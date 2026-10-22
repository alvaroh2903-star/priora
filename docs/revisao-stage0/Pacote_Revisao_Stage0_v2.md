# Pacote de revisão — Stage 0 corrigido (v2)

> **Nota de publicação (22/10/2026).** Este pacote foi publicado como documentação no branch de revisão, num commit **só de documentação** sobre o `9e1fcaa`. O código em revisão continua sendo `8e055b0..9e1fcaa`.
>
> Onde o texto fala em "anexos":
>
> - **Diff completo:** comparação `8e055b0...9e1fcaa` no GitHub, ou `git diff 8e055b0 9e1fcaa`.
> - **`docs/diagnostico-relatorios-stage0.md`:** já está no repositório, no próprio `9e1fcaa`.
> - **`Priora_Diagnostico_Courrier_Rev3.md` e `Matriz_Requisitos_Courrier.md`:** nesta mesma pasta, com notas sobre as revisões avaliadas e o que ficou desatualizado.
> - **`carga-sintetica.json` e os registros sintéticos do cenário ponta a ponta:** não foram publicados neste commit. São dados sintéticos gerados pelos testes; a carga é reproduzível com `DIAG_CARGA=1 npm run diag:selftest`.
>
> Desde a redação, a Linha A continua em `8e055b0`. A Linha B avançou para `0ae78a9`, que não é usada neste pacote.
>
> O texto abaixo da linha horizontal está sem alteração. O diagnóstico continua desligado: nada foi publicado, ativado ou medido em produção.

---

21–22/10/2026 (seção 12 acrescentada em 22/10 para a revisão de código) · só instrumentação de medição. Não inclui nenhuma mudança funcional do Blueprint, otimização ou alteração de Delivered.

Rótulos usados:

- **[sintético]** — gerado em teste, com dependências falsas e valores escolhidos por mim.
- **[código]** — lido no código.
- **[config]** — lido em arquivo de configuração.
- **[GitHub API]** — consultado no GitHub.
- **[relatado]** — afirmado por terceiros, não verificado.

**Não há nenhuma constatação de produção neste pacote.**

---

## 1. Identificadores

| Item | Valor |
|---|---|
| Base (tip da Linha A `claude/demurrage-api-playwright-5q2lqq`, conferido antes de editar e de novo antes do push) | `8e055b09825ee2c2cb729de38c2169d91c6e1399` |
| Branch de revisão (novo) | `claude/stage0-diag-relatorios-revisao` |
| Commit resultante | `eb857dc172852b3dbfc4f6e98a803399c20734c7` (instrumentação) → **`9e1fcaafd725f4ed5ec550fe145d44c54e3e6e65`** (correção só dos testes, depois da falha do CI) = **head do branch de revisão** |
| Diff completo | `stage0v2_8e055b0..9e1fcaa.diff` e `.patch` (anexos) |
| Deploy, ativação, dados ou logs de produção | **nenhum** |
| Push em branch existente | **nenhum** (nem na Linha A, nem no branch padrão) |

A Linha A **não avançou** desde `8e055b0` durante o trabalho. Conferi antes de editar e antes do push (`8e055b0` em 21/10 23:50 UTC e de novo em 22/10 00:13 UTC, antes do segundo push).

## 2. Mudanças recentes da base, preservadas

**[código]** O `a4096c8` e o `8e055b0` foram inspecionados antes de editar. Ficaram intactos:

- **Leitura de anexos:**
  - listagem com `$select('id,name,contentType,size,isInline')`, sem `contentBytes`;
  - um `GET` com `$expand` por `itemAttachment`;
  - `mapLimit(withAtt, 5, …)` nas duas rotas.
- **Memória:** o tratador de `unhandledRejection`, o amostrador de memória e `/health/jobs` (`index.ts`).

A instrumentação só **envolve** chamadas existentes (`observarGraph(…, client…get())`, `observarIa(…, attempt)`) e acrescenta linhas de cobertura. Nenhuma linha de negócio foi removida ou reordenada; o diff da seção 4 mostra isso. A leitura antiga de anexos não foi restaurada.

## 3. Correções pedidas → onde e como foram verificadas

