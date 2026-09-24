-- Demurrage Engine V2 — migration ADITIVA (revisão 7 do plano, Fase 4).
-- 0001-0008 não são reescritas.
--
-- Motor tarifário e versionamento. Três instrumentos comerciais diferentes
-- (Termo por Embarque, Termo Único, Exposição Rocket) compartilham a mesma
-- INFRAESTRUTURA de tabela versionada/faixa, mas cada um é um motor de negócio
-- separado no código (Cap. 24.1/24.2/24.3). Aqui só o schema.
--
-- Princípios (Blueprint Cap. 8 e 24; decisões finais #3):
-- - Tabelas são versionadas e históricas: uma versão usada por um cálculo nunca
--   é sobrescrita. Nova negociação = nova versão (nova linha), a antiga
--   permanece para reconstrução.
-- - `day_count_basis` é EXPLÍCITO por tabela: contagem absoluta desde a descarga
--   ou contagem em dias excedentes ao free time. Nunca inferido pelo armador nem
--   pela faixa.
-- - `ValorApurado` é a memória de cálculo (append-only, exceto a transição de
--   `calculation_status`): guarda o suficiente para reconstruir POR QUE um valor
--   foi calculado sem depender da regra atual do sistema.

CREATE TYPE tariff_table_tipo AS ENUM ('rocket_cliente', 'armador');
CREATE TYPE tariff_qualidade_fonte AS ENUM (
  'OFICIAL_VALIDADA', 'OFICIAL_NAO_VALIDADA', 'PUBLICA_ESTIMATIVA', 'PROVISORIA_INCOMPLETA'
);
CREATE TYPE tariff_day_count_basis AS ENUM ('since_discharge_absolute', 'excess_over_free_time');
CREATE TYPE valor_motor_comercial AS ENUM ('termo_embarque', 'termo_unico', 'exposicao_armador');
CREATE TYPE valor_confirmation_status AS ENUM ('ESTIMATED', 'ESTIMATED_PROVISIONAL', 'CONFIRMED', 'UNAVAILABLE');
CREATE TYPE valor_calculation_status AS ENUM ('OPEN', 'FINAL', 'SUPERSEDED');

-- ---------------------------------------------------------------------------
-- Tabelas tarifárias versionadas
-- ---------------------------------------------------------------------------

CREATE TABLE tariff_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = tabela pública/compartilhada (ex.: tabelas de armador do Blueprint).
  -- Preenchido = tabela privada negociada por uma organização (Rocket×cliente).
  organization_id UUID REFERENCES organizations(id),
  tipo tariff_table_tipo NOT NULL,
  armador_id UUID REFERENCES armadores(id),
  termo_comercial termo_comercial_tipo,
  versao INTEGER NOT NULL CHECK (versao >= 1),
  vigencia_inicio DATE NOT NULL,
  vigencia_fim DATE,
  qualidade_fonte tariff_qualidade_fonte NOT NULL,
  day_count_basis tariff_day_count_basis NOT NULL,
  fonte TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tariff_tables_vigencia_coerente CHECK (vigencia_fim IS NULL OR vigencia_fim >= vigencia_inicio),
  -- Coerência tipo × instrumento: Rocket×cliente sempre tem termo_comercial e
  -- nunca armador; tabela de armador sempre tem armador e nunca termo_comercial.
  CONSTRAINT tariff_tables_tipo_coerente CHECK (
    (tipo = 'rocket_cliente' AND termo_comercial IS NOT NULL AND armador_id IS NULL)
    OR (tipo = 'armador' AND armador_id IS NOT NULL AND termo_comercial IS NULL)
  ),
  -- Unicidade das tabelas privadas por organização.
  CONSTRAINT tariff_tables_versao_unica UNIQUE (organization_id, tipo, armador_id, termo_comercial, versao)
);

-- Unicidade das tabelas públicas de armador (organization_id NULL não participa
-- da UNIQUE acima porque NULLs não conflitam por padrão no Postgres).
CREATE UNIQUE INDEX tariff_tables_armador_publica_unica
  ON tariff_tables (armador_id, versao)
  WHERE organization_id IS NULL;

CREATE INDEX tariff_tables_lookup_idx
  ON tariff_tables (tipo, armador_id, termo_comercial, organization_id, vigencia_inicio);

