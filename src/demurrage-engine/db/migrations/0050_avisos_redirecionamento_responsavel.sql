-- Demurrage Engine V2 — migration ADITIVA (Produção P1, auditoria corretiva da
-- entrega de filas pessoais): o aviso de divergência endereçado ao
-- RESPONSÁVEL OPERACIONAL segue o responsável ATUAL do processo.
-- 0001-0049 não são reescritas; nenhuma linha existente é alterada.
--
-- Regra (ver docs/demurrage-producao-p1-autenticacao-filas.md):
--  - a entrega `destinatario_tipo = 'responsavel_operacional'` ainda não
--    enviada pertence a quem é o responsável NO MOMENTO do envio;
--  - uma reatribuição a invalida de forma auditável (`SUPERADA`, com motivo e
--    a entrega que a substituiu) e cria/reativa a do novo responsável — na
--    própria transação da atribuição e, de novo, no worker (sob o lock do
--    processo) antes de cada envio; o TIPO da entrega de cada pessoa segue o
--    papel de agora (o responsável anterior que é gestor ativo fica com a
--    entrega de gestor); numa divergência resolvida (ou ocorrência anterior)
--    a entrega do anterior é encerrada (`ocorrencia_encerrada`) sem criar outra;
--  - `envio_confirmado_em` marca a ÚLTIMA verificação do worker, feita sob o
--    lock do processo imediatamente antes de chamar o transporte: uma entrega
--    confirmada é um envio já decidido enquanto a pessoa era a responsável
--    (o ponto de linearização entre reatribuição e envio — nenhum lock do
--    banco fica aberto durante o envio externo, por desenho dos avisos).

ALTER TABLE ft_divergencia_entregas DROP CONSTRAINT ft_divergencia_entregas_status_check;
ALTER TABLE ft_divergencia_entregas ADD CONSTRAINT ft_divergencia_entregas_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SUPERADA'));

ALTER TABLE ft_divergencia_entregas
  ADD COLUMN superada_em TIMESTAMPTZ,
  ADD COLUMN superada_motivo TEXT,
  ADD COLUMN substituida_por_id UUID REFERENCES ft_divergencia_entregas(id),
  ADD COLUMN envio_confirmado_em TIMESTAMPTZ;

ALTER TABLE ft_divergencia_entregas ADD CONSTRAINT ft_divergencia_entregas_superada_coerente CHECK (
  (status = 'SUPERADA') = (superada_em IS NOT NULL AND superada_motivo IS NOT NULL)
  AND (superada_motivo IS NULL OR superada_motivo IN ('responsavel_reatribuido', 'sem_responsavel', 'ocorrencia_encerrada'))
  AND (substituida_por_id IS NULL OR status = 'SUPERADA')
  AND (substituida_por_id IS DISTINCT FROM id)
);
-- Só a entrega do responsável operacional é redirecionada (a de gestor segue o papel).
ALTER TABLE ft_divergencia_entregas ADD CONSTRAINT ft_divergencia_entregas_superada_so_responsavel CHECK (
  status <> 'SUPERADA' OR destinatario_tipo = 'responsavel_operacional'
);
-- Confirmação de envio só existe na posse em que foi feita. GATILHO, não
-- CHECK: o código anterior a esta migration (rollback do deploy) não conhece
-- a coluna — o claim, a finalização e a devolução dele continuam válidos e a
-- confirmação herdada de outra posse é apagada em vez de abortar a escrita.
CREATE OR REPLACE FUNCTION ft_divergencia_entregas_confirmacao_na_posse() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status <> 'PROCESSING'
     OR (TG_OP = 'UPDATE' AND NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
    NEW.envio_confirmado_em := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ft_divergencia_entregas_confirmacao_na_posse
  BEFORE INSERT OR UPDATE ON ft_divergencia_entregas
  FOR EACH ROW EXECUTE FUNCTION ft_divergencia_entregas_confirmacao_na_posse();

-- Trilha: redirecionamento auditável (evento append-only já existente).
ALTER TABLE ft_divergencia_eventos DROP CONSTRAINT ft_divergencia_eventos_tipo_check;
ALTER TABLE ft_divergencia_eventos ADD CONSTRAINT ft_divergencia_eventos_tipo_check
  CHECK (tipo IN ('aberta', 'atualizada', 'reconhecida', 'resolvida', 'reaberta', 'aviso_emitido', 'aviso_falhou', 'aviso_redirecionado'));
