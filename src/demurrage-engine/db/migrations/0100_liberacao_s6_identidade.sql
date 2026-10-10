-- Liberação S6 — identidade central de Processo e Master (N-3, N-4, N-14, N-16, N-18).
--
-- Migration ADITIVA: 0001–0034 não são tocadas. `processos` continua sendo a
-- tabela central do Processo e não recebe coluna, constraint nem trigger; o S6
-- só insere (organization_id, numero_processo). Aqui mora SÓ identidade: nenhuma
-- regra de Liberação, Demurrage, Courier ou Auditoria, e nenhuma cópia de MBL/HBL
-- em `processos`. O vínculo Processo↔Master é fato do S2, não do S6.
--
-- Requer PostgreSQL 15+ (NULLS NOT DISTINCT): o armador não declarado (NULL) é
-- um valor da chave de idempotência, não "qualquer valor".
--
-- Referências são append-only. Uma referência cuja evidência foi provada
-- inválida (N-14) continua no histórico, mas deixa de resolver identidade: a
-- invalidação é uma linha terminal em `identidade_pendencias`
-- (motivo EVIDENCIA_INVALIDADA, estado ENCERRADA_POR_EVIDENCIA_INVALIDA) que
-- aponta para a referência. Uma evidência nova válida pode restabelecer a mesma
-- referência numa GERAÇÃO seguinte; a geração k só existe se a k-1 foi
-- invalidada, então há no máximo uma geração ativa por referência.
-- Invalidar evidência é mudança material (N-16): reavalia, na hora, só as
-- pendências da chave afetada; as que mudam guardam a causa
-- (`causa_invalidacao_id`).

-- ---------------------------------------------------------------------------
-- Referências do Processo.
--   ORIGEM: proveniência da criação do processo pelo S6 (código completo +
--           origem documental). Uma por processo; não é invalidável. Se o
--           código já foi um alias invalidado, ocupa a geração seguinte.
--   ALIAS:  referência alternativa comprovada por evidência inequívoca na mesma
--           organização (N-3). Um código completo de OUTRO processo nunca vira
--           alias (IM2151, IM2151-26 e IM2151-026 são identidades distintas).
-- ---------------------------------------------------------------------------
CREATE TABLE processo_referencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ORIGEM', 'ALIAS')),
  referencia_original TEXT NOT NULL,
  referencia TEXT NOT NULL CHECK (referencia <> ''),
  geracao INTEGER NOT NULL DEFAULT 1 CHECK (geracao >= 1),
  fonte TEXT NOT NULL CHECK (btrim(fonte) <> ''),
  evidencia_ref TEXT NOT NULL CHECK (btrim(evidencia_ref) <> ''),
  observado_em TIMESTAMPTZ NOT NULL,
  registrado_por_membership_id UUID,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT processo_referencias_processo_fk
    FOREIGN KEY (processo_id, organization_id) REFERENCES processos (id, organization_id),
  CONSTRAINT processo_referencias_membership_fk
    FOREIGN KEY (registrado_por_membership_id, organization_id) REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT processo_referencias_org_referencia_unique UNIQUE (organization_id, referencia, geracao),
  CONSTRAINT processo_referencias_id_org_unique UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX processo_referencias_uma_origem ON processo_referencias (processo_id) WHERE tipo = 'ORIGEM';

CREATE TRIGGER processo_referencias_append_only BEFORE UPDATE OR DELETE ON processo_referencias
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION check_processo_referencia_geracao() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.geracao > 1 AND NOT EXISTS (
    SELECT 1 FROM processo_referencias r JOIN identidade_pendencias i ON i.processo_referencia_id = r.id
     WHERE r.organization_id = NEW.organization_id AND r.referencia = NEW.referencia AND r.geracao = NEW.geracao - 1) THEN
    RAISE EXCEPTION 'processo_referencias: % geracao % exige a geracao anterior invalidada', NEW.referencia, NEW.geracao;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER processo_referencias_geracao BEFORE INSERT ON processo_referencias
  FOR EACH ROW EXECUTE FUNCTION check_processo_referencia_geracao();

