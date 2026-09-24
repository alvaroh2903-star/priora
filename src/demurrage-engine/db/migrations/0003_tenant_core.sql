-- Demurrage Engine V2 — Fase 1: núcleo de tenant (Cliente, CondicaoComercial,
-- Processo). Toda tabela aqui carrega organization_id e é protegida por
-- trigger contra associação acidental com registros de outra organização
-- (decisão final #1, revisão 4).
--
-- Nota de investigação: src/routes/processRoutes.ts (único candidato a
-- "cadastro central de Processo" já existente na Priora) foi confirmado
-- stateless — monta processos ao vivo agrupando e-mail, sem persistência.
-- Cliente/Processo nascem aqui como registros locais e operacionais do
-- módulo Demurrage, com ref_externa reservado para uma futura integração
-- central (HeadCargo ou outra), não como cadastro corporativo duplicado.

CREATE TABLE clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  nome TEXT NOT NULL,
  -- O Blueprint não define regra de unicidade para identidade de cliente;
  -- não inventamos uma. `documento` fica informativo, sem constraint.
  documento TEXT,
  contatos JSONB,
  ref_externa TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX clientes_org_idx ON clientes(organization_id);

-- Agora que `clientes` existe, liga o vínculo opcional de
-- organization_memberships.cliente_id (papel CLIENT) e garante consistência
-- de organização com um trigger.
ALTER TABLE organization_memberships
  ADD CONSTRAINT organization_memberships_cliente_fk
    FOREIGN KEY (cliente_id) REFERENCES clientes(id);

CREATE OR REPLACE FUNCTION check_membership_cliente_org() RETURNS TRIGGER AS $$
DECLARE
  cliente_org UUID;
BEGIN
  IF NEW.cliente_id IS NOT NULL THEN
    SELECT organization_id INTO cliente_org FROM clientes WHERE id = NEW.cliente_id;
    IF cliente_org IS NULL OR cliente_org <> NEW.organization_id THEN
      RAISE EXCEPTION
        'OrganizationMembership.organization_id (%) nao corresponde a organizacao do Cliente (%)',
        NEW.organization_id, cliente_org;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organization_memberships_cliente_org_check
  BEFORE INSERT OR UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION check_membership_cliente_org();

-- Decisão final #3 (revisão 4): não existe fato gerador universal.
-- CondicaoComercial NÃO tem fato_gerador_data — cada motor comercial (Fase 4)
-- determina sua própria regra temporal a partir do instrumento aplicável.
-- tabela_id (referência à tabela tarifária) só é adicionado por ALTER TABLE
-- na Fase 4, quando TabelaTarifaria existir.
CREATE TYPE termo_comercial_tipo AS ENUM ('embarque', 'unico');

CREATE TABLE condicoes_comerciais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  termo_tipo termo_comercial_tipo NOT NULL,
  fonte_documental TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX condicoes_comerciais_org_idx ON condicoes_comerciais(organization_id);

CREATE TABLE processos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  -- Nullable: um processo pode nascer do backfill sem o número Rocket ainda
  -- identificado (ver ContainerDataSource / runBackfill). "Nada inventado":
  -- fica pendente em vez de receber um valor fabricado.
  numero_processo TEXT,
  -- Nullable pelo mesmo motivo: o backfill frequentemente encontra um
  -- contêiner sem conseguir identificar o cliente a partir do e-mail.
  cliente_id UUID REFERENCES clientes(id),
  mbl TEXT,
  hbl TEXT,
  armador_id UUID REFERENCES armadores(id),
  condicao_comercial_id UUID REFERENCES condicoes_comerciais(id),
  responsavel_operacional_id UUID REFERENCES usuarios(id),
  ref_externa TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- UNIQUE com coluna nullable: Postgres trata múltiplos NULLs como
  -- não-conflitantes, então vários processos "sem número ainda" na mesma
  -- organização coexistem sem violar a constraint — é o comportamento
  -- desejado (cada um pendente de identificação, não um duplicata).
  CONSTRAINT processos_org_numero_unique UNIQUE (organization_id, numero_processo)
);

CREATE INDEX processos_org_idx ON processos(organization_id);
CREATE INDEX processos_org_cliente_idx ON processos(organization_id, cliente_id);

CREATE OR REPLACE FUNCTION check_processo_cliente_org() RETURNS TRIGGER AS $$
DECLARE
  cliente_org UUID;
BEGIN
  IF NEW.cliente_id IS NOT NULL THEN
    SELECT organization_id INTO cliente_org FROM clientes WHERE id = NEW.cliente_id;
    IF cliente_org IS NULL OR cliente_org <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Processo.organization_id (%) nao corresponde a organizacao do Cliente (%)',
        NEW.organization_id, cliente_org;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processos_cliente_org_check
  BEFORE INSERT OR UPDATE ON processos
  FOR EACH ROW EXECUTE FUNCTION check_processo_cliente_org();

CREATE OR REPLACE FUNCTION check_processo_condicao_org() RETURNS TRIGGER AS $$
DECLARE
  cond_org UUID;
BEGIN
  IF NEW.condicao_comercial_id IS NOT NULL THEN
    SELECT organization_id INTO cond_org FROM condicoes_comerciais WHERE id = NEW.condicao_comercial_id;
    IF cond_org IS NULL OR cond_org <> NEW.organization_id THEN
      RAISE EXCEPTION
        'Processo.organization_id (%) nao corresponde a organizacao da CondicaoComercial (%)',
        NEW.organization_id, cond_org;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processos_condicao_org_check
  BEFORE INSERT OR UPDATE ON processos
  FOR EACH ROW EXECUTE FUNCTION check_processo_condicao_org();