| # | Correção | Onde | Evidência (teste) |
|---|---|---|---|
| 1 | Port para o código atual | `courierRoutes.ts`, `demurrageRoutes.ts` (ganchos ao redor do `mapLimit`), `graphService.ts` (`anexos.lista`/`anexos.item`), `geminiClient.ts`, `index.ts` | `relatoriosRotas.test.ts`: resposta **e chamadas** ao Graph e à IA idênticas com o diagnóstico desligado e ligado, nas duas rotas |
| 2 | Pendência duplicada; níveis distintos | `relatoriosDiag.ts`: `tarefas`, `chamadas.graph`, `chamadas.ia.{iniciais, retentativas}`; `pendentesAoResponder = { tarefas, chamadasGraph, chamadasIa }`, **sem total** | `relatoriosDiag.test.ts` "níveis separados"; `relatoriosRotas.test.ts` demurrage: 14 tarefas = 14 chamadas iniciais, 1 nova tentativa (não vira tarefa), 1 tarefa e 1 chamada pendentes, que terminam uma vez cada no registro tardio; resumo: "(= 1 por tarefa)" e "níveis distintos, não somar" |
| 3 | Correlação por organização + conta + tentativa | escopo `org\|acc` no registro de concorrência, nos limites e no `relatoriosResumo` (chave `org\|acc\|att`, operações `org\|acc\|op`); `op`/`att` só como correlação, validados por formato | "isolamento: … por organização + conta"; "resumo: junção escopada…" (mesmo `att` em duas contas não casa); "IDs … malformados são descartados" |
| 4 | Envio só da sessão autenticada da conta Microsoft ativa | `diagRoutes.ts`: `homeAccountId` = conta ativa **e** presente no cache do MSAL (sem renovar token); se não confere, `403` e nada registrado; nunca `401` | "envio: só da sessão autenticada da conta ATIVA…" (sem sessão, outra conta, fora do cache) |
| 5 | Nada para não autenticados; ingestão limitada | rastro **provisório** antes do `requireAuth`, que só vale depois dele (header e registro só então); `diagLimiteCorpo` antes do `express.json`; `LIMITES_DIAG` | "sem login: nenhuma linha…"; testes de 413/411, 20 por envio, 30 envios/min (`429` + `off`), 120 eventos/min, 60 por operação, 600 linhas/min, um resumo de descartes por janela, teto de 500 rastros, rastro vencido de 10 min |
| 6 | Salt dedicado obrigatório | `lerConfig`: exige `PRIORA_DIAG_SALT` ≥ 32 caracteres e ≠ `SESSION_SECRET`; sem fallback; configuração inválida desliga e gera uma linha `relatorios.config` sem valores | "configuração: sem salt dedicado…" (as rotas de negócio seguem normais) |
| 7 | Desativação efetiva em páginas abertas; buffer limitado | `Relatorios.dc.html`: estados desconhecido/ligado/desligado; resposta sem header desliga; envio por `fetch` keepalive que para em `403`/`429`/`off`/erro; log ≤ 100, fila ≤ 20, ≤ 40 envios por página, um envio por vez | "desativação com a página aberta…"; "servidor recusa (403, 429, off)…"; "limites — fila ≤ 20…"; "desligado → próximas tentativas sem IDs…" |
| 8 | Falha da telemetria não quebra a Relatórios | navegador: rastreador inerte, `try/catch` em tudo; servidor: `try/catch` por ponto, `next()` uma única vez, `finally` que encerra o rastro | navegador: equivalência com a página original de `8e055b0` sob 4 falhas injetadas e 3 recusas; servidor: falha injetada em 10 pontos, com resposta e chamadas externas idênticas |
| 9 | Overhead sob concorrência, incluindo o histograma por requisição | histograma por requisição **substituído** por um amostrador único compartilhado (`setInterval` de 50 ms, ligado só com rastro ativo) mais ELU por requisição | `relatoriosCarga.test.ts` (seção 7); "um único timer de amostragem…" (100 simultâneas → 1 timer; 0 ocioso) |

## 4. Arquivos alterados (base `8e055b0` → 9e1fcaa)

```
 docs/diagnostico-relatorios-stage0.md |  214 +++++++
 package.json                          |    2 +
 public/Relatorios.dc.html             |  113 +++-
 src/ai/geminiClient.ts                |    3 +-
 src/diag/relatoriosCarga.test.ts      |  226 +++++++
 src/diag/relatoriosCliente.test.ts    |  452 ++++++++++++++
 src/diag/relatoriosDiag.test.ts       |  659 ++++++++++++++++++++
 src/diag/relatoriosDiag.ts            | 1085 +++++++++++++++++++++++++++++++++
 src/diag/relatoriosResumo.ts          |  370 +++++++++++
 src/diag/relatoriosRotas.test.ts      |  438 +++++++++++++
 src/graph/graphService.ts             |   82 ++-
 src/index.ts                          |    4 +
 src/routes/courierRoutes.ts           |   32 +-
 src/routes/demurrageRoutes.ts         |   36 +-
 src/routes/diagRoutes.ts              |   76 +++
 15 files changed, 3754 insertions(+), 38 deletions(-)
```

**Código de negócio tocado:** só envolvimentos e linhas de cobertura.

- `courierRoutes.ts` +30/−2
- `demurrageRoutes.ts` +34/−2
- `graphService.ts` +54/−28 (reindentação dos `client…get()` dentro de `observarGraph`)
- `geminiClient.ts` +2/−1
- `index.ts` +4

**Arquivos novos:**

- `src/diag/relatoriosDiag.ts`
- `src/diag/relatoriosResumo.ts`
- `src/routes/diagRoutes.ts`
- 4 arquivos de teste
- o procedimento

## 5. Testes executados

Todos isolados: Graph, MSAL e Gemini falsos; rede bloqueada fora de 127.0.0.1; diretórios temporários.

