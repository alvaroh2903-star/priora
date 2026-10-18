-- Liberação — Entrega 1: reutilização dos fatos documentais do MBL. Dono: Auditoria.
--
-- Migration ADITIVA sobre `auditoria_extracoes` (0102). Nenhuma linha existente
-- é alterada: as colunas novas são anuláveis e sem default, então as extrações
-- anteriores ficam NULL ("não preservado na época") e nunca são reconstruídas.
-- A tabela continua append-only (os gatilhos da 0102 não mudam).
--
--  - `campos_documentais`: o que a extração EXISTENTE já devolve e o motor
--    documental usa (navio e viagem, consignatário, números de contêiner),
--    exatamente como o OCR devolveu. É dado EXTRAÍDO, não fato confiável: a
--    confiabilidade é decidida na leitura, pelas regras aprovadas.
--  - `arquivo_sha256`: hash dos bytes do anexo que o extrator já obteve para o
--    OCR (sem novo download). Identifica conteúdo idêntico ou diferente; nunca
--    decide sozinho qual MBL é válido. Mesmo nome com conteúdo diferente = outra
--    versão; a identidade do anexo continua sendo mensagem + anexo do Outlook.

ALTER TABLE auditoria_extracoes
  ADD COLUMN campos_documentais JSONB
    CHECK (campos_documentais IS NULL OR jsonb_typeof(campos_documentais) = 'object'),
  ADD COLUMN arquivo_sha256 TEXT
    CHECK (arquivo_sha256 IS NULL OR arquivo_sha256 ~ '^[0-9a-f]{64}$');

-- Reuso por conteúdo idêntico dentro da organização (sem novo OCR).
CREATE INDEX auditoria_extracoes_arquivo_idx
  ON auditoria_extracoes (organization_id, arquivo_sha256) WHERE arquivo_sha256 IS NOT NULL;
