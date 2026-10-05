# Fase D15-A v1.1 (corretiva) — Eliminação da Corrida de FINAL, Ordem Universal de Lock e Contrato Canônico de Reabertura

> **Status:** correção de três achados de auditoria sobre a implementação
> D15-A v1.0 (commit `86461d0`). **D15-A continua NÃO aprovada e NÃO
> congelada.** Entrega para NOVA auditoria. D15-B, D15-C e D16 **não foram
> iniciadas**. Nenhuma mudança em frontend, Portal do Cliente, HeadCargo,
> Liberação, Auditoria, Courier, cadência/crédito de tracking, motores
> tarifários ou regras de negócio congeladas de D10–D14. Nenhuma rota nova,
> nenhum escopo de produto novo.

## 1. Os três achados e a causa raiz

### Achado #1 — corrida do guard de FINAL

**Causa raiz:** cada escritor material (`ContainerRepository.applyObservation`,
`promoverMasterFreeTimeComClient`, e por herança `promoverHouseFreeTimeComClient`)
decidia "promover ou bloquear" consultando `apuracao_status` e a linha do
contêiner em passos **sem um lock que serializasse contra `finalizarProcesso`**.
Era possível: (a) ler o contêiner como ainda não-FINAL; (b) `finalizarProcesso`
rodar e comitar por completo entre essa leitura e o `UPDATE`; (c) o escritor
material prosseguir e promover o valor — escrevendo por cima de um contêiner
já FINAL. A V1.0 introduziu um lock consultivo (`demurrage:closing:<processoId>`)
apenas nos QUATRO métodos de `closingService.ts`; os CINCO escritores
materiais nunca o adquiriam. Resultado: o lock protegia fechamento↔fechamento,
mas não protegia escritor-material↔fechamento — exatamente a lacuna
identificada pelo auditor.

**Correção:** todo escritor material agora adquire o **mesmo** lock
consultivo, **antes** de reler qualquer linha mutável, e só decide
promover/bloquear depois de reler `apuracao_status` sob esse lock. Ver §2.

### Achado #2 — ordem de lock inconsistente (risco de deadlock)

**Causa raiz:** a V1.0 tinha quatro ordens de lock diferentes entre os
quatro métodos de fechamento/reabertura:

| Método (v1.0) | Ordem observada |
|---|---|
| `validarMinuta` | lock de linha (minuta/contêiner) → lock consultivo |
| `finalizarProcesso` | lock consultivo → lock de linha (processo/contêiner) |
| `solicitarReabertura` | lock consultivo → lock de linha (reabertura) |
| `autorizarReabertura` | lock de linha (reabertura) → lock consultivo |

Duas transações que adquirem os mesmos dois recursos em ordens opostas são a
definição clássica de deadlock: `validarMinuta` (trava a minuta, depois
tenta o consultivo) correndo contra `finalizarProcesso` (trava o consultivo,
depois tenta travar o contêiner que `validarMinuta` também trava) podia, sob
timing desfavorável, produzir um deadlock real detectado pelo próprio
Postgres (ou, pior, uma espera indefinida se as travas não colidissem
exatamente nesse padrão mas ainda impedissem progresso).

**Correção:** as quatro operações — e agora os cinco escritores materiais —
seguem a MESMA ordem, sem excecão. Ver §2.

### Achado #3 — contrato de resultado não padronizado

**Causa raiz:** cada escritor devolvia um formato próprio quando um fato
material era bloqueado por FINAL: `ContainerRepository` usava
`outcome: 'bloqueada_final'` sem nenhum booleano dedicado;
`masterFreeTimeService` usava `bloqueadoPorFinal: boolean`;
`houseFreeTimeService` só repassava o `outcome` de `ContainerRepository`;
`eventIngestion.ts` nem sequer tinha o conceito no tipo `PromocaoAplicada`.
Um consumidor (UI futura, auditoria, backfill) precisava conhecer a forma de
CADA escritor para saber se uma reabertura era exigida.

