-- G-3c — Reconstrução controlada das projeções da Liberação anteriores ao motor oficial (L1b). Dono: Liberação.
--
-- Só esquema: nenhuma linha de negócio é lida, copiada nem reescrita aqui. A reconstrução é um serviço de
-- aplicação (em lotes, retomável, isolado por organização) que reavalia cada processo pelos fatos persistidos,
-- pelo adaptador oficial. Depende só da 0103 (nada das 0104–0106). Quatro partes:
--   1) a fila durável da reconstrução: posse com dono, token e expiração; cerca (fencing) pelo token;
--      tentativas limitadas; esgotamento visível;
--   2) a posse perdida, registrada;
--   3) o registro da liberação histórica que a decisão oficial atual não comprova ("Decisão histórica diverge
--      da decisão oficial atual"), só com referências aos eventos e códigos de etapa — nenhuma evidência bruta
--      é copiada — e conferido contra os próprios eventos (append-only);
--   4) a guarda do terminal da 0103 passa a proteger o LIBERADO OFICIAL (versão >= 3) e a liberação histórica
--      (Decisão A): a versão da projeção nunca diminui; um LIBERADO legado (versão < 3, saída da L1a) só dá
--      lugar à decisão da L1b se o registro da liberação histórica for gravado NA MESMA transação; nunca é
--      removido. O evento histórico continua intacto (append-only).
--
-- Por que tabelas novas: `tracking_schedule_claims` (Demurrage) não tem token de posse nem cerca na
-- finalização, não limita tentativas e é chaveada por alvo de rastreio; o `alert_outbox` não tem posse.

-- ---------------------------------------------------------------------------
-- 1) Fila durável da reconstrução. Um item ATIVO (PENDENTE/PROCESSANDO) por processo; concluído e esgotado
-- são imutáveis e nada é apagado (histórico da operação).
-- ---------------------------------------------------------------------------
CREATE TABLE liberacao_reconstrucoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  -- PROJECAO_LEGADA: projeção anterior à versão oficial; PEDIDO_ADMIN: pedido explícito de uma pessoa ADMIN.
  motivo TEXT NOT NULL CHECK (motivo IN ('PROJECAO_LEGADA', 'PEDIDO_ADMIN')),
  solicitado_por_membership_id UUID,
  versao_alvo INTEGER NOT NULL CHECK (versao_alvo >= 3),
  situacao TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (situacao IN ('PENDENTE', 'PROCESSANDO', 'CONCLUIDA', 'ESGOTADA')),
  -- Contadas na reivindicação (inclusive a de um trabalhador que morreu com a posse).
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  max_tentativas INTEGER NOT NULL DEFAULT 5 CHECK (max_tentativas BETWEEN 1 AND 20),
  disponivel_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  dono TEXT CHECK (dono IS NULL OR length(dono) BETWEEN 1 AND 120),
  posse_token UUID,
  posse_expira_em TIMESTAMPTZ,
  -- Código saneado (nome do erro + mensagem mascarada), nunca evidência bruta.
  ultimo_erro TEXT CHECK (ultimo_erro IS NULL OR length(ultimo_erro) <= 200),
  resultado TEXT CHECK (resultado IN ('RECONSTRUIDA', 'SEM_MUDANCA_MATERIAL', 'JA_ATUAL', 'PROCESSO_NAO_ENCONTRADO')),
  evento_sequencia INTEGER CHECK (evento_sequencia >= 1),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT liberacao_reconstrucoes_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT liberacao_reconstrucoes_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT liberacao_reconstrucoes_solicitante_fk FOREIGN KEY (solicitado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT liberacao_reconstrucoes_evento_fk FOREIGN KEY (organization_id, processo_id, evento_sequencia)
    REFERENCES liberacao_avaliacao_eventos (organization_id, processo_id, sequencia),
  CONSTRAINT liberacao_reconstrucoes_solicitante CHECK ((motivo = 'PEDIDO_ADMIN') = (solicitado_por_membership_id IS NOT NULL)),
  CONSTRAINT liberacao_reconstrucoes_posse CHECK (
    (situacao = 'PROCESSANDO') = (posse_token IS NOT NULL)
    AND (posse_token IS NULL) = (dono IS NULL)
    AND (posse_token IS NULL) = (posse_expira_em IS NULL)),
  CONSTRAINT liberacao_reconstrucoes_conclusao CHECK (
    (situacao = 'CONCLUIDA') = (resultado IS NOT NULL)
    AND (situacao IN ('CONCLUIDA', 'ESGOTADA')) = (concluido_em IS NOT NULL)),
  CONSTRAINT liberacao_reconstrucoes_tentativas CHECK (tentativas <= max_tentativas)
);

CREATE UNIQUE INDEX liberacao_reconstrucoes_ativa_unica
  ON liberacao_reconstrucoes (organization_id, processo_id) WHERE situacao IN ('PENDENTE', 'PROCESSANDO');