| Execução | Resultado |
|---|---|
| `npm run diag:selftest` com `RELATORIOS_HTML_ORIGINAL` = página de `8e055b0` e bloqueio de rede via `NODE_OPTIONS` (4 CPUs) | **41 testes: 40 ok, 1 pulado** (carga, que só roda com `DIAG_CARGA=1`) · 37 s · 0 conexões bloqueadas |
| A mesma suíte restrita a **1 CPU** (`taskset -c 0`), 2 vezes | 40/40 ok nas duas · 83–85 s |
| Por arquivo | cliente 16 · servidor/unidade 20 · rotas reais e ponta a ponta 4 · carga 1 (pulado; rodado à parte com `DIAG_CARGA=1`: ok) |
| `npm test` (preAlerta + ceMercante), com bloqueio de rede | 78/78 |
| Selftests que importam módulos alterados, com bloqueio de rede: `autosync`, `reconciliation`, `ports`, `security`, `demurrage:calc` | todos ok · 0 conexões bloqueadas |
| `tsc --noEmit` e `npm run build` | ok; os testes ficam fora de `dist` |
| CI run 57 (commit `eb857dc`) | **falhou** em `diag:selftest`: isolamento entre testes (detalhes na seção 9). Os outros 32 selftests passaram, inclusive `browser:smoke`. |
| CI run 58 (commit `9e1fcaa`, correção só dos testes) — **resultado por script; ver 12.4** | **passou**: typecheck, build e **33/33 self-tests OK**, incluindo `diag:selftest` (run 58, 22/10 00:13–00:16 UTC) |

**O que os testes cobrem, em resumo:**

- **Equivalência da tela:** a página foi comparada à original de `8e055b0` em 5 cenários. Cada cenário rodou desligado, ligado, com 4 falhas injetadas (`crypto`, `headers.get`, `fetch` do envio, sem `document`) e com 3 recusas do servidor (403, 429, off).
- **Equivalência das rotas:** corpo das respostas **e** chamadas ao Graph e à IA idênticos entre desligado e ligado.
- **Falhas injetadas no servidor:** 10 pontos, com resposta e chamadas idênticas.
- **Correções 2 a 8:** testes dedicados, listados na seção 3.

**Não executado localmente:** o `selftest:all` completo. O `browser:smoke` navega até `example.com` pelo Chromium, fora do alcance do bloqueio de rede do Node. O CI rodou esse conjunto (seção 9). O script novo se chama `diag:selftest`, seguindo a convenção do projeto, e por isso também entra no CI.

## 6. Relatório de medição — **SINTÉTICO** (cenário ponta a ponta corrigido)

**Condições:**

- base `8e055b0` + instrumentação;
- tempo escalado ÷20 (ms nominais; a CPU aparece ×20);
- atrasos escolhidos por mim:
  - busca: 12 s;
  - listagem de anexos: 1 s (uma de 12 s);
  - `GET` de item: 1 s;
  - IA: 3 s (uma de 30 s, uma com 503 seguido de nova tentativa);
  - auth: 0,3 s;
- caixa: 60 mensagens, 30 com anexo.

**Isto demonstra o mecanismo e a contagem; não mede produção.**

