-- Demurrage Engine V2 — migration ADITIVA (Fase 8 v1.3). 0001-0017 não são
-- reescritas; aqui só se REDEFINE a função do guard documental do FINAL.
--
-- Endurecimento (v1.3, item 2): em processo FINAL, a exceção documental que
-- permite materializar effective_return_date sem reabertura NÃO pode se apoiar no
-- `tracking_return_date` ATUAL (que um tracking posterior pode ter movido). A
-- prova de que a minuta apenas CONFIRMA o resultado congelado é a DATA FINAL
-- efetivamente usada e congelada no fechamento — `relogios.data_final_apuracao`
-- (imutável em FINAL pelo guard de relógios da 0017). Qualquer effective diferente
-- dessa data congelada é mudança MATERIAL e exige reabertura.
--
-- A evidência de tracking posterior continua sendo PRESERVADA (tracking_return_date
-- pode mudar em FINAL — não é barrado); o que muda é que ela deixa de servir como
-- prova para alterar effective sem reabertura.

CREATE OR REPLACE FUNCTION forbid_effective_change_processo_final() RETURNS TRIGGER AS $$
DECLARE
  st TEXT;
  congelada DATE;
BEGIN
  IF NEW.effective_return_date IS DISTINCT FROM OLD.effective_return_date THEN
    SELECT apuracao_status INTO st FROM processos WHERE id = NEW.processo_id;
    IF st = 'FINAL' THEN
      -- Data final congelada no fechamento = a dos relógios (imutável em FINAL).
      SELECT data_final_apuracao INTO congelada
        FROM relogios WHERE container_id = NEW.id AND tipo = 'cliente';
      IF NEW.effective_return_date IS DISTINCT FROM congelada THEN
        RAISE EXCEPTION 'effective_return_date: processo FINAL — alteracao material (difere da data final congelada %) exige reabertura', congelada;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- O TRIGGER da 0017 já aponta para esta função (CREATE OR REPLACE mantém o binding).
