-- S2-mín — Fatos da Auditoria (H-3, H-7, N-18). Dono: Auditoria.
--
-- 1) `auditoria_extracoes`: o resultado que a extração EXISTENTE da Auditoria
--    já produz (OCR uma vez), persistido no ponto em que hoje seria descartado.
--    Append-only e idempotente: a mesma saída para o mesmo anexo não grava nada;
--    uma saída diferente vira outra linha (a evidência conflitante é preservada).
--    A proveniência vem do e-mail, sem nova varredura: ids Graph e
--    internetMessageId, anexo, remetente, data de recebimento e as referências
--    de processo BRUTAS capturadas inteiras (nunca truncadas).
--
-- 2) `processo_master_vinculos`: o vínculo documental Processo ↔ Master (H-7,
--    N-18) — fato do S2, não do S6. Só nasce de UMA extração de MBL legível,
--    do mesmo e-mail que cita diretamente um único processo, com as duas
--    identidades resolvidas pelo S6. Nunca inferido. `vinculado_em` é quando a
--    Priora estabeleceu o vínculo (N-15); `observado_em` é a data da fonte.

CREATE TABLE auditoria_extracoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  caixa_id UUID NOT NULL,
  message_id TEXT NOT NULL CHECK (message_id <> ''),
  internet_message_id TEXT,
  attachment_id TEXT NOT NULL CHECK (attachment_id <> ''),
  attachment_nome TEXT NOT NULL,
  content_type TEXT,
  remetente TEXT,
  mensagem_recebida_em TIMESTAMPTZ,
  referencias_processo_brutas TEXT[] NOT NULL DEFAULT '{}',
  -- Como a Auditoria associou o e-mail ao processo: citação no próprio e-mail ou referência cruzada (inferência).
  associacao TEXT NOT NULL CHECK (associacao IN ('CITADA', 'REFERENCIA_CRUZADA')),
  tipo_por_nome TEXT NOT NULL,
  tipo_detectado TEXT NOT NULL CHECK (tipo_detectado IN ('MBL', 'HBL', 'CE_MASTER', 'CE_HOUSE', 'ITEM', 'OUTRO')),
  legivel BOOLEAN NOT NULL,
  conhecimento TEXT,
  extrator TEXT NOT NULL,
  extrator_versao TEXT NOT NULL,
  modelo TEXT NOT NULL,
  conteudo_hash TEXT NOT NULL,
  extraido_em TIMESTAMPTZ NOT NULL,
  acionado_por_membership_id UUID NOT NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auditoria_extracoes_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT auditoria_extracoes_caixa_fk FOREIGN KEY (caixa_id, organization_id)
    REFERENCES email_caixas (id, organization_id),
  CONSTRAINT auditoria_extracoes_acionador_fk FOREIGN KEY (acionado_por_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT auditoria_extracoes_unica UNIQUE
    (organization_id, caixa_id, message_id, attachment_id, extrator, extrator_versao, modelo, conteudo_hash)
);
CREATE INDEX auditoria_extracoes_mensagem_idx ON auditoria_extracoes (organization_id, message_id);

CREATE TRIGGER auditoria_extracoes_append_only
  BEFORE UPDATE OR DELETE ON auditoria_extracoes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON auditoria_extracoes
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();

CREATE TABLE processo_master_vinculos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  processo_id UUID NOT NULL,
  master_id UUID NOT NULL,
  extracao_id UUID NOT NULL,
  processo_ref_bruta TEXT NOT NULL,
  processo_via TEXT NOT NULL CHECK (processo_via IN ('CODIGO', 'ALIAS', 'CRIADO')),
  mbl_bruto TEXT NOT NULL,
  fonte TEXT NOT NULL CHECK (fonte = 'auditoria_extracao'),
  observado_em TIMESTAMPTZ,
  vinculado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT processo_master_vinculos_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT processo_master_vinculos_master_fk FOREIGN KEY (master_id, organization_id)
    REFERENCES masters (id, organization_id),
  CONSTRAINT processo_master_vinculos_extracao_fk FOREIGN KEY (extracao_id, organization_id)
    REFERENCES auditoria_extracoes (id, organization_id),
  -- A mesma evidência para o mesmo par não grava de novo; evidência nova é preservada.
  CONSTRAINT processo_master_vinculos_evidencia_unica UNIQUE (organization_id, processo_id, master_id, extracao_id)
);
CREATE INDEX processo_master_vinculos_processo_idx ON processo_master_vinculos (organization_id, processo_id);
CREATE INDEX processo_master_vinculos_master_idx ON processo_master_vinculos (organization_id, master_id);

CREATE TRIGGER processo_master_vinculos_append_only
  BEFORE UPDATE OR DELETE ON processo_master_vinculos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON processo_master_vinculos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
