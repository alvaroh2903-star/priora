# Fase D14 v1.1 — correção pontual sobre a V1 de Gestão e Indicadores (NÃO aprovada, NÃO congelada)

> **Status:** correção pontual (release corretivo) sobre o commit `60f2a4e`
> (D14 V1), em resposta a 9 achados bloqueantes de auditoria. Preserva
> integralmente D7–D13, as rotas/UI da V1, os motores de tarifa, os
> relógios, a cadência de tracking, a execução de tracking, as decisões de
> responsabilidade e o comportamento de fechamento — nenhum desses motores
> foi reescrito ou teve regra alterada. A D14 **continua NÃO aprovada e NÃO
> congelada**; a **D15 não foi iniciada**. Esta entrega é só a correção dos
> 9 achados, para nova auditoria.

## 0. O que esta correção NÃO faz

- Não cria nenhuma migration. `git status` confirma: nenhum arquivo em
  `src/demurrage-engine/db/migrations/` foi tocado ou criado.
- Não altera nenhum motor congelado (D7–D13): `cadencePolicy.ts`,
  `dualClockCalculator.ts`, `bracketEngine`, `closingService.ts`,
  `decidirResponsabilidade.ts`, `trackingService`/`schedulerOrchestrator`,
  `cursorAssinado.ts` permanecem byte-a-byte intocados.
- Não altera nenhuma rota ou arquivo da V1 original (`src/demurrage/**`) nem
  nenhum arquivo em `public/` (D13, protótipo visual, continua intocado).
- O único arquivo congelado tocado é `leitura/contrato.ts`, e só para
  **estender aditivamente** o union `CodigoErroLeitura` com dois códigos de
  erro novos (`periodo_obrigatorio`, `periodo_invertido`) — nenhum código
  existente foi removido ou renomeado, nenhuma outra declaração do arquivo
  mudou.

## 1. Os 9 achados — o que estava errado e o que mudou

