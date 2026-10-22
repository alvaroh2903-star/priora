# Diagnóstico — Módulo Courrier (Priora): relatório completo e matriz de requisitos

> **Nota de publicação (22/10/2026). Leia antes do restante.**
>
> Este é o relatório completo da revisão 3 (21/10/2026), publicado no branch de revisão `claude/stage0-diag-relatorios-revisao` como documentação para a revisão de código do Stage 0 v2. O texto depois da linha horizontal está **sem alteração**, com uma exceção: o número de rastreio real citado em A2 foi omitido.
>
> **Revisões de código avaliadas neste relatório:**
>
> - **Linha B:** `claude/busy-cori-8o1czj` @ `0827452` (20/10/2026). É a referência principal: `arquivo:linha` sem indicação é desta revisão, e `:NNN` sem arquivo é `src/routes/courierRoutes.ts`.
> - **Linha A:** `claude/demurrage-api-playwright-5q2lqq` @ `ec52362` (18/10/2026), nas referências marcadas com "A".
> - **Stage 0 v1:** `46ab6de` (com o documento `c0c4b9a`), no branch padrão `claude/outlook-email-api-0jv8g4`.
>
> **Situação em 22/10/2026** (verificada por `git`, sem acesso à produção):
>
> - A Linha A avançou para `8e055b0` (`a4096c8` e `8e055b0`, em 21/10).
> - A Linha B avançou para `0ae78a9` (6 commits em 22/10).
> - O Stage 0 v1 foi substituído pelo **Stage 0 v2** (`8e055b0` → `eb857dc` → `9e1fcaa`, no branch de revisão), ainda em revisão de código. Nada foi publicado nem ativado.
>
> **Achados desatualizados ou a ler com ressalva:**
>
> | Onde | O que o texto diz | Situação em 22/10/2026 |
> |---|---|---|
> | R3.1, R3.5, Apêndice R3 | O Stage 0 é o `46ab6de`; recomenda publicar o `46ab6de` | **Substituído.** O `46ab6de` gera conflitos sobre `8e055b0`, e medir com `ec52362` + `46ab6de` reverteria `a4096c8` e `8e055b0`. O candidato à medição é o `9e1fcaa`, ainda em revisão. Publicação e duração da janela dependem de decisão separada. |
> | R3.3, `/api/couriers` | Anexos "8 s, em paralelo"; um timeout de 40 s implicaria tempo fora das fases limitadas | **Desatualizado.** Desde o `8e055b0` os anexos são lidos 5 mensagens por vez (`mapLimit`). O pior caso da fase é 5 × 8 s = 40 s [código], e a inferência deixa de valer. |
> | R3.3 (Anexos), H3b, última linha da tabela de R3.5 | A listagem sem `$select` baixaria o conteúdo (`contentBytes`) dos PDFs | **Desatualizado para a Linha A.** Desde o `8e055b0`, a listagem usa `$select` (sem `contentBytes`) e há um `GET` com `$expand` por `itemAttachment`. O tamanho registrado é o **declarado** (`size`). |
> | A3 (tabela), 5.3 | "Até 25 leituras em paralelo, uma requisição Graph por mensagem" (Linha A) | Hoje são 1 listagem mais 1 `GET` por e-mail encaminhado, 5 mensagens por vez. O teto de 25 mensagens não mudou. |
> | A1, A2, tabela de linhas da Parte B | O tip da Linha A é `ec52362` | O tip atual é `8e055b0`. As referências de linha marcadas com "A" podem estar deslocadas. |
> | R3.3, tabela de sinais de R3.5 | Nomes de campos do v1: `loop.p99Ms`, `silenciadas`, `limite` (anexos), `listagemAnexos.bytesArquivo` | No v2: `loop.atrasoMaxMs` (com `elu`), `engolidas`, `limiteServidor`, `bytesDeclaradosArquivo`. Continuam iguais: `ms.auth`, `uptimeS`, `primeiraDoProcesso`, `cobertura.fonte` e `buscaTemMais`. |
> | Apêndice R3 | Saída sintética do v1 (`npm run test:diag` sobre `ec52362` + `46ab6de`), com pendências somadas entre níveis ("trabalho pendente ao responder: 8") | **Substituído** pelo relatório sintético do v2 (`Pacote_Revisao_Stage0_v2.md`, §6). Lá, tarefas, chamadas Graph e chamadas de IA aparecem separadas, sem soma. |
> | Seção 2 (matriz), seções 1 e 3 | Referências da Linha B em `0827452` | Na Linha B `0ae78a9`, `courierRoutes.ts` ganhou 5 linhas, e as referências podem estar deslocadas de 1 a 5 linhas. O `POST /reply-draft` passou a poder ser desligado por `PRIORA_ESCRITA_LEGADA_OUTLOOK`; o padrão não mudou. As classes **não foram reavaliadas** contra `0ae78a9` (ver `Matriz_Requisitos_Courrier.md`). |
> | A3, "Montagem da aba" | "O shell monta a aba na primeira visita e a mantém montada" | **Incompleto (corrigido em 22/10, conferido no código e no navegador local).** Ao abrir o painel (`Priora.dc.html`), o shell pré-monta **todas** as abas: começa ~0,45 s depois e monta uma a cada 160 ms (`warm`, desde `5e4b338`). Abrir o painel dispara, juntas, as cargas da Relatórios, Exigem Atenção, Courier (com a pré-busca de rastreio), Demurrage, Auditoria e Processos. Os dois logins redirecionam para o painel. |
> | 6.1, T2 | `SESSION_SECRET` explícito | Na Linha B `0ae78a9`, o servidor valida o `SESSION_SECRET` no boot em produção. Não foi reavaliado. |
>
> **Dados:** o documento não traz credenciais, conteúdo de caixa postal nem linhas brutas de log de produção. As observações de produção de A2 e A5 foram **relatadas pelo usuário** (prints e um resumo de log) e aparecem resumidas. Não há medição real: todos os números de saída são **sintéticos**.

---

20/10/2026 · revisão 2: 21/10/2026 · **revisão 3: 21/10/2026, após o Stage 0**

Arquivo em Markdown com o conteúdo integral do doc do diagnóstico (Partes A e B, matriz completa por identificador), mais este preâmbulo da revisão 3. A terminologia e os identificadores do Blueprint (Revisão 3.0) foram mantidos.

## Revisão 3 — o que mudou depois do Stage 0

### R3.1 Situação

- O **Stage 0** (só instrumentação de diagnóstico do carregamento da Relatórios) foi implementado no commit `46ab6de`, no branch `claude/outlook-email-api-0jv8g4`. **Não houve deploy.** O branch de produção (`claude/demurrage-api-playwright-5q2lqq`) não foi tocado.
- O cherry-pick de `46ab6de` sobre `ec52362` (tip da Linha A) foi verificado localmente: aplica **sem conflito**, compila e passa nos testes. O worktree de verificação foi descartado sem push.
- A instrumentação fica **desligada** até `PRIORA_DIAG_RELATORIOS=on`. O procedimento está em `docs/diagnostico-relatorios-stage0.md`.
- **Nenhuma etapa funcional do Blueprint foi iniciada.** Também não houve mudança em compartilhamento de requisições, cache, ingestão incremental, retries ou cancelamento.

### R3.2 Medições

- **Reais: nenhuma.** Não houve acesso a produção, caixa real nem IA real. As hipóteses H1–H8 (A5) **continuam sem confirmação ou refutação**.
- **Sintéticas:** cenário ponta a ponta com Graph, MSAL e Gemini falsos, tempo escalado (÷20) e rede bloqueada; ver o apêndice. Elas **demonstram mecanismos** em ambiente controlado; **não medem magnitudes nem frequências** de produção:
  - o timeout do navegador não encerra a conexão, e o servidor segue até o fim;
  - as tentativas se sobrepõem ao processamento anterior;
  - chamadas Graph e IA terminam depois do limite do servidor e depois da resposta;
  - uma operação do usuário multiplica buscas, leituras de anexo e invocações de IA quando o servidor demora mais que o limite do navegador.

### R3.3 Inferências por código, a confirmar com medição real

- **`/api/couriers`.** O processamento no servidor tem limites internos:
  - busca: 20 s;
  - fallback: +20 s, só quando a busca vem vazia;
  - anexos: 8 s, em paralelo;
  - mais auth e CPU.

  Com o limite de 40 s do navegador (Linha A), um timeout ali implica tempo **fora** dessas fases limitadas (auth, fila/boot do host, event loop bloqueado, caminho de fallback) ou resposta não-2xx. Os campos `ms.auth`, `uptimeS`, `loop` e `cobertura.fonte` e a junção navegador × servidor permitem separar esses casos.
- **`/api/demurrage`.** Com IA ligada, o servidor pode levar busca (até 20 s) + anexos (até 8 s) + IA (até 22 s), contra 15 s de limite no navegador. Por isso, timeouts do navegador nessa rota são **estruturalmente prováveis** sempre que a IA demora.
  - Cada operação pode gerar até 4 execuções completas (1 + 3 tentativas), cada uma com até 14 análises, mais as novas tentativas do Gemini.
  - **Isto é inferência; a frequência real não foi medida.**
- **Anexos.** `getItemAttachmentTexts` lista os anexos **sem `$select`**. Segundo a documentação do Graph, a listagem traz os `fileAttachment` com `contentBytes`; a própria Linha A já usa `$select` em outra função para evitar isso. O caminho da Relatórios só usa `itemAttachment`, então os bytes dos PDFs seriam baixados e descartados.
  - O Stage 0 registra o `size` declarado de cada anexo listado (`listagemAnexos.bytesArquivo`), sem conteúdo.
  - O impacto em tempo **não foi medido** (hipótese H3b).
- **Falhas silenciadas.** `getItemAttachmentTexts` engole erros e devolve `[]`; antes do Stage 0, uma falha (inclusive 429) era indistinguível de "sem anexo encaminhado". Agora conta como `silenciadas`, com o código.

### R3.4 Correções e precisões exigidas na revisão

1. **Escalonamento de Delivered (TRN-003, AC-07).** O vermelho é **obrigatório** pelo Blueprint. Qualquer etapa sem ele (inclusive a E1 proposta na seção 7) é **entrega parcial, não conclusão conforme**. A conformidade de TRN-003 e AC-07 só se completa com E10, que depende de LAC-01 a LAC-05.
2. **Parâmetros de calendário e horário.** Nenhum valor é proposto para LAC-01 a LAC-05. A seção 4.3 mantém `INDETERMINADO` sem padrão oculto; as fixtures de E1 ficam marcadas como **não homologadas**.
3. **Compartilhamento de requisições em voo (A6, opção 1).** A chave precisa incluir:
   - organização;
   - conta conectada;
   - contexto de autorização;
   - parâmetros da requisição.

   O compartilhamento nunca pode cruzar contas, organizações ou sessões com autorização diferente. `/stats` só aproveita a construção quando os parâmetros forem idênticos. Isso substitui o "single-flight por caixa + endpoint" escrito em A6.
4. **Cancelamento (A4, A6 opção 6).** Cancelar no navegador **não** prova que o servidor ou o provedor pararam. A instrumentação registra separadamente:
   - o desfecho no navegador;
   - a desconexão real da conexão (`desconexao`);
   - o trabalho que seguiu depois da resposta (`relatorios.tardio`).

   Uma proposta futura de cancelamento terá de demonstrar a parada no servidor e no provedor com esses registros.
5. **Custo de IA.** A Linha A já registra `[Gemini][custo] … ~US$ ~R$` com preços de lista fixos no código, não verificados. Esse número **não deve ser usado** como base de custo. O Stage 0 registra só invocações, latência e tokens informados pelo provedor (`usageMetadata`), sem estimativa monetária. A linha de custo existente não foi removida, para não mudar comportamento fora do escopo.
6. **E0 × Stage 0.** O Stage 0 cobre só a parte de **medição** de E0. A decisão de base (T1), os testes de caracterização da Linha B e o banco de teste isolado (T9) continuam pendentes.

### R3.5 Próximo passo recomendado, com base na evidência disponível

A evidência atual é só sintética e por código. Por isso, **o próximo passo recomendado é a medição real autorizada**, não uma otimização. Ela exige três autorizações:

- publicar `46ab6de` na linha de produção;
- ligar a variável numa janela combinada;
- ler os logs.

Com os dados, a decisão segue a tabela abaixo. Cada linha só vale se o sinal aparecer na medição real.

| Sinal observado | Leitura | Candidato (revisão separada) |
| --- | --- | --- |
| Muitos `timeout` em `/api/demurrage` com servidor > 15 s e respostas `tardia` | Trabalho repetido por tentativa (H5/H8) | Opção 1 escopada (R3.4.3) e opção 5 (reuso de IA), com teste de cobertura |
| `ms.auth` alto | H4 (MSAL) | Investigar renovação de token; sem mudança funcional |
| `uptimeS` baixo / `primeiraDoProcesso` nos casos lentos, ou timeouts sem registro do servidor | H1 / tempo antes do Express | Consideração de infraestrutura, separada |
| `loop.p99Ms` alto | H6 (contenção no processo) | Isolar Playwright/OCR/IA do processo web |
| `silenciadas`/429, `limite` de anexos, `buscaTemMais` frequentes | H3 e cobertura efetiva menor que a nominal | Opção 4 (ingestão incremental), só com demonstração contra o Blueprint |
| `bytesArquivo` alto com anexos lentos | H3b | `$select` na listagem, se a cobertura demonstrada for igual |

Na trilha funcional do Blueprint, a recomendação da seção 8 continua: E1 é a primeira etapa funcional, depois de T1 e T2. **E1 é parcial**, e a conformidade de Delivered exige E10.

