-- Fase D15-C — Integridade tarifária e recuperação de filas (migration
-- ADITIVA; 0001-0036 não são reescritas).
--
-- Cobre, só na camada de banco, os seis casos aprovados em
-- docs/demurrage-fase-d15-diagnostico.md (R28, R29, R30, R57, R58, R59):
--
--   1) tariff_tables: coluna `ativada_em` (versionamento/imutabilidade, R30) —
--      ver nota de retrocompatibilidade abaixo;
--   2) tariff_tables_versao_unica: corrigida para NULLS NOT DISTINCT — a
--      unicidade era inefetiva porque cada tipo de tabela sempre tem
--      exatamente uma de {armador_id, termo_comercial} nula (R30);
--   3) tariff_tables/tariff_brackets: triggers de imutabilidade — uma versão
--      ATIVADA (ativada_em preenchido) OU USADA (referenciada por
--      valores_apurados.tabela_id) nunca aceita UPDATE/DELETE na tabela, nem
--      INSERT/UPDATE/DELETE nas faixas (R30);
--   4) tariff_brackets: EXCLUDE constraint (GiST) contra faixas sobrepostas
--      no mesmo (tariff_table_id, tipo_equipamento) — funciona por serviço,
--      por SQL direto e sob concorrência (a própria natureza de um índice)
--      (R28);
--   5) tracking_alert_deliveries: claim_token/worker_id/expira_em + status
--      'PROCESSING' — mesmo protocolo de claim/posse já usado em
--      demurrage_fallback_manual_avisos/ft_divergencia_entregas/
--      demurrage_pendencia_avisos (R59).
--
-- R29 (moeda mista aborta a transação) e R57/R58 (filas presas em
-- PROCESSING/sem teto de tentativas) são corrigidos só em código de
-- aplicação — nenhuma migration nova é necessária para eles (tentativas já
-- existe em todas as filas afetadas; o teto é um parâmetro de chamada, não
-- uma constraint).
--
-- Nota de retrocompatibilidade (R30 — "ativada" vs. "usada", e por que
-- `ativada_em` NÃO tem DEFAULT now()): o padrão universal de todo seed/teste
-- existente é "INSERT na tabela, DEPOIS um loop de INSERT nas faixas" — a
-- tabela e suas faixas nunca nascem atômicas na mesma instrução. Testado
-- empiricamente: dar a `ativada_em` um DEFAULT now() quebra esse padrão
-- universal, porque a tabela já nasceria IMUTÁVEL antes da primeira faixa
-- ser inserida — toda chamada a `seedArmadorTables`/`seedRocketTermoPorEmbarque`
-- (e qualquer código futuro que siga a mesma ordem) passaria a falhar. Por
-- isso `ativada_em` fica SEM DEFAULT (NULL por omissão, igual a qualquer
-- outra coluna nova): nenhuma tabela nasce automaticamente "ativada" só por
-- existir. A imutabilidade continua garantida pelo OUTRO gatilho, que
-- cobre com segurança o caso real — "usada por um ValorApurado" só pode
-- acontecer depois que a tabela e TODAS as suas faixas já foram inseridas
-- (nenhum cálculo roda no meio de um seed). "Ativada" (`ativada_em`
-- preenchido) fica como um TRAVAMENTO explícito e opcional, feito só por
-- quem chama `tariffTableService.ativar()` depois de já ter inserido as
-- faixas — útil para travar uma versão revisada antes mesmo do primeiro uso,
-- sem depender de esperar por um cálculo. `selecionarVigente`/`buscarPorId`
-- NUNCA filtram por `ativada_em` — ele não é um controle de visibilidade,
-- só de mutabilidade; a seleção de versão vigente permanece exatamente a
-- mesma regra de data/dimensão de sempre. Linhas pré-existentes recebem
-- `ativada_em = criado_em` (fato real já na própria linha, nunca uma data
-- inventada): todo o histórico anterior a esta fase é declarado congelado a
-- partir de agora, preservando o espírito original do comentário da
-- migration 0009 ("uma versão usada por um cálculo nunca é sobrescrita").

