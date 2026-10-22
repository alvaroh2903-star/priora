-- Demurrage Engine V2 — migration ADITIVA (Produção P1, reabertura controlada:
-- correção de minuta, documento e encerramento automático). 0001-0047 não
-- são reescritas.
--
-- Regras de produto aplicadas (ver docs/demurrage-producao-p1-correcao-minuta-encerramento.md):
--  - a minuta é registrada/anexada pelo analista ou responsável interno;
--    NUNCA há aprovação de MANAGER/ADMIN. Só verificação técnica automática
--    (contêiner, data legível/válida, coerência estrutural, comparação com a
--    devolução do tracking). Coerente e igual ao tracking → ACEITA; incoerente
--    → INCONSISTENTE; coerente mas diferente do tracking → DIVERGENTE. As duas
--    últimas abrem pendência operacional para o analista corrigir/substituir;
--  - a data do tracking é a devolução OFICIAL — o novo fluxo nunca escreve
--    `containers.effective_return_date` nem fabrica devolução ausente
--    (minuta sem devolução no tracking permanece RECEBIDA, aguardando);
--  - uma nova minuta do mesmo contêiner SUBSTITUI a vigente (histórico
--    preservado, nunca apagado);
--  - o processo encerra AUTOMATICAMENTE (FINAL) quando todas as condições
--    reais estão satisfeitas; `fechamentos.origem` distingue o automático do
--    acionamento humano administrativo.
--
-- Compatibilidade com dado legado (nenhuma linha existente é reescrita por
-- esta migration):
--  - `estado_minuta` mantém RECEBIDA/VALIDADA/REJEITADA no CHECK. VALIDADA e
--    REJEITADA passam a ser só LEITURA de legado (aprovação/rejeição humana
--    do fluxo antigo) — o novo fluxo nunca as escreve. RECEBIDA continua
--    significando "registrada, aguardando avaliação técnica";
--  - linhas legadas têm `regra_avaliacao` NULL e ficam FORA do índice único
--    de minuta vigente (podem existir várias RECEBIDA legadas por contêiner)
--    e mantêm a semântica de comprovação legada até serem substituídas. A
--    substituição (toda minuta ainda não substituída do contêiner vira
--    SUBSTITUIDA, com evento de auditoria) acontece no REGISTRO de uma minuta
--    nova, pela aplicação, sob o lock consultivo do processo — nunca em SQL
--    cego nem nesta migration;
--  - `containers.effective_return_date` legado não é tocado por esta
--    migration e continua lido por COALESCE(effective, tracking). A
--    aplicação o limpa (evento RECALCULO, histórico preservado) quando a
--    minuta legada que o originou foi substituída e o processo está OPEN — a
--    devolução volta a ser a do tracking. Em processo FINAL nada muda até
--    uma reabertura.

-- ---------------------------------------------------------------------------
-- 1) documentos: o mecanismo documental JÁ EXISTENTE (0016, até aqui sem
--    escritor) passa a guardar a REFERÊNCIA AUDITÁVEL do arquivo real da
--    minuta (PDF/imagem). Não existe armazenamento binário no sistema: a
--    linha guarda referência + hash SHA-256 + nome + tipo + tamanho; o
--    arquivo em si vive no repositório de origem (anexo de e-mail Graph ou
--    referência externa). Nenhum binário em tabela operacional.
-- ---------------------------------------------------------------------------
ALTER TABLE documentos
  ADD COLUMN organization_id UUID REFERENCES organizations(id),
  ADD COLUMN minuta_id UUID,
  ADD COLUMN versao_minuta INTEGER,
  ADD COLUMN referencia_armazenamento TEXT,
  ADD COLUMN nome_arquivo TEXT,
  ADD COLUMN tipo_conteudo TEXT,
  ADD COLUMN tamanho_bytes BIGINT,
  ADD COLUMN hash_conteudo TEXT,
  ADD COLUMN incluido_por_membership_id UUID REFERENCES organization_memberships(id);

