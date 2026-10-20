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
--  - isolamento: organização obrigatória e imutável; o autor é membership DA MESMA organização (FK composta);
--  - só um ADMIN da MESMA organização grava (papel conferido no instante da gravação);
--  - append-only: corrigir é registrar de novo; o histórico nunca é alterado nem apagado;
--  - ordem do histórico: as gravações de uma organização são serializadas (trava transacional), a `sequencia` dá a ordem
--    e o instante nunca volta (nada é gravado "no passado" para reordenar o histórico);
--  - CNPJ e CPF só com dígitos e com os dígitos verificadores válidos;
--  - nenhum texto vazio nem com caractere de controle ou separador de linha (os lugares nos modelos são de uma linha);
--  - poderes comprovados apontam o CADASTRADO exato que comprovam, e só o atual do signatário (revisão O1.9: uma
--    correção que troca nome/CPF não herda os poderes da pessoa anterior).
--
-- Revisão O1.9 (no próprio arquivo: esta migração não foi aplicada em ambiente real).
--
-- Reversão (em transação):
--   DROP TABLE organizacao_signatarios_legais; DROP TABLE organizacao_cadastro_institucional;
--   DROP FUNCTION organizacao_signatario_regras(); DROP FUNCTION organizacao_cadastro_gravacao();
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

-- NULL (dado não cadastrado) passa; texto cadastrado precisa ter conteúdo e nenhum caractere de controle nem separador
-- de linha ou de parágrafo (U+2028, U+2029).
CREATE OR REPLACE FUNCTION texto_de_uma_linha(t TEXT) RETURNS BOOLEAN AS $$
  SELECT t IS NULL OR (btrim(t) <> '' AND t !~ '[[:cntrl:]\u2028\u2029]');
$$ LANGUAGE sql IMMUTABLE;

-- Toda gravação no cadastro da organização (as duas tabelas): serializada por organização, só por um ADMIN da MESMA
-- organização (com o papel que tem AGORA) e nunca com instante anterior ao último já gravado.
CREATE OR REPLACE FUNCTION organizacao_cadastro_gravacao() RETURNS TRIGGER AS $$
DECLARE
  papel_atual organization_role;
  fora_de_ordem BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cadastro_institucional:' || NEW.organization_id::text, 0));
  SELECT papel INTO papel_atual FROM organization_memberships
   WHERE id = NEW.registrado_por_membership_id AND organization_id = NEW.organization_id FOR SHARE;
  IF papel_atual IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'CADASTRO_INSTITUCIONAL_EXIGE_ADMIN: membership % não é ADMIN desta organização', NEW.registrado_por_membership_id;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE organization_id = $1 AND registrado_em > $2)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
    INTO fora_de_ordem USING NEW.organization_id, NEW.registrado_em;
  IF fora_de_ordem THEN
    RAISE EXCEPTION 'CADASTRO_INSTITUCIONAL_FORA_DE_ORDEM: instante % anterior ao último registro desta organização', NEW.registrado_em;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 1) Dados fixos da organização. Cada linha é o cadastro COMPLETO naquele instante; vale a mais recente.
CREATE TABLE organizacao_cadastro_institucional (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordem de gravação (as gravações da organização são serializadas; o UUID não tem ordem).
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  cnpj TEXT NOT NULL CHECK (cnpj_digitos_validos(cnpj)),
  razao_social TEXT CHECK (texto_de_uma_linha(razao_social)),
  endereco TEXT CHECK (texto_de_uma_linha(endereco)),
  telefone TEXT CHECK (texto_de_uma_linha(telefone)),
  contato_sobreestadia_nome TEXT CHECK (texto_de_uma_linha(contato_sobreestadia_nome)),
  contato_sobreestadia_email TEXT CHECK (texto_de_uma_linha(contato_sobreestadia_email)),
  emails_para_recibo TEXT CHECK (texto_de_uma_linha(emails_para_recibo)),
  motivo TEXT CHECK (texto_de_uma_linha(motivo)),
  registrado_por_membership_id UUID NOT NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizacao_cadastro_institucional_autor_fk FOREIGN KEY (registrado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id)
);

CREATE INDEX organizacao_cadastro_institucional_atual_idx ON organizacao_cadastro_institucional (organization_id, sequencia DESC);

CREATE TRIGGER organizacao_cadastro_institucional_append_only
  BEFORE UPDATE OR DELETE ON organizacao_cadastro_institucional
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON organizacao_cadastro_institucional
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TRIGGER organizacao_cadastro_institucional_gravacao
  BEFORE INSERT ON organizacao_cadastro_institucional
  FOR EACH ROW EXECUTE FUNCTION organizacao_cadastro_gravacao();

