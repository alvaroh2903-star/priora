-- Liberação — documentos de apresentação (decisões 14.1–14.9). Dono: Liberação (domínio documental).
--
-- Migration ADITIVA: nenhuma tabela anterior muda. Identidade, vínculo e autoria
-- vêm das tabelas dos donos (S6 `masters`/`processos`, S2 `auditoria_extracoes`,
-- S4 `organization_memberships`). As tabelas seguem o nome do domínio
-- (`documentos_apresentacao*`, plano §7); o prefixo `liberacao_` continua
-- reservado à projeção da L2. Toda tabela carrega `organization_id` imutável
-- (regra da 0007) e só referencia linhas da MESMA organização (FKs compostas).
--
-- Por que cada tabela existe (nenhuma infraestrutura existente guarda isto):
--   1) documentos_apresentacao_modelos — versões dos modelos oficiais: o arquivo,
--      a leitura (definição) validada por uma pessoa e o estado (pendente,
--      validado, rejeitado pela agência, descartado). Atualização reativa: só muda
--      por cadastro, validação, rejeição comprovada ou substituto recebido.
--   2) documentos_apresentacao — DOCUMENTO PREPARADO: o PDF gerado, o conteúdo
--      material, a proveniência de cada valor, a origem de cada opção (regra ou
--      Analista), a versão de modelo e o gerador. Idempotente (N-16).
--   3) documentos_apresentacao_processos — snapshot dos processos vinculados ao
--      Master na preparação (N-15), com integridade referencial para `processos`
--      (um array não teria FK).
--   4) documentos_apresentacao_assinaturas — ARQUIVO ASSINADO, só do termo
--      Evergreen (ciclo completo, DOC-31: MSC, Hapag-Lloyd e ZIM são assinados
--      e encaminhados fora da Priora e nada assinado deles é guardado): o PDF com a
--      assinatura digital do SIGNATÁRIO LEGAL (aplicada fora da Priora, DOC-23),
--      quem o ANEXOU (operador — não é o signatário), a identidade esperada e,
--      se for o caso, a substituição justificada de um arquivo anterior da mesma
--      versão (cadeia linear; o anterior nunca muda — DOC-25, DOC-30). Nunca o
--      próprio PDF preparado; o mesmo arquivo nunca serve a dois registros.
--   4b) documentos_apresentacao_conferencias — CONFERÊNCIA HUMANA do arquivo
--      assinado (DOC-20, DOC-24): quem conferiu, quando, qual arquivo (hash), a
--      identidade esperada, o resultado e a constatação quando recusado.
--      Append-only e amarrada a UM registro de assinatura: um novo arquivo
--      assinado é outro registro e exige nova conferência.
--
-- Revisão DOC-22/23 (2026-10-15), feita NESTE arquivo porque a 0104 ainda não
-- foi aplicada em nenhum ambiente real (só no banco temporário de testes): a
-- regra antiga "só quem preparou registra o arquivo assinado" (preparador =
-- signatário, DOC-16) saiu; `assinado_por_membership_id` virou
-- `registrado_por_membership_id` (o operador); entraram a identidade do
-- signatário legal (documento, arquivo e conferência), a cadeia de
-- substituições e a constatação da conferência. Revisão DOC-31 (2026-10-15),
-- pelo mesmo motivo: o gatilho do arquivo assinado passou a aceitar só documento
-- do termo Evergreen (a conferência e o envio dependem dele por FK, então valem
-- só para o termo também). Nenhum documento preparado é obrigado a ter
-- assinatura, conferência, tentativa de envio ou registro de Outlook. Depois de
-- aplicada em ambiente real, mudanças aqui só por nova migration.
--   5) documentos_apresentacao_envios — TENTATIVA de envio no Outlook do PRÓPRIO
--      Analista: estado atual, composição, rascunho, confirmação lida do Graph,
--      reenvio (de qual envio, motivo, quem autorizou). Uma tentativa aberta por
--      Master e fluxo; um reenvio por envio confirmado.
--   6) documentos_apresentacao_eventos — histórico append-only das mudanças de
--      modelos e de tentativas (estado anterior/novo, autor, evidência).
-- Apresentação comprovada NÃO mora aqui: continua sendo evidência da agência (L1b).
--
-- Reversão (o runner só aplica para frente; para desfazer, em transação):
--   DROP TABLE documentos_apresentacao_eventos, documentos_apresentacao_envios, documentos_apresentacao_conferencias,
--     documentos_apresentacao_assinaturas, documentos_apresentacao_processos,
--     documentos_apresentacao, documentos_apresentacao_modelos;
--   DROP FUNCTION check_transicao_modelo_apresentacao(), check_assinatura_diferente_do_preparado(),
--     check_conferencia_do_arquivo_assinado(), check_envio_apresentacao_reenvio(), check_transicao_envio_apresentacao();
--   DELETE FROM schema_migrations WHERE filename = '0104_liberacao_documentos_apresentacao.sql';

