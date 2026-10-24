# Proposta de integração e medição — Stage 0 (para aprovação)

> **Situação em 24/10/2026: NÃO APROVADA. Não executar.** A integração e a janela
> abaixo foram recusadas por serem desproporcionais para uma medição inicial: três
> reinícios, possível perda de sessão, `autoSync` em segundo plano e possivelmente
> centenas de chamadas de IA. O Stage 0 está encerrado e a instrumentação continua
> **desligada** no branch de revisão. Este texto fica só como registro, com as
> correções de 24/10:
>
> - 52 chamadas Graph é uma estimativa condicional, não um teto;
> - parar não cancela chamadas já despachadas;
> - esperar 10 min não confirma conclusão, e o mecanismo de expiração está descrito;
> - `autoSync` e boot do painel ficam separados da medição isolada;
> - os limites superiores não são uso típico.

22/10/2026 · **proposta**: nada foi integrado, publicado, ativado nem medido. A etapa
de instrumentação está encerrada; esta proposta não acrescenta telemetria.

Rótulos: **[código]** lido no código · **[local]** verificado localmente, sem
produção · **[relatado]** afirmado em commits ou comentários, não verificado ·
**[a conferir]** depende do painel do Render, no dia.

## 1. Linha A e compatibilidade

- **[código]** O tip da Linha A (`claude/demurrage-api-playwright-5q2lqq`) em 22/10
  continua `8e055b0` (21/10 19:16 UTC). Não há commit novo para compatibilizar.
- O branch de revisão é **linear sobre `8e055b0`**, então a integração é um
  **fast-forward**: sem merge commit e sem rebase. O SHA publicado é o mesmo que
  foi revisado e testado no CI.
- As correções recentes da Linha A (`a4096c8`: erro de promessa não derruba o
  processo; `8e055b0`: anexos sem `contentBytes`, lotes de 5) estão na base e
  seguem intactas. Os testes de equivalência comparam as rotas reais com o
  diagnóstico desligado e ligado.
- **No dia:** se a Linha A tiver avançado, **não integrar**. Fazer rebase, rodar os
  testes e pedir uma revisão nova da diferença.

## 2. Revisão proposta e commits

**Revisão:** o head de `claude/stage0-diag-relatorios-revisao` que contém este
documento. O SHA vai na mensagem de entrega e só é aprovado com o CI verde.

| Commit | Conteúdo | Código? |
|---|---|---|
| `eb857dc` | Stage 0 v2: instrumentação (desligada por padrão) | sim |
| `9e1fcaa` | correção dos testes (isolamento entre testes) | só testes |
| `ad86b57` | pacote de revisão, diagnóstico Rev3 e matriz | só `docs/` |
| `ddb831e` | corpo do envio limitado ao lido; coleta só da sessão selecionada | sim |
| head | esta proposta e a nota de substituição no pacote | só `docs/` |

**Excluídos:** `46ab6de` (Stage 0 v1) e `c0c4b9a` (procedimento v1), que estão no
branch padrão `claude/outlook-email-api-0jv8g4`. Nenhum dos dois é ancestral da
revisão. Não fazer cherry-pick nem merge deles. O que fazer com eles no branch
padrão é uma decisão separada.

**Operação, quando aprovada:**

```
git push origin <SHA>:refs/heads/claude/demurrage-api-playwright-5q2lqq
```

O push é recusado se não for fast-forward; não usar `--force`.

- **[código]** O push dispara o CI na Linha A (`ci.yml`, em qualquer push).
- **[relatado]** Pelo `render.yaml`, o serviço publica a Linha A. **[a conferir]** se
  o deploy automático está ligado no `priora-1`. Se estiver, **este push é a
  publicação**, com o diagnóstico desligado, e reinicia o serviço (seção 10).

## 3. Achado que muda o desenho: o painel pré-carrega todas as abas