**Correção:** `exigeReabertura: boolean` é agora o campo canônico,
`true` se e somente se `outcome === 'bloqueada_final'`, presente em TODOS os
pontos de retorno dos cinco escritores e propagado por `eventIngestion.ts`.
`bloqueadoPorFinal` em `PromoverMasterFreeTimeResultado` é mantido como
alias **depreciado** (documentado como tal), só por compatibilidade interna
temporária — nenhum chamador externo novo deve lê-lo.

## 2. Ordem universal de lock (final)

Implementada uma única vez em
`src/demurrage-engine/closing/materialChangeGuard.ts` —
`lockProcesso(db, processoId)` — e **reusada literalmente** (nenhuma
reimplementação, nenhuma variante de chave) por todo escritor material e
pelas quatro operações de fechamento/reabertura. A chave é
`demurrage:closing:<processoId>` (`pg_advisory_xact_lock`, escopo de
transação — liberado automaticamente em `COMMIT`/`ROLLBACK`, nunca precisa de
`UNLOCK` manual).

Toda operação, sem exceção, segue estes oito passos dentro de **uma única
transação**:

1. **Identifica** o processo/recurso a partir do input, **sem** `FOR UPDATE`
   (a FK `processo_id` é estável — nunca reatribuída; ler sem lock é seguro
   e evita adquirir um lock de linha antes do consultivo).
2. **`lockProcesso`** — `pg_advisory_xact_lock` pelo `processoId`. Este é
   SEMPRE o primeiro lock de qualquer operação D15-A.
3. **Relê e trava** (`FOR UPDATE`) a linha do **processo**.
4. **Relê e trava** (`FOR UPDATE`) a(s) linha(s) de **contêiner** (ordenadas
   por `id` quando mais de uma) e, quando aplicável, a linha de **minuta**
   ou **reabertura** — com verificação explícita de que a minuta/reabertura
   relida ainda pertence ao contêiner/processo esperado (defesa adicional
   contra uma minuta reatribuída entre o passo 1 e o passo 4, ainda que isso
   não aconteça na prática hoje).
5. **Persiste** a observação bruta / executa a lógica de negócio.
6. **Decide** prioridade/gates reavaliando o estado relido nos passos 3-4
   (nunca uma leitura anterior ao lock).
7. **Promove OU bloqueia+registra** `FATO_MATERIAL_POS_FINAL`.
8. **Comita** tudo junto — a transação cobre observação, decisão, evento e
   projeção como uma unidade atômica.

Por que isso elimina os dois achados ao mesmo tempo: como o lock consultivo
(passo 2) é **sempre** o primeiro lock de qualquer operação D15-A, duas
operações no MESMO processo nunca disputam uma linha em ordens opostas — a
segunda fica bloqueada no passo 2 até a primeira comitar ou abortar, **antes
de tocar qualquer linha**. Isso é ao mesmo tempo:

- a prova do achado #1: nenhum escritor material pode ler `apuracao_status`
  (passo 3) enquanto outra transação do MESMO processo ainda não comitou —
  então a releitura no passo 3 é sempre o estado **verdadeiramente atual**,
  nunca um instantâneo que a outra transação pode invalidar depois;
- a prova do achado #2: como NENHUMA operação adquire um lock de linha antes
  do consultivo, não existe par de operações que disputem dois recursos em
  ordens opostas — pré-condição necessária para um deadlock de duas transações.

### Métodos/arquivos que agora seguem esta ordem

| Operação | Arquivo | Observação |
|---|---|---|
| `ContainerRepository.applyObservationComClient` (descarga, tipo de equipamento, retorno de tracking, `gateOutDate`) | `persistence/containerRepository.ts` | Único método estático; `applyObservation` é wrapper transacional fino sobre ele (ver §3). |
| `promoverMasterFreeTimeComClient` | `freeTime/masterFreeTimeService.ts` | Serviço central próprio (divergência SI×Master, avisos, outbox) — não delega a `containerRepository`. |
| `promoverHouseFreeTimeComClient` | `freeTime/houseFreeTimeService.ts` | Delega inteiramente a `applyObservationComClient` — herda o protocolo sem duplicar lógica. |
| `validarMinuta` | `closing/closingService.ts` | Identidade via `minutas m JOIN containers c` (sem lock) → consultivo → `FOR UPDATE` processo → `FOR UPDATE` contêiner → `FOR UPDATE` minuta (com verificação de pertencimento). |
| `finalizarProcesso` | `closing/closingService.ts` | `processoId` já é o input — consultivo é o primeiro lock, sem mudança estrutural necessária (já estava correto na v1.0; só ganhou o gancho `_testeAguardarAntesDoCommit`, ver §4). |
| `solicitarReabertura` | `closing/closingService.ts` | Mesma situação de `finalizarProcesso` — já estava correto; confirmado, não alterado. |
| `autorizarReabertura` | `closing/closingService.ts` | Identidade via `SELECT processo_id FROM reaberturas WHERE id=$1` (sem lock) → consultivo → `FOR UPDATE` reabertura → `FOR UPDATE` processo. Era a ordem INVERTIDA na v1.0 (lock de linha antes do consultivo) — este é o ponto exato corrigido do achado #2. |

