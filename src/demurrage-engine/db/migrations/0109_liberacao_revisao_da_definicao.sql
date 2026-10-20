-- Liberação — revisão da LEITURA (definição) de um modelo oficial já validado, com o MESMO arquivo (decisão 14.20).
--
-- A leitura validada de uma versão é imutável (0104) e o mesmo arquivo nunca é cadastrado duas vezes. A 14.20 mudou a
-- fonte aceita dos campos do consignatário nas definições oficiais (revisão 2): para uma organização que já validou a
-- revisão 1, a única forma de adotar a nova leitura sem alterar a anterior é uma VERSÃO NOVA do mesmo arquivo, pendente
-- até uma pessoa validar. Esta migração cria só esse caminho:
--  - `revisao_da_definicao`: 1 na leitura original de cada arquivo (todas as linhas existentes); cada revisão soma 1;
--  - origem `REVISAO_DA_DEFINICAO`: o mesmo arquivo (mesmos bytes e hash) de uma versão VALIDADA da mesma organização e
--    do mesmo tipo (`substitui_modelo_id`), registrada por uma pessoa, com a decisão na evidência e leitura nova;
--  - o arquivo continua único por (organização, tipo, hash) EM CADA revisão: cadastro e substituto seguem idênticos
--    (sempre revisão 1), e duas revisões com o mesmo número do mesmo arquivo não existem;
--  - o número da revisão nunca muda depois de gravado.
-- Nada existente é alterado: as versões, leituras, validações e documentos anteriores ficam como estão.
--
-- Reversão (em transação, só sem linhas REVISAO_DA_DEFINICAO):
--   DROP TRIGGER documentos_apresentacao_modelos_revisao ON documentos_apresentacao_modelos; DROP FUNCTION check_revisao_da_definicao();
--   ALTER TABLE documentos_apresentacao_modelos DROP CONSTRAINT documentos_apresentacao_modelos_arquivo_unico,
--     ADD CONSTRAINT documentos_apresentacao_modelos_arquivo_unico UNIQUE (organization_id, tipo, arquivo_sha256);
--   (e as restrições de origem como na 0104); ALTER TABLE documentos_apresentacao_modelos DROP COLUMN revisao_da_definicao;
--   DELETE FROM schema_migrations WHERE filename = '0109_liberacao_revisao_da_definicao.sql';

ALTER TABLE documentos_apresentacao_modelos
  ADD COLUMN revisao_da_definicao SMALLINT NOT NULL DEFAULT 1 CHECK (revisao_da_definicao >= 1);

ALTER TABLE documentos_apresentacao_modelos
  DROP CONSTRAINT documentos_apresentacao_modelos_origem_check,
  ADD CONSTRAINT documentos_apresentacao_modelos_origem_check CHECK (origem IN ('CADASTRO', 'SUBSTITUTO_DA_AGENCIA', 'REVISAO_DA_DEFINICAO'));

ALTER TABLE documentos_apresentacao_modelos
  DROP CONSTRAINT documentos_apresentacao_modelos_origem,
  ADD CONSTRAINT documentos_apresentacao_modelos_origem CHECK (
    (origem = 'CADASTRO' AND cadastrado_por_membership_id IS NOT NULL AND substitui_modelo_id IS NULL AND revisao_da_definicao = 1)
    OR (origem = 'SUBSTITUTO_DA_AGENCIA' AND substitui_modelo_id IS NOT NULL AND evidencia IS NOT NULL AND revisao_da_definicao = 1)
    OR (origem = 'REVISAO_DA_DEFINICAO' AND substitui_modelo_id IS NOT NULL AND cadastrado_por_membership_id IS NOT NULL AND evidencia IS NOT NULL
      AND definicao IS NOT NULL AND revisao_da_definicao > 1));

ALTER TABLE documentos_apresentacao_modelos
  DROP CONSTRAINT documentos_apresentacao_modelos_arquivo_unico,
  ADD CONSTRAINT documentos_apresentacao_modelos_arquivo_unico UNIQUE (organization_id, tipo, arquivo_sha256, revisao_da_definicao);

-- A revisão é do MESMO arquivo de uma versão VALIDADA (mesma organização e tipo), com o número seguinte e leitura nova;
-- o número nunca muda depois.
CREATE OR REPLACE FUNCTION check_revisao_da_definicao() RETURNS TRIGGER AS $$
DECLARE
  base documentos_apresentacao_modelos%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.revisao_da_definicao IS DISTINCT FROM OLD.revisao_da_definicao THEN
      RAISE EXCEPTION 'documentos_apresentacao_modelos: o número da revisão da definição é imutável';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.origem <> 'REVISAO_DA_DEFINICAO' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO base FROM documentos_apresentacao_modelos
   WHERE id = NEW.substitui_modelo_id AND organization_id = NEW.organization_id FOR SHARE;
  IF NOT FOUND OR base.tipo <> NEW.tipo OR base.arquivo_sha256 <> NEW.arquivo_sha256 OR base.arquivo <> NEW.arquivo THEN
    RAISE EXCEPTION 'REVISAO_DE_OUTRO_ARQUIVO: a revisão da definição é do mesmo arquivo de uma versão desta organização';
  END IF;
  IF base.estado <> 'VALIDADO' THEN
    RAISE EXCEPTION 'REVISAO_SO_DE_VERSAO_VALIDADA: versão % está %', base.id, base.estado;
  END IF;
  IF NEW.revisao_da_definicao <> base.revisao_da_definicao + 1 THEN
    RAISE EXCEPTION 'REVISAO_FORA_DE_ORDEM: revisão % de uma leitura de revisão %', NEW.revisao_da_definicao, base.revisao_da_definicao;
  END IF;
  IF NEW.definicao IS NOT DISTINCT FROM base.definicao THEN
    RAISE EXCEPTION 'REVISAO_SEM_LEITURA_NOVA: a revisão precisa de outra leitura';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_apresentacao_modelos_revisao
  BEFORE INSERT OR UPDATE ON documentos_apresentacao_modelos
  FOR EACH ROW EXECUTE FUNCTION check_revisao_da_definicao();