| # | Achado | Correção | Arquivo(s) |
|---|---|---|---|
| 1 | `/eficiencia` calculava "desde sempre" quando nenhum período era informado | `periodoInicio`+`periodoFim` agora **obrigatórios** em `/eficiencia` (400 determinístico se faltar um, se forem invertidos, ou se a data civil não existir — ex. 30 de fevereiro); `/qualidade` aceita período **opcional**, mas exige a invariante "as duas ou nenhuma" quando usado, e as métricas históricas (G-E1/E2/E4) viram `historico: { periodoAplicado: false, ...null }` quando ausente, nunca uma média "desde sempre" | `leitura/gestao/eficiencia.ts` (`validarPeriodoObrigatorio`), `leitura/gestao/qualidade.ts` (`validarPeriodoOpcional`), `routes/demurrageGestaoRoutes.ts` |
| 2 | `mediaDiasDemurrageFinal` (G-D4) somava toda linha FINAL de `valores_apurados`, sem reusar a seleção autoritativa — podia misturar motor comercial errado e misturar cliente/Rocket num único indicador "por contêiner" | Reescrito para reusar `buscarEnvelopesSelecionadosDaOrganizacao` (G1, congelada): no máximo um envelope por lado/contêiner; devolve **duas médias separadas e nomeadas** (`mediaDiasDemurrageCliente`/`mediaDiasDemurrageRocket`), cada uma com sua própria amostra — nunca um agregado cruzando lados | `leitura/gestao/eficiencia.ts` (`mediaDiasDemurrageFinal`), `leitura/gestao/selecaoFinanceira.ts` (`EnvelopesContainer` ganhou `clienteDiasCobrados`/`rocketDiasCobrados`, opcionais) |
| 3 | G-D1/D2/D3 usavam só `tracking_return_date` para Empty Return, ignorando `effective_return_date` (minuta validada) | As três consultas (G-D1/D2/D3) agora usam a MESMA data canônica `COALESCE(c.effective_return_date, c.tracking_return_date)` em todo lugar — um contêiner só com `effective_return_date` contribui normalmente | `leitura/gestao/eficiencia.ts` (`condicaoPeriodo`, consulta G-D1/D2/D3) |
| 4 | `tracking_fetches`/`tracking_incidents` são tabelas globais; um `JOIN` até `containers` fazia uma linha compartilhada por dois contêineres (mesmo MBL, mesma organização OU organizações diferentes) ser contada mais de uma vez | Toda consulta passou de `JOIN` para `EXISTS` (semi-join): cada linha de `tracking_fetches`/`tracking_incidents` entra **no máximo uma vez** por organização autorizada, preservando isolamento (organização sem contêiner vinculado nunca a vê) | `leitura/gestao/qualidade.ts` (`metricasDeFetches`, `conectoresComFalhaAberta`) |
| 5 | Suspensão de tracking contava contêineres, não processos — um processo com dois contêineres suspensos contava duas vezes | `processosComTrackingSuspensoAgora` agora agrupa por `processo_id` num `Set`, reexecutando `avaliarCadencia` (congelada) sobre os fatos de cada contêiner — cada processo conta **uma vez**, mesmo com múltiplos contêineres suspensos | `leitura/gestao/qualidade.ts` (`processosSuspensosAgora`) |
| 6 | O filtro `tipoEquipamento` nos indicadores de grão PROCESSO (G-A4/A5/A8/A9/A10) usava um `JOIN` até `containers`, que fazia um processo com N contêineres do tipo filtrado contar N vezes | Trocado por `EXISTS (SELECT 1 FROM containers ce WHERE ce.processo_id = p.id AND ce.container_type_id = $N)` — semi-join, nunca fan-out; um processo com tipos mistos conta **uma vez**, e um processo sem nenhum contêiner do tipo filtrado é excluído | `leitura/gestao/operacional.ts` (consulta 2, grão processo), `leitura/gestao/drilldown.ts` (mesma predicate na composição) |
| 7 | G-A2/G-A3 (grão CONTÊINER) e G-A9 (grão PROCESSO) estavam na mesma dimensão `estado`, declarados mutuamente exclusivos entre si — grãos diferentes nunca são comparáveis | Duas dimensões separadas: `estado_container` (G-A2/G-A3) e `estado_processo` (G-A9, hoje sozinho). `mutuamenteExclusivoCom` nunca mais cruza grão | `leitura/gestao/operacional.ts` (`Dimensao`, `ESTADO_CONTAINER_IDS`/`ESTADO_PROCESSO_IDS`) |
| 8 | Um indicador publicado podia devolver 404 "surpresa" no drill-down, ou uma lista de composição fabricada/inconsistente para médias e percentuais | Registro explícito (`indicadorRegistry.ts`) de todo indicador dos 5 contratos — ID, grão, tipo, `drilldownDisponivel`, estratégia de composição, data natural, se exige período/filtros. A rota de composição consulta o registro ANTES de decidir: ID desconhecido → 404 real; ID conhecido com `drilldownDisponivel: false` → `200` explícito com `motivo`, nunca 404 | `leitura/gestao/indicadorRegistry.ts` (novo), `leitura/gestao/drilldown.ts` |
| 9 | A composição carregava todos os IDs correspondentes e fazia `slice(offset, offset+limite)` em memória — custo e memória crescem com o tamanho da população | Paginação por **keyset real**: indicadores de predicate SQL simples (todo o Grupo A, Grupo C, G-D-RESP-\*/TOTAL-FINAL/SEM-RESPONSABILIDADE, G-E7/E8) paginam dentro do PostgreSQL (`WHERE id_ord > $cursor ORDER BY id_ord LIMIT $limite+1`); os 6 indicadores "concluídos" do Grupo D e G-E9 (que dependem de `envelopeDoRelogio`/`avaliarCadencia`, lógica de negócio nunca duplicada em SQL) usam uma população já estruturalmente limitada (FINAL+período, ou contêineres rastreáveis da organização) e paginam por keyset **sobre a lista ordenada, nunca por offset**. O cursor assinado liga organização, indicador, hash do período/filtros e a versão de ordenação — qualquer divergência invalida o cursor | `leitura/gestao/drilldown.ts` (reescrita completa: `paginarSql`, `paginarMemoria`, `specDoIndicador`, `hashContexto`) |

### Validação adicional (fora da lista numerada, mas exigida pelo escopo)