-- ---------------------------------------------------------------------------
-- 1) Versões dos modelos oficiais
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao_modelos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR')),
  versao TEXT NOT NULL CHECK (btrim(versao) <> ''),
  arquivo BYTEA NOT NULL CHECK (octet_length(arquivo) > 0),
  arquivo_sha256 TEXT NOT NULL CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  origem TEXT NOT NULL CHECK (origem IN ('CADASTRO', 'SUBSTITUTO_DA_AGENCIA')),
  substitui_modelo_id UUID,
  -- Substituto: e-mail e anexo da agência de onde ele veio.
  evidencia JSONB,
  definicao JSONB,
  estado TEXT NOT NULL DEFAULT 'PENDENTE_DE_VALIDACAO'
    CHECK (estado IN ('PENDENTE_DE_VALIDACAO', 'VALIDADO', 'REJEITADO_PELA_AGENCIA', 'DESCARTADO')),
  cadastrado_por_membership_id UUID,
  cadastrado_em TIMESTAMPTZ NOT NULL,
  validado_por_membership_id UUID,
  validado_em TIMESTAMPTZ,
  rejeicao JSONB,
  rejeitado_em TIMESTAMPTZ,
  descartado_em TIMESTAMPTZ,
  CONSTRAINT documentos_apresentacao_modelos_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT documentos_apresentacao_modelos_arquivo_unico UNIQUE (organization_id, tipo, arquivo_sha256),
  CONSTRAINT documentos_apresentacao_modelos_versao_unica UNIQUE (organization_id, tipo, versao),
  CONSTRAINT documentos_apresentacao_modelos_substitui_fk FOREIGN KEY (substitui_modelo_id, organization_id)
    REFERENCES documentos_apresentacao_modelos (id, organization_id),
  CONSTRAINT documentos_apresentacao_modelos_cadastro_fk FOREIGN KEY (cadastrado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_apresentacao_modelos_validacao_fk FOREIGN KEY (validado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_apresentacao_modelos_origem CHECK (
    (origem = 'CADASTRO' AND cadastrado_por_membership_id IS NOT NULL AND substitui_modelo_id IS NULL)
    OR (origem = 'SUBSTITUTO_DA_AGENCIA' AND substitui_modelo_id IS NOT NULL AND evidencia IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_modelos_validado CHECK (
    (estado IN ('VALIDADO', 'REJEITADO_PELA_AGENCIA'))
      = (validado_em IS NOT NULL AND validado_por_membership_id IS NOT NULL AND definicao IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_modelos_rejeitado CHECK ((estado = 'REJEITADO_PELA_AGENCIA') = (rejeitado_em IS NOT NULL AND rejeicao IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_modelos_descartado CHECK ((estado = 'DESCARTADO') = (descartado_em IS NOT NULL))
);

-- Transições: PENDENTE → VALIDADO | DESCARTADO; VALIDADO → REJEITADO_PELA_AGENCIA.
-- A leitura (definição) só muda enquanto pendente; arquivo, origem e autoria nunca.
CREATE OR REPLACE FUNCTION check_transicao_modelo_apresentacao() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documentos_apresentacao_modelos: versão de modelo não pode ser apagada';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.tipo, NEW.versao, NEW.arquivo_sha256, NEW.origem, NEW.substitui_modelo_id, NEW.evidencia,
      NEW.cadastrado_por_membership_id, NEW.cadastrado_em)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.tipo, OLD.versao, OLD.arquivo_sha256, OLD.origem, OLD.substitui_modelo_id, OLD.evidencia,
      OLD.cadastrado_por_membership_id, OLD.cadastrado_em)
     OR NEW.arquivo IS DISTINCT FROM OLD.arquivo THEN
    RAISE EXCEPTION 'documentos_apresentacao_modelos: arquivo, origem e cadastro são imutáveis';
  END IF;
  IF NEW.estado = OLD.estado THEN
    IF OLD.estado <> 'PENDENTE_DE_VALIDACAO' OR NEW.definicao IS NOT DISTINCT FROM OLD.definicao THEN
      RAISE EXCEPTION 'documentos_apresentacao_modelos: só a leitura de uma versão pendente pode mudar sem transição';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.estado = 'PENDENTE_DE_VALIDACAO' AND NEW.estado IN ('VALIDADO', 'DESCARTADO'))
       OR (OLD.estado = 'VALIDADO' AND NEW.estado = 'REJEITADO_PELA_AGENCIA')) THEN
    RAISE EXCEPTION 'documentos_apresentacao_modelos: transição % → % não permitida', OLD.estado, NEW.estado;
  END IF;
  IF OLD.estado = 'VALIDADO' AND (NEW.definicao IS DISTINCT FROM OLD.definicao OR NEW.validado_em IS DISTINCT FROM OLD.validado_em
      OR NEW.validado_por_membership_id IS DISTINCT FROM OLD.validado_por_membership_id) THEN
    RAISE EXCEPTION 'documentos_apresentacao_modelos: a leitura validada é imutável';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_apresentacao_modelos_transicao BEFORE UPDATE OR DELETE ON documentos_apresentacao_modelos
  FOR EACH ROW EXECUTE FUNCTION check_transicao_modelo_apresentacao();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao_modelos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 2) Documento preparado
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordem de registro (desempate determinístico entre documentos do mesmo instante; o UUID não tem ordem).
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  master_id UUID NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('TERMO_EVERGREEN', 'MEMORANDO_MSC', 'MEMORANDO_HAPAG_ROCHAMAR', 'MEMORANDO_ZIM_ROCHAMAR')),
  modelo_id UUID NOT NULL,
  conteudo JSONB NOT NULL,
  conteudo_sha256 TEXT NOT NULL CHECK (conteudo_sha256 ~ '^[0-9a-f]{64}$'),
  proveniencia JSONB NOT NULL,
  selecoes JSONB NOT NULL DEFAULT '[]'::jsonb,
  escolhas JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Valores que só o Analista conhece (ex.: data/hora combinada com a agência), com autor e instante.
  informados JSONB NOT NULL DEFAULT '[]'::jsonb,
  gerador TEXT NOT NULL CHECK (btrim(gerador) <> ''),
  gerador_versao TEXT NOT NULL CHECK (btrim(gerador_versao) <> ''),
  arquivo BYTEA NOT NULL CHECK (octet_length(arquivo) > 0),
  arquivo_sha256 TEXT NOT NULL CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  preparado_em TIMESTAMPTZ NOT NULL,
  -- O preparador (quem acionou a geração). Não é o signatário (DOC-22/23).
  preparado_por_membership_id UUID NOT NULL,
  -- Identidade do signatário legal REPRESENTADA no documento (cadastro confiável; não é membership: o signatário não
  -- precisa ser usuário da Priora). Nulos juntos quando o modelo não tem campos de quem assina.
  signatario_id TEXT,
  signatario_nome TEXT,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documentos_apresentacao_master_fk FOREIGN KEY (master_id, organization_id)
    REFERENCES masters (id, organization_id),
  CONSTRAINT documentos_apresentacao_modelo_fk FOREIGN KEY (modelo_id, organization_id)
    REFERENCES documentos_apresentacao_modelos (id, organization_id),
  CONSTRAINT documentos_apresentacao_autor_fk FOREIGN KEY (preparado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_apresentacao_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT documentos_apresentacao_idempotencia UNIQUE (organization_id, master_id, tipo, conteudo_sha256, gerador, gerador_versao),
  CONSTRAINT documentos_apresentacao_signatario CHECK ((signatario_id IS NULL) = (signatario_nome IS NULL)
    AND (signatario_id IS NULL OR (btrim(signatario_id) <> '' AND btrim(signatario_nome) <> '')))
);
CREATE INDEX documentos_apresentacao_master_idx ON documentos_apresentacao (organization_id, master_id, tipo, preparado_em);

CREATE TRIGGER documentos_apresentacao_append_only BEFORE UPDATE OR DELETE ON documentos_apresentacao
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 3) Processos vinculados na preparação (snapshot)
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao_processos (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  documento_id UUID NOT NULL,
  processo_id UUID NOT NULL,
  PRIMARY KEY (documento_id, processo_id),
  CONSTRAINT documentos_apresentacao_processos_documento_fk FOREIGN KEY (documento_id, organization_id)
    REFERENCES documentos_apresentacao (id, organization_id),
  CONSTRAINT documentos_apresentacao_processos_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id)
);

