-- Demurrage Engine V2 — Fase D11 v1.1 (corretiva, aditiva). 0001-0032 não são
-- reescritas — as funções de trigger criadas na 0031 são substituídas via
-- CREATE OR REPLACE (mesma convenção da 0007/0009 para forbid_organization_
-- change) e um único trigger obsoleto é removido; nenhuma tabela é alterada.
--
-- Corretiva 1 — NAO_APLICAVEL restrito a um universo bem definido: relógio do
--   cliente OK e ZERO dias; relógio Rocket OK e POSITIVO; os dois relógios
--   FECHADOS na devolução efetiva; House e Master Free Time DETERMINÁVEIS;
--   House > Master. Sem isso, "exposição da Rocket" nunca é, por si só,
--   diferença comercial de Free Time — vira SEM_APURACAO_DETERMINAVEL,
--   INTERVALO_ABERTO ou NAO_APLICAVEL_INVALIDO (ver decidirResponsabilidade.ts
--   para os mesmos códigos no serviço).
--
-- Corretiva 2 — cobertura completa mesmo sem NENHUMA linha de dia: a
--   restrição adiada da 0031 estava ligada a `responsabilidade_decisao_dias`
--   (AFTER INSERT ... FOR EACH ROW) — uma decisão sem nenhuma linha de dia
--   simplesmente não disparava nada. Agora a MESMA verificação (contagem por
--   lado batendo com dias_rocket/dias_cliente; cobertura completa do relógio
--   do cliente em RELOGIO_CLIENTE) é uma restrição adiada em
--   `responsabilidade_decisoes` (AFTER INSERT, por decisão), que sempre
--   dispara — com ou sem linha de dia.
--
-- Corretiva 3 — a base financeira da decisão fica versionada dentro de
--   `base.valorCliente` (id, input_hash, motor, tabela, versão, total, moeda,
--   hash das faixas — gravado pelo serviço, sem alteração de schema). Um novo
--   trigger em `valores_apurados` invalida a decisão vigente quando o valor
--   ATIVO do cliente muda — mesmo que o relógio não tenha mudado (nunca só o
--   hash do relógio decide alteração tarifária). A exposição da Rocket ao
--   armador (relogio_tipo = 'rocket') nunca invalida a divisão do cliente.

-- ---------------------------------------------------------------------------
-- Corretiva 1: NAO_APLICAVEL restrito (substitui a função de validação da
-- 0031 por completo — mesmo corpo + o ramo NAO_APLICAVEL ampliado).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION responsabilidade_decisao_valida_insercao() RETURNS TRIGGER AS $$
DECLARE
  st TEXT;
  papel_atual organization_role;
  rel_cliente RECORD;
  rel_rocket RECORD;
  devolucao DATE;
  versao_atual INTEGER;
  decisao_atual_id UUID;
  house_ft INTEGER;
  master_ft INTEGER;
