-- Demurrage Engine V2 — migration ADITIVA (Produção P1, administração
-- tarifária operacional). 0001-0051 não são reescritas; nenhuma linha de
-- tariff_tables, tariff_brackets ou valores_apurados é alterada; as funções e
-- os triggers de imutabilidade da 0037/0038 continuam exatamente como estão.
--
-- Ver docs/demurrage-producao-p1-administracao-tarifas.md. Resumo:
--  - o ESTADO de uma versão (RASCUNHO, ATIVA, SUBSTITUIDA, DESATIVADA) é
--    derivado: rascunho = `ativada_em IS NULL`; substituição e desativação são
--    TRANSIÇÕES append-only gravadas aqui, nunca um UPDATE na versão (que é
--    imutável depois de ativada);
--  - toda operação administrativa grava UM evento de auditoria append-only,
--    que é também o registro de idempotência (chave + hash do pedido +
--    resposta) e a correlação do recálculo (`recalculo_outbox.chave` = id do
--    evento);
--  - o recálculo dos processos abertos afetados usa o outbox EXISTENTE
--    (claim, época, retentativa), agora também com `tipo = 'tarifa'`. A
--    transação administrativa só grava a EXPANSÃO pendente; os itens por
--    contêiner são criados DEPOIS do COMMIT, processo a processo, sob o lock
--    do processo (ver 6).

-- ---------------------------------------------------------------------------
-- 1) Chave composta (id, organization_id) — alvo de FK das tabelas abaixo:
--    um evento ou transição só pode apontar para versão da MESMA organização
--    (versão pública, organization_id NULL, nunca é alvo de escrita).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX tariff_tables_id_org_unica ON tariff_tables (id, organization_id);

