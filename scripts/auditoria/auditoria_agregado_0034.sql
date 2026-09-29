-- ============================================================================
-- SCRIPT DE AUDITORIA — SOMENTE LEITURA (READ-ONLY)
-- NÃO é migration. NÃO é executado pelo migrate. NÃO corrige nada.
-- Não apaga, não regrava, não cria função/tabela/tabela temporária.
-- ============================================================================
--
-- Auditoria READ-ONLY do agregado das decisões de responsabilidade (D11 v1.2).
--
-- Para cada linha de responsabilidade_decisoes, chama a MESMA função que os
-- três gatilhos adiados da 0034 usam — responsabilidade_validar_agregado(id)
-- — e informa quais violam hoje, com o motivo (mensagem da exceção).
--
-- Garantias:
--  - roda dentro de BEGIN TRANSACTION READ ONLY; qualquer escrita é recusada
--    pelo próprio PostgreSQL. Termina em ROLLBACK;
--  - não cria função, tabela ou tabela temporária; só DO + RAISE NOTICE;
--  - cada chamada roda num bloco com EXCEPTION (subtransação), então uma
--    violação não interrompe as demais.
--
-- Leitura do resultado: a função compara a decisão com o relógio ATUAL do
-- contêiner. Uma decisão que já não é a vigente (substituída por versão
-- posterior, ou invalidada por mudança de relógio/valor) pode "violar hoje"
-- a cobertura só porque o relógio mudou depois — por isso a coluna
-- `situacao` separa:
--   vigente     = é a projeção atual do contêiner;
--   maior_versao_sem_projecao = maior versão do contêiner sem projeção (invalidada
--               depois, ou nunca projetada — ex.: gravada por SQL direto);
--   substituida = existe versão posterior.
--
-- Uso (a partir da raiz do repositório):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/auditoria/auditoria_agregado_0034.sql
-- Saída: uma linha NOTICE 'VIOLA|...' por decisão que viola hoje e uma linha
-- final 'RESUMO|decisoes=N|violam_hoje=V|conformes=C'.

BEGIN TRANSACTION READ ONLY;

DO $$
DECLARE
  d RECORD;
  total INTEGER := 0;
  violacoes INTEGER := 0;
  motivo TEXT;
BEGIN
  IF to_regprocedure('responsabilidade_validar_agregado(uuid)') IS NULL THEN
    RAISE EXCEPTION 'banco sem a migration 0034 (funcao responsabilidade_validar_agregado ausente)';
  END IF;

  FOR d IN
    SELECT r.id, r.container_id, r.versao, r.status, r.base_relogio, r.valor_status, r.criado_em,
           CASE
             WHEN c.responsabilidade_decisao_id = r.id THEN 'vigente'
             WHEN r.versao = (SELECT max(x.versao) FROM responsabilidade_decisoes x WHERE x.container_id = r.container_id) THEN 'maior_versao_sem_projecao'
             ELSE 'substituida'
           END AS situacao
      FROM responsabilidade_decisoes r
      JOIN containers c ON c.id = r.container_id
     ORDER BY r.criado_em, r.id
  LOOP
    total := total + 1;
    BEGIN
      PERFORM responsabilidade_validar_agregado(d.id);
    EXCEPTION WHEN OTHERS THEN
      violacoes := violacoes + 1;
      motivo := SQLERRM;
      RAISE NOTICE 'VIOLA|%|container=%|versao=%|%|%|%|situacao=%|%',
        d.id, d.container_id, d.versao, d.status, d.base_relogio, d.valor_status, d.situacao, motivo;
    END;
  END LOOP;

  RAISE NOTICE 'RESUMO|decisoes=%|violam_hoje=%|conformes=%', total, violacoes, total - violacoes;
END $$;

ROLLBACK;