ALTER TABLE documentos
  ADD CONSTRAINT documentos_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id),
  ADD CONSTRAINT documentos_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id);

-- Documento de minuta: todos os vínculos e metadados obrigatórios.
ALTER TABLE documentos ADD CONSTRAINT documentos_minuta_coerente CHECK (
  minuta_id IS NULL OR (
    organization_id IS NOT NULL AND processo_id IS NOT NULL AND container_id IS NOT NULL
    AND tipo = 'minuta_devolucao'
    AND origem IN ('email_anexo', 'referencia_externa')
    AND referencia_armazenamento IS NOT NULL AND char_length(referencia_armazenamento) BETWEEN 1 AND 1000
    AND nome_arquivo IS NOT NULL AND char_length(nome_arquivo) BETWEEN 1 AND 255
    AND tipo_conteudo IN ('application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp', 'image/heic')
    AND tamanho_bytes IS NOT NULL AND tamanho_bytes BETWEEN 1 AND 52428800
    AND hash_conteudo IS NOT NULL AND hash_conteudo ~ '^[0-9a-f]{64}$'
    AND versao_minuta IS NOT NULL AND versao_minuta >= 1
    AND incluido_por_membership_id IS NOT NULL AND incluido_por IS NOT NULL
  )
);
CREATE UNIQUE INDEX documentos_minuta_unico ON documentos (minuta_id) WHERE minuta_id IS NOT NULL;
CREATE INDEX documentos_container_idx ON documentos (container_id);

-- Documento é evidência: append-only (mesmo padrão de closing_events).
CREATE TRIGGER documentos_append_only
  BEFORE UPDATE OR DELETE ON documentos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Convenção da 0007 (DECISÃO 1): toda tabela com organization_id carrega o
-- trigger de imutabilidade da organização — mesmo que o append-only acima já
-- barre qualquer UPDATE, a regra do catálogo vale para toda tabela de tenant.
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 2) minutas: vocabulário de estado do aceite técnico + vínculos.
-- ---------------------------------------------------------------------------
ALTER TABLE minutas DROP CONSTRAINT minutas_estado_minuta_check;
ALTER TABLE minutas ADD CONSTRAINT minutas_estado_minuta_check CHECK (estado_minuta IN (
  'RECEBIDA',       -- registrada; aguardando avaliação técnica (ex.: sem devolução no tracking)
  'ACEITA',         -- aceite técnico automático: coerente e igual à devolução do tracking
  'DIVERGENTE',     -- coerente, mas a data difere da devolução do tracking → pendência
  'INCONSISTENTE',  -- falhou a verificação técnica (número/data/cronologia) → pendência
  'SUBSTITUIDA',    -- substituída por uma minuta mais recente do mesmo contêiner (histórico)
  'VALIDADA',       -- LEGADO (fluxo antigo, aprovação humana) — só leitura
  'REJEITADA'       -- LEGADO (fluxo antigo, rejeição humana) — só leitura
));

ALTER TABLE minutas
  ADD COLUMN regra_avaliacao TEXT CHECK (regra_avaliacao IS NULL OR regra_avaliacao = 'minuta.tecnica.v1'),
  ADD COLUMN versao INTEGER CHECK (versao IS NULL OR versao >= 1),
  ADD COLUMN substituida_por_id UUID,
  ADD COLUMN substituida_em TIMESTAMPTZ,
  ADD COLUMN data_tracking_comparada DATE,
  ADD COLUMN aguardando TEXT CHECK (aguardando IS NULL OR aguardando IN ('DEVOLUCAO_TRACKING', 'DESCARGA')),
  ADD COLUMN fatos_avaliacao JSONB,
  ADD COLUMN avaliada_em TIMESTAMPTZ;

ALTER TABLE documentos
  ADD CONSTRAINT documentos_minuta_fk FOREIGN KEY (minuta_id) REFERENCES minutas(id);
