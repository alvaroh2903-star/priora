-- Demurrage Engine V2 — Fase 1: dados de referência GLOBAIS.
-- Armador, ContainerType e ContainerTypeMapping são compartilhados por todas
-- as organizações: MSC é o mesmo MSC para qualquer tenant da Priora — não
-- carregam organization_id (ver "Convenções — Multiempresa" no plano).

CREATE TABLE armadores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  codigo_interno TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT armadores_codigo_interno_unique UNIQUE (codigo_interno)
);

CREATE TABLE container_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT NOT NULL,
  nome TEXT NOT NULL,
  categoria TEXT NOT NULL,
  tamanho_pes INTEGER,
  CONSTRAINT container_types_codigo_unique UNIQUE (codigo)
);

-- Cap. 9 do Blueprint: o mapeamento precisa de histórico (vigente_desde/
-- vigente_ate) porque uma alteração de equivalência pode afetar cálculos
-- futuros sem apagar o registro anterior.
CREATE TABLE container_type_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  valor_original TEXT NOT NULL,
  fonte TEXT NOT NULL,
  container_type_id UUID NOT NULL REFERENCES container_types(id),
  regra_aplicada TEXT,
  vigente_desde DATE NOT NULL DEFAULT CURRENT_DATE,
  vigente_ate DATE,
  CONSTRAINT container_type_mappings_unique UNIQUE (valor_original, fonte, vigente_desde)
);

CREATE INDEX container_type_mappings_lookup_idx ON container_type_mappings(valor_original, fonte);