CREATE TRIGGER documentos_apresentacao_processos_append_only BEFORE UPDATE OR DELETE ON documentos_apresentacao_processos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao_processos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4) Assinatura humana
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao_assinaturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  documento_id UUID NOT NULL,
  arquivo BYTEA NOT NULL CHECK (octet_length(arquivo) > 0),
  arquivo_sha256 TEXT NOT NULL CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  -- O OPERADOR: quem anexou/registrou o arquivo (qualquer pessoa interna autorizada — DOC-22). Nunca é tomado como signatário.
  registrado_por_membership_id UUID NOT NULL,
  registrado_em TIMESTAMPTZ NOT NULL,
  -- O que os bytes mostram: assinatura digital aplicada SOBRE o PDF preparado, assinatura sem vínculo verificável, ou nenhuma
  -- (ex.: digitalização de assinatura à mão). Não valida certificado.
  verificacao TEXT NOT NULL CHECK (verificacao IN ('INDICIO_DE_ASSINATURA_DIGITAL_SOBRE_O_PREPARADO', 'INDICIO_DE_ASSINATURA_DIGITAL_SEM_VINCULO', 'SEM_INDICIO_DE_ASSINATURA_DIGITAL')),
  -- Identidade do signatário legal esperada no certificado: a do documento (trigger abaixo).
  signatario_esperado_id TEXT,
  signatario_esperado_nome TEXT,
  -- Substituição de um arquivo anterior da MESMA versão (DOC-25, DOC-30): motivo e justificativa obrigatórios.
  substitui_assinatura_id UUID,
  substituicao_motivo TEXT CHECK (substituicao_motivo IN ('ARQUIVO_ANTERIOR_NAO_CONFORME', 'ALTERACAO_APOS_ASSINATURA', 'OUTRO')),
  substituicao_justificativa TEXT,
  CONSTRAINT documentos_apresentacao_assinaturas_documento_fk FOREIGN KEY (documento_id, organization_id)
    REFERENCES documentos_apresentacao (id, organization_id),
  CONSTRAINT documentos_apresentacao_assinaturas_autor_fk FOREIGN KEY (registrado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  -- O mesmo arquivo assinado nunca sustenta dois registros (nem de outro documento ou versão).
  CONSTRAINT documentos_apresentacao_assinaturas_arquivo_unico UNIQUE (organization_id, arquivo_sha256),
  CONSTRAINT documentos_apresentacao_assinaturas_id_doc_org_unique UNIQUE (id, documento_id, organization_id),
  -- Substitui um registro do MESMO documento e organização.
  CONSTRAINT documentos_apresentacao_assinaturas_substitui_fk FOREIGN KEY (substitui_assinatura_id, documento_id, organization_id)
    REFERENCES documentos_apresentacao_assinaturas (id, documento_id, organization_id),
  -- Cadeia linear: cada registro é substituído no máximo uma vez.
  CONSTRAINT documentos_apresentacao_assinaturas_substituida_uma_vez UNIQUE (substitui_assinatura_id),
  CONSTRAINT documentos_apresentacao_assinaturas_substituicao CHECK (
    (substitui_assinatura_id IS NULL) = (substituicao_motivo IS NULL) AND (substitui_assinatura_id IS NULL) = (substituicao_justificativa IS NULL)
    AND (substituicao_justificativa IS NULL OR btrim(substituicao_justificativa) <> '')),
  CONSTRAINT documentos_apresentacao_assinaturas_signatario CHECK ((signatario_esperado_id IS NULL) = (signatario_esperado_nome IS NULL))
);
-- Um só PRIMEIRO arquivo por documento: os demais entram como substituição (sem arquivos paralelos em silêncio).
CREATE UNIQUE INDEX documentos_apresentacao_assinaturas_primeiro_unico ON documentos_apresentacao_assinaturas (documento_id)
  WHERE substitui_assinatura_id IS NULL;

