-- Demurrage Engine V2 — migration ADITIVA (controle de capacidade da rota
-- HTTP do handoff — Entrega 1, adição estreita autorizada pelo usuário).
-- 0001-0046 NÃO são reescritas. Nenhuma linha existente é alterada.
--
-- Limita quantas requisições AUTENTICADAS a rota do handoff aceita, em duas
-- dimensões independentes, com estado DURÁVEL e COMPARTILHADO no PostgreSQL
-- (vale para qualquer número de instâncias da aplicação; nada em memória do
-- processo decide a admissão):
--   * por credencial  — um balde por credencial (`..._credenciais`);
--   * por organização — um balde por organização, somando todas as
--                       credenciais ativas dela (`..._organizacoes`).
-- Uma linha por credencial e uma por organização — nunca um histórico de
-- requisições (sem crescimento ilimitado).
--
-- Algoritmo (balde de fichas com reposição contínua, relógio = PostgreSQL):
--   taxa (fichas/s)        = limite_por_minuto / 60
--   fichas_agora           = trunc(least(rajada, fichas_salvas
--                              + greatest(0, segundos(agora - atualizado_em)) * taxa), 6)
--   admite                 se fichas_agora_credencial >= 1 E fichas_agora_organizacao >= 1;
--                          então as DUAS perdem exatamente 1 ficha;
--   rejeita (429)          caso contrário — NENHUMA das duas perde ficha;
--   espera_dimensão (s)    = (1 - fichas_agora) / taxa
--                            + max(0, segundos(atualizado_em - agora)), só para a dimensão
--                            que recusou (a 2ª parcela só é > 0 se o relógio do banco recuou:
--                            a reposição só recomeça em `atualizado_em`);
--   Retry-After            = greatest(1, ceil(max(espera_credencial, espera_organizacao)))
--                            (segundos inteiros, arredondado PARA CIMA — nunca cedo demais);
--   próximo permitido em   = agora + max(espera) segundos.
-- `trunc(..., 6)` arredonda as fichas PARA BAIXO na 6ª casa decimal — nunca
-- concede fração a mais do que o tempo decorrido justifica. Balde novo nasce
-- cheio (rajada). Rotação do segredo de uma credencial (`rotacionada_em`
-- muda) reinicia SÓ o balde daquela credencial, cheio; o da organização
-- continua o mesmo. A geração da credencial é lida DEPOIS do lock da
-- organização (que serializa todo escritor do balde da credencial) e só
-- avança: uma requisição que já estava em andamento durante a rotação nunca
-- reinicia o balde de novo nem devolve a geração antiga.
--
-- Atomicidade: tudo numa única chamada de função = uma única transação curta
-- (sem chamada externa). Ordem de lock DETERMINÍSTICA: a linha da
-- ORGANIZAÇÃO é travada (FOR UPDATE) ANTES de qualquer escrita no balde da
-- CREDENCIAL — duas credenciais da mesma organização se serializam na linha
-- da organização e nenhuma transação segura um lock que a outra espera.
-- `lock_timeout` local de 2 s: sob contenção extrema a chamada falha (a rota
-- responde 500 genérico, sem processar o handoff) em vez de prender a
-- conexão indefinidamente.

-- Falha rápido (e pode ser repetida) em vez de enfileirar o tráfego do
-- handoff atrás de um lock esperado indefinidamente: o ALTER abaixo pede
-- ACCESS EXCLUSIVE em `demurrage_handoff_credenciais` até o fim desta
-- transação do runner. Vale só para esta transação (`SET LOCAL`).
SET LOCAL lock_timeout = '5s';

-- Chave composta para a FK do balde de credencial: garante, NO BANCO, que o
-- balde de uma credencial só pode pertencer à organização dona dela (mesmo
-- padrão de `containers_id_org_unique`/`processos_id_org_unique`). `id` já é
-- PK, então a restrição nunca falha para dados existentes.
ALTER TABLE demurrage_handoff_credenciais
  ADD CONSTRAINT demurrage_handoff_credenciais_id_org_unique UNIQUE (id, organization_id);

