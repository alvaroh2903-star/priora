-- S4 — Outlook do PRÓPRIO Analista (autenticação Microsoft DELEGADA, aprovada na decisão 4.3).
--
-- Uma conexão por pessoa (membership) e organização. Guarda o cache SERIALIZADO
-- do MSAL dessa pessoa, CIFRADO (AES-256-GCM com a mesma chave versionada do
-- cache da caixa monitorada; o dado autenticado amarra o cifrado à organização,
-- à membership e à conta, de modo que um registro não serve para outra pessoa).
-- Não existe coluna de token: o conteúdo é opaco para a Priora.
--
-- Por que uma tabela nova: `msal_cache_criptografado` é de linha única (a caixa
-- monitorada, id = 'default') e pertence ao legado do Demurrage; misturar os
-- tokens das pessoas nela juntaria duas contas que nunca podem se confundir.
--
-- Regras garantidas no banco (além da aplicação):
--  - a conta é a vinculada EXPLICITAMENTE à pessoa (`usuarios.home_account_id`);
--  - a membership é dessa pessoa e dessa organização, e não é CLIENT;
--  - a conta nunca é a de uma caixa monitorada ativa (Clara);
--  - organização, membership e usuário são imutáveis; desconectar apaga o cache
--    e avança a geração (escritas atrasadas são descartadas).
--
-- DOC-21: a conexão sobrevive ao logout da Priora (não é sessão) e só termina
-- por desconexão explícita da pessoa, revogação pela administração ou
-- invalidação pela Microsoft (token revogado/expirado). Usar a conexão exige
-- uma sessão autenticada DESSA pessoa: a linha é lida pela membership da sessão.
-- As regras de identidade valem para CONECTAR (e renovar); desconectar/revogar
-- vale sempre — inclusive para quem já perdeu o acesso (é como os tokens dela saem).
--
-- Reversão (em transação):
--   DROP TABLE outlook_conexoes_pessoa; DROP FUNCTION check_outlook_conexao_pessoa();
--   DELETE FROM schema_migrations WHERE filename = '0105_s4_outlook_da_pessoa.sql';

CREATE TABLE outlook_conexoes_pessoa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  membership_id UUID NOT NULL,
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  home_account_id TEXT NOT NULL CHECK (btrim(home_account_id) <> ''),
  username TEXT NOT NULL,
  escopos TEXT[] NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('CONECTADA', 'DESCONECTADA')),
  motivo_desconexao TEXT CHECK (motivo_desconexao IN ('PELA_PESSOA', 'REVOGADA_PELA_ADMINISTRACAO', 'INVALIDADA_PELA_MICROSOFT')),
  desconectada_por_membership_id UUID,
  geracao INTEGER NOT NULL DEFAULT 1 CHECK (geracao >= 1),
  revisao INTEGER NOT NULL DEFAULT 1 CHECK (revisao >= 1),
  algoritmo TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algoritmo = 'aes-256-gcm'),
  chave_versao INTEGER CHECK (chave_versao >= 1),
  iv BYTEA CHECK (octet_length(iv) = 12),
  auth_tag BYTEA CHECK (octet_length(auth_tag) = 16),
  dados BYTEA,
  conectada_em TIMESTAMPTZ NOT NULL,
  desconectada_em TIMESTAMPTZ,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outlook_conexoes_pessoa_membership_fk FOREIGN KEY (membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT outlook_conexoes_pessoa_uma_por_pessoa UNIQUE (organization_id, membership_id),
  CONSTRAINT outlook_conexoes_pessoa_cache CHECK (
    (estado = 'CONECTADA') = (chave_versao IS NOT NULL AND iv IS NOT NULL AND auth_tag IS NOT NULL AND dados IS NOT NULL)),
  CONSTRAINT outlook_conexoes_pessoa_desconexao CHECK (
    (estado = 'DESCONECTADA') = (desconectada_em IS NOT NULL)
    AND (estado = 'DESCONECTADA') = (motivo_desconexao IS NOT NULL)
    AND (estado = 'DESCONECTADA' OR desconectada_por_membership_id IS NULL)),
  -- Desconexão por pessoa (ela mesma ou a administração) guarda quem foi; a invalidação pela Microsoft não tem autor.
  CONSTRAINT outlook_conexoes_pessoa_autor_da_desconexao CHECK (
    motivo_desconexao IS NULL OR (motivo_desconexao = 'INVALIDADA_PELA_MICROSOFT') = (desconectada_por_membership_id IS NULL)),
  CONSTRAINT outlook_conexoes_pessoa_desconectada_por_fk FOREIGN KEY (desconectada_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT outlook_conexoes_pessoa_escopo_minimo CHECK ('Mail.ReadWrite' = ANY (escopos))
);

CREATE OR REPLACE FUNCTION check_outlook_conexao_pessoa() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.membership_id IS DISTINCT FROM OLD.membership_id OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id) THEN
    RAISE EXCEPTION 'outlook_conexoes_pessoa: membership e usuário são imutáveis';
  END IF;
  -- Desconectar/revogar sempre pode (sem cache, nada a proteger); as regras de identidade valem para conectar e renovar.
  IF NEW.estado = 'DESCONECTADA' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships m JOIN usuarios u ON u.id = m.usuario_id
     WHERE m.id = NEW.membership_id AND m.organization_id = NEW.organization_id AND m.usuario_id = NEW.usuario_id
       AND m.papel <> 'CLIENT' AND u.home_account_id = NEW.home_account_id
  ) THEN
    RAISE EXCEPTION 'outlook_conexoes_pessoa: a conta não é a vinculada à pessoa, ou a pessoa não é interna desta organização';
  END IF;
  IF EXISTS (
    SELECT 1 FROM email_caixas c WHERE c.home_account_id = NEW.home_account_id AND c.estado <> 'removida'
  ) THEN
    RAISE EXCEPTION 'outlook_conexoes_pessoa: a conta é de uma caixa monitorada; o Outlook do Analista nunca é a caixa monitorada';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outlook_conexoes_pessoa_regras
  BEFORE INSERT OR UPDATE ON outlook_conexoes_pessoa
  FOR EACH ROW EXECUTE FUNCTION check_outlook_conexao_pessoa();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON outlook_conexoes_pessoa
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
