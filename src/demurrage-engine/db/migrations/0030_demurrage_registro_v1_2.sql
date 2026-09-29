-- Demurrage Engine V2 — migration ADITIVA (Fase D10 v1.2 — corretiva final do registro).
-- Não reescreve 0028 nem 0029. Nenhuma regra congelada (relógios, tarifas,
-- hierarquia de fontes, cadência, responsabilidade, minuta, fechamento) muda.
--
--   1) Backfill SEGURO de `container_equipamento_original.observation_id` para
--      seleções gravadas antes da 0029 + guarda contra novas seleções sem ele;
--   2) outbox de pós-commit com CLAIM de posse inequívoca (estado processando,
--      token, worker, prazo, geração) e FK garantindo contêiner ∈ processo;
--   3) aviso DURÁVEL aos gestores para cada fallback manual de Free Time
--      (outbox próprio com claim — o de divergência é atado a ft_divergencias).

-- ---------------------------------------------------------------------------
-- 1a) Nova pendência auditável: seleção legada sem observação determinável.
-- ---------------------------------------------------------------------------
ALTER TABLE demurrage_pendencias DROP CONSTRAINT demurrage_pendencias_tipo_check;
ALTER TABLE demurrage_pendencias ADD CONSTRAINT demurrage_pendencias_tipo_check CHECK (tipo IN (
  'armador_ausente', 'armador_nao_cadastrado', 'armador_sem_tracking',
  'mbl_ausente', 'tipo_ausente', 'tipo_nao_reconhecido',
  'tipo_selecao_sem_observacao'
));

-- ---------------------------------------------------------------------------
-- 1b) Backfill: liga cada seleção legada à observação que a originou, casando
--     TODOS os atributos — contêiner, campo, fonte, instante observado e valor
--     (e organização). Só vincula quando há EXATAMENTE uma candidata; zero ou
--     mais de uma → nada é escolhido arbitrariamente: a linha fica como está
--     (dados preservados, observation_id NULL) e nasce uma pendência aberta com
--     o retrato da seleção e o número de candidatas.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _d10_v12_legado ON COMMIT DROP AS
SELECT e.container_id, e.organization_id, c.processo_id, e.tipo_original, e.fonte, e.observado_em,
       e.codigo_normalizado, e.regra_aplicada,
       (SELECT array_agg(fo.id ORDER BY fo.id)
          FROM field_observations fo
         WHERE fo.entidade_tipo = 'container' AND fo.entidade_id = e.container_id
           AND fo.campo = 'tipoEquipamentoOriginal' AND fo.fonte = e.fonte
           AND fo.observado_em = e.observado_em AND fo.valor = to_jsonb(e.tipo_original)
           AND fo.organization_id = e.organization_id) AS candidatas
  FROM container_equipamento_original e
  JOIN containers c ON c.id = e.container_id
 WHERE e.observation_id IS NULL;

UPDATE container_equipamento_original e
   SET observation_id = l.candidatas[1]
  FROM _d10_v12_legado l
 WHERE l.container_id = e.container_id
   AND coalesce(array_length(l.candidatas, 1), 0) = 1;

INSERT INTO demurrage_pendencias (organization_id, processo_id, container_id, tipo, contexto)
SELECT l.organization_id, l.processo_id, l.container_id, 'tipo_selecao_sem_observacao',
       jsonb_build_object(
         'origem', 'migration_0030_backfill',
         'motivo', CASE WHEN coalesce(array_length(l.candidatas, 1), 0) = 0 THEN 'nenhuma_observacao_correspondente'
                        ELSE 'mais_de_uma_observacao_correspondente' END,
         'candidatas', coalesce(to_jsonb(l.candidatas), '[]'::jsonb),
         'selecaoLegada', jsonb_build_object(
           'tipoOriginal', l.tipo_original, 'fonte', l.fonte, 'observadoEm', l.observado_em,
           'codigoNormalizado', l.codigo_normalizado, 'regraAplicada', l.regra_aplicada))
  FROM _d10_v12_legado l
 WHERE coalesce(array_length(l.candidatas, 1), 0) <> 1
ON CONFLICT (processo_id, COALESCE(container_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo)
  WHERE estado = 'aberta' DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1c) Guarda: nenhuma seleção NOVA (ou reescrita) sem observation_id. NOT VALID