```
Registros: 5 req · 5 tardio · 10 cliente

[navegador] Operações /api/couriers: 1 (com dados: 1)
  tentativas por operação: 1:1 · ms até ter dados: p50 28760 · p90 28760 · máx 28760 (n=1)
  [junção] por operação — chamadas Graph: p50 47 · p90 47 · máx 47 (n=1) · tarefas Clara: p50 0 · p90 0 · máx 0 (n=1) · chamadas de IA (iniciais+novas tentativas): p50 0 · p90 0 · máx 0 (n=1)

[navegador] Operações /api/demurrage: 1 (com dados: 0)
  tentativas por operação: 4:1 · ms até ter dados: —
  [junção] por operação — chamadas Graph: p50 188 · p90 188 · máx 188 (n=1) · tarefas Clara: p50 56 · p90 56 · máx 56 (n=1) · chamadas de IA (iniciais+novas tentativas): p50 60 · p90 60 · máx 60 (n=1)

[navegador] Tentativas /api/demurrage: 4 · desfechos timeout:4 · limite 15000:4
  ms (ok): — · com outra em voo: 4 (mesma URL: 3) · aba oculta: 0
  respostas que chegaram DEPOIS do timeout: 4 · ms após o limite: p50 35540 · p90 35900 · máx 35900 (n=4)

[navegador] Tentativas /api/couriers: 1 · desfechos ok:1 · limite 40000:1
  ms (ok): p50 28760 · p90 28760 · máx 28760 (n=1) · com outra em voo: 0 (mesma URL: 0) · aba oculta: 0
  respostas que chegaram DEPOIS do timeout: 0 · ms após o limite: —

[servidor] /api/couriers: 1 req · origem relatorios:1 · status 200:1
  ms resposta: p50 28591 · p90 28591 · máx 28591 (n=1) · ms auth: p50 307 · p90 307 · máx 307 (n=1)
  1ª do processo: 0 · uptime<60s: 1 · com outra em curso no início: 0 · com outra iniciada durante: 1 · desconexões: 0
  event loop — atraso máx: p50 1 · p90 1 · máx 1 (n=1) · utilização: p50 0.023 · p90 0.023 · máx 0.023 (n=1)
  TAREFAS:
    searchLogistics: iniciadas 1 · ok 1 (vazias 0, falhas engolidas 0) · erro 0 · códigos — · limite do servidor 0 · terminaram após o limite 0 · ms máx 12011
    itemAttachment: iniciadas 25 · ok 24 (vazias 4, falhas engolidas 1) · erro 0 · códigos 429:1 · limite do servidor 1 · terminaram após o limite 0 · ms máx 2034
  CHAMADAS Graph (máx simultâneas por req: p50 5 · p90 5 · máx 5 (n=1)):
    busca: iniciadas 1 · ok 1 · erro 0 · códigos — · ms máx 12010
    anexos.lista: iniciadas 25 · ok 23 · erro 1 · códigos 429:1 · ms máx 1020
    anexos.item: iniciadas 20 · ok 20 · erro 0 · códigos — · ms máx 1017
  anexos (mensagens): elegiveis:30 selecionados:25 puladosPorLimite:5 tentados:25 comTextoUsado:20 semTexto:3 falhas:1 limiteServidor:1 pendentesAoResponder:1
  anexos listados (tipo / bytes DECLARADOS): listagens:23 arquivo:26 item:20 referencia:0 outro:0 bytesDeclaradosArquivo:11900000 bytesDeclaradosItem:600000
  busca no máximo pedido: 1 · Graph indicou mais resultados (nextLink): 1
  pendente ao responder — tarefas itemAttachment:1 | chamadas Graph 1 | chamadas IA 0 (níveis distintos, não somar) · req com trabalho tardio: 1

[servidor] /api/demurrage: 4 req · origem relatorios:4 · status 200:4
  ms resposta: p50 50486 · p90 50782 · máx 50782 (n=4) · ms auth: p50 296 · p90 320 · máx 320 (n=4)
  1ª do processo: 0 · uptime<60s: 4 · com outra em curso no início: 4 · com outra iniciada durante: 3 · desconexões: 0
  event loop — atraso máx: p50 1 · p90 15 · máx 15 (n=4) · utilização: p50 0.024 · p90 0.033 · máx 0.033 (n=4)
  TAREFAS:
    searchDemurrage: iniciadas 4 · ok 4 (vazias 0, falhas engolidas 0) · erro 0 · códigos — · limite do servidor 0 · terminaram após o limite 0 · ms máx 12073
    itemAttachment: iniciadas 100 · ok 100 (vazias 16, falhas engolidas 4) · erro 0 · códigos 429:4 · limite do servidor 4 · terminaram após o limite 4 · ms máx 13027
    claraDemurrage: iniciadas 56 · ok 52 (vazias 0, falhas engolidas 0) · erro 0 · códigos — · limite do servidor 4 · terminaram após o limite 0 · ms máx 4847
  CHAMADAS Graph (máx simultâneas por req: p50 5 · p90 5 · máx 5 (n=4)):
    busca: iniciadas 4 · ok 4 · erro 0 · códigos — · ms máx 12072
    anexos.lista: iniciadas 100 · ok 96 · erro 4 · códigos 429:4 · ms máx 12010
    anexos.item: iniciadas 84 · ok 84 · erro 0 · códigos — · ms máx 1024
  CHAMADAS de IA (até a resposta): iniciais 56 · novas tentativas 4 · ok 52 · erro 4 503:4 · sem usageMetadata 0 · tokens informados entrada:52000 saida:2600 pensamento:0 cache:0 total:54600
  anexos (mensagens): elegiveis:120 selecionados:100 puladosPorLimite:20 tentados:100 comTextoUsado:80 semTexto:12 falhas:4 limiteServidor:4 pendentesAoResponder:0
  anexos listados (tipo / bytes DECLARADOS): listagens:96 arquivo:108 item:84 referencia:0 outro:0 bytesDeclaradosArquivo:49200000 bytesDeclaradosItem:2520000
  busca no máximo pedido: 4 · Graph indicou mais resultados (nextLink): 4
  pendente ao responder — tarefas claraDemurrage:4 | chamadas Graph 0 | chamadas IA 4 (níveis distintos, não somar) · req com trabalho tardio: 4

[servidor] Trabalho DEPOIS da resposta /api/couriers: 1 req (encerrados por tempo: 0) · último término após a resposta: p50 4859 · p90 4859 · máx 4859 (n=1)
  tarefa itemAttachment: terminaram 1 (ok 1, erro 0) · após o limite 1 · iniciadas depois 0
  chamada Graph anexos.lista: terminaram 1 · iniciadas depois 0
  chamada Graph anexos.item: terminaram 1 · iniciadas depois 1

[servidor] Trabalho DEPOIS da resposta /api/demurrage: 4 req (encerrados por tempo: 0) · último término após a resposta: p50 7999 · p90 8012 · máx 8012 (n=4)
  tarefa claraDemurrage: terminaram 4 (ok 4, erro 0) · após o limite 4 · iniciadas depois 0
  chamadas de IA: terminaram ok 4 / erro 0 · iniciadas depois 0 · tokens informados entrada:4000 saida:200 pensamento:0 cache:0 total:4200

[reconciliação IA] tarefas Clara 56 · chamadas iniciais 56 (= 1 por tarefa) · novas tentativas 4 · terminaram ok 56 / erro 4 · pendentes na resposta: tarefas 4, chamadas 4 · tokens informados entrada:56000 saida:2800 pensamento:0 cache:0 total:58800

[junção navegador×servidor, por organização+conta] tentativas 5 · com registro do servidor 5
  timeouts no navegador 4 · servidor levou mais que o limite 4 · sem registro do servidor 0 (causa não determinável só com estes dados)
  respostas que chegaram ao navegador depois do timeout: 4
```