---

**Revisão 2 (21/10).** Este doc tem duas partes:

- **Parte A** responde aos itens 1 a 6: o commit `0b4f186` e o caminho de carregamento da Relatórios.
- **Parte B** é o diagnóstico do Blueprint (item 7). A matriz de rastreabilidade foi expandida para uma linha por identificador, e a primeira etapa foi revista à luz da Parte A.

Na revisão 2, nenhuma alteração havia sido feita no código; os fixes já publicados foram mantidos. (Revisão 3: só o Stage 0 de medição foi implementado; ver o preâmbulo.)

## Parte A — Commit 0b4f186 e carregamento da Relatórios

### A1. O que o commit 0b4f186 contém

**Identificação.**

| Campo | Valor |
| --- | --- |
| Branch | `claude/demurrage-api-playwright-5q2lqq` (Linha A) |
| Commit pai | `392eca0` |
| Data | 07/09/2026 |
| Situação no branch | Ancestral do tip atual `ec52362`; nenhum commit posterior alterou a Relatórios |
| Arquivos | Um: `public/Relatorios.dc.html` (+24/−9) |

**Mudanças na Relatórios (todas as do commit):**

1. Botão "Tentar novamente" no card de erro, chamando `onRetry`.
2. `load()` passa a chamar `loadCouriers(0)` em vez de um fetch único.
3. Nova função `loadCouriers(attempt)`:
   - até 3 tentativas para `/api/couriers`;
   - limite por tentativa de **25 s → 40 s**;
   - espera de 4 s e 8 s entre tentativas;
   - nova mensagem final de erro.
4. `renderVals` expõe `onRetry`, que reinicia `loadCouriers(0)`: cada clique abre uma nova série de até 3 tentativas.

**Não alterado pelo commit:**

- `fetchJson` continua sem cancelamento e tratando qualquer resposta não-2xx como falha.
- `loadDemurrage` continua igual: `/api/demurrage`, 15 s, até 4 tentativas.
- O cálculo das KPIs.

**Mudanças no Courrier: nenhuma neste commit.**

- Nenhuma mudança de backend.
- Nenhuma mudança de cobertura: busca top 60, leitura de até 25 anexos e tipos de anexo continuam iguais. Verifiquei os diffs dos três commits que publiquei nesta linha (`b22871f`, `286d42e`, `0b4f186`): nenhum toca esses limites.

**Problema no próprio commit.** A mensagem do commit, o comentário no código e o texto mostrado ao usuário ("Se a instância estava dormindo (plano gratuito do Render)…") apresentam *cold start* como causa. É uma hipótese não medida (A5). O texto deve ser revisto, mas não alterei nada agora.

**Contexto: mudanças do Courrier em commits separados.** Ambas alteram o comportamento do Courrier sem demonstração contra o Blueprint (ver Parte B, 6.3).

- `b22871f`:
  - teto de 8 processos por referência (`referenceResolver.ts`);
  - `docResolution` lido só do e-mail do próprio courier;
  - deduplicação por base (IM2404 = IM2404-26) na união com a Clara, no front.
- `286d42e`:
  - `extractEnvelopeDocs` e `webLink` (lista de documentos do envelope);
  - rótulo "Não informado" para OHBL.

**Divergência entre as linhas.**

- Na Linha B, a deduplicação por base foi substituída por referência exata (N-3, `Courier Module:850-852`). Lá, IM2404 e IM2404-26 continuam sendo linhas distintas.
- A Relatórios da Linha B está com 25 s (`9e9d2dd`), não com 40 s.

### A2. Validações realizadas e o que segue sem verificação

**Validações que eu realizei:**

| Item | Validação feita | Não feita |
| --- | --- | --- |
| `0b4f186` | Cherry-pick sem conflito; equilíbrio das tags do template (sc-if 9/9, sc-for 4/4); presença de `loadCouriers`/`40000`; branch sem commits novos antes do push; push confirmado (`392eca0..0b4f186`). | Verificação de sintaxe do script; renderização no navegador; teste de comportamento contra API real ou simulada. O arquivo é de front e não passa pelo `tsc`. |
| `b22871f`, `286d42e` | `tsc` da Linha A com as dependências instaladas: OK. Teste avulso do resolvedor com índice sintético (referência com 30 processos ignorada). Teste avulso da extração com 5 linhas transcritas de um print. `node --check` do script do Courier Module (na minha branch). | Testes automatizados; validação contra e-mails reais. |
| Hoje | `linhas.test.ts` (Linha B): 7/7 aprovados, em ambiente isolado. | `courierFatos.test.ts`: exige PostgreSQL e faz `truncateAll`; não executado. |

**Observações de produção.** Todas foram fornecidas por vocês; eu não acessei a produção.

1. `/health` em 01/09: commit `286d42e`, branch `demurrage-api-playwright`. Confirma que os fixes de courier daquela data foram publicados.
2. Print posterior de um card DHL (número de rastreio omitido nesta publicação):
   - mostrava 3 processos, coerente com a deduplicação;
   - **mas o HBL ainda aparecia como "Via Telex Release"**;
   - a Clara recusada com 429 RESOURCE\_EXHAUSTED após 4 tentativas.

   **A correção de Telex não teve efeito confirmado em produção**, e a causa não foi investigada. Hipóteses: o texto do próprio envelope contém "telex"; a regex aceita negação; o front estava em cache.
3. Log do Render (\~19:21, deploy `87165b8`): dezenas de "\[Gemini\] sobrecarregado (tentativa 2/4, 3/4)" em poucos segundos.
4. Print da Relatórios com "tempo esgotado" (limite de 25 s, antes do `0b4f186`).

**Não verificado:**

- se o `0b4f186` está em produção: não há `/health` com esse commit, e o branch já avançou para `ec52362`;
- se a Relatórios passou a carregar;
- se os candidatos fantasmas do FedEx sumiram e se a lista de documentos aparece em produção;
- a causa do "tempo esgotado";
- a causa do 401 ("pede autenticação de novo");
- execuções e efeito do workflow `keep-alive.yml` (`663a13a`, no branch padrão). Ele faz uma requisição à URL de produção a cada 10 minutos.

**Correção das minhas afirmações anteriores.** Apresentei como causas, sem medição:

- "cold start é a causa quase certa";
- "foi timeout real, porque não apareceu a tela de login";
- "o disco efêmero apagado a cada deploy ou sono causa o logout";
- "o plano Starter resolve timeout e logout".

Retiro todas como conclusões. Elas permanecem apenas como hipóteses (A5).

### A3. Caminho atual de carregamento da Relatórios (Linha A, com 0b4f186)

**Montagem da aba.** O shell monta a aba na primeira visita e a mantém montada (`Priora.dc.html:42`, mapa `mounted`). `componentDidMount` chama `load()` uma vez (`Relatorios.dc.html:187`). Trocar de aba e voltar não recarrega; recarregar a página, sim.

**Duas cadeias disparadas ao mesmo tempo pelo `load()`:**

1. `/api/couriers` via `fetchJson(url, 40000)` (`:191-197`, `:213-224`):
   - até 3 tentativas;
   - há nova tentativa quando nada chega em 40 s **ou** quando chega qualquer status não-2xx (401, 403, 500…) ou JSON inválido, porque `fetchJson` converte tudo em `null` (`:194`).
2. `/api/demurrage` via `fetchJson(url, 15000)` (`:226-235`): até 4 tentativas, 20 s depois de cada falha.

**Trabalho no servidor a cada tentativa:**

| Recurso | `/api/couriers` (`courierRoutes.ts` A `:669-676` → `buildCourierView :287-662`) | `/api/demurrage` (`demurrageRoutes.ts` A `:269` em diante) |
| --- | --- | --- |
| Autenticação | Sessão + MSAL `acquireTokenSilent` (`requireAuth.ts` A `:18-61`). Se vai à rede da Microsoft depende da validade do token (não medido). | Idem |
| Leitura da caixa | Graph `$search` top 60 (`:288-292`); se vazio, top 40 da caixa de entrada (`:298-299`). | Graph `$search` top 60 com mais palavras-chave (`:274-278`). |
| Anexos | Até 25 leituras em paralelo (`:311-321`), uma requisição Graph por mensagem com `$expand` do e-mail anexado, limite de 8 s cada. **Falha vira lista vazia, sem aviso.** | Até 25 leituras (`:291-300`), mesmo comportamento. |
| Rastreio FedEx/DHL | Nenhum | Nenhum |
| IA | Nenhuma | **Até 14 chamadas Gemini em paralelo** (`AI_CAP = 14`, `:373-388`), limite de 22 s cada, com até 1 nova tentativa em erro transitório (`geminiClient.ts` A `:78`). |
| Reaproveitamento | Nenhum: cada tentativa refaz tudo. | Nenhum: cada tentativa refaz busca, anexos e IA. |

Dois pontos de código merecem destaque:

- O limite do cliente para `/api/demurrage` (15 s) é **menor** que o limite de cada chamada de IA no servidor (22 s).
- A Relatórios não chama `/api/tracking`. A IA do Courrier (Clara) só roda ao expandir um card na aba Couriers.

### A4. Cancelamento e sobreposição

**No cliente:**

- `fetchJson` usa `Promise.race` com `setTimeout` e **não tem `AbortController`** (`Relatorios.dc.html:191-197`).
- A requisição HTTP **não é cancelada**. O navegador mantém a conexão e recebe a resposta, que é descartada.
- O `window.fetch` global do shell continua observando essa resposta: um 401 que chegue tarde ainda abre a tela de login.

**No servidor:**

- Nenhum handler observa a desconexão do cliente.
- O cliente Graph não recebe sinal de cancelamento.
- O `withTimeout` do servidor só desiste de *esperar*: as chamadas Graph e Gemini **continuam** até terminar.

**Consequência (por código, não medida): as tentativas podem se sobrepor a processamento que continua no servidor.**

- **`/api/couriers`:** se o servidor levar mais de \~44 s (40 s de espera + 4 s), a 2ª tentativa começa com a 1ª ainda rodando. No pior caso, até 3 construções simultâneas da mesma visão. O botão "Tentar novamente" abre outra série sem esperar as anteriores.
- **`/api/demurrage`:** com limite de 15 s e espera de 20 s, execuções que passem de \~35 s se acumulam (até 4), cada uma com até 14 chamadas de IA.
- **Outras abas:** abas já montadas (Courier, Exigem Atenção) podem estar construindo a mesma visão ao mesmo tempo. O servidor não deduplica requisições em voo para esses endpoints; só o rastreio tem `inFlight`.

Quantas sobreposições ocorrem de fato: **não medido**.

### A5. Evidência do gargalo: medição × hipótese

**Medições disponíveis: nenhuma.** Não existe medição de tempo de `/api/couriers`, `/api/demurrage` ou das suas fases, nem identificador de requisição, contagem de chamadas Graph ou métricas de CPU e memória coletadas. **O gargalo não está identificado.**

**Observações (não são medições do gargalo):**

| # | Observação | O que ela permite concluir |
| --- | --- | --- |
| O1 | "Tempo esgotado" com limite de 25 s | Só que, em 25 s, não chegou resposta 2xx utilizável. Pode ser lentidão **ou** erro não-2xx: o código não distingue. |
| O2 | Dezenas de 503 do Gemini em segundos no log | Havia muitas chamadas de IA concorrentes. A origem não aparece no log. É compatível com `/api/demurrage`, mas também com Auditoria/OCR. |
| O3 | 429 RESOURCE\_EXHAUSTED na Clara | A cota do Gemini estava esgotada naquele momento. |
| O4 | Aviso do Render de atraso de "50 s ou mais" | Declaração da plataforma sobre o plano gratuito, não medição deste evento. |

**Hipóteses não confirmadas:**

- **H1:** cold start.
- **H2:** latência do `$search`.
- **H3:** as 25 leituras de anexo em paralelo e limitação (429) do Graph; as falhas são silenciadas e reduzem a cobertura sem aviso.
- **H4:** renovação do token MSAL.
- **H5:** concorrência entre `/api/couriers` e `/api/demurrage` disparados juntos, outras abas e as próprias tentativas sobrepostas.
- **H6:** contenção no processo Node. A Linha A roda Playwright/Chromium, OCR e IA no mesmo processo.
- **H7:** respostas 401 ou 500 exibidas como "tempo esgotado".
- **H8 (estrutural, vista no código):** a IA de demurrage roda dentro do carregamento da Relatórios.

**Medições necessárias para identificar o gargalo.** Na revisão 2 era uma proposta. Na revisão 3, foi implementada como Stage 0, ainda sem medição real (ver R3.1 e R3.2):

- tempo por fase, com identificador de requisição: autenticação, busca, anexos (com contagem de falhas e de 429), filtro e índice, IA (quantidade e duração);
- registro de desconexão do cliente e do trabalho que continua depois dela;
- no cliente, distinção entre timeout, status HTTP e JSON inválido;
- correlação com as métricas de CPU e memória do Render;
- execução em homologação com caixa controlada, a frio e a quente, sem tocar a produção sem autorização.

### A6. Opções para reduzir trabalho repetido mantendo cobertura

**Premissa.** Não reduzir o top 60, os 25 anexos nem os tipos de anexo, e não alterar regras do Courrier, sem demonstrar antes o impacto funcional com fixtures contra o Blueprint.

**O código atual já limita a cobertura:**

- busca top 60;
- anexos lidos só em 25 mensagens;
- só e-mail encaminhado como anexo (`itemAttachment`);
- falhas silenciadas.