Nenhuma outra tabela/trava do sistema foi tocada: os namespaces de
`decidirResponsabilidade.ts` (lock de contêiner, sem prefixo) e de
`registrarProcessoDemurrage.ts` (`demurrage:processo:<org>:<numero>`)
continuam distintos e não colidem com `demurrage:closing:<processoId>`.

## 3. Limites de transação por caminho de observação

| Caminho | Transação própria? | Como |
|---|---|---|
| `ContainerRepository.applyObservation` (chamada autônoma — `masterFreeTimeDays` excluído) | **Sim, nova nesta versão.** | Era, antes da v1.1, uma sequência de instruções `autocommit` separadas (a observação, a releitura, o `UPDATE`, cada uma sua própria transação implícita) — exatamente a janela do achado #1. Agora abre `BEGIN`, delega a `ContainerRepository.applyObservationComClient(client, input)` e fecha com `COMMIT`/`ROLLBACK` — **nenhuma lógica duplicada**, o `ComClient` é a única implementação. |
| `ContainerRepository.applyObservation` para `masterFreeTimeDays` | Sim (herdada) | Delega a `promoverMasterFreeTime` (autônomo), que já abre sua própria transação. |
| `ContainerRepository.applyObservationComClient` | Não (recebe `client` de quem chama) | Usado tanto pelo wrapper autônomo acima quanto por `promoverHouseFreeTimeComClient` — o chamador define a fronteira. |
| `promoverMasterFreeTime` (autônomo) | Sim | `BEGIN` → `promoverMasterFreeTimeComClient` → `COMMIT`/`ROLLBACK`. |
| `promoverMasterFreeTimeComClient` | Não | Observação, decisão, `UPDATE`, divergência SI×Master, eventos, avisos e outbox de recálculo — tudo na mesma transação do chamador. |
| `promoverHouseFreeTimeComClient` | Não | Delega a `applyObservationComClient` dentro da MESMA transação do chamador; outbox de recálculo na sequência, mesma transação. |
| `validarMinuta`, `finalizarProcesso`, `solicitarReabertura`, `autorizarReabertura` | Sim (cada uma) | Inalterado da v1.0: cada operação é uma transação única, do `BEGIN` ao `COMMIT`/`ROLLBACK`. |

Em todos os casos, uma falha em QUALQUER ponto depois do `BEGIN` desfaz a
observação bruta, a decisão, o evento `FATO_MATERIAL_POS_FINAL` e qualquer
mutação de projeção — nunca um estado parcial. Ver os testes de rollback em
§4.3.

Nenhuma trigger de banco foi adicionada para "descartar" observações
silenciosamente — a evidência bruta é SEMPRE persistida em
`field_observations` antes de qualquer decisão de promoção (passo 5 do
protocolo), e só a PROMOÇÃO é recusada quando bloqueada; a observação em si
nunca é descartada.

## 4. Testes novos (10 itens obrigatórios)

Arquivo: `src/demurrage-engine/__tests__/closingD15AV11.test.ts` (14 testes).
Não reescreve `closingD15A.test.ts` — os 16 testes de aceitação da v1.0
continuam exatamente como estavam (ver §6).

### 4.1 — Corrida escritor material × `finalizarProcesso` (itens #1 e #2 da lista obrigatória)

Duas técnicas, deliberadamente combinadas:

