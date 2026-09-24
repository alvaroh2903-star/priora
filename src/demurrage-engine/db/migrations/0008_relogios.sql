-- Demurrage Engine V2 — migration ADITIVA (revisão 6 do plano, Fase 3).
-- 0001-0007 não são reescritas.
--
-- Tabela `relogios`: CACHE / PROJEÇÃO PURA dos dois relógios (Cliente ← House,
-- Rocket ← Master) de cada contêiner. Nada aqui é fonte da verdade: cada linha
-- é 100% regenerável a partir de (descarga do contêiner, free time
-- correspondente, data final de apuração, versão do motor temporal). O motor
-- (freeTimeClock, chamado duas vezes pelo dualClockCalculator) é a única fonte.
--
-- input_hash resume TODAS as entradas relevantes daquele relógio. Se qualquer
-- uma muda, o hash muda e a linha está obsoleta (stale/inválida) — quem lê
-- compara o hash gravado com o recalculado a partir das entradas atuais.
--
-- Não há alteração manual válida do cache: um trigger exige que todo INSERT e
-- UPDATE venham do recalculador (SET LOCAL demurrage.relogio_writer =
-- 'dualClockCalculator'). DELETE é livre — apagar só força a regeneração.

CREATE TABLE relogios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  -- Qual dos dois relógios do contêiner esta linha projeta.
  tipo TEXT NOT NULL CHECK (tipo IN ('cliente', 'rocket')),
  -- Espelha FreeTimeClockResult.status.
  estado TEXT NOT NULL CHECK (estado IN ('OK', 'PENDING', 'INVALID')),
  ultimo_dia_livre DATE,
  primeiro_dia_demurrage DATE,
  -- Sempre presente: é uma das entradas do cálculo (não um resultado).
  data_final_apuracao DATE NOT NULL,
  dias_demurrage INTEGER CHECK (dias_demurrage IS NULL OR dias_demurrage >= 0),
  pendencias TEXT[] NOT NULL DEFAULT '{}',
  motivo TEXT,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  engine_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  UNIQUE (container_id, tipo),

  -- A forma da linha tem que ser coerente com o estado projetado — o cache não
  -- pode guardar um "OK sem dias" nem um "PENDING com data de demurrage".
  CONSTRAINT relogios_forma_por_estado CHECK (
    (estado = 'OK' AND ultimo_dia_livre IS NOT NULL AND primeiro_dia_demurrage IS NOT NULL
       AND dias_demurrage IS NOT NULL AND motivo IS NULL AND cardinality(pendencias) = 0)
    OR
    (estado = 'PENDING' AND ultimo_dia_livre IS NULL AND primeiro_dia_demurrage IS NULL
       AND dias_demurrage IS NULL AND motivo IS NULL AND cardinality(pendencias) >= 1)
    OR
    (estado = 'INVALID' AND ultimo_dia_livre IS NULL AND primeiro_dia_demurrage IS NULL
       AND dias_demurrage IS NULL AND motivo IS NOT NULL)
  )
);

-- Leitura por contêiner (os dois relógios de uma vez).
CREATE INDEX relogios_container_idx ON relogios (container_id);

-- Cache não se edita à mão: só o recalculador escreve.
CREATE OR REPLACE FUNCTION forbid_relogio_manual_write() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('demurrage.relogio_writer', true) IS DISTINCT FROM 'dualClockCalculator' THEN
    RAISE EXCEPTION
      'relogios e cache regeneravel: INSERT/UPDATE so pelo recalculador (dualClockCalculator), nunca manualmente';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER relogios_somente_recalculador
  BEFORE INSERT OR UPDATE ON relogios
  FOR EACH ROW EXECUTE FUNCTION forbid_relogio_manual_write();