**Reconciliação por nível (sintético):**

| Nível | Por tentativa de `/api/demurrage` | 4 tentativas |
|---|---|---|
| Conversas candidatas → selecionadas (`AI_CAP = 14`) | 16 → 14 | — |
| **Tarefas** de extração (`claraDemurrage`) | 14 | 56 |
| **Chamadas** de IA iniciais (1 por tarefa) | 14 | 56 |
| **Novas tentativas** (após 503) | 1 | 4 |
| Chamadas de IA no total | 15 | 60 |
| Tarefas que estouraram 22 s | 1 | 4 |
| Pendente na resposta — tarefas | 1 | 4 |
| Pendente na resposta — chamadas de IA (o **mesmo** trabalho, em outro nível) | 1 | 4 |
| Concluídas depois da resposta | 1 tarefa e 1 chamada (ok) | 4 e 4 |
| Tokens **informados pelo provedor falso** (valores fixos do teste) | 14.700 | 58.800 |

As 4 chamadas com 503 não trazem `usageMetadata` no falso. Elas registram 0 e não são estimadas.

**Leitura de anexos (`/api/couriers`, sintético):**

- 25 tarefas e 25 listagens; 20 `GET` de item (só nas mensagens com e-mail encaminhado);
- 1 falha 429 engolida pela função, contada como falha (e não como "sem texto");
- 1 tarefa estourou os 8 s, liberou a vaga do lote de 5 e terminou depois da resposta;
- máximo de chamadas Graph simultâneas observado: 5. Neste cenário a mensagem lenta era a última do lote; o campo mediria mais de 5 se houvesse mensagens na fila.

## 7. Overhead sob concorrência — **SINTÉTICO**

**Condições:**

- máquina do sandbox (4 vCPU Intel(R) Xeon(R) Processor @ 2.10GHz, Node v22.22.0);
- cliente HTTP e servidor no **mesmo processo**;
- rotas reais da Linha A com Graph, MSAL e Gemini falsos, com atrasos fixos e pequenos (busca 20 ms, anexos 5 ms, IA 20 ms). As requisições ficam dominadas pela CPU do próprio processamento;
- 5 rodadas por cenário, com as variantes **intercaladas**; mediana entre rodadas;
- as linhas de diagnóstico são serializadas e descartadas (o custo de stdout não entra).

Execução: `DIAG_CARGA=1 npm run diag:selftest` (arquivo `relatoriosCarga.test.ts`); JSON bruto em `carga-sintetica.json`.

Variantes:

- **A** — desligado;
- **B** — ligado (v2: amostrador único + ELU);
- **C** — ligado + um `monitorEventLoopDelay` **por requisição**, emulando o desenho anterior.

| Rota | Concorrência | CPU/req A (desligado) | CPU/req B (v2) | CPU/req C (histograma por req, v1) | p95 A / B / C (ms) |
|---|---|---|---|---|---|
| `/api/couriers` | 1 | 15.1 ms | 16.8 ms (+11%) | 17.9 ms (+18%) | 87 / 88 / 88 |
| `/api/couriers` | 10 | 10.8 ms | 11.1 ms (+3%) | 12.6 ms (+16%) | 176 / 170 / 182 |
| `/api/couriers` | 50 | 10.9 ms | 12.1 ms (+11%) | 15.1 ms (+38%) | 570 / 596 / 711 |
| `/api/couriers` | 100 | 10.0 ms | 10.5 ms (+5%) | 11.4 ms (+14%) | 1026 / 1061 / 1068 |
| `/api/demurrage` | 10 | 9.2 ms | 9.8 ms (+7%) | 10.1 ms (+10%) | 145 / 152 / 169 |
| `/api/demurrage` | 50 | 7.3 ms | 8.2 ms (+12%) | 8.6 ms (+17%) | 385 / 398 / 414 |

**Leitura (sintética):**

- **B (corrigido):** acrescentou de **+0,3 a +1,7 ms de CPU por requisição (+3% a +12%)**, sempre abaixo de C.
- **C (histograma por requisição, desenho anterior):** de **+0,9 a +4,2 ms (+10% a +38%)**. O pior caso é com 50 requisições simultâneas em `/api/couriers`. Por isso o histograma por requisição foi **substituído** por um amostrador único.
- **Latência p50/p95:** as diferenças ficaram dentro do ruído, sem padrão consistente entre as variantes (em alguns níveis, B ficou abaixo de A).
- **Timers:** o pico de timers JS ativos (milhares sob carga) é dominado pelos timers do `withTimeout` das rotas, que **nunca são cancelados** — comportamento existente **[código]**, fora do escopo e não alterado. Esse pico não serve para comparar as variantes e não enxerga os timers nativos do histograma. A garantia de **1 timer** do diagnóstico, independente da concorrência, vem do teste dedicado: 100 requisições simultâneas dão 1 timer, e 0 quando ocioso.

