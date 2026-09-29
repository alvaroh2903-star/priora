-- Demurrage Engine V2 — Fase D11 (Gates G1-G3): decisão de Responsabilidade
-- Rocket × Cliente, versionada e auditável. 0001-0030 não são reescritas.
--
-- Contrato aprovado (não é tela nem rota pública — só o serviço da aplicação
-- grava aqui; ver `responsabilidade/decidirResponsabilidade.ts`):
--
--  - Fonte de verdade: `responsabilidade_decisoes` é APPEND-ONLY (nunca
--    UPDATE/DELETE). Uma correção nasce como uma NOVA VERSÃO que aponta para a
--    anterior via `substitui_decisao_id`; a versão anterior nunca é apagada
--    nem reescrita — só deixa de ser a vigente (a vigente é sempre a de maior
--    `versao` para aquele `container_id`).
--  - Dois universos temporais possíveis (nunca misturados numa decisão):
--     `RELOGIO_CLIENTE` (dias cobrados do cliente existem — é a base da
--     distribuição Rocket × cliente) ou `RELOGIO_ROCKET` (cliente zero, só a
--     exposição da Rocket tem dias — Rocket só responde com períodos
--     concretos dentro do intervalo real do relógio Rocket) ou
--     `NAO_APLICAVEL` (diferença comercial de Free Time, sem demurrage
--     operacional a distribuir).
--  - Coerência status × base × dias × motivo é um CHECK (não é regra só de
--    aplicação): ver `responsabilidade_decisoes_coerencia_check`.
--  - Valor financeiro: incide SOMENTE sobre o valor comercial do cliente
--    (RELOGIO_CLIENTE); a exposição da Rocket ao armador nunca é dividida,
--    nunca é copiada para `valor_rocket`/`valor_cliente` e nunca é alterada
--    por esta tabela. Em RELOGIO_ROCKET/NAO_APLICAVEL não há valor a apurar
--    aqui — `valor_status = 'NAO_APLICAVEL'`.
--  - Cada dia atribuído mora em `responsabilidade_decisao_dias` (granularidade
--    de dia, PK (decisao_id, dia) — impede duplicata/sobreposição do MESMO
--    dia na MESMA decisão por construção). `responsabilidade_decisao_periodos`
--    guarda os períodos DECLARADOS pelo Gestor (a forma como ele justificou a
--    atribuição); os dias são a EXPANSÃO granular desses períodos.
--  - Autoria: só MANAGER/ADMIN (lido com FOR SHARE — mesmo padrão da 0007).
--  - Timing: processo não pode estar FINAL (exige reabertura); o intervalo de
--    apuração do relógio-base tem que estar FECHADO (data_final_apuracao do
--    relógio-base == devolução efetiva do contêiner) — nunca uma decisão
--    antes da devolução.
--
-- Proteção em profundidade (item 6 aprovado): o trigger de INSERT valida
-- autoridade, estado do processo, coerência com o relógio-base e sequência de
-- versão; um trigger de restrição ADIADA (constraint trigger) valida, no
-- COMMIT, que os dias gravados batem exatamente com dias_rocket/dias_cliente
-- e (quando RELOGIO_CLIENTE) cobrem TODO o relógio do cliente sem buraco.

-- ---------------------------------------------------------------------------
-- 1) responsabilidade_decisoes
-- ---------------------------------------------------------------------------