**[código + local]** Ao abrir o painel (`Priora.dc.html`, qualquer aba), o shell
monta **todas** as abas: começa ~0,45 s depois e monta uma a cada 160 ms
(`warm`). Os dois logins (Priora e Microsoft) redirecionam para o painel.

Verificado num servidor local com as APIs simuladas:

| Página aberta | Chamadas de API disparadas sozinha |
|---|---|
| `/Relatorios.dc.html` (direto) | 1× `/api/couriers`, 1× `/api/demurrage` |
| `/Priora.dc.html#relatorios` (painel) | 3× `/api/couriers`, 3× `/api/demurrage`, `/api/processes`, `/api/auditoria/processos`, `/api/me`, `/api/priora/me`. Com dados reais, o Courier ainda faz a pré-busca de rastreio (FedEx/DHL). |

Consequências:

- "Uma carga da Relatórios" **dentro do painel** é o boot inteiro do painel.
- Uma carga **só da Relatórios** exige abrir `/Relatorios.dc.html` direto.
- Todo login dispara um boot do painel.

**Três categorias que nunca se somam nem se misturam:**

| Categoria | O que é | Coletada? | Pode ser lida como medição isolada da Relatórios? |
|---|---|---|---|
| Carga isolada | `/Relatorios.dc.html` aberta direto | sim | **sim**, desde que não haja sobreposição com as categorias abaixo |
| Boot do painel por login | os módulos que o painel monta depois de um login ou recarga | sim, se a sessão for a selecionada; os pedidos de outros módulos aparecem como `origem: "outra"` | **não**: é reportado à parte |
| Volta do `autoSync` | trabalho de fundo depois de cada boot do processo | **não** (fora do rastreio) | **não**. Se coincidir com uma carga isolada, essa carga passa a "não isolada" |

## 4. Sequência mínima

### Pré-condições

- Janela fora do expediente, com aviso prévio aos usuários: os reinícios podem
  deslogar todos (seção 10).
- Fora da volta semanal do watchdog (segunda, 06:00 UTC).
- **[a conferir]** `AUTO_SYNC_ENABLED`. Se estiver ligado, a 1ª volta roda 3 min
  depois de **cada** boot, com raspagem e IA fora do diagnóstico. Antes de cada
  carga, esperar a linha `[autoSync] …` de fim da volta.
- **Um** operador selecionado, **uma** aba. Outras abas e dispositivos dele
  fechados, e nenhuma outra atividade dele durante a coleta. A coleta pega todas
  as sessões desse operador.
- Os três valores da seleção já obtidos e o salt já gerado pelo operador
  (procedimento, "Como obter os três valores sem expô-los"). Nenhum deles passa
  por chat, ticket, commit ou documento.

### Passos

| # | Passo | Diagnóstico | Reinício |
|---|---|---|---|
| 0 | Integração (seção 2). | desligado | R1 |
| 1 | **Linha de base** (detalhes abaixo). | desligado | — |
| 2 | **Ativação:** um único save com as 5 variáveis. Início da janela (T0). | ligado | R2 |
| 3 | **Carga L1** (detalhes abaixo). | ligado | — |
| 4 | **Repetição controlada L2:** na mesma aba, abrir ou recarregar `/Relatorios.dc.html` (isolada nas duas variantes, se nenhuma volta do `autoSync` coincidir). Esperar a conclusão confirmada (seção 7). | ligado | — |
| 5 | **Encerramento:** 60 s sem atividade (para sair o resumo de descartes, se houver); fechar a aba; exportar os logs (seção 7); um único save removendo as 5 variáveis. Fim da janela. | desligado | R3 |

**Passo 1 — Linha de base.**

1. O operador, que já estava logado antes do R1, recarrega a página.
2. Anotar se continuou logado depois do R1. Isso decide a variante: sessão mantida
   → **A**; deslogado → **B**.