- **Sem pausa artificial** (5 testes — um por campo: descarga, House FT,
  Master FT, tipo de equipamento, retorno de tracking): `Promise.all` de um
  escritor material concorrente com `finalizarProcesso`, sobre o MESMO
  processo ainda OPEN. Como a ordem universal de lock (§2) garante
  correção **independente de quem chega primeiro**, o teste aceita os DOIS
  estados finais válidos e verifica qual ocorreu: se a observação venceu a
  corrida pelo lock consultivo, ela promove e `finalizarProcesso` incorpora
  o novo valor ao fechar; se `finalizarProcesso` venceu, a observação, ao
  finalmente conseguir o lock, relê `apuracao_status = 'FINAL'` e
  corretamente bloqueia+registra. As DUAS alternativas são aceitas — o que
  nunca é aceito, e nunca ocorreu em nenhuma execução, é uma promoção
  depois de FINAL sem reabertura.
- **Com pausa DETERMINÍSTICA** (2 testes, descarga como caso representativo
  do caminho genérico — os outros quatro campos já estão cobertos pela
  técnica acima, e usam o MESMO protocolo): um "portão" (`criarPortao()`)
  implementado só com Promises — nenhum `sleep`, nenhuma dependência de
  timing. O gancho `_testeAntesDaDecisaoFinal` (ou `_testeAguardarAntesDoCommit`
  em `finalizarProcesso`) resolve uma Promise que sinaliza "paused" e só
  continua quando o teste chama `liberar()`. Como a pausa ocorre DEPOIS do
  lock consultivo e dos `FOR UPDATE` terem sido adquiridos, a operação
  concorrente que tenta o MESMO lock fica estruturalmente bloqueada no
  Postgres até `liberar()` ser chamado — garantido pela semântica do
  próprio `pg_advisory_xact_lock`, não por timing do teste. Os dois testes
  provam explicitamente as duas ordens: "observação pausada primeiro,
  promove, fechamento incorpora o valor já promovido" e "`finalizarProcesso`
  pausado imediatamente antes do commit, observação só decide depois do
  FINAL já comitado — bloqueia, nunca promove".

### 4.2 — Deadlock-freedom entre operações de tipos diferentes (item obrigatório relacionado ao achado #2)

