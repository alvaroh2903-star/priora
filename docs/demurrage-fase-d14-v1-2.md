# Fase D14 v1.2 — correção mínima sobre a v1.1 (NÃO aprovada, NÃO congelada)

> **Status:** release corretivo mínimo sobre o commit `6462c0e` (D14 v1.1),
> em resposta a 4 achados remanescentes. Todas as correções corretas da v1.1
> foram preservadas; nenhum comportamento congelado de D7–D13 foi alterado;
> nenhuma migration foi criada; nenhum arquivo em `public/` foi tocado. A D14
> **continua NÃO aprovada e NÃO congelada**; a **D15 não foi iniciada**.
> Entrega para nova auditoria.

## 1. Achados e correções

### #1 — Composições em memória ilimitadas removidas

**Defeito (v1.1):** os 6 indicadores financeiros de conclusão do Grupo D
carregavam todos os contêineres FINAL do período, construíam todos os
envelopes financeiros, filtravam a população inteira em memória e reordenavam
a lista inteira a cada página; `G-E9` varria todos os contêineres e montava o
`Set` completo de processos suspensos a cada página. "FINAL + período" não é
um limite técnico, e o benchmark de 10.000 linhas da v1.1 cobria só o caminho
SQL de `G-A1`.

**Correção:**

- `drilldownDisponivel: false`, com motivo explícito no registro e na resposta
  (200, nunca 404), para: `G-D-SEM-CUSTO-CLIENTE`, `G-D-COM-CUSTO-CLIENTE`,
  `G-D-SEM-EXPOSICAO-ROCKET`, `G-D-COM-EXPOSICAO-ROCKET`,
  `G-D-SEM-VALOR-NENHUM-LADO`, `G-D-INTEGRIDADE` e `G-E9`. Motivo: a seleção
  financeira autoritativa está disponível para o **cálculo do agregado**, mas
  ainda não tem composição persistentemente paginável (`G-E9`: reexecutar
  `avaliarCadencia` na população inteira a cada página não é limitado). As
  **contagens/agregados** (`eficiencia.ts`, `qualidade.ts`) não foram alteradas.
- `modo: 'memoria'`, `paginarMemoria`, e os imports de `selecaoFinanceira` e
  `cadencePolicy` **removidos** de `drilldown.ts`. A especificação de busca é
  agora só `{ grao, baseSql, params }`; toda composição disponível é paginada
  por keyset **dentro do PostgreSQL** (`count(*)` + `LIMIT $n` + busca de
  exibição restrita aos ≤ limite IDs da página).
- Seleção financeira autoritativa **não** foi duplicada em SQL.

Indicadores com composição (21, conjunto fixado em teste): `G-A1`–`G-A10`,
`G-C-*` (4), `G-D-TOTAL-FINAL`, `G-D-SEM-RESPONSABILIDADE`, `G-D-RESP-*` (3),
`G-E7`, `G-E8`.

### #2 — G-E7 reconciliado no grão processo

`tiposContainerNaoReconhecidos` agora usa `count(DISTINCT processo_id)` com a
**mesma predicate** da composição (organização; `estado = 'aberta'`; `tipo IN
('tipo_ausente','tipo_nao_reconhecido')`; `processo_id IS NOT NULL`).
**Decisão sobre `processo_id` nulo:** a coluna é `NOT NULL` no esquema
(migration existente) — nenhuma linha com processo nulo pode existir (o teste
prova a rejeição `23502`). Mesmo assim a predicate exclui nulos
**explicitamente**, na métrica e na composição: um nulo hipotético nunca vira um
"processo" contado. Grão público permanece `processo`.

### #3 — G-E8 reconciliado no grão contêiner

`tabelasOuFaixasIndisponiveis` usa `count(DISTINCT va.container_id)` e a
composição `SELECT DISTINCT va.container_id` (mesma predicate: organização,
`calculation_status IN ('OPEN','FINAL')`, `confirmation_status =
'UNAVAILABLE'`). Grão público permanece `container`.

