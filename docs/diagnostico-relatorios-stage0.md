# Diagnóstico do carregamento da Relatórios — Stage 0 (v2)

Instrumentação **só de medição**. Não altera limites, timeouts, retries, prompts,
modelos, regras de negócio, cobertura nem o conteúdo das respostas. Fica
**desligada** até as cinco variáveis abaixo estarem corretas, e só coleta a
**sessão selecionada**.

## Ativação e configuração

| Variável | Regra |
|---|---|
| `PRIORA_DIAG_RELATORIOS` | `on` liga; qualquer outro valor (ou ausente) desliga. Lida a cada requisição. |
| `PRIORA_DIAG_SALT` | **Obrigatório** quando ligado: dedicado, ≥ 32 caracteres, diferente de `SESSION_SECRET`. Não há fallback para constante nem para o segredo de sessão. |
| `PRIORA_DIAG_ORG` | **Obrigatório:** ID da empresa Priora selecionada. |
| `PRIORA_DIAG_OPERADOR` | **Obrigatório:** ID do usuário Priora (operador) selecionado. |
| `PRIORA_DIAG_CONTA` | **Obrigatório:** e-mail da conta Microsoft conectada (a caixa) selecionada. Comparação sem diferenciar maiúsculas. |

Com `on` e salt ou seleção inválidos, o diagnóstico fica **desligado**. Uma linha
`{"diag":"relatorios.config","erro":"<código>"}` é registrada no boot ou na
mudança de estado, só com o código: `salt_ausente`, `salt_curto`,
`salt_igual_session_secret`, `selecao_incompleta` (falta uma das três) ou
`selecao_invalida` (formato inválido). Nenhum valor é registrado. As rotas de
negócio não são afetadas.

## Quem é coletado (seleção)

Só **uma** sessão é coletada: a que cumpre as três condições ao mesmo tempo,
todas verificadas no servidor.

| Condição | De onde vem (servidor) |
|---|---|
| Empresa = `PRIORA_DIAG_ORG` | `prioraOrgId` da sessão, gravado pelo servidor no login Priora (Supabase). |
| Operador = `PRIORA_DIAG_OPERADOR` | `prioraUserId` da sessão, gravado no mesmo login. |
| Caixa = `PRIORA_DIAG_CONTA` | Conta Microsoft **conectada no servidor** (conta ativa), e o `homeAccountId` da sessão é o dessa conta. O `requireAuth` (rotas) e a rota de envio verificam também o cache do MSAL. |

- **Nenhum header ou corpo vindo do navegador** define a identidade. `X-Priora-Op`
  e `X-Priora-Attempt` são só correlação, validados por formato. Campos de
  identidade no corpo de um envio são descartados.
- **Sessões não selecionadas** se comportam como com o diagnóstico desligado:
  - nas rotas `/api/couriers` e `/api/demurrage`: sem `X-Priora-Diag`, sem rastro e
    sem linha;
  - no `POST /api/diag/relatorios`: `204` + `X-Priora-Diag: off` (a mesma resposta de
    "desligado"), nada registrado.
- Isso vale também para outro operador da **mesma empresa usando a mesma caixa**,
  para o mesmo operador em outra empresa e para qualquer sessão depois de uma troca
  da conta conectada.

### Como obter os três valores sem expô-los

1. O operador selecionado entra na Priora no próprio navegador e conecta a caixa,
   como faz normalmente.
2. Na mesma aba, abre `/api/priora/me`: `org.id` é a empresa e `user.id` é o
   operador.
3. Abre `/api/me`: `username` é o e-mail da conta Microsoft conectada.
4. Quem tem acesso ao painel do Render copia os três valores direto para as
   variáveis. **Não passam por chat, commit, ticket, documento nem log.** O
   diagnóstico nunca registra esses valores; nos registros, conta e empresa
   aparecem só como pseudônimos HMAC.

### Limitações da seleção

- **Por operador, não por aba ou dispositivo.** Todas as sessões do operador
  selecionado na mesma empresa e caixa são coletadas, inclusive outras abas
  (marcadas `origem: "outra"`) e outro navegador dele. Não há seleção por
  sessão: o identificador de sessão é segredo (não pode ir para configuração nem
  log) e muda a cada login e reinício.
- **Exige login Priora.** Sessão só com a conexão Microsoft, sem login Priora,
  nunca é coletada. O painel da Priora já exige esse login.
- **Troca da conta conectada** encerra a coleta até a seleção ser atualizada.
- **Requisições de outras sessões não aparecem**, nem como concorrência: a
  medição mostra a experiência do operador selecionado, não a carga total do
  processo. A contagem de rastros ativos do processo (`processoNoInicio`) também
  só vê o escopo selecionado.

