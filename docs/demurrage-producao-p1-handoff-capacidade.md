# Produção P1 — Entrega 1: controle de capacidade da rota HTTP do handoff

**Status: AGUARDANDO REVISÃO.** Adição estreita à Entrega 1 (congelada),
autorizada explicitamente pelo usuário. Não declara nada congelado.

**Baseline:** branch `claude/practical-cerf-mnz7oj`, HEAD `b220ff0` (backend
da Produção P1 concluído e congelado). Esta adição toca só a rota HTTP do
handoff: um middleware novo entre a autenticação e o processamento, uma
migration aditiva (`0047`) e testes. **Nenhum arquivo de frontend, nenhum
arquivo-fonte das Entregas 2 e 3, nenhuma mudança no contrato assinado
(payload, cabeçalhos, string canônica, HMAC).** Nada da integração da
Liberação, de tarifas ou de outra frente foi iniciado.

| Item | Decisão |
|---|---|
| Ponto de inserção | Middleware da rota `POST /` (a que entra no processamento), **depois** da autenticação HMAC completa (credencial, assinatura, timestamp, nonce) e **antes** do parse do corpo, da reivindicação de idempotência e do serviço |
| Algoritmo | Balde de fichas (token bucket) com reposição contínua, calculado **dentro do PostgreSQL** com o relógio do banco |
| Dimensões | Por credencial (60/min, rajada 10) e por organização somando as credenciais (120/min, rajada 20) — padrões configuráveis |
| Estado | Uma linha por credencial e uma por organização (migration `0047`); nenhum histórico de requisições |
| Atomicidade | Uma chamada de função = uma transação curta; organização travada antes da credencial; admite só se as duas têm ficha; recusa não consome nenhuma |
| Recusa | `429`, `Retry-After` em segundos inteiros arredondados para cima, corpo exato `{"error":"limite_temporario"}` |
| Falha do controle | A mesma resposta genérica de falha inesperada da rota (`500 {"resultado":"FALHA","detalhe":{"motivo":…}}`), sem processar o handoff |

---

## 1. Diagnóstico (antes da edição)

### 1.1 Rota

`POST /api/integracoes/demurrage/handoff/processos`, montada em
`src/index.ts:38` **antes** do `express.json()` global (o router tem o
próprio `express.raw()`, porque a assinatura cobre os bytes exatos do
corpo). Router em `src/routes/demurrageHandoffRoutes.ts`.

### 1.2 Ordem da cadeia (em `b220ff0`)

1. `express.raw({ type: '*/*', limit: '1mb' })` e cópia dos bytes para `req.corpoBruto`.
2. `criarAutenticarHandoffHttp` (`handoff/autenticacaoHttp.ts`):
   1. `organizationId` em query/cabeçalho → `400 parametro_nao_aceito` (sem consulta ao banco);
   2. cabeçalhos ausentes → `401 falha_autenticacao`;
   3. `SELECT` da credencial (`buscarCredencialParaVerificacao`; inexistente/desabilitada → 401);
   4. HMAC-SHA256 em tempo constante sobre a string canônica (→ 401);
   5. tolerância do timestamp (→ 401);
   6. `INSERT` do nonce em `demurrage_handoff_nonces` (repetido → 401);
   7. preenche `req.contextoHandoff = { organizationId, credencialIdentidade }` — **a organização vem sempre da credencial**, nunca da requisição.
3. Handler `POST /`: `JSON.parse` do corpo (→ `400 JSON_INVALIDO`) e `processarEventoHandoff`:
   1. `validarEntradaHandoff` (→ `400 CONTRATO_INVALIDO`);
   2. **reivindicação de idempotência**: `INSERT … ON CONFLICT DO NOTHING` em `demurrage_handoff_eventos` (`registrarOuRecuperarEvento`);
   3. replay / conflito / vínculo do processo e aplicação D10 (transações próprias do serviço, inclusive a conexão dedicada do lock de vínculo).

### 1.3 Fronteiras de transação

Cada passo da autenticação é um comando autocommit no pool. A reivindicação
de idempotência é um `INSERT` autocommit. As transações de negócio ficam
inteiramente dentro do serviço (`resolverVinculoProcesso` e o D10). Não há
transação aberta atravessando middlewares.

### 1.4 Mapeamento de erros existente

