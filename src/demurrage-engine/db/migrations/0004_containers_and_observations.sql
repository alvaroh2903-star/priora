-- Demurrage Engine V2 — Fase 1: Contêiner (unidade de cálculo, Cap. 3 do
-- Blueprint), FieldObservation (proveniência append-only) e Snapshot.
--
-- Campos críticos tipados + proveniência (ajuste da revisão 3, ponto 1):
-- Contêiner guarda o valor ATUALMENTE SELECIONADO de cada campo crítico,
-- tipado; cada um tem um ponteiro para o FieldObservation que o originou.
-- "Pendente" não é um enum — é o campo estar NULL.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% e append-only: % nao e permitido nesta tabela', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE containers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalizado do Processo pai (trigger garante consistência) — existe
  -- para índice/consulta direta; a unicidade real já é org-segura por
  -- transitividade via processo_id (ver constraint abaixo).
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL REFERENCES processos(id),
  numero TEXT NOT NULL,
  container_type_id UUID REFERENCES container_types(id),
  -- FKs para field_observations são adicionadas em ALTER TABLE abaixo, depois
  -- que a tabela field_observations existir nesta mesma migration.
  container_type_source_observation_id UUID,
  discharge_date DATE,
  discharge_date_observation_id UUID,
  house_free_time_days INTEGER,
  house_free_time_observation_id UUID,
  master_free_time_days INTEGER,
  master_free_time_observation_id UUID,
  gate_out_date DATE,
  gate_out_observation_id UUID,
  tracking_return_date DATE,
  tracking_return_observation_id UUID,
  -- Derivado (tracking_return_date, ou a data da Minuta validada quando essa
  -- entidade existir na Fase 8) — não é uma observação direta.
  effective_return_date DATE,
  -- tracking_target_id (Fase 5), estado/prioridade/motivo_prioridade
  -- (Cap. 21, Fase 7) entram por ALTER TABLE em fases futuras: nada os
  -- calcula ainda nesta Fase 1, então não nascem aqui (decisão técnica de
  -- sequenciamento, não altera nenhuma regra aprovada).
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT containers_processo_numero_unique UNIQUE (processo_id, numero)
);

CREATE INDEX containers_org_idx ON containers(organization_id);
CREATE INDEX containers_org_numero_idx ON containers(organization_id, numero);

CREATE TABLE field_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  entidade_tipo TEXT NOT NULL CHECK (entidade_tipo IN ('processo', 'container')),
  entidade_id UUID NOT NULL,
  campo TEXT NOT NULL,
  valor JSONB,
  fonte TEXT NOT NULL CHECK (
    fonte IN (
      'tracking_service', 'email_heuristic', 'manual_fallback',
      'house_document', 'master_bl', 'headcargo', 'outro'
    )
  ),
  -- Quando a fonte disse que o valor é este (distinto de coletado_em).
  observado_em TIMESTAMPTZ NOT NULL,
  -- Quando a Priora efetivamente gravou esta observação.
  coletado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidencia_ref TEXT,
  criado_por UUID REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Impede a MESMA fonte gravar o mesmo instante duas vezes; NÃO limita
  -- quantas fontes distintas observam o mesmo campo (ponto 1, revisão 3:
  -- "deve ser possível haver mais de duas fontes concorrentes").
  CONSTRAINT field_observations_unique UNIQUE (entidade_tipo, entidade_id, campo, fonte, observado_em)
);

CREATE INDEX field_observations_entidade_idx ON field_observations(entidade_tipo, entidade_id, campo);
CREATE INDEX field_observations_org_idx ON field_observations(organization_id);

CREATE TRIGGER field_observations_append_only
  BEFORE UPDATE OR DELETE ON field_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Agora que field_observations existe, liga os ponteiros de containers.
ALTER TABLE containers
  ADD CONSTRAINT containers_container_type_obs_fk
    FOREIGN KEY (container_type_source_observation_id) REFERENCES field_observations(id),
  ADD CONSTRAINT containers_discharge_obs_fk
    FOREIGN KEY (discharge_date_observation_id) REFERENCES field_observations(id),
  ADD CONSTRAINT containers_house_ft_obs_fk
    FOREIGN KEY (house_free_time_observation_id) REFERENCES field_observations(id),
  ADD CONSTRAINT containers_master_ft_obs_fk
    FOREIGN KEY (master_free_time_observation_id) REFERENCES field_observations(id),
  ADD CONSTRAINT containers_gate_out_obs_fk
    FOREIGN KEY (gate_out_observation_id) REFERENCES field_observations(id),
  ADD CONSTRAINT containers_tracking_return_obs_fk
    FOREIGN KEY (tracking_return_observation_id) REFERENCES field_observations(id);

CREATE TABLE snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  container_id UUID NOT NULL REFERENCES containers(id),
  versao INTEGER NOT NULL,
  -- FK para tracking_events adicionada na Fase 5, quando essa tabela existir.
  evento_origem_id UUID,
  dados_congelados JSONB NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT snapshots_container_versao_unique UNIQUE (container_id, versao)
);

CREATE INDEX snapshots_org_idx ON snapshots(organization_id);

CREATE TRIGGER snapshots_append_only
  BEFORE UPDATE OR DELETE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Triggers de consistência multiempresa.

CREATE OR REPLACE FUNCTION check_container_processo_org() RETURNS TRIGGER AS $$
DECLARE
  processo_org UUID;
BEGIN
  SELECT organization_id INTO processo_org FROM processos WHERE id = NEW.processo_id;
  IF processo_org IS NULL OR processo_org <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Conteiner.organization_id (%) nao corresponde a organizacao do Processo (%)',
      NEW.organization_id, processo_org;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER containers_processo_org_check
  BEFORE INSERT OR UPDATE ON containers
  FOR EACH ROW EXECUTE FUNCTION check_container_processo_org();

-- FieldObservation.entidade_id deve apontar para um registro da MESMA
-- organização declarada em FieldObservation.organization_id — nunca uma
-- observação "vazando" para a organização errada.
CREATE OR REPLACE FUNCTION check_field_observation_entidade_org() RETURNS TRIGGER AS $$
DECLARE
  entidade_org UUID;
BEGIN
  IF NEW.entidade_tipo = 'container' THEN
    SELECT organization_id INTO entidade_org FROM containers WHERE id = NEW.entidade_id;
  ELSIF NEW.entidade_tipo = 'processo' THEN
    SELECT organization_id INTO entidade_org FROM processos WHERE id = NEW.entidade_id;
  END IF;
  IF entidade_org IS NULL OR entidade_org <> NEW.organization_id THEN
    RAISE EXCEPTION
      'FieldObservation.organization_id (%) nao corresponde a organizacao da entidade referenciada (%, %)',
      NEW.organization_id, NEW.entidade_tipo, NEW.entidade_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER field_observations_entidade_org_check
  BEFORE INSERT ON field_observations
  FOR EACH ROW EXECUTE FUNCTION check_field_observation_entidade_org();

CREATE OR REPLACE FUNCTION check_snapshot_container_org() RETURNS TRIGGER AS $$
DECLARE
  container_org UUID;
BEGIN
  SELECT organization_id INTO container_org FROM containers WHERE id = NEW.container_id;
  IF container_org IS NULL OR container_org <> NEW.organization_id THEN
    RAISE EXCEPTION
      'Snapshot.organization_id (%) nao corresponde a organizacao do Conteiner (%)',
      NEW.organization_id, container_org;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER snapshots_container_org_check
  BEFORE INSERT ON snapshots
  FOR EACH ROW EXECUTE FUNCTION check_snapshot_container_org();
