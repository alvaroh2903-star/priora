-- Demurrage Engine V2 — migration ADITIVA (revisão 12 do plano, revisão da Fase 6).
-- 0001-0013 não são reescritas.
--
-- Duas necessidades da revisão da Fase 6:
--
-- 1) WORKER REAL com idempotência/claim em PostgreSQL. O worker roda sem
--    ninguém abrir tela. Dois workers simultâneos (ou um reinício no meio de
--    uma janela) NÃO podem duplicar a consulta ao armador. A "janela" é a data
--    civil da consulta devida (determinística: proximaConsulta). O primeiro a
--    reivindicar (armador + janela) executa; os outros veem o claim e desistem.
--
-- 2) OUTBOX de alerta: a entrega criada (linha) ≠ "enviada". Sem transporte
--    real ainda (e-mail/webhook/Slack precisam de SUA VALIDAÇÃO), a entrega
--    nasce PENDING e só vira SENT quando um transporte real confirmar; FAILED
--    guarda o erro para reprocessar. Assim nenhum alerta se perde.

-- 1) Claim de janela do scheduler: idempotência por (tracking_target_id, janela).
--    Não carrega organization_id: o TrackingTarget e sua consulta são GLOBAIS
--    (uma consulta serve todas as organizações). Portanto fora da convenção da
--    DECISÃO 1 (nenhum trigger de organização imutável se aplica aqui).
CREATE TABLE tracking_schedule_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_target_id UUID NOT NULL REFERENCES tracking_targets(id) ON DELETE CASCADE,
  -- Chave determinística da janela devida (data civil 'AAAA-MM-DD' da consulta).
  janela TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'done', 'failed')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  claimed_por TEXT,
  claimed_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  erro TEXT,
  -- Uma reivindicação por (target, janela): a barreira contra worker duplicado.
  CONSTRAINT tracking_schedule_claims_unico UNIQUE (tracking_target_id, janela)
);

CREATE INDEX tracking_schedule_claims_target_idx
  ON tracking_schedule_claims (tracking_target_id);

-- 2) Estado de entrega do alerta (outbox). Uma linha criada NÃO é "enviada":
--    nasce PENDING; um transporte real a leva a SENT (com enviado_em) ou FAILED
--    (com erro), reprocessável. `tentativas` limita retentativas cegas.
ALTER TABLE tracking_alert_deliveries
  ADD COLUMN status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  ADD COLUMN tentativas INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN enviado_em TIMESTAMPTZ,
  ADD COLUMN erro TEXT;

-- Fila de trabalho do outbox: entregas ainda não enviadas.
CREATE INDEX tracking_alert_deliveries_pendentes_idx
  ON tracking_alert_deliveries (status)
  WHERE status <> 'SENT';
