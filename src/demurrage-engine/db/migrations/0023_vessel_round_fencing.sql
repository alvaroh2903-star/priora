-- Demurrage Engine V2 — migration ADITIVA (Fase 9 Bloco 2 v1.4): FENCING da
-- rodada compartilhada. Uma rodada expirada pode ser REIVINDICADA por outro
-- worker; o proprietário anterior não pode mais gravar tentativa, cobertura ou
-- desfecho após a transferência. `epoca` é uma versão MONOTÔNICA da posse:
-- incrementada a cada (re)aquisição. As escritas terminais validam
-- (worker_id, epoca) atuais antes de aplicar. 0001-0022 NÃO são reescritas.
-- Cadência/relógios/tarifas/apuração/Fases 7-8 intactos.
ALTER TABLE vessel_call_rodadas
  ADD COLUMN epoca INTEGER NOT NULL DEFAULT 1;
