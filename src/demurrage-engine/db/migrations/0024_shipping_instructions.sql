-- Demurrage Engine V2 — migration ADITIVA: Master Free Time pela Shipping
-- Instructions (SI). 0001-0023 NÃO são reescritas. Bloco 2 (tracking
-- compartilhado), cadência, relógios puros, tarifas, responsabilidade, minutas,
-- fechamento e Fases 7/8 intactos.
--
-- Regra operacional da Rocket: o PRIMEIRO e-mail cronológico da conversa de
-- pré-alerta é a Shipping Instructions. O Master Free Time é extraído do corpo
-- e dos anexos dessa mensagem, só quando explícito; o Master BL posterior
-- prevalece (prioridade 90 > 85).

-- ---------------------------------------------------------------------------
-- 1) Nova fonte `shipping_instructions`. O CHECK de `fonte` EXISTE no schema
--    (0004, field_observations_fonte_check) → recriado com o novo valor.
-- ---------------------------------------------------------------------------
ALTER TABLE field_observations DROP CONSTRAINT field_observations_fonte_check;
ALTER TABLE field_observations ADD CONSTRAINT field_observations_fonte_check CHECK (
  fonte IN (
    'tracking_service', 'email_heuristic', 'manual_fallback',
    'house_document', 'master_bl', 'headcargo', 'outro', 'shipping_instructions'
  )
);

-- Guarda de BANCO (defesa em profundidade, além do writer): o tracking do
-- armador nunca registra House nem Master Free Time. NOT VALID: vale para toda
-- escrita nova sem reavaliar o histórico append-only.
ALTER TABLE field_observations ADD CONSTRAINT field_observations_tracking_sem_free_time
  CHECK (NOT (fonte = 'tracking_service' AND campo IN ('houseFreeTimeDays', 'masterFreeTimeDays'))) NOT VALID;

-- Âncora para FKs compostas (processo, organização).
ALTER TABLE processos ADD CONSTRAINT processos_id_org_unique UNIQUE (id, organization_id);

