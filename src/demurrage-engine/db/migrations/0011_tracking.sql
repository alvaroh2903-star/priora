-- Demurrage Engine V2 — migration ADITIVA (revisão 9 do plano, Fase 5).
-- 0001-0010 não são reescritas.
--
-- Ingestão do tracking de armador via API central da Priora (Scrapfly/Playwright
-- atrás dela). Entidades desenhadas na "Schema — Fase 1" (seção Tracking):
--   - tracking_targets: GLOBAL (sem organization_id) — uma referência rastreável.
--   - container_tracking_targets: vínculo N:N contêiner ↔ target.
--   - tracking_fetches: auditoria de cada CONSUMO lógico da API central (não é
--     1:1 com uma chamada Scrapfly — pode vir do cache central).
--   - tracking_events: eventos normalizados, deduplicados no PRÓPRIO Postgres.
--
-- Identidade do target (revisão 9): a API central aceita uma ref genérica e não
-- distingue MBL/HBL; a identidade operacional do target é a `reference_value`
-- normalizada (bate 1:1 com a chave de cache central). `reference_type` fica como
-- METADADO (de onde a Demurrage tirou a ref: mbl/hbl/container), não como parte
-- da identidade — não se inventa na resposta uma distinção que a API não retorna.

CREATE TABLE tracking_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Referência normalizada (maiúscula, sem espaços/hífens) — bate com refKey da API central.
  reference_value TEXT NOT NULL,
  -- Crença da Demurrage sobre a origem da referência (metadado, não identidade).
  reference_type TEXT NOT NULL CHECK (reference_type IN ('mbl', 'hbl', 'container', 'booking', 'desconhecido')),
  -- Armador detectado pela API central (nullable: a API detecta na consulta).
  armador TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Um target por referência: um mesmo BL alimenta vários contêineres/módulos
  -- e corresponde a uma única entrada de cache na API central.
  CONSTRAINT tracking_targets_ref_unica UNIQUE (reference_value)
);

CREATE TABLE container_tracking_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  tracking_target_id UUID NOT NULL REFERENCES tracking_targets(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- organization_id herdado via container_id (o target é global; o isolamento é
  -- pelo acesso via Processo/Contêiner). N:N: um target ↔ vários contêineres.
  CONSTRAINT container_tracking_targets_unica UNIQUE (container_id, tracking_target_id)
);

CREATE INDEX container_tracking_targets_target_idx ON container_tracking_targets (tracking_target_id);

-- Cada consumo lógico da API central. NÃO significa "gastou Scrapfly": pode ter
-- vindo do cache central (cached=true). Append-only (auditoria de consumo).
CREATE TABLE tracking_fetches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_target_id UUID NOT NULL REFERENCES tracking_targets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ok', 'parcial', 'falha')),
  -- Registrados quando a API informa; não se inventa contagem de créditos Scrapfly.
  cached BOOLEAN NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT false,
  carrier TEXT,
  events_count INTEGER NOT NULL DEFAULT 0 CHECK (events_count >= 0),
  iniciado_em TIMESTAMPTZ NOT NULL,
  finalizado_em TIMESTAMPTZ NOT NULL,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tracking_fetches_target_idx ON tracking_fetches (tracking_target_id, criado_em);

CREATE TRIGGER tracking_fetches_append_only
  BEFORE UPDATE OR DELETE ON tracking_fetches
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Eventos normalizados. A API real NÃO fornece id estável de evento nem persiste
-- payload bruto: external_event_id e raw_ref nascem NULL. A identidade é o
-- dedupe_hash (fallback aprovado): armador + target + contêiner + tipo do evento
-- + data + descrição/local normalizados. UNIQUE garante idempotência no BANCO —
-- reconsultar o mesmo evento histórico amanhã não cria outra linha.
CREATE TABLE tracking_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_target_id UUID NOT NULL REFERENCES tracking_targets(id) ON DELETE CASCADE,
  tracking_fetch_id UUID REFERENCES tracking_fetches(id),
  container_numero TEXT,
  tipo_evento TEXT NOT NULL CHECK (tipo_evento IN ('berth', 'discharge', 'available', 'gate_out', 'empty_return', 'other')),
  data_evento DATE,
  status_desc TEXT,
  location TEXT,
  external_event_id TEXT,
  raw_ref TEXT,
  dedupe_hash TEXT NOT NULL,
  coletado_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracking_events_dedupe_unico UNIQUE (dedupe_hash)
);

CREATE INDEX tracking_events_target_idx ON tracking_events (tracking_target_id, data_evento);

CREATE TRIGGER tracking_events_append_only
  BEFORE UPDATE OR DELETE ON tracking_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Vínculo do Snapshot com o evento de origem (reservado na 0004): agora que
-- tracking_events existe, fecha a FK que a Fase 1 deixou pendente.
ALTER TABLE snapshots
  ADD CONSTRAINT snapshots_evento_origem_fk
  FOREIGN KEY (evento_origem_id) REFERENCES tracking_events(id);
