-- Demurrage Engine V2 — migration ADITIVA (Fase D15-B — integridade de dados e
-- exceções). 0001-0035 NÃO são reescritas. D15-A (fechamento/reabertura,
-- transação/lock de recálculo) permanece intocada. Nenhuma regra congelada de
-- D10-D14 muda (relógios, tarifas, hierarquia de fontes, cadência,
-- responsabilidade, minuta, fechamento, leitura de Gestão/Indicadores).
--
-- Resumo (ver docs/demurrage-fase-d15-b.md para o detalhe por caso):
--   1) demurrage_pendencias: novos tipos nomeados + resolução manual auditável
--      (resolvido_por/resolvido_motivo, mesmo padrão de ft_divergencias);
--   2) vessel_call_pendencias: tipo mismatch_carrier + resolução manual auditável;
--   3) ft_divergencias: campo generalizado para aceitar houseFreeTimeDays (conflito
--      House-only, sem tocar o par Master×SI já existente);
--   4) free_time_tentativas: histórico APPEND-ONLY de tentativas de obtenção de
--      Free Time (fonte, resultado, evidência sanitizada), ligado à pendência;
--   5) demurrage_pendencia_avisos: outbox de aviso aos gestores para pendências
--      que exigem notificação ativa (retorno vazio pré-descarga, fallback manual
--      superado por fonte mais forte) — mesmo padrão de claim/posse já usado em
--      demurrage_fallback_manual_avisos/ft_divergencia_entregas;
--   6) container_vessel_calls.observado_em: data do evento que motivou a
--      associação/rolagem, para recusar rolagem para uma VesselCall mais antiga
--      (R44 — evento tardio/cache).

-- ---------------------------------------------------------------------------
-- 1) demurrage_pendencias: novos tipos + resolução manual auditável.
-- ---------------------------------------------------------------------------
ALTER TABLE demurrage_pendencias DROP CONSTRAINT demurrage_pendencias_tipo_check;
ALTER TABLE demurrage_pendencias ADD CONSTRAINT demurrage_pendencias_tipo_check CHECK (tipo IN (
  'armador_ausente', 'armador_nao_cadastrado', 'armador_sem_tracking',
  'mbl_ausente', 'tipo_ausente', 'tipo_nao_reconhecido', 'tipo_selecao_sem_observacao',
  -- D15-B (novos):
  'retorno_vazio_antes_descarga',        -- 31.5 (R08) — bloqueia fechamento, notifica gestão.
  'cronologia_gate_out_antes_descarga',  -- R39 — bloqueia só a promoção do fato afetado.
  'cronologia_retorno_antes_gate_out',   -- R40 — idem.
  'condicao_comercial_ausente',          -- R26 — tarifa do cliente indisponível por falta de condição.
  'conflito_mesma_fonte',                -- R37 — mesma fonte, mesmo instante, valor diferente.
  'fallback_manual_superado',            -- R07 — fonte mais forte chegou sobre um manual_fallback vigente.
  'free_time_ausente'                    -- R05 — ausência de Free Time com histórico de tentativas anexado.
));

-- Resolução MANUAL auditável (mesmo padrão de ft_divergencias.resolvida_por/
-- resolvida_motivo): preenchido só quando um humano resolve explicitamente
-- (R45/R56); a resolução AUTOMÁTICA por condição desaparecida (já existente)
-- continua deixando estas colunas NULAS — não há regressão de comportamento.
ALTER TABLE demurrage_pendencias
  ADD COLUMN resolvido_por UUID REFERENCES organization_memberships(id),
  ADD COLUMN resolvido_motivo TEXT;

-- ---------------------------------------------------------------------------
-- 2) vessel_call_pendencias: tipo mismatch_carrier + resolução manual auditável.
-- ---------------------------------------------------------------------------
ALTER TABLE vessel_call_pendencias DROP CONSTRAINT vessel_call_pendencias_tipo_check;
ALTER TABLE vessel_call_pendencias ADD CONSTRAINT vessel_call_pendencias_tipo_check CHECK (tipo IN (
  'pod_nao_confirmado', 'pod_divergente', 'identidade_ambigua', 'atracacao_ambigua',
  'mismatch_carrier' -- R38 — referência de tracking aparenta outro armador.
));
ALTER TABLE vessel_call_pendencias
  ADD COLUMN resolvido_por UUID REFERENCES organization_memberships(id),
  ADD COLUMN resolvido_motivo TEXT;

