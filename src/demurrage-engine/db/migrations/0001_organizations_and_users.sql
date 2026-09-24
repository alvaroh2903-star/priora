-- Demurrage Engine V2 — Fase 1: Fundação persistente
-- Multiempresa desde a primeira migration (decisão final #1, revisão 4).
--
-- Organization = empresa usuária da Priora (ex.: Rocket).
-- Usuario = identidade GLOBAL da pessoa, independente de organização,
--   vinculada preferencialmente ao home_account_id do MSAL (a mesma
--   identidade que src/auth/msalClient.ts e requireAuth.ts já usam para o
--   login com a Microsoft) — RBAC não cria um sistema de contas paralelo.
-- OrganizationMembership = o papel de um Usuario dentro de uma Organization.

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  slug TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_unique UNIQUE (slug)
);

CREATE TABLE usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL,
  email TEXT NOT NULL,
  -- Referência à identidade MSAL já existente (ver src/auth/activeAccount.ts).
  -- Nullable: um Usuario pode ser cadastrado (ex.: convite) antes do primeiro login.
  home_account_id TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usuarios_email_unique UNIQUE (email),
  CONSTRAINT usuarios_home_account_id_unique UNIQUE (home_account_id)
);

CREATE TYPE organization_role AS ENUM ('ANALYST', 'MANAGER', 'ADMIN', 'CLIENT');

CREATE TABLE organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  papel organization_role NOT NULL,
  -- FK para clientes(id) é adicionada na migration 0003, quando a tabela existir.
  -- Só é relevante quando papel = 'CLIENT'; um trigger (migration 0003) garante
  -- que o Cliente referenciado pertence à MESMA organization_id.
  cliente_id UUID,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Leitura literal do pedido ("contém O papel", singular): um papel por
  -- pessoa por organização nesta V1 do RBAC.
  CONSTRAINT organization_memberships_org_usuario_unique UNIQUE (organization_id, usuario_id)
);

CREATE INDEX organization_memberships_org_idx ON organization_memberships(organization_id);
CREATE INDEX organization_memberships_usuario_idx ON organization_memberships(usuario_id);
