-- Demurrage Engine V2 — migration ADITIVA (Fase 8: minuta, devolução efetiva,
-- fechamento e reabertura, especificação v1). 0001-0015 não são reescritas.
--
-- Convenção de tenant: as tabelas desta fase NÃO carregam organization_id
-- denormalizado — chaveiam por container_id/processo_id, que já carregam a
-- organização (isolamento por transitividade). Assim a convenção da DECISÃO 1
-- (organization_id imutável) e seu catálogo permanecem intocados.
--
-- Preserva tracking_return_date (nunca apagado). effective_return_date só vem
-- de uma minuta VALIDADA (proveniência via effective_return_minuta_id).

-- 1) Minuta: recebida (upload) → validada/rejeitada (MANAGER/ADMIN). Upload não
--    altera datas/valores. `supersedes_id` encadeia uma nova minuta à anterior.
CREATE TABLE minutas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  estado_minuta TEXT NOT NULL DEFAULT 'RECEBIDA'
    CHECK (estado_minuta IN ('RECEBIDA', 'VALIDADA', 'REJEITADA')),
  numero_informado TEXT,
  data_informada DATE,
  -- Preenchida só na validação; é a candidata a effective_return_date.
  data_validada DATE,
  -- true quando data_validada difere do tracking_return_date no momento da validação.
  divergente_do_tracking BOOLEAN NOT NULL DEFAULT false,
  motivo_rejeicao TEXT,
  evidencia_ref TEXT,
  recebida_por UUID REFERENCES usuarios(id),
  validada_por UUID REFERENCES usuarios(id),
  supersedes_id UUID REFERENCES minutas(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX minutas_container_idx ON minutas (container_id);
-- No máximo uma minuta VALIDADA "ativa" (não superseded) por contêiner.
CREATE UNIQUE INDEX minutas_validada_ativa_unica
  ON minutas (container_id)
  WHERE estado_minuta = 'VALIDADA' AND supersedes_id IS NULL;

-- 2) Proveniência da devolução efetiva no contêiner. effective_return_date já
--    existe (0004); aqui só o ponteiro para a minuta que a originou. Também a
--    dimensão responsabilidade (gate de FINAL): NULL = derivado (Fase 8);
--    a Fase 11 grava a resolução.
ALTER TABLE containers
  ADD COLUMN effective_return_minuta_id UUID REFERENCES minutas(id),
  ADD COLUMN responsabilidade TEXT
    CHECK (responsabilidade IS NULL OR responsabilidade IN (
      'NAO_APLICAVEL', 'EM_ANALISE', 'CONFIRMADA_ROCKET', 'CONFIRMADA_CLIENTE', 'DIVIDIDA'
    ));

-- 3) Fechamento operacional (FINAL) do processo — dimensão separada do estado
--    derivado da Fase 7. Congelamento exige MANAGER/ADMIN (registro em fechamentos).
ALTER TABLE processos
  ADD COLUMN apuracao_status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (apuracao_status IN ('OPEN', 'FINAL')),
  ADD COLUMN fechado_em TIMESTAMPTZ,
  ADD COLUMN fechado_por UUID REFERENCES usuarios(id);

CREATE TABLE fechamentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
  realizado_por UUID REFERENCES usuarios(id),
  justificativa TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fechamentos_processo_idx ON fechamentos (processo_id);

-- 4) Reabertura: Gestor/perfil autorizado + justificativa + valores anteriores
--    preservados. Nunca apaga histórico.
CREATE TABLE reaberturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processo_id UUID NOT NULL REFERENCES processos(id) ON DELETE CASCADE,
  estado TEXT NOT NULL DEFAULT 'SOLICITADA'
    CHECK (estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA', 'REFECHADA')),
  solicitada_por UUID REFERENCES usuarios(id),
  autorizada_por UUID REFERENCES usuarios(id),
  justificativa TEXT,
  -- Snapshot dos valores/estado anteriores, para comparação (nunca sobrescrito).
  valores_anteriores JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reaberturas_processo_idx ON reaberturas (processo_id);

-- 5) Documento/evidência (Cap. 29.7/32.6): existência de esquema para vincular
--    origem/data/usuário/estado de conferência. Gestão completa de documentos é
--    da Fase 9 (UI); a Fase 8 usa evidencia_ref na minuta para o fluxo de fechamento.
CREATE TABLE documentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  tipo TEXT,
  origem TEXT,
  estado_conferencia TEXT,
  evidencia_ref TEXT,
  incluido_por UUID REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documentos_processo_idx ON documentos (processo_id);

-- 6) Timeline: log append-only de eventos do ciclo de fechamento (NÃO é
--    field_observations — não são observações de campo). Diferencia evento
--    automático de ação humana e preserva ator/data-hora/evidência.
CREATE TABLE closing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processo_id UUID REFERENCES processos(id) ON DELETE CASCADE,
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  tipo_evento TEXT NOT NULL CHECK (tipo_evento IN (
    'EMPTY_RETURN', 'MINUTA_RECEBIDA', 'MINUTA_VALIDADA', 'MINUTA_REJEITADA',
    'DIVERGENCIA_TRACKING_MINUTA', 'RECALCULO', 'FECHAMENTO_FINAL',
    'REABERTURA_SOLICITADA', 'REABERTURA_AUTORIZADA', 'REABERTURA', 'REFECHAMENTO'
  )),
  origem TEXT NOT NULL CHECK (origem IN ('automatico', 'humano')),
  ator_usuario_id UUID REFERENCES usuarios(id),
  evidencia_ref TEXT,
  payload JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX closing_events_processo_idx ON closing_events (processo_id, criado_em);
CREATE INDEX closing_events_container_idx ON closing_events (container_id, criado_em);

-- Append-only (reusa forbid_mutation da 0004).
CREATE TRIGGER closing_events_append_only
  BEFORE UPDATE OR DELETE ON closing_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
