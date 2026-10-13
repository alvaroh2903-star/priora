-- L2 — Projeção real da Liberação. Dono: Liberação.
--
-- S1 + S2 + S6 → L1a → projeção persistida. Nada aqui é fato de origem: os
-- fatos continuam com os donos (Courier → `courier_fatos`; Auditoria e vínculo
-- Processo↔Master → `auditoria_extracoes` / `processo_master_vinculos`;
-- identidade → S6/`processos`). A Liberação guarda só:
--   1) a avaliação ATUAL derivada pela L1a (uma linha por processo, substituível);
--   2) o histórico append-only das mudanças MATERIAIS dessa avaliação;
--   3) ponteiros (ids) para as linhas de origem usadas — nunca cópia dos valores.
-- O processo é o central (`processos.id`); não há identidade de processo própria.

-- ---------------------------------------------------------------------------
-- Histórico de mudanças materiais (append-only). Uma linha por mudança do
-- resultado operacional da L1a: a primeira avaliação, e depois só quando a
-- impressão material muda. Frescor (última confirmação, "desde" da
-- disponibilidade) e ponteiros não são materiais. Guarda a projeção anterior e
-- a nova, com as impressões, para auditoria.
-- ---------------------------------------------------------------------------
CREATE TABLE liberacao_avaliacao_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  sequencia INTEGER NOT NULL CHECK (sequencia >= 1),
  impressao_anterior TEXT CHECK (impressao_anterior ~ '^[0-9a-f]{64}$'),
  impressao_nova TEXT NOT NULL CHECK (impressao_nova ~ '^[0-9a-f]{64}$'),
  avaliacao_anterior JSONB,
  avaliacao_nova JSONB NOT NULL,
  fontes JSONB NOT NULL,
  gatilho TEXT NOT NULL CHECK (gatilho IN (
    'COURIER_CONFERENCIA', 'COURIER_ENVELOPE', 'AUDITORIA_VINCULO', 'IDENTIDADE_RESOLVIDA', 'MASTER_COMPARTILHADO',
    'RECONSTRUCAO', 'RECONSTRUCAO_MANUAL')),
  -- Só a reconstrução pedida por uma pessoa (S4) tem autor; recálculo interno não inventa ator.
  acionado_por_membership_id UUID,
  versao_projecao INTEGER NOT NULL CHECK (versao_projecao >= 1),
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT liberacao_avaliacao_eventos_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT liberacao_avaliacao_eventos_acionador_fk FOREIGN KEY (acionado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT liberacao_avaliacao_eventos_sequencia_unica UNIQUE (organization_id, processo_id, sequencia),
  -- A primeira avaliação não tem anterior; as seguintes têm, e só existem se a impressão mudou.
  CONSTRAINT liberacao_avaliacao_eventos_cadeia CHECK (
    (sequencia = 1) = (impressao_anterior IS NULL)
    AND (impressao_anterior IS NULL) = (avaliacao_anterior IS NULL)
    AND impressao_anterior IS DISTINCT FROM impressao_nova
  ),
  CONSTRAINT liberacao_avaliacao_eventos_autor CHECK ((gatilho = 'RECONSTRUCAO_MANUAL') = (acionado_por_membership_id IS NOT NULL))
);

CREATE TRIGGER liberacao_avaliacao_eventos_append_only
  BEFORE UPDATE OR DELETE ON liberacao_avaliacao_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON liberacao_avaliacao_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- Avaliação atual: uma linha por (organização, processo). Projeção derivada,
-- atualizável (frescor e ponteiros sem evento; mudança material junto com o
-- evento, na mesma transação). `sequencia` aponta o evento que estabeleceu o
-- estado material atual.
-- ---------------------------------------------------------------------------
CREATE TABLE liberacao_avaliacoes (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  avaliacao JSONB NOT NULL,
  fontes JSONB NOT NULL,
  impressao_material TEXT NOT NULL CHECK (impressao_material ~ '^[0-9a-f]{64}$'),
  versao_projecao INTEGER NOT NULL CHECK (versao_projecao >= 1),
  sequencia INTEGER NOT NULL CHECK (sequencia >= 1),
  terminal BOOLEAN NOT NULL,
  avaliado_em TIMESTAMPTZ NOT NULL,
  alterado_em TIMESTAMPTZ NOT NULL,
  CONSTRAINT liberacao_avaliacoes_pk PRIMARY KEY (organization_id, processo_id),
  CONSTRAINT liberacao_avaliacoes_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT liberacao_avaliacoes_evento_fk FOREIGN KEY (organization_id, processo_id, sequencia)
    REFERENCES liberacao_avaliacao_eventos (organization_id, processo_id, sequencia),
  CONSTRAINT liberacao_avaliacoes_processo_coerente CHECK (avaliacao ->> 'processoId' = processo_id::text),
  CONSTRAINT liberacao_avaliacoes_terminal_coerente CHECK (
    terminal = COALESCE(avaliacao #>> '{etapa,etapa}' = 'LIBERADO', false))
);

-- Terminal (LIBERADO) não é reaberto nem apagado pela projeção (N-16, cap. 39).
CREATE FUNCTION liberacao_avaliacoes_terminal_preservado() RETURNS trigger AS $$
BEGIN
  IF OLD.terminal AND (TG_OP = 'DELETE' OR NOT NEW.terminal) THEN
    RAISE EXCEPTION 'liberacao_avaliacoes: avaliação terminal (LIBERADO) não pode ser reaberta nem removida'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER liberacao_avaliacoes_terminal_preservado
  BEFORE UPDATE OR DELETE ON liberacao_avaliacoes
  FOR EACH ROW EXECUTE FUNCTION liberacao_avaliacoes_terminal_preservado();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON liberacao_avaliacoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
