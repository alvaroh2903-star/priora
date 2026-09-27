-- Demurrage Engine V2 — migration ADITIVA corretiva da 0024 (Master Free Time
-- pela Shipping Instructions). A 0024 foi publicada e é IMUTÁVEL; tudo o que
-- mudou no banco depois dela entra aqui. Funciona tanto em banco novo
-- (0001→0025) quanto em banco que já executou a 0024 original.

-- 1) Intenção: contêineres citados na SI (ISO 6346), para reavaliar alcance e
--    pendências de contêiner inexistente sem reler o documento. Coluna com
--    DEFAULT constante: não reescreve linhas nem dispara o trigger append-only.
ALTER TABLE si_intencoes ADD COLUMN containers_ref TEXT[] NOT NULL DEFAULT '{}';

-- 2) Entregas de aviso: claim PERSISTENTE. O envio externo acontece fora de
--    qualquer transação/lock; a finalização só é aceita com o token vigente;
--    PROCESSING vencido (processo interrompido) é recuperado.
ALTER TABLE ft_divergencia_entregas DROP CONSTRAINT ft_divergencia_entregas_status_check;
ALTER TABLE ft_divergencia_entregas ADD CONSTRAINT ft_divergencia_entregas_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'));
ALTER TABLE ft_divergencia_entregas
  ADD COLUMN claim_token UUID,
  ADD COLUMN worker_id TEXT,
  ADD COLUMN expira_em TIMESTAMPTZ;
ALTER TABLE ft_divergencia_entregas ADD CONSTRAINT ft_divergencia_entregas_claim
  CHECK ((status = 'PROCESSING') = (claim_token IS NOT NULL AND expira_em IS NOT NULL));

-- 3) Outbox de recálculo: item em PROCESSING sempre tem dono e prazo.
ALTER TABLE recalculo_outbox ADD CONSTRAINT recalculo_outbox_claim
  CHECK (estado <> 'PROCESSING' OR (worker_id IS NOT NULL AND expira_em IS NOT NULL));