Esses limites existentes deveriam ser medidos (quantos anexos e mensagens ficam de fora) antes de qualquer decisão.

| # | Opção | Muda o resultado? | Invalidação | Trade-off e Blueprint |
| --- | --- | --- | --- | --- |
| 1 | **Coalescer requisições idênticas em voo** no servidor (single-flight por caixa + endpoint), como o rastreio já faz. Tentativas, abas e `/stats` passam a aguardar a mesma construção. | Não: resultado e frescor idênticos. | Não se aplica: vale só durante a construção. | Elimina a sobreposição de A4. Determinístico. Sem efeito em ENT, ASS ou HIS. |
| 2 | **Reaproveitar a leitura por mensagem:** texto de anexo e resultado do filtro guardados por `message.id` + versão da mensagem + versão do extrator. | Não; a cobertura fica igual ou maior. | Mensagem alterada; extrator ou regra alterados. | Exige persistência e retenção (DEP-05, LAC-08). Preserva a evidência (ENT-006). |
| 3 | **Resultado materializado compartilhado** entre Courier, Exigem Atenção, Relatórios e `/stats`. | Não, desde que o frescor seja explícito. | Novo e-mail (delta) e fato gravado. | Depende de 4. Exibir o horário da última atualização. |
| 4 | **Ingestão incremental** pelo delta do Graph (já existe na Linha B). | Sim, para melhor: acaba o corte de 60 (ENT-003, ENT-005, HIS-001). | Delta, mensagem removida, cursor expirado. | Persistência; janela de ressincronização a definir. |
| 5 | **IA de demurrage com reuso:** cache por thread (ids das mensagens + versão de prompt e modelo); IA só para threads novas ou alteradas, e só quando o determinístico não resolver; sem retry em 429 de cota. | Não, se houver regra explícita de encaminhamento à IA e teste de cobertura. | Mensagem nova na thread; versão de prompt ou modelo. | Está fora do Courrier, mas no caminho da Relatórios. É a maior fonte de IA repetida identificada no código. |
| 6 | **Cancelamento real e mensagens corretas:** `AbortController` no cliente; nenhuma nova tentativa em 401/403; diferenciar timeout de erro; o servidor deixa de iniciar leituras para requisição abandonada **só** quando não houver outro interessado (combinar com a opção 1). | O conteúdo não muda; a mensagem passa a dizer a causa real. | — | Sem a opção 1, cancelar no servidor pode desperdiçar trabalho que outra aba usaria. |
| 7 | **Desacoplar o custo de demurrage da Relatórios:** carregar o card de demurrage só quando for necessário, ou a partir de resultado já calculado. | Muda quando o card aparece. | — | Decisão de Gestão (KPI-007), não do Courrier. |

**Não recomendo sem demonstração:** reduzir o `top`, reduzir os 25 anexos, deixar de ler anexos ou cortar threads. Isso reduz a descoberta (ENT-003, ENT-005, ASS-002, CT-040).

**Infraestrutura (consideração separada).** Um upgrade do Render pode afetar H1 e H6, mas não o recomendo como correção sem medição. **Não prometo carregamento rápido no primeiro acesso.**

## Parte B — Diagnóstico do Blueprint (item 7)

As seções abaixo são o diagnóstico completo pedido anteriormente:

- **Seção 2:** matriz de rastreabilidade com uma linha por identificador.
- **Seções 7 e 8:** etapas propostas e primeira etapa, revistas à luz da Parte A.

## Escopo, fontes e método

**Natureza deste documento.** Diagnóstico somente. Nenhum arquivo do repositório, regra, banco, dependência ou configuração foi alterado. Não houve acesso à produção, envio de e-mail, criação de rascunho nem execução de migration. As regras, identificadores e termos do Blueprint foram mantidos em português, como no original.

**Especificação.** *Priora — Blueprint funcional do módulo Courrier*, Revisão 3.0 (20/10/2026), lido integralmente: GOV, REL, ENT, ASS, TRN, TMP, CNF, RES, ETA, CLA, SOL, KPI, HIS, AC-01 a AC-24, CT-001 a CT-042, cadastro CA-R/CT-R, DEP-01 a DEP-06, VAL-01 a VAL-05 e LAC-01 a LAC-16.

**Código inspecionado: existem duas linhas ativas e divergentes do Courrier.** Isso é o achado mais importante para planejar a implementação (ver seções 1, 3 e 6).

| Rótulo | Branch | Commit | Situação |
| --- | --- | --- | --- |
| **Linha A** | `claude/demurrage-api-playwright-5q2lqq` | `ec52362` (18/10/2026) | Última linha confirmada em produção (via `/health` em 01/09/2026, commit `286d42e`). Não reverifiquei a produção, conforme a instrução. Tem Supabase, login Priora, landing page, scrapers de armador e o rastreio DHL pelo site. |
| **Linha B** | `claude/busy-cori-8o1czj` | `0827452` (20/10/2026) | Linha mais recente. Parte do branch padrão do repositório (`claude/outlook-email-api-0jv8g4`). Acrescenta fatos duráveis do Courrier em PostgreSQL, identidade de processo (S6), pessoa × caixa (S4), a Liberação que consome o Courrier e o motor de Demurrage. |

As duas compartilham o núcleo do Courrier: `src/routes/courierRoutes.ts`, `src/couriers/*`, `public/Courier Module.dc.html` e as correções de 01/09. Elas divergem em persistência, autenticação, rastreio e nos módulos vizinhos. Salvo indicação, as referências `arquivo:linha` abaixo são da **Linha B**. Diferenças da Linha A são indicadas explicitamente.

**Tipos de evidência.**

- **Código:** conclusão obtida por leitura do código.
- **Teste:** comportamento observado em teste executado neste diagnóstico.

Uma tela, um comentário, um placeholder ou um caminho de código não usado **não** foi considerado prova de implementação.

**Testes executados (isolados).** As dependências foram instaladas apenas numa cópia descartável do código, com `--ignore-scripts`. A execução usou ambiente vazio: sem chaves, banco ou rede de aplicação.

- `src/couriers/fatos/__tests__/linhas.test.ts` (Linha B): **7 aprovados**. Cobrem: captura exata de referências IM, ausência de truncamento, índice de referências e proveniência da linha assinada pelo servidor.
- `src/couriers/fatos/__tests__/courierFatos.test.ts` (Linha B): **pulado**. Exige PostgreSQL (`DEMURRAGE_TEST_DATABASE_URL`/`DATABASE_URL`) e executa `truncateAll`. **Não é seguro** apontá-lo para qualquer banco compartilhado, por isso não foi executado contra nenhum banco.
- **Linha A:** não há testes do Courrier. O script `test` cobre só Auditoria/PRE-ALERTA.
- Não existem testes automatizados para o front do Courrier, para `buildCourierView`, para o rastreio nem para a análise da Clara.

## 1. Arquitetura atual

### 1.1 Componentes e arquivos do Courrier

| Camada | Arquivo | Papel real |
| --- | --- | --- |
| Tela | `public/Courier Module.dc.html` (1.197 linhas) | Cards, timeline, conferência, follow-up, prefetch do rastreio e análise da Clara. **Também contém regras de negócio:** ações por estado (`:815-826`), expectativa por documento (célula MBL/HBL) e trava de conferência (`:293-295`, `:1056`). |
| API | `src/routes/courierRoutes.ts` (1.411 linhas) | `buildCourierView` (`:360-776`); `/stats` (`:1108-1115`); `/:cid/analysis` (`:1130-1223`); `/:tracking/estado` (`:1231-1263`); `reply-info`/`reply-draft` (`:1270-1322`); `followup` (`:1330-1344`); `conferencia` (`:1357-1406`). |
| Filtro | `src/couriers/courierFilters.ts` + `.json` | Pontuação determinística do e-mail; candidatos de tracking; exclusão de número de conta (`:137-140`). |
| Associação | `src/couriers/referenceResolver.ts` | Índice referência→IM, cardinalidade (HBL/MBL 1:1 automático, Booking nunca) e teto `MAX_SHARED_PROCESSES = 8` (`:277`). |
| Identidade | `src/identidade/captura.ts` e outros | Referência IM exata (IM2151 ≠ IM2151-26). **Testado** em `linhas.test.ts`. |
| Persistência legada | `src/couriers/courierStore.ts` | JSON em `DATA_DIR`: `courier-estados.json` (`:38`), `courier-conferencia.json` (`:113`), `courier-followups.json` (`:182`). Sobrescreve o valor anterior; não guarda histórico. |
| Persistência durável (só B) | `src/couriers/fatos/courierFatos.ts`, migration `0101_courier_fatos.sql` | Fatos append-only (trigger `:80-82`) apenas de `ESTADO_ENVELOPE` e `CONFERENCIA_DOCUMENTO`. Valor anterior, autor (membership), caixa e proveniência da linha. |
| Proveniência (só B) | `src/couriers/fatos/linha.ts` | Identificador opaco assinado pelo servidor: CITADA / AMBÍGUA / INFERIDA / CLARA. **Testado.** |
| Rastreio | `src/routes/trackingRoutes.ts`, `src/fedex/fedexClient.ts`, `src/dhl/*` | Consulta sob demanda; cache em memória de 5 min e deduplicação de chamadas em voo (`:48-68`). A Linha A acrescenta o rastreio DHL pelo site (`src/dhl/dhlWeb.ts`). |
| E-mail | `src/graph/graphService.ts` | `$search` por palavras-chave (`:105-118`); leitura de e-mail encaminhado como anexo (`itemAttachment`, `:146-164`); conversa; rascunho de resposta. |
| IA | `src/ai/emailParser.ts` (`parseThread`, `:186-230`), `src/ai/geminiClient.ts` | Clara sob demanda. Até 3 novas tentativas por chamada na Linha B (`:49-50`, `:106-115`); até 1 na Linha A (`geminiClient.ts` A `:78`). |
| Consumidores | `public/Exigem Atencao.dc.html`, `public/Relatorios.dc.html` | Recalculam risco e KPIs **no navegador** a partir de `/api/couriers`. |

### 1.2 Caminhos de execução ativos

1. **Lista (sem IA).** Ao abrir a tela Courier, Exigem Atenção ou Relatórios, o front chama `GET /api/couriers`. A visão é reconstruída do zero a cada requisição, sem cache no servidor:
   - Graph `$search` com OR das palavras-chave, **top 60** (`:361-368`). Se vier vazio, usa a caixa de entrada (top 40).
   - Lê o anexo de até 25 mensagens, só do tipo `itemAttachment`. **PDF e imagem não são lidos**: pouch lists anexadas ficam fora.
   - Filtra cada e-mail, agrupa por `conversationId` e funde por tracking normalizado (`:417-571`).
   - Aplica o índice de referências, a expectativa e a resolução documental por regex (`:120-150`), o ETA por regex (`:162-202`) e os documentos por linha (`:241-278`).
   - Sobrepõe o estado e a conferência gravados (JSON + duráveis, `:586-594`, `:705-708`).
   - `GET /stats` reconstrói a mesma visão de novo (`:1108-1115`).
2. **Rastreio.** Ao carregar a lista, o front dispara a consulta de **todos** os trackings FedEx/DHL (`Courier Module:772-787`) via `GET /api/tracking/:number`. Nada do rastreio é persistido.
3. **Clara.** Ao expandir um card (`:514-518` → `ensureAnalysis :575-589`), o front chama `GET /:cid/analysis`, que lê até 6 conversas × 50 mensagens, com anexos encaminhados, e faz 1 chamada Gemini (`parseThread`). O resultado fica só na memória do navegador.
4. **Ações humanas.**
   - Estado do envelope: um dos 5 valores *Identificado / Recebido / Em Conferência / Divergência / Concluído*.
   - Marca de conferência MBL/HBL por processo: Recebido / Não recebido / desmarcar.
   - "Já realizei esta ação".
   - Rascunho de resposta no Outlook: **não envia**.

### 1.3 Armazenamento: o que persiste e o que não persiste

**Persiste:**

- JSON legado (A e B): estado, conferência e follow-up. Fica em disco efêmero se `DATA_DIR` não estiver num disco persistente.
- Linha B, só com `PRIORA_FATOS_DURAVEIS=on` (`src/operacional/contexto.ts:37-39`): fatos duráveis de estado e conferência. A gravação exige uma sessão de **pessoa** distinta da caixa monitorada (`:63-73`). Numa sessão legada, o resultado é `ATOR_INDISTINGUIVEL_DA_CAIXA` e o código **cai silenciosamente no JSON** (`courierRoutes.ts:1239-1246`, `:1371-1378`). O follow-up nunca vai ao banco.

**Não persiste:**

- e-mails, threads e anexos de origem;
- o registro do Courrier em si (o card só existe enquanto seus e-mails estiverem entre os 60 mais recentes da busca);
- documentos esperados, associações e candidatos;
- ETA;
- resultado da Clara;
- observações da transportadora (status, horário do Delivered).

A Linha A tem Supabase no app, mas o Courrier **não** o usa: grava só em JSON.

### 1.4 Fontes e integrações

