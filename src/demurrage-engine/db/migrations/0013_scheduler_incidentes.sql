-- Demurrage Engine V2 — migration ADITIVA (revisão 11 do plano, Fase 6).
-- 0001-0012 não são reescritas.
--
-- Correção (revisão 11): a API marítima de Tracking da Priora consulta SOMENTE
-- MBL e CONTAINER — HBL nunca dispara tracking. Um vínculo de tracking
-- executável representa apenas MBL ou CONTAINER. HBL continua existindo no
-- domínio Processo/Auditoria, mas não é target executável.
--
-- Scheduler e alerta multiempresa (Cap. 16/18): incidente técnico ÚNICO por
-- TrackingTarget (global); a 3ª falha consecutiva abre o incidente; sucesso
-- fecha e reseta a sequência. As ENTREGAS operacionais são segregadas por
-- organização (uma por incidente + organization_id); nunca misturam organizações.

-- 1) reference_type executável: só MBL/CONTAINER (exclui HBL).
ALTER TABLE container_tracking_targets DROP CONSTRAINT container_tracking_targets_reference_type_check;
ALTER TABLE container_tracking_targets
  ADD CONSTRAINT container_tracking_targets_reference_type_check
  CHECK (reference_type IS NULL OR reference_type IN ('mbl', 'container'));

-- 2) Cooldown de atualização manual (aprox. 2h) por TrackingTarget.
ALTER TABLE tracking_targets ADD COLUMN ultima_consulta_manual_em TIMESTAMPTZ;

-- 3) Incidente técnico ÚNICO por TrackingTarget. `seq` numera incidentes
--    sucessivos do mesmo target (nova sequência de 3 falhas = novo incidente).
CREATE TABLE tracking_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_target_id UUID NOT NULL REFERENCES tracking_targets(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  aberto_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  fechado_em TIMESTAMPTZ,
  motivo TEXT,
  CONSTRAINT tracking_incidents_seq_unico UNIQUE (tracking_target_id, seq)
);

-- No máximo UM incidente aberto por target.
CREATE UNIQUE INDEX tracking_incidents_aberto_unico
  ON tracking_incidents (tracking_target_id)
  WHERE fechado_em IS NULL;

-- 4) Entregas do alerta. O alerta TÉCNICO é global (uma por incidente,
--    organization_id NULL). As entregas OPERACIONAIS são por organização
--    afetada (uma por incidente + organização) e nunca misturam organizações.
CREATE TABLE tracking_alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES tracking_incidents(id) ON DELETE CASCADE,
  escopo TEXT NOT NULL CHECK (escopo IN ('tecnico_global', 'operacional_org')),
  organization_id UUID REFERENCES organizations(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracking_alert_escopo_coerente CHECK (
    (escopo = 'tecnico_global' AND organization_id IS NULL)
    OR (escopo = 'operacional_org' AND organization_id IS NOT NULL)
  ),
  -- Uma entrega operacional por (incidente, organização).
  CONSTRAINT tracking_alert_por_org_unica UNIQUE (incident_id, organization_id)
);

-- Uma entrega técnica global por incidente (organization_id NULL não participa da UNIQUE acima).
CREATE UNIQUE INDEX tracking_alert_tecnico_unico
  ON tracking_alert_deliveries (incident_id)
  WHERE escopo = 'tecnico_global';

-- Convenção da DECISÃO 1 (0007): tracking_alert_deliveries carrega organization_id
-- (a organização destinatária da entrega operacional) — imutável. É append-only
-- na prática (entregas nunca são atualizadas), então o trigger nunca dispara.
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON tracking_alert_deliveries
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