-- ---------------------------------------------------------------------------
-- 1) tariff_tables.ativada_em
-- ---------------------------------------------------------------------------
ALTER TABLE tariff_tables ADD COLUMN ativada_em TIMESTAMPTZ;
UPDATE tariff_tables SET ativada_em = criado_em;

COMMENT ON COLUMN tariff_tables.ativada_em IS
  'NULL (padrao, sem DEFAULT) = ainda nao travada explicitamente — pode seguir mutavel ate ser usada por um ValorApurado. Preenchido (tariffTableService.ativar) = travamento explicito e antecipado, opcional. Em qualquer um dos dois casos (preenchido OU ja usada), a versao fica IMUTAVEL (R30). NUNCA filtrado por selecionarVigente/buscarPorId — nao e controle de visibilidade, so de mutabilidade.';

-- ---------------------------------------------------------------------------
-- 2) Unicidade de versão — NULLS NOT DISTINCT (estagiada: aborta com os IDs
--    em conflito se algum dado legado já violar a unicidade corrigida; nunca
--    resolve silenciosamente uma duplicata descoberta).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  conflito RECORD;
BEGIN
  SELECT organization_id, tipo, armador_id, termo_comercial, versao, array_agg(id) AS ids, count(*) AS n
    INTO conflito
    FROM tariff_tables
   GROUP BY organization_id, tipo, armador_id, termo_comercial, versao
  HAVING count(*) > 1
   LIMIT 1;
  IF conflito.n IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0037 abortada: tariff_tables já tem versões duplicadas sob a unicidade corrigida (org=%, tipo=%, armador=%, termo=%, versao=%, ids=%) — resolva manualmente (qual versão é a verdadeira; a outra precisa de uma versao nova própria) antes de reaplicar esta migration.',
      conflito.organization_id, conflito.tipo, conflito.armador_id, conflito.termo_comercial, conflito.versao, conflito.ids;
  END IF;
END $$;

ALTER TABLE tariff_tables DROP CONSTRAINT tariff_tables_versao_unica;
ALTER TABLE tariff_tables ADD CONSTRAINT tariff_tables_versao_unica
  UNIQUE NULLS NOT DISTINCT (organization_id, tipo, armador_id, termo_comercial, versao);

-- A unicidade acima, agora com NULLS NOT DISTINCT, já cobre integralmente o
-- caso das tabelas públicas de armador (organization_id NULL tratado como
-- igual entre si) — o índice parcial legado fica redundante, mas inofensivo;
-- não é removido aqui (nenhuma migration aditiva precisa desfazer o que já
-- funcionava, só corrigir o que não funcionava).