| Integração | Situação |
| --- | --- |
| Microsoft Graph (leitura) | **Funciona:** `$search`, conversa, `itemAttachment`. **Incompleta:** PDF/imagem (`fileAttachment`) não lidos; sem leitura incremental no Courrier; sem detecção de envio humano. |
| Microsoft Graph (escrita) | Só `createReply` como rascunho (`:1313`). Os escopos de login incluem `Mail.Send`, mas o Courrier não envia. |
| FedEx Track API | **Funciona** com chaves. O mapeamento junta `ACTUAL_DELIVERY` com `ESTIMATED_DELIVERY` (`fedexClient.ts:153-157`). |
| DHL Unified API | Cliente existe. Na Linha A há commits de 18/10 tratando "chave sem acesso à API de rastreio" e um fallback pelo site. A disponibilidade real precisa ser confirmada (DEP-02). |
| Gemini (Clara) | **Funciona** com chave, sob demanda. Houve recusas 429 por cota durante o uso (tela de 01/09). |
| HeadCargo | **Inexistente.** Aparece só como nome de fonte no domínio da Liberação (`src/liberacao/dominio/fontes.ts`). |
| Auditoria | Não é cruzada pelo Courrier. Na Linha B, os fatos de Auditoria são consumidos pela Liberação, não pelo Courrier. |
| Tracking de armador / ETA marítima | **Não ligado ao Courrier.** Existe o motor de tracking de contêiner e vessel call do Demurrage (`src/demurrage-engine/tracking/*`, B) e scrapers de armador (A): reutilizáveis. |
| Liberação | Linha B: o Courrier dispara `envelopeRegistrado` e `conferenciaRegistrada` (`:1251`, `:1391`), só no ramo durável. Linha A: sem integração. |
| Fila de Decisões | **Placeholder** estático (`public/Fila de Decisoes.dc.html`, 38 linhas), sem integração. |
| Gestão | Relatórios e Exigem Atenção leem `/api/couriers` e calculam no navegador. |

### 1.5 Processamento agendado e autorização

**Agendamento.** **Não há processamento agendado no Courrier.** Tudo acontece sob demanda, ao abrir telas. Existe um scheduler in-process do Demurrage (`src/demurrage/schedulerBootstrap.ts`, B) e o workflow `keep-alive.yml`, que só pinga `/health`.

**Autorização.** `requireAuth` por sessão. Na Linha B, o S4 distingue pessoa × caixa, e a escrita durável é negada só ao papel `CLIENT` (`contexto.ts:73`). **Não existe o conceito de analista responsável pelo Courrier.** A trava "conferência só após recebimento" existe apenas no front.

## 2. Rastreabilidade de requisitos (matriz completa por identificador)

**Legenda.**

- **Classe:** **I** implementado; **P** parcial; **A** ausente; **C** conflitante; **D** dependente de esclarecimento (LAC, VAL ou DEP); **N/V** governança, não verificável em código.
- **Tipo de evidência:** **Cód** = inspeção de código; **Teste** = verificado por teste executado.

Salvo indicação, os caminhos são da Linha B (`courierRoutes.ts`, salvo outro arquivo indicado). A Linha A tem o mesmo núcleo, sem fatos duráveis.

**Cobertura por teste.** Nenhum CA-R ou CT-R tem teste automatizado. A única verificação por teste executado é parcial e cobre ENT-006 (`linhas.test.ts`).

### 2.1 GOV — Governança

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| GOV-001 | N/V | — | Regra de processo. Nenhuma decisão não aprovada foi adotada neste diagnóstico. |
| GOV-002 | C | Cód | Há regras no código sem aprovação: 5 estados (`courierStore.ts:23`; CHECK em `0101_courier_fatos.sql:57`); ETA ≤ 5 d e "parado ≥ 7 d" (`Exigem Atencao.dc.html:246`, `:249`); teto de 8 (`referenceResolver.ts:277`); rótulo "Não informado"; deduplicação por base (Linha A). Ver 6.3. |
| GOV-003 | C | Cód | `processosLiberados` (`:865-867`) e o texto "liberação bloqueada" (`Exigem Atencao:257`) invadem o escopo da Liberação. |
| GOV-004 | N/V | Cód | Coerente: não há simulação de HeadCargo nem de armador no Courrier. |
| GOV-005 | I | Cód | `reply-draft` só cria rascunho (`:1300-1322`); nenhum envio no Courrier. |

### 2.2 REL — Relações

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| REL-001 | P | Cód | Um card por tracking normalizado (`:526-571`). Não é persistido, não preserva a origem de cada informação e some fora do top 60. |
| REL-002 | A | Cód | Não há relação entre envelopes. |
| REL-003 | A | Cód | Não há correção de tracking. |
| REL-004 | P/C | Cód | Vários IMs por envelope: sim. MBL ligado a vários IMs: só como candidato (`referenceResolver.ts:287-320`). A conferência é por IM com coluna MBL (`Courier Module:953`): um MBL compartilhado vira duas marcações físicas. |
| REL-005 | C | Cód | "Agente" é o remetente do e-mail mais recente do envelope (`:288-294`, `:541-545`), não o agente por IM. |

### 2.3 ENT — Descoberta e criação

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| ENT-001 | P | Cód | "Processos sem courier" (`:497-511`, `:577-582`; tela `:369`) não cria Courrier. Mas é centrado no IM, não mostra referências além do assunto e não sugere e-mail. |
| ENT-002 | P | Cód | O card só existe com tracking, mas o marco de início não é registrado. |
| ENT-003 | P | Cód | `$search` top 60 (`:361-368`), threads e e-mail anexo em até 25 mensagens (`:384-395`). Não lê PDF/imagem; sem HeadCargo e sem Auditoria. Falhas de anexo são silenciadas. |
| ENT-004 | P | Cód | Resolve por referência e marca `precisaRevisao` (`:618-627`, `:723`), mas não há ação para confirmar o IM. |
| ENT-005 | P | Cód | Agrega por tracking (`:532-552`), sem cronologia. |
| ENT-006 | P | Cód + Teste | A proveniência da linha IM é assinada (`linha.ts`; `:637-646`) e testada (`linhas.test.ts`, 7/7). Os demais derivados (documentos esperados, ETA, resolução documental) não apontam evidência. |

### 2.4 ASS — Associação, expectativa e contradições

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| ASS-001 | P | Cód | Relações 1:N nunca são resolvidas automaticamente (`referenceResolver.ts:307`), mas os vínculos válidos não são preservados. O teto de 8 pode descartar vínculos válidos. |
| ASS-002 | P | Cód | `extractEnvelopeDocs` (`:241-278`) mantém os não identificados, mas só aparece quando o envelope não tem nenhum IM e não é persistido. |
| ASS-003 | A | Cód | Não sinaliza inconsistência. |
| ASS-004 | A / D | — | Não há HeadCargo (DEP-03). |
| ASS-005 | A | Cód | — |
| ASS-006 | A | Cód | Não há correção de associação. |
| ASS-007 | A | Cód | Expectativa sem histórico. |
| ASS-008 | P/C | Cód | A regex de emissão no destino (`:143-146`) vale para o envelope inteiro e a tela mostra "Emitido no destino" (`Courier Module:932`), sem histórico. |
| ASS-009 | A | Cód | — |
| ASS-010 | P/C | Cód | A regex de telex aceita negação (`:141`); "sent … consignee" (`:147-148`) vale para o envelope inteiro; "shipper" não é coberto. Em produção, Telex continuou exibido depois do fix (A2). |
| ASS-011 | P | Cód | Quando detectado, o telex aparece como motivo e não oferece marcação (`Courier Module:953`, `cell()`). |

### 2.5 TRN e TMP — Transporte e complementos temporais

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| TRN-001 | I (ressalva) | Cód | O estado só muda por ação humana (`:1231-1263`), mas Delivered aparece em verde (`Courier Module:797`, `:898`, `:905`). |
| TRN-002 | A | Cód | — |
| TRN-003 | A / D | Cód | Depende de LAC-01 a LAC-05. |
| TRN-004 | A | Cód | Delivery Exception não é classificada. |
| TRN-005 | A | Cód | — |
| TRN-006 | A | Cód | Não há "etiqueta criada" nem relógio. |
| TRN-007 | C | Cód | "Parado ≥ 7 d" calculado pela data do e-mail (`Exigem Atencao:249`). |
| TRN-008 | A | Cód | — |
| TMP-001 | A | Cód | Sem horário de Brasília: datas no fuso do navegador (`Courier Module:509-510`). |
| TMP-002 | A / D | Cód | — |
| TMP-003 | A / D | Cód | — |
| TMP-004 | I (por omissão) | Cód | Nada escala nem confirma automaticamente. A regra precisa ser preservada quando houver escalonamento. |

### 2.6 CNF — Conferência física

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| CNF-001 | I (limitado) | Cód | Recebido / Não recebido / sem marca, apenas para MBL e HBL Original por IM (`:1357-1406`). |
| CNF-002 | P | Cód | O recebimento é separado, mas a trava de conferência existe só no front (`Courier Module:293-295`, `:1056`): a API aceita conferência em envelope "Identificado". |
| CNF-003 | I | Cód | Cada marca é gravada isoladamente; itens não tocados ficam sem marca. |
| CNF-004 | A / D | Cód | Não há responsável; só o papel CLIENT é bloqueado (`operacional/contexto.ts:73`). Depende de LAC-11. |
| CNF-005 | P/C | Cód | "Finalizar courier" está disponível a partir de "Recebido", sem conferência (`Courier Module:824`). |
| CNF-006 | C | Cód | "Divergência resolvida — finalizar" (`:826`) leva a Concluído, que sai da lista (`:731-734`). |
| CNF-007 | P | Cód | Desmarcar ou trocar é possível; o durável guarda `valor_anterior` (B). Sem justificativa, reabertura nem recálculo. |
| CNF-008 | P | Cód | É possível remarcar como Recebido e os follow-ups são mantidos, sem semântica de "encontrado depois". |

### 2.7 RES — Ressalvas, danos e inesperados

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| RES-001 | A | Cód | Não há ressalva na conclusão. |
| RES-002 | A | Cód | — |
| RES-003 | A / D | Cód | Não há fotos (LAC-08) nem HeadCargo (DEP-03). |
| RES-004 | A | Cód | — |
| RES-005 | A | Cód | — |
| RES-006 | A | Cód | — |
| RES-007 | A | Cód | A classe CLARA existe para linhas de IM, não para documentos inesperados. |
| RES-008 | A | Cód | — |

### 2.8 ETA — ETA marítima e prioridade

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| Tabela de limiares | C / D | Cód | Exigem Atenção usa ≤ 5 d (`:246`). Depende de LAC-06. |
| ETA-001 | A / D | Cód | ETA vem de regex no e-mail (`:162-202`). Depende de DEP-02. |
| ETA-002 | P | Cód | Recalcula a cada carga, sem persistência nem alerta de agravamento. |
| ETA-003 | C | Cód | Não marca incerteza; captura qualquer data até 25 caracteres após o rótulo; infere o ano quando falta (`:162`, `:178-188`). |
| ETA-004 | A | Cód | — |

### 2.9 CLA — Clara, cobranças e promessas

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| CLA-001 | I | Cód | Modal editável, cópia e rascunho (`:1300-1322`; `Courier Module:658-690`). |
| CLA-002 | P | Cód | O rascunho responde na conversa mais recente do envelope (`:1018-1031`), não necessariamente na thread original. |
| CLA-003 | A/C | Cód | Um rascunho por processo + documento (`Courier Module:691`, `:1006`); não consolida por thread. |
| CLA-004 | P/C | Cód | Traz IM e MBL/HBL. Não traz ETA nem evidência, e afirma "today" (`Courier Module:665`, `:678`). |
| CLA-005 | A | Cód | — |
| CLA-006 | P | Cód | A pendência surge ao marcar "Não recebido" (`Courier Module:1010`), sem depender da conclusão. |
| CLA-007 | A / D | Cód | Depende de DEP-06 e LAC-09. |
| CLA-008 | A / D | Cód | Depende de LAC-14. |
| CLA-009 | A | Cód | — |
| CLA-010 | P | Cód | Um item por courier, com um único motivo; precedência ad hoc (LAC-07). |
| CLA-011 | I (frágil) | Cód | Não resolve a pendência (`:1330-1344`), mas fica só no JSON legado. |
| CLA-012 | A / D | Cód | Depende de LAC-09. |

### 2.10 SOL — Resolução de pendências

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| SOL-001 | A | Cód | Não existe o objeto pendência. |
| SOL-002 | A | Cód | — |
| SOL-003 | A | Cód | — |
| SOL-004 | P | Cód | Só a exibição por regex, sem o histórico "Resolvido por emissão no destino". |
| SOL-005 | A / D | Cód | Depende de DEP-04. |
| SOL-006 | A / D | Cód | Depende de DEP-04; a Fila de Decisões é placeholder. |
| SOL-007 | A / D | Cód | Depende de LAC-13 e VAL-03. |
| SOL-008 | C | Cód | `processosLiberados` (`:865-867`). |

### 2.11 KPI — Indicadores e Gestão

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| KPI-001 | P | Cód | Calculados automaticamente, mas a partir da janela de 60 e-mails (`:786-914`; `/stats :1108-1115`). |
| KPI-002 | A | Cód | Não há classificação de falha. |
| KPI-003 | A | Cód | — |
| KPI-004 | A | Cód | — |
| KPI-005 | A | Cód | — |
| KPI-006 | C / D | Cód | "Tempo médio" = conclusão − primeira menção (`:868-873`). Depende de LAC-10. |
| KPI-007 | I | Cód | Os indicadores aparecem em Gestão › Relatórios. |
| KPI-008 | A | Cód | — |

### 2.12 HIS — Histórico e rastreabilidade

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| HIS-001 | P | Cód | Durável só para estado e conferência (B, com a chave ligada); o resto não é persistido. |
| HIS-002 | C | Cód | O JSON sobrescreve e a lista esconde a divergência ao concluir. |
| HIS-003 | P | Cód | Concluído sai da lista (`:731-734`), mas não há pesquisa histórica. |
| HIS-004 | C | Cód | Concluído com pendência ativa fica oculto. |
| HIS-005 | C | Cód | "Liberação bloqueada" (`Exigem Atencao:257`). |