**Limitações da medição:**

- uma máquina só, compartilhada, com ruído;
- carga sintética com pouca latência externa: com o Graph e o Gemini reais, que levam centenas de ms, a fração relativa muda;
- a produção roda com 0,5 vCPU;
- sem desvio-padrão (só mediana de 5 rodadas);
- o custo de escrita no stdout do Render não entra.

**Não tratar estes números como desempenho de produção.**

## 8. Limitações remanescentes

- **Medição real:** nenhuma. As hipóteses H1–H8 continuam abertas.
- **Desfechos 401:** não são registrados no servidor (requisição sem login), por exigência da correção 5. Ficam só no log local da página (`window.__prioraDiag`).
- **Tentativas iniciais:** antes da primeira resposta da página, o navegador não sabe se o diagnóstico está ligado. As primeiras tentativas sempre levam IDs, e até 20 eventos ficam em memória. Se o servidor for ligado com a página aberta e desligada, a correlação recomeça só nas tentativas seguintes.
- **Concorrência medida depois da autenticação:** `concorrencia.noInicio` é tirado no fim do `requireAuth`, não na chegada da requisição.
- **AsyncLocalStorage:** depois de ligado uma vez, o hook do Node fica ativo até o processo reiniciar.
- **Testes não cobertos:**
  - nenhum teste verifica diretamente que o middleware desligado não envolve `res.end`. A evidência é indireta: sem header, sem linhas, respostas idênticas;
  - os dois limites de memória da ingestão (2.000 operações lembradas e a poda de 1.000 contas) **não têm teste dedicado**. A análise está na seção 12.3.
- **Limites operacionais:** a cota de 600 linhas/min é por processo. Acima dela os registros são descartados e só aparecem no resumo de descartes, o que pode cortar registros tardios sob carga alta.
- **Pseudônimos:** HMAC truncado em 64 bits; trocar o salt quebra a ligação entre janelas.
- **Overhead:** medido com cliente e servidor no mesmo processo, sem custo de stdout e numa única máquina de CI/sandbox. Ver seção 7.
- **Herdado da Linha A:** continua o log `[Gemini][custo]`, com preços de lista não verificados. Não foi tocado nem é usado.

## 9. Automação disparada pelo push do branch de revisão

- **[config]** O `ci.yml` da Linha A roda em qualquer push. Ele executa:
  - `npm ci` e `npx playwright install --with-deps chromium`;
  - typecheck, build e `selftest:all`, que inclui o `browser:smoke`, com navegação a `example.com`.

  Nenhuma chamada a Graph, Gemini, transportadora ou produção, pelo que inspecionei.
- **[config, relatado no comentário do `render.yaml`]** O Render publica só o branch da Linha A; não há PR nem preview.
- **[GitHub API]** Push → CI:
  - **run 57** (`eb857dc`): **falhou** em `diag:selftest`. Duas causas, ambas nos testes e não na instrumentação:
    - registros tardios de testes anteriores (tarefas de 600 ms) caíam na contagem de testes seguintes (599 ≠ 600; tardios ≠ 100);
    - o `setInterval` do teste de timers, sem `finally`, segurou o processo até o limite de 5 min do runner (`spawnSync npm ETIMEDOUT`).
  - Corrigido em **`9e1fcaa`**, só nos testes:
    - cada teste espera o fim dos rastros ativos;
    - o intervalo é liberado em `finally`;
    - a tarefa que não terminava sozinha é liberada no fim do teste;
    - as rodadas de falha injetada esperam 800 ms.
  - **run 58** (`9e1fcaa`): **sucesso**, 33/33.
- O push não disparou nenhum outro workflow, deploy ou PR. O `/health` de produção não foi consultado, para evitar qualquer acesso à produção.

## 10. Procedimento de medição e rollback

Atualizado em `docs/diagnostico-relatorios-stage0.md` (anexo). Pontos principais:

- **Ativação:** `PRIORA_DIAG_RELATORIOS=on` **e** `PRIORA_DIAG_SALT` dedicado. Com salt inválido, nada é coletado e aparece uma linha `relatorios.config`.
- **Duração da janela: não definida.** Os 45 min não estão aprovados; é decisão sua depois da revisão.
- **Sequência:** linha de base desligado → ativar → cenários A–E → condições de parada → exportar só as linhas `"diag":"relatorios.` → desativar. As páginas abertas param sozinhas.
- **Rollback:**
  - nível 1: remover as variáveis;
  - nível 2: redeploy do commit anterior ou `git revert` na Linha A.

  Sem migration nem estado persistido.

## 11. Diagnóstico e matriz

- `Priora_Diagnostico_Courrier_Rev3.md` — o relatório completo da revisão 3, sem alteração.
- `Matriz_Requisitos_Courrier.md` — a matriz completa, extraída sem mudanças da seção 2 (uma linha por identificador: GOV, REL, ENT, ASS, TRN/TMP, CNF, RES, ETA, CLA, SOL, KPI, HIS, AC/CT, DEP, VAL, LAC), com uma ressalva de data sobre `8e055b0`.
- As partes da Rev3 desatualizadas por `8e055b0` seguem as do pacote anterior:
  - o teto de ~28 s de `/api/couriers` no R3.3;
  - a hipótese H3b, de bytes de PDF baixados.

