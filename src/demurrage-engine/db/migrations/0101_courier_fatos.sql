-- S1 — Courier durável (H-2, H-6, N-7). Dono: Courier.
--
-- Só os fatos que o OPERADOR confirma no módulo Courier: a conferência de MBL e
-- de HBL original por (envelope, referência exata do processo) e o estado do
-- envelope. Append-only: correção (desmarcar) e mudança oficial viram linhas
-- novas com o valor anterior; nada é apagado. A visão do Courier (cards,
-- agrupamento, índice de referências, Clara, ETA, expectativa documental,
-- estatísticas) continua derivada da caixa postal e não é copiada aqui.
--
-- Identidades distintas (N-6): `caixa_id` é a caixa Microsoft monitorada;
-- `autor_membership_id` é a pessoa autenticada na Priora. A organização vem da
-- caixa vinculada no servidor (`email_caixas`), nunca do cliente.
--
-- Identidade do processo (N-3): `processo_ref` é o código EXATO, limpo pelo S6
-- (`limparCodigoProcesso`) — nunca a base sem sufixo. `processo_ref_bruta` é a
-- forma como a referência apareceu. A resolução para `processos.id` é feita
-- pelo S6 com origem OPERACIONAL (nunca cria processo); sem identidade, a
-- pendência do S6 fica registrada e o fato é preservado sem ser publicado.
--
-- `associacao` é a proveniência da LINHA, determinada pelo servidor: só
-- 'CITADA' (o processo está citado diretamente nas conversas do próprio
-- envelope) pode virar fato oficial de escopo Processo.

CREATE TABLE courier_fatos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  caixa_id UUID NOT NULL,
  tracking_bruto TEXT NOT NULL,
  tracking_chave TEXT NOT NULL CHECK (tracking_chave ~ '^[A-Z0-9]+$'),
  tipo TEXT NOT NULL CHECK (tipo IN ('ESTADO_ENVELOPE', 'CONFERENCIA_DOCUMENTO')),
  documento TEXT CHECK (documento IN ('MBL', 'HBL_ORIGINAL')),
  processo_ref_bruta TEXT,
  processo_ref TEXT,
  referencias_brutas TEXT[] NOT NULL DEFAULT '{}',
  associacao TEXT CHECK (associacao IN ('CITADA', 'AMBIGUA', 'INFERIDA', 'CLARA', 'NAO_VERIFICADA')),
  linha_emitida_em TIMESTAMPTZ,
  valor TEXT NOT NULL,
  valor_anterior TEXT,
  nota TEXT,
  sequencia INTEGER NOT NULL CHECK (sequencia >= 1),
  processo_id UUID,
  identidade_pendencia_id UUID,
  autor_membership_id UUID NOT NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT courier_fatos_caixa_fk FOREIGN KEY (caixa_id, organization_id)
    REFERENCES email_caixas (id, organization_id),
  CONSTRAINT courier_fatos_autor_fk FOREIGN KEY (autor_membership_id, organization_id)
    REFERENCES organization_memberships (id, organization_id),
  CONSTRAINT courier_fatos_processo_fk FOREIGN KEY (processo_id, organization_id)
    REFERENCES processos (id, organization_id),
  CONSTRAINT courier_fatos_pendencia_fk FOREIGN KEY (identidade_pendencia_id, organization_id)
    REFERENCES identidade_pendencias (id, organization_id),
  CONSTRAINT courier_fatos_forma CHECK (
    (tipo = 'ESTADO_ENVELOPE'
      AND documento IS NULL AND processo_ref IS NULL AND processo_ref_bruta IS NULL AND associacao IS NULL
      AND linha_emitida_em IS NULL AND referencias_brutas = '{}' AND processo_id IS NULL AND identidade_pendencia_id IS NULL
      AND valor IN ('Identificado', 'Recebido', 'Em Conferência', 'Divergência', 'Concluído')
      AND (valor_anterior IS NULL OR valor_anterior IN ('Identificado', 'Recebido', 'Em Conferência', 'Divergência', 'Concluído')))
    OR
    (tipo = 'CONFERENCIA_DOCUMENTO'
      AND documento IS NOT NULL AND processo_ref IS NOT NULL AND processo_ref <> '' AND processo_ref_bruta IS NOT NULL
      AND associacao IS NOT NULL AND nota IS NULL
      AND valor IN ('RECEBIDO', 'AUSENTE_NA_CONFERENCIA', 'DESMARCADO')
      AND (valor_anterior IS NULL OR valor_anterior IN ('RECEBIDO', 'AUSENTE_NA_CONFERENCIA', 'DESMARCADO')))
  ),
  -- Desmarcar é retração: não é observação de processo e não passa pelo S6.
  CONSTRAINT courier_fatos_identidade CHECK (
    (processo_id IS NULL OR identidade_pendencia_id IS NULL)
    AND (valor <> 'DESMARCADO' OR (processo_id IS NULL AND identidade_pendencia_id IS NULL))
  ),
  -- Uma sequência por assunto (envelope, tipo, documento, referência exata): serializa escritas concorrentes.
  CONSTRAINT courier_fatos_sequencia_unica UNIQUE NULLS NOT DISTINCT
    (organization_id, tracking_chave, tipo, documento, processo_ref, sequencia)
);

CREATE INDEX courier_fatos_tracking_idx ON courier_fatos (organization_id, tracking_chave);
CREATE INDEX courier_fatos_processo_ref_idx ON courier_fatos (organization_id, processo_ref)
  WHERE tipo = 'CONFERENCIA_DOCUMENTO';

CREATE TRIGGER courier_fatos_append_only
  BEFORE UPDATE OR DELETE ON courier_fatos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER organization_id_immutable
  BEFORE UPDATE ON courier_fatos
  FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION forbid_organization_change();
