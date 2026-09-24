-- Demurrage Engine V2 — migration ADITIVA (revisão 8 do plano, Fase 4).
-- 0001-0009 não são reescritas.
--
-- DECISÃO APROVADA — vigência tarifária desconhecida.
-- O Blueprint não fornece datas históricas confiáveis de início de vigência
-- das tabelas de armador nem da tabela Rocket atual. Em vez de inventar uma
-- data, o schema passa a representar "início desconhecido" explicitamente:
--
--   tariff_tables.vigencia_inicio  → NULLABLE. NULL = INÍCIO DESCONHECIDO.
--     NULL não significa -infinito e NÃO autoriza aplicação retroativa
--     ilimitada.
--   tariff_tables.verificada_em (TIMESTAMPTZ NOT NULL) → quando os valores
--     daquela versão foram comprovadamente verificados. É prova de verificação,
--     nunca de início de vigência.
--
-- Seleção de versão (implementada em tariffTableRepository.selecionarVigente):
--   1. versão com vigencia_inicio CONHECIDA que cubra reference_date tem prioridade;
--   2. versão com vigencia_inicio = NULL só pode ser usada se reference_date for
--      >= data civil de verificada_em;
--   3. nunca aplicar versão de início desconhecido a período anterior à 1ª verificação;
--   4. se nenhuma versão comprovadamente aplicável existir → UNAVAILABLE com
--      motivo TARIFF_VERSION_NOT_PROVEN (nunca zero);
--   5. versão posterior com vigência conhecida vence a de início desconhecido
--      quando ambas forem candidatas.
--
-- Correção auditável: surgindo evidência de vigência real depois, não se altera
-- silenciosamente cálculo histórico. ValorApurado OPEN pode ser recalculado
-- (supersede); FINAL segue a governança de reabertura/correção.

ALTER TABLE tariff_tables ALTER COLUMN vigencia_inicio DROP NOT NULL;

-- ADD com default temporário só para a coluna nascer NOT NULL numa tabela que
-- (em produção) está vazia; o default é removido em seguida para que todo
-- INSERT futuro tenha de informar verificada_em explicitamente — nunca uma data
-- inventada por omissão.
ALTER TABLE tariff_tables ADD COLUMN verificada_em TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE tariff_tables ALTER COLUMN verificada_em DROP DEFAULT;

COMMENT ON COLUMN tariff_tables.vigencia_inicio IS
  'NULL = início de vigência desconhecido (não retroage antes de verificada_em; ver seleção de versão).';
COMMENT ON COLUMN tariff_tables.verificada_em IS
  'Data/hora em que os valores da versão foram verificados. Prova de verificação, nunca de início de vigência.';