-- Adiável: a minuta vigente anterior é marcada SUBSTITUIDA (apontando para o id
-- já reservado da nova) ANTES do INSERT da nova, para que o índice único de
-- vigência nunca veja duas vigentes — a integridade referencial é conferida
-- no COMMIT da mesma transação.
ALTER TABLE minutas
  ADD CONSTRAINT minutas_substituida_por_fk FOREIGN KEY (substituida_por_id) REFERENCES minutas(id)
  DEFERRABLE INITIALLY DEFERRED;

-- Substituição: estado e vínculo andam juntos.
ALTER TABLE minutas ADD CONSTRAINT minutas_substituicao_coerente CHECK (
  (estado_minuta = 'SUBSTITUIDA') = (substituida_por_id IS NOT NULL)
  AND (substituida_por_id IS NULL) = (substituida_em IS NULL)
  AND (substituida_por_id IS NULL OR substituida_por_id <> id)
);
-- Estados do aceite técnico só existem em linhas do fluxo novo.
ALTER TABLE minutas ADD CONSTRAINT minutas_estado_tecnico_exige_regra CHECK (
  estado_minuta NOT IN ('ACEITA', 'DIVERGENTE', 'INCONSISTENTE') OR regra_avaliacao IS NOT NULL
);
-- O fluxo novo nunca escreve os campos de aprovação humana do legado.
ALTER TABLE minutas ADD CONSTRAINT minutas_fluxo_tecnico_sem_aprovacao_humana CHECK (
  regra_avaliacao IS NULL OR (validada_por IS NULL AND data_validada IS NULL AND estado_minuta NOT IN ('VALIDADA', 'REJEITADA'))
);
ALTER TABLE minutas ADD CONSTRAINT minutas_aceita_coerente CHECK (
  estado_minuta <> 'ACEITA' OR (data_tracking_comparada IS NOT NULL AND data_informada = data_tracking_comparada)
);
ALTER TABLE minutas ADD CONSTRAINT minutas_divergente_coerente CHECK (
  estado_minuta <> 'DIVERGENTE' OR (data_tracking_comparada IS NOT NULL AND data_informada IS NOT NULL AND data_informada <> data_tracking_comparada)
);
ALTER TABLE minutas ADD CONSTRAINT minutas_inconsistente_coerente CHECK (
  estado_minuta <> 'INCONSISTENTE' OR motivo_rejeicao IS NOT NULL
);

-- No máximo UMA minuta vigente (não substituída) do fluxo novo por contêiner.
-- Linhas legadas (regra_avaliacao NULL) ficam fora — ver nota de compatibilidade.
CREATE UNIQUE INDEX minutas_vigente_unica ON minutas (container_id)
  WHERE regra_avaliacao IS NOT NULL AND substituida_por_id IS NULL;
CREATE UNIQUE INDEX minutas_versao_unica ON minutas (container_id, versao) WHERE versao IS NOT NULL;
CREATE INDEX minutas_nao_substituidas_idx ON minutas (container_id)
  WHERE substituida_por_id IS NULL AND estado_minuta IN ('RECEBIDA', 'ACEITA', 'DIVERGENTE', 'INCONSISTENTE');
CREATE INDEX minutas_exigem_acao_idx ON minutas (criado_em, id)
  WHERE substituida_por_id IS NULL AND estado_minuta IN ('DIVERGENTE', 'INCONSISTENTE');

-- Toda minuta do fluxo novo tem o seu documento — verificado no COMMIT
-- (constraint trigger adiável): uma falha ao registrar o documento nunca
-- deixa uma minuta "sem arquivo" persistida.
CREATE OR REPLACE FUNCTION exigir_documento_minuta() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documentos d WHERE d.minuta_id = NEW.id) THEN
    RAISE EXCEPTION 'minutas %: minuta do fluxo técnico exige documento vinculado', NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER minutas_exige_documento
  AFTER INSERT ON minutas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.regra_avaliacao IS NOT NULL)
  EXECUTE FUNCTION exigir_documento_minuta();

