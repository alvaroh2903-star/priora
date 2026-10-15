-- Demurrage Engine V2 — migration ADITIVA (Produção P1, Entrega 2 — rotas de
-- ação operacional). 0001-0041 NÃO são reescritas.
--
-- Única necessidade de schema desta entrega: uma chave de idempotência
-- PERSISTIDA para a ÚNICA ação cujo serviço congelado não oferece nenhuma
-- garantia natural contra duplicação sob retry — `ClosingService.registrarMinuta`
-- (captura/upload de minuta, sem RBAC, sem chave natural: duas chamadas com o
-- MESMO corpo criam duas linhas `RECEBIDA` distintas, sem nenhum conflito de
-- unicidade a detectar isso). Todas as outras seis famílias de ação desta
-- entrega já têm idempotência garantida pelo próprio serviço congelado
-- (ja_final, reabertura_ja_aberta/autorizada, resolução silenciosa de
-- pendência já resolvida, versionamento otimista da responsabilidade, ou
-- deduplicação na camada de observação do fallback manual) — ver
-- docs/demurrage-producao-p1-entrega-2.md §idempotência para a prova de cada
-- uma; nenhuma delas usa esta tabela.
--
-- Tabela GENÉRICA (não amarrada a "minuta" no nome) para que uma futura rota
-- desta mesma família de ações que precise da mesma garantia reaproveite o
-- artefato em vez de criar um novo — mesma disciplina já seguida em
-- `demurrage_pendencias`/`ft_divergencias` (nenhuma tabela de exceção nova
-- por caso). `rota` + `chave` (fornecida pelo chamador, ex.: cabeçalho
-- `Idempotency-Key`) + `organization_id` formam a chave de deduplicação —
-- nunca entre organizações diferentes, mesmo com a mesma chave textual.
CREATE TABLE demurrage_acoes_idempotencia (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  membership_id UUID NOT NULL REFERENCES organization_memberships(id),
  rota TEXT NOT NULL,
  chave TEXT NOT NULL,
  resultado JSONB NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demurrage_acoes_idempotencia_unica UNIQUE (organization_id, rota, chave)
);
CREATE INDEX demurrage_acoes_idempotencia_org_idx ON demurrage_acoes_idempotencia (organization_id);

-- Append-only (mesma convenção de demurrage_handoff_processo_links, 0041):
-- uma vez gravado o resultado de uma chamada, nunca é mutado nem apagado —
-- um retry sempre lê o MESMO resultado da primeira aplicação bem-sucedida.
CREATE TRIGGER demurrage_acoes_idempotencia_append_only
  BEFORE UPDATE OR DELETE ON demurrage_acoes_idempotencia
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_acoes_idempotencia
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
