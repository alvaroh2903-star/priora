-- Demurrage Engine V2 — migration ADITIVA (Fase 9 v1.1 corretiva). 0001-0019 NÃO
-- são reescritas (a 0019 já foi enviada).
--
-- (item 2) Isolamento por organização na associação, garantido pelo BANCO além
-- da validação na aplicação: `container_vessel_calls` passa a carregar
-- organization_id e FKs COMPOSTAS exigem que o contêiner e o VesselCall sejam da
-- MESMA organização — associação cruzada é impossível mesmo chamando o repository
-- direto.
--
-- (item 5) `vessel_call_sync_incidents`: registro PERSISTENTE (append-only) das
-- falhas técnicas isoladas do vessel_call_sync — a ingestão principal segue, mas
-- a falha não fica só em console.

-- Alvos de FK composta (id já é PK; a UNIQUE (id, org) permite referenciar o par).
ALTER TABLE containers ADD CONSTRAINT containers_id_org_unique UNIQUE (id, organization_id);
ALTER TABLE vessel_calls ADD CONSTRAINT vessel_calls_id_org_unique UNIQUE (id, organization_id);

ALTER TABLE container_vessel_calls ADD COLUMN organization_id UUID;
UPDATE container_vessel_calls cvc SET organization_id = c.organization_id
  FROM containers c WHERE c.id = cvc.container_id;
ALTER TABLE container_vessel_calls ALTER COLUMN organization_id SET NOT NULL;

-- Contêiner e VesselCall precisam ser da MESMA organização (isolamento no banco).
ALTER TABLE container_vessel_calls
  ADD CONSTRAINT cvc_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT cvc_vessel_call_org_fk FOREIGN KEY (vessel_call_id, organization_id)
    REFERENCES vessel_calls (id, organization_id) ON DELETE CASCADE;

CREATE INDEX container_vessel_calls_org_idx ON container_vessel_calls (organization_id);

-- Convenção da DECISÃO 1 (0007): tabela de tenant com organization_id é imutável
-- quanto à organização.
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON container_vessel_calls
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- Incidentes técnicos do vessel_call_sync (persistente, append-only). O sync
-- roda ISOLADO (uma falha não interrompe a ingestão), mas a falha é registrada
-- aqui — nunca só em console. organization_id é nullable: a consulta de um target
-- pode servir várias organizações; preenchido quando há uma única envolvida.
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_call_sync_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),
  tracking_target_id UUID REFERENCES tracking_targets(id) ON DELETE CASCADE,
  tracking_fetch_id UUID REFERENCES tracking_fetches(id),
  etapa TEXT NOT NULL DEFAULT 'vessel_call_sync',
  mensagem TEXT NOT NULL,           -- sanitizada (sem stack/dados sensíveis)
  ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vessel_call_sync_incidents_target_idx ON vessel_call_sync_incidents (tracking_target_id, ocorrido_em);
CREATE INDEX vessel_call_sync_incidents_org_idx ON vessel_call_sync_incidents (organization_id);

CREATE TRIGGER vessel_call_sync_incidents_append_only
  BEFORE UPDATE OR DELETE ON vessel_call_sync_incidents
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON vessel_call_sync_incidents
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