CREATE OR REPLACE FUNCTION check_assinatura_diferente_do_preparado() RETURNS TRIGGER AS $$
BEGIN
  -- DOC-31: arquivo assinado só no ciclo completo (termo Evergreen). MSC, Hapag-Lloyd e ZIM terminam no PDF gerado.
  IF NOT EXISTS (SELECT 1 FROM documentos_apresentacao d
                  WHERE d.id = NEW.documento_id AND d.organization_id = NEW.organization_id AND d.tipo = 'TERMO_EVERGREEN') THEN
    RAISE EXCEPTION 'documentos_apresentacao_assinaturas: arquivo assinado só do termo Evergreen (MSC, Hapag-Lloyd e ZIM são assinados fora da Priora)';
  END IF;
  IF EXISTS (SELECT 1 FROM documentos_apresentacao d WHERE d.id = NEW.documento_id AND d.arquivo_sha256 = NEW.arquivo_sha256) THEN
    RAISE EXCEPTION 'documentos_apresentacao_assinaturas: o arquivo assinado é idêntico ao PDF preparado (nenhuma assinatura)';
  END IF;
  -- DOC-22/23: qualquer pessoa interna autorizada anexa o arquivo (cliente nunca); quem anexa não é o signatário.
  IF EXISTS (SELECT 1 FROM organization_memberships m WHERE m.id = NEW.registrado_por_membership_id AND m.papel = 'CLIENT') THEN
    RAISE EXCEPTION 'documentos_apresentacao_assinaturas: cliente não anexa arquivo assinado';
  END IF;
  -- A identidade esperada é exatamente a representada no documento (nunca a de quem anexa).
  IF NOT EXISTS (SELECT 1 FROM documentos_apresentacao d
                  WHERE d.id = NEW.documento_id AND d.organization_id = NEW.organization_id
                    AND d.signatario_id IS NOT DISTINCT FROM NEW.signatario_esperado_id
                    AND d.signatario_nome IS NOT DISTINCT FROM NEW.signatario_esperado_nome) THEN
    RAISE EXCEPTION 'documentos_apresentacao_assinaturas: o signatário esperado não é o representado no documento';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_apresentacao_assinaturas_diferente BEFORE INSERT ON documentos_apresentacao_assinaturas
  FOR EACH ROW EXECUTE FUNCTION check_assinatura_diferente_do_preparado();