3. Se preciso, o operador entra (login → boot do painel).
4. Observar:
   - `/health` mostra o SHA integrado;
   - o painel e a Relatórios funcionam como antes;
   - nenhum `X-Priora-Diag` nas respostas de `/api/couriers` (ferramentas do
     navegador);
   - **nenhuma** linha `"diag":"relatorios.` em 10 min.
5. O operador deixa a aba em `/Relatorios.dc.html` e fica parado.
6. Esperar ≥ 10 min depois do boot antes do passo 2, para o trabalho tardio
   terminar.

**Passo 3 — Carga L1.**

- **Variante A** (sessão sobrevive): recarregar `/Relatorios.dc.html`. Carga isolada.
- **Variante B** (sessão perdida): o operador entra de novo (Priora; Microsoft se
  for pedido, com a **mesma** caixa) e cai no painel. Esse boot do painel **não é
  uma carga isolada** e é reportado à parte (seção 3). Nesta variante, a única carga
  isolada é a L2.
- Esperar a **conclusão confirmada** (seção 7): cada `relatorios.req` com pendência
  precisa do seu `relatorios.tardio` com `encerradoPorTempo: false`. Se isso não
  acontecer em 10 min, a carga fica com **trace incompleto**. Passar o tempo não
  confirma nada.

**Prazos:**

- **Janela máxima: 30 min**, do save de ativação (R2) ao save de desativação (R3).
  O esperado é 15 a 20 min.
- Se a L2 não puder começar até T0 + 20 min, ela não é feita: encerrar e
  registrar o motivo.

## 5. Tetos de chamadas externas

**[código, `8e055b0`]** A instrumentação não acrescenta chamadas.

**Por execução de rota:**

| Rota | Graph | IA (Gemini) | MSAL |
|---|---|---|---|
| `/api/couriers` | 1 busca + 0–1 caixa de entrada (só se a busca vier vazia) + ≤ 25 listagens de anexos + **I** | 0 | 1 `acquireTokenSilent` (vai à rede só se precisar renovar) |
| `/api/demurrage` | idem | ≤ 14 extrações × ≤ 2 chamadas (1 nova tentativa em erro transitório) = **≤ 28** | 1 |
| `/api/processes`, `/api/auditoria/processos` | 1 busca + 0–1 caixa de entrada | 0 | 1 |

**I** é o número de e-mails encaminhados como anexo nas ≤ 25 mensagens (1 `GET`
cada). **O código não limita I.**

- **52 chamadas Graph por execução é uma estimativa condicional, não um teto.** Vale
  só se cada mensagem tiver no máximo 1 e-mail encaminhado (I ≤ 25). Uma execução
  pode passar de 52.
- Todos os números de Graph abaixo herdam essa condição.
- Nenhum número desta seção é uso típico: são **limites superiores** tirados do
  código. O uso típico nunca foi medido.

**Tentativas do navegador:**

- Relatórios: até 3 de `/api/couriers` e até 4 de `/api/demurrage`.
- Exigem Atenção: 1 de `/api/couriers` e até 4 de `/api/demurrage`.
- Courier e Demurrage: 1 cada.

**Por carga:**

| Carga | Execuções (máx.) | Graph (estimativa condicional) | IA (limite superior) | Sem nenhuma nova tentativa do navegador (1 execução por chamada de módulo); também é limite superior, não uso típico |
|---|---|---|---|---|
| **L** — `/Relatorios.dc.html` | 3 couriers + 4 demurrage | **364** | **112** | Graph ≤ 104, IA ≤ 28 |
| **P** — boot do painel | 5 couriers + 9 demurrage + processes + auditoria | **732** | **252** | Graph ≤ 316, IA ≤ 84 |

O boot do painel faz ainda a pré-busca de rastreio do Courier: 1 `/api/tracking/:n`
por rastreio FedEx/DHL da lista, com cache. A DHL pelo site usa o navegador
remoto e consome créditos.

**Por sequência:**

