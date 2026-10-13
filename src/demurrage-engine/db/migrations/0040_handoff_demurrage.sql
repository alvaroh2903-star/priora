-- Produção P1 — Entrega 1 (handoff automático e idempotente da Demurrage)
-- migration ADITIVA; 0001-0039 não são reescritas.
--
-- Três tabelas novas:
--
--   1) demurrage_handoff_credenciais — registro das credenciais de integração
--      (M2M) autorizadas a chamar o handoff por HTTP. O segredo NUNCA é
--      gravado em texto claro: é cifrado (AES-256-GCM, mesmo padrão de
--      `msal_cache_criptografado`/`cacheCrypto.ts`, chave por variável de
--      ambiente com versão para rotação). O caminho in-process confiável
--      (chamado direto no monólito) não usa esta tabela — recebe o contexto
--      de organização já resolvido, sem passar pela autenticação HTTP.
--
--   2) demurrage_handoff_nonces — proteção contra replay: cada (credencial,
--      nonce) só pode ser usado uma vez. Sem expurgo automático nesta
--      entrega (nunca é incorreto manter um nonce antigo — só cresce em
--      disco; expurgo é tarefa operacional futura, documentada no relatório).
--
--   3) demurrage_handoff_eventos — ledger de identidade/idempotência do
--      handoff, por (organization_id, origem_sistema, origem_evento_id).
--      Camada de identidade EXTERNA (evento a montante), distinta e acima do
--      ledger `demurrage_registros` (D10, identidade do PAYLOAD): o mesmo
--      `origem_evento_id` com hash de payload diferente é um conflito aqui,
--      ANTES de qualquer tentativa de registro; eventos diferentes para o
--      mesmo `origem_processo_id` são evolução legítima do processo.

CREATE TABLE demurrage_handoff_credenciais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA', 'DESABILITADA')),
  -- Segredo cifrado (AES-256-GCM) — nunca texto claro. `chave_versao` permite
  -- rotacionar a CHAVE DE CIFRA do servidor sem invalidar credenciais já
  -- emitidas (mesmo padrão de `msal_cache_criptografado`). Rotacionar o
  -- PRÓPRIO SEGREDO da credencial (ação do integrador) é diferente: gera um
  -- novo segredo cifrado, substitui as 4 colunas abaixo atomicamente — o
  -- segredo anterior para de validar imediatamente (sem janela de
  -- sobreposição nesta entrega; ver limitação no relatório).
  chave_versao INTEGER NOT NULL,
  iv BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  segredo_cifrado BYTEA NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  desabilitada_em TIMESTAMPTZ,
  rotacionada_em TIMESTAMPTZ,
  CONSTRAINT demurrage_handoff_credenciais_desabilitada_coerente
    CHECK ((status = 'DESABILITADA') = (desabilitada_em IS NOT NULL))
);
CREATE INDEX demurrage_handoff_credenciais_org_idx ON demurrage_handoff_credenciais (organization_id);

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_handoff_credenciais
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TABLE demurrage_handoff_nonces (
  credencial_id UUID NOT NULL REFERENCES demurrage_handoff_credenciais(id),
  nonce TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (credencial_id, nonce)
);

CREATE TABLE demurrage_handoff_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  -- Identidade de quem autenticou a chamada: o UUID (como texto) da credencial
  -- HTTP autenticada, OU um marcador textual do chamador in-process confiável
  -- (nunca um UUID de credencial real — ver `handoff/credenciais.ts`).
  -- Deliberadamente NÃO é FK para `demurrage_handoff_credenciais`: o caminho
  -- in-process não tem (nem precisa ter) uma credencial provisionada.
  credencial_identidade TEXT NOT NULL,
  origem_sistema TEXT NOT NULL,
  -- Identificador ESTÁVEL do processo a montante (nunca extraído de MBL/HBL/
  -- número de contêiner/cliente — ver handoffService.ts).
  origem_processo_id TEXT NOT NULL,
  -- Identificador IMUTÁVEL do evento/versão a montante — a chave de
  -- idempotência desta camada.
  origem_evento_id TEXT NOT NULL,
  -- Versão/ocorrência do evento a montante, quando informada (texto livre do
  -- lado de quem chama — nunca interpretada como data operacional da
  -- Demurrage).
  origem_ocorrido_em TIMESTAMPTZ,
  payload_hash TEXT NOT NULL,
  processo_id UUID,
  resultado TEXT CHECK (resultado IN (
    'APLICADO', 'REPLAY_IDEMPOTENTE', 'ACEITO_COM_PENDENCIA', 'EXIGE_REABERTURA',
    'CONFLITO_EVENTO', 'CONTRATO_INVALIDO', 'FALHA'
  )),
  falha_sanitizada TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT demurrage_handoff_eventos_identidade_unica
    UNIQUE (organization_id, origem_sistema, origem_evento_id),
  CONSTRAINT demurrage_handoff_eventos_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id)
);
CREATE INDEX demurrage_handoff_eventos_processo_origem_idx
  ON demurrage_handoff_eventos (organization_id, origem_sistema, origem_processo_id);

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_handoff_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Append-only na identidade do evento: depois de concluído, só os campos de
-- resultado podem mudar (nunca a identidade que o tornaria outro evento).
CREATE OR REPLACE FUNCTION forbid_handoff_evento_identidade_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.origem_sistema IS DISTINCT FROM OLD.origem_sistema
     OR NEW.origem_processo_id IS DISTINCT FROM OLD.origem_processo_id
     OR NEW.origem_evento_id IS DISTINCT FROM OLD.origem_evento_id
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN
    RAISE EXCEPTION 'demurrage_handoff_eventos %: identidade do evento e imutavel apos criada', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER demurrage_handoff_eventos_identidade_imutavel
  BEFORE UPDATE ON demurrage_handoff_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_handoff_evento_identidade_change();
