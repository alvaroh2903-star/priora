-- Demurrage Engine V2 — migration ADITIVA (Fase D10 — Demurrage vertical).
-- 0001-0027 NÃO são reescritas. Nenhuma regra congelada (relógios, tarifas,
-- hierarquia de fontes, cadência, responsabilidade, minuta, fechamento) muda.
--
-- Suporte ao CONTRATO TÉCNICO de registro na Demurrage (`demurrage.registro.v1`):
--   1) demurrage_registros       — ledger idempotente/auditável de cada chamada;
--   2) processo_campos_selecionados — ponteiro (processo, campo) → observação que
--      selecionou o valor tipado de `processos` (mesma hierarquia de fontes dos
--      contêineres, aplicada aos campos do processo; histórico no ledger
--      append-only `field_observations`);
--   3) container_equipamento_original — tipo ORIGINAL (bruto) do contêiner +
--      código normalizado e regra aplicada (o histórico bruto também vai para
--      `field_observations`, campo 'tipoEquipamentoOriginal');
--   4) demurrage_pendencias      — pendências explícitas do registro (armador,
--      MBL, tipo) — nada é inventado para preenchê-las;
--   5) armador_codigos_tracking  — referência GLOBAL: código interno do armador
--      (`armadores.codigo_interno`) → identificador do carrier na API central de
--      tracking (vocabulários diferentes: 'CMA' × 'cmacgm'). Sem fuzzy.

-- ---------------------------------------------------------------------------
-- 1) Ledger do contrato: uma linha por (organização, chave de idempotência).
-- ---------------------------------------------------------------------------
CREATE TABLE demurrage_registros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  versao_contrato TEXT NOT NULL CHECK (versao_contrato = 'demurrage.registro.v1'),
  chave_idempotencia TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  origem_sistema TEXT NOT NULL,
  origem_referencia TEXT,
  resultado JSONB NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demurrage_registros_chave_unica UNIQUE (organization_id, chave_idempotencia),
  CONSTRAINT demurrage_registros_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id)
);
CREATE INDEX demurrage_registros_processo_idx ON demurrage_registros (processo_id, criado_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_registros
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
CREATE TRIGGER demurrage_registros_append_only
  BEFORE UPDATE OR DELETE ON demurrage_registros
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- 2) Seleção dos campos do processo pela hierarquia de fontes.
-- ---------------------------------------------------------------------------
CREATE TABLE processo_campos_selecionados (
  processo_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  campo TEXT NOT NULL CHECK (campo IN ('mbl', 'hbl', 'armador', 'cliente', 'condicaoComercial', 'responsavelOperacional')),
  observation_id UUID NOT NULL REFERENCES field_observations(id),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (processo_id, campo),
  CONSTRAINT processo_campos_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id)
);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON processo_campos_selecionados
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 3) Tipo original do contêiner (bruto) + normalização aplicada.
-- ---------------------------------------------------------------------------
CREATE TABLE container_equipamento_original (
  container_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  tipo_original TEXT NOT NULL,
  fonte TEXT NOT NULL,
  observado_em TIMESTAMPTZ NOT NULL,
  evidencia_ref TEXT,
  codigo_normalizado TEXT,
  regra_aplicada TEXT CHECK (regra_aplicada IS NULL OR regra_aplicada IN ('mapeamento', 'identidade')),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT container_equip_normalizacao CHECK ((codigo_normalizado IS NULL) = (regra_aplicada IS NULL)),
  CONSTRAINT container_equip_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id)
);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON container_equipamento_original
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4) Pendências do registro. Uma ABERTA por (processo, contêiner, tipo);
--    resolver preserva a linha (histórico).
-- ---------------------------------------------------------------------------
CREATE TABLE demurrage_pendencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  container_id UUID,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'armador_ausente', 'armador_nao_cadastrado', 'armador_sem_tracking',
    'mbl_ausente', 'tipo_ausente', 'tipo_nao_reconhecido'
  )),
  contexto JSONB NOT NULL DEFAULT '{}'::jsonb,
  estado TEXT NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta', 'resolvida')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ,
  CONSTRAINT demurrage_pendencias_resolucao CHECK ((estado = 'resolvida') = (resolvido_em IS NOT NULL)),
  CONSTRAINT demurrage_pendencias_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT demurrage_pendencias_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id)
);
CREATE UNIQUE INDEX demurrage_pendencias_aberta_unica
  ON demurrage_pendencias (processo_id, COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo)
  WHERE estado = 'aberta';
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_pendencias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 5) Código interno do armador → carrier da API central de tracking (global).
-- ---------------------------------------------------------------------------
CREATE TABLE armador_codigos_tracking (
  codigo_interno TEXT PRIMARY KEY,
  carrier_tracking TEXT NOT NULL
);
INSERT INTO armador_codigos_tracking (codigo_interno, carrier_tracking) VALUES
  ('MSC', 'msc'), ('HAPAG', 'hapag'), ('CMA', 'cmacgm'), ('MAERSK', 'maersk'),
  ('ONE', 'one'), ('PIL', 'pil'), ('YANGMING', 'yangming'), ('HMM', 'hmm'),
  ('EVERGREEN', 'evergreen'), ('COSCO', 'cosco'), ('OOCL', 'oocl'), ('ZIM', 'zim');