| Trecho | Variante A | Variante B |
|---|---|---|
| Linha de base (desligado) | P se houver login; senão, 0 | P |
| Janela (ligado) | L + L: ≤ **728** Graph, ≤ **224** IA | P + L: ≤ **1.096** Graph, ≤ **364** IA, mais a pré-busca de rastreio |

**Fora destes tetos:** as voltas do `autoSync` depois de cada reinício (se ligado),
a atividade de outros usuários e o novo login de rotina depois do R3.

## 6. Condições de parada

Ao acontecer qualquer item abaixo, **parar e desativar na hora**, sem fazer a
próxima carga.

**Parar não cancela chamadas já despachadas.** Nem o timeout do navegador, nem o
`withTimeout` do servidor, nem a desativação ou o reinício cancelam o que já saiu
para o Graph, o Gemini, o FedEx/DHL ou o navegador remoto. O provedor pode concluir,
e cobrar, chamadas enviadas antes da parada. Parar só impede que **novas** chamadas
comecem: sem próxima carga e, depois do reinício, sem trabalho pendente no processo.

1. **Privacidade:** linha de diagnóstico com campo fora da lista documentada, ou com
   endereço, assunto, ID, token ou valor da seleção.
2. **Escopo:** mais de um par `org`/`acc` nas linhas, ou linhas chegando com o
   operador parado (outra sessão dele).
3. **Configuração:** qualquer `relatorios.config`. Nada está sendo coletado; corrigir
   fora da janela.
4. **Descartes:** `rastros_ativos_max` ou `cota_linhas_processo` em
   `relatorios.descartes`. Outros motivos não param, mas a janela vira
   **incompleta**.
5. **Recursos:** `[memoria]` acima de 400 MB, reinício, OOM ou queda.
6. **Provedores:**
   - Gemini `429 RESOURCE_EXHAUSTED` (cota);
   - 5 ou mais `503` do Gemini numa carga;
   - 5 ou mais `429` do Graph numa carga.
7. **Estimativas excedidas:** chamadas observadas (soma de `req` + `tardio`) acima
   do limite da carga (seção 5), ou execução com mais de 52 chamadas Graph. Isso
   indica que a condição I ≤ 25 não valeu.
8. **Comportamento:**
   - Relatórios ou painel diferentes da linha de base (erro novo, tela de login
     inesperada);
   - aumento de 5xx;
   - queixa de outro usuário.
9. **Tempo:** 30 min de janela.

## 7. Trabalho não concluído, exportação e análise

**Trabalho não concluído e expiração do rastro** **[código, `relatoriosDiag.ts`]:**

- O timeout do navegador e o `withTimeout` do servidor **não cancelam** chamadas.
- Uma requisição é **concluída** só quando todas as tarefas e chamadas pendentes
  terminam:
  - se não havia pendência na resposta, o `relatorios.req` já traz
    `pendentesAoResponder` zerado;
  - se havia, sai **um** `relatorios.tardio` com `encerradoPorTempo: false`.
- **Expiração:** cada rastro tem um limite de 10 min (`rastroMaxMs`) desde o início
  da requisição. A varredura dos vencidos (`varrerVencidos`) **não tem timer**: só
  roda quando a próxima requisição **selecionada** passa pelo `requireAuth`.
  - Vencido varrido com resposta já enviada: sai um `relatorios.tardio` com
    `encerradoPorTempo: true` e `pendentesNaoConcluidos`. Isso diz que o trabalho
    **não** terminou no prazo; o rastro só é liberado.
  - Vencido sem resposta enviada: só libera a memória. Se a resposta sair depois,
    vem o `relatorios.req`, mas nunca um `relatorios.tardio`.
  - Sem nova requisição selecionada, nenhum vencido é varrido. O reinício descarta
    tudo, sem linha.
- **10 min de espera não equivalem a conclusão.** A espera só limita quanto tempo se
  aguarda pela linha de conclusão.