### 2.13 Critérios de aceite AC-01 a AC-24 (e CT-001 a CT-024)

Cada CT-0xx verifica o AC de mesmo número. **Nenhum foi executado:** não existem fixtures nem testes para eles. A situação abaixo vem de inspeção de código.

| AC / CT | Regras | Situação |
| --- | --- | --- |
| AC-01 / CT-001 | REL-001, ENT-005, ENT-006 | P — um card por tracking; evidências não preservadas. |
| AC-02 / CT-002 | ENT-001, ENT-002 | P — nenhum Courrier fictício; não há "Envios sem tracking". |
| AC-03 / CT-003 | REL-003, KPI-008 | A |
| AC-04 / CT-004 | REL-002, SOL-001 | A |
| AC-05 / CT-005 | REL-004, ASS-001 | C — MBL compartilhado gera marcação por IM. |
| AC-06 / CT-006 | CNF-001, CNF-003 | I (Cód) — não verificado por teste. |
| AC-07 / CT-007 | TRN-001 a TRN-003, TMP-001 a TMP-004 | A — só TRN-001 atende. |
| AC-08 / CT-008 | CNF-005, CNF-006, HIS-002, HIS-004 | C |
| AC-09 / CT-009 | RES-006 a RES-008 | A |
| AC-10 / CT-010 | RES-001, RES-004, RES-005 | A |
| AC-11 / CT-011 | ETA-001, CLA-005 | A |
| AC-12 / CT-012 | ETA-001, ETA-003 | A |
| AC-13 / CT-013 | TRN-006, CLA-009 | A |
| AC-14 / CT-014 | TRN-004, TRN-005 | A |
| AC-15 / CT-015 | CLA-002, CLA-003 | A |
| AC-16 / CT-016 | CLA-003 | A |
| AC-17 / CT-017 | CLA-008 | A / D |
| AC-18 / CT-018 | ASS-008, SOL-004, SOL-005, SOL-008 | P — só exibição; a Liberação (B) é separada. |
| AC-19 / CT-019 | SOL-006 | A / D |
| AC-20 / CT-020 | CNF-007, CNF-008, KPI-005 | P — append-only (B), sem justificativa e sem KPI. |
| AC-21 / CT-021 | KPI-002, KPI-003 | A |
| AC-22 / CT-022 | HIS-003 | P — sai da lista, mas não é pesquisável. |
| AC-23 / CT-023 | CNF-004 | A / D |
| AC-24 / CT-024 | CLA-010 | P — consolida, com um único motivo. |

### 2.14 Cenários complementares CT-025 a CT-042

| CT | Regras | Situação atual | Bloqueio para homologação |
| --- | --- | --- | --- |
| CT-025 | TMP-001, TMP-002 | A | LAC-03, LAC-05 |
| CT-026 | TMP-003, TRN-003 | A | LAC-01 a LAC-05 |
| CT-027 | TMP-003, TRN-003 | A | LAC-04, LAC-05 |
| CT-028 | TMP-002, TMP-003 | A | LAC-03, LAC-05 |
| CT-029 | TMP-002, TMP-003 | A | LAC-03 a LAC-05 |
| CT-030 | TMP-002, TMP-003 | A | LAC-01 a LAC-05 |
| CT-031 | TMP-003, TRN-003 | A | LAC-01 a LAC-05 |
| CT-032 | TMP-003 | A | LAC-01, LAC-02 |
| CT-033 | TRN-001, TMP-004, CNF-002 | P — a separação existe; a condição não é calculada. | Sem bloqueio |
| CT-034 | TRN-003, TMP-004 | A | Momento: LAC-04 |
| CT-035 | TMP-001, TMP-003 | A | LAC-03 |
| CT-036 | CLA-007, DEP-06 | A | LAC-09 |
| CT-037 | CLA-007, CLA-008 | A | LAC-09, LAC-14 |
| CT-038 | SOL-001, SOL-003, HIS-002 | A | Sem bloqueio |
| CT-039 | ASS-008, ASS-009, SOL-004, SOL-008 | A (exibição parcial) | Sem bloqueio |
| CT-040 | ASS-002, ASS-003 | P — documentos por linha. | Sem bloqueio |
| CT-041 | RES-002, RES-003, RES-005 | A | Sem bloqueio |
| CT-042 | KPI-002, KPI-004, KPI-008 | A | Sem bloqueio |

### 2.15 DEP — Dependências técnicas

| ID | Classe | Situação (Cód) |
| --- | --- | --- |
| DEP-01 | P | Leitura, busca, conversa e e-mail anexo funcionam. Sem PDF/imagem (`fileAttachment`) e sem detecção de envio humano. |
| DEP-02 | P | Clientes FedEx e DHL existem; a chave DHL está em dúvida (commits da Linha A); o armador não é ligado ao Courrier. |
| DEP-03 | A | Não há HeadCargo. |
| DEP-04 | P | A Liberação (B) consome os fatos (`:1251`, `:1391`); a Fila de Decisões é placeholder. |
| DEP-05 | P | `courier_fatos` append-only só para estado e conferência; sem anexos e fotos. |
| DEP-06 | A | Sem detecção de envio humano. |

### 2.16 VAL — Pontos de validação

| ID | Situação |
| --- | --- |
| VAL-01 | Aberta. O código não distingue correção de tracking de novo envelope. |
| VAL-02 | Resolvida em parte pelo Blueprint (Brasília, 18h, 2 h). O código não implementa nada disso. |
| VAL-03 | Aberta. Não há vínculo entre threads. |
| VAL-04 | Aberta. Não há fotos. |
| VAL-05 | Aberta. "Já realizei esta ação" existe (`:1330-1344`), sem prova de envio. |

### 2.17 LAC — Lacunas (todas abertas)

| ID | Escolha implícita já presente no código |
| --- | --- |
| LAC-01 | Nenhuma: não há expediente. |
| LAC-02 | Nenhuma: não há calendário. |
| LAC-03 | O FedEx mistura entrega real e previsão (`fedexClient.ts:153-157`); não há instante de detecção. |
| LAC-04 | Nenhuma. |
| LAC-05 | Nenhuma. |
| LAC-06 | **Sim:** dias contados pela diferença desde a meia-noite local, com limite ≤ 5 (`Exigem Atencao:239-246`). |
| LAC-07 | **Sim:** severidade de 0 a 2 e ordenação própria (`Exigem Atencao:250-274`). |
| LAC-08 | Nenhuma: não há anexos nem fotos. |
| LAC-09 | "Já realizei" não comprova envio. |
| LAC-10 | **Sim:** "tempo médio" (`:868-873`). |
| LAC-11 | **Sim:** qualquer membro não-CLIENT pode alterar. |
| LAC-12 | Nenhuma. |
| LAC-13 | Nenhuma. |
| LAC-14 | **Sim:** a Clara recebe a data da mensagem mais recente como referência para datas relativas (`emailParser.ts:215-218`). |
| LAC-15 | **Sim:** catálogo de 5 estados, com CHECK em banco. |
| LAC-16 | Ver DEP. |

## 3. Lacunas funcionais e regressões

### 3.1 Onde o comportamento atual difere do Blueprint

1. **O Courrier não é um registro, é uma visão efêmera da caixa postal.** O envelope existe só enquanto seus e-mails estão entre os **60 mais recentes** do `$search` (`courierRoutes.ts:361-368`). Envelopes antigos, pendências abertas e divergências desaparecem da tela, das KPIs e de Exigem Atenção sem nenhuma ação humana. Isso contraria REL-001, HIS-001, HIS-003, HIS-004 e KPI-001. É a lacuna estrutural de maior impacto.
2. **Uma única máquina de 5 estados mistura dimensões** que o Blueprint separa (cap. 02: transporte, envelope, documento, pendência):
   - "Finalizar courier" a partir de "Recebido" pula a conferência;
   - "Divergência resolvida — finalizar" apaga da lista uma pendência ainda ativa;
   - não existe "Concluído com divergência".

   Afeta CNF-005, CNF-006, HIS-002, HIS-004, SOL-001 a SOL-003 e AC-08.
3. **A unidade documental é "IM × {MBL, HBL}", não "documento físico".** Um MBL compartilhado por dois IMs gera duas marcações (REL-004, AC-05). A expectativa OMBL/OHBL é decidida por regex sobre o texto de todo o envelope (`:120-124`), não por documento. A lista "cada linha = 1 documento" (`:241-278`) só aparece quando não há nenhum IM.
4. **Inferências por regex com efeito de resolução.** Telex, destino e importador são detectados por palavra solta e aplicados ao envelope inteiro (`:133-150`). Podem remover a expectativa física de um documento sem evidência confiável (ASS-008, ASS-010) e não deixam histórico (ASS-007, ASS-009).
5. **Regras de negócio no navegador.** Risco e prioridade (Exigem Atenção), KPIs (Relatórios), trava de conferência e expectativa por célula ficam no front. Consequências: não são testáveis por fixture, não são determinísticas para todos os usuários ao mesmo tempo e divergem do Blueprint (≤ 5 dias contra a tabela 3/7).
6. **Tempo.** Não há horário de Brasília, não há marco de Delivered persistido, e o FedEx mistura entrega real com previsão. Detalhes na seção 4.
7. **Persistência dupla e silenciosa (Linha B).**
   - Com a chave ligada, a escrita vai para `courier_fatos`; na sessão legada, ou com o banco indisponível, cai no JSON **sem avisar a tela**, salvo o campo `duravel.gravado:false`.
   - A leitura sobrepõe o durável ao JSON (`:586-594`).
   - Resultado: a verdade pode ficar dividida entre duas fontes.
   - Follow-ups só existem no JSON. O JSON fica em disco que pode ser efêmero no Render.
8. **Permissões.** Não há analista responsável nem transferência auditada (CNF-004, AC-23). A trava de recebimento antes da conferência existe só no front (CNF-002).
9. **Invasão de escopo (GOV-003, SOL-008, HIS-005).** `processosLiberados` e o texto "liberação bloqueada".
10. **Cobrança.** O modelo afirma "received the courier today", não há consolidação por thread, o rascunho pode cair na thread errada, faltam ETA e evidência, e não há relógios (CLA-002 a CLA-008).

### 3.2 Riscos sobre o que já funciona

- **Duas linhas divergentes (risco nº 1).** Implementar sobre a linha errada perde trabalho ou reintroduz regressões:
  - A Linha A tem o fallback DHL pelo site, login Priora, Supabase e a Relatórios com 40 s.
  - A Linha B tem fatos duráveis, identidade S6, Liberação, S4 e captura incremental do Graph.
  - Elas têm implementações distintas do mesmo conceito: `microsoftAccount.ts` (A) contra `microsoftConnection.ts`/`activeAccount` (B), e timeout de 40 s (A) contra 25 s (B) na Relatórios.
- **Histórico já gravado.**
  - `courier_fatos` (B) é append-only e restrito por CHECK ao catálogo de 5 estados (`0101:57`). Mudar o catálogo (LAC-15) exige migration que **preserve** as linhas antigas e mapeie a semântica, sem reescrever.
  - O JSON legado não tem histórico: só o último valor é recuperável.
- **Integridade da identidade.** A chave do envelope é `trackingKey` (alfanumérico maiúsculo). A conferência é pela referência exata do IM (N-3), o que está correto e testado. Qualquer mudança para unidade documental precisa manter compatibilidade com essas chaves e com a projeção da Liberação (`fatosCourierDoProcesso`).
- **Liberação (B) já consome o Courrier.** Mudanças em `courier_fatos` ou em `associacao` mexem na Liberação. Os gatilhos `envelopeRegistrado` e `conferenciaRegistrada` precisam continuar idempotentes.
- **Custo e quota.** Cada abertura de Courier, Exigem Atenção ou Relatórios refaz a busca no Graph e até 25 leituras de anexo. Retries de 429 no Gemini consomem cota sem chance de sucesso quando a cota diária acabou.

### 3.3 Componentes que funcionam e devem ser reutilizados

| Componente | Onde | Serve a |
| --- | --- | --- |
| Filtro determinístico de e-mail, candidatos de tracking e exclusão de conta | `courierFilters.ts` (A/B) | ENT-003, definição de Tracking |
| Captura exata de IM (testada) | `identidade/captura.ts` (B) | ENT-004, ENT-006, ASS-001 |
| Índice de referências com cardinalidade | `referenceResolver.ts` (A/B) | ASS-001, ASS-002; rever o teto de 8 |
| Fatos append-only, projeção e gatilhos da Liberação | `courierFatos.ts`, `0101` (B) | HIS-001, HIS-002, CNF-007, DEP-04, DEP-05 |
| Proveniência assinada pelo servidor (testada) | `couriers/fatos/linha.ts` (B) | ENT-006, RES-007 |
| Pessoa × caixa e contexto operacional | `operacional/*`, `auth/pessoa` (B) | CNF-004 (base), autoria em HIS-001 |
| Clientes FedEx/DHL, cache e deduplicação em voo; token FedEx em cache | `trackingRoutes.ts`, `fedexClient.ts` (A/B); `dhlWeb.ts` (A) | TRN-\*, DEP-02 |
| Captura incremental do Graph (delta + cursor + 429) | `graphService.ts` (`getMailFolderDeltaPage`), `capturaPreAlerta*` (B) | ENT-003, ENT-005, custo |
| Scheduler in-process e data operacional em `America/Sao_Paulo` | `demurrage-engine/scheduler/*`, `time/operationalDate.ts` (B) | TMP-001, TRN-006, relógios. **Atenção:** o fuso desse módulo é sobrescrevível por `DEMURRAGE_TZ_OPERACIONAL`, e TMP-001 proíbe substituto. |
| Tracking de contêiner, armador e vessel call | `demurrage-engine/tracking/*` (B), scrapers (A) | ETA-001, ETA-003 |
| Rascunho na thread sem envio | `reply-draft` (A/B) | CLA-001, CLA-002 |
| Documentos por linha | `extractEnvelopeDocs` (A/B) | ASS-002, CT-040 (base) |

