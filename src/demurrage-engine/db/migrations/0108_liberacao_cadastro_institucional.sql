-- Liberação — cadastro institucional da organização (decisão O1.8, registrada em 14.19).
--
-- Os quatro documentos de apresentação usam os MESMOS dados fixos da própria organização. As duas fontes já
-- estavam previstas no domínio documental, sem lugar para ficar:
--  - `CADASTRO_DA_ORGANIZACAO`: CNPJ, razão social, endereço, telefone e contatos;
--  - `CADASTRO_DO_SIGNATARIO_LEGAL` (DOC-23): nome civil, CPF, qualificação e evidência do signatário legal, com a
--    comprovação dos poderes quando registrada (nunca presumida).
-- Esta migração cria os dois registros VAZIOS: quem cadastra é a administração da organização, pela API. Nenhum
-- dado institucional fica no código.
--
-- Regras garantidas no banco (além da aplicação):
--  - isolamento: organização obrigatória e imutável;
--  - só um ADMIN da MESMA organização grava (papel conferido no instante da gravação);
--  - append-only: corrigir é registrar de novo; o histórico nunca é alterado nem apagado;
--  - CNPJ e CPF só com dígitos e com os dígitos verificadores válidos;
--  - nenhum texto vazio nem com caractere de controle (os lugares desses dados nos modelos são de uma linha).
--
-- Reversão (em transação):
--   DROP TABLE organizacao_signatarios_legais; DROP TABLE organizacao_cadastro_institucional;
--   DROP FUNCTION organizacao_signatario_regras(); DROP FUNCTION organizacao_cadastro_por_admin();
--   DROP FUNCTION texto_de_uma_linha(TEXT); DROP FUNCTION cnpj_digitos_validos(TEXT); DROP FUNCTION cpf_digitos_validos(TEXT);
--   DELETE FROM schema_migrations WHERE filename = '0108_liberacao_cadastro_institucional.sql';