## 12. Esclarecimentos para a revisão de código

Só com evidência que já existe. Nada foi implementado, alterado ou testado de novo para esta seção, e o diagnóstico continua **desligado** por padrão.

### 12.1 Cache e exposição da ativação entre usuários

- **Rotas de negócio (`GET /api/couriers` e `GET /api/demurrage`):**
  - Nenhuma rota define `Cache-Control`, `Expires` ou `Vary`, antes ou depois do Stage 0 **[código: busca em `index.ts`, `courierRoutes.ts`, `demurrageRoutes.ts`]**.
  - O Express usa o padrão `etag: 'weak'`, verificado na versão instalada. O ETag é calculado sobre o **corpo** em `res.json`, e o Stage 0 não altera o corpo: há testes de corpo idêntico byte a byte, ligado e desligado, nas duas rotas. Logo o ETag e o comportamento de revalidação (`If-None-Match` → `304`) são os mesmos. Isso é inferência do código do Express; nenhum teste compara o header `ETag` diretamente.
  - O Stage 0 só **acrescenta** o header de resposta `X-Priora-Diag: on`. Ele é posto depois do `requireAuth`, por isso também sai num `304` de requisição autenticada. Não adiciona `Cache-Control` nem `Vary`.
  - No navegador, os headers `X-Priora-Op` e `X-Priora-Attempt` são de **requisição**. Sem `Vary`, não entram na chave de cache, e o modo de cache do `fetch` não foi alterado.
- **Rota nova (`POST /api/diag/relatorios`):** responde com `Cache-Control: no-store` e sem corpo.
- **Exposição entre usuários:**
  - A ativação é **global do processo** (variáveis de ambiente), não por conta.
  - O header leva só a constante `on`/`off`: nenhum pseudônimo, ID de conta ou ID de correlação. O servidor nunca devolve `X-Priora-Op`/`X-Priora-Attempt`.
  - O header só sai para requisições **autenticadas**; o teste "sem login" verifica a ausência.
  - O estado do navegador (`window.__prioraDiag`) é por página.
  - **Não verificado:** se algum intermediário (proxy do Render) armazena essas respostas autenticadas. Se armazenasse, o problema principal seria o **corpo** de negócio, que já existia antes; o header do Stage 0 não acrescenta nada específico de conta.

### 12.2 Como os resumos sinalizam registros descartados (trace incompleto ≠ medição completa)

**Contado e registrado:**

- Os descartes do servidor geram uma linha `relatorios.descartes` por janela de 60 s, com contagem por motivo:
  - `cota_linhas_processo`;
  - `rastros_ativos_max`;
  - `taxa_envios_conta`;
  - `taxa_eventos_conta`;
  - `teto_operacao`;
  - `excesso_no_envio`;
  - `evento_invalido`.
- Essa linha fica fora da cota de linhas, mas é emitida por um timer `unref`: **se o processo terminar antes, o resumo de descartes se perde**.
- Configuração inválida gera `relatorios.config`.
- Rastro encerrado à força sai como `relatorios.tardio` com `encerradoPorTempo: true` e `pendentesNaoConcluidos`.

**O que o `relatoriosResumo` faz:**

- soma `descartes` e `errosConfig` e os imprime **no topo** do texto ("Descartes por limite: …");
- separa "timeouts sem registro do servidor" e diz que a causa não é determinável;
- **não** atribui um descarte a um trace específico (a linha descartada não existe);
- **não** marca hoje, por requisição, o caso "pendente na resposta e sem registro tardio". O dado existe (`pendentesAoResponder` × presença do `relatorios.tardio` pelo `rid`), mas a verificação não está automatizada. É uma lacuna, não corrigida nesta etapa.

**Regra de leitura proposta para a medição** (sem implementar):

1. Janela com qualquer `relatorios.descartes` ou `relatorios.config` é **incompleta** e não serve como medição completa.
2. Requisição com algum pendente na resposta e sem `relatorios.tardio` correspondente é **trace incompleto**: descartado, processo reiniciado ou ainda rodando na exportação.
3. Tentativa do navegador sem registro do servidor é **sem junção**, não "servidor rápido".

**Nunca sinalizado** (fica invisível):

- requisições sem login (por exigência da correção 5);
- tudo com o diagnóstico desligado;
- descartes **do navegador**: fila de 20 que perde os mais antigos, log de 100, teto de 40 envios, parada após recusa. O navegador não reporta o que descartou; os eventos de navegador de uma janela podem estar incompletos sem aviso.

### 12.3 Memória: o que limita as estruturas lembradas