## 4. Entregue sem confirmação

### 4.1 Separação entre Delivered da transportadora e recebimento físico

**O que existe (Cód).** A separação de dados de TRN-001 e CNF-002 está correta:

- o status da transportadora é só leitura (`trackingRoutes.ts:75-106`) e nunca muda o estado do envelope;
- "Recebido" só nasce de ação humana (`courierRoutes.ts:1231-1263`; na Linha B, como fato durável com autor);
- marcar o recebimento não marca nenhum documento.

**O que não existe (Cód):**

- A condição "Delivered sem confirmação" **não é calculada em lugar nenhum**: nem no servidor nem no front.
- O front pinta "Delivered/entregue" de **verde**, com a mesma cor de sucesso (`Courier Module:797`, `:898`, `:905`). Isso induz a ler entrega como recebimento: contraria o espírito de TRN-001 e o destaque amarelo de TRN-002.
- Não há destaque no topo, nem a ação "Courrier ainda não chegou", nem escalonamento (TRN-003), nem registro de "possível falha de entrega".

### 4.2 Base temporal disponível hoje

- **Nenhum instante de Delivered é persistido.** O `TrackingResult` (`src/tracking/types.ts:8-23`) não tem campo de entrega. Os eventos vêm com o horário cru da transportadora (FedEx com offset do local do evento; DHL `timestamp`). O resultado vive 5 minutos em memória e só é buscado quando alguém abre a tela.
- **O FedEx mistura entrega real com previsão.** `estimatedDelivery` recebe `ESTIMATED_DELIVERY` **ou** `ACTUAL_DELIVERY` (`fedexClient.ts:153-157`), e a tela mostra isso como "Chegada". Para LAC-03 (marco inicial), o código atual não distingue os dois.
- **Não há "instante de detecção" nem "instante de ciência" registrados.** Hoje só o horário do evento informado pela transportadora estaria disponível, e apenas no momento da consulta. Se a consulta acontece horas depois, nada registra o atraso (CT-035).
- **Não há horário de Brasília (TMP-001).** As datas são formatadas no fuso do navegador (`Courier Module:509-510`). O servidor não calcula nada temporal para o Courrier. Existe utilitário de data operacional em `America/Sao_Paulo` na Linha B (`demurrage-engine/time/operationalDate.ts`), mas ele aceita substituição por variável de ambiente: para TMP-001 o fuso precisa ser **fixo**, sem substituto.

### 4.3 Fechamento às 18h e mínimo de duas horas operacionais

Nada está implementado: nem o dia operacional, nem a acumulação de minutos operacionais, nem a elegibilidade por 120 minutos.

O que o Blueprint já fixa e **pode** ser implementado sem suposição:

1. **Referência:** Brasília (`America/Sao_Paulo`, fixo).
2. **Corte:** nenhum minuto após 18:00 de Brasília conta como operacional (TMP-002; CT-028, CT-030).
3. **Elegibilidade:** abaixo de 120 minutos operacionais acumulados, o escalonamento por decurso é inelegível; com 120, a condição mínima está satisfeita, mas isso **não** define a cor sozinho (TMP-003; CT-026, CT-027).
4. **A virada de meia-noite não dispensa o mínimo** (CT-031).
5. **Confirmar recebimento encerra a condição** (CT-033), e o decurso nunca confirma recebimento nem declara extravio (TMP-004; CT-034).
6. **Horário ausente ou atraso de integração** gera "limitação de cálculo", e não um marco fabricado (CT-035).

O que **não** pode ser decidido pelo código, e permanece parâmetro explícito ou estado "indeterminado":

- **LAC-01:** abertura do expediente. Sem ela, não se sabe quando o dia seguinte começa a acumular.
- **LAC-02:** calendário, feriados e fins de semana.
- **LAC-03:** marco inicial — evento, detecção ou ciência.
- **LAC-04:** momento exato do vermelho e saldo entre dias.
- **LAC-05:** precisão e arredondamento.

**Proposta de contrato (sem escolher valores).** Uma função pura no servidor recebe:

- o instante de referência com sua origem (evento/detecção/ciência);
- o instante de avaliação;
- `abertura` (LAC-01), `calendário` (LAC-02) e `precisão` (LAC-05) como parâmetros obrigatórios.

Ela devolve `minutosOperacionais` e `INELEGÍVEL | MÍNIMO_ATINGIDO | INDETERMINADO(motivo)`. Sem os parâmetros homologados, a saída é `INDETERMINADO`, nunca um padrão oculto: **não assumir 8h, 9h, dias úteis nem 24 horas corridas**. O amarelo de TRN-002 não depende desse cálculo. O vermelho de TRN-003 só pode ser ligado depois de LAC-01 a LAC-05; até lá, a tela pode mostrar "escalonamento ainda não homologável", sem cor vermelha.

### 4.4 Relógios distintos

A janela de duas horas operacionais vale **apenas** para Delivered sem confirmação. Os prazos de 24 horas são outros relógios e não podem reutilizar o cálculo operacional nem ser convertidos em horas úteis:

- etiqueta sem coleta (TRN-006, CLA-009);
- resposta a cobrança (CLA-007);
- consulta ao armador (CLA-012).

Nenhum desses relógios existe hoje. Os de cobrança dependem ainda de prova de envio humano (DEP-06, LAC-09).

### 4.5 Precedência e consolidação

Delivery Exception, extravio, ETA e Delivered simultâneos devem gerar um alerta consolidado (CLA-010, AC-24). A ordem entre eles depende de LAC-07. Hoje não há nenhuma dessas condições de transporte calculada.

## 5. IA e custos operacionais

**Medições.** Não há contadores persistidos de chamadas ao Graph, às transportadoras ou ao Gemini, nem de tokens:

- A Linha A registra no log, por chamada, os tokens de entrada e saída e um custo estimado (`src/ai/geminiClient.ts:275-281`, linha `[Gemini][custo]`). O valor não é agregado, e eu não tive acesso a esses logs.
- A Linha B não registra nem isso.

Por isso **não apresento nenhum número de custo ou volume**. Onde cito frequência, ela vem da lógica de disparo, não de medição.

### 5.1 Inventário de chamadas de IA no Courrier

Há **uma** chamada de IA no fluxo do Courrier. A lista principal é **100% determinística**.

| Item | Descrição |
| --- | --- |
| Chamada | `parseThread` (`emailParser.ts:186-230`) via `GET /api/couriers/:cid/analysis` (`courierRoutes.ts:1130-1223`). |
| Propósito | Processos, documentos, `hblResolution`, datas, evidências, resumo e confiança da "Clara" para o envelope. |
| Gatilho | Expandir um card (`Courier Module:514-518` → `ensureAnalysis :575-589`). |
| Frequência (pela lógica) | 1 chamada por card expandido, por aba do navegador. O cache existe só em memória do navegador, então recarregar, abrir outra aba ou outro usuário repete a chamada. Em erro 429/503/500 há novas tentativas: até 3 na Linha B (`geminiClient.ts:49-50`, `:106-115`) e até 1 na Linha A (`geminiClient.ts` A `:78`). Cada tentativa é uma nova chamada. |
| Entradas | Até 6 conversas × 50 mensagens com corpo integral e o texto de e-mails anexados. **Sem truncamento** do transcript. |
| Reuso existente | Nenhum no servidor; nada é persistido. |
| O que já é determinístico | Processos citados (`capturarReferenciasProcesso`); o próprio endpoint **descarta** IMs da Clara que não estão escritos no texto (`:1193-1199`). Mapa documento×processo por linha (`mapProcessDocs`, `:923-943`). Telex/wave/destino por regex. ETA por regex. |

Outras chamadas Gemini existem fora do Courrier e **disputam a mesma cota**: OCR e Auditoria, PRE-ALERTA, Demurrage parser, `trackingOrganizer`, `shippingInstructionsPorts`, `/api/analysis` e, na Linha A, `processRoutes` e `browser/carriers/aiExtract`. A recusa 429 vista na tela do Courrier em 01/09 é compatível com essa concorrência; não há medição para atribuir a causa.

**IA no carregamento da Relatórios (fora do Courrier).** Ao montar, a Relatórios chama `/api/demurrage`. Esse endpoint faz até 14 chamadas Gemini por requisição (`demurrageRoutes.ts` A `:373-388`; o mesmo `AI_CAP` existe na Linha B, `:295-301`), e a Relatórios re-tenta até 4 vezes. Detalhes, cancelamento e sobreposição em A3 e A4. É a maior fonte de IA repetida encontrada no código; o volume real não foi medido.

### 5.2 O que pode deixar de usar IA (total ou parcialmente)

- **Pode ser totalmente determinístico:**
  - processos citados;
  - tipo de documento por linha;
  - BL por linha;
  - tracking;
  - estados, prazos, relógios, permissões, prioridade, deduplicação e cálculos.

  Isso já é assim na lista e deve continuar.
- **Pode ser determinístico com regra explícita, com IA só como fallback marcado como "inferido":**
  - telex/wave/destino *afirmativos* (hoje a regex não distingue negação);
  - ETA com rótulo e data completa.
- **Justifica IA, por exigir interpretar linguagem livre:**
  - promessas ("tomorrow", CLA-008, sujeito a LAC-14);
  - correção explícita contra novo envelope (REL-003, LAC-12);
  - mudança de instrução (ASS-007/009);
  - "envio ao shipper depois do pagamento" (ASS-010);
  - confirmação em outra thread (SOL-007, LAC-13).

  Mesmo nesses casos, o resultado da IA deve ser **sugestão com evidência (trecho + id da mensagem)**, confirmada por humano quando a regra exigir.

### 5.3 Processamento repetido e chamadas externas desnecessárias (Cód)

1. **`/api/couriers` sem cache no servidor:**
   - Cada abertura de Courier, Exigem Atenção e Relatórios refaz o `$search` (top 60) e até 25 leituras de anexo.
   - `/stats` refaz tudo de novo.
   - Relatórios re-tenta até 3× em timeout.
   - O mesmo e-mail é reprocessado a cada abertura.
2. **Rastreio:**
   - O prefetch consulta **todos** os trackings FedEx/DHL a cada carga da tela, inclusive de envelopes já recebidos ou concluídos.
   - O cache de 5 minutos é em memória e se perde a cada reinício.
3. **Clara:**
   - A análise é refeita do zero a cada expansão em nova sessão, mesmo sem nenhuma mensagem nova.
   - Ela também relê até 300 mensagens e anexos.
4. **Retries em 429 por cota esgotada** gastam tempo e chamadas sem chance de sucesso.

Os itens 1 a 4 descrevem a lógica do código, não medições. Em A4: as tentativas não cancelam o trabalho anterior, nem no cliente nem no servidor, e por isso podem se sobrepor a ele.

### 5.4 Otimizações propostas, invalidação e trade-offs

| Otimização | Invalidação necessária | Trade-off / preservação de cobertura |
| --- | --- | --- |
| **Ingestão incremental** via delta do Graph (reusar `getMailFolderDeltaPage`, B): cada mensagem processada uma vez (dedupe por `id`/`internetMessageId`) e derivados recalculados só para os trackings afetados. | Mensagem nova ou alterada (delta). Mensagem removida (`@removed`: manter a evidência marcada, não apagar). Mudança de versão das regras ou do resolvedor recalcula tudo. Cursor expirado força ressincronização dentro de uma janela definida. | **Aumenta** a cobertura: elimina o corte de 60 e-mails. Exige persistência (DEP-05) e política de retenção (LAC-08). O frescor passa a depender do intervalo do ciclo. |
| **Visão materializada única** no servidor, compartilhada por Courier, Exigem Atenção e Relatórios. | Nova mensagem, fato gravado ou observação de transporte nova. | Elimina reprocessamento idêntico. A defasagem máxima precisa ser explícita na tela. |
| **Cache da Clara** persistido, chaveado por (ids das mensagens + última alteração + versão do prompt e do modelo). IA só para itens que o determinístico não resolveu. | Mensagem nova em qualquer thread ligada; troca de prompt ou modelo; correção humana de associação. | Mantém as evidências (trechos). Risco: um caso ambíguo não ser enviado à IA, mitigado por regra de encaminhamento explícita e teste de cobertura com fixtures. |
| **Rastreio persistido e agendado por estado**: deduplicado por número; nenhuma consulta após recebimento confirmado; frequência por status. | TTL por status; evento novo; confirmação humana encerra a consulta. | Reduz chamadas e dá o marco temporal que a seção 4 exige. A frequência de consulta define o atraso de detecção: registrar o instante de detecção (CT-035). |
| **Anexo lido uma vez** por mensagem; ler PDF e imagem só para mensagens candidatas. | Nova versão do anexo. | Amplia a cobertura (pouch lists em PDF) com custo controlado. A leitura de PDF/imagem pode exigir OCR por IA: decidir caso a caso. |
| **Sem retry em 429 de cota diária**; retry só em sobrecarga transitória. | — | Não reduz cobertura; a análise falha rápido e é refeita quando houver cota. |

Nenhuma otimização acima remove evidência. Todas exigem que cada derivado continue apontando para a mensagem e o trecho de origem (ENT-006, HIS-001).