-- ---------------------------------------------------------------------------
-- 3) demurrage_pendencias: dois tipos novos, resolvidos pelo registro de uma
--    minuta coerente (substituta) — nunca por aprovação de gestor.
-- ---------------------------------------------------------------------------
ALTER TABLE demurrage_pendencias DROP CONSTRAINT demurrage_pendencias_tipo_check;
ALTER TABLE demurrage_pendencias ADD CONSTRAINT demurrage_pendencias_tipo_check CHECK (tipo IN (
  'armador_ausente', 'armador_nao_cadastrado', 'armador_sem_tracking',
  'mbl_ausente', 'tipo_ausente', 'tipo_nao_reconhecido', 'tipo_selecao_sem_observacao',
  'retorno_vazio_antes_descarga', 'cronologia_gate_out_antes_descarga', 'cronologia_retorno_antes_gate_out',
  'condicao_comercial_ausente', 'conflito_mesma_fonte', 'fallback_manual_superado', 'free_time_ausente',
  -- Produção P1 (correção de minuta):
  'minuta_inconsistente',          -- a minuta vigente falhou a verificação técnica
  'minuta_divergente_tracking'     -- a minuta vigente diverge da devolução oficial do tracking
));

-- ---------------------------------------------------------------------------
-- 4) closing_events: eventos do aceite técnico (aditivo).
-- ---------------------------------------------------------------------------
ALTER TABLE closing_events DROP CONSTRAINT closing_events_tipo_evento_check;
ALTER TABLE closing_events ADD CONSTRAINT closing_events_tipo_evento_check CHECK (tipo_evento IN (
  'EMPTY_RETURN', 'MINUTA_RECEBIDA', 'MINUTA_VALIDADA', 'MINUTA_REJEITADA',
  'DIVERGENCIA_TRACKING_MINUTA', 'RECALCULO', 'FECHAMENTO_FINAL',
  'REABERTURA_SOLICITADA', 'REABERTURA_AUTORIZADA', 'REABERTURA', 'REFECHAMENTO',
  'RESPONSABILIDADE_CONFIRMADA', 'RESPONSABILIDADE_CORRIGIDA', 'RESPONSABILIDADE_INVALIDADA',
  'FATO_MATERIAL_POS_FINAL',
  'MINUTA_ACEITA', 'MINUTA_DIVERGENTE', 'MINUTA_INCONSISTENTE', 'MINUTA_SUBSTITUIDA'
));

-- ---------------------------------------------------------------------------
-- 5) fechamentos: origem do encerramento. Toda linha existente veio do
--    fluxo antigo (finalização humana) → 'humano' é a interpretação correta,
--    não um valor inventado.
-- ---------------------------------------------------------------------------
ALTER TABLE fechamentos
  ADD COLUMN origem TEXT NOT NULL DEFAULT 'humano' CHECK (origem IN ('humano', 'automatico'));
ALTER TABLE fechamentos ADD CONSTRAINT fechamentos_automatico_sem_autor CHECK (origem <> 'automatico' OR realizado_por IS NULL);
ALTER TABLE fechamentos ADD CONSTRAINT fechamentos_humano_com_autor CHECK (origem <> 'humano' OR realizado_por IS NOT NULL) NOT VALID;

-- ---------------------------------------------------------------------------
-- 6) processos: resultado da última avaliação automática de encerramento
--    (informativo para a leitura e para a rotação justa da varredura).
-- ---------------------------------------------------------------------------
ALTER TABLE processos
  ADD COLUMN encerramento_avaliado_em TIMESTAMPTZ,
  ADD COLUMN encerramento_bloqueio TEXT,
  ADD COLUMN encerramento_bloqueio_container_id UUID REFERENCES containers(id) ON DELETE SET NULL;
CREATE INDEX processos_encerramento_varredura_idx ON processos (encerramento_avaliado_em NULLS FIRST, id)
  WHERE apuracao_status = 'OPEN';