CREATE TABLE demurrage_handoff_capacidade_organizacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id),
  fichas NUMERIC(14, 6) NOT NULL CHECK (fichas >= 0),
  atualizado_em TIMESTAMPTZ NOT NULL,
  admitidas_total BIGINT NOT NULL DEFAULT 0 CHECK (admitidas_total >= 0),
  rejeitadas_total BIGINT NOT NULL DEFAULT 0 CHECK (rejeitadas_total >= 0),
  ultima_rejeicao_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_handoff_capacidade_organizacoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TABLE demurrage_handoff_capacidade_credenciais (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credencial_id UUID NOT NULL UNIQUE,
  organization_id UUID NOT NULL,
  -- `coalesce(rotacionada_em, criado_em)` da credencial no último uso: quando
  -- muda (rotação do segredo), o balde recomeça cheio e independente.
  geracao_credencial TIMESTAMPTZ NOT NULL,
  fichas NUMERIC(14, 6) NOT NULL CHECK (fichas >= 0),
  atualizado_em TIMESTAMPTZ NOT NULL,
  admitidas_total BIGINT NOT NULL DEFAULT 0 CHECK (admitidas_total >= 0),
  rejeitadas_total BIGINT NOT NULL DEFAULT 0 CHECK (rejeitadas_total >= 0),
  ultima_rejeicao_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT demurrage_handoff_capacidade_credenciais_credencial_org_fk
    FOREIGN KEY (credencial_id, organization_id) REFERENCES demurrage_handoff_credenciais (id, organization_id),
  CONSTRAINT demurrage_handoff_capacidade_credenciais_org_fk
    FOREIGN KEY (organization_id) REFERENCES demurrage_handoff_capacidade_organizacoes (organization_id)
);

