-- Demurrage Engine V2 — migration ADITIVA: House e Master Free Time separados
-- na Shipping Instructions (SI) e associação registrada. 0024 e 0025 são
-- imutáveis e não são reescritas.
--
-- A SI real traz os dois valores ("FREE TIME HOUSE: 20" / "FREE TIME MASTER:
-- 20"). Até aqui a intenção só representava o Master; agora cada intenção e
-- cada proveniência dizem a qual campo pertencem. Linhas existentes recebem
-- 'masterFreeTimeDays' (é o que elas eram). Colunas com DEFAULT constante não
-- reescrevem linhas nem disparam os triggers append-only.

ALTER TABLE si_intencoes ADD COLUMN campo TEXT NOT NULL DEFAULT 'masterFreeTimeDays'
  CONSTRAINT si_intencoes_campo_check CHECK (campo IN ('masterFreeTimeDays', 'houseFreeTimeDays'));

-- A unicidade da intenção passa a considerar o campo (House e Master do mesmo
-- alcance coexistem na mesma versão). O índice novo é criado ANTES de remover o
-- antigo; nenhum dado é alterado — só a chave de unicidade é ampliada.
CREATE UNIQUE INDEX si_intencoes_unica_campo ON si_intencoes (versao_id, campo, escopo, COALESCE(container_numero, ''));
DROP INDEX si_intencoes_unica;

ALTER TABLE si_proveniencias ADD COLUMN campo TEXT NOT NULL DEFAULT 'masterFreeTimeDays'
  CONSTRAINT si_proveniencias_campo_check CHECK (campo IN ('masterFreeTimeDays', 'houseFreeTimeDays'));

-- Como a intenção foi associada ao processo. A SI real é emitida antes do MBL:
-- 'numero_processo' registra a associação feita só pelo código (ex.: IM3126-26).
-- Nulo em linhas anteriores a esta migration (informação não registrada à época).
ALTER TABLE si_proveniencias ADD COLUMN associacao_por TEXT
  CONSTRAINT si_proveniencias_associacao_check CHECK (associacao_por IN ('numero_processo', 'mbl', 'numero_processo_e_mbl'));

-- Recálculo também quando o House Free Time selecionado muda (relógio do
-- cliente, que só muda com observação válida de House Free Time).
ALTER TABLE recalculo_outbox DROP CONSTRAINT recalculo_outbox_tipo_check;
ALTER TABLE recalculo_outbox ADD CONSTRAINT recalculo_outbox_tipo_check
  CHECK (tipo IN ('master_free_time', 'house_free_time'));