- Autenticação: `401 {"error":"falha_autenticacao"}` genérico; `400 parametro_nao_aceito`.
- Contrato: `400 CONTRATO_INVALIDO` / `JSON_INVALIDO`.
- Erro inesperado (achado #3 da v1.1 da Entrega 1): `500 {"resultado":"FALHA","detalhe":{"motivo":<código fechado>}}`, com o código vindo de `classificarFalhaHandoff` (só SQLSTATE/classe do erro, nunca `.message`) e log `[demurrage-handoff] erro inesperado ao processar evento: <código>`.

### 1.5 Padrões PostgreSQL reaproveitados

- Contadores/claims atômicos com `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` (mesmo padrão do vínculo de processo e do fencing do scheduler).
- Chave composta `(id, organization_id)` como alvo de FK para impedir, **no banco**, vínculo entre organizações (padrão de `containers_id_org_unique`/`processos_id_org_unique`).
- Trigger `organization_id_immutable` com `forbid_organization_change()` (migrations anteriores).
- `set_config('lock_timeout', …, true)` local à transação.

### 1.6 Logs e métricas existentes

Não existe framework de métricas no repositório. A convenção (ex.:
`src/demurrage-engine/scheduler/schedulerBootstrap.ts`) é: contadores
simples em memória por instância + linhas de log com prefixo
(`[demurrage-handoff] …`) e pares `chave=valor`, nunca o erro bruto. Foi a
convenção seguida (§8).

### 1.7 Testes da Entrega 1 que exercitam a rota

`handoffProducaoP1.test.ts` (23), `handoffProducaoP1V11.test.ts` (19),
`handoffVinculoTransacaoV12.test.ts` (15) e
`handoffVinculoConcorrenciaV13.test.ts` (3) — 60 testes. Os dois primeiros
montam o router real com `criarDemurrageHandoffRouter()` **sem
configuração injetada**, ou seja, com o controle de capacidade ativo nos
padrões (60/10, 120/20). **Nenhum desses arquivos foi alterado**; os 60
continuam passando (§10.2).

---

## 2. Ponto de inserção

```
express.raw → corpoBruto → autenticação HMAC (credencial, assinatura, timestamp, nonce)
            → [NOVO] controle de capacidade
            → parse JSON → validarEntradaHandoff → reivindicação de idempotência → negócio
```

Em `src/routes/demurrageHandoffRoutes.ts`: o controle é o primeiro
handler da própria rota de processamento —
`router.post('/', criarControleCapacidadeHandoff({ pool, config }), <handler existente>)` —
depois de `router.use(criarAutenticarHandoffHttp(deps))`. O corpo do
handler existente não mudou. É o menor ponto que cumpre as quatro
condições:

1. **autenticou** — só chega aqui quem passou por todos os passos de §1.2.2;
2. **identificou** credencial e organização — `req.contextoHandoff`, preenchido só pela autenticação;
3. **decide a capacidade**;
4. **só então** entra no parse, na idempotência e no negócio.

Consequências deliberadas:

- Requisição recusada na autenticação (inclusive nonce repetido) **nunca
  chega** ao controle: não cria nem altera estado de capacidade. Um
  atacante que capture uma requisição assinada e a reenvie dentro da janela
  de tolerância recebe 401 pelo nonce e **não consegue drenar** a
  capacidade da credencial legítima.
- O nonce de uma requisição recusada com 429 **já foi gravado** (faz parte
  da autenticação, que precede a decisão). A retentativa é, como qualquer
  requisição do contrato, uma nova assinatura com novo nonce e timestamp;
  o **mesmo `origemEventoId`** continua valendo, porque o 429 não criou
  registro de idempotência.
- O caminho in-process (`processarEventoHandoff` chamado diretamente, ex.:
  `CREDENCIAL_IDENTIDADE_INTERNA`) **não passa pela rota** e não é limitado:
  o controle protege a exposição HTTP, não o serviço.
- Por estar na rota `POST /` (e não num `router.use`), uma requisição
  autenticada que não casa com ela (ex.: `GET` assinado) segue o
  comportamento de antes (sai do router, 404) e **não consome** tentativa.
- O contrato assinado não muda: nenhum cabeçalho, campo ou byte da string
  canônica foi alterado.

---

## 3. Algoritmo de capacidade

### 3.1 Fórmula

Balde de fichas com reposição contínua, um balde por credencial e um por
organização, calculado pela função `demurrage_handoff_capacidade_admitir`
(migration `0047`). `agora` é o relógio do PostgreSQL
(`clock_timestamp()`, lido **depois** de obter os dois locks).

```
taxa (fichas/s)       = limite_por_minuto / 60
fichas_agora          = trunc(least(rajada, fichas_salvas + max(0, segundos(agora − atualizado_em)) × taxa), 6)
admite                ⇔ fichas_agora(credencial) ≥ 1  E  fichas_agora(organização) ≥ 1
  se admite           → as DUAS perdem exatamente 1 ficha
  se recusa           → NENHUMA perde ficha (só a reposição já acumulada é materializada)
espera(dimensão)      = (1 − fichas_agora) / taxa + max(0, segundos(atualizado_em − agora))
                        — só para a dimensão que recusou; a 2ª parcela só é > 0 se o relógio
                          do banco recuou (a reposição só recomeça em atualizado_em)
Retry-After           = max(1, ceil(max(espera_credencial, espera_organização)))
próximo permitido em  = agora + max(espera) segundos
dimensão informada    = a de maior espera (empate → credencial)
```

### 3.2 Arredondamento

- **Fichas: `trunc(…, 6)`** — para baixo na 6ª casa decimal (`NUMERIC(14,6)`).
  Nunca concede fração além do que o tempo decorrido justifica; a perda
  máxima é de 10⁻⁶ ficha por cálculo.
- **`Retry-After`: `ceil`, mínimo 1** — segundos inteiros, sempre para
  cima: esperar `Retry-After` segundos nunca é cedo demais para a dimensão
  que recusou (desde que nada mais a consuma nesse intervalo — §7).
- `max(0, …)` no tempo decorrido: um `atualizado_em` no futuro (relógio do
  banco recuando) nunca produz reposição negativa; `atualizado_em` só
  avança (`greatest(atualizado_em, agora)`). Nesse caso a espera soma a
  diferença até `atualizado_em`, para o `Retry-After` não ser cedo demais.

### 3.3 Baldes novos e rotação

- Balde novo nasce **cheio** (= rajada) no primeiro uso autenticado.
- **Rotação do segredo** (`rotacionarCredencial` mantém o `id` e grava
  `rotacionada_em`): a função compara `coalesce(rotacionada_em, criado_em)`
  com `geracao_credencial` do balde; se a lida é **posterior** à gravada, o
  balde **da credencial** recomeça cheio e independente (a mesma linha é
  reiniciada — continua uma linha por credencial). O balde **da
  organização** não é tocado: o limite da organização continua
  compartilhado e contínuo através da rotação.
- A geração é lida **depois** do lock da organização (que serializa todo
  escritor do balde da credencial) e só avança
  (`greatest(gravada, lida)`). Uma requisição que já esperava o lock
  durante a rotação não reinicia o balde novo uma segunda vez nem devolve a
  geração antiga (achado SQLC-1 da revisão, §10.1; teste `#18b`).

### 3.4 Garantias (o que "60 por minuto, rajada 10" significa aqui)

Com os padrões (credencial: taxa 1 ficha/s, capacidade 10; organização:
taxa 2 fichas/s, capacidade 20). Os itens marcados **[teste]** são
provados por teste com os limites padrão (`#20b`) ou sob concorrência
(`#7`, `#8`, `#8b`); os marcados **[fórmula]** são derivados da fórmula
de §3.1 (corretos, mas não medidos numa janela real de 60 s).

- **Rajada [teste]:** no máximo 10 admissões seguidas por credencial (20 por organização).
- **Reposição [teste]:** 1 ficha/s por credencial, 2 fichas/s por organização, nunca acima da rajada; com os padrões, toda recusa traz `Retry-After: 1`.
- **Ritmo sustentado [fórmula]:** em média, nunca mais que 60/min por credencial e 120/min por organização; o excedente em relação a essa média nunca passa da rajada, em janela de qualquer tamanho.
- **Janela de T segundos [fórmula]:** admite no máximo `⌊f₀ + taxa × T⌋`, onde `f₀ ∈ [0, rajada]` são as fichas no início da janela. Numa janela de 60 s, a contagem passa de 60/120 sempre que `f₀ ≥ 1` — isto é, sempre que o tráfego anterior esteve abaixo da taxa (ociosidade de ≥ 1 s ou qualquer ritmo menor que 1/s) — e chega a **70/140** quando `f₀` = rajada (69/139 numa janela semiaberta). Só fica em 60/120 enquanto o tráfego mantém o balde vazio.
- **Por geração da credencial:** o limite da credencial vale por geração — uma rotação começa um balde cheio novo (é o pedido: "rotação cria capacidade de credencial independente"). O limite da organização continua valendo através das rotações.
- **Concorrência / múltiplas instâncias [teste]:** nunca mais admissões do que os baldes permitem — estado único no banco, cada decisão sob lock das duas linhas (§6).

> **Ponto para decisão do usuário (interpretação da política).** O token
> bucket com capacidade = rajada e reposição = limite/60 por segundo é a
> realização padrão de "N por minuto com rajada B" e é o modelo pedido
> ("token bucket ou equivalente com reposição contínua"). Ele **não** é um
> teto estrito de 60/120 em toda janela deslizante de 60 s (pior caso
> 70/140, acima). Nenhum balde de fichas — nem combinação de baldes —
> consegue ao mesmo tempo rajada 10, ritmo sustentado de 60/min e teto
> estrito de 60 em toda janela. Opções, se a revisão quiser o teto estrito:
>
> - **(a) Só configuração:** `…_POR_MINUTO = limite − rajada` (ex.: 50 com
>   rajada 10; 100 com rajada 20) → no máximo 60/120 em qualquer janela,
>   mas o ritmo sustentado cai para 50/100 por minuto (um cliente constante
>   de 1/s teria ~1 em 6 requisições recusadas) e "POR_MINUTO" deixa de
>   significar "aceitas por minuto".
> - **(b) Registro limitado de admissões:** na mesma função, guardar as
>   últimas N admissões de cada balde (N = limite: 60/120 carimbos por
>   linha, ~0,5–1 KB) e exigir também "menos de N nos últimos 60 s", junto
>   com o balde atual para a rajada → teto estrito, ritmo 60/120 e rajada
>   10/20 ao mesmo tempo; uma linha por credencial/organização, transação
>   curta. Exige baixar o máximo configurável (hoje 1.000.000).
>
> Nenhuma das duas foi aplicada sem decisão explícita.

---

## 4. Schema (migration `0047_handoff_controle_capacidade.sql`)

Aditiva: 0001–0046 intocadas, nenhuma linha existente alterada.

| Objeto | Definição |
|---|---|
| `demurrage_handoff_credenciais_id_org_unique` | `UNIQUE (id, organization_id)` na tabela de credenciais existente — alvo da FK composta abaixo. `id` já é PK, então nunca falha para dados existentes |
| `demurrage_handoff_capacidade_organizacoes` | `id` PK; `organization_id` `UNIQUE` → `organizations(id)`; `fichas NUMERIC(14,6) ≥ 0`; `atualizado_em`; `admitidas_total`, `rejeitadas_total` (`BIGINT ≥ 0`); `ultima_rejeicao_em`; `criado_em`; trigger `organization_id_immutable` |
| `demurrage_handoff_capacidade_credenciais` | `id` PK; `credencial_id` `UNIQUE`; `organization_id`; `geracao_credencial`; `fichas`; `atualizado_em`; contadores; `criado_em`; **FK composta** `(credencial_id, organization_id)` → `demurrage_handoff_credenciais(id, organization_id)`; FK `organization_id` → balde da organização; índice em `organization_id`; trigger `organization_id_immutable` |
| `demurrage_handoff_capacidade_admitir(…)` | Função `plpgsql`: valida os limites (inteiros ≥ 1), confere que a credencial pertence à organização informada, trava e atualiza os dois baldes e devolve `(admitida, dimensao, retry_after_segundos, proximo_permitido_em)` |

Integridade garantida pelo banco, não só pelo código:

- **Uma linha por credencial e uma por organização** (`UNIQUE`); o volume é
  limitado pelo número de credenciais/organizações, nunca pelo número de
  requisições.
- **Dono imutável:** os triggers recusam qualquer `UPDATE` de `organization_id`.
- **Sem cruzamento de organizações:** a FK composta impede que o balde de
  uma credencial pertença a outra organização; a função ainda lê a
  organização da própria credencial e lança se o parâmetro divergir
  (defesa em profundidade).
- `TRUNCATE … CASCADE` dos testes (`testDb.ts`) já cobre as tabelas novas pelas FKs; `testDb.ts` não mudou.

---

## 5. Configuração

| Variável | Padrão | Significado |
|---|---|---|
| `PRIORA_HANDOFF_CAPACIDADE_CREDENCIAL_POR_MINUTO` | `60` | Taxa de reposição do balde de cada credencial (fichas/min) |
| `PRIORA_HANDOFF_CAPACIDADE_CREDENCIAL_RAJADA` | `10` | Capacidade do balde de cada credencial |
| `PRIORA_HANDOFF_CAPACIDADE_ORGANIZACAO_POR_MINUTO` | `120` | Taxa de reposição do balde da organização (soma das credenciais) |
| `PRIORA_HANDOFF_CAPACIDADE_ORGANIZACAO_RAJADA` | `20` | Capacidade do balde da organização |

`…_POR_MINUTO` é a **taxa de reposição** (média sustentada), não um teto
por janela: o pior caso numa janela de 60 s é `POR_MINUTO + RAJADA` (§3.4).
Aumentar a rajada aumenta esse pior caso na mesma medida; nada impede
`RAJADA > POR_MINUTO` (só inteiros positivos são exigidos).

Regras (`handoff/capacidade.ts`, `carregarConfigCapacidadeHandoff`):

- **Ausente** → padrão. **Presente** → precisa casar `^[1-9][0-9]*$` (após
  `trim`) e ser ≤ 1.000.000. Vazio, `0`, negativo, decimal, notação
  científica, hexadecimal, `+5` ou acima do máximo lançam
  `ErroConfigCapacidadeHandoff` com o nome da variável e o valor recebido.
- **Falha na inicialização:** a configuração é lida na **importação** de
  `demurrageHandoffRoutes.ts` pelo `index.ts`; valor inválido derruba o
  processo antes do `listen`. Não existe valor que desligue o limite.
- **Log de inicialização** (sem segredo — esta configuração não tem nenhum):
  `[demurrage-handoff] controle de capacidade ativo: credencial=60/min rajada=10; organizacao=120/min rajada=20`.
- Documentadas em `.env.example`, **comentadas** (uma linha `VAR=` vazia
  seria inválida e derrubaria a inicialização).
- Os limites vão como parâmetros da função a cada chamada: todas as
  instâncias devem usar a mesma configuração (ver §12).

---

## 6. Transação e concorrência

- **Uma transação curta por decisão:** uma única chamada
  `SELECT … FROM demurrage_handoff_capacidade_admitir($1…$6)` em autocommit.
  Nada de rede, HTTP ou serviço externo dentro dela; nenhuma transação
  atravessa o middleware.
- **Ordem determinística de locks:**
  1. `INSERT` do balde da organização `ON CONFLICT DO NOTHING`;
  2. `SELECT … FOR UPDATE` da linha da **organização**;
  3. leitura da geração da credencial (rotação), já sob esse lock;
  4. `INSERT` do balde da credencial `ON CONFLICT DO NOTHING`;
  5. `SELECT … FOR UPDATE` da linha da **credencial**;
  6. leitura de `clock_timestamp()`, cálculo e `UPDATE` das duas linhas.

  Duas credenciais da mesma organização se serializam na linha da
  organização; uma transação nunca segura um lock que outra espera na ordem
  inversa.
- **Deadlock encontrado e corrigido durante o desenvolvimento:** na
  primeira versão, o `INSERT` do balde da credencial vinha antes do
  `FOR UPDATE` da organização. A verificação da FK desse `INSERT` pega
  `KEY SHARE` na linha da organização; duas credenciais **novas** da mesma
  organização ficavam cada uma com `KEY SHARE` esperando o `FOR UPDATE` da
  outra (`40P01`). O teste de alta concorrência (#8b) reproduziu; com a
  organização travada primeiro, a FK só pede um lock que a própria
  transação já detém. #8b passou 8 de 8 repetições seguidas depois da
  correção.
- **`lock_timeout` de 2 s** (`set_config(…, true)`, local à transação): sob
  contenção extrema a chamada falha em vez de prender a conexão; a rota
  responde a falha genérica (§7), o handoff **não** é processado e nenhum
  balde é criado ou consumido (rollback da transação inteira — `#21b`).
- **Atomicidade entre as dimensões:** a decisão e as duas atualizações
  acontecem na mesma transação; ou as duas perdem 1 ficha, ou nenhuma.

---

## 7. Contrato HTTP

| Situação | Resposta |
|---|---|
| Admitida | Segue para o processamento existente — respostas **inalteradas** (`200`/`400`/`409`/`500` da Entrega 1) |
| Recusada por capacidade | `429`, cabeçalho `Retry-After: <inteiro ≥ 1>`, corpo **exato** `{"error":"limite_temporario"}` |
| Falha interna do controle (banco indisponível, `lock_timeout`, exceção da função) | `500 {"resultado":"FALHA","detalhe":{"motivo":"<código fechado>"}}` — a mesma resposta genérica de falha inesperada da rota (ex.: `BANCO_DADOS_ERRO`); o handoff não é processado |
| Falha de autenticação / parâmetro proibido | Inalteradas (`401`/`400`), sem tocar a capacidade |

- O corpo do 429 é fixo: nunca contadores, fichas, credencial, organização,
  dimensão ou detalhe do banco.
- Um 429 **não** cria nem consome registro em `demurrage_handoff_eventos` e
  **nunca** chama `processarEventoHandoff`.
- **Toda requisição admitida consome 1 tentativa**, qualquer que seja o
  resultado de negócio: JSON inválido, `CONTRATO_INVALIDO`,
  `REPLAY_IDEMPOTENTE`, `CONFLITO_EVENTO`, `EXIGE_REABERTURA`, falha.
  Requisição autenticada que não chega à rota de processamento (outro
  método ou caminho) **não** consome.
- **Semântica de `Retry-After`:** segundos até a dimensão que recusou ter
  pelo menos 1 ficha **se nada mais a consumir** nesse intervalo. Na
  dimensão organização, outras credenciais podem consumir antes; o
  chamador deve tratar o valor como espera mínima, não como reserva.

---

## 8. Observabilidade

Convenção do repositório (contadores simples + log com prefixo), sem
framework novo:

| Sinal | Onde |
|---|---|
| Admitidas | contador da instância `admitidas`; total durável `admitidas_total` (por credencial e por organização) |
| Recusadas | contadores `rejeitadasCredencial` / `rejeitadasOrganizacao`; total durável `rejeitadas_total` + `ultima_rejeicao_em`, **só na dimensão que recusou** |
| Dimensão da recusa | log `[demurrage-handoff] capacidade: 429 dimensao=<credencial\|organizacao> organizationId=<uuid> credencialId=<uuid> retryAfter=<n>s (admitidas=… rejeitadas_credencial=… rejeitadas_organizacao=… falhas=…)` |
| Falhas internas | contador `falhasInternas`; log `[demurrage-handoff] capacidade: falha interna <código> — requisição não processada (…contadores…)` |
| Limites configurados | linha de inicialização (§5) |

**Fonte operacional das contagens:** as colunas duráveis dos baldes
(`admitidas_total`, `rejeitadas_total`, `ultima_rejeicao_em`) — somadas por
todas as instâncias e consultáveis a qualquer momento (§14.2). Os
contadores em memória da instância aparecem em cada linha de 429 ou de
falha e via `contadoresCapacidadeHandoff()`; não há endpoint de métricas no
repositório e nenhum foi criado, nem log por requisição admitida (seria
ruído em tráfego normal).

**Nunca logados** (verificado pelo teste de log): segredo HMAC, assinatura,
corpo bruto (nem conteúdo de documento/e-mail que ele carregaria),
cabeçalhos de autenticação (`x-handoff-*` — nem os nomes nem os valores de
assinatura, nonce e timestamp), mensagem ou detalhe bruto do erro do
banco. O `credencialId` logado é o id do registro da credencial
(não é segredo; é enviado em claro em todo pedido).

---

## 9. Evidência de testes

Arquivo novo: `src/demurrage-engine/__tests__/handoffCapacidade.test.ts`
(PostgreSQL real; servidores Express reais na porta 0 com o router de
produção). Determinismo: os testes injetam limites pequenos (ex.: 1/min,
rajada 2) para que a reposição durante o teste seja desprezível,
"avançam o relógio do banco" deslocando `atualizado_em` para o passado no
fixture (`make_interval`), congelam a reposição com `atualizado_em` no
futuro quando precisam de contagem exata com os limites padrão (`#20b`) e
comparam `Retry-After` com a espera que a própria decisão gravou. Nenhum
`sleep`; as únicas esperas são o `lock_timeout` real de 2 s da função em
`#21b` e o polling de milissegundos de `#18b` até a conexão atrasada estar
de fato bloqueada no lock.

| # pedido | Requisito | Teste |
|---|---|---|
| 1 | Abaixo dos dois limites segue normalmente | `capacidade #1` |
| 2 | Limite por credencial → 429 | `#2` (corpo exato, `Retry-After`) |
| 3 | Limite por organização com duas credenciais | `#3` (e o contador/linha de log da dimensão organização) |
| 4 | `Retry-After` presente, positivo, para cima | `#4` (24/min, rajada 1, balde fixado em 0 ficha logo antes → cabeçalho = teto da espera exata gravada pela própria decisão, ≈ 2,5 s → `"3"`; 1/min → teto de `(1 − fichas) × 60`; `proximo_permitido_em` da função = instante da decisão + `(1 − fichas)/taxa`, e `retry_after_segundos` = `ceil` dessa espera; com `atualizado_em` 5 s no futuro, `proximo_permitido_em` = `atualizado_em` + 2,5 s exatos e `Retry-After` 7–8) |
| 5 | Capacidade volta após avançar o relógio do banco | `#5` (+60 s → 1 ficha; +3600 s → limitado à rajada) |
| 6 | Duas instâncias compartilham estado | `#6` |
| 7 | Concorrência não excede a credencial | `#7` (30 simultâneas em 2 instâncias → exatamente 5) |
| 8 | Concorrência entre credenciais não excede a organização | `#8` (4 credenciais × 6 → exatamente 7) |
| — | Alta concorrência com várias conexões | `#8b` (60 conexões `pg.Client` dedicadas simultâneas, 3 credenciais + outra organização → exatamente 25 e 10, sem deadlock, totais duráveis coerentes; confere antes que há conexões livres e usa `synchronous_commit = off` só nessas conexões de teste) |
| 9 | Recusa da organização não consome a credencial | `#9` |
| 10 | Recusa da credencial não consome a organização | `#10` |
| 11 | 429 não cria registro de idempotência | `#11/#12` |
| 12 | 429 nunca chama o serviço | `#11/#12` (espião no pool: exatamente 3 comandos — credencial, nonce, função de capacidade) |
| 13 | Replay idempotente consome 1 | `#13` (e continua uma linha em `demurrage_handoff_eventos`) |
| 14 | Falha de validação depois da admissão consome 1 | `#14` (`CONTRATO_INVALIDO` e JSON inválido) |
| 15 | Falha de autenticação não cria estado | `#15` (assinatura, credencial inexistente/desabilitada, timestamp, `organizationId` na query, sem cabeçalhos, nonce repetido) |
| — | Autenticada mas fora da rota de processamento | `capacidade: requisição autenticada que não entra no processamento (GET)` (404, nenhum balde criado) |
| 16 | Credencial A só afeta B pela organização | `#16` |
| 17 | Organização A nunca afeta B | `#17` |
| 18 | Rotação: balde de credencial novo, organização preservada | `#18`; `#18b` (corrida determinística com duas conexões: requisição esperando o lock da organização durante a rotação → exatamente uma rajada depois da rotação) |
| 19 | Configuração inválida falha a inicialização | `#19` (12 valores ruins × 4 variáveis; processo filho que importa a rota sai com erro citando a variável) |
| 20 | Padrão = valores documentados | `#20` (e a linha de log no processo filho); `#20b` (comportamento com os padrões: rajada exata 10/20 com a reposição congelada, reposição exata de 1 e 2 fichas/s medida sobre o intervalo que a própria função usou, teto na rajada após 60 s, `Retry-After` 1) |
| 21 | Falha do banco → resposta genérica sem processar | `#21` (SQLSTATE `55P03` injetado com marcador; marcador ausente de corpo e logs; contador de falhas +1); `#21b` (falha **real**: outra transação segura a linha da organização e a função estoura o próprio `lock_timeout` → 500 `BANCO_DADOS_ERRO` para credencial existente e nova; baldes idênticos, nenhum balde novo, nenhum evento, contador +2) |
| — | Log sanitizado e contadores | `capacidade: o log de um 429 …` (dimensão, organização, id da credencial, `Retry-After`; nunca segredo, assinatura, nonce, timestamp, corpo ou nomes de cabeçalho; contadores da instância: +1 recusa na dimensão credencial); `#1` (contador de admitidas +3) |
| 22 | Migration em banco limpo e em upgrade a partir da `0046` | `#22/#23` (upgrade com dados reais da Entrega 1; impressão digital das tabelas existentes idêntica antes/depois) |
| 23 | Reexecução não muda nada | `#22/#23` (`applied = []` e impressão digital idêntica) |
| 24 | Testes da Entrega 1 inalterados e verdes | arquivos `handoff*.test.ts` da Entrega 1 sem nenhuma alteração; 60/60 (§10.2, etapa 2) |

Ajustes mecânicos em testes existentes (só listas de migrations, mesmo
padrão das entregas anteriores): `0047` acrescentada como última em
`demurrageAcoesEntrega2V11`, `demurrageAcoesEntrega2V12`, `migrate`,
`registroDemurrageV12`, `responsabilidadeAuditoria`, `responsabilidadeV12`,
`responsavelOperacional` e `schedulerClaimFencing`; as duas tabelas novas
acrescentadas ao catálogo de tabelas com `organization_id` de
`migration0007` (que confere que toda tabela de tenant tem o trigger
`organization_id_immutable` — as duas têm); em
`leituraOperacionalEntrega3V11` (#M1/#M2), `runMigrations(pool)` passou a
`runMigrations(pool, { until: MIGRATION_0046 })` para manter esses testes
fixados na fronteira da 0046 que eles verificam.

---

## 10. Revisão adversarial e regressão

### 10.1 Revisão adversarial (antes do commit)

A implementação passou por uma revisão adversarial própria em cinco
frentes (SQL/concorrência, HTTP/escopo, testes, migration/rollout,
política). Achados e o tratamento de cada um, todos dentro deste escopo:

| Achado | Gravidade | Problema | Correção | Prova |
|---|---|---|---|---|
| SQLC-1 | menor | A geração da credencial era lida **antes** de esperar o lock da organização; uma requisição que esperava durante uma rotação reiniciava de novo o balde novo e gravava a geração antiga → rajada extra (o limite da credencial podia ser excedido) | Geração lida depois do lock da organização; reinício só se a geração lida é posterior; gravação com `greatest` | `#18b`: com a função anterior, **5** admissões depois da rotação (rajada 3); com a correção, **3** |
| SQLC-2 | info | Com `atualizado_em` no futuro (relógio do banco recuou), a espera ignorava a diferença → `Retry-After` cedo demais (nunca admissão a mais) | Espera soma `max(0, atualizado_em − agora)` | `#4`: com a função anterior, `proximo_permitido_em` = `atualizado_em` − 2,5 s; com a correção, + 2,5 s exatos |
| HTTP-1 | info | O controle estava em `router.use`: requisição autenticada fora da rota de processamento (ex.: `GET` assinado) consumia tentativa | Controle como primeiro handler de `router.post('/')` | Teste `capacidade: requisição autenticada que não entra no processamento (GET)` |
| HTTP-2 | info | Contagem de admitidas só visível nas linhas de 429/falha | Documentado: colunas duráveis dos baldes são a fonte operacional (§8, §14.2) | — |
| HTTP-3 | info | `#4` dependia do tempo de processamento da primeira requisição | Balde fixado em 0 ficha logo antes da segunda requisição | — |
| MR-1 | menor | O teste da migration não provava a FK composta (um `credencial_id` inexistente falharia com qualquer FK) | Teste grava o balde de uma credencial **real** de outra organização (cujo balde de organização existe) → só a FK composta recusa; controle positivo na organização dona | `#22/#23` |
| MR-2 | info | O `ALTER` em `demurrage_handoff_credenciais` (ACCESS EXCLUSIVE) podia esperar sem limite atrás de uma sessão longa, enfileirando a autenticação do handoff | `SET LOCAL lock_timeout = '5s'` no início da `0047` (só na transação do runner); falha é segura para repetir (§12) | — |
| MR-3 | info | `extract(epoch …)` só devolve `numeric` a partir do PostgreSQL 14; em versão anterior a função falharia em tempo de execução | Casts explícitos `::NUMERIC` | — |
| T1 | menor | `#8b` podia falhar por ambiente (conexões livres; flush do WAL no caminho serializado) | Checagem de conexões livres com mensagem clara; `synchronous_commit = off` só nas conexões do teste | — |
| T2 | menor | `#4` ainda dependia do relógio de parede | Cabeçalho comparado com o teto da espera exata gravada pela própria decisão | — |
| T3 | menor | `#21` não provocava falha real do PostgreSQL | `#21b`: `lock_timeout` real dentro da função; baldes intactos e nenhum balde novo | `#21b` |
| T4 | info | Teste de log não procurava os **valores** de nonce e timestamp | Valores incluídos na lista proibida | — |
| T5 | info | Nenhum teste conferia os contadores da instância | Deltas conferidos em `#1`, `#3` (dimensão organização, com a linha de log), `#21`, `#21b` e no teste de log (dimensão credencial) | — |
| POL-1 | info | Interpretação: token bucket não é teto estrito por janela deslizante | Mantido o modelo pedido; decisão do usuário registrada com opções (§3.4) | — |
| POL-2 | menor | §3.4 dizia que 70/140 só ocorria após 10 s de ociosidade | Texto corrigido: qualquer `f₀ ≥ 1` no início da janela | — |
| POL-3 | info | Limite da credencial vale por geração (rotação) | Qualificado em §3.4 | — |
| POL-4 | info | `POR_MINUTO` lido como teto | §5 e `.env.example`: é a taxa; pior caso `POR_MINUTO + RAJADA` | — |
| POL-5 | info | Nenhum teste fixava o comportamento com os padrões | `#20b`; números de janela marcados como derivados da fórmula | `#20b` |
| — | — | A suíte completa acusou o catálogo de tabelas com `organization_id` de `migration0007` | Tabelas novas acrescentadas ao catálogo (as duas têm o trigger) | `migration0007` 18/18 |

### 10.2 Regressão sequencial

Executada num **worktree limpo** criado com `git worktree add` e
posicionado em `19fc8d9` (o commit de código desta adição; este relatório
é completado no commit seguinte, que só altera documentação), com
`npm ci` a partir do lockfile — sem `node_modules` nem arquivos
compartilhados com o worktree de desenvolvimento. PostgreSQL 16.15 real,
banco novo e vazio; Node v22.22.0; `DEMURRAGE_DATABASE_URL` e
`DEMURRAGE_TEST_DATABASE_URL` apontando para o mesmo banco. Uma etapa por
vez, na ordem abaixo, nunca em paralelo.

| # | Etapa | Comando / arquivos | Testes | Pass | Fail | Skipped | Cancelled | Todo | Duração |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Novos testes de capacidade | `handoffCapacidade.test.ts` | 27 | 27 | 0 | 0 | 0 | 0 | 28,5 s |
| 2 | Entrega 1 (handoff) | `handoffProducaoP1(V11).test.ts`, `handoffVinculoConcorrenciaV13.test.ts`, `handoffVinculoTransacaoV12.test.ts` | 60 | 60 | 0 | 0 | 0 | 0 | 48,8 s |
| 3 | Entrega 2 (ações) | `demurrageAcoesEntrega2(.V11/.V12).test.ts`, `acoesSemLogicaDeNegocio.test.ts` | 70 | 70 | 0 | 0 | 0 | 0 | 47,0 s |
| 4 | Entrega 3 (leitura) | `leituraOperacionalEntrega3.test.ts`, `leituraOperacionalEntrega3V11.test.ts`, `leituraOperacionalEntrega3V11Unidade.test.ts` | 47 | 47 | 0 | 0 | 0 | 0 | 34,3 s |
| 5 | Suíte completa do Demurrage Engine | `npm run test:demurrage-engine` | **1181** | **1181** | 0 | 0 | 0 | 0 | 807,7 s |
| 6 | V1 | `npm run test` | 25 | 25 | 0 | 0 | 0 | 0 | 3,6 s |
| 7 | D13 UI | `npm run test:demurrage-ui` | 66 | 66 | 0 | 0 | 0 | 0 | 30,0 s |
| 8 | TypeScript | `tsc --noEmit` | — | limpo (saída vazia, exit 0) | | | | | 6,2 s |
| 9 | Build de produção | `npm run build` | — | limpo (exit 0) | | | | | 7,4 s |

A etapa 5 contém as etapas 1–4 (mesma pasta `__tests__`): 1181 = 1154 do
congelamento da Entrega 3 v1.1 + 27 testes novos. Os 60 da Entrega 1
rodam **sem nenhuma alteração** nos seus arquivos e com o controle de
capacidade ativo nos padrões. Lembrete: `tsc` (etapas 8 e 9) não verifica
`*.test.ts`; os tipos dos testes são verificados pelo `ts-node` nas
etapas 1–7.

`git status --porcelain` no worktree limpo: vazio antes e depois de todas
as etapas (`dist/` e `node_modules/` são ignorados pelo `.gitignore`).

No worktree de desenvolvimento, antes do commit, `handoffCapacidade.test.ts`
passou em 3 execuções consecutivas (verificação de estabilidade de `#8b`,
`#18b` e `#21b`) e em todas as execuções seguintes depois das últimas
adições de teste.

---

## 11. Prova de escopo

Verificado sobre `git diff b220ff0 19fc8d9` (18 arquivos: 1 migration
nova, 1 módulo novo, a rota do handoff, 1 arquivo de teste novo, 10
arquivos de teste com ajuste mecânico, `.env.example` e 3 documentos):

- **Nenhum arquivo de frontend:** 0 caminhos em `public/`, `*.html`,
  `*.css`, `*.jsx` ou `src/frontend-tests/`; D13 UI verde (§10.2, etapa 7).
- **Entregas 2 e 3 sem mudança de comportamento em produção:** 0 arquivos
  em `src/demurrage-engine/acoes/`, `closing/`, `persistence/`, `leitura/`,
  `registro/`, `src/routes/demurrageAcoesRoutes.ts`,
  `src/routes/demurrageV2Routes.ts`, `src/index.ts` e `src/middleware/`.
  Nos testes delas, só a atualização mecânica da lista de migrations (§9).
  Entrega 2 70/70 e Entrega 3 47/47 (§10.2).
- **Contrato assinado inalterado:** no diretório `handoff/`, o único
  arquivo do diff é o novo `capacidade.ts` — `assinatura.ts`,
  `autenticacaoHttp.ts`, `credenciais.ts`, `handoffService.ts` e o
  contrato não mudaram. Cabeçalhos, string canônica, HMAC, tolerância de
  timestamp, nonce e payload continuam os mesmos.
- **Idempotência inalterada para requisições admitidas:** na rota, fora de
  imports e comentários, o diff é só a configuração, o middleware
  acrescentado como primeiro handler de `router.post('/')` e o router
  padrão criado com a configuração validada; o corpo do handler (parse,
  `processarEventoHandoff`, tradução de status, falha genérica) é o
  mesmo. `#13` prova a semântica de replay (uma linha só em
  `demurrage_handoff_eventos`). Os 60 testes da Entrega 1 (HMAC, nonce,
  timestamp, idempotência, transação, vínculo) **não foram alterados** e
  passam com o controle ativo nos padrões.
- **Nenhum serviço externo:** `capacidade.ts` importa só tipos do
  Express, `pg`, `./erros` e o tipo da requisição autenticada; nenhum
  `fetch`/HTTP/processo filho/temporizador. A única E/S é uma chamada
  `pool.query` à função do PostgreSQL.
- **Migrations:** 0001–0046 intocadas; só `0047` adicionada.
- **Sem dependência de mudança local:** a validação do §10.2 rodou num
  worktree limpo do próprio commit, com `npm ci` a partir do lockfile e
  banco novo; `git status --porcelain` vazio antes e depois.

---

## 12. Notas de rollout

1. **Migration primeiro** (`npm run db:migrate:demurrage`), depois a
   aplicação. A aplicação nova sem a `0047` responde **500 genérico** em
   toda requisição autenticada do handoff (a função não existe → SQLSTATE
   `42883` → `BANCO_DADOS_ERRO`, por construção do tratamento de §7) —
   falha fechada, nunca processamento sem limite.
2. O `ALTER TABLE … ADD CONSTRAINT … UNIQUE (id, organization_id)` em
   `demurrage_handoff_credenciais` cria um índice e pega lock exclusivo
   nessa tabela até o fim da transação da migration (tabela pequena: uma
   linha por credencial). Aplicar em janela de baixo tráfego do handoff. A
   `0047` define `SET LOCAL lock_timeout = '5s'`: se outra sessão segurar a
   tabela, a migration **falha inteira** (rollback, nada aplicado, a `0047`
   não fica registrada) em vez de enfileirar a autenticação do handoff —
   basta repetir `npm run db:migrate:demurrage` quando a sessão terminar.
3. **Mesma configuração em todas as instâncias.** Os baldes são
   compartilhados, mas os limites vão como parâmetros de cada chamada:
   instâncias com valores diferentes aplicariam limites diferentes ao
   mesmo balde durante um rollout. Trocar a configuração com reinício
   coordenado.
4. **Pool:** cada requisição autenticada faz uma chamada a mais ao banco
   (uma transação curta). Sob rajada concentrada numa mesma organização, as
   chamadas se serializam na linha da organização por poucos milissegundos.
5. Validado em PostgreSQL 16.15. A função usa casts explícitos
   (`::NUMERIC`) e não depende do tipo de retorno de `extract` (que mudou
   no PostgreSQL 14); o piso do schema existente continua o mesmo
   (`gen_random_uuid()` nativo, PostgreSQL 13+).
6. Integradores: tratar `429` como retentável, respeitando `Retry-After`,
   com nova assinatura/nonce e o **mesmo** `origemEventoId`.

## 13. Rollback

- **Aplicação:** voltar para `b220ff0` remove o middleware; a rota volta ao
  comportamento sem limite. A aplicação antiga não lê nem escreve as
  tabelas novas.
- **Banco:** **não é preciso desfazer a `0047`.** As tabelas, a função e a
  restrição `UNIQUE (id, organization_id)` são inofensivas para o código
  antigo (nenhum caminho antigo as usa; a restrição nunca falha, pois `id`
  é PK). Manter o schema também permite reimplantar a versão nova sem
  remigrar. O runner registra a `0047` como aplicada; não editar nem
  remover a linha de `schema_migrations`.
- Se for **necessário** remover (não recomendado), em uma transação:
  `DROP FUNCTION demurrage_handoff_capacidade_admitir(UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER); DROP TABLE demurrage_handoff_capacidade_credenciais; DROP TABLE demurrage_handoff_capacidade_organizacoes; ALTER TABLE demurrage_handoff_credenciais DROP CONSTRAINT demurrage_handoff_credenciais_id_org_unique; DELETE FROM schema_migrations WHERE filename = '0047_handoff_controle_capacidade.sql';`
  — só com a aplicação antiga já em execução. (Sequência conferida num
  banco de desenvolvimento com a `0047` aplicada, dentro de uma transação
  desfeita com `ROLLBACK`: todos os comandos executam sem erro.)

---

## 14. Runbook

### 14.1 Mudar os limites

1. Definir as variáveis do §5 no ambiente de **todas** as instâncias (inteiros positivos; remover a variável volta ao padrão).
2. Reiniciar as instâncias. Conferir no log de inicialização a linha `[demurrage-handoff] controle de capacidade ativo: …` com os valores novos.
3. Valor inválido: a instância não sobe e o erro cita a variável (`ErroConfigCapacidadeHandoff: … PRIORA_HANDOFF_CAPACIDADE_… = "…"`). Corrigir e reiniciar.
4. Os baldes existentes são reaproveitados: o saldo atual é limitado à nova rajada no próximo cálculo e passa a repor na nova taxa. Nada a limpar no banco.

### 14.2 Identificar 429 repetidos

- **Logs:** `grep '\[demurrage-handoff\] capacidade: 429'` — cada linha traz `dimensao`, `organizationId`, `credencialId`, `retryAfter`.
- **Banco (totais duráveis, todas as instâncias):**

  ```sql
  -- organizações com recusas recentes
  SELECT organization_id, admitidas_total, rejeitadas_total, ultima_rejeicao_em, fichas
    FROM demurrage_handoff_capacidade_organizacoes
   WHERE ultima_rejeicao_em > now() - interval '1 hour'
   ORDER BY ultima_rejeicao_em DESC;

  -- credenciais com recusas recentes
  SELECT credencial_id, organization_id, admitidas_total, rejeitadas_total, ultima_rejeicao_em, fichas
    FROM demurrage_handoff_capacidade_credenciais
   WHERE ultima_rejeicao_em > now() - interval '1 hour'
   ORDER BY ultima_rejeicao_em DESC;
  ```

  Os totais são cumulativos desde a criação do balde (não são zerados pela
  rotação da credencial). `fichas` é o saldo no último uso, antes da
  reposição desde então.
- **Leitura:** recusas só na dimensão `credencial` → um integrador acima do
  seu ritmo; recusas na dimensão `organizacao` com várias credenciais → a
  soma das credenciais da organização acima do limite. Falhas internas
  aparecem como `capacidade: falha interna …` e respondem 500, não 429.

### 14.3 Interpretar `Retry-After`

- Inteiro ≥ 1: segundos até a dimensão que recusou ter 1 ficha, arredondado para cima.
- Com os padrões, depois de esgotada a rajada, o valor típico é `1` (credencial repõe 1 ficha/s; organização, 2 fichas/s). Valores maiores só aparecem com limites configurados abaixo de 60/min.
- Não é reserva: na dimensão organização, outra credencial pode consumir antes; nova recusa traz novo `Retry-After`.

### 14.4 Rollback preservando o estado inofensivo do banco

1. Reimplantar a aplicação em `b220ff0` (ou anterior com a mesma rota).
2. **Não** reverter a migration: as tabelas e a função da `0047` ficam ociosas e não afetam nada.
3. Para voltar à versão com o controle, basta reimplantá-la: o schema já está lá e os baldes recomeçam do estado gravado (com reposição pelo tempo decorrido, limitada à rajada).

---

## 15. Limitações registradas

1. **Teto estrito por janela deslizante:** não garantido — até `rajada + limite` (70/140) numa janela de 60 s, sempre que o tráfego anterior deixou fichas no balde (§3.4). Pendente de decisão do usuário.
2. **Contadores de instância** são por processo e zeram no reinício; os totais duráveis por balde são a fonte compartilhada.
3. Inalterado da Entrega 1: falha de banco **dentro da autenticação** continua fora do escopo deste controle (comportamento congelado).

---

## 16. Status

- Controle de capacidade **implementado e validado** (código `19fc8d9`;
  regressão sequencial em worktree limpo toda verde — §10.2).
- **Aguardando revisão do usuário. Não declarado congelado.**
- **Decisão pendente do usuário (§3.4):** manter o balde de fichas (pior
  caso 70/140 numa janela de 60 s, média 60/120) ou exigir teto estrito por
  janela deslizante — opção (a), só configuração, ou (b), registro
  limitado de admissões.
- Nenhum frontend alterado ou declarado; chamador da Liberação **não**
  iniciado; nenhuma outra frente começada.