CREATE INDEX demurrage_handoff_capacidade_credenciais_org_idx
  ON demurrage_handoff_capacidade_credenciais (organization_id);

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_handoff_capacidade_credenciais
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE FUNCTION demurrage_handoff_capacidade_admitir(
  p_credencial_id UUID,
  p_organization_id UUID,
  p_credencial_por_minuto INTEGER,
  p_credencial_rajada INTEGER,
  p_organizacao_por_minuto INTEGER,
  p_organizacao_rajada INTEGER
) RETURNS TABLE (admitida BOOLEAN, dimensao TEXT, retry_after_segundos INTEGER, proximo_permitido_em TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE
  v_org_da_credencial UUID;
  v_geracao TIMESTAMPTZ;
  v_geracao_balde TIMESTAMPTZ;
  v_org RECORD;
  v_cred RECORD;
  v_agora TIMESTAMPTZ;
  v_taxa_cred NUMERIC;
  v_taxa_org NUMERIC;
  v_fichas_cred NUMERIC;
  v_fichas_org NUMERIC;
  v_espera_cred NUMERIC := 0;
  v_espera_org NUMERIC := 0;
  v_espera NUMERIC;
BEGIN
  IF p_credencial_por_minuto IS NULL OR p_credencial_por_minuto < 1
     OR p_credencial_rajada IS NULL OR p_credencial_rajada < 1
     OR p_organizacao_por_minuto IS NULL OR p_organizacao_por_minuto < 1
     OR p_organizacao_rajada IS NULL OR p_organizacao_rajada < 1 THEN
    RAISE EXCEPTION 'demurrage_handoff_capacidade_admitir: limites devem ser inteiros positivos';
  END IF;
  v_taxa_cred := p_credencial_por_minuto::NUMERIC / 60;
  v_taxa_org := p_organizacao_por_minuto::NUMERIC / 60;

  PERFORM set_config('lock_timeout', '2000ms', true);

  -- A organização do balde vem SEMPRE da própria credencial; o parâmetro só
  -- é conferido (defesa em profundidade) — nunca confiado. (`organization_id`
  -- da credencial é imutável, então pode ser lido antes dos locks.)
  SELECT c.organization_id INTO v_org_da_credencial
    FROM demurrage_handoff_credenciais c
   WHERE c.id = p_credencial_id;
  IF NOT FOUND OR v_org_da_credencial IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'demurrage_handoff_capacidade_admitir: credencial e organizacao inconsistentes';
  END IF;

  -- Baldes novos nascem cheios. Ordem FIXA: (1) garante e TRAVA a linha da
  -- organização; (2) só então garante e trava a linha da credencial. O
  -- INSERT do balde de credencial verifica a FK para o balde da organização
  -- e, com isso, pega KEY SHARE na linha da organização: se esse INSERT
  -- viesse antes do FOR UPDATE da organização, duas credenciais novas da
  -- mesma organização se bloqueariam mutuamente (KEY SHARE × FOR UPDATE =
  -- deadlock, provado pelo teste de alta concorrência). Com a organização já
  -- travada por esta transação, a FK só pede um lock que ela mesma detém.
  INSERT INTO demurrage_handoff_capacidade_organizacoes (organization_id, fichas, atualizado_em)
    VALUES (p_organization_id, p_organizacao_rajada, clock_timestamp())
    ON CONFLICT (organization_id) DO NOTHING;
  SELECT * INTO v_org FROM demurrage_handoff_capacidade_organizacoes
   WHERE organization_id = p_organization_id FOR UPDATE;

  -- Geração (rotação) lida SÓ DEPOIS do lock da organização: todo escritor
  -- do balde desta credencial passa por esse lock, e cada comando vê o que
  -- já foi commitado — as leituras da geração ficam em ordem. Lida antes,
  -- uma requisição que esperou o lock durante uma rotação traria a geração
  -- antiga e reiniciaria o balde (rajada extra).
  SELECT coalesce(c.rotacionada_em, c.criado_em) INTO v_geracao
    FROM demurrage_handoff_credenciais c
   WHERE c.id = p_credencial_id;

  INSERT INTO demurrage_handoff_capacidade_credenciais (credencial_id, organization_id, geracao_credencial, fichas, atualizado_em)
    VALUES (p_credencial_id, p_organization_id, v_geracao, p_credencial_rajada, clock_timestamp())
    ON CONFLICT (credencial_id) DO NOTHING;
  SELECT * INTO v_cred FROM demurrage_handoff_capacidade_credenciais
   WHERE credencial_id = p_credencial_id FOR UPDATE;

  -- Relógio do PostgreSQL, lido DEPOIS de obter os dois locks.
  v_agora := clock_timestamp();

  v_fichas_org := trunc(least(p_organizacao_rajada::NUMERIC,
    v_org.fichas + greatest(0, extract(epoch FROM (v_agora - v_org.atualizado_em))::NUMERIC) * v_taxa_org), 6);
  -- Geração só avança (defesa em profundidade): reinicia apenas se a lida é
  -- POSTERIOR à gravada; nunca grava uma geração anterior.
  v_geracao_balde := greatest(v_cred.geracao_credencial, v_geracao);
  IF v_geracao > v_cred.geracao_credencial THEN
    v_fichas_cred := p_credencial_rajada;  -- rotação: balde novo e independente
  ELSE
    v_fichas_cred := trunc(least(p_credencial_rajada::NUMERIC,
      v_cred.fichas + greatest(0, extract(epoch FROM (v_agora - v_cred.atualizado_em))::NUMERIC) * v_taxa_cred), 6);
  END IF;

  IF v_fichas_cred >= 1 AND v_fichas_org >= 1 THEN
    UPDATE demurrage_handoff_capacidade_organizacoes
       SET fichas = v_fichas_org - 1, atualizado_em = greatest(v_org.atualizado_em, v_agora),
           admitidas_total = admitidas_total + 1
     WHERE organization_id = p_organization_id;
    UPDATE demurrage_handoff_capacidade_credenciais
       SET fichas = v_fichas_cred - 1, atualizado_em = greatest(v_cred.atualizado_em, v_agora),
           geracao_credencial = v_geracao_balde, admitidas_total = admitidas_total + 1
     WHERE credencial_id = p_credencial_id;
    RETURN QUERY SELECT true, NULL::TEXT, NULL::INTEGER, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- A reposição só recomeça em `atualizado_em`: se ele estiver à frente de
  -- `agora` (relógio do banco recuou), a espera inclui essa diferença.
  IF v_fichas_cred < 1 THEN
    v_espera_cred := (1 - v_fichas_cred) / v_taxa_cred + greatest(0, extract(epoch FROM (v_cred.atualizado_em - v_agora))::NUMERIC);
  END IF;
  IF v_fichas_org < 1 THEN
    v_espera_org := (1 - v_fichas_org) / v_taxa_org + greatest(0, extract(epoch FROM (v_org.atualizado_em - v_agora))::NUMERIC);
  END IF;
  v_espera := greatest(v_espera_cred, v_espera_org);

  -- Recusa: nenhuma das duas perde ficha. Só materializa a reposição já
  -- acumulada (equivalente matemático) e conta a recusa na(s) dimensão(ões)
  -- que recusou(aram).
  UPDATE demurrage_handoff_capacidade_organizacoes
     SET fichas = v_fichas_org, atualizado_em = greatest(v_org.atualizado_em, v_agora),
         rejeitadas_total = rejeitadas_total + CASE WHEN v_fichas_org < 1 THEN 1 ELSE 0 END,
         ultima_rejeicao_em = CASE WHEN v_fichas_org < 1 THEN v_agora ELSE ultima_rejeicao_em END
   WHERE organization_id = p_organization_id;
  UPDATE demurrage_handoff_capacidade_credenciais
     SET fichas = v_fichas_cred, atualizado_em = greatest(v_cred.atualizado_em, v_agora),
         geracao_credencial = v_geracao_balde,
         rejeitadas_total = rejeitadas_total + CASE WHEN v_fichas_cred < 1 THEN 1 ELSE 0 END,
         ultima_rejeicao_em = CASE WHEN v_fichas_cred < 1 THEN v_agora ELSE ultima_rejeicao_em END
   WHERE credencial_id = p_credencial_id;

  RETURN QUERY SELECT
    false,
    CASE WHEN v_espera_cred >= v_espera_org THEN 'credencial' ELSE 'organizacao' END,
    greatest(1, ceil(v_espera))::INTEGER,
    v_agora + v_espera * INTERVAL '1 second';
END;
$$;