CREATE INDEX liberacao_reconstrucoes_fila
  ON liberacao_reconstrucoes (disponivel_em, criado_em) WHERE situacao IN ('PENDENTE', 'PROCESSANDO');
CREATE INDEX liberacao_reconstrucoes_processo
  ON liberacao_reconstrucoes (organization_id, processo_id, criado_em DESC);

CREATE FUNCTION liberacao_reconstrucoes_historico() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'liberacao_reconstrucoes: o histórico da reconstrução não é removido' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.situacao IN ('CONCLUIDA', 'ESGOTADA') THEN
    RAISE EXCEPTION 'liberacao_reconstrucoes: item % é imutável', OLD.situacao USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER liberacao_reconstrucoes_historico
  BEFORE UPDATE OR DELETE ON liberacao_reconstrucoes
  FOR EACH ROW EXECUTE FUNCTION liberacao_reconstrucoes_historico();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON liberacao_reconstrucoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- 2) Finalização recusada pela cerca (o token não é mais o do item): registro append-only, para a operação ver.
CREATE TABLE liberacao_reconstrucao_posses_perdidas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  reconstrucao_id UUID NOT NULL,
  dono TEXT NOT NULL CHECK (length(dono) BETWEEN 1 AND 120),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT liberacao_reconstrucao_posses_perdidas_item_fk FOREIGN KEY (reconstrucao_id, organization_id)
    REFERENCES liberacao_reconstrucoes (id, organization_id)
);
CREATE INDEX liberacao_reconstrucao_posses_perdidas_org ON liberacao_reconstrucao_posses_perdidas (organization_id);
CREATE TRIGGER liberacao_reconstrucao_posses_perdidas_append_only
  BEFORE UPDATE OR DELETE ON liberacao_reconstrucao_posses_perdidas
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON liberacao_reconstrucao_posses_perdidas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 3) Registro da liberação histórica não comprovada: a liberação do motor anterior diverge da decisão oficial
-- atual. Referências aos dois eventos (append-only) + códigos de etapa e instantes; nunca a avaliação nem a
-- evidência copiadas. Uma por processo e evento histórico; append-only e sem fluxo de encerramento (Decisão A).
-- Não reabre o processo nem cria pendência: o ato operacional já ocorrido não é revertido por ninguém aqui.
-- ---------------------------------------------------------------------------
CREATE TABLE liberacao_revisoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  condicao TEXT NOT NULL CHECK (condicao IN ('DECISAO_HISTORICA_DIVERGE_DA_OFICIAL')),
  historica_sequencia INTEGER NOT NULL,
  historica_versao INTEGER NOT NULL CHECK (historica_versao >= 1),
  historica_etapa TEXT NOT NULL CHECK (historica_etapa ~ '^[A-Z_]{1,60}$'),
  historica_em TIMESTAMPTZ NOT NULL,
  oficial_sequencia INTEGER NOT NULL,
  oficial_etapa TEXT NOT NULL CHECK (oficial_etapa ~ '^[A-Z_]{1,60}$'),
  oficial_em TIMESTAMPTZ NOT NULL,
  detectada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT liberacao_revisoes_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT liberacao_revisoes_historica_fk FOREIGN KEY (organization_id, processo_id, historica_sequencia)
    REFERENCES liberacao_avaliacao_eventos (organization_id, processo_id, sequencia),
  CONSTRAINT liberacao_revisoes_oficial_fk FOREIGN KEY (organization_id, processo_id, oficial_sequencia)
    REFERENCES liberacao_avaliacao_eventos (organization_id, processo_id, sequencia),
  CONSTRAINT liberacao_revisoes_ordem CHECK (historica_sequencia < oficial_sequencia),
  CONSTRAINT liberacao_revisoes_unica UNIQUE (organization_id, processo_id, condicao, historica_sequencia)
);
CREATE TRIGGER liberacao_revisoes_append_only
  BEFORE UPDATE OR DELETE ON liberacao_revisoes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON liberacao_revisoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- Cada registro confere com os eventos que cita: o histórico é um LIBERADO de versão anterior; o oficial é da
-- versão >= 3 e NÃO é LIBERADO; etapas e instantes iguais aos dos eventos. O instante de detecção é o da
-- transação que grava (não o informado por quem insere).
CREATE FUNCTION liberacao_revisoes_conferida() RETURNS trigger AS $$
DECLARE
  h liberacao_avaliacao_eventos%ROWTYPE;
  o liberacao_avaliacao_eventos%ROWTYPE;
  etapa_oficial TEXT;