-- ---------------------------------------------------------------------------
-- Master: só o UUID próprio na organização (N-18). Sem coluna de MBL ou
-- armador e sem outra unicidade: organização + MBL não é identidade infalível.
-- ---------------------------------------------------------------------------
CREATE TABLE masters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT masters_id_org_unique UNIQUE (id, organization_id)
);

CREATE TRIGGER masters_append_only BEFORE UPDATE OR DELETE ON masters
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Referências do Master: uma linha por forma distinta (chave canônica + armador
-- DECLARADO) e geração, com a primeira evidência. Reobservar a mesma forma não
-- grava nada (NULLS NOT DISTINCT: armador NULL repetido também é a mesma forma).
-- Busca por (organization_id, chave_canonica), sem unicidade.
-- ---------------------------------------------------------------------------
CREATE TABLE master_referencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  master_id UUID NOT NULL,
  mbl_original TEXT NOT NULL,
  mbl_limpo TEXT NOT NULL CHECK (mbl_limpo <> ''),
  chave_canonica TEXT NOT NULL CHECK (chave_canonica <> ''),
  -- armador declarado pela fonte (código de tracking); NULL = não declarado. Nunca inferido.
  armador_codigo TEXT CHECK (armador_codigo ~ '^[a-z0-9]+$'),
  geracao INTEGER NOT NULL DEFAULT 1 CHECK (geracao >= 1),
  regra TEXT NOT NULL,
  fonte TEXT NOT NULL CHECK (btrim(fonte) <> ''),
  evidencia_ref TEXT NOT NULL CHECK (btrim(evidencia_ref) <> ''),
  observado_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT master_referencias_master_fk
    FOREIGN KEY (master_id, organization_id) REFERENCES masters (id, organization_id),
  CONSTRAINT master_referencias_forma_unique
    UNIQUE NULLS NOT DISTINCT (master_id, chave_canonica, armador_codigo, geracao),
  CONSTRAINT master_referencias_id_org_unique UNIQUE (id, organization_id)
);

CREATE INDEX master_referencias_org_chave_idx ON master_referencias (organization_id, chave_canonica);

CREATE TRIGGER master_referencias_append_only BEFORE UPDATE OR DELETE ON master_referencias
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION check_master_referencia_geracao() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.geracao > 1 AND NOT EXISTS (
    SELECT 1 FROM master_referencias r JOIN identidade_pendencias i ON i.master_referencia_id = r.id
     WHERE r.master_id = NEW.master_id AND r.chave_canonica = NEW.chave_canonica
       AND r.armador_codigo IS NOT DISTINCT FROM NEW.armador_codigo AND r.geracao = NEW.geracao - 1) THEN
    RAISE EXCEPTION 'master_referencias: % geracao % exige a geracao anterior invalidada', NEW.chave_canonica, NEW.geracao;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER master_referencias_geracao BEFORE INSERT ON master_referencias
  FOR EACH ROW EXECUTE FUNCTION check_master_referencia_geracao();