BEGIN
  SELECT apuracao_status INTO st FROM processos WHERE id = NEW.processo_id FOR SHARE;
  IF st IS NULL THEN
    RAISE EXCEPTION 'EXIGE_REABERTURA: processo % nao encontrado', NEW.processo_id;
  END IF;
  IF st = 'FINAL' THEN
    RAISE EXCEPTION 'EXIGE_REABERTURA: processo % esta FINAL', NEW.processo_id;
  END IF;

  SELECT papel INTO papel_atual FROM organization_memberships WHERE id = NEW.autor_membership_id FOR SHARE;
  IF papel_atual IS NULL OR papel_atual <> NEW.autor_papel::organization_role THEN
    RAISE EXCEPTION 'AUTOR_NAO_AUTORIZADO: membership % nao tem papel % agora', NEW.autor_membership_id, NEW.autor_papel;
  END IF;

  SELECT COALESCE(effective_return_date, tracking_return_date), house_free_time_days, master_free_time_days
    INTO devolucao, house_ft, master_ft
    FROM containers WHERE id = NEW.container_id FOR SHARE;
  IF devolucao IS NULL THEN
    RAISE EXCEPTION 'ANTES_DA_DEVOLUCAO: container % ainda sem devolucao efetiva', NEW.container_id;
  END IF;

  SELECT estado, dias_demurrage, data_final_apuracao INTO rel_cliente
    FROM relogios WHERE container_id = NEW.container_id AND tipo = 'cliente';
  SELECT estado, dias_demurrage, data_final_apuracao INTO rel_rocket
    FROM relogios WHERE container_id = NEW.container_id AND tipo = 'rocket';

  IF NEW.base_relogio = 'RELOGIO_CLIENTE' THEN
    IF rel_cliente IS NULL OR rel_cliente.estado <> 'OK' OR COALESCE(rel_cliente.dias_demurrage, 0) < 1 THEN
      RAISE EXCEPTION 'BASE_RELOGIO_INVALIDA: relogio cliente sem dias OK para container %', NEW.container_id;
    END IF;
    IF rel_cliente.data_final_apuracao IS DISTINCT FROM devolucao THEN
      RAISE EXCEPTION 'INTERVALO_ABERTO: relogio cliente ainda nao fechado na devolucao (container %)', NEW.container_id;
    END IF;
  ELSIF NEW.base_relogio = 'RELOGIO_ROCKET' THEN
    IF rel_cliente IS NOT NULL AND rel_cliente.estado = 'OK' AND COALESCE(rel_cliente.dias_demurrage, 0) >= 1 THEN
      RAISE EXCEPTION 'BASE_RELOGIO_INVALIDA: relogio cliente tem dias — base deve ser RELOGIO_CLIENTE (container %)', NEW.container_id;
    END IF;
    IF rel_rocket IS NULL OR rel_rocket.estado <> 'OK' OR COALESCE(rel_rocket.dias_demurrage, 0) < 1 THEN
      RAISE EXCEPTION 'BASE_RELOGIO_INVALIDA: relogio rocket sem dias OK para container %', NEW.container_id;
    END IF;
    IF rel_rocket.data_final_apuracao IS DISTINCT FROM devolucao THEN
      RAISE EXCEPTION 'INTERVALO_ABERTO: relogio rocket ainda nao fechado na devolucao (container %)', NEW.container_id;
    END IF;
  ELSE -- NAO_APLICAVEL (v1.1 — corretiva 1: universo estritamente restrito)
    IF rel_cliente IS NULL OR rel_cliente.estado <> 'OK' THEN
      RAISE EXCEPTION 'SEM_APURACAO_DETERMINAVEL: relogio cliente nao OK — NAO_APLICAVEL exige zero dias DETERMINADOS (container %)', NEW.container_id;
    END IF;
    IF COALESCE(rel_cliente.dias_demurrage, 0) >= 1 THEN
      RAISE EXCEPTION 'BASE_RELOGIO_INVALIDA: relogio cliente tem dias — NAO_APLICAVEL nao se aplica (container %)', NEW.container_id;
    END IF;
    IF rel_cliente.data_final_apuracao IS DISTINCT FROM devolucao THEN
      RAISE EXCEPTION 'INTERVALO_ABERTO: relogio cliente ainda nao fechado (NAO_APLICAVEL, container %)', NEW.container_id;
    END IF;
    IF rel_rocket IS NULL OR rel_rocket.estado <> 'OK' THEN
      RAISE EXCEPTION 'NAO_APLICAVEL_INVALIDO: relogio rocket pendente ou invalido (container %)', NEW.container_id;
    END IF;
    IF COALESCE(rel_rocket.dias_demurrage, 0) < 1 THEN
      RAISE EXCEPTION 'NAO_APLICAVEL_INVALIDO: ambos os relogios com zero dias (container %)', NEW.container_id;
    END IF;
    IF rel_rocket.data_final_apuracao IS DISTINCT FROM devolucao THEN
      RAISE EXCEPTION 'INTERVALO_ABERTO: relogio rocket ainda nao fechado (NAO_APLICAVEL, container %)', NEW.container_id;
    END IF;
    IF house_ft IS NULL OR master_ft IS NULL THEN
      RAISE EXCEPTION 'NAO_APLICAVEL_INVALIDO: free time indeterminavel (container %)', NEW.container_id;
    END IF;
    IF NOT (house_ft > master_ft) THEN
      RAISE EXCEPTION 'NAO_APLICAVEL_INVALIDO: house free time (%) nao e maior que o master (%) (container %)', house_ft, master_ft, NEW.container_id;
    END IF;
  END IF;

  SELECT versao, id INTO versao_atual, decisao_atual_id
    FROM responsabilidade_decisoes WHERE container_id = NEW.container_id
    ORDER BY versao DESC LIMIT 1 FOR UPDATE;
  IF versao_atual IS NULL THEN
    IF NEW.versao <> 1 THEN
      RAISE EXCEPTION 'VERSAO_DESATUALIZADA: primeira decisao do container % precisa ser versao 1', NEW.container_id;
    END IF;
  ELSE
    IF NEW.versao <> versao_atual + 1 OR NEW.substitui_decisao_id IS DISTINCT FROM decisao_atual_id THEN
      RAISE EXCEPTION 'VERSAO_DESATUALIZADA: versao vigente do container % e %, decisao precisa substitui-la', NEW.container_id, versao_atual;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Corretiva 2: cobertura completa disparada pela PRÓPRIA decisão, não só
