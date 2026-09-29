-- Demurrage Engine V2 — Fase D11 v1.2 (corretiva final, aditiva). 0001-0033
-- não são reescritas: funções de trigger são substituídas via CREATE OR
-- REPLACE e triggers são (re)criados; nenhuma tabela ou coluna muda.
--
-- Integridade do AGREGADO da decisão (decisão + períodos + dias):
--
-- A 0033 passou a validar a cobertura a partir da própria decisão (cobre a
-- decisão sem nenhum dia), mas removeu o trigger por dia — uma linha de dia
-- (ou de período) acrescentada DEPOIS, em outra transação, não era mais
-- revalidada. Agora UMA única função de validação
-- (`responsabilidade_validar_agregado`) é chamada por três restrições
-- ADIADAS, disparadas:
--   - pela criação da decisão          (responsabilidade_decisoes_cobertura);
--   - pela inclusão de cada dia        (responsabilidade_decisao_dias_cobertura);
--   - pela inclusão de cada período    (responsabilidade_decisao_periodos_cobertura).
-- As três usam a MESMA regra — não há duas versões divergentes.
--
-- No COMMIT, para a decisão afetada:
--   - contagem Rocket = dias_rocket e contagem cliente = dias_cliente;
--   - RELOGIO_CLIENTE: cobre todos os dias reais do relógio do cliente, sem buraco;
--   - RELOGIO_ROCKET: pelo menos um dia Rocket concreto;
--   - NAO_APLICAVEL: nenhum dia e nenhum período;
--   - posições cronológicas únicas e iguais à posição real do dia no relógio-base;
--   - moeda de cada dia = moeda da decisão;
--   - valor_status = CALCULADO: todo dia valorado e soma por lado = valor_rocket /
--     valor_cliente; demais status: nenhum dia valorado;
--   - períodos sem sobreposição e, expandidos, IGUAIS ao conjunto (dia, lado)
--     gravado — nenhum dia sem período, nenhum período sem os seus dias.

CREATE OR REPLACE FUNCTION responsabilidade_validar_agregado(p_decisao_id UUID) RETURNS VOID AS $$
DECLARE
  dec RECORD;
  rel RECORD;
  c_rocket INTEGER;
  c_cliente INTEGER;
  c_total INTEGER;
  c_posicoes INTEGER;
  soma_rocket NUMERIC;
  soma_cliente NUMERIC;