## O que é medido

| Nível | Identificador | Origem | Conteúdo |
|---|---|---|---|
| Operação do usuário | `op` | navegador | gatilho (abrir a aba / "Tentar novamente"), recursos |
| Tentativa HTTP | `att` | navegador | nº, limite, desfecho (`ok`, `timeout`, `http_NNN`, `json_invalido`, `erro_rede`), ms, requisições em voo, aba visível, resposta que chegou depois do timeout (`tardia`) |
| Requisição no servidor | `rid` | servidor | auth, tempo até responder, status, desconexão, concorrência, cobertura, atraso/uso do event loop |
| **Tarefa** | rótulo do `withTimeout` | servidor | `searchLogistics`, `searchDemurrage`, `listInbox`, `itemAttachment` (uma mensagem), `claraDemurrage` (uma conversa): iniciadas, ok, vazias, erro, falhas engolidas, limite do servidor, terminou após o limite |
| **Chamada Graph** | tipo | servidor | `busca`, `inbox`, `anexos.lista`, `anexos.item`: iniciadas, ok, erro, códigos, máximo simultâneo por requisição |
| **Chamada de IA** | — | servidor | `iniciais` (uma por extração) × `retentativas` (dentro do geminiClient), ok, erro, códigos, latência, tokens **informados** pelo provedor (`usageMetadata`) |

**Os níveis nunca são somados.** Uma extração pendente aparece como 1 tarefa
`claraDemurrage` **e** como 1 chamada de IA pendente: é o mesmo trabalho visto
em dois níveis. `pendentesAoResponder` traz `{ tarefas: {…}, chamadasGraph,
chamadasIa }`, sem total.

Registros (uma linha JSON cada):

- `relatorios.req`: ao responder;
- `relatorios.tardio`: trabalho que terminou depois da resposta, ou rastro encerrado após 10 min;
- `relatorios.cliente`: eventos do navegador;
- `relatorios.descartes`: resumo, no máximo um por minuto, do que foi descartado por limite;
- `relatorios.config`: configuração inválida.

### Observado × inferido

| Afirmação | Tipo |
|---|---|
| Tentativa estourou o limite do navegador; resposta chegou N ms depois | observado (navegador) |
| Servidor levou X ms; tarefa estourou o limite; chamada terminou depois da resposta | observado (servidor) |
| Mais de 5 chamadas Graph simultâneas apesar do lote de 5 | observado (`graphMaxSimultaneas`) |
| Tokens por chamada | informado pelo provedor; sem `usageMetadata` conta em `semUso`, nunca estimado |
| Graph indicou mais resultados que o `top` | sinal do provedor (`buscaTemMais`/`inboxTemMais`) |
| "Busca devolveu o máximo pedido" | indício de truncamento, não prova |
| Tamanho dos anexos | **declarado** no metadado (`size`); a listagem não baixa conteúdo |
| Tempo antes do Express (proxy, fila, boot) | **não medido** |
| Causa de um timeout sem registro do servidor | **indeterminada** (não chegou, não terminou, sem login ou diagnóstico desligado) |
| Atraso do event loop explicando lentidão | inferência; o atraso em si é observado |

O timeout da Relatórios (`Promise.race`) **não cancela** o `fetch`. Cancelar no
navegador não prova que o servidor ou o provedor pararam. `desconexao` só aparece
quando a conexão fecha de fato. O trabalho que seguiu aparece em
`relatorios.tardio`.

## Autenticação, isolamento e privacidade

- **Requisições:** só viram registro depois do `requireAuth` e só da sessão
  selecionada (seção anterior). Sem login ou fora da seleção, não há linha nem header
  `X-Priora-Diag`.
- **`POST /api/diag/relatorios`:** exige sessão com `homeAccountId` igual ao da conta
  Microsoft **ativa** e presente no cache do MSAL, como o `requireAuth`, mas sem renovar
  token. Se não confere: `403`, nada registrado. Sessão válida fora da seleção: `204` +
  `off`, nada registrado. A rota nunca responde `401` (o shell abriria o login).
- **Escopo:** a empresa Priora e a conta da sessão selecionada. Concorrência, limites e
  junção navegador × servidor ficam dentro dele.
- **IDs do navegador (`op`, `att`):** dados de correlação **não confiáveis**. São
  validados por formato e nunca usados como identidade ou autorização.
- **Conteúdo:** nunca registra corpo/assunto, conteúdo ou nome de anexo, IDs de
  mensagem/conversa/anexo, endereços, tokens ou credenciais. Conta e organização viram
  HMAC-SHA256 (16 hex) com o salt dedicado.