CREATE OR REPLACE FUNCTION cnpj_digitos_validos(v TEXT) RETURNS BOOLEAN AS $$
DECLARE
  pesos1 INT[] := ARRAY[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  pesos2 INT[] := ARRAY[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  s INT;
  r INT;
  d1 INT;
  d2 INT;
BEGIN
  IF v IS NULL OR v !~ '^[0-9]{14}$' OR v ~ '^(.)\1{13}$' THEN
    RETURN FALSE;
  END IF;
  s := 0;
  FOR i IN 1..12 LOOP s := s + substr(v, i, 1)::INT * pesos1[i]; END LOOP;
  r := s % 11;
  d1 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  s := 0;
  FOR i IN 1..12 LOOP s := s + substr(v, i, 1)::INT * pesos2[i]; END LOOP;
  s := s + d1 * pesos2[13];
  r := s % 11;
  d2 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  RETURN substr(v, 13, 1)::INT = d1 AND substr(v, 14, 1)::INT = d2;
END
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION cpf_digitos_validos(v TEXT) RETURNS BOOLEAN AS $$
DECLARE
  s INT;
  r INT;
  d1 INT;
  d2 INT;
BEGIN
  IF v IS NULL OR v !~ '^[0-9]{11}$' OR v ~ '^(.)\1{10}$' THEN
    RETURN FALSE;
  END IF;
  s := 0;
  FOR i IN 1..9 LOOP s := s + substr(v, i, 1)::INT * (11 - i); END LOOP;
  r := (s * 10) % 11;
  d1 := CASE WHEN r = 10 THEN 0 ELSE r END;
  s := 0;
  FOR i IN 1..9 LOOP s := s + substr(v, i, 1)::INT * (12 - i); END LOOP;
  s := s + d1 * 2;
  r := (s * 10) % 11;
  d2 := CASE WHEN r = 10 THEN 0 ELSE r END;
  RETURN substr(v, 10, 1)::INT = d1 AND substr(v, 11, 1)::INT = d2;
END
$$ LANGUAGE plpgsql IMMUTABLE;

-- NULL (dado não cadastrado) passa; texto cadastrado precisa ter conteúdo e nenhum caractere de controle (nem quebra).
CREATE OR REPLACE FUNCTION texto_de_uma_linha(t TEXT) RETURNS BOOLEAN AS $$
  SELECT t IS NULL OR (btrim(t) <> '' AND t !~ '[[:cntrl:]]');
$$ LANGUAGE sql IMMUTABLE;

-- Só um ADMIN da MESMA organização grava, com o papel que tem AGORA.
CREATE OR REPLACE FUNCTION organizacao_cadastro_por_admin() RETURNS TRIGGER AS $$
DECLARE
  papel_atual organization_role;
BEGIN
  SELECT papel INTO papel_atual FROM organization_memberships
   WHERE id = NEW.registrado_por_membership_id AND organization_id = NEW.organization_id FOR SHARE;
  IF papel_atual IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'CADASTRO_INSTITUCIONAL_EXIGE_ADMIN: membership % não é ADMIN desta organização', NEW.registrado_por_membership_id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 1) Dados fixos da organização. Cada linha é o cadastro COMPLETO naquele instante; vale a mais recente.
CREATE TABLE organizacao_cadastro_institucional (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  cnpj TEXT NOT NULL CHECK (cnpj_digitos_validos(cnpj)),
  razao_social TEXT CHECK (texto_de_uma_linha(razao_social)),
  endereco TEXT CHECK (texto_de_uma_linha(endereco)),
  telefone TEXT CHECK (texto_de_uma_linha(telefone)),
  contato_sobreestadia_nome TEXT CHECK (texto_de_uma_linha(contato_sobreestadia_nome)),
  contato_sobreestadia_email TEXT CHECK (texto_de_uma_linha(contato_sobreestadia_email)),
  emails_para_recibo TEXT CHECK (texto_de_uma_linha(emails_para_recibo)),
  motivo TEXT CHECK (texto_de_uma_linha(motivo)),
  registrado_por_membership_id UUID NOT NULL REFERENCES organization_memberships(id),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX organizacao_cadastro_institucional_atual_idx ON organizacao_cadastro_institucional (organization_id, registrado_em DESC, id DESC);

CREATE TRIGGER organizacao_cadastro_institucional_append_only
  BEFORE UPDATE OR DELETE ON organizacao_cadastro_institucional
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON organizacao_cadastro_institucional
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TRIGGER organizacao_cadastro_institucional_por_admin
  BEFORE INSERT ON organizacao_cadastro_institucional
  FOR EACH ROW EXECUTE FUNCTION organizacao_cadastro_por_admin();

-- 2) Signatário legal (DOC-23), por eventos: CADASTRADO (dados e evidência; um novo CADASTRADO corrige), PODERES_COMPROVADOS
--    (evidência e validade, nunca presumidos) e REVOGADO (definitivo). O signatário não precisa ser usuário da Priora.
CREATE TABLE organizacao_signatarios_legais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  signatario_id UUID NOT NULL,
  evento TEXT NOT NULL CHECK (evento IN ('CADASTRADO', 'PODERES_COMPROVADOS', 'REVOGADO')),
  nome TEXT CHECK (texto_de_uma_linha(nome)),
  cpf TEXT CHECK (cpf IS NULL OR cpf_digitos_validos(cpf)),
  qualificacao TEXT CHECK (texto_de_uma_linha(qualificacao)),
  -- Descrição da evidência registrada pela administração (ex.: documento societário ou procuração e onde está arquivado).
  evidencia TEXT CHECK (texto_de_uma_linha(evidencia)),
  poderes_valido_ate DATE,
  motivo TEXT CHECK (texto_de_uma_linha(motivo)),
  registrado_por_membership_id UUID NOT NULL REFERENCES organization_memberships(id),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizacao_signatario_evento_completo CHECK (
    (evento = 'CADASTRADO' AND nome IS NOT NULL AND cpf IS NOT NULL AND qualificacao IS NOT NULL AND evidencia IS NOT NULL AND poderes_valido_ate IS NULL)
    OR (evento = 'PODERES_COMPROVADOS' AND evidencia IS NOT NULL AND nome IS NULL AND cpf IS NULL AND qualificacao IS NULL)
    OR (evento = 'REVOGADO' AND motivo IS NOT NULL AND nome IS NULL AND cpf IS NULL AND qualificacao IS NULL AND evidencia IS NULL AND poderes_valido_ate IS NULL)
  )
);

CREATE INDEX organizacao_signatarios_legais_org_idx ON organizacao_signatarios_legais (organization_id, signatario_id, registrado_em, id);

CREATE TRIGGER organizacao_signatarios_legais_append_only
  BEFORE UPDATE OR DELETE ON organizacao_signatarios_legais
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON organizacao_signatarios_legais
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TRIGGER organizacao_signatarios_legais_por_admin
  BEFORE INSERT ON organizacao_signatarios_legais
  FOR EACH ROW EXECUTE FUNCTION organizacao_cadastro_por_admin();

-- Poderes e revogação só para um signatário cadastrado NESTA organização; revogado não recebe mais nada.
CREATE OR REPLACE FUNCTION organizacao_signatario_regras() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.evento <> 'CADASTRADO' AND NOT EXISTS (
    SELECT 1 FROM organizacao_signatarios_legais
     WHERE organization_id = NEW.organization_id AND signatario_id = NEW.signatario_id AND evento = 'CADASTRADO'
  ) THEN
    RAISE EXCEPTION 'SIGNATARIO_INEXISTENTE: signatário % não cadastrado nesta organização', NEW.signatario_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM organizacao_signatarios_legais
     WHERE organization_id = NEW.organization_id AND signatario_id = NEW.signatario_id AND evento = 'REVOGADO'
  ) THEN
    RAISE EXCEPTION 'SIGNATARIO_REVOGADO: signatário % já revogado', NEW.signatario_id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizacao_signatarios_legais_regras
  BEFORE INSERT ON organizacao_signatarios_legais
  FOR EACH ROW EXECUTE FUNCTION organizacao_signatario_regras();
