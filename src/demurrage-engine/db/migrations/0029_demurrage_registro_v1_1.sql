-- Demurrage Engine V2 — migration ADITIVA (Fase D10 v1.1 — corretiva do registro).
-- Não reescreve a 0028. Nenhuma regra congelada (relógios, tarifas, hierarquia
-- de fontes, cadência, responsabilidade, minuta, fechamento) muda.
--
--   1) demurrage_pos_commit_outbox — reparo DURÁVEL do pós-commit do registro
--      (recálculo + fotografia): uma falha entre o COMMIT principal e o
--      pós-processamento nunca deixa o contêiner permanentemente incompleto —
--      a linha continua pendente/falha até uma chamada reparar (idempotente);
--   2) container_equipamento_original ganha `observation_id` — o tipo original
--      selecionado passa a apontar para a MESMA observação vencedora que
--      derivou o tipo normalizado (em vez de ser sobrescrito incondicionalmente);
--   3) demurrage_fallback_manual_justificativas — governança do `manual_fallback`
--      (Free Time apenas): justificativa + autor identificado, sempre auditável
--      (Blueprint Cap. 4: "MANUAL_FALLBACK como último recurso auditado").

-- ---------------------------------------------------------------------------
-- 1) Outbox do pós-commit (recálculo + fotografia) do registro.
-- ---------------------------------------------------------------------------
CREATE TABLE demurrage_pos_commit_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  container_id UUID NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'concluido', 'falha')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT demurrage_pos_commit_outbox_unica UNIQUE (processo_id, container_id),
  CONSTRAINT demurrage_pos_commit_outbox_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT demurrage_pos_commit_outbox_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id)
);
CREATE INDEX demurrage_pos_commit_outbox_pendentes_idx
  ON demurrage_pos_commit_outbox (processo_id) WHERE estado <> 'concluido';
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_pos_commit_outbox
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
-- NÃO é append-only: `estado` transiciona pendente → concluido/falha (o
-- reparo é durável precisamente porque a linha é atualizada em vez de recriada).

-- ---------------------------------------------------------------------------
-- 2) Tipo original selecionado passa a apontar para a observação vencedora.
-- ---------------------------------------------------------------------------
ALTER TABLE container_equipamento_original
  ADD COLUMN observation_id UUID REFERENCES field_observations(id);

-- ---------------------------------------------------------------------------
-- 3) Governança do manual_fallback (Free Time): justificativa + autor.
-- ---------------------------------------------------------------------------
CREATE TABLE demurrage_fallback_manual_justificativas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  observation_id UUID NOT NULL UNIQUE REFERENCES field_observations(id),
  justificativa TEXT NOT NULL CHECK (length(trim(justificativa)) > 0),
  autor_membership_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demurrage_fallback_manual_autor_org_fk FOREIGN KEY (autor_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id)
);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_fallback_manual_justificativas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
CREATE TRIGGER demurrage_fallback_manual_justificativas_append_only
  BEFORE UPDATE OR DELETE ON demurrage_fallback_manual_justificativas
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