-- ---------------------------------------------------------------------------
-- 2) Eventos de administração (auditoria + idempotência)
-- ---------------------------------------------------------------------------
CREATE TABLE tariff_admin_eventos (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  tariff_table_id UUID NOT NULL,
  operacao TEXT NOT NULL CHECK (operacao IN (
    'CRIAR_RASCUNHO', 'CRIAR_VERSAO_DE', 'ATUALIZAR_METADADOS', 'SUBSTITUIR_FAIXAS',
    'ATIVAR', 'DESATIVAR', 'REPROCESSAR_RECALCULO')),
  -- Identidade da versão no instante do evento (cópia: a versão é imutável
  -- depois de ativada, e a dimensão nunca muda pela API).
  tipo tariff_table_tipo NOT NULL,
  armador_id UUID REFERENCES armadores(id),
  termo_comercial termo_comercial_tipo,
  versao INTEGER NOT NULL CHECK (versao >= 1),
  -- Autor: SEMPRE o membership da sessão, com o papel relido sob lock.
  autor_membership_id UUID NOT NULL,
  autor_usuario_id UUID NOT NULL REFERENCES usuarios(id),
  autor_papel TEXT NOT NULL CHECK (autor_papel IN ('MANAGER', 'ADMIN')),
  motivo TEXT CHECK (motivo IS NULL OR (btrim(motivo) <> '' AND char_length(motivo) <= 1000)),
  valores_anteriores JSONB,
  valores_novos JSONB,
  -- SHA-256 do conteúdo canônico da versão DEPOIS da operação (na ativação:
  -- exatamente o conteúdo publicado).
  conteudo_hash TEXT NOT NULL CHECK (conteudo_hash ~ '^[0-9a-f]{64}$'),
  idempotencia_chave TEXT NOT NULL CHECK (char_length(idempotencia_chave) BETWEEN 1 AND 200),
  idempotencia_hash TEXT NOT NULL CHECK (idempotencia_hash ~ '^[0-9a-f]{64}$'),
  resultado JSONB NOT NULL,
  -- Reprocessamento: o evento cujo recálculo foi refeito (correlação).
  recalculo_evento_origem_id UUID,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tariff_admin_eventos_tabela_org_fk FOREIGN KEY (tariff_table_id, organization_id)
    REFERENCES tariff_tables (id, organization_id),
  CONSTRAINT tariff_admin_eventos_autor_org_fk FOREIGN KEY (autor_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT tariff_admin_eventos_idempotencia_unica UNIQUE (organization_id, idempotencia_chave),
  CONSTRAINT tariff_admin_eventos_id_org_unica UNIQUE (id, organization_id),
  CONSTRAINT tariff_admin_eventos_origem_org_fk FOREIGN KEY (recalculo_evento_origem_id, organization_id)
    REFERENCES tariff_admin_eventos (id, organization_id),
  CONSTRAINT tariff_admin_eventos_motivo_exigido CHECK (
    operacao NOT IN ('ATIVAR', 'DESATIVAR', 'CRIAR_VERSAO_DE', 'REPROCESSAR_RECALCULO') OR motivo IS NOT NULL
  ),
  CONSTRAINT tariff_admin_eventos_reprocesso_coerente CHECK (
    (operacao = 'REPROCESSAR_RECALCULO') = (recalculo_evento_origem_id IS NOT NULL)
  )
);
CREATE INDEX tariff_admin_eventos_tabela_idx ON tariff_admin_eventos (tariff_table_id, criado_em, id);
CREATE INDEX tariff_admin_eventos_org_idx ON tariff_admin_eventos (organization_id, criado_em, id);
CREATE TRIGGER tariff_admin_eventos_append_only
  BEFORE UPDATE OR DELETE ON tariff_admin_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON tariff_admin_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 3) Transições de ciclo de vida (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE tariff_versao_transicoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_table_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('ATIVACAO', 'SUBSTITUICAO', 'DESATIVACAO')),
  -- SUBSTITUICAO: último dia em que a versão substituída ainda vale. Menor que
  -- o início = substituída integralmente (nunca mais selecionada).
  vigencia_efetiva_fim DATE,
  substituida_por_id UUID,
  evento_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tariff_versao_transicoes_evento_org_fk FOREIGN KEY (evento_id, organization_id)
    REFERENCES tariff_admin_eventos (id, organization_id),
  CONSTRAINT tariff_versao_transicoes_tabela_org_fk FOREIGN KEY (tariff_table_id, organization_id)
    REFERENCES tariff_tables (id, organization_id),
  CONSTRAINT tariff_versao_transicoes_sucessora_org_fk FOREIGN KEY (substituida_por_id, organization_id)
    REFERENCES tariff_tables (id, organization_id),
  CONSTRAINT tariff_versao_transicoes_forma CHECK (
    (tipo = 'SUBSTITUICAO' AND vigencia_efetiva_fim IS NOT NULL AND substituida_por_id IS NOT NULL
       AND substituida_por_id <> tariff_table_id)
    OR (tipo IN ('ATIVACAO', 'DESATIVACAO') AND vigencia_efetiva_fim IS NULL AND substituida_por_id IS NULL)
  )
);
CREATE UNIQUE INDEX tariff_versao_transicoes_uma_ativacao ON tariff_versao_transicoes (tariff_table_id) WHERE tipo = 'ATIVACAO';
CREATE UNIQUE INDEX tariff_versao_transicoes_uma_desativacao ON tariff_versao_transicoes (tariff_table_id) WHERE tipo = 'DESATIVACAO';
CREATE INDEX tariff_versao_transicoes_tabela_idx ON tariff_versao_transicoes (tariff_table_id, tipo);
CREATE TRIGGER tariff_versao_transicoes_append_only
  BEFORE UPDATE OR DELETE ON tariff_versao_transicoes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON tariff_versao_transicoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4) Rascunho DESATIVADO (abandonado) é terminal: nunca mais editado,
--    ativado nem apagado. Trigger NOVO, ao lado dos da 0037/0038 (que
--    continuam cobrindo versão ativada ou usada).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tariff_table_esta_desativada(p_tabela_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM tariff_versao_transicoes x WHERE x.tariff_table_id = p_tabela_id AND x.tipo = 'DESATIVACAO');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION forbid_tariff_desativada_mutation() RETURNS TRIGGER AS $$
DECLARE
  tabela_ref UUID;
BEGIN
  IF TG_TABLE_NAME = 'tariff_tables' THEN
    tabela_ref := OLD.id;
  ELSE
    -- Uma faixa nunca troca de versão: mover tiraria conteúdo de uma versão
    -- ativada ou desativada sem passar pela checagem da versão de ORIGEM
    -- (as checagens abaixo e as da 0037 olham a versão de destino).
    IF TG_OP = 'UPDATE' AND NEW.tariff_table_id IS DISTINCT FROM OLD.tariff_table_id THEN
      RAISE EXCEPTION 'faixa %: tariff_table_id e imutavel (crie a faixa na versao certa)', OLD.id;
    END IF;
    tabela_ref := COALESCE(NEW.tariff_table_id, OLD.tariff_table_id);
    -- Serializa qualquer escritor de faixas (também fora da API: serviço
    -- legado, seed, SQL direto) com a ativação/desativação em curso, que
    -- segura a versão com FOR NO KEY UPDATE: FOR SHARE conflita com ele.
    -- Sem isso, faixas trocadas entre a validação e o COMMIT da ativação
    -- publicariam um conteúdo diferente do hash auditado.
    PERFORM 1 FROM tariff_tables WHERE id = tabela_ref FOR SHARE;
  END IF;
  IF tariff_table_esta_desativada(tabela_ref) THEN
    RAISE EXCEPTION 'tarifa %: versao DESATIVADA e terminal — % barrado (crie uma nova versao)', tabela_ref, TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tariff_tables_desativada_terminal
  BEFORE UPDATE OR DELETE ON tariff_tables
  FOR EACH ROW EXECUTE FUNCTION forbid_tariff_desativada_mutation();
