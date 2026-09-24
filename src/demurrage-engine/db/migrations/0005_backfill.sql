-- Demurrage Engine V2 — Fase 1: rastreabilidade do backfill/bootstrap.
--
-- BackfillRun é OPERACIONAL (mutável in-place), não append-only: seus
-- contadores agregados só ficam completos ao final da execução. BackfillItem
-- é append-only — é ele quem carrega a rastreabilidade por item exigida
-- (ponto 12, revisão 3), não só um contador agregado.

CREATE TABLE backfill_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  executado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'em_andamento' CHECK (status IN ('em_andamento', 'concluido')),
  processos_processados INTEGER NOT NULL DEFAULT 0,
  campos_marcados_pendentes INTEGER NOT NULL DEFAULT 0,
  erros JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX backfill_runs_org_idx ON backfill_runs(organization_id);

CREATE TABLE backfill_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backfill_run_id UUID NOT NULL REFERENCES backfill_runs(id),
  entidade_tipo TEXT NOT NULL,
  entidade_id UUID NOT NULL,
  resultado TEXT NOT NULL CHECK (
    resultado IN ('criado', 'atualizado', 'pendencia_marcada', 'ignorado', 'erro')
  ),
  detalhe JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX backfill_items_run_idx ON backfill_items(backfill_run_id);

CREATE TRIGGER backfill_items_append_only
  BEFORE UPDATE OR DELETE ON backfill_items
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