-- ---------------------------------------------------------------------------
-- 2) Conversas de pré-alerta registradas para ingestão (pela importação
--    automática ou manualmente). Uma por (organização, conversa).
-- ---------------------------------------------------------------------------
CREATE TABLE si_conversas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  conversation_id TEXT NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('importacao_automatica', 'manual')),
  registrada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT si_conversas_unica UNIQUE (organization_id, conversation_id)
);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON si_conversas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 3) Controle IDEMPOTENTE da versão ingerida: uma linha por (organização,
--    conversa, conteudo_hash da 1ª mensagem). DONE nunca é refeita (sem novo
--    download/OCR). PENDENTE (resultado com pendência) e FAILED (erro técnico)
--    podem ser reprocessadas pelo POST. `epoca` = fencing da posse.
-- ---------------------------------------------------------------------------
CREATE TABLE si_versoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_received_at TIMESTAMPTZ NOT NULL,
  conteudo_hash TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('PROCESSING', 'DONE', 'PENDENTE', 'FAILED')),
  epoca INTEGER NOT NULL DEFAULT 1,
  tentativas INTEGER NOT NULL DEFAULT 1,
  worker_id TEXT,
  expira_em TIMESTAMPTZ NOT NULL,
  erro TEXT,
  iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT si_versoes_unica UNIQUE (organization_id, conversation_id, conteudo_hash)
);
CREATE INDEX si_versoes_conversa_idx ON si_versoes (organization_id, conversation_id, criado_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON si_versoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4) Intenção documental extraída (append-only): o valor de Free Time e seu
--    alcance (MBL/processo inteiro ou contêiner específico), com a evidência.
--    Reaplicada a contêineres que surgirem depois SEM repetir leitura/OCR.
--    processo_id nulo = processo ainda não identificável (refs preservadas).
-- ---------------------------------------------------------------------------
CREATE TABLE si_intencoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  versao_id UUID NOT NULL REFERENCES si_versoes(id),
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_received_at TIMESTAMPTZ NOT NULL,
  processo_id UUID,
  processos_ref TEXT[] NOT NULL DEFAULT '{}',
  mbls_ref TEXT[] NOT NULL DEFAULT '{}',
  escopo TEXT NOT NULL CHECK (escopo IN ('mbl', 'container')),
  container_numero TEXT,
  valor_dias INTEGER NOT NULL CHECK (valor_dias >= 0),
  encontrado_em TEXT NOT NULL CHECK (encontrado_em IN ('corpo', 'anexo')),
  attachment_id TEXT,
  attachment_nome TEXT,
  trecho_evidencia TEXT NOT NULL,
  metodo_extracao TEXT NOT NULL CHECK (metodo_extracao IN ('texto', 'ocr_visao')),
  confianca NUMERIC(4, 3) NOT NULL CHECK (confianca >= 0 AND confianca <= 1),
  conteudo_hash TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT si_intencoes_escopo_container CHECK ((escopo = 'container') = (container_numero IS NOT NULL)),
  CONSTRAINT si_intencoes_processo_org_fk FOREIGN KEY (processo_id, organization_id) REFERENCES processos (id, organization_id)
);
CREATE UNIQUE INDEX si_intencoes_unica ON si_intencoes (versao_id, escopo, COALESCE(container_numero, ''));
CREATE TRIGGER si_intencoes_append_only
  BEFORE UPDATE OR DELETE ON si_intencoes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON si_intencoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 5) Proveniência estruturada por contêiner (append-only). Tabela tipada (não
--    JSON em evidencia_ref) porque precisa de UNIQUE idempotente por
--    (intenção, contêiner), FKs e consultas de auditoria por conversa/mensagem.
--    field_observations.evidencia_ref guarda só o ponteiro `si_intencao:<id>`.
-- ---------------------------------------------------------------------------
CREATE TABLE si_proveniencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  intencao_id UUID NOT NULL REFERENCES si_intencoes(id),
  field_observation_id UUID NOT NULL REFERENCES field_observations(id),
  processo_id UUID NOT NULL,
  container_id UUID NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_received_at TIMESTAMPTZ NOT NULL,
  encontrado_em TEXT NOT NULL CHECK (encontrado_em IN ('corpo', 'anexo')),
  attachment_id TEXT,
  attachment_nome TEXT,
  trecho_evidencia TEXT NOT NULL,
  valor_dias INTEGER NOT NULL CHECK (valor_dias >= 0),
  metodo_extracao TEXT NOT NULL CHECK (metodo_extracao IN ('texto', 'ocr_visao')),
  confianca NUMERIC(4, 3) NOT NULL,
  conteudo_hash TEXT NOT NULL,
  observado_em TIMESTAMPTZ NOT NULL,
  coletado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT si_proveniencias_unica UNIQUE (intencao_id, container_id),
  CONSTRAINT si_proveniencias_container_org_fk FOREIGN KEY (container_id, organization_id) REFERENCES containers (id, organization_id),
  CONSTRAINT si_proveniencias_processo_org_fk FOREIGN KEY (processo_id, organization_id) REFERENCES processos (id, organization_id)
);
CREATE INDEX si_proveniencias_conversa_idx ON si_proveniencias (organization_id, conversation_id, message_id);
CREATE TRIGGER si_proveniencias_append_only
  BEFORE UPDATE OR DELETE ON si_proveniencias
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON si_proveniencias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 6) Pendências da ingestão da SI. Idempotentes por hash de contexto: no
--    máximo UMA aberta por (organização, contexto). Resolver preserva a linha.
-- ---------------------------------------------------------------------------
CREATE TABLE si_pendencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  versao_id UUID REFERENCES si_versoes(id),
  processo_id UUID,
  mbl TEXT,
  container_id UUID,
  container_numero TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'free_time_nao_encontrado', 'free_time_ambiguo', 'processo_nao_identificado', 'mbl_nao_identificado',
    'conversa_multiprocesso', 'container_nao_encontrado', 'alcance_nao_determinado', 'ocr_baixa_confianca'
  )),
  motivo TEXT NOT NULL,
  contexto JSONB NOT NULL DEFAULT '{}'::jsonb,
  contexto_hash TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta', 'resolvida')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ,
  resolvido_por TEXT,
  CONSTRAINT si_pendencias_resolucao CHECK ((estado = 'resolvida') = (resolvido_em IS NOT NULL AND resolvido_por IS NOT NULL)),
  CONSTRAINT si_pendencias_processo_org_fk FOREIGN KEY (processo_id, organization_id) REFERENCES processos (id, organization_id),
  CONSTRAINT si_pendencias_container_org_fk FOREIGN KEY (container_id, organization_id) REFERENCES containers (id, organization_id)
);
CREATE UNIQUE INDEX si_pendencias_aberta_unica ON si_pendencias (organization_id, contexto_hash) WHERE estado = 'aberta';
CREATE INDEX si_pendencias_conversa_idx ON si_pendencias (organization_id, conversation_id, estado);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON si_pendencias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 7) Divergência SI × Master BL do Master Free Time — estado CORRENTE (mutável
--    e controlado) + ocorrência (`ocorrencia_seq`, incrementa a cada reabertura).
--    Informativa: o Master segue selecionado e o cálculo não bloqueia.
-- ---------------------------------------------------------------------------
CREATE TABLE ft_divergencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  container_id UUID NOT NULL,
  campo TEXT NOT NULL DEFAULT 'masterFreeTimeDays' CHECK (campo = 'masterFreeTimeDays'),
  valor_si INTEGER NOT NULL,
  obs_si_id UUID NOT NULL REFERENCES field_observations(id),
  valor_master INTEGER NOT NULL,
  obs_master_id UUID NOT NULL REFERENCES field_observations(id),
  estado TEXT NOT NULL CHECK (estado IN ('aberta', 'reconhecida', 'resolvida', 'reaberta')),
  ocorrencia_seq INTEGER NOT NULL DEFAULT 1 CHECK (ocorrencia_seq >= 1),
  reconhecida_por TEXT,
  reconhecida_em TIMESTAMPTZ,
  resolvida_por TEXT,
  resolvida_em TIMESTAMPTZ,
  resolvida_motivo TEXT CHECK (resolvida_motivo IN ('convergencia', 'manual')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ft_divergencias_unica UNIQUE (container_id, campo),
  CONSTRAINT ft_divergencias_container_org_fk FOREIGN KEY (container_id, organization_id) REFERENCES containers (id, organization_id),
  CONSTRAINT ft_divergencias_processo_org_fk FOREIGN KEY (processo_id, organization_id) REFERENCES processos (id, organization_id)
);
CREATE INDEX ft_divergencias_org_idx ON ft_divergencias (organization_id, estado);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON ft_divergencias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Histórico APPEND-ONLY da divergência.
CREATE TABLE ft_divergencia_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  divergencia_id UUID NOT NULL REFERENCES ft_divergencias(id),
  ocorrencia_seq INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('aberta', 'atualizada', 'reconhecida', 'resolvida', 'reaberta', 'aviso_emitido', 'aviso_falhou')),
  autor TEXT NOT NULL,
  detalhe JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ft_divergencia_eventos_idx ON ft_divergencia_eventos (divergencia_id, criado_em);