CREATE TRIGGER tariff_brackets_desativada_terminal
  BEFORE INSERT OR UPDATE OR DELETE ON tariff_brackets
  FOR EACH ROW EXECUTE FUNCTION forbid_tariff_desativada_mutation();

-- ---------------------------------------------------------------------------
-- 5) Outbox de recálculo: também por mudança tarifária (mesmo worker, mesmo
--    claim/época/retentativa). Só amplia a lista aceita.
-- ---------------------------------------------------------------------------
ALTER TABLE recalculo_outbox DROP CONSTRAINT recalculo_outbox_tipo_check;
ALTER TABLE recalculo_outbox ADD CONSTRAINT recalculo_outbox_tipo_check
  CHECK (tipo IN ('master_free_time', 'house_free_time', 'tarifa'));
CREATE INDEX recalculo_outbox_tarifa_chave_idx ON recalculo_outbox (chave) WHERE tipo = 'tarifa';

-- `tariff_table_esta_congelada` (0037) faz EXISTS em valores_apurados por
-- tabela_id a cada edição de faixa e de versão; sem índice, cada checagem
-- varre a tabela inteira (append-only, sempre crescendo).
CREATE INDEX valores_apurados_tabela_idx ON valores_apurados (tabela_id) WHERE tabela_id IS NOT NULL;

-- Desfecho de um item concluído (observabilidade): recalculado de fato, ou
-- ignorado porque o processo já era FINAL no momento do consumo. NULL nas
-- linhas anteriores a esta migration (desfecho não registrado à época).
ALTER TABLE recalculo_outbox ADD COLUMN desfecho TEXT
  CONSTRAINT recalculo_outbox_desfecho_check CHECK (desfecho IS NULL OR desfecho IN ('RECALCULADO', 'IGNORADO_FINAL'));

-- ---------------------------------------------------------------------------
-- 6) Expansão do recálculo por mudança tarifária (fora da transação
--    administrativa). Uma linha por evento que muda o que é aplicável
--    (ATIVAR/DESATIVAR de versão publicada). O expansor percorre os processos
--    do escopo em ordem de id e, para CADA um, numa transação curta, toma o
--    MESMO lock consultivo do processo que reabertura, registro e recálculo
--    tomam, relê o status e, se OPEN, insere no outbox um item por contêiner
--    (ordem de id; `ON CONFLICT DO NOTHING`). Quem estava recalculando com a
--    tarifa anterior termina antes e recebe o item; quem começa depois já lê
--    a tarifa nova. Posse com prazo (`worker_id`/`posse_ate`) e cursor
--    (`cursor_processo_id`): retomável depois de queda, nunca dois expansores
--    no mesmo evento ao mesmo tempo.
-- ---------------------------------------------------------------------------
CREATE TABLE tariff_recalculo_expansoes (
  evento_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  tariff_table_id UUID NOT NULL,
  cursor_processo_id UUID,
  processos INTEGER NOT NULL DEFAULT 0 CHECK (processos >= 0),
  itens INTEGER NOT NULL DEFAULT 0 CHECK (itens >= 0),
  worker_id TEXT,
  posse_ate TIMESTAMPTZ,
  concluida_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tariff_recalculo_expansoes_evento_org_fk FOREIGN KEY (evento_id, organization_id)
    REFERENCES tariff_admin_eventos (id, organization_id),
  CONSTRAINT tariff_recalculo_expansoes_tabela_org_fk FOREIGN KEY (tariff_table_id, organization_id)
    REFERENCES tariff_tables (id, organization_id),
  CONSTRAINT tariff_recalculo_expansoes_posse CHECK ((worker_id IS NULL) = (posse_ate IS NULL)),
  CONSTRAINT tariff_recalculo_expansoes_concluida_sem_posse CHECK (concluida_em IS NULL OR worker_id IS NULL)
);
CREATE INDEX tariff_recalculo_expansoes_pendentes_idx ON tariff_recalculo_expansoes (criado_em) WHERE concluida_em IS NULL;
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON tariff_recalculo_expansoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
