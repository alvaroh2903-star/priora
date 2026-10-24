-- Demurrage Engine V2 — migration ADITIVA (Produção P1, entrega corretiva de
-- autenticação, identidade operacional, atribuição e filas pessoais).
-- 0001-0048 não são reescritas; nenhuma linha existente é alterada.
--
-- Conceitos que ficam SEPARADOS (ver docs/demurrage-producao-p1-autenticacao-filas.md):
--  - sessão humana da aplicação → `sessoes_humanas` (esta migration);
--  - credencial de integração com a Microsoft (caixa postal / Graph) →
--    `msal_conta_ativa` + `msal_cache_criptografado` (0027, intocadas);
--  - credencial HMAC do handoff → `demurrage_handoff_credenciais` (0040, intocada);
--  - organização ativa do usuário → dado da SESSÃO, revalidado a cada
--    requisição contra um membership interno ATIVO.

-- ---------------------------------------------------------------------------
-- 1) Sessões humanas (store do express-session compartilhado entre instâncias).
--    A chave é o SHA-256 do identificador da sessão: o identificador em claro
--    (que vai no cookie assinado) nunca é gravado no banco. `dados` nunca
--    contém token Microsoft (o login de identidade descarta os tokens).
-- ---------------------------------------------------------------------------
CREATE TABLE sessoes_humanas (
  sid_hash TEXT PRIMARY KEY CHECK (sid_hash ~ '^[0-9a-f]{64}$'),
  usuario_id UUID REFERENCES usuarios(id),
  dados JSONB NOT NULL,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  revogada_em TIMESTAMPTZ,
  revogada_motivo TEXT,
  CONSTRAINT sessoes_humanas_revogacao_coerente CHECK ((revogada_em IS NULL) = (revogada_motivo IS NULL))
);
CREATE INDEX sessoes_humanas_usuario_idx ON sessoes_humanas (usuario_id) WHERE revogada_em IS NULL;
CREATE INDEX sessoes_humanas_expiracao_idx ON sessoes_humanas (expira_em);

-- ---------------------------------------------------------------------------
-- 2) Identidade: administrador de PLATAFORMA (não de organização) — o único
--    papel que pode conectar/desconectar a integração Microsoft, que é global
--    (serve a todas as organizações). Só o CLI de provisionamento o altera.
-- ---------------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN administrador_plataforma BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 3) Memberships: ativação/desativação (nunca DELETE — as FKs de auditoria
--    apontam para o membership). Ativo = `desativado_em IS NULL`.
-- ---------------------------------------------------------------------------
ALTER TABLE organization_memberships
  ADD COLUMN desativado_em TIMESTAMPTZ,
  ADD COLUMN desativado_motivo TEXT,
  ADD CONSTRAINT organization_memberships_desativacao_coerente
    CHECK ((desativado_em IS NULL) = (desativado_motivo IS NULL));
CREATE INDEX organization_memberships_ativos_idx ON organization_memberships (organization_id, papel) WHERE desativado_em IS NULL;

-- Trilha de auditoria das mudanças de membership (append-only).
CREATE TABLE membership_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  membership_id UUID NOT NULL,
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('CRIADA', 'PAPEL_ALTERADO', 'DESATIVADA', 'REATIVADA')),
  papel_anterior organization_role,
  papel_novo organization_role,
  ator_tipo TEXT NOT NULL CHECK (ator_tipo IN ('membership', 'operador_plataforma')),
  ator_membership_id UUID,
  ator_descricao TEXT,
  motivo TEXT NOT NULL CHECK (btrim(motivo) <> ''),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT membership_eventos_membership_org_fk FOREIGN KEY (membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT membership_eventos_ator_org_fk FOREIGN KEY (ator_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT membership_eventos_ator_coerente CHECK (
    (ator_tipo = 'membership' AND ator_membership_id IS NOT NULL)
    OR (ator_tipo = 'operador_plataforma' AND ator_membership_id IS NULL AND ator_descricao IS NOT NULL AND btrim(ator_descricao) <> '')
  ),
  -- Ninguém altera o PRÓPRIO membership por esta trilha (sem autoconcessão).
  CONSTRAINT membership_eventos_sem_autoalteracao CHECK (ator_membership_id IS DISTINCT FROM membership_id)
);
CREATE INDEX membership_eventos_membership_idx ON membership_eventos (membership_id, criado_em);
CREATE TRIGGER membership_eventos_append_only
  BEFORE UPDATE OR DELETE ON membership_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON membership_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Trilha das mudanças de IDENTIDADE (vínculo Microsoft, papel de plataforma,
-- revogação de sessões) — feitas só pelo operador de plataforma (CLI).
CREATE TABLE usuario_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN (
    'USUARIO_CRIADO', 'IDENTIDADE_VINCULADA', 'IDENTIDADE_DESVINCULADA',
    'ADMIN_PLATAFORMA_CONCEDIDO', 'ADMIN_PLATAFORMA_REVOGADO', 'SESSOES_REVOGADAS'
  )),
  detalhe JSONB NOT NULL DEFAULT '{}'::jsonb,
  ator_descricao TEXT NOT NULL CHECK (btrim(ator_descricao) <> ''),
  motivo TEXT NOT NULL CHECK (btrim(motivo) <> ''),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX usuario_eventos_usuario_idx ON usuario_eventos (usuario_id, criado_em);
CREATE TRIGGER usuario_eventos_append_only
  BEFORE UPDATE OR DELETE ON usuario_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Invariante: uma organização que TEM administrador ativo nunca fica sem