-- pelas linhas de dia — cobre o caso de uma decisão sem NENHUMA linha.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS responsabilidade_decisao_dias_cobertura ON responsabilidade_decisao_dias;

CREATE OR REPLACE FUNCTION responsabilidade_decisao_cobertura_completa_por_decisao() RETURNS TRIGGER AS $$
DECLARE
  contagem_rocket INTEGER;
  contagem_cliente INTEGER;
  dias_relogio_cliente INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE lado = 'ROCKET'), count(*) FILTER (WHERE lado = 'CLIENTE')
    INTO contagem_rocket, contagem_cliente
    FROM responsabilidade_decisao_dias WHERE decisao_id = NEW.id;

  IF contagem_rocket <> NEW.dias_rocket OR contagem_cliente <> NEW.dias_cliente THEN
    RAISE EXCEPTION 'LACUNA: dias gravados (rocket=%, cliente=%) nao batem com a decisao % (rocket=%, cliente=%)',
      contagem_rocket, contagem_cliente, NEW.id, NEW.dias_rocket, NEW.dias_cliente;
  END IF;

  IF NEW.base_relogio = 'RELOGIO_CLIENTE' THEN
    SELECT dias_demurrage INTO dias_relogio_cliente FROM relogios
      WHERE container_id = NEW.container_id AND tipo = 'cliente';
    IF (contagem_rocket + contagem_cliente) <> dias_relogio_cliente THEN
      RAISE EXCEPTION 'LACUNA: decisao % cobre % dia(s) mas o relogio cliente tem % dia(s) de demurrage',
        NEW.id, contagem_rocket + contagem_cliente, dias_relogio_cliente;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Dispara SEMPRE (0 ou mais linhas de dia já podem existir na mesma
-- transação, já que a decisão é inserida ANTES dos dias pelo serviço — a
-- restrição é ADIADA para o COMMIT, quando todas as linhas já foram gravadas).
CREATE CONSTRAINT TRIGGER responsabilidade_decisoes_cobertura
  AFTER INSERT ON responsabilidade_decisoes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_cobertura_completa_por_decisao();

-- ---------------------------------------------------------------------------
-- Corretiva 3: invalidação por mudança no valor ATIVO do cliente — nunca só
-- pelo hash do relógio. Só reage a `relogio_tipo = 'cliente'`: a exposição da
-- Rocket ao armador nunca invalida a divisão financeira do cliente.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION responsabilidade_invalidar_por_valor() RETURNS TRIGGER AS $$
DECLARE
  cont RECORD;
  vigente RECORD;
  valor_cliente_id_salvo TEXT;
BEGIN
  SELECT id, responsabilidade_decisao_id INTO cont FROM containers WHERE id = NEW.container_id;
  IF cont.responsabilidade_decisao_id IS NULL THEN
    RETURN NULL; -- nada projetado (sem decisão, ou já invalidada).
  END IF;

  SELECT id, versao, base, base_relogio INTO vigente FROM responsabilidade_decisoes WHERE id = cont.responsabilidade_decisao_id;
  IF vigente.id IS NULL OR vigente.base_relogio <> 'RELOGIO_CLIENTE' THEN
    RETURN NULL; -- só existe valor comercial do cliente a versionar em RELOGIO_CLIENTE.
  END IF;

  valor_cliente_id_salvo := vigente.base#>>'{valorCliente,id}';
  -- O valor ATIVO do cliente que sustentou a decisão mudou (novo id — o
  -- registro é idempotente por hash: se o hash não mudou, nenhuma linha nova
  -- é inserida e este trigger nem dispara).
  IF valor_cliente_id_salvo IS DISTINCT FROM NEW.id::text THEN
    UPDATE containers SET responsabilidade = NULL, responsabilidade_decisao_id = NULL WHERE id = NEW.container_id;
    INSERT INTO closing_events (processo_id, container_id, tipo_evento, origem, payload)
    SELECT c.processo_id, NEW.container_id, 'RESPONSABILIDADE_INVALIDADA', 'automatico',
           jsonb_build_object('decisaoId', vigente.id, 'versao', vigente.versao, 'motivo', 'VALOR_CLIENTE_RECALCULADO')
      FROM containers c WHERE c.id = NEW.container_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER valores_apurados_invalidar_responsabilidade
  AFTER INSERT ON valores_apurados
  FOR EACH ROW WHEN (NEW.relogio_tipo = 'cliente' AND NEW.calculation_status IN ('OPEN', 'FINAL'))
  EXECUTE FUNCTION responsabilidade_invalidar_por_valor();
