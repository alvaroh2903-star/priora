-- Demurrage Engine V2 — migration ADITIVA (Fase 8 v1.1: guarda de FINAL em
-- profundidade). 0001-0016 não são reescritas.
--
-- Defesa em profundidade (item 4): além do guard de aplicação no orquestrador,
-- o banco impede que um processo FINAL tenha relógios/valores recalculados
-- (superseded) ou o effective_return_date materialmente alterado sem reabertura.
-- A reabertura volta o processo a OPEN antes de qualquer recálculo, então o
-- pipeline normal opera livremente em OPEN; só FINAL é congelado.
--
-- Exceção documental (aprovada): em processo FINAL, uma minuta posterior que
-- apenas CONFIRMA a mesma data já usada no fechamento pode materializar
-- effective_return_date = tracking_return_date (não altera valor). Por isso o
-- guard de `containers` só barra quando a nova data difere do tracking.

-- 1) valores_apurados: nenhum INSERT/supersede quando o processo está FINAL.
CREATE OR REPLACE FUNCTION forbid_valor_write_processo_final() RETURNS TRIGGER AS $$
DECLARE st TEXT;
BEGIN
  SELECT p.apuracao_status INTO st
    FROM containers c JOIN processos p ON p.id = c.processo_id
   WHERE c.id = NEW.container_id;
  IF st = 'FINAL' THEN
    RAISE EXCEPTION 'valores_apurados: processo FINAL congelado — recalculo/supersede exige reabertura';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER valores_apurados_final_guard
  BEFORE INSERT OR UPDATE ON valores_apurados
  FOR EACH ROW EXECUTE FUNCTION forbid_valor_write_processo_final();

-- 2) relogios: cache não é reescrito quando o processo está FINAL (congela dias).
CREATE OR REPLACE FUNCTION forbid_relogio_write_processo_final() RETURNS TRIGGER AS $$
DECLARE st TEXT;
BEGIN
  SELECT p.apuracao_status INTO st
    FROM containers c JOIN processos p ON p.id = c.processo_id
   WHERE c.id = NEW.container_id;
  IF st = 'FINAL' THEN
    RAISE EXCEPTION 'relogios: processo FINAL congelado — recalculo exige reabertura';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER relogios_final_guard
  BEFORE INSERT OR UPDATE ON relogios
  FOR EACH ROW EXECUTE FUNCTION forbid_relogio_write_processo_final();

-- 3) containers.effective_return_date: alteração MATERIAL barrada em FINAL.
--    (mudança para = tracking_return_date é a exceção documental, permitida.)
CREATE OR REPLACE FUNCTION forbid_effective_change_processo_final() RETURNS TRIGGER AS $$
DECLARE st TEXT;
BEGIN
  IF NEW.effective_return_date IS DISTINCT FROM OLD.effective_return_date THEN
    SELECT apuracao_status INTO st FROM processos WHERE id = NEW.processo_id;
    IF st = 'FINAL' AND NEW.effective_return_date IS DISTINCT FROM NEW.tracking_return_date THEN
      RAISE EXCEPTION 'effective_return_date: processo FINAL — alteracao material exige reabertura';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER containers_effective_final_guard
  BEFORE UPDATE ON containers
  FOR EACH ROW EXECUTE FUNCTION forbid_effective_change_processo_final();