CREATE TABLE responsabilidade_decisoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL REFERENCES processos(id),
  container_id UUID NOT NULL REFERENCES containers(id),
  versao INTEGER NOT NULL CHECK (versao >= 1),

  status TEXT NOT NULL CHECK (status IN (
    'CONFIRMADA_ROCKET', 'CONFIRMADA_CLIENTE', 'DIVIDIDA', 'NAO_APLICAVEL'
  )),
  motivo_estruturado TEXT CHECK (motivo_estruturado IS NULL OR motivo_estruturado IN (
    'DIFERENCA_COMERCIAL_FREE_TIME'
  )),
  base_relogio TEXT NOT NULL CHECK (base_relogio IN (
    'RELOGIO_CLIENTE', 'RELOGIO_ROCKET', 'NAO_APLICAVEL'
  )),

  dias_rocket INTEGER NOT NULL CHECK (dias_rocket >= 0),
  dias_cliente INTEGER NOT NULL CHECK (dias_cliente >= 0),

  -- Só preenchido quando base_relogio = RELOGIO_CLIENTE (única base com valor
  -- comercial do cliente a distribuir). CALCULADO exige os três preenchidos e
  -- coerentes (valor_rocket + valor_cliente = valor total do relógio cliente,
  -- validado pelo serviço antes do INSERT); INDISPONIVEL = tarifa do cliente
  -- não permitiu apurar o valor por dia (dias ficam registrados mesmo assim).
  valor_status TEXT NOT NULL CHECK (valor_status IN ('CALCULADO', 'INDISPONIVEL', 'NAO_APLICAVEL')),
  valor_rocket NUMERIC(14,2),
  valor_cliente NUMERIC(14,2),
  moeda TEXT,

  -- Retrato do(s) relógio(s) usados como base no momento da decisão (dias,
  -- data_final_apuracao, input_hash) — usado para detectar decisão
  -- desatualizada quando o relógio muda depois (gatilho de invalidação, 0032).
  base JSONB NOT NULL,
  base_hash TEXT NOT NULL,

  justificativa TEXT NOT NULL CHECK (length(btrim(justificativa)) > 0),
  evidencia_ref TEXT NOT NULL CHECK (length(btrim(evidencia_ref)) > 0),

  autor_membership_id UUID NOT NULL,
  autor_papel TEXT NOT NULL CHECK (autor_papel IN ('MANAGER', 'ADMIN')),
  decidido_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  substitui_decisao_id UUID REFERENCES responsabilidade_decisoes(id),
  motivo_correcao TEXT,

  reabertura_id UUID REFERENCES reaberturas(id),

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT responsabilidade_decisoes_container_versao_unique UNIQUE (container_id, versao),
  CONSTRAINT responsabilidade_decisoes_substitui_unique UNIQUE (substitui_decisao_id),
  CONSTRAINT responsabilidade_decisoes_id_org_unique UNIQUE (id, organization_id),

  -- Composição FK: processo/container/autor têm que pertencer à MESMA organização.
  CONSTRAINT responsabilidade_decisoes_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT responsabilidade_decisoes_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id),
  CONSTRAINT responsabilidade_decisoes_container_processo_fk FOREIGN KEY (container_id, processo_id)
    REFERENCES containers (id, processo_id),
  CONSTRAINT responsabilidade_decisoes_autor_org_fk FOREIGN KEY (autor_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),

  -- Versão 1 nunca substitui nem tem motivo de correção; versão > 1 sempre
  -- substitui uma anterior e sempre declara por quê.
  CONSTRAINT responsabilidade_decisoes_versionamento_check CHECK (
    (versao = 1 AND substitui_decisao_id IS NULL AND motivo_correcao IS NULL)
    OR (versao > 1 AND substitui_decisao_id IS NOT NULL
        AND motivo_correcao IS NOT NULL AND length(btrim(motivo_correcao)) > 0)
  ),

  -- Coerência status × base × dias × motivo estruturado (ajustes aprovados 1-2):
  --  - CONFIRMADA_CLIENTE: só existe no relógio do cliente; 0 dias Rocket.
  --  - CONFIRMADA_ROCKET: relógio do cliente (Rocket causou o atraso de dias
  --    do cliente) OU relógio Rocket (atraso comprovado só na exposição,
  --    caso A) — nunca sem dias Rocket concretos.
  --  - DIVIDIDA: só no relógio do cliente, com dias dos dois lados.
  --  - NAO_APLICAVEL: só por diferença comercial de Free Time — sem relógio
  --    operacional, sem dias, motivo estruturado obrigatório.
  CONSTRAINT responsabilidade_decisoes_coerencia_check CHECK (
    (status = 'CONFIRMADA_CLIENTE' AND base_relogio = 'RELOGIO_CLIENTE'
       AND dias_rocket = 0 AND dias_cliente >= 1 AND motivo_estruturado IS NULL)
    OR (status = 'CONFIRMADA_ROCKET' AND base_relogio IN ('RELOGIO_CLIENTE', 'RELOGIO_ROCKET')
       AND dias_rocket >= 1 AND dias_cliente = 0 AND motivo_estruturado IS NULL)
    OR (status = 'DIVIDIDA' AND base_relogio = 'RELOGIO_CLIENTE'
       AND dias_rocket >= 1 AND dias_cliente >= 1 AND motivo_estruturado IS NULL)
    OR (status = 'NAO_APLICAVEL' AND base_relogio = 'NAO_APLICAVEL'
       AND dias_rocket = 0 AND dias_cliente = 0
       AND motivo_estruturado = 'DIFERENCA_COMERCIAL_FREE_TIME')
  ),

  -- Valor financeiro só existe (e só pode existir) na base RELOGIO_CLIENTE —
  -- é o único universo com valor comercial do cliente a distribuir (ajuste 3:
  -- a exposição da Rocket ao armador nunca entra aqui, nunca é dividida).
  CONSTRAINT responsabilidade_decisoes_valor_coerencia_check CHECK (
    (base_relogio = 'RELOGIO_CLIENTE' AND valor_status IN ('CALCULADO', 'INDISPONIVEL')
       AND (valor_status = 'INDISPONIVEL'
            OR (valor_rocket IS NOT NULL AND valor_cliente IS NOT NULL AND moeda IS NOT NULL)))
    OR (base_relogio IN ('RELOGIO_ROCKET', 'NAO_APLICAVEL') AND valor_status = 'NAO_APLICAVEL'
       AND valor_rocket IS NULL AND valor_cliente IS NULL AND moeda IS NULL)
  )
);

