-- Produção P1 — Entrega 1, corretiva v1.1 (handoff: vínculo estável de
-- processo + snapshot de resposta para replay sem escrita).
-- migration ADITIVA; 0001-0040 não são reescritas.
--
-- Achado #1 do usuário: `origemProcessoId` era descrito como a identidade
-- ESTÁVEL do processo a montante, mas nada persistia esse vínculo — o
-- serviço continuava identificando o processo interno por `numeroProcesso`
-- (dado mutável da própria requisição) a cada chamada. Dois eventos
-- diferentes com o MESMO `origemProcessoId` podiam, então, apontar para
-- `numeroProcesso` diferentes e criar/atualizar processos internos
-- diferentes — quebrando a garantia de identidade estável.
--
-- `demurrage_handoff_processo_links` fecha essa lacuna: um vínculo
-- AUTORITATIVO e IMUTÁVEL (organization_id, origem_sistema,
-- origem_processo_id) -> processo_id. O PRIMEIRO evento aplicado com
-- sucesso estabelece o vínculo; todo evento seguinte com a MESMA
-- identidade a montante tem de resolver o processo por ESTE vínculo —
-- nunca por MBL/HBL/número de contêiner/nome de cliente (fatos comerciais
-- mutáveis) e nunca silenciosamente migrar a identidade a montante para
-- outro processo interno. A linha inteira é imutável (`forbid_mutation`):
-- nem o próprio `processo_id` pode ser trocado depois de gravado — isso é
-- o que torna a garantia de banco "nunca reatribuir" real, não só de
-- aplicação.
CREATE TABLE demurrage_handoff_processo_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  origem_sistema TEXT NOT NULL,
  origem_processo_id TEXT NOT NULL,
  processo_id UUID NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demurrage_handoff_processo_links_unica
    UNIQUE (organization_id, origem_sistema, origem_processo_id),
  CONSTRAINT demurrage_handoff_processo_links_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id)
);
CREATE INDEX demurrage_handoff_processo_links_processo_idx
  ON demurrage_handoff_processo_links (organization_id, processo_id);

-- Linha inteira imutável: nem a organização, nem a identidade a montante,
-- nem o processo vinculado podem mudar depois de criada. `forbid_mutation`
-- já existe (usada por si_intencoes/si_proveniencias desde a migration 0024)
-- — mesma convenção, reaproveitada aqui.
CREATE TRIGGER demurrage_handoff_processo_links_append_only
  BEFORE UPDATE OR DELETE ON demurrage_handoff_processo_links
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Mantida por convenção (toda tabela de tenant tem este trigger — ver
-- migration0007.test.ts) ainda que `forbid_mutation` já torne qualquer
-- UPDATE impossível, inclusive em organization_id.
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_handoff_processo_links
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- Achado da auditoria de replay (ver relatório v1.1, §6): reconstruir a
-- resposta de um evento JÁ CONCLUÍDO com sucesso chamando
-- `registrarProcessoDemurrage` de novo NÃO é garantidamente uma operação
-- sem escrita — o reparo pós-commit do outbox (D10 v1.1) roda incondicional
-- a cada chamada e pode gravar em `demurrage_pos_commit_outbox`/`snapshots`/
-- `valores_apurados` se ainda houver reparo pendente para aquele processo,
-- mesmo que o PRÓPRIO evento do handoff já esteja concluído como
-- `ACEITO_COM_PENDENCIA`. `resposta_aplicada` grava, no momento da conclusão
-- bem-sucedida (não no replay), um retrato fiel da resposta de negócio —
-- um replay posterior do MESMO evento lê este retrato em vez de chamar o
-- D10 de novo, tornando o replay uma leitura pura, sem exceção.
ALTER TABLE demurrage_handoff_eventos ADD COLUMN resposta_aplicada JSONB;
