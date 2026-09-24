-- Demurrage Engine V2 — migration ADITIVA (revisão 10 do plano, Fase 5).
-- 0011 NÃO é reescrita.
--
-- Identidade do TrackingTarget passa a ser `armador + reference_value_canonical`
-- (revisão 10). A API central recebe uma ref genérica e não distingue MBL/HBL,
-- então reference_type SAI da identidade física e vai para o vínculo. A grafia
-- bruta original é preservada no vínculo (proveniência), não duplicada no target
-- global — várias grafias equivalentes apontam para o MESMO target real.
--
-- Idempotente no ambiente de migrations (aplicada uma vez); preserva dados
-- existentes (backfill da canônica a partir do reference_value bruto anterior).

-- 1) Nova coluna canônica; backfill conservador a partir do valor bruto atual.
ALTER TABLE tracking_targets ADD COLUMN reference_value_canonical TEXT;
UPDATE tracking_targets SET reference_value_canonical = reference_value
 WHERE reference_value_canonical IS NULL;
ALTER TABLE tracking_targets ALTER COLUMN reference_value_canonical SET NOT NULL;

-- 2) armador é parte OBRIGATÓRIA da identidade.
ALTER TABLE tracking_targets ALTER COLUMN armador SET NOT NULL;

-- 3) Troca a identidade: de UNIQUE(reference_value) para UNIQUE(armador, canônica).
ALTER TABLE tracking_targets DROP CONSTRAINT tracking_targets_ref_unica;
ALTER TABLE tracking_targets
  ADD CONSTRAINT tracking_targets_identidade_unica UNIQUE (armador, reference_value_canonical);

-- 4) reference_type sai da identidade do target; o raw não é duplicado no target.
ALTER TABLE tracking_targets DROP COLUMN reference_type;
ALTER TABLE tracking_targets DROP COLUMN reference_value;

CREATE INDEX tracking_targets_canonical_idx ON tracking_targets (reference_value_canonical);

-- 5) Contexto de origem no vínculo: como AQUELA origem conhece a referência.
--    Permite o mesmo target real ser reusado mesmo que uma origem o conheça como
--    MBL e outra como BL/HBL — sem duplicar consulta.
ALTER TABLE container_tracking_targets
  ADD COLUMN reference_type TEXT
    CHECK (reference_type IS NULL OR reference_type IN ('mbl', 'hbl', 'container', 'booking', 'desconhecido'));
ALTER TABLE container_tracking_targets ADD COLUMN reference_raw TEXT;

-- 6) Auditoria: o TrackingEvent do contrato traz vessel/voyage; preservamos para
--    não descartar informação do evento normalizado recebido da API central.
ALTER TABLE tracking_events ADD COLUMN vessel TEXT;
ALTER TABLE tracking_events ADD COLUMN voyage TEXT;
