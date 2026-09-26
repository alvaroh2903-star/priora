-- Demurrage Engine V2 — migration ADITIVA (Fase 9, 1ª entrega: fundação do
-- VesselCall e tracking compartilhado). 0001-0018 não são reescritas.
--
-- Escala de navio (VesselCall) COMPARTILHADA por processos/contêineres da MESMA
-- organização que pertencem à mesma viagem. Esta entrega é FUNDAÇÃO: modelo
-- versionado, identidade/normalização conservadora, associação POR CONTÊINER
-- (permite rolagem parcial), isolamento por organização, histórico append-only,
-- rolagem auditável e pendências idempotentes. NÃO altera cadência/claim/tarifas/
-- relógios; NÃO promete economia de créditos entre MBLs (dedup por target já
-- existente permanece; economia por viagem depende de extensão futura do contrato).
--
-- Dados COMPARTILHADOS (moram aqui, lidos por associação — nunca copiados para o
-- processo): ETA, chegada, atracação, com fonte/observação/evidência + histórico.
-- Dados INDIVIDUAIS (descarga, Gate Out, devolução, Free Time, apuração, tarifas,
-- valores, responsabilidade, minuta, fechamento) permanecem no contêiner/processo.

-- ---------------------------------------------------------------------------
-- vessel_calls: a escala. Identidade = org + armador + navio + viagem + POD.
-- ETA NÃO compõe a identidade (muda na viagem). Guarda valor NORMALIZADO e o
-- ORIGINAL de cada componente. POD só entra quando CONFIRMADO (hierarquia
-- documental resolvida na aplicação); sem POD confirmado não há VesselCall.
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  armador TEXT NOT NULL,               -- normalizado (conservador)
  armador_original TEXT NOT NULL,
  vessel_normalizado TEXT NOT NULL,
  vessel_original TEXT NOT NULL,
  voyage TEXT NOT NULL,                -- normalizado
  voyage_original TEXT NOT NULL,
  pod TEXT NOT NULL,                   -- normalizado (POD CONFIRMADO)
  pod_original TEXT NOT NULL,
  pod_fonte TEXT NOT NULL,             -- master_bl | house_document | ... (nunca 'evento')
  pod_evidencia TEXT,
  -- Eventos compartilhados ATUAIS. Só populados com FONTE VÁLIDA; nunca fabricados.
  eta_atual DATE, eta_fonte TEXT, eta_observada_em TIMESTAMPTZ, eta_evidencia TEXT,
  chegada DATE, chegada_fonte TEXT, chegada_observada_em TIMESTAMPTZ, chegada_evidencia TEXT,
  atracacao DATE, atracacao_fonte TEXT, atracacao_observada_em TIMESTAMPTZ, atracacao_evidencia TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vessel_calls_identidade_unica UNIQUE (organization_id, armador, vessel_normalizado, voyage, pod)
);

CREATE INDEX vessel_calls_org_idx ON vessel_calls (organization_id);

-- Convenção da DECISÃO 1 (0007): toda tabela de tenant com organization_id é
-- imutável quanto à organização. Reusa a função genérica forbid_organization_change.
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON vessel_calls
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- vessel_call_eventos: histórico APPEND-ONLY dos eventos compartilhados. Nunca
-- sobrescreve em silêncio — cada mudança relevante grava anterior/novo/fonte/
-- observação/evidência/originador/motivo. Reingestão idêntica NÃO gera linha
-- (a aplicação só registra quando há mudança relevante ou nova evidência).
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_call_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_call_id UUID NOT NULL REFERENCES vessel_calls(id) ON DELETE CASCADE,
  campo TEXT NOT NULL CHECK (campo IN ('eta', 'chegada', 'atracacao')),
  valor_anterior DATE,
  valor_novo DATE,
  fonte TEXT NOT NULL,
  observado_em TIMESTAMPTZ NOT NULL,
  evidencia TEXT,
  tracking_fetch_id UUID REFERENCES tracking_fetches(id),
  processo_originador_id UUID REFERENCES processos(id),
  container_originador_id UUID REFERENCES containers(id),
  motivo TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vessel_call_eventos_vc_idx ON vessel_call_eventos (vessel_call_id, criado_em);

CREATE TRIGGER vessel_call_eventos_append_only
  BEFORE UPDATE OR DELETE ON vessel_call_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- container_vessel_calls: associação PRIMÁRIA por contêiner. No máximo UMA ativa
-- por contêiner (rolagem: desativa a anterior antes de ativar a nova). Vários
-- contêineres do mesmo processo podem estar em VesselCalls diferentes.
-- ---------------------------------------------------------------------------
CREATE TABLE container_vessel_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  vessel_call_id UUID NOT NULL REFERENCES vessel_calls(id) ON DELETE CASCADE,
  ativo BOOLEAN NOT NULL DEFAULT true,
  associado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo_chave TEXT NOT NULL,          -- a chave/identidade que casou
  origem_dados TEXT NOT NULL,          -- ex.: 'tracking_service'
  desvinculado_em TIMESTAMPTZ,
  desvinculo_motivo TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No máximo UMA associação ativa por contêiner.
CREATE UNIQUE INDEX container_vessel_calls_ativo_unico ON container_vessel_calls (container_id) WHERE ativo;
CREATE INDEX container_vessel_calls_vc_idx ON container_vessel_calls (vessel_call_id);

-- Histórico auditável das transições de associação (associar / desvincular /
-- rolagem). Append-only: nunca apaga o passado da associação.
CREATE TABLE container_vessel_call_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  vessel_call_id UUID REFERENCES vessel_calls(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('associado', 'desvinculado', 'rolagem')),
  chave TEXT,
  origem_dados TEXT,
  motivo TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX container_vessel_call_eventos_idx ON container_vessel_call_eventos (container_id, criado_em);

CREATE TRIGGER container_vessel_call_eventos_append_only
  BEFORE UPDATE OR DELETE ON container_vessel_call_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- vessel_call_pendencias: ambiguidades que impedem associação automática (POD
-- não confirmado, POD divergente entre fontes, identidade ambígua de navio/
-- viagem/armador). IDEMPOTENTE: uma pendência ABERTA por identidade estável
-- (contexto_hash = org + contêiner/target + tipo + contexto). Estados
-- aberta/resolvida com histórico (linhas resolvidas nunca são apagadas).
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_call_pendencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  container_id UUID REFERENCES containers(id) ON DELETE CASCADE,
  tracking_target_id UUID REFERENCES tracking_targets(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('pod_nao_confirmado', 'pod_divergente', 'identidade_ambigua', 'atracacao_ambigua')),
  contexto_hash TEXT NOT NULL,         -- identidade estável da pendência (dedupe)
  detalhe JSONB,
  estado TEXT NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta', 'resolvida')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ
);

-- Idempotência: no máximo UMA pendência ABERTA por identidade estável.
CREATE UNIQUE INDEX vessel_call_pendencias_aberta_unica ON vessel_call_pendencias (contexto_hash) WHERE estado = 'aberta';
CREATE INDEX vessel_call_pendencias_org_idx ON vessel_call_pendencias (organization_id, estado);

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON vessel_call_pendencias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
