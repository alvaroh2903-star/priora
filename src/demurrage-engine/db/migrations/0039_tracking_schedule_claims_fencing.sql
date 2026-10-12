-- D16 v1.1 (corretiva) — fencing do claim individual do tracking scheduler
-- (migration ADITIVA; 0001-0038 não são reescritas).
--
-- Achado bloqueante (auditoria D16): `claimJanela` (0014) permite que um
-- claim 'claimed' expirado (worker morto/lento) seja retomado por outro
-- worker, mas `concluirClaim` finalizava por (tracking_target_id, janela)
-- SOZINHO — sem checar posse. Corrida real: A reivindica, demora mais que o
-- staleInterval, B retoma o claim e começa a trabalhar, A termina tarde e
-- chama concluirClaim, que finaliza a linha ATUAL (agora de B) como 'done'
-- ou 'failed' — a posse e o estado da janela ficam corrompidos mesmo com B
-- ainda em execução. O mesmo protocolo de fencing por `claim_token` já usado
-- em `tracking_alert_deliveries` (migration 0037, R59) é replicado aqui.
--
-- `claim_token` só existe enquanto a linha está `status = 'claimed'` (CHECK
-- simétrico ao já usado em 0037 para tracking_alert_deliveries): toda
-- reivindicação (claim OU retomada) recebe um UUID novo; finalizar exige
-- apresentar o token que a própria reivindicação devolveu, e limpa o token
-- (volta a NULL) ao sair de 'claimed'. Não altera cadência, seleção de
-- target, cálculo de janela nem política de crédito — só a barreira de
-- posse na finalização.

ALTER TABLE tracking_schedule_claims
  ADD COLUMN claim_token UUID;

-- Backfill seguro: linhas pré-existentes em 'claimed' recebem um token
-- NOVO e descartável só para satisfazer a invariante abaixo — nenhum worker
-- real já o detém, então ele nunca viabiliza uma finalização por um worker
-- antigo; a primeira reivindicação futura (nova ou por retomada de claim
-- expirado) sobrescreve este token com um real, exatamente como já ocorre
-- hoje para `claimed_em`/`tentativas`. Isto não inventa posse bem-sucedida:
-- apenas evita que a linha fique num estado "claimed sem token", que a
-- invariante abaixo proíbe. Linhas 'done'/'failed' seguem com claim_token
-- NULL (não há posse ativa a preservar).
UPDATE tracking_schedule_claims
   SET claim_token = gen_random_uuid()
 WHERE status = 'claimed';

ALTER TABLE tracking_schedule_claims
  ADD CONSTRAINT tracking_schedule_claims_token_consistente
    CHECK ((status = 'claimed') = (claim_token IS NOT NULL));
