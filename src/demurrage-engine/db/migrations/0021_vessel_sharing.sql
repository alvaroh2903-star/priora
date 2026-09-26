-- Demurrage Engine V2 — migration ADITIVA (Fase 9 Bloco 2: tracking intercalado
-- por VesselCall). 0001-0020 NÃO são reescritas.
--
-- Reuso COORDENADO das consultas normais por MBL dos processos da mesma escala.
-- NÃO há consulta por navio. O compartilhamento automático só ativa com VÍNCULO
-- DE VIAGEM CONFIRMADO por evento estruturado do armador OU confirmação humana
-- auditada — a mera presença de navio+viagem é vínculo PREVISTO e não habilita.
-- Cadência (cadencePolicy), relógios, tarifas, apuração e Fases 7/8 intactos.

-- ---------------------------------------------------------------------------
-- Participante: snapshot de confirmação individual usado para formar o grupo.
-- estado ∈ {elegivel, removido} — "coberto" NÃO é estado do participante (é da
-- cobertura). ETA prevista e vínculo de viagem vêm de FONTE VÁLIDA; humano
-- auditado quando o armador não fornece evento estruturado.
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_call_participantes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  vessel_call_id UUID NOT NULL,
  container_id UUID NOT NULL,
  tracking_target_id UUID REFERENCES tracking_targets(id) ON DELETE SET NULL,
  processo_id UUID REFERENCES processos(id) ON DELETE SET NULL,
  eta_prevista DATE,
  vinculo_viagem_confirmado BOOLEAN NOT NULL DEFAULT false,
  -- Como o vínculo foi confirmado: evento estruturado do armador OU humano auditado.
  confirmacao_tipo TEXT CHECK (confirmacao_tipo IN ('evento_estruturado', 'humano_auditado')),
  confirmacao_fonte TEXT,
  status_previsto_confirmado TEXT CHECK (status_previsto_confirmado IN ('previsto', 'confirmado')),
  evidencia TEXT,
  observado_em TIMESTAMPTZ,
  confirmado_em TIMESTAMPTZ,
  tracking_fetch_id UUID REFERENCES tracking_fetches(id),
  -- Auditoria da confirmação humana (quando aplicável).
  humano_usuario TEXT,
  humano_motivo TEXT,
  estado TEXT NOT NULL DEFAULT 'elegivel' CHECK (estado IN ('elegivel', 'removido')),
  motivo_remocao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vessel_call_participantes_unico UNIQUE (vessel_call_id, container_id),
  CONSTRAINT vcp_container_org_fk FOREIGN KEY (container_id, organization_id) REFERENCES containers (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT vcp_vessel_call_org_fk FOREIGN KEY (vessel_call_id, organization_id) REFERENCES vessel_calls (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX vessel_call_participantes_vc_idx ON vessel_call_participantes (vessel_call_id, estado);
CREATE INDEX vessel_call_participantes_org_idx ON vessel_call_participantes (organization_id);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON vessel_call_participantes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- Rodada compartilhada: coordenação transacional por VesselCall + data
-- operacional. Identidade PERMANENTE e ÚNICA (org, vessel_call, data_operacional)
-- INDEPENDENTE do estado — no máximo UMA rodada automática por VesselCall por
-- data operacional, mesmo depois de concluída. Recuperação de rodada abandonada:
-- outro worker REIVINDICA a MESMA linha expirada (não cria outra).
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_call_rodadas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  vessel_call_id UUID NOT NULL,
  data_operacional DATE NOT NULL,
  referencia_target_id UUID REFERENCES tracking_targets(id) ON DELETE SET NULL,
  referencia_container_id UUID REFERENCES containers(id) ON DELETE SET NULL,
  worker_id TEXT,
  adquirida_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  estado TEXT NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta', 'concluida', 'expirada')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vessel_call_rodadas_unica UNIQUE (organization_id, vessel_call_id, data_operacional),
  CONSTRAINT vcr_vessel_call_org_fk FOREIGN KEY (vessel_call_id, organization_id) REFERENCES vessel_calls (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX vessel_call_rodadas_vc_idx ON vessel_call_rodadas (vessel_call_id, data_operacional);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON vessel_call_rodadas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Tentativas da rodada (append-only): a original + no máximo UMA alternativa.
-- cache_hit, consulta_efetiva e falha são resultados DISTINTOS.
CREATE TABLE vessel_call_rodada_tentativas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rodada_id UUID NOT NULL REFERENCES vessel_call_rodadas(id) ON DELETE CASCADE,
  numero_tentativa INTEGER NOT NULL CHECK (numero_tentativa >= 1),
  target_id UUID REFERENCES tracking_targets(id) ON DELETE SET NULL,
  container_id UUID REFERENCES containers(id) ON DELETE SET NULL,
  iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminada_em TIMESTAMPTZ,
  resultado TEXT CHECK (resultado IN ('cache_hit', 'consulta_efetiva', 'falha')),
  tracking_fetch_id UUID REFERENCES tracking_fetches(id),
  cache_hit BOOLEAN NOT NULL DEFAULT false,
  consulta_efetiva BOOLEAN NOT NULL DEFAULT false,
  falha_sanitizada TEXT,
  CONSTRAINT vcrt_tentativa_unica UNIQUE (rodada_id, numero_tentativa)
);
CREATE INDEX vessel_call_rodada_tentativas_idx ON vessel_call_rodada_tentativas (rodada_id, numero_tentativa);
CREATE TRIGGER vessel_call_rodada_tentativas_append_only
  BEFORE UPDATE OR DELETE ON vessel_call_rodada_tentativas
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Cobertura compartilhada por participante: enquanto vigente (coberto_ate no
-- futuro), o beneficiado é excluído SÓ da seleção automática compartilhável —
-- NUNCA conclui/altera claim individual, NUNCA cria TrackingFetch, NUNCA altera
-- última consulta, NUNCA bloqueia atualização manual nem consulta obrigatória
-- pós-saída. É estado (transita vigente→vencida|invalidada); nunca é apagada.
-- ---------------------------------------------------------------------------
CREATE TABLE vessel_call_coberturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  vessel_call_id UUID NOT NULL,
  tracking_target_id UUID REFERENCES tracking_targets(id) ON DELETE SET NULL,
  container_id UUID REFERENCES containers(id) ON DELETE SET NULL,
  rodada_id UUID REFERENCES vessel_call_rodadas(id) ON DELETE SET NULL,
  cobertura_originadora_fetch_id UUID REFERENCES tracking_fetches(id),
  target_consultado_id UUID REFERENCES tracking_targets(id) ON DELETE SET NULL,
  processo_consultado_id UUID REFERENCES processos(id) ON DELETE SET NULL,
  coberto_desde TIMESTAMPTZ NOT NULL DEFAULT now(),
  coberto_ate TIMESTAMPTZ NOT NULL,
  campos_compartilhados TEXT[] NOT NULL DEFAULT '{}',
  evidencia TEXT,
  motivo_termino TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente' CHECK (estado IN ('vigente', 'vencida', 'invalidada')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vcc_vessel_call_org_fk FOREIGN KEY (vessel_call_id, organization_id) REFERENCES vessel_calls (id, organization_id) ON DELETE CASCADE
);
-- No máximo UMA cobertura VIGENTE por (contêiner, vessel_call).
CREATE UNIQUE INDEX vessel_call_coberturas_vigente_unica
  ON vessel_call_coberturas (vessel_call_id, container_id) WHERE estado = 'vigente';
CREATE INDEX vessel_call_coberturas_target_idx ON vessel_call_coberturas (tracking_target_id, estado);
CREATE INDEX vessel_call_coberturas_org_idx ON vessel_call_coberturas (organization_id);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON vessel_call_coberturas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