-- ---------------------------------------------------------------------------
-- 3) Imutabilidade de versão ativada/usada (R30)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tariff_table_esta_congelada(p_tabela_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM tariff_tables t
     WHERE t.id = p_tabela_id
       AND (t.ativada_em IS NOT NULL OR EXISTS (SELECT 1 FROM valores_apurados v WHERE v.tabela_id = t.id))
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION tariff_table_esta_congelada(UUID) IS
  'true = a versao ja foi ativada (ativada_em preenchido) OU usada por pelo menos um ValorApurado — nos dois casos, imutavel (R30). Reusada pelos triggers de tariff_tables e tariff_brackets para nunca duplicar a checagem.';

CREATE OR REPLACE FUNCTION forbid_tariff_table_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tariff_table_esta_congelada(OLD.id) THEN
      RAISE EXCEPTION 'tariff_tables %: versao ativada ou usada em calculo e imutavel — DELETE barrado; crie uma nova versao (tariffTableService.criarVersaoCorrigida) para corrigir', OLD.id;
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: a própria ativação (ativada_em NULL -> preenchido) é a ÚNICA
  -- transição possível DEPOIS que a linha já está congelada — e ela só é
  -- alcançável a partir de um estado NÃO congelado (rascunho), então a
  -- checagem sobre o estado ANTERIOR (OLD) já barra qualquer tentativa de
  -- editar uma linha já ativada/usada, sem precisar de um caso especial.
  IF tariff_table_esta_congelada(OLD.id) THEN
    RAISE EXCEPTION 'tariff_tables %: versao ativada ou usada em calculo e imutavel — UPDATE barrado; crie uma nova versao (tariffTableService.criarVersaoCorrigida) para corrigir', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tariff_tables_imutavel
  BEFORE UPDATE OR DELETE ON tariff_tables
  FOR EACH ROW EXECUTE FUNCTION forbid_tariff_table_mutation();

CREATE OR REPLACE FUNCTION forbid_tariff_bracket_mutation() RETURNS TRIGGER AS $$
DECLARE
  tabela_ref UUID := COALESCE(NEW.tariff_table_id, OLD.tariff_table_id);
BEGIN
  IF tariff_table_esta_congelada(tabela_ref) THEN
    RAISE EXCEPTION 'tariff_brackets: a tabela % esta ativada ou usada em calculo — faixas imutaveis (insercao/edicao/remocao barrada); crie uma nova versao para corrigir', tabela_ref;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tariff_brackets_imutavel
  BEFORE INSERT OR UPDATE OR DELETE ON tariff_brackets
  FOR EACH ROW EXECUTE FUNCTION forbid_tariff_bracket_mutation();

-- ---------------------------------------------------------------------------
-- 4) Faixas sem sobreposição — EXCLUDE (GiST) por (tariff_table_id,
--    tipo_equipamento); funciona por serviço, por SQL direto e sob
--    concorrência real (é um índice, não uma checagem em memória de app).
--    `int4range(dia_inicial, dia_final + 1)`: dia_final NULL -> `dia_final+1`
--    e NULL, e `int4range(x, NULL)` o Postgres interpreta como limite
--    superior em aberto — exatamente a faixa [dia_inicial, ∞) já usada pelo
--    domínio, sem precisar de um CASE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  conflito RECORD;
BEGIN
  SELECT a.id AS id_a, b.id AS id_b, a.tariff_table_id, a.tipo_equipamento
    INTO conflito
    FROM tariff_brackets a
    JOIN tariff_brackets b
      ON a.tariff_table_id = b.tariff_table_id
     AND a.tipo_equipamento = b.tipo_equipamento
     AND a.id < b.id
     AND int4range(a.dia_inicial, a.dia_final + 1) && int4range(b.dia_inicial, b.dia_final + 1)
   LIMIT 1;
  IF conflito.id_a IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0037 abortada: tariff_brackets já tem faixas sobrepostas (tabela=%, equipamento=%, ids=% e %) — resolva manualmente (qual faixa é a verdadeira) antes de reaplicar esta migration.',
      conflito.tariff_table_id, conflito.tipo_equipamento, conflito.id_a, conflito.id_b;
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE tariff_brackets ADD CONSTRAINT tariff_brackets_sem_sobreposicao
  EXCLUDE USING GIST (
    tariff_table_id WITH =,
    tipo_equipamento WITH =,
    int4range(dia_inicial, dia_final + 1) WITH &&
  );

-- ---------------------------------------------------------------------------
-- 5) tracking_alert_deliveries: claim/posse (R59) — mesmo protocolo das
--    demais filas já corrigidas (demurrage_fallback_manual_avisos,
--    ft_divergencia_entregas, demurrage_pendencia_avisos).
-- ---------------------------------------------------------------------------
ALTER TABLE tracking_alert_deliveries DROP CONSTRAINT tracking_alert_deliveries_status_check;
ALTER TABLE tracking_alert_deliveries ADD CONSTRAINT tracking_alert_deliveries_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'));

ALTER TABLE tracking_alert_deliveries
  ADD COLUMN claim_token UUID,
  ADD COLUMN worker_id TEXT,
  ADD COLUMN expira_em TIMESTAMPTZ,
  ADD COLUMN atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT tracking_alert_deliveries_claim
    CHECK ((status = 'PROCESSING') = (claim_token IS NOT NULL AND worker_id IS NOT NULL AND expira_em IS NOT NULL));

CREATE INDEX tracking_alert_deliveries_claim_idx
  ON tracking_alert_deliveries (status, criado_em) WHERE status <> 'SENT';