BEGIN
  SELECT * INTO h FROM liberacao_avaliacao_eventos
   WHERE organization_id = NEW.organization_id AND processo_id = NEW.processo_id AND sequencia = NEW.historica_sequencia;
  SELECT * INTO o FROM liberacao_avaliacao_eventos
   WHERE organization_id = NEW.organization_id AND processo_id = NEW.processo_id AND sequencia = NEW.oficial_sequencia;
  etapa_oficial := CASE WHEN o.avaliacao_nova #>> '{etapa,tipo}' = 'DETERMINADA' THEN o.avaliacao_nova #>> '{etapa,etapa}'
                        ELSE 'NAO_DETERMINAVEL' END;
  IF h.sequencia IS NULL OR o.sequencia IS NULL
     OR h.versao_projecao >= 3 OR (h.avaliacao_nova #>> '{etapa,etapa}') IS DISTINCT FROM 'LIBERADO'
     OR NEW.historica_versao IS DISTINCT FROM h.versao_projecao OR NEW.historica_etapa IS DISTINCT FROM 'LIBERADO'
     OR NEW.historica_em IS DISTINCT FROM h.registrado_em
     OR o.versao_projecao < 3 OR etapa_oficial = 'LIBERADO'
     OR NEW.oficial_etapa IS DISTINCT FROM etapa_oficial OR NEW.oficial_em IS DISTINCT FROM o.registrado_em THEN
    RAISE EXCEPTION 'liberacao_revisoes: o registro não corresponde aos eventos que cita' USING ERRCODE = 'check_violation';
  END IF;
  NEW.detectada_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER liberacao_revisoes_conferida
  BEFORE INSERT ON liberacao_revisoes
  FOR EACH ROW EXECUTE FUNCTION liberacao_revisoes_conferida();

-- ---------------------------------------------------------------------------
-- 4) Guarda do terminal e da liberação histórica.
--  - LIBERADO oficial (versão >= 3): irreversível e não removível (como na 0103).
--  - A versão da projeção nunca diminui: rebaixar não é caminho de reabertura.
--  - LIBERADO legado (versão < 3): só dá lugar à decisão oficial (versão >= 3, não terminal) se o registro da
--    liberação histórica — histórico = o evento da linha legada, oficial = o evento da linha nova — foi gravado
--    pela MESMA transação (o xmin do registro é a transação corrente; gravado numa subtransação, é recusado).
--  - Linha não terminal de um processo com LIBERADO legado nos eventos: só com o registro desse evento.
-- ---------------------------------------------------------------------------
CREATE FUNCTION liberacao_historica_registrada_na_transacao(
  p_org UUID, p_processo UUID, p_historica INTEGER, p_oficial INTEGER
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM liberacao_revisoes r
     WHERE r.organization_id = p_org AND r.processo_id = p_processo AND r.condicao = 'DECISAO_HISTORICA_DIVERGE_DA_OFICIAL'
       AND r.historica_sequencia = p_historica AND r.oficial_sequencia = p_oficial
       AND r.xmin::text = (pg_current_xact_id()::text::numeric % 4294967296)::text)
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION liberacao_avaliacoes_terminal_preservado() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.terminal THEN
      RAISE EXCEPTION 'liberacao_avaliacoes: avaliação terminal (LIBERADO) não pode ser reaberta nem removida'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.versao_projecao < OLD.versao_projecao THEN
    RAISE EXCEPTION 'liberacao_avaliacoes: a versão da projeção não pode ser reduzida' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.terminal AND NOT NEW.terminal AND NOT (
       OLD.versao_projecao < 3 AND NEW.versao_projecao >= 3
       AND liberacao_historica_registrada_na_transacao(OLD.organization_id, OLD.processo_id, OLD.sequencia, NEW.sequencia)) THEN
    RAISE EXCEPTION 'liberacao_avaliacoes: avaliação terminal (LIBERADO) não pode ser reaberta nem removida'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION liberacao_avaliacoes_liberacao_historica() RETURNS trigger AS $$
DECLARE historica INTEGER;
BEGIN
  IF NEW.terminal THEN RETURN NEW; END IF;
  SELECT max(e.sequencia) INTO historica FROM liberacao_avaliacao_eventos e
   WHERE e.organization_id = NEW.organization_id AND e.processo_id = NEW.processo_id
     AND e.versao_projecao < 3 AND e.avaliacao_nova #>> '{etapa,etapa}' = 'LIBERADO';
  IF historica IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM liberacao_revisoes r
        WHERE r.organization_id = NEW.organization_id AND r.processo_id = NEW.processo_id
          AND r.condicao = 'DECISAO_HISTORICA_DIVERGE_DA_OFICIAL' AND r.historica_sequencia = historica) THEN
    RAISE EXCEPTION 'liberacao_avaliacoes: a liberação histórica (evento %) precisa do seu registro antes de dar lugar à decisão oficial', historica
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Dispara também no INSERT ... ON CONFLICT DO UPDATE da projeção (antes da guarda de UPDATE).
CREATE TRIGGER liberacao_avaliacoes_liberacao_historica
  BEFORE INSERT ON liberacao_avaliacoes
  FOR EACH ROW EXECUTE FUNCTION liberacao_avaliacoes_liberacao_historica();