## Limites explícitos (`LIMITES_DIAG`)

| Limite | Valor | Ao exceder |
|---|---|---|
| Corpo de um envio do navegador | 16 KB **lidos** | lido por um parser JSON só desta rota, antes do parser global: `Content-Length` acima de 16 KB → `413` sem ler; sem `Content-Length` → `411`; com `Content-Encoding` (gzip, deflate, br…) ou sem `Content-Type: application/json` → `415`; JSON malformado → `400`. Nada é descomprimido, então o corpo interpretado nunca passa de 16 KB. As demais rotas seguem com o parser global (100 KB, aceita gzip/deflate). |
| Eventos por envio | 20 | excedente descartado e contado |
| Envios por organização+conta por minuto | 30 | `429` + `X-Priora-Diag: off` (o navegador para) |
| Eventos por organização+conta por minuto | 120 | descartados e contados |
| Eventos por organização+conta+operação | 60 | descartados e contados (2.000 operações lembradas) |
| Linhas de diagnóstico por minuto no processo | 600 | descartadas e contadas |
| Resumo de descartes | 1 linha por janela de 60 s | — |
| Rastros ativos no processo | 500 | excedentes não são rastreados |
| Rastro sem conclusão | 10 min | encerrado e liberado (`encerradoPorTempo`) |
| Navegador: log local / fila / envios por página | 100 / 20 / 40 | mais antigos saem; ao atingir 40, para |

## O que permanece com o diagnóstico DESLIGADO

**Servidor:**

- O middleware dos dois routers lê a variável e chama `next()`.
- `diagAutenticado` lê o contexto vazio.
- Observadores devolvem a própria promessa; coberturas não são calculadas.
- Nenhum timer, header ou linha. A rota `POST /api/diag/relatorios` segue montada:
  - verifica a sessão;
  - responde `403` sem sessão válida;
  - com sessão válida, responde `204` + `X-Priora-Diag: off`.
- O leitor de corpo da rota de envio (`411`/`413`/`415`/`400`, até 16 KB) roda antes
  do parser global, também desligado.
- Se o diagnóstico tiver sido ligado uma vez, o rastreamento de contexto assíncrono do
  Node (AsyncLocalStorage) continua ativo até o processo reiniciar.

**Navegador:**

- Até a **primeira** resposta da Relatórios, o estado é desconhecido. Nesse intervalo
  geram-se IDs, vão 2 headers e até 20 eventos ficam na memória.
- A partir de uma resposta sem `X-Priora-Diag: on`, o estado vira desligado:
  - sem IDs, headers, eventos ou envios;
  - a fila é limpa;
  - resta só a leitura desse header nas respostas seguintes, para religar se o
    servidor voltar a ligar.
- Uma página aberta para de enviar:
  - na próxima resposta sem o header;
  - ou no primeiro envio recusado (`403`, `429`, `off`, erro de rede).

## Falhas da telemetria

Toda falha interna é engolida:

- no navegador, o rastreador inerte nunca lança;
- no servidor, há `try/catch` em cada ponto, e `next()` é chamado exatamente uma vez.

Os testes injetam falhas em cada ponto e comparam com a execução desligada. Ficam
iguais: a resposta, as chamadas ao Graph e à IA e o comportamento da tela.

## Procedimento de medição real (exige decisão e autorização separadas)

Nada disto foi executado. A duração da janela **não está definida**: é decisão sua
depois da revisão.

1. **Commit:** o commit de revisão aprovado, aplicado ao tip da Linha A da data. Se a
   Linha A tiver avançado, revisar a diferença antes. Confirmar em `/health` o commit
   no ar.
2. **Linha de base:** publicar com o diagnóstico desligado e observar um intervalo sem
   linhas `"diag":"relatorios.`. Isso valida o caminho desligado em produção.
3. **Ativação** (Render → Environment):
   - obter os três valores da seleção como em "Como obter os três valores sem
     expô-los";
   - criar `PRIORA_DIAG_ORG`, `PRIORA_DIAG_OPERADOR` e `PRIORA_DIAG_CONTA` com esses
     valores;
   - criar `PRIORA_DIAG_SALT`, gerado pelo operador, sem passar por chat, commit ou
     ticket;
   - criar `PRIORA_DIAG_RELATORIOS=on`;
   - salvar. Normalmente reinicia o serviço e desloga os usuários (sessões em disco
     temporário); confirmar no painel. Depois do reinício, o operador entra de novo
     na Priora e reconecta a caixa, se for pedido. Os IDs de empresa e operador não
     mudam com o reinício.
   - Se aparecer `relatorios.config`, o salt ou a seleção estão inválidos e nada é
     coletado.
   - Conferir a seleção: o operador abre a Relatórios e vê `X-Priora-Diag: on` nas
     respostas de `/api/couriers` (ferramentas do navegador). Outro usuário da mesma
     caixa, se houver, **não** deve ver esse header.
