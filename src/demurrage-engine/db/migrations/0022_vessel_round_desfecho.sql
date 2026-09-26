-- Demurrage Engine V2 — migration ADITIVA (Fase 9 Bloco 2 v1.3): persiste o
-- DESFECHO FACTUAL da rodada compartilhada. Sem isto, um tick posterior (ou
-- outro worker) que encontra a rodada JÁ CONCLUÍDA não consegue distinguir, de
-- forma inequívoca, se deve suprimir só os cobertos, liberar todos ao individual
-- ou tratar divergência — as colunas existentes (estado/referência) não carregam
-- essa informação. Coluna nullable; rodadas abertas ficam com desfecho NULL até
-- concluir. 0001-0021 NÃO são reescritas. Cadência/relógios/tarifas/apuração/
-- Fases 7-8 intactos.
ALTER TABLE vessel_call_rodadas
  ADD COLUMN desfecho TEXT
    CHECK (desfecho IN (
      'sucesso_com_cobertura',
      'sucesso_sem_cobertura',
      'falha_sem_cobertura',
      'encerrada_por_saida',
      'divergencia_referencia'
    ));