CREATE TRIGGER ft_divergencia_eventos_append_only
  BEFORE UPDATE OR DELETE ON ft_divergencia_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON ft_divergencia_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Entregas (outbox de aviso) POR OCORRÊNCIA: reabrir gera novos avisos;
-- reprocessar a mesma ocorrência não duplica; falhas são retentáveis.
CREATE TABLE ft_divergencia_entregas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  divergencia_id UUID NOT NULL REFERENCES ft_divergencias(id),
  ocorrencia_seq INTEGER NOT NULL,
  destinatario_tipo TEXT NOT NULL CHECK (destinatario_tipo IN ('responsavel_operacional', 'gestor')),
  destinatario_membership_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em TIMESTAMPTZ,
  CONSTRAINT ft_divergencia_entregas_unica UNIQUE (divergencia_id, ocorrencia_seq, destinatario_membership_id),
  CONSTRAINT ft_divergencia_entregas_membership_org_fk FOREIGN KEY (destinatario_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id)
);
CREATE INDEX ft_divergencia_entregas_status_idx ON ft_divergencia_entregas (status, criado_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON ft_divergencia_entregas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 8) Outbox de RECÁLCULO: gravado na MESMA transação da promoção. Idempotente
--    por (contêiner, tipo, chave = observação promovida). Worker com claim
--    concorrente (SKIP LOCKED + época), retry e recuperação de item abandonado.
-- ---------------------------------------------------------------------------
CREATE TABLE recalculo_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  container_id UUID NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('master_free_time')),
  chave TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'PENDING' CHECK (estado IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  epoca INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  expira_em TIMESTAMPTZ,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT recalculo_outbox_unica UNIQUE (container_id, tipo, chave),
  CONSTRAINT recalculo_outbox_container_org_fk FOREIGN KEY (container_id, organization_id) REFERENCES containers (id, organization_id)
);
CREATE INDEX recalculo_outbox_estado_idx ON recalculo_outbox (estado, criado_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON recalculo_outbox
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