Dois testes, cada um usando um pool com `SET lock_timeout` curto
(`testPoolComLockTimeout(5000)` — item obrigatório #6, ver §4.4):

- `validarMinuta` × `finalizarProcesso` no mesmo processo, via `Promise.all`
  sem pausa artificial (a ordem universal de lock garante ausência de
  deadlock independentemente de quem vence). O cenário usa uma minuta SEM
  divergência (mesma data do tracking), de forma que o resultado de negócio
  é idêntico nas duas ordens possíveis — só o CAMINHO interno de
  `validarMinuta` (branch OPEN ou branch "apenas confirma" de FINAL) muda
  conforme quem chega primeiro. Ambas as chamadas sempre sucedem; o processo
  termina FINAL e a minuta termina VALIDADA.
- `autorizarReabertura` × uma NOVA `solicitarReabertura` no mesmo processo —
  exatamente o par que tinha ordens de lock OPOSTAS na v1.0 (achado #2:
  `autorizarReabertura` travava a linha antes do consultivo;
  `solicitarReabertura` travava o consultivo antes da linha). `autorizarReabertura`
  sempre sucede; a segunda solicitação concorrente é sempre recusada (com
  `reabertura_ja_aberta` ou `processo_nao_final`, dependendo da ordem —
  ambos são corretos); nenhuma segunda linha de reabertura é criada.

### 4.3 — Rollback total sob falha injetada (item #3)

Dois testes usando o gancho `_testeFalhaAposObservacao` (dispara
imediatamente depois do `INSERT` em `field_observations`, antes de qualquer
decisão de prioridade/promoção): um para o caminho genérico de
`ContainerRepository` (descarga) e um para o serviço central próprio de
Master Free Time (caminho de código distinto, merece prova própria). Ambos
confirmam: a contagem de `field_observations` não muda, nenhum
`FATO_MATERIAL_POS_FINAL` é criado, a projeção do contêiner permanece
intocada — e, crucialmente, que a OPERAÇÃO DE VERDADE (sem a falha) continua
funcionando imediatamente depois, provando que o `ROLLBACK` libera o lock
consultivo corretamente (nenhuma trava "vazada").

### 4.4 — `lock_timeout` como rede de segurança (item #6)

`testPoolComLockTimeout(ms)` cria um `Pool` e, via `pool.on('connect', ...)`,
executa `SET lock_timeout = '<ms>'` em TODA conexão física nova — incluindo
as abertas internamente por `ClosingService` via `this.pool.connect()`. Os
dois testes de deadlock-freedom (§4.2) usam este pool. Caso uma regressão
futura reintroduza uma ordem de lock inconsistente, a trava correspondente
expira em segundos com um erro claro do Postgres (`55P03 lock_timeout`) em
vez de travar a suíte inteira indefinidamente. Reforçado por `timeout: 15000`
na própria chamada `test(...)` do `node:test` nos testes de corrida/deadlock,
como segunda rede de segurança independente do Postgres.

### 4.5 — Contrato canônico `exigeReabertura` (itens #7 e #8)

Um teste cobre os CINCO escritores bloqueados por FINAL simultaneamente
(descarga, tipo de equipamento, retorno de tracking via
`ContainerRepository`; House Free Time via `promoverHouseFreeTimeComClient`;
Master Free Time via `promoverMasterFreeTime`) e verifica, para cada um,
`outcome === 'bloqueada_final'` e `exigeReabertura === true` — além de
confirmar que o alias depreciado `bloqueadoPorFinal` (só em Master Free
Time) ainda espelha o mesmo valor. Um segundo teste cobre o caso promovido e
o caso de prioridade menor (processo OPEN): ambos devolvem
`exigeReabertura === false`.

### 4.6 — Dedupe sob concorrência real, sem migration nova (item #9)

Duas chamadas IDÊNTICAS (mesmo contêiner, campo, fonte, valor e
`observado_em`) disparadas via `Promise.all` contra um processo já FINAL
cujo valor frozen é diferente. Como as duas disputam a MESMA trava
consultiva, a segunda só começa a decidir depois que a primeira já comitou —
nessa releitura, `field_observations` já contém a tupla exata (inserida pela
primeira chamada), então a segunda tentativa de `INSERT` cai no
`ON CONFLICT (entidade_tipo, entidade_id, campo, fonte, observado_em) DO
NOTHING` já existente (migration `0004`, inalterada), e o
`registrarFatoMaterialPosFinal` (dedupe por conteúdo — `containerId` +
`campo` + `valorAnterior` + `valorNovo` — já existente desde a v1.0, também
inalterado) encontra o evento da primeira chamada e não duplica. O teste
confirma: exatamente 2 linhas em `field_observations` (a do seed + a nova,
nunca 3), exatamente 1 evento `FATO_MATERIAL_POS_FINAL`, e ambas as chamadas
devolvem `outcome: 'bloqueada_final'` / `exigeReabertura: true`.

Este teste é a PROVA empírica que fundamenta a decisão de não criar
migration — ver §5.

### 4.7 — Totais

14 testes novos em `closingD15AV11.test.ts`, todos verdes. Cobertura dos 10
itens obrigatórios: #1 e #2 (corrida escritor×fechamento, 7 testes — 5 sem
pausa + 2 com pausa determinística), #2 adicional (deadlock entre tipos
diferentes, 2 testes), #3 (rollback, 2 testes), #6 (lock_timeout, mecanismo
aplicado aos 2 testes de §4.2), #7/#8 (contrato canônico, 2 testes), #9
(dedupe sem migration, 1 teste). O item #10 (preservar os 16 testes da v1.0)
é verificado em §6.

## 5. Decisão de migration: NENHUMA nova migration é necessária

**Decisão:** o item #9 da lista obrigatória — "concurrent identical blocked
observations must not duplicate the effective audit event" — é garantido
pela COMBINAÇÃO de dois mecanismos já existentes, sem precisar de nenhuma
constraint ou chave de idempotência nova:

1. **Serialização pelo lock consultivo** (`pg_advisory_xact_lock` por
   `processoId`, §2): duas tentativas sobre o MESMO processo nunca
   executam o passo de decisão/registro concorrentemente — uma espera a
   outra comitar ou abortar por completo antes de começar a sua própria
   decisão. Isso por si só já impediria uma corrida de ESCRITA simultânea
   no evento.
2. **Dedupe por conteúdo em `registrarFatoMaterialPosFinal`** (já existente
   desde a v1.0, `materialChangeGuard.ts`, inalterado nesta versão): antes
   de inserir, um `SELECT` verifica se já existe um `FATO_MATERIAL_POS_FINAL`
   para o mesmo `containerId` + `campo` + `valorAnterior` + `valorNovo`; se
   sim, `jaRegistrado: true` e nenhum `INSERT` novo ocorre.

A combinação é necessária e suficiente: o lock consultivo garante que a
SEGUNDA tentativa só começa a decidir depois que a PRIMEIRA já comitou (logo
o `SELECT` de dedupe da segunda sempre vê o evento da primeira, nunca uma
condição de corrida entre dois `SELECT`s concorrentes que ambos veem "não
existe" e ambos inserem); o dedupe por conteúdo garante que, mesmo assim, a
segunda não insere uma linha redundante. O teste de §4.6 prova isso
empiricamente contra PostgreSQL real, sob concorrência real (duas conexões,
`Promise.all`), não é uma inferência teórica.

Migration `0035_d15a_integridade_final_reabertura.sql` **não foi editada**
(instrução explícita). Nenhuma migration nova foi criada.

## 6. Arquivos alterados (exatos)

### Novos

| Arquivo | Conteúdo |
|---|---|
| `src/demurrage-engine/__tests__/closingD15AV11.test.ts` | Os 14 testes desta versão (§4). |
| `docs/demurrage-fase-d15-a-v1-1.md` | Este documento. |

### Alterados — produção

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/closing/materialChangeGuard.ts` | Novo `lockProcesso(db, processoId)` (único ponto de implementação do lock consultivo, reusado por `closingService.ts` e por todo escritor material). `FatoMaterialBloqueadoInput` ganha `processoIdConhecido`/`apuracaoStatusConhecido` (evita releitura redundante quando o chamador já tem o dado sob lock) e `_testeAntesDaDecisaoFinal` (gancho de pausa reusado por TODOS os escritores). Cabeçalho documenta a ordem universal de lock (§2). |
| `src/demurrage-engine/persistence/containerRepository.ts` | `applyObservation` reescrito como wrapper transacional fino (§3) — elimina a sequência de instruções autocommit da v1.0. `applyObservationComClient` reescrito para o protocolo de 8 passos (§2). Corrigido o bug de idempotência de replay (§7). Novos campos `exigeReabertura` nos dois resultados; ganchos `_testeFalhaAposObservacao`/`_testeAntesDaDecisaoFinal`. |
| `src/demurrage-engine/freeTime/masterFreeTimeService.ts` | `promoverMasterFreeTimeComClient` reescrito para o mesmo protocolo de 8 passos. Corrigido o mesmo bug de idempotência de replay (§7), mirrorado. `PromoverMasterFreeTimeResultado` ganha `exigeReabertura` (canônico) e mantém `bloqueadoPorFinal` como alias depreciado documentado. |
| `src/demurrage-engine/freeTime/houseFreeTimeService.ts` | `PromoverHouseFreeTimeInput` ganha os dois ganchos `_teste*`; retorno ganha `exigeReabertura` (repassado de `applyObservationComClient` — nenhuma lógica nova). |
| `src/demurrage-engine/tracking/eventIngestion.ts` | `PromocaoAplicada` ganha `exigeReabertura: boolean`; os quatro pontos de `promocoes.push(...)` (descarga, `gateOutDate`, retorno de tracking, tipo de equipamento) passam a preencher o campo. |
| `src/demurrage-engine/closing/closingService.ts` | Import do `lockProcesso` compartilhado (a implementação LOCAL duplicada da v1.0 foi removida). `validarMinuta`: preâmbulo de lock reescrito para a ordem universal (identidade sem lock → consultivo → processo → contêiner → minuta com verificação de pertencimento). `autorizarReabertura`: preâmbulo de lock reescrito (identidade sem lock → consultivo → reabertura → processo) — era a ordem INVERTIDA na v1.0 (achado #2). `finalizarProcesso`: ganho o gancho `_testeAguardarAntesDoCommit` (pausa imediatamente antes do `COMMIT`, usado pelos testes de corrida "fechamento vence" — §4.1); ordem de lock já estava correta, sem mudança estrutural. `solicitarReabertura`: confirmado já compatível; sem mudança. |

Nenhuma rota, nenhum arquivo de frontend, nenhum motor tarifário, nenhuma
regra de cadência/crédito de tracking foi tocado. Nenhuma trigger de banco
nova. Nenhuma migration nova.

## 7. Bug encontrado e corrigido durante a implementação: regressão de idempotência de replay

Ao transformar `ContainerRepository.applyObservation` num wrapper
transacional fino (§3, requisito explícito da auditoria), a lógica existente
de `applyObservationComClient` — `if (criada) { promover = true; ... }` —
revelou um efeito colateral: essa condição existia para suportar
idempotência estrutural de chamadores `ComClient`, mas tinha como premissa
implícita que SÓ uma observação NOVA (`criada: true`) poderia estar em jogo.
Replays de uma tentativa IDÊNTICA já bloqueada por FINAL (`criada: false`,
porque a tupla exata já existe em `field_observations`) pulavam inteiramente
o bloco de decisão — incluindo a reinvocação de `fatoMaterialBloqueadoPorFinal`
— e o outcome degradava silenciosamente de `'bloqueada_final'` para
`'registrada_sem_promover'` na segunda tentativa idêntica. Isso quebraria
diretamente a garantia de idempotência exigida pelo item #9 (§4.6) e pelo
contrato canônico (achado #3).

**Correção:** a condição de entrada no bloco de decisão passou de
`if (criada)` para `let promover = !conflito` (onde `conflito` já era
calculado antes, para o caso genuíno de "mesma fonte, mesmo instante, valor
diferente" — que continua corretamente excluído de promover). Isso faz o
bloco de decisão rodar tanto para um fato NOVO quanto para o replay IDÊNTICO
de um fato já conhecido — produzindo o mesmo resultado determinístico em
ambos os casos. Aplicado em `ContainerRepository.applyObservationComClient`
e, mirrorado, em `promoverMasterFreeTimeComClient` (estrutura equivalente,
nomes de variável distintos). Confirmado pelo teste pré-existente
"D15-A #1/#2: descarga corrigida após FINAL... — e idempotente" (que já
reprocessava a mesma tentativa bloqueada) e pelo novo teste de dedupe sob
concorrência real (§4.6).

## 8. Totais de teste — regressão completa

Executado sequencialmente contra PostgreSQL 16 real
(`DEMURRAGE_TEST_DATABASE_URL`/`DEMURRAGE_DATABASE_URL`/`DATABASE_URL` →
`priora_demurrage_test`), nenhum teste pulado:

| Suíte | Resultado |
|---|---|
| D15-A v1.0 (`closingD15A.test.ts`) — os 16 testes de aceitação originais | **16/16**, preservados sem alteração |
| D15-A v1.1 (`closingD15AV11.test.ts`) — os 14 testes desta versão | **14/14** |
| `closing.test.ts` (fechamento/minuta/reabertura base) | **21/21** |
| Suíte completa da Demurrage Engine (`npm run test:demurrage-engine`, inclui D10/D11/D12/D14/D15-A/D15-A v1.1 e todo o restante) | **842/842**, 0 falhas, 0 pulados |
| V1 (`npm test`) | **25/25** |
| D13 UI (`npm run test:demurrage-ui`) | **66/66** |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

`tsc --noEmit` e o build de produção foram executados sem nenhum erro após
cada rodada de edição, não só no final.

## 9. O que esta entrega NÃO faz

- Não declara D15-A aprovada nem congelada.
- Não inicia D15-B, D15-C ou D16.
- Não adiciona rota, ação de frontend ou escopo de produto novo.
- Não edita a migration `0035`.
- Não cria migration nova (justificado em §5).
- Não altera nenhuma regra de negócio congelada de D10–D14.

Entrega para nova auditoria.