-- Convenção da DECISÃO 1 (0007): toda tabela de tenant com organization_id é
-- imutável quanto à organização. Vale também para a tabela privada Rocket
-- (organization_id preenchido); as tabelas públicas de armador (NULL) nunca
-- migram para uma organização. Reusa a função genérica forbid_organization_change.
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON tariff_tables
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TABLE tariff_brackets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_table_id UUID NOT NULL REFERENCES tariff_tables(id) ON DELETE CASCADE,
  tipo_equipamento TEXT NOT NULL,
  dia_inicial INTEGER NOT NULL CHECK (dia_inicial >= 1),
  -- NULL = faixa aberta (até o infinito). Termo por Embarque é uma única faixa
  -- aberta [1, ∞) por equipamento (tarifa fixa por dia, sem progressão).
  dia_final INTEGER CHECK (dia_final IS NULL OR dia_final >= dia_inicial),
  valor_dia NUMERIC(12, 2) NOT NULL CHECK (valor_dia >= 0),
  moeda TEXT NOT NULL,
  CONSTRAINT tariff_brackets_unica UNIQUE (tariff_table_id, tipo_equipamento, dia_inicial)
);

CREATE INDEX tariff_brackets_lookup_idx ON tariff_brackets (tariff_table_id, tipo_equipamento, dia_inicial);

-- ---------------------------------------------------------------------------
-- Valor apurado — memória de cálculo (append-only, exceto calculation_status)
-- ---------------------------------------------------------------------------

CREATE TABLE valores_apurados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  relogio_tipo TEXT NOT NULL CHECK (relogio_tipo IN ('cliente', 'rocket')),
  motor_comercial valor_motor_comercial NOT NULL,
  tabela_id UUID REFERENCES tariff_tables(id),
  versao_tabela INTEGER,
  -- NULL quando o motor não usa faixa (Termo por Embarque, tarifa fixa).
  day_count_basis_aplicada tariff_day_count_basis,
  period_start DATE,
  period_end DATE,
  dias_cobrados INTEGER CHECK (dias_cobrados IS NULL OR dias_cobrados >= 0),
  faixas_aplicadas JSONB NOT NULL DEFAULT '[]',
  total NUMERIC(14, 2) CHECK (total IS NULL OR total >= 0),
  moeda TEXT,
  confirmation_status valor_confirmation_status NOT NULL,
  custo_real_confirmado_ref TEXT,
  calculation_status valor_calculation_status NOT NULL DEFAULT 'OPEN',
  engine_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  supersedes_id UUID REFERENCES valores_apurados(id),
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- CONFIRMED só com referência de custo real (nunca só por tabela validada).
  CONSTRAINT valores_confirmed_exige_ref CHECK (
    confirmation_status <> 'CONFIRMED' OR custo_real_confirmado_ref IS NOT NULL
  ),
  -- UNAVAILABLE não tem número; os demais status têm total/dias/moeda.
  CONSTRAINT valores_forma_por_status CHECK (
    (confirmation_status = 'UNAVAILABLE' AND total IS NULL AND dias_cobrados IS NULL)
    OR (confirmation_status <> 'UNAVAILABLE' AND total IS NOT NULL AND dias_cobrados IS NOT NULL AND moeda IS NOT NULL)
  )
);

-- No máximo um valor ATIVO (OPEN/FINAL) por (contêiner, relógio, motor). Um
-- recálculo marca o anterior como SUPERSEDED antes de inserir o novo.
CREATE UNIQUE INDEX valores_apurados_ativo_unico
  ON valores_apurados (container_id, relogio_tipo, motor_comercial)
  WHERE calculation_status IN ('OPEN', 'FINAL');

CREATE INDEX valores_apurados_container_idx ON valores_apurados (container_id, relogio_tipo, motor_comercial);