-- nenhum. Verificada no COMMIT (constraint trigger adiável), serializada por
-- organização com o MESMO lock consultivo do serviço de provisionamento —
-- duas remoções concorrentes nunca passam juntas, por qualquer caminho.
CREATE OR REPLACE FUNCTION exigir_admin_ativo_na_organizacao() RETURNS TRIGGER AS $$
DECLARE
  restantes INTEGER;
BEGIN
  IF OLD.papel = 'ADMIN' AND OLD.desativado_em IS NULL THEN
    -- Mesmo lock consultivo do serviço de provisionamento: duas transações que
    -- removem, cada uma, um dos dois últimos ADMINs serializam aqui, e a
    -- segunda conta (READ COMMITTED, novo snapshot por comando) já enxerga a
    -- remoção da primeira — sem write skew.
    PERFORM pg_advisory_xact_lock(hashtextextended('priora:organizacao:membros:' || OLD.organization_id::text, 0));
    SELECT count(*) INTO restantes
      FROM organization_memberships
     WHERE organization_id = OLD.organization_id AND papel = 'ADMIN' AND desativado_em IS NULL;
    IF restantes = 0 THEN
      RAISE EXCEPTION 'ORGANIZACAO_SEM_ADMIN: a organizacao % ficaria sem administrador ativo', OLD.organization_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER organization_memberships_admin_ativo
  AFTER UPDATE OF papel, desativado_em OR DELETE ON organization_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION exigir_admin_ativo_na_organizacao();

-- Responsável operacional DESATIVADO: deliberadamente SEM trigger em
-- `processos` — o handoff (D10) continua aceitando o responsável que o sistema
-- de origem enviar (uma recusa no banco derrubaria o evento inteiro, em todo
-- retry). O serviço de atribuição só aceita alvo ATIVO, e a leitura trata
-- responsável desativado como "sem responsável" (fila SEM_RESPONSAVEL).

-- ---------------------------------------------------------------------------
-- 4) Atribuição do responsável: fonte nova no ledger de observações (acima de
--    todas — o handoff, fonte `outro`, nunca sobrescreve uma atribuição
--    interna) e trilha append-only com idempotência atômica.
-- ---------------------------------------------------------------------------
ALTER TABLE field_observations DROP CONSTRAINT field_observations_fonte_check;
ALTER TABLE field_observations ADD CONSTRAINT field_observations_fonte_check CHECK (
  fonte IN (
    'tracking_service', 'email_heuristic', 'manual_fallback',
    'house_document', 'master_bl', 'headcargo', 'outro', 'shipping_instructions',
    'atribuicao_interna'
  )
);

CREATE TABLE processo_atribuicoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  resultado TEXT NOT NULL CHECK (resultado IN ('ATRIBUIDO', 'INALTERADO')),
  anterior_membership_id UUID,
  novo_membership_id UUID,
  -- Autor: o membership MANAGER/ADMIN da sessão (HTTP) ou o operador de
  -- plataforma (CLI de implantação — atribuição inicial em lote).
  autor_tipo TEXT NOT NULL CHECK (autor_tipo IN ('membership', 'operador_plataforma')),
  autor_membership_id UUID,
  autor_usuario_id UUID REFERENCES usuarios(id),
  autor_descricao TEXT,
  motivo TEXT NOT NULL CHECK (btrim(motivo) <> ''),
  observation_id UUID REFERENCES field_observations(id),
  idempotencia_chave TEXT NOT NULL CHECK (char_length(idempotencia_chave) BETWEEN 1 AND 200),
  idempotencia_hash TEXT NOT NULL CHECK (idempotencia_hash ~ '^[0-9a-f]{64}$'),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT processo_atribuicoes_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT processo_atribuicoes_anterior_org_fk FOREIGN KEY (anterior_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT processo_atribuicoes_novo_org_fk FOREIGN KEY (novo_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT processo_atribuicoes_autor_org_fk FOREIGN KEY (autor_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT processo_atribuicoes_autor_coerente CHECK (
    (autor_tipo = 'membership' AND autor_membership_id IS NOT NULL AND autor_usuario_id IS NOT NULL)
    OR (autor_tipo = 'operador_plataforma' AND autor_membership_id IS NULL AND autor_usuario_id IS NULL
        AND autor_descricao IS NOT NULL AND btrim(autor_descricao) <> '')
  ),
  CONSTRAINT processo_atribuicoes_resultado_coerente CHECK (
    (resultado = 'ATRIBUIDO' AND anterior_membership_id IS DISTINCT FROM novo_membership_id AND observation_id IS NOT NULL)
    OR (resultado = 'INALTERADO' AND anterior_membership_id IS NOT DISTINCT FROM novo_membership_id AND observation_id IS NULL)
  ),
  CONSTRAINT processo_atribuicoes_idempotencia_unica UNIQUE (organization_id, idempotencia_chave)
);
CREATE INDEX processo_atribuicoes_processo_idx ON processo_atribuicoes (processo_id, criado_em);
CREATE TRIGGER processo_atribuicoes_append_only
  BEFORE UPDATE OR DELETE ON processo_atribuicoes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON processo_atribuicoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 5) Autor ATIVO também no banco: decisão de responsabilidade (trigger da 0033).
-- ---------------------------------------------------------------------------
-- Produção P1 (identidade operacional) — o trigger de inserção de decisão de
-- responsabilidade (0033) passa a exigir que o autor esteja ATIVO: mesmo corpo
-- da 0033, só a leitura do papel do autor ganha `AND desativado_em IS NULL`
-- (o `FOR SHARE` já existente serializa com a desativação concorrente).
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

  SELECT papel INTO papel_atual FROM organization_memberships
   WHERE id = NEW.autor_membership_id AND desativado_em IS NULL FOR SHARE;
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