BEGIN
  SELECT * INTO dec FROM responsabilidade_decisoes WHERE id = p_decisao_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) FILTER (WHERE lado = 'ROCKET'), count(*) FILTER (WHERE lado = 'CLIENTE'),
         count(*), count(DISTINCT posicao)
    INTO c_rocket, c_cliente, c_total, c_posicoes
    FROM responsabilidade_decisao_dias WHERE decisao_id = p_decisao_id;

  -- Contagem por lado.
  IF c_rocket <> dec.dias_rocket OR c_cliente <> dec.dias_cliente THEN
    RAISE EXCEPTION 'LACUNA: dias gravados (rocket=%, cliente=%) nao batem com a decisao % (rocket=%, cliente=%)',
      c_rocket, c_cliente, dec.id, dec.dias_rocket, dec.dias_cliente;
  END IF;

  -- NAO_APLICAVEL: único caso sem dias — e sem períodos.
  IF dec.base_relogio = 'NAO_APLICAVEL' THEN
    IF c_total > 0 THEN
      RAISE EXCEPTION 'AGREGADO_INVALIDO: decisao NAO_APLICAVEL % nao aceita dias', dec.id;
    END IF;
    IF EXISTS (SELECT 1 FROM responsabilidade_decisao_periodos WHERE decisao_id = dec.id) THEN
      RAISE EXCEPTION 'PERIODO_INCOMPATIVEL: decisao NAO_APLICAVEL % nao aceita periodos', dec.id;
    END IF;
    RETURN;
  END IF;

  IF dec.base_relogio = 'RELOGIO_ROCKET' AND c_rocket < 1 THEN
    RAISE EXCEPTION 'LACUNA: decisao RELOGIO_ROCKET % sem nenhum dia Rocket concreto', dec.id;
  END IF;

  SELECT primeiro_dia_demurrage, data_final_apuracao, dias_demurrage INTO rel
    FROM relogios
   WHERE container_id = dec.container_id
     AND tipo = CASE WHEN dec.base_relogio = 'RELOGIO_CLIENTE' THEN 'cliente' ELSE 'rocket' END;

  -- Cobertura completa do relógio do cliente: mesma quantidade e nenhum buraco.
  IF dec.base_relogio = 'RELOGIO_CLIENTE' THEN
    IF rel.dias_demurrage IS NULL OR c_total <> rel.dias_demurrage THEN
      RAISE EXCEPTION 'LACUNA: decisao % cobre % dia(s) mas o relogio cliente tem % dia(s) de demurrage',
        dec.id, c_total, rel.dias_demurrage;
    END IF;
    IF EXISTS (
      SELECT 1 FROM generate_series(rel.primeiro_dia_demurrage, rel.data_final_apuracao, interval '1 day') AS g(d)
       WHERE NOT EXISTS (SELECT 1 FROM responsabilidade_decisao_dias x WHERE x.decisao_id = dec.id AND x.dia = g.d::date)
    ) THEN
      RAISE EXCEPTION 'LACUNA: decisao % deixa dia(s) do relogio cliente sem atribuicao', dec.id;
    END IF;
  END IF;

  -- Posições cronológicas: únicas e iguais à posição real no relógio-base.
  IF c_posicoes <> c_total OR EXISTS (
    SELECT 1 FROM responsabilidade_decisao_dias x
     WHERE x.decisao_id = dec.id AND x.posicao <> (x.dia - rel.primeiro_dia_demurrage) + 1
  ) THEN
    RAISE EXCEPTION 'POSICAO_INVALIDA: posicoes cronologicas duplicadas ou fora da ordem real na decisao %', dec.id;
  END IF;

  -- Moeda de cada dia = moeda da decisão.
  IF EXISTS (SELECT 1 FROM responsabilidade_decisao_dias x WHERE x.decisao_id = dec.id AND x.moeda IS DISTINCT FROM dec.moeda) THEN
    RAISE EXCEPTION 'MOEDA_DIVERGENTE: dia com moeda diferente da decisao % (%)', dec.id, dec.moeda;
  END IF;

  -- Soma financeira dos dias.
  IF dec.valor_status = 'CALCULADO' THEN
    IF EXISTS (SELECT 1 FROM responsabilidade_decisao_dias x WHERE x.decisao_id = dec.id AND x.valor_dia IS NULL) THEN
      RAISE EXCEPTION 'VALOR_DIVERGENTE: decisao CALCULADA % com dia sem diaria', dec.id;
    END IF;
    SELECT COALESCE(sum(valor_dia) FILTER (WHERE lado = 'ROCKET'), 0), COALESCE(sum(valor_dia) FILTER (WHERE lado = 'CLIENTE'), 0)
      INTO soma_rocket, soma_cliente
      FROM responsabilidade_decisao_dias WHERE decisao_id = dec.id;
    IF soma_rocket <> dec.valor_rocket OR soma_cliente <> dec.valor_cliente THEN
      RAISE EXCEPTION 'VALOR_DIVERGENTE: soma dos dias (rocket=%, cliente=%) difere da decisao % (rocket=%, cliente=%)',
        soma_rocket, soma_cliente, dec.id, dec.valor_rocket, dec.valor_cliente;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM responsabilidade_decisao_dias x WHERE x.decisao_id = dec.id AND x.valor_dia IS NOT NULL) THEN
    RAISE EXCEPTION 'VALOR_DIVERGENTE: decisao % sem valor CALCULADO nao aceita diaria nos dias', dec.id;
  END IF;

  -- Períodos: sem sobreposição e expansão = dias gravados (dia e lado).
  IF EXISTS (
    SELECT 1 FROM responsabilidade_decisao_periodos a
      JOIN responsabilidade_decisao_periodos b
        ON b.decisao_id = a.decisao_id AND b.id <> a.id AND a.inicio <= b.fim AND b.inicio <= a.fim
     WHERE a.decisao_id = dec.id
  ) THEN
    RAISE EXCEPTION 'PERIODO_INCOMPATIVEL: periodos sobrepostos na decisao %', dec.id;
  END IF;
  IF EXISTS (
    (SELECT g.d::date, p.lado FROM responsabilidade_decisao_periodos p,
            generate_series(p.inicio, p.fim, interval '1 day') AS g(d)
      WHERE p.decisao_id = dec.id
     EXCEPT
     SELECT dia, lado FROM responsabilidade_decisao_dias WHERE decisao_id = dec.id)
    UNION ALL
    (SELECT dia, lado FROM responsabilidade_decisao_dias WHERE decisao_id = dec.id
     EXCEPT
     SELECT g.d::date, p.lado FROM responsabilidade_decisao_periodos p,
            generate_series(p.inicio, p.fim, interval '1 day') AS g(d)
      WHERE p.decisao_id = dec.id)
  ) THEN
    RAISE EXCEPTION 'PERIODO_INCOMPATIVEL: periodos declarados nao correspondem aos dias gravados na decisao %', dec.id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Disparo pela DECISÃO (0033): mesma função, chave = NEW.id.
CREATE OR REPLACE FUNCTION responsabilidade_decisao_cobertura_completa_por_decisao() RETURNS TRIGGER AS $$
BEGIN
  PERFORM responsabilidade_validar_agregado(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Disparo pelo DIA e pelo PERÍODO (função da 0031 substituída): chave = NEW.decisao_id.
CREATE OR REPLACE FUNCTION responsabilidade_decisao_cobertura_completa() RETURNS TRIGGER AS $$
BEGIN
  PERFORM responsabilidade_validar_agregado(NEW.decisao_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A restrição da decisão (0033) continua existindo; é garantida aqui também
-- para bancos onde a 0033 tenha sido aplicada sem ela.
DROP TRIGGER IF EXISTS responsabilidade_decisoes_cobertura ON responsabilidade_decisoes;
CREATE CONSTRAINT TRIGGER responsabilidade_decisoes_cobertura
  AFTER INSERT ON responsabilidade_decisoes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_cobertura_completa_por_decisao();

-- Restrição por DIA restaurada (removida pela 0033): um dia acrescentado depois,
-- em qualquer transação, revalida o agregado inteiro no COMMIT.
DROP TRIGGER IF EXISTS responsabilidade_decisao_dias_cobertura ON responsabilidade_decisao_dias;
CREATE CONSTRAINT TRIGGER responsabilidade_decisao_dias_cobertura
  AFTER INSERT ON responsabilidade_decisao_dias
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_cobertura_completa();

-- Restrição por PERÍODO (nova): um período acrescentado depois revalida o agregado.
CREATE CONSTRAINT TRIGGER responsabilidade_decisao_periodos_cobertura
  AFTER INSERT ON responsabilidade_decisao_periodos
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_cobertura_completa();