CREATE INDEX responsabilidade_decisoes_container_idx ON responsabilidade_decisoes (container_id, versao DESC);
CREATE INDEX responsabilidade_decisoes_processo_idx ON responsabilidade_decisoes (processo_id);
CREATE INDEX responsabilidade_decisoes_org_idx ON responsabilidade_decisoes (organization_id);

CREATE TRIGGER responsabilidade_decisoes_append_only
  BEFORE UPDATE OR DELETE ON responsabilidade_decisoes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON responsabilidade_decisoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 2) Gatilho de INSERT: autoridade, estado do processo, coerência com o
--    relógio-base, intervalo fechado e sequência de versão. Roda ANTES do
--    INSERT de cada decisão — proteção em profundidade além da validação da
--    aplicação (que já checa tudo isto antes de tentar o INSERT).
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
BEGIN
  -- Processo FINAL: qualquer decisão nova exige reabertura autorizada primeiro
  -- (o processo precisa estar OPEN quando a decisão é inserida).
  SELECT apuracao_status INTO st FROM processos WHERE id = NEW.processo_id FOR SHARE;
  IF st IS NULL THEN
    RAISE EXCEPTION 'EXIGE_REABERTURA: processo % nao encontrado', NEW.processo_id;
  END IF;
  IF st = 'FINAL' THEN
    RAISE EXCEPTION 'EXIGE_REABERTURA: processo % esta FINAL', NEW.processo_id;
  END IF;

  -- Autoridade: o membership autor precisa ter, HOJE, o papel declarado na
  -- decisão, e esse papel precisa ser MANAGER/ADMIN (já garantido pelo CHECK
  -- de coluna; aqui confirmamos que bate com o papel ATUAL do membership).
  SELECT papel INTO papel_atual FROM organization_memberships WHERE id = NEW.autor_membership_id FOR SHARE;
  IF papel_atual IS NULL OR papel_atual <> NEW.autor_papel::organization_role THEN
    RAISE EXCEPTION 'AUTOR_NAO_AUTORIZADO: membership % nao tem papel % agora', NEW.autor_membership_id, NEW.autor_papel;
  END IF;

  -- Contêiner devolvido: devolução efetiva (effective_return_date senão
  -- tracking_return_date) precisa existir — nunca decisão antes da devolução.
  SELECT COALESCE(effective_return_date, tracking_return_date) INTO devolucao
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
  ELSE -- NAO_APLICAVEL
    IF rel_cliente IS NOT NULL AND rel_cliente.estado = 'OK' AND COALESCE(rel_cliente.dias_demurrage, 0) >= 1 THEN
      RAISE EXCEPTION 'BASE_RELOGIO_INVALIDA: relogio cliente tem dias — NAO_APLICAVEL nao se aplica (container %)', NEW.container_id;
    END IF;
  END IF;

  -- Sequência de versão: 1a decisão do contêiner => versao=1, sem substitui;
  -- correção => versao = vigente+1 e substitui = decisão vigente (a de maior
  -- versão), nunca outra.
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