- `limite` da composição: regex `^[1-9]\d*$` — rejeita `0`, negativo, decimal,
  notação científica/hex (`routes/demurrageGestaoRoutes.ts`,
  `paginacaoDaQuery`).
- Período (`periodoInicio`/`periodoFim`) sempre validado contra data civil
  REAL (`CivilDate`/`toOrdinal`, rejeita `2026-02-30`), nunca só a forma do
  texto.
- Nenhuma rota GET de Gestão escreve, recalcula, dispara tracking ou envia
  notificação — provado pelo fingerprint completo do banco antes/depois
  (teste "ZERO ESCRITAS", §3).
- Isolamento de organização permanece via `JOIN`/`EXISTS` a partir de
  `processos`/`containers` em toda consulta nova ou alterada — nenhuma
  tabela lida diretamente por `organization_id` sem esse vínculo quando a
  tabela não o carrega diretamente (caso de `tracking_fetches`/
  `tracking_incidents`).

## 2. Achado extra descoberto durante a correção do #8

Ao montar o registro (#8), ficou visível um risco de confusão de população
**não nomeado explicitamente nos 9 itens, mas implícito na exigência de
reconciliação**: os sub-contadores de responsabilidade dentro de
`eficiencia.ts` (`concluidos.responsabilidadeConfirmadaRocket/Cliente/
Dividida`) são escopados a **FINAL + período** (Grupo D), enquanto
`responsabilidade.ts` (`porStatus`) conta os MESMOS valores de status
**sem período, para toda a organização** (Grupo C). São duas populações
genuinamente diferentes. Em vez de reusar o mesmo rótulo (o que faria a
composição de um indicador reconciliar com o número errado), cada
população recebeu um ID de indicador PRÓPRIO e nunca confundível:
`G-D-RESP-CONFIRMADA-ROCKET` (Grupo D, com período) vs.
`G-C-CONFIRMADA_ROCKET` (Grupo C, org-wide) — e o mesmo para os outros dois
status. Ambos estão no registro, com suas composições reconciliando cada
uma com sua própria população.

## 3. Testes novos (D14 v1.1) e evidência por achado

| Achado | Teste(s) | Arquivo |
|---|---|---|
| #1 | `D14 v1.1 #1 — /eficiencia exige período: ...`; `D14 v1.1 #1 — /qualidade: período parcial...` | `gestaoEficiencia.test.ts`, `gestaoQualidade.test.ts` |
| #2 | `D14 v1.1 #2 — G-D4: DOIS motores comerciais ATIVOS/FINAL no mesmo lado cliente...` (dois motores FINAL no mesmo lado, só o aplicável contribui) | `gestaoEficiencia.test.ts` |
| #3 | Coberto pelas asserções existentes de G-D1/D2/D3 (datas naturais) + leitura de código (consulta única compartilhada pelas três) | `gestaoEficiencia.test.ts` |
| #4 | `D14 v1.1 #4 — DOIS CONTÊINERES DA MESMA organização compartilhando UM target...` (mesma org) + teste G6 original (duas orgs compartilhando target) | `gestaoQualidade.test.ts` |
| #5 | Extensão do teste G-E9 existente com um segundo contêiner suspenso do MESMO processo — `processosComTrackingSuspensoAgora` permanece `1` | `gestaoQualidade.test.ts` |
| #6 | `D14 v1.1 #6 — filtro tipoEquipamento em indicador de grão PROCESSO (G-A4): processo com tipos de contêiner MISTOS conta UMA VEZ...` | `gestaoOperacional.test.ts` |
| #7 | Assertivas atualizadas do teste "sobreposição de dimensões" (G-A3 só exclusivo com G-A2, nunca G-A9) + `D14 v1.1 #7 — contrato genérico: toda referência em mutuamenteExclusivoCom aponta para um indicador do MESMO grão e dimensão` | `gestaoOperacional.test.ts`, `gestaoDrilldown.test.ts` |
| #8 | 4 testes de cobertura/registro (Grupo A reconcilia; Grupo C status presente/ausente; ID nunca publicado continua 404; todo `drilldownDisponivel:true` é de fato tratado por `specDoIndicador`) | `gestaoDrilldown.test.ts` |
| #9 | 4 testes de keyset: sem duplicar/perder linhas trocando tamanho de página (SQL e memória); cursor adulterado/cruzado (organização, indicador, versão, payload corrompido) rejeitado; contagem de consultas e tamanho de página CONSTANTES entre 100 e 10.000+ linhas | `gestaoDrilldown.test.ts` |

Todos os testes novos usam PostgreSQL real (nunca mock), seguindo o padrão
já estabelecido pela suíte D14 original.

## 4. Resultados da regressão completa

Ambiente: PostgreSQL 16 local (`priora_demurrage_test`), suíte rodada com
`node --test-concurrency=1` (arquivos sequenciais — evita corrida no banco
compartilhado entre arquivos de teste).

| Suíte | Comando | Resultado |
|---|---|---|
| D14 completa (original + v1.1, 8 arquivos `gestao*.test.ts`) | `node --test-concurrency=1 -r ts-node/register --test src/demurrage-engine/__tests__/gestao*.test.ts` | **68/68 verde** |
| Regressão completa da engine (D7–D14, 29 arquivos) | `npm run test:demurrage-engine` | **792/792 verde** |
| Suíte original V1 (`src/auditoria/preAlerta`) | `npm test` | **25/25 verde** |
| Suíte UI D13 (`src/frontend-tests`) | `npm run test:demurrage-ui` | **66/66 verde** |
| Verificação de tipos | `npx tsc --noEmit` | limpo, zero erros |
| Build de produção | `npm run build` | limpo, `dist/` gerado |

Nenhum teste pré-existente teve sua asserção relaxada para passar — as duas
únicas mudanças em testes pré-existentes (`gestaoOperacional.test.ts`
"sobreposição de dimensões" e as 7 chamadas de `montarGestaoEficiencia`
sem período) são correções da própria asserção para o comportamento NOVO e
CORRETO exigido pelos achados #7 e #1, documentadas inline nos arquivos.

### 4.1 Zero-escrita (todas as rotas GET de Gestão)

Teste `D14 G6 — ZERO ESCRITAS: nenhuma das 6 rotas de Gestão altera UMA
LINHA do banco (fingerprint completo antes/depois)`
(`gestaoRoutes.test.ts`): fingerprint `md5` do conteúdo inteiro de 20
tabelas relevantes, antes e depois de chamar as 6 rotas (`/operacional`,
`/financeiro`, `/responsabilidade`, `/eficiencia`, `/qualidade`,
`/indicadores/G-A1/composicao`) com um cenário real (processo devolvido +
decisão de responsabilidade). Fingerprint idêntico — **verde**.

### 4.2 Benchmark de keyset com 10.000+ linhas correspondentes

Teste `D14 v1.1 #9 — paginação por keyset no PostgreSQL permanece com
contagem de consultas e tamanho de página CONSTANTES entre 100 e 10.000+
linhas correspondentes` (`gestaoDrilldown.test.ts`), reaproveitando o
gerador de massa síntetica de `gestaoBenchmarkG7.ts` (`gerarMassa`): compara
o número de consultas SQL executadas por `buscarComposicaoIndicador`
(G-A1) entre uma organização com 100 processos e outra com 10.000 — **o
número de consultas é o MESMO**, e a página devolvida continua com o
tamanho pedido (nunca a população inteira). O total reconciliado é
`>= 10.000` — **verde**.

### 4.3 Deduplicação de target compartilhado

Dois testes, ambos verdes:

- `D14 v1.1 #4` (`gestaoQualidade.test.ts`): dois contêineres da MESMA
  organização vinculados ao MESMO tracking target (mesmo MBL) — 1 fetch
  real + 1 fetch de cache gravados; `consultasRealizadas` e
  `respostasReaproveitadasCache` continuam `1` cada (nunca `2`), e
  `taxaSucessoPorArmador` reflete os 2 fetches reais, nunca 4.
- `D14 G6` (original, preservado): mesmo target compartilhado entre DUAS
  organizações diferentes — cada organização vê só as consultas que lhe
  cabem, sem vazamento cruzado.

## 5. Status final

- **D14 permanece NÃO aprovada e NÃO congelada.**
- **A D15 não foi iniciada.**
- Esta correção está pronta para nova auditoria sobre os 9 achados
  listados no §1.