-- Append-only: nada de DELETE; no UPDATE só a transição de calculation_status
-- (para frente) e a confirmação de custo real (confirmation_status +
-- custo_real_confirmado_ref). Nenhuma coluna de memória de cálculo muda.
CREATE OR REPLACE FUNCTION forbid_valor_apurado_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'valores_apurados e append-only: DELETE nao e permitido (registro %)', OLD.id;
  END IF;
  IF NEW.container_id <> OLD.container_id
     OR NEW.relogio_tipo <> OLD.relogio_tipo
     OR NEW.motor_comercial <> OLD.motor_comercial
     OR NEW.tabela_id IS DISTINCT FROM OLD.tabela_id
     OR NEW.versao_tabela IS DISTINCT FROM OLD.versao_tabela
     OR NEW.day_count_basis_aplicada IS DISTINCT FROM OLD.day_count_basis_aplicada
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.dias_cobrados IS DISTINCT FROM OLD.dias_cobrados
     OR NEW.faixas_aplicadas IS DISTINCT FROM OLD.faixas_aplicadas
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.moeda IS DISTINCT FROM OLD.moeda
     OR NEW.engine_version <> OLD.engine_version
     OR NEW.input_hash <> OLD.input_hash
     OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.calculated_at <> OLD.calculated_at THEN
    RAISE EXCEPTION 'valores_apurados e append-only: so calculation_status e a confirmacao de custo podem mudar (registro %)', OLD.id;
  END IF;
  IF NEW.calculation_status <> OLD.calculation_status
     AND NOT (
       (OLD.calculation_status = 'OPEN' AND NEW.calculation_status IN ('FINAL', 'SUPERSEDED'))
       OR (OLD.calculation_status = 'FINAL' AND NEW.calculation_status = 'SUPERSEDED')
     ) THEN
    RAISE EXCEPTION 'transicao de calculation_status invalida: % -> %', OLD.calculation_status, NEW.calculation_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER valores_apurados_append_only
  BEFORE UPDATE OR DELETE ON valores_apurados
  FOR EACH ROW EXECUTE FUNCTION forbid_valor_apurado_mutation();

-- ---------------------------------------------------------------------------
-- Vínculo condição comercial → tabela Rocket (Termo por Embarque: versão fixa
-- no processo/condição). A tabela referenciada tem que ser da mesma organização.
-- ---------------------------------------------------------------------------

ALTER TABLE condicoes_comerciais ADD COLUMN tabela_id UUID REFERENCES tariff_tables(id);

CREATE OR REPLACE FUNCTION check_condicao_tabela_same_org() RETURNS TRIGGER AS $$
DECLARE
  tabela_org UUID;
  tabela_termo termo_comercial_tipo;
BEGIN
  IF NEW.tabela_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id, termo_comercial INTO tabela_org, tabela_termo
    FROM tariff_tables WHERE id = NEW.tabela_id;
  IF tabela_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'condicao comercial % e tabela % sao de organizacoes diferentes', NEW.id, NEW.tabela_id;
  END IF;
  IF tabela_termo IS DISTINCT FROM NEW.termo_tipo THEN
    RAISE EXCEPTION 'termo da condicao (%) difere do termo da tabela (%)', NEW.termo_tipo, tabela_termo;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER condicoes_comerciais_tabela_same_org
  BEFORE INSERT OR UPDATE OF tabela_id, organization_id, termo_tipo ON condicoes_comerciais
  FOR EACH ROW EXECUTE FUNCTION check_condicao_tabela_same_org();

-- ---------------------------------------------------------------------------
-- Seed GLOBAL: vocabulário de equipamento (Cap. 9). São as classes que a tabela
-- Rocket do Blueprint precifica (DV/HC, OT, FR, NOR, RE em 20' e 40'). Não é uma
-- tabela de equivalências ISO (essa o Blueprint deixa como pendência dele mesmo)
-- — é só o conjunto de códigos normalizados que as tarifas usam.
-- ---------------------------------------------------------------------------

INSERT INTO container_types (codigo, nome, categoria, tamanho_pes) VALUES
  ('20DV',  'Dry Van 20',              'dry',       20),
  ('40DV',  'Dry Van 40',              'dry',       40),
  ('20HC',  'High Cube 20',            'high_cube', 20),
  ('40HC',  'High Cube 40',            'high_cube', 40),
  ('20OT',  'Open Top 20',             'open_top',  20),
  ('40OT',  'Open Top 40',             'open_top',  40),
  ('20FR',  'Flat Rack 20',            'flat_rack', 20),
  ('40FR',  'Flat Rack 40',            'flat_rack', 40),
  ('20NOR', 'Non-Operating Reefer 20', 'nor',       20),
  ('40NOR', 'Non-Operating Reefer 40', 'nor',       40),
  ('20RE',  'Reefer 20',               'reefer',    20),
  ('40RE',  'Reefer 40',               'reefer',    40);
