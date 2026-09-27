-- Demurrage Engine V2 — migration ADITIVA: captura automática do pré-alerta.
-- 0001-0026 NÃO são reescritas; si_conversas e o bloco manual da Shipping
-- Instructions permanecem intocados.
--
-- 1) Persistência DURÁVEL da autenticação Microsoft (antes: arquivos em .data,
--    efêmeros no host): o cache SERIALIZADO do MSAL, criptografado
--    (AES-256-GCM, chave por variável de ambiente, versão da chave para
--    rotação), e a conta ativa. Não existe tabela de refresh tokens: o que se
--    guarda é o blob opaco do MSAL, cifrado.
-- 2) Vínculo explícito caixa postal → organização, cursor de sincronização por
--    caixa + pasta (com lease/época/expiração) e a descoberta das conversas.

-- ---------------------------------------------------------------------------
-- Cache MSAL criptografado (linha única). `revisao` = escrita otimista (CAS);
-- `geracao` muda quando a conta conectada troca ou é desconectada, e descarta
-- escritas atrasadas de tokens da conta anterior.
-- ---------------------------------------------------------------------------
CREATE TABLE msal_cache_criptografado (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  geracao INTEGER NOT NULL DEFAULT 1 CHECK (geracao >= 1),
  revisao INTEGER NOT NULL DEFAULT 1 CHECK (revisao >= 1),
  algoritmo TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algoritmo = 'aes-256-gcm'),
  chave_versao INTEGER NOT NULL CHECK (chave_versao >= 1),
  iv BYTEA NOT NULL CHECK (octet_length(iv) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  dados BYTEA NOT NULL,
  importado_de_arquivo_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Conta Microsoft ativa (linha única). Sem conta = colunas nulas.
CREATE TABLE msal_conta_ativa (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  home_account_id TEXT,
  username TEXT,
  conectada_em TIMESTAMPTZ,
  importada_de_arquivo_em TIMESTAMPTZ,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT msal_conta_ativa_forma CHECK (
    (home_account_id IS NULL AND username IS NULL AND conectada_em IS NULL)
    OR (home_account_id IS NOT NULL AND username IS NOT NULL AND conectada_em IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Caixa postal vinculada a UMA organização (V1). O vínculo só é feito por
-- ADMIN da organização; a organização NUNCA é inferida do conteúdo do e-mail.
-- ---------------------------------------------------------------------------
CREATE TABLE email_caixas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  home_account_id TEXT NOT NULL,
  username TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'ativa' CHECK (estado IN ('ativa', 'pausada', 'removida')),
  vinculada_por_membership_id UUID NOT NULL,
  vinculada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  alterada_por_membership_id UUID,
  removida_em TIMESTAMPTZ,
  token_estado TEXT NOT NULL DEFAULT 'desconhecido' CHECK (token_estado IN ('desconhecido', 'disponivel', 'indisponivel')),
  token_motivo TEXT,
  token_verificado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_caixas_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT email_caixas_removida CHECK ((estado = 'removida') = (removida_em IS NOT NULL)),
  CONSTRAINT email_caixas_vinculo_fk FOREIGN KEY (vinculada_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT email_caixas_alteracao_fk FOREIGN KEY (alterada_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id)
);
-- Uma caixa pertence a no máximo UMA organização enquanto o vínculo existir.
CREATE UNIQUE INDEX email_caixas_uma_org_por_caixa ON email_caixas (home_account_id) WHERE estado <> 'removida';
CREATE INDEX email_caixas_org_idx ON email_caixas (organization_id, estado);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON email_caixas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- Cursor de sincronização (Graph messages/delta) por caixa + pasta, com lease
-- persistente (dono, época monotônica, expiração). O cursor só avança com a
-- posse vigente (fencing) e depois de registrar as candidatas da página.
-- ---------------------------------------------------------------------------
CREATE TABLE email_sync_estado (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  caixa_id UUID NOT NULL,
  pasta TEXT NOT NULL CHECK (pasta IN ('inbox', 'sentitems')),
  cursor_tipo TEXT CHECK (cursor_tipo IN ('next', 'delta')),
  cursor_link TEXT,
  janela_inicio TIMESTAMPTZ,
  lease_owner TEXT,
  lease_epoca INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoca >= 0),
  lease_expira_em TIMESTAMPTZ,
  ultima_tentativa_em TIMESTAMPTZ,
  ultimo_sucesso_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  ultimo_erro_em TIMESTAMPTZ,
  proxima_tentativa_em TIMESTAMPTZ,
  ressincronizacoes INTEGER NOT NULL DEFAULT 0,
  mensagens_vistas BIGINT NOT NULL DEFAULT 0,
  candidatas BIGINT NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_sync_estado_unica UNIQUE (caixa_id, pasta),
  CONSTRAINT email_sync_estado_cursor CHECK ((cursor_tipo IS NULL) = (cursor_link IS NULL)),
  CONSTRAINT email_sync_estado_lease CHECK ((lease_owner IS NULL) = (lease_expira_em IS NULL)),
  CONSTRAINT email_sync_estado_caixa_org_fk FOREIGN KEY (caixa_id, organization_id) REFERENCES email_caixas (id, organization_id)
);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON email_sync_estado
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- Descoberta automática de conversas de pré-alerta (tabela PRÓPRIA; não altera
-- si_conversas). Uma por (organização, conversationId). Guarda só códigos de
-- motivo — nunca corpo, trecho ou anexo.
-- ---------------------------------------------------------------------------
CREATE TABLE si_conversas_descobertas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  caixa_id UUID NOT NULL,
  conversation_id TEXT NOT NULL,
  pasta TEXT NOT NULL CHECK (pasta IN ('inbox', 'sentitems')),
  origem TEXT NOT NULL CHECK (origem IN ('delta', 'backfill')),
  message_id_gatilho TEXT NOT NULL,
  primeira_mensagem_id TEXT,
  processo_codigo TEXT,
  estado TEXT NOT NULL CHECK (estado IN ('registrada', 'ingerida', 'pendente', 'rejeitada', 'falha')),
  motivo TEXT,
  resultado_ingestao TEXT,
  versao_id UUID REFERENCES si_versoes(id),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  proxima_tentativa_em TIMESTAMPTZ,
  ultimo_erro TEXT,
  descoberta_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT si_conversas_descobertas_unica UNIQUE (organization_id, conversation_id),
  CONSTRAINT si_conversas_descobertas_rejeicao CHECK (estado <> 'rejeitada' OR motivo IS NOT NULL),
  CONSTRAINT si_conversas_descobertas_registro CHECK (estado IN ('rejeitada') OR processo_codigo IS NOT NULL),
  CONSTRAINT si_conversas_descobertas_caixa_org_fk FOREIGN KEY (caixa_id, organization_id) REFERENCES email_caixas (id, organization_id)
);
CREATE INDEX si_conversas_descobertas_fila_idx ON si_conversas_descobertas (organization_id, estado, proxima_tentativa_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON si_conversas_descobertas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