-- ---------------------------------------------------------------------------
-- 3) ft_divergencias: generaliza `campo` para aceitar conflito House-only
--    (R36), sem tocar o par Master×SI já existente (mesma tabela, mesmas
--    colunas valor_si/valor_master — reaproveitadas como "lado A"/"lado B"
--    do conflito, qualquer que seja o campo).
-- ---------------------------------------------------------------------------
ALTER TABLE ft_divergencias DROP CONSTRAINT ft_divergencias_campo_check;
ALTER TABLE ft_divergencias ADD CONSTRAINT ft_divergencias_campo_check
  CHECK (campo IN ('masterFreeTimeDays', 'houseFreeTimeDays'));

-- ---------------------------------------------------------------------------
-- 4) Histórico de tentativas de Free Time (R05) — APPEND-ONLY, ligado à
--    pendência correspondente (quando existe uma aberta). `resultado =
--    'encontrado'` registra TODA observação de Free Time aceita (qualquer
--    fonte real, nunca manual_fallback — a tentativa humana não é uma
--    "fonte consultada"); `resultado = 'nao_encontrado'` registra uma busca
--    que não achou nada (hoje: ingestão de Shipping Instructions). A
--    projeção da ÚLTIMA tentativa por (contêiner, campo) não precisa de
--    coluna adicional: `ORDER BY tentativa_em DESC LIMIT 1`.
-- ---------------------------------------------------------------------------
CREATE TABLE free_time_tentativas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  container_id UUID NOT NULL,
  pendencia_id UUID REFERENCES demurrage_pendencias(id),
  campo TEXT NOT NULL CHECK (campo IN ('houseFreeTimeDays', 'masterFreeTimeDays')),
  fonte_tentada TEXT NOT NULL,
  resultado TEXT NOT NULL CHECK (resultado IN ('encontrado', 'nao_encontrado')),
  evidencia_sanitizada TEXT,
  detalhe JSONB NOT NULL DEFAULT '{}'::jsonb,
  tentativa_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT free_time_tentativas_container_org_fk FOREIGN KEY (container_id, organization_id)
    REFERENCES containers (id, organization_id),
  CONSTRAINT free_time_tentativas_processo_org_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id)
);
CREATE INDEX free_time_tentativas_container_campo_idx ON free_time_tentativas (container_id, campo, tentativa_em DESC);
CREATE TRIGGER free_time_tentativas_append_only
  BEFORE UPDATE OR DELETE ON free_time_tentativas
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON free_time_tentativas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 5) Outbox de aviso aos gestores para pendências que exigem notificação
--    ATIVA (R07, R08) — mesmo padrão de claim/posse de
--    `demurrage_fallback_manual_avisos`/`ft_divergencia_entregas`. Genérico
--    por `pendencia_id`: qualquer tipo de `demurrage_pendencias` pode usá-lo,
--    mas esta entrega só enfileira para os dois tipos citados.
-- ---------------------------------------------------------------------------
CREATE TABLE demurrage_pendencia_avisos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  pendencia_id UUID NOT NULL REFERENCES demurrage_pendencias(id),
  destinatario_membership_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  erro TEXT,
  claim_token UUID,
  worker_id TEXT,
  expira_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em TIMESTAMPTZ,
  CONSTRAINT demurrage_pendencia_avisos_unico UNIQUE (pendencia_id, destinatario_membership_id),
  CONSTRAINT demurrage_pendencia_avisos_membership_org_fk FOREIGN KEY (destinatario_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT demurrage_pendencia_avisos_claim
    CHECK ((status = 'PROCESSING') = (claim_token IS NOT NULL AND worker_id IS NOT NULL AND expira_em IS NOT NULL))
);
CREATE INDEX demurrage_pendencia_avisos_status_idx ON demurrage_pendencia_avisos (status, criado_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_pendencia_avisos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 6) container_vessel_calls: data do EVENTO (não da escrita) que motivou a
--    associação/rolagem (R44) — NULA para linhas legadas (pré-D15-B), nunca
--    retroativamente preenchida. `associarContainer` passa a recusar rolar
--    para uma VesselCall cuja evidência é mais ANTIGA que a já ativa (evento
--    tardio/cache), preservando a associação corrente e registrando o fato.
-- ---------------------------------------------------------------------------
ALTER TABLE container_vessel_calls ADD COLUMN observado_em DATE;

-- Evento auditável da recusa (R44) — preserva o fato de que uma rolagem foi
-- tentada e rejeitada por recência, sem alterar a associação ativa.
ALTER TABLE container_vessel_call_eventos DROP CONSTRAINT container_vessel_call_eventos_tipo_check;
ALTER TABLE container_vessel_call_eventos ADD CONSTRAINT container_vessel_call_eventos_tipo_check
  CHECK (tipo IN ('associado', 'desvinculado', 'rolagem', 'rolagem_recusada_recencia'));