| Estrutura | Limite | Como | Testado? |
|---|---|---|---|
| Rastros ativos | 500 | novos acima disso não são rastreados (descarte contado) | **sim** |
| Rastro sem conclusão | 10 min | varredura a cada nova autenticação; libera e emite `encerradoPorTempo` | **sim**. Sem novas requisições, a varredura não roda; o teto de 500 continua valendo. |
| Linhas por minuto | 600 | janela fixa de 60 s | **sim** |
| **Operações lembradas** (`eventosPorOperacao`, chave organização+conta+op) | **2.000** | ordem de inserção: ao passar de 2.000 sai a mais antiga; uma atualização reinsere no fim | **NÃO** |
| **Contas para taxa** (`taxaPorEscopo`) | **1.000 (limite brando)** | só **poda** quando passa de 1.000, e só entradas com mais de 60 s | **NÃO** |
| Navegador: log / fila / envios | 100 / 20 / 40 | descarta os mais antigos; para nos 40 envios | **sim** |

Os dois **não validados**:

1. **2.000 operações.** O código limita o tamanho do mapa, mas nenhum teste passa de 2.000 operações distintas.
   - Efeito colateral do desenho: se uma operação sai do mapa e volta, o contador dela recomeça e ela pode passar de 60 eventos. Isso exige mais de 2.000 outras operações no meio.
2. **1.000 contas.** **Não é um teto rígido.** Se mais de 1.000 escopos distintos (organização+conta) enviarem eventos no mesmo minuto, o mapa passa de 1.000 até as entradas envelhecerem.
   - O envio exige sessão da conta Microsoft **ativa**, e o MVP tem uma conta ativa por processo, então na prática o número de escopos tende a ser pequeno. Isso é inferência sobre o modelo de autenticação atual, não uma garantia do limite.

Outras estruturas sem teto explícito, também não testadas:

- os mapas `status` por rótulo dentro de cada rastro, limitados pela variedade de códigos (HTTP 100–599 ou código simbólico ≤ 40 caracteres);
- no navegador, `_diagOpT0` e `_diagN` (uma entrada por operação ou URL durante a vida da página);
- `_diagVoo` (fetches que nunca terminam permanecem).

Com o diagnóstico desligado, nada disso cresce: a rota de envio sai antes e o navegador desligado não cria IDs.

### 12.4 Os 33 scripts do CI × os 40 casos de teste do diagnóstico

São contagens de coisas diferentes:

- **CI run 58 = 33 scripts.**
  - O `selftest:all` executa 33 scripts npm (os `*:selftest`, mais `test`, `browser:smoke`, `carriers:detect` e `demurrage:calc`) e julga cada um **pelo código de saída**.
  - O `diag:selftest` é **um** desses 33 ("✅ diag:selftest (34.3s)"); outro é o `test` (78 casos de preAlerta/ceMercante).
  - O log do CI **só mostra os casos de um script quando ele falha**, por isso o run 58 não traz a contagem por caso.
- **Diagnóstico = 41 casos (`node:test`) dentro do `diag:selftest`.**
  - **Local**, com `RELATORIOS_HTML_ORIGINAL`: 40 ok e 1 pulado (carga, que só roda com `DIAG_CARGA=1`).
  - **No CI**, as variáveis `RELATORIOS_HTML_ORIGINAL` e `DIAG_CARGA` não existem, então **2 casos são pulados por construção** (equivalência com a página original e carga). O log do run 57, que falhou e por isso listou os casos, mostra os dois como `# SKIP`.
  - No run 58 o esperado é 39 ok e 2 pulados, mas **essa contagem por caso não aparece no log**; a evidência do run 58 é só o código de saída do script.
- A **equivalência com a página original** só foi exercitada **localmente**, nas execuções relatadas na seção 5, e não no CI.

### 12.5 Achado de código: timers do `withTimeout` nunca cancelados

- **[código]** Existem quatro cópias de `withTimeout`:
  - `src/routes/courierRoutes.ts:276`;
  - `src/routes/demurrageRoutes.ts:116`;
  - `src/routes/auditoriaRoutes.ts:54`;
  - `src/demurrage/emailRefs.ts:14`.
- Todas criam um `setTimeout` por chamada e **nunca chamam `clearTimeout`**. Depois que a chamada termina, o timer fica agendado até disparar (8 s, 20 s ou 22 s) e então rejeita uma corrida já decidida, sem efeito no resultado.
- O Stage 0 **mantém exatamente esse comportamento** nas duas rotas instrumentadas (só acrescenta `obs.estourou()` dentro do callback) e **não toca** as outras duas cópias.
- **[sintético]** No benchmark, o pico de timers JS ativos chegou a milhares, mesmo com o diagnóstico **desligado** (variante A):
  - 4.946 em `/api/couriers` com 1 requisição por vez;
  - 22.974 com 100 simultâneas;
  - 62.237 em `/api/demurrage` com 50 simultâneas.

  O pico acumula entre rodadas e depende do ritmo do teste.
- **Impacto em produção: não medido.** Não há afirmação sobre memória ou CPU em produção.
- **Não alterado** nesta etapa; fica como achado para uma decisão separada.

## 13. O que NÃO foi feito

- Deploy, ativação, acesso a dados ou logs de produção.
- Push na Linha A ou no branch padrão.
- Mudanças funcionais do Blueprint, otimizações, compartilhamento de requisições, cache, ingestão incremental, mudanças de retry ou cancelamento, ou alterações de Delivered.