CREATE TRIGGER responsabilidade_decisoes_validar_insercao
  BEFORE INSERT ON responsabilidade_decisoes
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_valida_insercao();

-- ---------------------------------------------------------------------------
-- 3) responsabilidade_decisao_periodos — períodos DECLARADOS pelo Gestor.
-- ---------------------------------------------------------------------------

CREATE TABLE responsabilidade_decisao_periodos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  decisao_id UUID NOT NULL REFERENCES responsabilidade_decisoes(id),
  lado TEXT NOT NULL CHECK (lado IN ('ROCKET', 'CLIENTE')),
  inicio DATE NOT NULL,
  fim DATE NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT responsabilidade_decisao_periodos_intervalo_check CHECK (fim >= inicio),
  CONSTRAINT responsabilidade_decisao_periodos_decisao_org_fk FOREIGN KEY (decisao_id, organization_id)
    REFERENCES responsabilidade_decisoes (id, organization_id)
);

CREATE INDEX responsabilidade_decisao_periodos_decisao_idx ON responsabilidade_decisao_periodos (decisao_id);

CREATE TRIGGER responsabilidade_decisao_periodos_append_only
  BEFORE UPDATE OR DELETE ON responsabilidade_decisao_periodos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON responsabilidade_decisao_periodos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4) responsabilidade_decisao_dias — expansão granular (1 linha por dia).
--    PK (decisao_id, dia) impede, por construção, duplicata/sobreposição do
--    MESMO dia na MESMA decisão (G9 — "data fora do relógio" e sobreposição).
-- ---------------------------------------------------------------------------

CREATE TABLE responsabilidade_decisao_dias (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  decisao_id UUID NOT NULL REFERENCES responsabilidade_decisoes(id),
  dia DATE NOT NULL,
  lado TEXT NOT NULL CHECK (lado IN ('ROCKET', 'CLIENTE')),
  -- Posição cronológica (1-based) do dia dentro do relógio-base (cliente ou
  -- rocket) — usada para expandir a diária conservando a faixa tarifária
  -- ORIGINAL do cliente (ajuste 3: nenhuma faixa reinicia).
  posicao INTEGER NOT NULL CHECK (posicao >= 1),
  faixa_inicio INTEGER,
  faixa_fim INTEGER,
  valor_dia NUMERIC(12,2),
  moeda TEXT,
  PRIMARY KEY (decisao_id, dia),
  CONSTRAINT responsabilidade_decisao_dias_decisao_org_fk FOREIGN KEY (decisao_id, organization_id)
    REFERENCES responsabilidade_decisoes (id, organization_id)
);

CREATE INDEX responsabilidade_decisao_dias_decisao_idx ON responsabilidade_decisao_dias (decisao_id);

CREATE TRIGGER responsabilidade_decisao_dias_append_only
  BEFORE UPDATE OR DELETE ON responsabilidade_decisao_dias
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON responsabilidade_decisao_dias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Cada dia declarado precisa estar DENTRO do intervalo real do relógio-base
-- daquela decisão (G9): checa contra o(s) período(s) declarados da MESMA
-- decisão E, quando RELOGIO_ROCKET, contra o intervalo do relógio Rocket.
CREATE OR REPLACE FUNCTION responsabilidade_decisao_dia_dentro_da_base() RETURNS TRIGGER AS $$
DECLARE
  dec RECORD;
  primeiro_dia DATE;
  ultimo_dia DATE;