-- ---------------------------------------------------------------------------
-- Pendência de identidade: uma por EVIDÊNCIA (organização + entidade + motivo +
-- chave + armador + fonte + evidência), entre as ativas e as encerradas porque a
-- PRÓPRIA evidência é inválida. Reingerir a mesma evidência nunca abre outra
-- (N-16). Uma pendência resolvida, ou encerrada porque a evidência do OUTRO lado
-- caiu, fica no histórico e não impede que a evidência volte a ficar pendente.
--   REFERENCIA_INCOMPLETA / PROCESSO_NAO_ENCONTRADO: referência sem identidade;
--   ALIAS_CONFLITANTE: evidência de alias que contradiz uma identidade ativa
--     (a referência é código de outro processo ou já é alias de outro); guarda o
--     processo indicado pela evidência; nada é fundido nem sobrescrito;
--   ARMADOR_INCOMPATIVEL: referência de Master incompatível com o Master da chave
--     (ou com o prefixo do próprio MBL); nada é anexado nem criado;
--   MASTER_NAO_ENCONTRADO: referência de Master que ficou sem candidato válido
--     depois de uma invalidação; nenhuma identidade é inventada;
--   EVIDENCIA_INVALIDADA: registro terminal de que a evidência de um ALIAS ou de
--     uma referência de Master foi provada inválida; nasce encerrado.
--
-- Estados do N-14. Nenhuma escolha humana livre resolve identidade:
--   EM_ANALISE                       — autor e data; não resolve nada;
--   ENCERRADA_POR_EVIDENCIA_INVALIDA — exige autor, justificativa e a evidência
--                                      da invalidade;
--   RESOLVIDA_PELA_FONTE_DE_VERDADE  — só por nova observação registrada que
--                                      elimina a causa, com a evidência dela,
--                                      ou porque a evidência do outro lado foi
--                                      invalidada (causa_invalidacao_id).
-- Evidências válidas e incompatíveis mantêm a pendência aberta, mesmo após análise.
-- Estados finais são terminais; os fatos de origem da pendência são imutáveis.
-- ---------------------------------------------------------------------------
CREATE TABLE identidade_pendencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  entidade_tipo TEXT NOT NULL CHECK (entidade_tipo IN ('PROCESSO', 'MASTER')),
  motivo TEXT NOT NULL,
  referencia_original TEXT NOT NULL,
  chave TEXT NOT NULL CHECK (chave <> ''),
  armador_codigo TEXT CHECK (armador_codigo ~ '^[a-z0-9]+$'),
  fonte TEXT NOT NULL CHECK (btrim(fonte) <> ''),
  evidencia_ref TEXT NOT NULL CHECK (btrim(evidencia_ref) <> ''),
  observado_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  estado TEXT NOT NULL DEFAULT 'ABERTA'
    CHECK (estado IN ('ABERTA', 'EM_ANALISE', 'ENCERRADA_POR_EVIDENCIA_INVALIDA', 'RESOLVIDA_PELA_FONTE_DE_VERDADE')),
  em_analise_em TIMESTAMPTZ,
  em_analise_por_membership_id UUID,
  decidido_em TIMESTAMPTZ,
  decidido_por_membership_id UUID,
  justificativa TEXT,
  resolucao_fonte TEXT,
  resolucao_evidencia_ref TEXT,
  processo_indicado_id UUID,
  resolvido_processo_id UUID,
  resolvido_master_id UUID,
  processo_referencia_id UUID,
  master_referencia_id UUID,
  -- invalidação (EVIDENCIA_INVALIDADA ou pendência encerrada) que fez esta pendência mudar
  causa_invalidacao_id UUID,
  CONSTRAINT identidade_pendencias_motivo CHECK (
    (entidade_tipo = 'PROCESSO' AND armador_codigo IS NULL
      AND motivo IN ('REFERENCIA_INCOMPLETA', 'PROCESSO_NAO_ENCONTRADO', 'ALIAS_CONFLITANTE', 'EVIDENCIA_INVALIDADA'))
    OR (entidade_tipo = 'MASTER' AND motivo IN ('ARMADOR_INCOMPATIVEL', 'MASTER_NAO_ENCONTRADO', 'EVIDENCIA_INVALIDADA'))),
  CONSTRAINT identidade_pendencias_causa_forma CHECK (
    causa_invalidacao_id IS NULL OR estado IN ('ENCERRADA_POR_EVIDENCIA_INVALIDA', 'RESOLVIDA_PELA_FONTE_DE_VERDADE')),
  CONSTRAINT identidade_pendencias_indicado_forma CHECK ((motivo = 'ALIAS_CONFLITANTE') = (processo_indicado_id IS NOT NULL)),
  CONSTRAINT identidade_pendencias_invalidacao_forma CHECK (
    (motivo = 'EVIDENCIA_INVALIDADA') = (processo_referencia_id IS NOT NULL OR master_referencia_id IS NOT NULL)
    AND (processo_referencia_id IS NULL OR entidade_tipo = 'PROCESSO')
    AND (master_referencia_id IS NULL OR entidade_tipo = 'MASTER')
    AND (motivo <> 'EVIDENCIA_INVALIDADA' OR estado = 'ENCERRADA_POR_EVIDENCIA_INVALIDA')),
  CONSTRAINT identidade_pendencias_analise_forma CHECK ((em_analise_em IS NULL) = (em_analise_por_membership_id IS NULL)),
  CONSTRAINT identidade_pendencias_estado_forma CHECK (
    CASE estado
      WHEN 'ABERTA' THEN em_analise_em IS NULL
        AND decidido_em IS NULL AND decidido_por_membership_id IS NULL AND justificativa IS NULL
        AND resolucao_fonte IS NULL AND resolucao_evidencia_ref IS NULL
        AND resolvido_processo_id IS NULL AND resolvido_master_id IS NULL
      WHEN 'EM_ANALISE' THEN em_analise_em IS NOT NULL
        AND decidido_em IS NULL AND decidido_por_membership_id IS NULL AND justificativa IS NULL
        AND resolucao_fonte IS NULL AND resolucao_evidencia_ref IS NULL
        AND resolvido_processo_id IS NULL AND resolvido_master_id IS NULL
      WHEN 'ENCERRADA_POR_EVIDENCIA_INVALIDA' THEN decidido_em IS NOT NULL AND decidido_por_membership_id IS NOT NULL
        AND btrim(coalesce(justificativa, '')) <> ''
        AND btrim(coalesce(resolucao_fonte, '')) <> '' AND btrim(coalesce(resolucao_evidencia_ref, '')) <> ''
        AND resolvido_processo_id IS NULL AND resolvido_master_id IS NULL
      WHEN 'RESOLVIDA_PELA_FONTE_DE_VERDADE' THEN decidido_em IS NOT NULL AND justificativa IS NULL
        AND btrim(coalesce(resolucao_fonte, '')) <> '' AND btrim(coalesce(resolucao_evidencia_ref, '')) <> ''
        AND CASE entidade_tipo
              WHEN 'PROCESSO' THEN resolvido_processo_id IS NOT NULL AND resolvido_master_id IS NULL
              ELSE resolvido_master_id IS NOT NULL AND resolvido_processo_id IS NULL
            END
    END),
  CONSTRAINT identidade_pendencias_em_analise_membership_fk
    FOREIGN KEY (em_analise_por_membership_id, organization_id) REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT identidade_pendencias_decidido_membership_fk
    FOREIGN KEY (decidido_por_membership_id, organization_id) REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT identidade_pendencias_indicado_fk
    FOREIGN KEY (processo_indicado_id, organization_id) REFERENCES processos (id, organization_id),
  CONSTRAINT identidade_pendencias_processo_fk
    FOREIGN KEY (resolvido_processo_id, organization_id) REFERENCES processos (id, organization_id),
  CONSTRAINT identidade_pendencias_master_fk
    FOREIGN KEY (resolvido_master_id, organization_id) REFERENCES masters (id, organization_id),
  CONSTRAINT identidade_pendencias_processo_referencia_fk
    FOREIGN KEY (processo_referencia_id, organization_id) REFERENCES processo_referencias (id, organization_id),
  CONSTRAINT identidade_pendencias_master_referencia_fk
    FOREIGN KEY (master_referencia_id, organization_id) REFERENCES master_referencias (id, organization_id),
  CONSTRAINT identidade_pendencias_uma_invalidacao_alias UNIQUE (processo_referencia_id),
  CONSTRAINT identidade_pendencias_uma_invalidacao_master UNIQUE (master_referencia_id),
  CONSTRAINT identidade_pendencias_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT identidade_pendencias_causa_fk
    FOREIGN KEY (causa_invalidacao_id, organization_id) REFERENCES identidade_pendencias (id, organization_id)
);