## 6. Dependências e decisões pendentes

### 6.1 Investigação técnica (não exige decisão de produto)

| # | Questão | Por que bloqueia | Como verificar |
| --- | --- | --- | --- |
| T1 | **Qual linha está em produção e qual será a base da implementação** (A, B ou consolidação)? | Todas as etapas. | `/health` expõe `commit` e `branch`; configuração de branch do serviço no Render. |
| T2 | PostgreSQL de produção (Linha B): migrations aplicadas, `PRIORA_FATOS_DURAVEIS`, `SESSION_SECRET` explícito (sem ele, `linha.ts` não emite proveniência oficial — testado). | Persistência (DEP-05) e todo HIS/CNF durável. | Leitura de configuração pelo time, sem acesso meu à produção. |
| T3 | Permissões Graph: leitura de `fileAttachment` (PDF/JPG), delta por pasta, leitura de Itens Enviados para detectar envio humano. | ENT-003, ASS-002, DEP-01, DEP-06. | Testar com uma caixa de homologação. |
| T4 | Chaves e cotas FedEx/DHL, incluindo a recusa da chave DHL vista em commits da Linha A. Mapeamento de códigos de status para Delivered, Exception e Label Created por transportadora. | TRN-001 a TRN-008, DEP-02. | `/api/tracking/health` e fixtures de payload real anonimizadas. |
| T5 | Cobertura do tracking de armador para MBL: reusar o motor do Demurrage (B) ou os scrapers (A). | ETA-001 a ETA-004, AC-11, AC-12. | Levantar armadores atendidos e correlação MBL → container → navio. |
| T6 | HeadCargo: não há código nem contrato. | ASS-004, RES-003, DEP-03. | Contrato de API real. |
| T7 | Contratos com Liberação e Fila de Decisões; a Fila é placeholder. | SOL-006, SOL-007, AC-19, DEP-04. | Blueprints próprios desses módulos. |
| T8 | Armazenamento de anexos e fotos: não há store de binários no Courrier. | RES-003, HIS-001. | Depende também de LAC-08. |
| T9 | Banco de teste isolado para `courierFatos.test.ts`, que faz `truncateAll`. | Verificação de regressão durável. | URL dedicada e descartável em CI. |
| T10 | Reconciliação A × B em `auth` (`microsoftAccount` × `microsoftConnection`/S4) e nas telas (Relatórios 40 s × 25 s). | Risco de regressão ao unificar. | Diff dirigido; testes de caracterização. |

### 6.2 Decisões de produto: bloqueiam comportamentos específicos

Nenhuma delas será resolvida por suposição. O restante da etapa correspondente pode avançar com a incerteza explícita.

| Comportamento bloqueado | Depende de |
| --- | --- |
| Vermelho e escalonamento de TRN-003 (completo); CT-026 a CT-032 e CT-035 homologáveis | LAC-01 a LAC-05, VAL-02 |
| Limites de ETA, unidade e rótulo de "prioridade máxima" | LAC-06 |
| Ordem de ação entre riscos simultâneos (a consolidação já está aprovada) | LAC-07 |
| Relógios de 24 h de CLA-007 e CLA-012; ação fora do canal | LAC-09, DEP-06, VAL-05 |
| Vencimento de promessas (CLA-008) | LAC-14 |
| Correção de tracking × novo envelope sem declaração explícita | LAC-12, VAL-01 |
| Confirmação em outra thread (SOL-007) | LAC-13, VAL-03 |
| Métrica de resolução (KPI-006) | LAC-10 |
| Quem assume responsabilidade, corrige associação e consulta histórico (CNF-004, ASS-006) | LAC-11 |
| Fotos e anexos: retenção, acesso e limites | LAC-08, VAL-04 |
| Catálogo final de estados e transições, inclusive o destino dos 5 estados atuais e do CHECK em banco | LAC-15 |
| Disponibilidade real de APIs e custos | LAC-16 |

### 6.3 Pontos que este diagnóstico revelou e que precisam de validação

**PRECISA DE SUA VALIDAÇÃO** (GOV-002). São comportamentos já presentes no código, sem base no Blueprint. Não proponho decidir nenhum deles; só aponto que não devem ser preservados por inércia:

- **Teto `MAX_SHARED_PROCESSES = 8`** (`referenceResolver.ts:277`). Introduzido para eliminar candidatos fantasmas, mas ASS-001 manda preservar **todos** os vínculos válidos.
- **Rótulo "Não informado" para OHBL** e **resolução documental por regex no nível do envelope** (`:133-150`).
- **Limiar ≤ 5 dias e "parado ≥ 7 dias"** em Exigem Atenção.
- **Máquina de 5 estados** ("Manual") e ação "Divergência resolvida — finalizar".
- **KPI `processosLiberados`** e o texto "liberação bloqueada".

## 7. Etapas de implementação propostas

**Critérios comuns a todas as etapas:**

- uma etapa por revisão;
- lógica de negócio no servidor, como funções puras testáveis por fixture;
- mudanças aditivas, atrás de chave quando alteram a tela;
- nenhuma LAC preenchida por suposição;
- cada regra mapeada a componente e teste;
- telas sem redesenho: apenas os rótulos, destaques e ações que a regra exige.

As migrations são **propostas, não executadas**.

### E0 — Base única e rede de segurança

- **IDs:** GOV-002, GOV-004; prepara DEP-04 e DEP-05.
- **Mudanças:**
  - decidir a base (T1);
  - testes de caracterização da visão atual com Graph injetado (o router da Linha B já aceita dependências injetadas: `criarCourierRouter`) e e-mails sintéticos;
  - banco de teste isolado para os testes duráveis (T9);
  - contadores simples de chamadas Graph, transportadora e Gemini, sem PII, para medir as etapas seguintes.
- **Reuso:** `CourierRouterDeps`, `testDb.ts`.
- **Pré-requisitos:** T1, T2.
- **Aceite:** a suíte roda offline e sem rede externa; reproduz a saída atual para as fixtures; nenhuma mudança de comportamento.
- **Risco:** baixo.
- **Recuperação:** não se aplica (só testes e métricas).

**Acréscimos da revisão 2 a E0 (sem mudança de comportamento):**

- **Medição do caminho de carregamento:** tempo por fase com identificador de requisição; contagem de chamadas Graph, de 429 e de falhas silenciosas de anexo; contagem e duração da IA; registro de desconexão do cliente e do trabalho que continua depois dela (A5).
- **Medição da cobertura atual:** quantas mensagens e anexos ficam fora do top 60 e dos 25 anexos, para decidir A6 com dados.
- **Ambiente:** homologação com caixa controlada, a frio e a quente. Na produção, só com autorização.
- **Saída:** relatório de medição. Em seguida, decisão sobre as opções de A6, em especial a 1 (coalescer requisições em voo), que não muda o resultado.

### E1 — Transporte persistido e "Delivered sem confirmação" (amarelo, sem vermelho — entrega PARCIAL de TRN-003/AC-07)

- **IDs:** TRN-001, TRN-002, TMP-001, TMP-004, CNF-002; base de TMP-002, TMP-003, TRN-004 e TRN-006; AC-07 (parcial); CT-033, CT-035.
- **Mudanças:**
  - Persistir observações da transportadora, append-only: status normalizado (`ETIQUETA_CRIADA`, `EM_TRÂNSITO`, `EXCEÇÃO`, `DELIVERED`, `DESCONHECIDO`) com o código bruto preservado, horário do evento com offset original, instante de detecção e fonte.
  - Separar `ACTUAL_DELIVERY` de `ESTIMATED_DELIVERY` no FedEx.
  - Calcular **no servidor** a condição "Delivered sem confirmação" (Delivered observado e nenhum recebimento confirmado), com destaque amarelo no topo e as ações "Confirmar recebimento" e "Courrier ainda não chegou". A segunda vira fato, sem declarar extravio.
  - Delivered deixa de ser verde.
  - Função pura de minutos operacionais em Brasília fixo, com corte às 18h e parâmetros obrigatórios LAC-01 a LAC-05. Retorna `INDETERMINADO` enquanto não homologados. **Nenhum vermelho.**
- **Reuso:** clientes FedEx/DHL, cache e deduplicação, padrão append-only de `courier_fatos`, contexto S4, `trackingKey`.
- **Migration (proposta):** nova tabela `courier_observacoes_transporte` (org, tracking\_chave, transportadora, status\_normalizado, codigo\_bruto, evento\_em, evento\_offset, detectado\_em, fonte), append-only. Aditiva, sem backfill: observações antigas não existem.
- **Pré-requisitos:** E0; T4 (mapeamento de códigos).
- **Aceite:**
  - Delivered não muda o estado nem marca documentos (CT-033).
  - Confirmar recebimento remove a condição.
  - Horário ausente gera "limitação de cálculo" (CT-035).
  - Conversão UTC ↔ Brasília dá a mesma decisão (parte de CT-025).
  - 17h → 19h acumula só 60 minutos e 16h → 18h acumula 120, com fixtures **marcadas como não homologadas** (CT-028, CT-029).
  - 119 minutos → inelegível; 120 → mínimo atingido, sem cor (CT-026, CT-027).
- **Risco:** mapeamento de status errado gerando amarelo indevido.
- **Recuperação:** chave de exibição; a tabela é aditiva e pode ficar ociosa.

### E2 — Registro persistente do Courrier e ingestão incremental

- **IDs:** REL-001, ENT-002, ENT-003, ENT-005, ENT-006, HIS-001 (parte), HIS-003; AC-01; custo (seção 5).
- **Mudanças:**
  - Mensagens e evidências persistidas via delta do Graph, deduplicadas por id.
  - Envelope persistido por `tracking_chave`, com marco de início, documentos anunciados com evidência e cronologia.
  - Visão materializada única para Courier, Exigem Atenção e Relatórios.
  - Pesquisa histórica de envelopes fora da lista.
- **Reuso:** `getMailFolderDeltaPage`, `capturaPreAlerta`, scheduler in-process, `courierFilters`, `referenceResolver`, `extractEnvelopeDocs`.
- **Migration (proposta):** tabelas de mensagem/evidência e de envelope. Backfill **somente leitura** da caixa dentro de uma janela a definir. Os estados e conferências do JSON legado são importados como fatos com origem `legado_json` e sem autor pessoal, sem inventar histórico anterior ao último valor.
- **Pré-requisitos:** T2, T3; LAC-08 (retenção) para política final.
- **Aceite:**
  - CT-001: dois e-mails com o mesmo tracking geram um registro com as duas evidências.
  - Um envelope com mais de 60 e-mails novos depois continua visível.
  - Reprocessar a mesma mensagem não duplica.
  - Execução em **modo sombra** comparando com a visão atual.
- **Risco:** duplicação, quota do Graph, divergência entre sombra e visão atual.
- **Recuperação:** manter a visão atual como fallback até o aceite.

### E3 — Conferência, conclusão e pendência como dimensões distintas

- **IDs:** CNF-002 (no servidor), CNF-003, CNF-005, CNF-006, CNF-007, HIS-002, HIS-004, CLA-011 (durável); AC-06, AC-08; base de SOL e KPI.
- **Mudanças:**
  - Comando explícito "Concluir conferência".
  - Rótulo histórico "Concluído com divergência".
  - Pendência como objeto próprio.
  - API recusa conferência antes do recebimento.
  - Reabertura com justificativa.
  - Follow-up como fato durável.
  - Remover "Divergência resolvida — finalizar".
- **Pré-requisitos:** **LAC-15** (catálogo de estados) e E2.
- **Migration (proposta):** não reescrever `courier_fatos`. Acrescentar fatos das novas dimensões e uma projeção que leia os 5 estados antigos com mapeamento documentado: "Divergência" passa a significar conferência com ausência e pendência aberta. A Liberação continua lendo os mesmos fatos.
- **Aceite:** CT-006, CT-008; reabrir sem justificativa é recusado; um Concluído com pendência continua visível; testes de regressão da Liberação (L2, L4, G3) verdes.
- **Risco:** Liberação.
- **Recuperação:** projeção nova em paralelo; a antiga mantida até o aceite.

### E4 — Unidade documental e associação

- **IDs:** REL-004, ASS-001 a ASS-003, ASS-005 a ASS-011, ENT-004; AC-05; CT-005, CT-039, CT-040.
- **Mudanças:**
  - Documento físico (OMBL/OHBL por BL) como unidade de conferência, com vínculo N:N a IMs (sem duplicar cópia).
  - Documentos anunciados não identificados preservados.
  - Inconsistência sinalizada.
  - Correção de associação com justificativa.
  - Telex e destino **por documento**, só afirmativos, com evidência e histórico.
  - Revisar o teto de 8 com validação.
- **Pré-requisitos:** E2, E3; LAC-11 (quem corrige).
- **Aceite:** CT-005 (uma marca para MBL compartilhado); CT-040; CT-039 (resolver e restaurar com cronologia); "HBL to cnee" sozinho **não** gera telex.
- **Risco:** chaves usadas pela Liberação (referência exata do IM).
- **Recuperação:** manter as linhas por IM como projeção derivada.

### E5 — Ressalvas e documentos inesperados

- **IDs:** RES-001 a RES-008; AC-09, AC-10; CT-009, CT-010, CT-041.
- **Pré-requisitos:** E3, E4. A parte de fotos depende de T8, LAC-08 e VAL-04 e pode ficar fora desta etapa.
- **Aceite:** concluir com ressalva sem categoria, com descrição e sem foto; um inesperado sem IM não bloqueia a conclusão.
- **Risco:** baixo, pois é aditivo.