--     é deliberado e documentado: as linhas legadas que o backfill NÃO pôde
--     vincular com segurança permanecem NULL para auditoria (com pendência
--     aberta) — um NOT NULL exigiria escolher arbitrariamente ou apagar dados.
--     Toda escrita futura (INSERT/UPDATE) passa pela verificação.
-- ---------------------------------------------------------------------------
ALTER TABLE container_equipamento_original
  ADD CONSTRAINT container_equip_observation_obrigatoria CHECK (observation_id IS NOT NULL) NOT VALID;

-- A observação selecionada tem de ser do MESMO contêiner, do campo de tipo
-- original, com a mesma fonte/valor/instante gravados na seleção (coerência
-- estrutural, não só referencial).
CREATE FUNCTION container_equip_observation_coerente() RETURNS trigger AS $$
DECLARE ok BOOLEAN;
BEGIN
  IF NEW.observation_id IS NULL THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM field_observations fo
     WHERE fo.id = NEW.observation_id AND fo.entidade_tipo = 'container' AND fo.entidade_id = NEW.container_id
       AND fo.campo = 'tipoEquipamentoOriginal' AND fo.fonte = NEW.fonte
       AND fo.observado_em = NEW.observado_em AND fo.valor = to_jsonb(NEW.tipo_original)
  ) INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION 'container_equipamento_original: observation_id % não corresponde à seleção do contêiner %', NEW.observation_id, NEW.container_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER container_equip_observation_coerente
  BEFORE INSERT OR UPDATE ON container_equipamento_original
  FOR EACH ROW EXECUTE FUNCTION container_equip_observation_coerente();

-- ---------------------------------------------------------------------------
-- 2) Outbox de pós-commit: claim de posse + contêiner ∈ processo.
-- ---------------------------------------------------------------------------
-- Chave candidata (id, processo_id): `id` já é PK, então é trivialmente única;
-- existe só para permitir a FK composta abaixo.
ALTER TABLE containers ADD CONSTRAINT containers_id_processo_unique UNIQUE (id, processo_id);

ALTER TABLE demurrage_pos_commit_outbox
  ADD CONSTRAINT demurrage_pos_commit_outbox_container_processo_fk
  FOREIGN KEY (container_id, processo_id) REFERENCES containers (id, processo_id);

ALTER TABLE demurrage_pos_commit_outbox DROP CONSTRAINT demurrage_pos_commit_outbox_estado_check;
ALTER TABLE demurrage_pos_commit_outbox ADD CONSTRAINT demurrage_pos_commit_outbox_estado_check
  CHECK (estado IN ('pendente', 'processando', 'concluido', 'falha'));
ALTER TABLE demurrage_pos_commit_outbox
  ADD COLUMN claim_token UUID,
  ADD COLUMN worker_id TEXT,
  ADD COLUMN expira_em TIMESTAMPTZ,
  -- Cada novo registro que exige reprocessamento incrementa a geração; a
  -- finalização só conclui se a geração reivindicada ainda for a vigente
  -- (senão volta a pendente — nenhum pedido novo se perde durante um claim).
  ADD COLUMN geracao INTEGER NOT NULL DEFAULT 1;
ALTER TABLE demurrage_pos_commit_outbox ADD CONSTRAINT demurrage_pos_commit_outbox_claim
  CHECK ((estado = 'processando') = (claim_token IS NOT NULL AND worker_id IS NOT NULL AND expira_em IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3) Avisos aos gestores de cada fallback manual de Free Time.
-- ---------------------------------------------------------------------------
CREATE TABLE demurrage_fallback_manual_avisos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  justificativa_id UUID NOT NULL REFERENCES demurrage_fallback_manual_justificativas(id),
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
  CONSTRAINT demurrage_fallback_manual_avisos_unico UNIQUE (justificativa_id, destinatario_membership_id),
  CONSTRAINT demurrage_fallback_manual_avisos_membership_org_fk FOREIGN KEY (destinatario_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT demurrage_fallback_manual_avisos_claim
    CHECK ((status = 'PROCESSING') = (claim_token IS NOT NULL AND worker_id IS NOT NULL AND expira_em IS NOT NULL))
);
CREATE INDEX demurrage_fallback_manual_avisos_status_idx ON demurrage_fallback_manual_avisos (status, criado_em);
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON demurrage_fallback_manual_avisos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