CREATE UNIQUE INDEX identidade_pendencias_evidencia_unique ON identidade_pendencias
  (organization_id, entidade_tipo, motivo, chave, armador_codigo, fonte, evidencia_ref) NULLS NOT DISTINCT
  WHERE estado IN ('ABERTA', 'EM_ANALISE') OR (estado = 'ENCERRADA_POR_EVIDENCIA_INVALIDA' AND causa_invalidacao_id IS NULL);

CREATE INDEX identidade_pendencias_abertas_idx ON identidade_pendencias (organization_id, entidade_tipo, chave)
  WHERE estado IN ('ABERTA', 'EM_ANALISE');

CREATE OR REPLACE FUNCTION check_identidade_pendencia_transicao() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.motivo <> 'EVIDENCIA_INVALIDADA' AND NEW.estado <> 'ABERTA' THEN
      RAISE EXCEPTION 'identidade_pendencias: pendencia de motivo % nasce ABERTA', NEW.motivo;
    END IF;
    IF NEW.processo_referencia_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM processo_referencias WHERE id = NEW.processo_referencia_id AND tipo = 'ALIAS') THEN
      RAISE EXCEPTION 'identidade_pendencias: so a evidencia de um ALIAS de processo e invalidavel';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'identidade_pendencias: DELETE nao e permitido (pendencia %)', OLD.id;
  END IF;
  IF OLD.estado IN ('ENCERRADA_POR_EVIDENCIA_INVALIDA', 'RESOLVIDA_PELA_FONTE_DE_VERDADE') THEN
    RAISE EXCEPTION 'identidade_pendencias: pendencia % ja esta no estado final %', OLD.id, OLD.estado;
  END IF;
  IF (NEW.entidade_tipo, NEW.motivo, NEW.referencia_original, NEW.chave, NEW.armador_codigo,
      NEW.fonte, NEW.evidencia_ref, NEW.observado_em, NEW.criado_em, NEW.processo_indicado_id,
      NEW.processo_referencia_id, NEW.master_referencia_id)
     IS DISTINCT FROM
     (OLD.entidade_tipo, OLD.motivo, OLD.referencia_original, OLD.chave, OLD.armador_codigo,
      OLD.fonte, OLD.evidencia_ref, OLD.observado_em, OLD.criado_em, OLD.processo_indicado_id,
      OLD.processo_referencia_id, OLD.master_referencia_id) THEN
    RAISE EXCEPTION 'identidade_pendencias: os fatos de origem da pendencia % sao imutaveis', OLD.id;
  END IF;
  IF OLD.estado = 'EM_ANALISE' AND NEW.estado = 'ABERTA' THEN
    RAISE EXCEPTION 'identidade_pendencias: pendencia % nao volta de EM_ANALISE para ABERTA', OLD.id;
  END IF;
  IF OLD.em_analise_em IS NOT NULL
     AND (NEW.em_analise_em, NEW.em_analise_por_membership_id) IS DISTINCT FROM (OLD.em_analise_em, OLD.em_analise_por_membership_id) THEN
    RAISE EXCEPTION 'identidade_pendencias: o registro de analise da pendencia % e imutavel', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER identidade_pendencias_transicao BEFORE INSERT OR UPDATE OR DELETE ON identidade_pendencias
  FOR EACH ROW EXECUTE FUNCTION check_identidade_pendencia_transicao();

-- ---------------------------------------------------------------------------
-- Organização imutável em toda tabela de tenant (regra padrão da 0007).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tabela TEXT;
BEGIN
  FOREACH tabela IN ARRAY ARRAY['processo_referencias', 'masters', 'master_referencias', 'identidade_pendencias'] LOOP
    EXECUTE format(
      'CREATE TRIGGER organization_id_immutable BEFORE UPDATE ON %I
         FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
         EXECUTE FUNCTION forbid_organization_change()',
      tabela
    );
  END LOOP;
END $$;