### E6 — ETA marítima e prioridade no servidor

- **IDs:** ETA-001 a ETA-004, TRN-004, TRN-005, TRN-008, CLA-010; AC-11, AC-12, AC-14, AC-24.
- **Mudanças:**
  - Usar o tracking de armador quando disponível; o ETA de e-mail fica marcado como "incerto".
  - Tabela 3/7 no servidor, substituindo o ≤ 5 do front.
  - Exception e extravio.
  - Alerta consolidado.
- **Pré-requisitos:** T5; **LAC-06** (fronteiras e rótulo) e **LAC-07** (ordem). Sem elas, implementar só a coleta e a consolidação, mostrando "priorização pendente de homologação".
- **Risco:** mudança visível em Exigem Atenção.
- **Recuperação:** chave.

### E7 — Cobranças da Clara e reuso de IA

- **IDs:** CLA-002 a CLA-006, CLA-010; AC-15, AC-16; CT-015, CT-016; custo.
- **Mudanças:**
  - Rascunho na **thread de origem** do documento.
  - Consolidação por thread.
  - Conteúdo verificável, sem "today" fixo.
  - Alternativas condicionais.
  - Cache persistido da Clara e IA só para o que o determinístico não resolveu.
  - Sem retry em 429 de cota.
- **Fora da etapa:** os relógios CLA-007, CLA-008 e CLA-012 aguardam DEP-06, LAC-09 e LAC-14.
- **Risco:** rascunho criado na caixa (efeito externo). Testes só com Graph injetado.

### E8 — Resolução de pendências e contratos com Liberação e Fila

- **IDs:** SOL-001 a SOL-008, REL-002, REL-003; AC-03, AC-04, AC-18, AC-19; CT-003, CT-004, CT-018, CT-019, CT-038.
- **Pré-requisitos:** E3, E4; T7; LAC-12/VAL-01 (só para casos ambíguos; os explícitos podem avançar); LAC-13 para SOL-007.
- **Aceite:** um tracking novo sozinho não resolve; a conferência no segundo envelope resolve a pendência original preservando a divergência; "armador não recebeu" não reabre o Courrier.

### E9 — KPIs em Gestão a partir dos fatos

- **IDs:** KPI-001 a KPI-008; AC-20, AC-21; CT-020, CT-021, CT-042.
- **Mudanças:**
  - Remover `processosLiberados`.
  - Classificações distintas: divergência, falha atribuída e falha confirmada resolvida.
  - Recálculo sem apagar fatos.
- **Pré-requisitos:** E3, E8; LAC-10 para KPI-006.
- **Risco:** números de Relatórios mudam. Comunicar e versionar a métrica.

### E10 — Escalonamento temporal completo (TRN-003)

- **IDs:** TRN-003, TMP-002, TMP-003, TRN-006, TRN-007, CLA-009, CNF-004 (responsável), AC-07 completo, AC-13, AC-23; CT-025 a CT-032, CT-034.
- **Pré-requisitos:** E1; **LAC-01 a LAC-05** homologadas (e LAC-11 para CNF-004).
- **Aceite:** todos os CT temporais com o calendário e os marcos homologados declarados na evidência.
- **Recuperação:** a cor vermelha fica atrás de chave.

## 8. Primeira etapa recomendada

**Revisão 2.** A Parte A mostra que o gargalo de carregamento **não está identificado** e que as tentativas atuais podem multiplicar trabalho, inclusive chamadas de IA. Por isso a recomendação mudou em dois pontos:

- **E0 vem primeiro e mede** (acréscimos da seção 7), sem alterar o comportamento.
- **Nenhuma otimização de carregamento é proposta antes da medição.** Isso vale em especial para qualquer redução de cobertura.

E1 continua sendo a primeira etapa funcional do Blueprint. O texto abaixo segue válido nesse enquadramento. A afirmação de que E1 "reduz chamadas externas" é uma expectativa a confirmar pela medição de E0, não um resultado.

**Recomendação: E0 seguida de E1**, como um pacote de revisão curto, *depois* de duas confirmações suas:

1. **Qual é a base de implementação (T1).** A Linha B (`busy-cori`) tem o que E1 reaproveita: fatos append-only, contexto pessoa × caixa e scheduler. A Linha A é a última confirmada em produção e tem o fallback DHL. Sem essa decisão, qualquer código novo nasce numa linha que pode ser descartada.
2. **Se o PostgreSQL de produção está disponível para o Courrier (T2).** Se não estiver, E1 precisa de outra persistência (por exemplo, o Supabase já presente na Linha A), o que muda a migration proposta.

### Por que E1 primeiro

- **Fundação funcional.** O transporte é uma das dimensões-base do capítulo 02 e hoje não tem registro algum. E1 cria a primeira trilha persistida de fatos de transporte, com instante e origem. TRN-003, TRN-004, TRN-006, ETA e os KPIs de dano dependem dela.
- **Conformidade imediata sem suposição.**
  - TRN-001 e TRN-002, TMP-001, TMP-004, CNF-002 e CT-033 e CT-035 são implementáveis e homologáveis **agora**: não dependem de LAC.
  - O cálculo das duas horas operacionais entra como função pura, com o corte de 18h fixo e os parâmetros LAC-01 a LAC-05 obrigatórios. Sem eles, devolve `INDETERMINADO`.
  - O vermelho fica para E10. **E1 sozinha é entrega parcial:** o escalonamento vermelho é obrigatório pelo Blueprint e só se completa em E10 (revisão 3, R3.4.1).
  - Isso respeita a exigência de não resolver calendário, abertura, marco ou "dia seguinte" por conta própria.
- **Reuso do que funciona.** Clientes FedEx/DHL, cache e deduplicação, padrão `courier_fatos`, S4 e `trackingKey`. Nada é reescrito.
- **Eficiência.** Persistir as observações permite parar de reconsultar envelopes já recebidos e substituir o prefetch de todos os trackings a cada abertura por consulta agendada por estado. Isso reduz chamadas externas sem perder frescor nem evidência, e dá o "instante de detecção" que LAC-03 precisa para ser decidida com dados reais.
- **Risco controlado.** A mudança é aditiva: tabela nova, condição calculada e duas ações. A Liberação não é tocada. Tudo fica atrás de chave de exibição.

### O que E0 + E1 não fazem

- Não mudam estados de envelope, conferência nem a lógica de associação.
- Não enviam nem criam rascunhos.
- Não acionam IA nova.
- Não pintam vermelho.
- Não declaram extravio.
- Não executam migration sem sua aprovação do script.

### Decisões que peço junto com a aprovação da etapa

- **T1 e T2:** respostas técnicas.
- **Lista de códigos de status por transportadora** que contam como Delivered, Exception e Etiqueta criada. Eu proponho a partir das documentações e de payloads reais anonimizados, e você valida.
- **Se o rótulo atual de "Chegada"** (que hoje mostra a entrega real do FedEx como previsão) passa a separar "Entregue em" de "Previsão". É correção de dado, sem redesenho.

Fico aguardando a revisão. Na revisão 2, nada da implementação havia sido iniciado. Na revisão 3, só o Stage 0 (medição, sem mudança de comportamento) foi implementado; nenhuma etapa funcional foi iniciada.

---

## Apêndice R3 — Resumo do cenário SINTÉTICO ponta a ponta (não é medição real)

Gerado por `npm run test:diag` sobre a Linha A (`ec52362` + `46ab6de`, limite de couriers 40 s), com dependências falsas e tempo escalado (÷20). Os tempos estão em ms nominais; o tempo de CPU real aparece multiplicado por 20.

Os atrasos foram **escolhidos para o teste**:

- busca: 12 s;
- anexo: 1 s (um lento de 12 s);
- IA: 3 s (uma de 30 s e uma com 503 seguida de nova tentativa);
- auth: 0,3 s;
- caixa fixa: 60 mensagens, 30 com anexo.

Os números abaixo refletem essas escolhas, não a produção.

```
Registros: 5 req · 5 tardio · 10 cliente

[observado/navegador] Operações /api/couriers: 1 (com dados: 1)
  tentativas por operação: 1:1
  ms até ter dados (desde a operação): p50 20820 · p90 20820 · máx 20820 (n=1)
  [junção] chamadas Graph por operação: p50 26 · p90 26 · máx 26 (n=1) · invocações de IA: p50 0 · p90 0 · máx 0 (n=1)

[observado/navegador] Operações /api/demurrage: 1 (com dados: 0)
  tentativas por operação: 4:1
  ms até ter dados (desde a operação): —
  [junção] chamadas Graph por operação: p50 104 · p90 104 · máx 104 (n=1) · invocações de IA: p50 60 · p90 60 · máx 60 (n=1)

[observado/navegador] Tentativas /api/demurrage: 4 · desfechos timeout:4 · limite 15000:4
  ms (ok): — · com outra requisição em voo: 4 · aba oculta: 0
  respostas que chegaram DEPOIS do timeout: 4 · ms após o limite: p50 27500 · p90 27740 · máx 27740 (n=4)

[observado/navegador] Tentativas /api/couriers: 1 · desfechos ok:1 · limite 40000:1
  ms (ok): p50 20820 · p90 20820 · máx 20820 (n=1) · com outra requisição em voo: 0 · aba oculta: 0
  respostas que chegaram DEPOIS do timeout: 0 · ms após o limite: —

[observado/servidor] /api/couriers: 1 req · origem relatorios:1 · status 200:1
  ms resposta: p50 20515 · p90 20515 · máx 20515 (n=1) · ms auth: p50 306 · p90 306 · máx 306 (n=1)
  1ª do processo: 0 · uptime<60s: 1 · com sobreposição: 1 · desconexões: 0
  atraso do event loop p99: p50 22 · p90 22 · máx 22 (n=1) · máx: p50 22 · p90 22 · máx 22 (n=1)
  searchLogistics: n 1 · ok 1 (vazio 0, dos quais falha engolida 0) · erro 0 · códigos — · limite do servidor 0 · terminou após o limite 0 · ms médio 12005 · máx 12005
  itemAttachment: n 25 · ok 24 (vazio 4, dos quais falha engolida 1) · erro 0 · códigos 429:1 · limite do servidor 1 · terminou após o limite 0 · ms médio 1016 · máx 1019
  anexos (mensagens): elegiveis:30 selecionados:25 puladosPorLimite:5 tentados:25 comTextoUsado:20 semTexto:3 falhas:1 limiteServidor:1 pendentesAoResponder:1
  anexos listados pelo Graph (tipo/bytes): chamadas:23 arquivo:26 item:20 referencia:0 outro:0 bytesArquivo:11900000 bytesItem:600000
  busca devolveu o máximo pedido (pode haver mais e-mails — indício, não prova): 1
  trabalho pendente ao responder: 1 · requisições com trabalho tardio: 1

[observado/servidor] /api/demurrage: 4 req · origem relatorios:4 · status 200:4
  ms resposta: p50 42430 · p90 42623 · máx 42623 (n=4) · ms auth: p50 313 · p90 318 · máx 318 (n=4)
  1ª do processo: 0 · uptime<60s: 4 · com sobreposição: 4 · desconexões: 0
  atraso do event loop p99: p50 21 · p90 23 · máx 23 (n=4) · máx: p50 21 · p90 26 · máx 26 (n=4)
  searchDemurrage: n 4 · ok 4 (vazio 0, dos quais falha engolida 0) · erro 0 · códigos — · limite do servidor 0 · terminou após o limite 0 · ms médio 12000 · máx 12002
  itemAttachment: n 100 · ok 100 (vazio 16, dos quais falha engolida 4) · erro 0 · códigos 429:4 · limite do servidor 4 · terminou após o limite 4 · ms médio 1450 · máx 12017
  claraDemurrage: n 56 · ok 52 (vazio 0, dos quais falha engolida 0) · erro 0 · códigos — · limite do servidor 4 · terminou após o limite 0 · ms médio 3135 · máx 4744
  IA (antes da resposta): invocações 60 · ok 52 · erro 4 503:4 · sem usageMetadata 0 · tokens entrada:52000 saida:2600 pensamento:0 cache:0 total:54600
  anexos (mensagens): elegiveis:120 selecionados:100 puladosPorLimite:20 tentados:100 comTextoUsado:80 semTexto:12 falhas:4 limiteServidor:4 pendentesAoResponder:0
  anexos listados pelo Graph (tipo/bytes): chamadas:96 arquivo:108 item:84 referencia:0 outro:0 bytesArquivo:49200000 bytesItem:2520000
  busca devolveu o máximo pedido (pode haver mais e-mails — indício, não prova): 4
  trabalho pendente ao responder: 8 · requisições com trabalho tardio: 4

[observado/servidor] Trabalho DEPOIS da resposta /api/couriers: 1 req · último término após a resposta: p50 3839 · p90 3839 · máx 3839 (n=1)
  itemAttachment: terminaram 1 (ok 1, erro 0) · iniciadas depois 0

[observado/servidor] Trabalho DEPOIS da resposta /api/demurrage: 4 req · último término após a resposta: p50 7995 · p90 8008 · máx 8008 (n=4)
  claraDemurrage: terminaram 4 (ok 4, erro 0) · iniciadas depois 0
  IA: invocações iniciadas depois 0 · terminaram ok 4 / erro 0 · tokens entrada:4000 saida:200 pensamento:0 cache:0 total:4200

[junção navegador×servidor] tentativas 5 · com registro do servidor 5
  timeouts no navegador 4 · servidor levou mais que o limite 4 · sem registro do servidor 0 (causa não determinável só com estes dados)
  respostas que chegaram ao navegador depois do timeout: 4
```