CREATE TRIGGER documentos_apresentacao_assinaturas_append_only BEFORE UPDATE OR DELETE ON documentos_apresentacao_assinaturas
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao_assinaturas
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 4b) Conferência humana do arquivo assinado (DOC-20)
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao_conferencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  documento_id UUID NOT NULL,
  assinatura_id UUID NOT NULL,
  -- O arquivo que a pessoa conferiu: tem de ser o do registro de assinatura (trigger abaixo).
  arquivo_sha256 TEXT NOT NULL CHECK (arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  resultado TEXT NOT NULL CHECK (resultado IN ('CONFORME', 'NAO_CONFORME')),
  -- O que a pessoa constatou no leitor de PDF ao recusar (só em NAO_CONFORME; nenhuma delas é conforme — DOC-25).
  constatacao TEXT CHECK (constatacao IN ('ASSINATURA_INVALIDA', 'DOCUMENTO_ALTERADO_APOS_ASSINATURA', 'INTEGRIDADE_NAO_CONFIRMADA',
    'SIGNATARIO_DIFERENTE_DO_ESPERADO', 'SEM_ASSINATURA_DIGITAL', 'CONTEUDO_DIVERGENTE_DO_PREPARADO', 'OUTRA')),
  -- Identidade que a pessoa devia ver no certificado: a do registro de assinatura (trigger abaixo).
  signatario_esperado_id TEXT,
  signatario_esperado_nome TEXT,
  conferido_por_membership_id UUID NOT NULL,
  conferido_em TIMESTAMPTZ NOT NULL,
  observacao TEXT,
  CONSTRAINT documentos_apresentacao_conferencias_assinatura_fk FOREIGN KEY (assinatura_id, documento_id, organization_id)
    REFERENCES documentos_apresentacao_assinaturas (id, documento_id, organization_id),
  CONSTRAINT documentos_apresentacao_conferencias_autor_fk FOREIGN KEY (conferido_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_apresentacao_conferencias_motivo CHECK (resultado <> 'NAO_CONFORME' OR btrim(coalesce(observacao, '')) <> ''),
  CONSTRAINT documentos_apresentacao_conferencias_constatacao CHECK ((resultado = 'NAO_CONFORME') = (constatacao IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_conferencias_signatario CHECK ((signatario_esperado_id IS NULL) = (signatario_esperado_nome IS NULL))
);
CREATE INDEX documentos_apresentacao_conferencias_documento_idx ON documentos_apresentacao_conferencias (organization_id, documento_id, conferido_em);

-- Nunca se confirma um arquivo diferente do registrado nem outra identidade; quem confere é pessoa interna (nunca CLIENT).
CREATE OR REPLACE FUNCTION check_conferencia_do_arquivo_assinado() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documentos_apresentacao_assinaturas a
                  WHERE a.id = NEW.assinatura_id AND a.organization_id = NEW.organization_id AND a.arquivo_sha256 = NEW.arquivo_sha256) THEN
    RAISE EXCEPTION 'documentos_apresentacao_conferencias: o arquivo conferido não é o do registro de assinatura';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documentos_apresentacao_assinaturas a
                  WHERE a.id = NEW.assinatura_id AND a.organization_id = NEW.organization_id
                    AND a.signatario_esperado_id IS NOT DISTINCT FROM NEW.signatario_esperado_id
                    AND a.signatario_esperado_nome IS NOT DISTINCT FROM NEW.signatario_esperado_nome) THEN
    RAISE EXCEPTION 'documentos_apresentacao_conferencias: o signatário esperado não é o do arquivo assinado';
  END IF;
  IF EXISTS (SELECT 1 FROM organization_memberships m WHERE m.id = NEW.conferido_por_membership_id AND m.papel = 'CLIENT') THEN
    RAISE EXCEPTION 'documentos_apresentacao_conferencias: cliente não confere assinatura';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_apresentacao_conferencias_arquivo BEFORE INSERT ON documentos_apresentacao_conferencias
  FOR EACH ROW EXECUTE FUNCTION check_conferencia_do_arquivo_assinado();
CREATE TRIGGER documentos_apresentacao_conferencias_append_only BEFORE UPDATE OR DELETE ON documentos_apresentacao_conferencias
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao_conferencias
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 5) Tentativas de envio (Outlook do próprio Analista)
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao_envios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  master_id UUID NOT NULL,
  fluxo TEXT NOT NULL CHECK (fluxo IN ('AGENDAMENTO_APRESENTACAO_GRIEG')),
  documento_id UUID NOT NULL,
  assinatura_id UUID NOT NULL,
  modelo_id UUID NOT NULL,
  chave_sha256 TEXT NOT NULL CHECK (chave_sha256 ~ '^[0-9a-f]{64}$'),
  -- Assunto, corpo e destinatários como preparados.
  composicao JSONB NOT NULL,
  -- Dono da caixa: a pessoa e a conta Microsoft DELA (nunca a caixa monitorada).
  analista_membership_id UUID NOT NULL,
  analista_conta_microsoft TEXT NOT NULL CHECK (btrim(analista_conta_microsoft) <> ''),
  reenvio_de UUID,
  reenvio_motivo TEXT,
  reenvio_autorizado_por_membership_id UUID,
  estado TEXT NOT NULL DEFAULT 'PREPARANDO_RASCUNHO' CHECK (estado IN (
    'PREPARANDO_RASCUNHO', 'RASCUNHO_DISPONIVEL', 'ENVIO_SOLICITADO', 'ENVIO_CONFIRMADO', 'RESULTADO_INCERTO', 'ENVIO_NAO_REALIZADO')),
  aberto_em TIMESTAMPTZ NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL,
  concluido_em TIMESTAMPTZ,
  rascunho_id TEXT,
  rascunho_internet_message_id TEXT,
  rascunho_conversation_id TEXT,
  -- Anexos com hash, registrados quando o rascunho é criado.
  anexos JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Evidência lida do Graph quando o envio é confirmado.
  confirmacao JSONB,
  falha TEXT,
  CONSTRAINT documentos_apresentacao_envios_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_master_fk FOREIGN KEY (master_id, organization_id)
    REFERENCES masters (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_documento_fk FOREIGN KEY (documento_id, organization_id)
    REFERENCES documentos_apresentacao (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_assinatura_fk FOREIGN KEY (assinatura_id, documento_id, organization_id)
    REFERENCES documentos_apresentacao_assinaturas (id, documento_id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_modelo_fk FOREIGN KEY (modelo_id, organization_id)
    REFERENCES documentos_apresentacao_modelos (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_analista_fk FOREIGN KEY (analista_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_reenvio_fk FOREIGN KEY (reenvio_de, organization_id)
    REFERENCES documentos_apresentacao_envios (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_autorizador_fk FOREIGN KEY (reenvio_autorizado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT documentos_apresentacao_envios_reenvio_completo CHECK (
    (reenvio_de IS NULL AND reenvio_motivo IS NULL AND reenvio_autorizado_por_membership_id IS NULL)
    OR (reenvio_de IS NOT NULL AND btrim(coalesce(reenvio_motivo, '')) <> '' AND reenvio_autorizado_por_membership_id IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_envios_conclusao CHECK ((estado IN ('ENVIO_CONFIRMADO', 'ENVIO_NAO_REALIZADO')) = (concluido_em IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_envios_confirmado_com_evidencia CHECK ((estado = 'ENVIO_CONFIRMADO') = (confirmacao IS NOT NULL)),
  CONSTRAINT documentos_apresentacao_envios_rascunho CHECK (
    estado NOT IN ('RASCUNHO_DISPONIVEL', 'ENVIO_SOLICITADO', 'ENVIO_CONFIRMADO') OR btrim(coalesce(rascunho_id, '')) <> ''),
  CONSTRAINT documentos_apresentacao_envios_nao_realizado_com_motivo CHECK (estado <> 'ENVIO_NAO_REALIZADO' OR btrim(coalesce(falha, '')) <> '')
);
-- Sem duplicidade: uma tentativa aberta por Master e fluxo; um reenvio (não falhado) por envio confirmado.
CREATE UNIQUE INDEX documentos_apresentacao_envios_uma_aberta ON documentos_apresentacao_envios (organization_id, master_id, fluxo)
  WHERE estado NOT IN ('ENVIO_CONFIRMADO', 'ENVIO_NAO_REALIZADO');
CREATE UNIQUE INDEX documentos_apresentacao_envios_um_reenvio ON documentos_apresentacao_envios (organization_id, reenvio_de)
  WHERE reenvio_de IS NOT NULL AND estado <> 'ENVIO_NAO_REALIZADO';

-- Depois de um envio CONFIRMADO, só reenvio explícito; e o reenvio parte do envio confirmado
-- VIGENTE (do mesmo Master e fluxo, ainda não substituído por outro reenvio confirmado).
CREATE OR REPLACE FUNCTION check_envio_apresentacao_reenvio() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reenvio_de IS NULL AND EXISTS (
    SELECT 1 FROM documentos_apresentacao_envios e
     WHERE e.organization_id = NEW.organization_id AND e.master_id = NEW.master_id AND e.fluxo = NEW.fluxo AND e.estado = 'ENVIO_CONFIRMADO') THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: já há envio confirmado; nova tentativa só como reenvio explícito';
  END IF;
  IF NEW.reenvio_de IS NOT NULL AND (NOT EXISTS (
    SELECT 1 FROM documentos_apresentacao_envios e
     WHERE e.id = NEW.reenvio_de AND e.organization_id = NEW.organization_id AND e.master_id = NEW.master_id
       AND e.fluxo = NEW.fluxo AND e.estado = 'ENVIO_CONFIRMADO')
    OR EXISTS (
    SELECT 1 FROM documentos_apresentacao_envios e
     WHERE e.organization_id = NEW.organization_id AND e.reenvio_de = NEW.reenvio_de AND e.estado = 'ENVIO_CONFIRMADO')) THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: reenvio exige o envio confirmado vigente do mesmo Master e fluxo';
  END IF;
  IF NEW.estado <> 'PREPARANDO_RASCUNHO' THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: tentativa nasce PREPARANDO_RASCUNHO';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_apresentacao_envios_reenvio BEFORE INSERT ON documentos_apresentacao_envios
  FOR EACH ROW EXECUTE FUNCTION check_envio_apresentacao_reenvio();

-- Só as transições do domínio; identidade, composição, dono e reenvio nunca mudam;
-- rascunho, anexos e confirmação são gravados uma vez; nada se apaga.
CREATE OR REPLACE FUNCTION check_transicao_envio_apresentacao() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: tentativa de envio não pode ser apagada';
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.master_id, NEW.fluxo, NEW.documento_id, NEW.assinatura_id, NEW.modelo_id, NEW.chave_sha256, NEW.composicao,
      NEW.analista_membership_id, NEW.analista_conta_microsoft, NEW.reenvio_de, NEW.reenvio_motivo, NEW.reenvio_autorizado_por_membership_id, NEW.aberto_em)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.master_id, OLD.fluxo, OLD.documento_id, OLD.assinatura_id, OLD.modelo_id, OLD.chave_sha256, OLD.composicao,
      OLD.analista_membership_id, OLD.analista_conta_microsoft, OLD.reenvio_de, OLD.reenvio_motivo, OLD.reenvio_autorizado_por_membership_id, OLD.aberto_em) THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: só o estado e a evidência do envio podem ser registrados';
  END IF;
  IF NOT (
       (OLD.estado = 'PREPARANDO_RASCUNHO' AND NEW.estado IN ('RASCUNHO_DISPONIVEL', 'ENVIO_NAO_REALIZADO'))
    OR (OLD.estado = 'RASCUNHO_DISPONIVEL' AND NEW.estado IN ('ENVIO_SOLICITADO', 'ENVIO_CONFIRMADO', 'RESULTADO_INCERTO', 'ENVIO_NAO_REALIZADO'))
    OR (OLD.estado = 'ENVIO_SOLICITADO' AND NEW.estado IN ('ENVIO_CONFIRMADO', 'RESULTADO_INCERTO', 'RASCUNHO_DISPONIVEL'))
    OR (OLD.estado = 'RESULTADO_INCERTO' AND NEW.estado IN ('ENVIO_CONFIRMADO', 'RASCUNHO_DISPONIVEL', 'ENVIO_NAO_REALIZADO'))) THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: transição % → % não permitida', OLD.estado, NEW.estado;
  END IF;
  IF (OLD.rascunho_id IS NOT NULL AND (NEW.rascunho_id, NEW.rascunho_internet_message_id, NEW.rascunho_conversation_id)
        IS DISTINCT FROM (OLD.rascunho_id, OLD.rascunho_internet_message_id, OLD.rascunho_conversation_id))
     OR (OLD.anexos <> '[]'::jsonb AND NEW.anexos IS DISTINCT FROM OLD.anexos)
     OR (OLD.confirmacao IS NOT NULL AND NEW.confirmacao IS DISTINCT FROM OLD.confirmacao) THEN
    RAISE EXCEPTION 'documentos_apresentacao_envios: rascunho, anexos e confirmação são gravados uma única vez';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documentos_apresentacao_envios_transicao BEFORE UPDATE OR DELETE ON documentos_apresentacao_envios
  FOR EACH ROW EXECUTE FUNCTION check_transicao_envio_apresentacao();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao_envios
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

-- ---------------------------------------------------------------------------
-- 6) Histórico append-only de modelos e tentativas
-- ---------------------------------------------------------------------------
CREATE TABLE documentos_apresentacao_eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordem de registro (determinística mesmo com o mesmo instante).
  sequencia BIGINT GENERATED ALWAYS AS IDENTITY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  modelo_id UUID,
  envio_id UUID,
  tipo TEXT NOT NULL CHECK (tipo IN (
    -- modelos
    'MODELO_CADASTRADO', 'LEITURA_DO_MODELO_DEFINIDA', 'MODELO_VALIDADO', 'MODELO_DESCARTADO', 'SUBSTITUTO_RECEBIDO',
    'SINAL_DE_REJEICAO', 'REJEICAO_CONFIRMADA', 'SINAL_DESCARTADO',
    -- tentativas de envio
    'TENTATIVA_ABERTA', 'RASCUNHO_CRIADO', 'RASCUNHO_ALTERADO', 'ENVIO_SOLICITADO', 'ENVIO_RECUSADO_PELA_INTEGRACAO',
    'RASCUNHO_AINDA_NAO_ENVIADO', 'ENVIO_CONFIRMADO', 'RESULTADO_INCERTO', 'ENVIO_NAO_REALIZADO')),
  estado_anterior TEXT,
  estado_novo TEXT,
  origem TEXT NOT NULL CHECK (origem IN ('PESSOA', 'INTEGRACAO')),
  ator_membership_id UUID,
  detalhe JSONB NOT NULL DEFAULT '{}'::jsonb,
  registrado_em TIMESTAMPTZ NOT NULL,
  CONSTRAINT documentos_apresentacao_eventos_alvo CHECK ((modelo_id IS NULL) <> (envio_id IS NULL)),
  CONSTRAINT documentos_apresentacao_eventos_pessoa CHECK (origem <> 'PESSOA' OR ator_membership_id IS NOT NULL),
  CONSTRAINT documentos_apresentacao_eventos_modelo_fk FOREIGN KEY (modelo_id, organization_id)
    REFERENCES documentos_apresentacao_modelos (id, organization_id),
  CONSTRAINT documentos_apresentacao_eventos_envio_fk FOREIGN KEY (envio_id, organization_id)
    REFERENCES documentos_apresentacao_envios (id, organization_id),
  CONSTRAINT documentos_apresentacao_eventos_ator_fk FOREIGN KEY (ator_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id)
);
CREATE INDEX documentos_apresentacao_eventos_modelo_idx ON documentos_apresentacao_eventos (organization_id, modelo_id, sequencia);
CREATE INDEX documentos_apresentacao_eventos_envio_idx ON documentos_apresentacao_eventos (organization_id, envio_id, sequencia);
-- A mesma resposta da agência nunca vira dois sinais (nada é reprocessado).
CREATE UNIQUE INDEX documentos_apresentacao_eventos_sinal_unico ON documentos_apresentacao_eventos (organization_id, modelo_id, (detalhe->>'messageId'))
  WHERE tipo = 'SINAL_DE_REJEICAO';

CREATE TRIGGER documentos_apresentacao_eventos_append_only BEFORE UPDATE OR DELETE ON documentos_apresentacao_eventos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON documentos_apresentacao_eventos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