BEGIN
  SELECT base_relogio, container_id INTO dec FROM responsabilidade_decisoes WHERE id = NEW.decisao_id;
  IF dec.base_relogio = 'RELOGIO_CLIENTE' THEN
    SELECT primeiro_dia_demurrage, data_final_apuracao INTO primeiro_dia, ultimo_dia
      FROM relogios WHERE container_id = dec.container_id AND tipo = 'cliente';
  ELSE
    SELECT primeiro_dia_demurrage, data_final_apuracao INTO primeiro_dia, ultimo_dia
      FROM relogios WHERE container_id = dec.container_id AND tipo = 'rocket';
  END IF;
  IF primeiro_dia IS NULL OR NEW.dia < primeiro_dia OR NEW.dia > ultimo_dia THEN
    RAISE EXCEPTION 'DIA_FORA_DA_BASE: dia % fora do intervalo do relogio-base (% a %) da decisao %',
      NEW.dia, primeiro_dia, ultimo_dia, NEW.decisao_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER responsabilidade_decisao_dias_dentro_da_base
  BEFORE INSERT ON responsabilidade_decisao_dias
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_dia_dentro_da_base();

-- Restrição ADIADA (ao COMMIT da transação): os dias gravados batem
-- exatamente com dias_rocket/dias_cliente da decisão e, quando
-- RELOGIO_CLIENTE, cobrem TODO O RELÓGIO do cliente (nenhum buraco, nenhum
-- dia fora da decisão) — G1/G2/G3 (a decisão só "fecha" se a soma bater).
CREATE OR REPLACE FUNCTION responsabilidade_decisao_cobertura_completa() RETURNS TRIGGER AS $$
DECLARE
  dec RECORD;
  contagem_rocket INTEGER;
  contagem_cliente INTEGER;
  dias_relogio_cliente INTEGER;
BEGIN
  SELECT id, base_relogio, dias_rocket, dias_cliente, container_id INTO dec
    FROM responsabilidade_decisoes WHERE id = NEW.decisao_id;

  SELECT count(*) FILTER (WHERE lado = 'ROCKET'), count(*) FILTER (WHERE lado = 'CLIENTE')
    INTO contagem_rocket, contagem_cliente
    FROM responsabilidade_decisao_dias WHERE decisao_id = dec.id;

  IF contagem_rocket <> dec.dias_rocket OR contagem_cliente <> dec.dias_cliente THEN
    RAISE EXCEPTION 'LACUNA: dias gravados (rocket=%, cliente=%) nao batem com a decisao % (rocket=%, cliente=%)',
      contagem_rocket, contagem_cliente, dec.id, dec.dias_rocket, dec.dias_cliente;
  END IF;

  IF dec.base_relogio = 'RELOGIO_CLIENTE' THEN
    SELECT dias_demurrage INTO dias_relogio_cliente FROM relogios
      WHERE container_id = dec.container_id AND tipo = 'cliente';
    IF (contagem_rocket + contagem_cliente) <> dias_relogio_cliente THEN
      RAISE EXCEPTION 'LACUNA: decisao % cobre % dia(s) mas o relogio cliente tem % dia(s) de demurrage',
        dec.id, contagem_rocket + contagem_cliente, dias_relogio_cliente;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER responsabilidade_decisao_dias_cobertura
  AFTER INSERT ON responsabilidade_decisao_dias
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION responsabilidade_decisao_cobertura_completa();

-- ---------------------------------------------------------------------------
-- 5) Projeção no contêiner (compatibilidade com lifecycle/fechamento — 0016).
--    A guarda de coerência entre a coluna e a decisão vigente é a 0032.
-- ---------------------------------------------------------------------------

ALTER TABLE containers ADD COLUMN responsabilidade_decisao_id UUID REFERENCES responsabilidade_decisoes(id);
CREATE INDEX containers_responsabilidade_decisao_idx ON containers (responsabilidade_decisao_id);
