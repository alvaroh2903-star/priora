-- Demurrage Engine V2 — migration ADITIVA (Produção P1, isolamento da
-- integração Microsoft compartilhada). 0001-0050 não são reescritas; nenhuma
-- linha existente é alterada.
--
-- ORGANIZAÇÃO DONA da caixa postal da integração (ver
-- docs/demurrage-producao-p1-autenticacao-filas.md):
--  - a conta Microsoft da integração (`msal_conta_ativa`, 0027) é UMA caixa
--    postal; o que se lê dela (V1, captura do pré-alerta, reprocessamento da
--    SI) e o que se envia por ela (avisos) pertence a UMA organização — a dona,
--    vinculada aqui EXPLICITAMENTE pelo operador de plataforma (CLI);
--  - dona = vínculo ATIVO da conta ATUAL da integração. Trocar a conta da
--    integração deixa a conta nova SEM dona até um vínculo novo (nunca herda o
--    vínculo da anterior: a chave é o `home_account_id`);
--  - histórico preservado: linhas nunca são apagadas; o único UPDATE aceito é
--    o desvínculo (uma vez); a organização de um vínculo é imutável.

CREATE TABLE integracao_microsoft_vinculos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_account_id TEXT NOT NULL CHECK (btrim(home_account_id) <> ''),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  vinculado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Descrição do operador de plataforma (texto livre do CLI, como `usuario_eventos.ator_descricao`).
  vinculado_por TEXT NOT NULL CHECK (btrim(vinculado_por) <> ''),
  motivo TEXT NOT NULL CHECK (btrim(motivo) <> ''),
  desvinculado_em TIMESTAMPTZ,
  desvinculado_por TEXT,
  desvinculo_motivo TEXT,
  CONSTRAINT integracao_microsoft_vinculos_desvinculo_coerente CHECK (
    (desvinculado_em IS NULL AND desvinculado_por IS NULL AND desvinculo_motivo IS NULL)
    OR (desvinculado_em IS NOT NULL
        AND desvinculado_por IS NOT NULL AND btrim(desvinculado_por) <> ''
        AND desvinculo_motivo IS NOT NULL AND btrim(desvinculo_motivo) <> '')
  ),
  CONSTRAINT integracao_microsoft_vinculos_ordem CHECK (desvinculado_em IS NULL OR desvinculado_em >= vinculado_em)
);

-- Uma conta da integração tem no máximo UMA organização dona por vez.
CREATE UNIQUE INDEX integracao_microsoft_vinculos_um_ativo
  ON integracao_microsoft_vinculos (home_account_id) WHERE desvinculado_em IS NULL;
CREATE INDEX integracao_microsoft_vinculos_org_idx ON integracao_microsoft_vinculos (organization_id, vinculado_em);

-- Mesma regra padrão de toda tabela com organization_id (0007).
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON integracao_microsoft_vinculos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Histórico: DELETE proibido; UPDATE só para gravar o desvínculo, uma única
-- vez, sem mexer em nenhum campo do vínculo. (TRUNCATE dos testes não passa
-- por gatilho de linha, como nas demais trilhas append-only.)
CREATE OR REPLACE FUNCTION integracao_microsoft_vinculos_somente_desvinculo() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'integracao_microsoft_vinculos e historico: DELETE nao e permitido (vinculo %)', OLD.id;
  END IF;
  IF OLD.desvinculado_em IS NOT NULL THEN
    RAISE EXCEPTION 'integracao_microsoft_vinculos: vinculo % ja foi desvinculado e e imutavel', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.home_account_id IS DISTINCT FROM OLD.home_account_id
     OR NEW.vinculado_em IS DISTINCT FROM OLD.vinculado_em
     OR NEW.vinculado_por IS DISTINCT FROM OLD.vinculado_por
     OR NEW.motivo IS DISTINCT FROM OLD.motivo
     OR NEW.desvinculado_em IS NULL THEN
    RAISE EXCEPTION 'integracao_microsoft_vinculos: so o desvinculo pode ser gravado (vinculo %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integracao_microsoft_vinculos_historico
  BEFORE UPDATE OR DELETE ON integracao_microsoft_vinculos
  FOR EACH ROW EXECUTE FUNCTION integracao_microsoft_vinculos_somente_desvinculo();