### #4 — Rótulo de G-A7

`Processos com tracking desatualizado` → `Contêineres com tracking
desatualizado`. Cálculo e grão (`container`) inalterados.

### Achado adicional encontrado e corrigido (fora dos 4 números)

Ao popular decisões de responsabilidade em escala para o benchmark, a
composição de `G-D-SEM-RESPONSABILIDADE` (v1.1) divergiu do indicador (1.200 ×
1.400): `eficiencia.ts` define `semResponsabilidadeAtribuida` como o **residual**
(qualquer contêiner sem decisão vigente `CONFIRMADA_ROCKET`/`CONFIRMADA_CLIENTE`/
`DIVIDIDA` — inclui decisão `NAO_APLICAVEL`), enquanto a composição só aceitava
"nenhuma decisão". Corrigi a **composição** para a definição já publicada do
indicador (o indicador não mudou). O benchmark de 10.000 processos agora
prova a reconciliação (1.400 = 1.400) com decisões `NAO_APLICAVEL` presentes.

## 2. Arquivos

Alterados: `leitura/gestao/drilldown.ts`, `leitura/gestao/indicadorRegistry.ts`,
`leitura/gestao/qualidade.ts`, `leitura/gestao/operacional.ts` (só o rótulo),
`__tests__/gestaoDrilldown.test.ts` e `__tests__/gestaoBenchmarkG7.ts` (remoção
da opção `hoje`, que a composição deixou de usar), `__tests__/gestaoRoutes.test.ts`
(zero-escrita estendido). Novo: `__tests__/gestaoV12.test.ts`,
`docs/demurrage-fase-d14-v1-2.md`. Nenhum arquivo congelado tocado.

## 3. Testes novos (`gestaoV12.test.ts`, 9) — sensíveis a mutação

| Achado | Teste | Mutação que o faz falhar (verificada) |
|---|---|---|
| #1 | 7 indicadores `false` + motivo explícito + 200 | `G-E9` volta a `true` |
| #1 | conjunto EXATO dos 21 indicadores com composição | qualquer indicador novo/restaurado com `true` |
| #1 | **asserção estática**: `drilldown.ts` sem `memoria`, `selecaoFinanceira`, `avaliarCadencia`, `.sort()`/`slice` de IDs, com `LIMIT $` | reintroduzir `paginarMemoria` |
| #1 | toda consulta de composição é contagem, `LIMIT $n` ou exibição ≤ limite IDs; mesma contagem 100 × 3.000 processos | remover o `LIMIT` da página |
| #1 | benchmark 100 × 10.000 por estratégia (ver §4), reconciliação com cada indicador | idem |
| #2 | G-E7: 2 pendências no P1 + 1 no P2 (+ resolvida e outro tipo ignoradas) = **2** no indicador e na composição, sem repetição entre páginas | métrica volta a `count(*)` (daria 3) |
| #2 | `processo_id` nulo rejeitado pelo esquema; predicate exclui nulo | remoção do `DISTINCT`/`IS NOT NULL` |
| #3 | G-E8: contêiner UNAVAILABLE nos dois lados com 2 motores ativos (3 linhas) + outro com 1 = **2** no indicador e na composição, sem repetição; SUPERSEDED/ESTIMATED ignorados | métrica `count(*)`; composição sem `DISTINCT` |
| #4 | rótulo exato, grão `container`, 2 contêineres do mesmo processo contam 2 | rótulo antigo |

## 4. Benchmark PostgreSQL por estratégia disponível (10.000 processos)

Massa sintética (`gerarMassa`) + UNAVAILABLE em 2 lados/motores (G-E8) + decisões
dos 4 status (triggers de USUÁRIO da tabela desligados e religados na mesma
transação, só nesta massa de benchmark em banco de teste isolado). Limite de
página 20; consultas medidas com 100 e com 10.000 processos:

| Indicador | Total (10k) | Consultas 100 → 10k | Itens/página | Tempo 10k (ms) |
|---|---|---|---|---|
| G-A1 | 10000 | 3 → 3 | 20 | 32 |
| G-A2 | 1645 | 3 → 3 | 20 | 17 |
| G-A3 | 1691 | 3 → 3 | 20 | 18 |
| G-A4 | 1667 | 3 → 3 | 20 | 4 |
| G-A5 | 1666 | 3 → 3 | 20 | 3 |
| G-A6 | 4000 | 3 → 3 | 20 | 27 |
| G-A7 | 3000 | 3 → 3 | 20 | 14 |
| G-A8 | 1000 | 3 → 3 | 20 | 6 |
| G-A9 | 1667 | 3 → 3 | 20 | 5 |
| G-A10 | 2000 | 3 → 3 | 20 | 5 |
| G-C-CONFIRMADA_ROCKET | 1000 | 3 → 3 | 20 | 5 |
| G-C-CONFIRMADA_CLIENTE | 1000 | 3 → 3 | 20 | 3 |
| G-C-DIVIDIDA | 1000 | 3 → 3 | 20 | 5 |
| G-C-NAO_APLICAVEL | 1000 | 3 → 3 | 20 | 4 |
| G-D-RESP-CONFIRMADA-ROCKET | 200 | 3 → 3 | 20 | 58 |
| G-D-RESP-CONFIRMADA-CLIENTE | 200 | 3 → 3 | 20 | 52 |
| G-D-RESP-DIVIDIDA | 200 | 3 → 3 | 20 | 52 |
| G-D-SEM-RESPONSABILIDADE | 1400 | 3 → 3 | 20 | 60 |
| G-D-TOTAL-FINAL | 2000 | 3 → 3 | 20 | 30 |
| G-E7 | 1000 | 3 → 3 | 20 | 3 |
| G-E8 | 3199 | 3 → 3 | 20 | 43 |

Contagem de consultas constante e página limitada em **todas** as 21 estratégias;
memória da aplicação limitada ao tamanho da página (nenhuma lista da população
é materializada). O total de cada composição reconcilia com o indicador
correspondente (Grupo A via `/operacional`, Grupo C via `/responsabilidade`,
Grupo D via `/eficiencia`, G-E7/G-E8 via `/qualidade`).

## 5. Regressão (PostgreSQL 16 local, `--test-concurrency=1`)

| Suíte | Resultado |
|---|---|
| Testes corretivos D14 v1.2 (`gestaoV12.test.ts`) | **9/9** |
| D14 completa (`gestao*.test.ts`, 9 arquivos) | **77/77** |
| Regressão completa da engine (`npm run test:demurrage-engine`) | **801/801** |
| V1 (`npm test`) | **25/25** |
| UI D13 (`npm run test:demurrage-ui`) | **66/66** |
| `npx tsc --noEmit` | limpo |
| `npm run build` | limpo |
| Zero-escrita (fingerprint md5 de 20 tabelas, antes/depois de todas as rotas GET, incluindo composições G-A1, G-E7, G-E8, G-E9, G-D-INTEGRIDADE, G-D-SEM-CUSTO-CLIENTE) | **verde** |

Nota de ambiente: a suíte HTTP de D12 usa o pool padrão e precisa de
`DATABASE_URL`/`DEMURRAGE_DATABASE_URL` além de `DEMURRAGE_TEST_DATABASE_URL`.

## 6. Limitação conhecida (declarada, não escondida)

Os 7 indicadores sem composição permanecem sem lista paginável até existir uma
estratégia persistida/legível por SQL que não duplique `envelopeDoRelogio` nem
`avaliarCadencia`. Isso é uma decisão explícita desta versão, não uma lacuna
escondida: a resposta traz `drilldownDisponivel: false` e o motivo.

## 7. Status final

- **D14 permanece NÃO aprovada e NÃO congelada.**
- **A D15 não foi iniciada.**
- Entrega pronta para nova auditoria.