-- 2) Signatário legal (DOC-23), por eventos: CADASTRADO (dados e evidência; um novo CADASTRADO corrige), PODERES_COMPROVADOS
--    (evidência e validade, nunca presumidos, sempre de UM CADASTRADO) e REVOGADO (definitivo). O signatário não precisa
--    ser usuário da Priora.
CREATE TABLE organizacao_signatarios_legais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  signatario_id UUID NOT NULL,
  evento TEXT NOT NULL CHECK (evento IN ('CADASTRADO', 'PODERES_COMPROVADOS', 'REVOGADO')),
  nome TEXT CHECK (texto_de_uma_linha(nome)),
  cpf TEXT CHECK (cpf IS NULL OR cpf_digitos_validos(cpf)),
  qualificacao TEXT CHECK (texto_de_uma_linha(qualificacao)),
  -- Descrição da evidência registrada pela administração (ex.: documento societário ou procuração e onde está arquivado).
  evidencia TEXT CHECK (texto_de_uma_linha(evidencia)),
  poderes_valido_ate DATE,
  -- PODERES_COMPROVADOS: o CADASTRADO exato (nome, CPF, qualificação) que a evidência comprova.
  refere_cadastro_id UUID,
  motivo TEXT CHECK (texto_de_uma_linha(motivo)),
  registrado_por_membership_id UUID NOT NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organizacao_signatarios_legais_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT organizacao_signatarios_legais_autor_fk FOREIGN KEY (registrado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT organizacao_signatarios_legais_cadastro_fk FOREIGN KEY (refere_cadastro_id, organization_id)
    REFERENCES organizacao_signatarios_legais (id, organization_id),
  CONSTRAINT organizacao_signatario_evento_completo CHECK (
    (evento = 'CADASTRADO' AND nome IS NOT NULL AND cpf IS NOT NULL AND qualificacao IS NOT NULL AND evidencia IS NOT NULL AND poderes_valido_ate IS NULL
      AND refere_cadastro_id IS NULL)
    OR (evento = 'PODERES_COMPROVADOS' AND evidencia IS NOT NULL AND refere_cadastro_id IS NOT NULL AND nome IS NULL AND cpf IS NULL AND qualificacao IS NULL)
    OR (evento = 'REVOGADO' AND motivo IS NOT NULL AND nome IS NULL AND cpf IS NULL AND qualificacao IS NULL AND evidencia IS NULL AND poderes_valido_ate IS NULL
      AND refere_cadastro_id IS NULL)
  )
);

CREATE INDEX organizacao_signatarios_legais_org_idx ON organizacao_signatarios_legais (organization_id, signatario_id, sequencia);

CREATE TRIGGER organizacao_signatarios_legais_append_only
  BEFORE UPDATE OR DELETE ON organizacao_signatarios_legais
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON organizacao_signatarios_legais
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Os gatilhos BEFORE INSERT disparam em ordem alfabética: `..._gravacao` (trava, ADMIN, ordem) antes de `..._regras`.
CREATE TRIGGER organizacao_signatarios_legais_gravacao
  BEFORE INSERT ON organizacao_signatarios_legais
  FOR EACH ROW EXECUTE FUNCTION organizacao_cadastro_gravacao();

-- Poderes e revogação só para um signatário cadastrado NESTA organização; revogado não recebe mais nada; poderes só
-- do CADASTRADO atual daquele signatário (lido sob a trava da organização).
CREATE OR REPLACE FUNCTION organizacao_signatario_regras() RETURNS TRIGGER AS $$
DECLARE
  atual UUID;
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
  IF NEW.evento = 'PODERES_COMPROVADOS' THEN
    SELECT id INTO atual FROM organizacao_signatarios_legais
     WHERE organization_id = NEW.organization_id AND signatario_id = NEW.signatario_id AND evento = 'CADASTRADO'
     ORDER BY sequencia DESC LIMIT 1;
    IF atual IS DISTINCT FROM NEW.refere_cadastro_id THEN
      RAISE EXCEPTION 'PODERES_DE_OUTRO_CADASTRO: os poderes precisam comprovar o cadastro atual do signatário %', NEW.signatario_id;
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER organizacao_signatarios_legais_regras
  BEFORE INSERT ON organizacao_signatarios_legais
  FOR EACH ROW EXECUTE FUNCTION organizacao_signatario_regras();
