-- Demurrage Engine V2 — Fase D11 (Gate G5): guarda de projeção + invalidação
-- automática por mudança de relógio. 0001-0031 não são reescritas.
--
-- Ajuste aprovado 6: "não preserve atualização direta de containers.responsa-
-- bilidade como caminho funcional... adicione proteção no banco para impedir
-- projeção incompatível com a decisão ativa". A coluna do contêiner CONTINUA
-- existindo (compatibilidade com lifecycle/fechamento, 0016) mas só pode
-- conter exatamente o que a decisão VIGENTE (maior versão) diz — nunca um
-- valor arbitrário, nunca uma decisão que não é mais a vigente.
--
-- Ajuste aprovado 1/2: uma decisão fica DESATUALIZADA quando o(s) relógio(s)
-- que a sustentaram mudam depois (novo tracking, nova minuta, reabertura +
-- recálculo). `responsabilidade_decisoes.base` (0031) guarda o input_hash dos
-- dois relógios NO MOMENTO da decisão; quando o relógio é regravado com um
-- input_hash diferente, a projeção volta a NULL (== EM_ANALISE, via
-- `derivarResponsabilidade`) e um evento `RESPONSABILIDADE_INVALIDADA` é
-- registrado — nunca silenciosamente mantém uma decisão que não reflete mais
-- os fatos.

-- ---------------------------------------------------------------------------
-- 1) closing_events: três tipos novos, aditivos (G_timeline).
-- ---------------------------------------------------------------------------

ALTER TABLE closing_events DROP CONSTRAINT closing_events_tipo_evento_check;
ALTER TABLE closing_events ADD CONSTRAINT closing_events_tipo_evento_check CHECK (tipo_evento IN (
  'EMPTY_RETURN', 'MINUTA_RECEBIDA', 'MINUTA_VALIDADA', 'MINUTA_REJEITADA',
  'DIVERGENCIA_TRACKING_MINUTA', 'RECALCULO', 'FECHAMENTO_FINAL',
  'REABERTURA_SOLICITADA', 'REABERTURA_AUTORIZADA', 'REABERTURA', 'REFECHAMENTO',
  'RESPONSABILIDADE_CONFIRMADA', 'RESPONSABILIDADE_CORRIGIDA', 'RESPONSABILIDADE_INVALIDADA'
));

-- ---------------------------------------------------------------------------
-- 2) Guarda de projeção em `containers` — só dispara quando as duas colunas
--    envolvidas são tocadas (INSERT sempre; UPDATE só quando estão no SET).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION containers_responsabilidade_projecao_guard() RETURNS TRIGGER AS $$
DECLARE
  vigente RECORD;
  st TEXT;
BEGIN
  -- Ambos NULL = estado derivado (sem decisão da Fase 11 ainda) — sempre ok.
  IF NEW.responsabilidade IS NULL AND NEW.responsabilidade_decisao_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.responsabilidade IS NULL OR NEW.responsabilidade_decisao_id IS NULL THEN
    RAISE EXCEPTION
      'PROJECAO_INCOMPATIVEL: containers.responsabilidade e responsabilidade_decisao_id tem que estar ambos NULL ou ambos preenchidos (container %)',
      NEW.id;
  END IF;

  SELECT id, status INTO vigente
    FROM responsabilidade_decisoes
   WHERE container_id = NEW.id
   ORDER BY versao DESC LIMIT 1;

  IF vigente.id IS NULL OR vigente.id <> NEW.responsabilidade_decisao_id THEN
    RAISE EXCEPTION
      'PROJECAO_INCOMPATIVEL: responsabilidade_decisao_id % nao e a decisao vigente do container % (vigente: %)',
      NEW.responsabilidade_decisao_id, NEW.id, vigente.id;
  END IF;

  IF NEW.responsabilidade <> vigente.status THEN
    RAISE EXCEPTION
      'PROJECAO_INCOMPATIVEL: containers.responsabilidade (%) difere do status da decisao vigente (%) no container %',
      NEW.responsabilidade, vigente.status, NEW.id;
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.responsabilidade IS DISTINCT FROM OLD.responsabilidade
                        OR NEW.responsabilidade_decisao_id IS DISTINCT FROM OLD.responsabilidade_decisao_id) THEN
    SELECT apuracao_status INTO st FROM processos WHERE id = NEW.processo_id;
    IF st = 'FINAL' THEN
      RAISE EXCEPTION
        'EXIGE_REABERTURA: processo FINAL — projecao de responsabilidade congelada (container %)', NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER containers_responsabilidade_projecao_guard
  BEFORE INSERT OR UPDATE OF responsabilidade, responsabilidade_decisao_id ON containers
  FOR EACH ROW EXECUTE FUNCTION containers_responsabilidade_projecao_guard();

-- ---------------------------------------------------------------------------
-- 3) Invalidação automática: quando um relógio é regravado com um input_hash
--    diferente do que sustentou a decisão vigente, a projeção volta a NULL
--    (== EM_ANALISE) e um evento fica registrado. Idempotente por tick: a
--    segunda linha de relógio regravada no MESMO recálculo encontra a
--    projeção já NULL e não repete o evento.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION responsabilidade_invalidar_por_relogio() RETURNS TRIGGER AS $$
DECLARE
  cont RECORD;
  vigente RECORD;
  hash_cliente_atual TEXT;
  hash_rocket_atual TEXT;
BEGIN
  SELECT id, responsabilidade_decisao_id INTO cont FROM containers WHERE id = NEW.container_id;
  IF cont.responsabilidade_decisao_id IS NULL THEN
    RETURN NULL; -- nada projetado (sem decisão, ou já invalidada neste mesmo ciclo).
  END IF;

  SELECT id, versao, base INTO vigente FROM responsabilidade_decisoes WHERE id = cont.responsabilidade_decisao_id;
  IF vigente.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT input_hash INTO hash_cliente_atual FROM relogios WHERE container_id = NEW.container_id AND tipo = 'cliente';
  SELECT input_hash INTO hash_rocket_atual FROM relogios WHERE container_id = NEW.container_id AND tipo = 'rocket';

  IF vigente.base->>'clienteInputHash' IS DISTINCT FROM hash_cliente_atual
     OR vigente.base->>'rocketInputHash' IS DISTINCT FROM hash_rocket_atual THEN
    UPDATE containers SET responsabilidade = NULL, responsabilidade_decisao_id = NULL WHERE id = NEW.container_id;
    INSERT INTO closing_events (processo_id, container_id, tipo_evento, origem, payload)
    SELECT c.processo_id, NEW.container_id, 'RESPONSABILIDADE_INVALIDADA', 'automatico',
           jsonb_build_object('decisaoId', vigente.id, 'versao', vigente.versao, 'motivo', 'relogio_recalculado')
      FROM containers c WHERE c.id = NEW.container_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER relogios_invalidar_responsabilidade
  AFTER INSERT OR UPDATE ON relogios
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_invalidar_por_relogio();