4. **Ações:** um operador autorizado, com a própria caixa:
   - A (a frio);
   - B (a quente, repetido);
   - C (Relatórios com Courrier);
   - D ("Tentar novamente", se aparecer);
   - E (aba oculta, opcional).

   A aba Courrier, no cenário C, também consulta rastreio FedEx/DHL, que não é medido.
5. **Chamadas esperadas** (tetos pelo código; o típico é o que se mede):
   - Graph: até ~52 por execução (1 busca, 0–1 inbox, até 25 listagens, 1 `GET` por
     e-mail encaminhado);
   - IA: até 28 por execução de `/api/demurrage`;
   - a instrumentação **não acrescenta** chamadas ao Graph nem à IA.
6. **Condições de parada:**
   - qualquer linha com dado fora da lista;
   - `[memoria]` acima de 400 MB, reinício ou OOM;
   - teto de gastos do Gemini, ou rajadas de 429/503;
   - comportamento da Relatórios diferente do de antes;
   - linhas de outro escopo de conta;
   - aumento de 5xx em relação à linha de base;
   - fim do tempo decidido.
7. **Logs:**
   - quem acessa: só a pessoa autorizada, pelo painel (as linhas são só do
     operador selecionado);
   - o que exportar: só as linhas `"diag":"relatorios.` do intervalo, no mesmo dia (a
     retenção do Render depende do plano);
   - onde guardar: local de acesso restrito;
   - quando apagar: ao fim da revisão;
   - como analisar: `npm run diag:resumo -- arquivo.log` (ou `--json`).
8. **Desativação:**
   - remover as cinco variáveis (`PRIORA_DIAG_RELATORIOS`, `PRIORA_DIAG_SALT`,
     `PRIORA_DIAG_ORG`, `PRIORA_DIAG_OPERADOR`, `PRIORA_DIAG_CONTA`) e salvar
     (reinício). Remover só `PRIORA_DIAG_RELATORIOS` já desliga a coleta; as outras
     saem para não deixar a seleção guardada;
   - as páginas abertas param sozinhas na próxima resposta;
   - abrir a Relatórios e confirmar a ausência de `X-Priora-Diag` e de linhas novas.
9. **Rollback:**
   - nível 1: a desativação acima;
   - nível 2: redeploy do commit anterior (Render) ou `git revert` na Linha A → CI →
     deploy, confirmando em `/health`.

   Sem migration nem estado persistido além dos logs. Cada reinício pode deslogar
   usuários (sessões em disco temporário), então avisar antes.

## O que continua sem medição

- Tempo de boot ou fila antes do Express; só `uptimeS` e `primeiraDoProcesso` indicam.
- Se o MSAL renovou o token pela rede ou usou cache.
- Bytes efetivamente trafegados (só o tamanho declarado dos anexos).
- Renderização após os dados chegarem.
- Desfechos `401`: não são registrados no servidor (sem login) e ficam só no log local
  da página.
- Eventos perdidos se a página fechar antes do envio.
- Custo monetário da IA (sem base de preço verificada; só tokens).
- Chamadas FedEx/DHL de outras abas.

## Testes

`npm run diag:selftest` é isolado:

- Graph, MSAL, conta conectada e Gemini falsos;
- rede bloqueada fora de 127.0.0.1;
- diretório temporário.

Cobre também a seleção e o corpo do envio:

- duas sessões na mesma empresa e na mesma caixa, só o operador selecionado coletado;
- mesmo operador em outra empresa e troca da conta conectada, sem coleta;
- headers e corpo forjados pelo navegador, sem efeito na identidade;
- corpo grande, sem tamanho, comprimido (gzip, deflate, br), não JSON e malformado,
  todos recusados; envio válido aceito;
- parser global das rotas de negócio inalterado;
- rotas reais com o diagnóstico ligado para uma sessão **não** selecionada: mesma
  resposta e mesmas chamadas que desligado, sem header e sem linha.

Variáveis opcionais:

- `RELATORIOS_HTML_ORIGINAL=<arquivo>`: compara a página com uma cópia sem
  instrumentação (desligado, ligado, com falhas injetadas e com recusas);
- `DIAG_CARGA=1`: mede overhead sob concorrência (desligado × ligado ×
  histograma por requisição).
