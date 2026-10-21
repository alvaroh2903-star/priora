# Diagnóstico do carregamento da Relatórios — Stage 0

Instrumentação **só de medição**. Não altera limites, timeouts, retries, prompts,
modelos, regras de negócio nem o conteúdo das respostas. Fica **desligada** até
alguém definir `PRIORA_DIAG_RELATORIOS=on` no ambiente.

## O que é medido

Três níveis, cada um com identificador opaco próprio:

| Nível | ID | Onde nasce | O que registra |
|---|---|---|---|
| Operação do usuário | `op` | navegador (abrir a aba; "Tentar novamente") | gatilho, recursos pedidos |
| Tentativa HTTP | `att` | navegador (cada `fetch`) | nº da tentativa, limite, desfecho (`ok`, `timeout`, `http_NNN`, `json_invalido`, `erro_rede`), ms, requisições em voo, aba visível, resposta que chegou depois do timeout (`tardia`) |
| Processamento | `rid` | servidor (cada `GET /api/couriers` e `GET /api/demurrage`) | auth, tempo até responder, status, desconexão do cliente, chamadas externas, IA, cobertura, concorrência, trabalho que seguiu depois da resposta |

Registros (uma linha JSON no stdout cada):

- `relatorios.req` — ao responder. Campos principais: `ms.auth`, `ms.resposta`,
  `status`, `desconexao`, `externas.<rótulo>` (rótulos do `withTimeout`:
  `searchLogistics`, `searchDemurrage`, `listInbox`, `itemAttachment`,
  `claraDemurrage` — com `n`, `ok`, `vazio`, `erro`, `silenciadas`, `limite`,
  `aposLimite`, `ms`, `msMax`, `status`), `ia` (invocações ao provedor,
  latência, códigos de erro, tokens do `usageMetadata`), `cobertura`, `anexos`,
  `listagemAnexos`, `emVoo`, `sobreposicoes`, `uptimeS`, `primeiraDoProcesso`,
  `loop` (atraso do event loop), `pendentesAoResponder`.
- `relatorios.tardio` — quando termina o trabalho que seguiu **depois** da
  resposta (chamadas do Graph ou da IA que estouraram o limite do servidor).
- `relatorios.cliente` — eventos enviados pelo navegador
  (`POST /api/diag/relatorios`, via `sendBeacon`, só quando o servidor
  responde com `X-Priora-Diag: on`).

### Observado × inferido

| Afirmação | Tipo |
|---|---|
| Tentativa estourou o limite do navegador; resposta chegou N ms depois | observado (navegador) |
| Servidor levou X ms; chamada externa estourou o limite; terminou depois | observado (servidor) |
| Requisições da mesma conta processadas ao mesmo tempo | observado (servidor) |
| Tokens por invocação | informado pelo provedor (`usageMetadata`); sem `usageMetadata` conta em `semUso` |
| Graph indicou mais resultados que o `top` (`buscaTemMais`) | sinal do provedor (`@odata.nextLink`) |
| "Busca devolveu o máximo pedido" | indício de truncamento, **não** prova |
| Tempo entre o clique e a chegada no Express (proxy, fila, cold start) | **não medido**: só a diferença entre o tempo do navegador e o do servidor, que mistura rede, proxy e fila |
| Causa de um timeout sem registro do servidor | **indeterminada** (não chegou, não terminou, ou o diagnóstico estava desligado) |
| Atraso do event loop explicando a lentidão | inferência; o atraso em si é observado |

Cancelamento: o timeout da Relatórios (`Promise.race`) **não cancela** o
`fetch`; a conexão fica aberta e o servidor segue. `desconexao` só aparece
quando a conexão fecha de fato (aba fechada, rede caiu). Um timeout do
navegador **não** é evidência de que o servidor ou o provedor pararam.

## Privacidade

- Nunca registra corpo/assunto de e-mail, conteúdo ou nome de anexo, IDs de
  mensagem/conversa, números de processo/contêiner/tracking, endereços, tokens
  ou credenciais. Só contagens, durações, códigos de status e IDs aleatórios.
- Conta e organização viram pseudônimos `HMAC-SHA256` (16 hex) com a chave
  `PRIORA_DIAG_SALT` (ou `SESSION_SECRET`). Organização: `prioraOrgId` da
  sessão quando existir; senão o tenant do `homeAccountId`.
- Concorrência (`emVoo`, `sobreposicoes`) é contada **por conta**. O único
  agregado entre contas é `emVooProcesso` (um número, sem identificação).
- Eventos do navegador passam por lista fechada de campos (zod); a conta vem da
  sessão, nunca do navegador.

## Procedimento de medição real (ambiente autorizado)

Requer autorização explícita para: publicar o commit no ambiente, ligar a
variável e ler os logs. Nada disto foi feito no Stage 0.

1. Publicar o commit da instrumentação na linha que roda em produção
   (`git cherry-pick <commit>` — verificado sem conflito sobre `ec52362`) e
   confirmar em `/health` o commit no ar.
2. Definir `PRIORA_DIAG_RELATORIOS=on` e um `PRIORA_DIAG_SALT` aleatório
   (32+ caracteres) no ambiente. O salt mantém os pseudônimos estáveis entre
   reinícios.
3. Executar, com a conta Microsoft autorizada, cada cenário algumas vezes
   (registrar data/hora de cada execução):
   - A. Primeira abertura da Relatórios após reinício ou inatividade.
   - B. Reabertura logo em seguida (recarregar a página).
   - C. Relatórios aberta junto com Courrier, Demurrage ou Exigem Atenção.
   - D. "Tentar novamente", quando aparecer.
   - E. Trocar de aba do navegador durante o carregamento (registra `visivel`).
4. Exportar os logs do período e filtrar as linhas com `"diag":"relatorios.`.
5. `npm run diag:resumo -- logs.txt` (texto) ou `-- logs.txt --json`.
   No navegador, `window.__prioraDiag.log` mostra os eventos locais.
6. Desligar: remover `PRIORA_DIAG_RELATORIOS` (efeito imediato, lido a cada
   requisição).

## O que continua sem medição mesmo com a instrumentação

- Tempo de boot/fila do host antes do Express (cold start): só `uptimeS` e
  `primeiraDoProcesso` indicam que o processo acabou de subir.
- Se o MSAL renovou o token pela rede ou usou cache (só a duração de `auth`).
- Tamanho em bytes das respostas de busca do Graph (só o dos anexos listados,
  pelo campo `size`).
- Tempo de renderização após os dados chegarem.
- Custo monetário da IA (não há base de preço verificada; só tokens).
- Eventos do navegador perdidos se a página fechar antes do envio.

## Overhead

- Desligado: o middleware chama `next()`; observadores devolvem a própria
  promessa; coberturas não são calculadas (função adiada).
- Ligado: ~1–3 µs por chamada observada (medido em teste), um histograma de
  event loop (timer de 20 ms) por requisição ativa, duas linhas JSON por
  requisição no máximo.
- Navegador: dois headers (~60 bytes) por `fetch`, buffer de até 200 eventos e,
  só com o servidor ligado, um `sendBeacon` por tentativa.

## Testes

`npm run test:diag` (isolado: Graph/MSAL/Gemini falsos, rede bloqueada fora de
127.0.0.1, diretório temporário). `RELATORIOS_HTML_ORIGINAL=<arquivo>` compara o
comportamento da página com uma cópia sem instrumentação.