- Contam como **trace incompleto**, nunca como "terminou":
  - requisição com pendência e sem `relatorios.tardio`;
  - `relatorios.tardio` com `encerradoPorTempo: true`.
- O reinício R3 também interrompe o processo, mas não cancela o que já foi
  despachado aos provedores (seção 6).

**Regras de leitura:**

- Janela com `relatorios.descartes` ou `relatorios.config` é **incompleta**.
- Requisição com pendência e sem `relatorios.tardio` é **trace incompleto**.
- Tentativa do navegador sem registro do servidor é **sem junção**.
- Evidência incompleta é relatada como tal, sem extrapolação.

**Exportação:**

- Quem: só a pessoa autorizada, pelo painel do Render, no mesmo dia.
- O quê: **só** as linhas `"diag":"relatorios.` do intervalo R2 → R3.
- Pico de memória, reinícios e horário do `autoSync` vão como **anotação**, não
  como linhas de log.
- Onde: local de acesso restrito. Apagar ao fim da revisão.
- Análise: `npm run diag:resumo -- arquivo.log`, aplicando as regras de leitura
  acima.

## 8. Desativação

- Um save removendo `PRIORA_DIAG_RELATORIOS`, `PRIORA_DIAG_SALT`, `PRIORA_DIAG_ORG`,
  `PRIORA_DIAG_OPERADOR` e `PRIORA_DIAG_CONTA` (R3).
- Conferir: nenhuma linha `"diag":"relatorios.` nova depois do boot e nenhum
  `X-Priora-Diag` no próximo uso normal.

## 9. Rollback

- **Nível 1:** a desativação acima. O código desligado se comporta igual ao
  anterior; os testes de equivalência cobrem isso.
- **Nível 2:**
  1. No Render, publicar de novo o deploy de `8e055b0` (rollback do painel).
  2. Na Linha A, `git revert` dos commits de código (`ddb831e`, `9e1fcaa`, `eb857dc`)
     num commit novo, sem force push, para o deploy automático não republicar a
     instrumentação.
  3. CI verde.
  4. Conferir o commit em `/health`.
- Não há migration nem estado persistido além dos logs.

## 10. Reinícios e interrupção de sessão

- O Render reinicia o serviço no deploy e **a cada save de variáveis**. São 3
  reinícios na sequência (R1, R2, R3), mais 1 se houver rollback. Por isso cada
  mudança de variáveis vai num save só.
- Cada reinício:
  - corta as requisições em curso;
  - zera a memória do diagnóstico;
  - roda o `autoSync` 3 min depois, se ligado.
- **[código]** Sessões, a conta Microsoft conectada e o cache do MSAL ficam em
  arquivos sob `DATA_DIR`.
- **[relatado]** Pelas mensagens de `a4096c8` e `8e055b0`, reinícios deslogaram
  usuários. **[a conferir]** se há disco persistente montado em `DATA_DIR`. Sem
  ele, cada reinício:
  - **desloga todos os usuários**;
  - pode exigir **reconectar a caixa Microsoft**, o que afeta todos os usuários e o
    `autoSync` até alguém reconectar.
- Os IDs da seleção (empresa e operador) não mudam com o reinício. A conta
  conectada só continua selecionada se a **mesma** caixa for reconectada.

## 11. O que esta medição não responde

- A carga com vários usuários (só o operador selecionado é coletado).
- O tempo antes do Express (proxy, fila, boot).
- As chamadas de outras rotas do painel (`/api/tracking`, `/api/processes`,
  `/api/auditoria`).
- O custo monetário: só tokens informados pelo provedor.
- A frequência em produção: uma janela, um operador, duas cargas.

## Aprovações que tinham sido pedidas (recusadas em 24/10/2026)

1. A integração por fast-forward da Linha A até o SHA informado na entrega
   (publicação com o diagnóstico desligado).
2. A janela: data e horário, operador, até 30 min, com as condições de parada
   acima.
3. A exportação e a leitura das linhas de diagnóstico pela pessoa autorizada.
