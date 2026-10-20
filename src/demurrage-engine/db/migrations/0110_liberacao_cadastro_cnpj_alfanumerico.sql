-- Liberação — cadastro institucional: CNPJ alfanumérico (O1.9.1, decisão 14.21).
--
-- A IN RFB 2.229/2024 criou o CNPJ alfanumérico (emitido desde julho de 2026): as 12 primeiras posições podem ter letras
-- maiúsculas; os 2 dígitos verificadores continuam numéricos, calculados com o valor do caractere = código ASCII − 48.
-- A conferência no MBL já o reconhecia; o cadastro aceitava só o numérico. Esta migração alinha o banco:
--  - `cnpj_valido(TEXT)`: numérico (a regra da 0108, inalterada) OU alfanumérico com os verificadores válidos;
--  - a restrição do CNPJ do cadastro passa a usá-la. Todo CNPJ numérico já gravado continua válido (é o mesmo teste).
-- Nenhuma validação é relaxada: máscara, minúscula, verificador errado ou dígitos repetidos continuam recusados.
--
-- Guarda (O1.9.1): a 0108 foi revista no próprio arquivo antes de sair deste ambiente. Se um banco tiver a 0108
-- ORIGINAL (sem `sequencia` e sem `refere_cadastro_id`), esta migração PARA com a explicação — nada é presumido e nada é
-- corrigido em silêncio; a convergência desse banco segue o plano validado (relatório O1.9.1).
--
-- Reversão (em transação, só sem CNPJ alfanumérico gravado):
--   ALTER TABLE organizacao_cadastro_institucional DROP CONSTRAINT organizacao_cadastro_institucional_cnpj_check,
--     ADD CONSTRAINT organizacao_cadastro_institucional_cnpj_check CHECK (cnpj_digitos_validos(cnpj));
--   DROP FUNCTION cnpj_valido(TEXT);
--   DELETE FROM schema_migrations WHERE filename = '0110_liberacao_cadastro_cnpj_alfanumerico.sql';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'organizacao_cadastro_institucional' AND column_name = 'sequencia')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'organizacao_signatarios_legais' AND column_name = 'refere_cadastro_id') THEN
    RAISE EXCEPTION '0108_ORIGINAL_DETECTADA: este banco tem a estrutura da 0108 anterior à revisão O1.9; aplicar o plano de convergência validado antes da 0110';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION cnpj_valido(v TEXT) RETURNS BOOLEAN AS $$
DECLARE
  pesos1 INT[] := ARRAY[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  pesos2 INT[] := ARRAY[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  s INT;
  r INT;
  d1 INT;
  d2 INT;
BEGIN
  IF v IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v ~ '^[0-9]{14}$' THEN
    RETURN cnpj_digitos_validos(v);
  END IF;
  IF v !~ '^[0-9A-Z]{12}[0-9]{2}$' OR v !~ '[A-Z]' THEN
    RETURN FALSE;
  END IF;
  s := 0;
  FOR i IN 1..12 LOOP s := s + (ascii(substr(v, i, 1)) - 48) * pesos1[i]; END LOOP;
  r := s % 11;
  d1 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  s := d1 * pesos2[13];
  FOR i IN 1..12 LOOP s := s + (ascii(substr(v, i, 1)) - 48) * pesos2[i]; END LOOP;
  r := s % 11;
  d2 := CASE WHEN r < 2 THEN 0 ELSE 11 - r END;
  RETURN substr(v, 13, 1)::INT = d1 AND substr(v, 14, 1)::INT = d2;
END
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE organizacao_cadastro_institucional
  DROP CONSTRAINT organizacao_cadastro_institucional_cnpj_check,
  ADD CONSTRAINT organizacao_cadastro_institucional_cnpj_check CHECK (cnpj_valido(cnpj));
