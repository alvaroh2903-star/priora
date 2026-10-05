-- Demurrage Engine V2 — migration ADITIVA (Fase D15-A: integridade de estado
-- final e reabertura). 0001-0034 não são reescritas.
--
-- O diagnóstico de D15 (commit f22d153) continha uma contradição editorial:
-- dizia que D15-A não exigia migration e, na mesma seção, apontava a falta de
-- unicidade em `reaberturas` e de ator obrigatório. Esta migration resolve a
-- contradição a favor da evidência: as duas garantias abaixo NÃO existiam no
-- schema (conferido em 0016_fase8_minuta_fechamento.sql) e são adicionadas
-- aqui, de forma aditiva.
--
-- Estratégia de compatibilidade para linhas existentes (requisito explícito:
-- nunca fabricar autor para dado legado):
--  - a exigência de ator (`solicitada_por`) é um CHECK `NOT VALID`: vale para
--    toda escrita NOVA (INSERT/UPDATE) a partir desta migration, mas NÃO
--    revalida linhas já existentes — uma reabertura antiga sem autor
--    permanece exatamente como está, sem reescrita nem autor inventado;
--  - o mesmo vale para `autorizada_por` quando o estado deixa de ser
--    SOLICITADA (ou seja, uma vez AUTORIZADA/RECALCULADA/REFECHADA, o autor
--    da autorização passa a ser obrigatório para escritas novas);
--  - a unicidade de reabertura aberta (no máximo uma SOLICITADA/AUTORIZADA/
--    RECALCULADA por processo) é um índice único parcial. Como este sistema
--    nunca esteve em produção (D14 segue "NÃO aprovada e NÃO congelada") e
--    todo teste constrói o schema do zero, não há dado legado real que
--    viole esta regra; se um ambiente já tivesse duplicatas, a criação do
--    índice falharia ALTO (erro de migration), nunca resolveria a duplicata
--    silenciosamente escolhendo uma das duas.

-- 1) closing_events: um tipo novo, aditivo — fato material recebido para um
--    contêiner de processo FINAL (discharge/FT/tipo/tracking_return/minuta
--    divergente), preservado como evidência de que o fato foi RECEBIDO e
--    BLOQUEADO (nunca promovido), não como alteração do estado congelado.
ALTER TABLE closing_events DROP CONSTRAINT closing_events_tipo_evento_check;
ALTER TABLE closing_events ADD CONSTRAINT closing_events_tipo_evento_check CHECK (tipo_evento IN (
  'EMPTY_RETURN', 'MINUTA_RECEBIDA', 'MINUTA_VALIDADA', 'MINUTA_REJEITADA',
  'DIVERGENCIA_TRACKING_MINUTA', 'RECALCULO', 'FECHAMENTO_FINAL',
  'REABERTURA_SOLICITADA', 'REABERTURA_AUTORIZADA', 'REABERTURA', 'REFECHAMENTO',
  'RESPONSABILIDADE_CONFIRMADA', 'RESPONSABILIDADE_CORRIGIDA', 'RESPONSABILIDADE_INVALIDADA',
  'FATO_MATERIAL_POS_FINAL'
));

-- 2) reaberturas: no máximo UMA reabertura "aberta" (ainda não REFECHADA) por
--    processo. Serializa concorrência em nível de banco — mesmo que o
--    serviço de aplicação perca uma corrida no check-then-insert, o segundo
--    INSERT concorrente falha por violação de unicidade em vez de criar uma
--    segunda reabertura aberta.
CREATE UNIQUE INDEX reaberturas_aberta_unica
  ON reaberturas (processo_id)
  WHERE estado IN ('SOLICITADA', 'AUTORIZADA', 'RECALCULADA');

-- 3) Ator obrigatório para escritas NOVAS (NOT VALID — ver nota de
--    compatibilidade acima). `solicitada_por` sempre obrigatório;
--    `autorizada_por` obrigatório a partir do momento em que a reabertura
--    deixa de ser SOLICITADA.
ALTER TABLE reaberturas
  ADD CONSTRAINT reaberturas_solicitada_por_obrigatoria
  CHECK (solicitada_por IS NOT NULL) NOT VALID;
ALTER TABLE reaberturas
  ADD CONSTRAINT reaberturas_autorizada_por_obrigatoria
  CHECK (estado = 'SOLICITADA' OR autorizada_por IS NOT NULL) NOT VALID;
