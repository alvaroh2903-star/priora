# Fase D15-A v1.3 (corretiva) — Instantâneo Pós-Lock Completo no Recálculo e Auditoria Estática por AST

> **Status:** correção de um achado bloqueante de auditoria sobre a
> implementação D15-A v1.2 (commit `368a986`). **D15-A continua NÃO
> aprovada e NÃO congelada.** Entrega para NOVA auditoria. D15-B, D15-C e
> D16 **não foram iniciadas**. Nenhuma mudança em frontend, Portal do
> Cliente, HeadCargo, Liberação, Auditoria, Courier, cadência/crédito de
> tracking, motores tarifários ou regras de negócio congeladas de D10–D14.
> Nenhuma rota nova, nenhum escopo de produto novo.

## 1. Achado bloqueante — instantâneo pré-lock no recálculo

### 1.1 Causa raiz

Até a v1.2, `recalcularApuracaoContainerComClient` relia **todo** o insumo
de cálculo — descarga, House Free Time, Master Free Time, retorno
(tracking/efetivo), equipamento, armador, condição comercial — numa única
consulta **antes** do lock consultivo do processo. Só `apuracao_status` era
relido **depois** do lock (correção da v1.2, achado #1-B — ver
`docs/demurrage-fase-d15-a-v1-2.md` §1.2-B).

Isso bastava para o guard de FINAL (o único uso que a v1.2 precisava), mas
deixava uma janela real: se esta chamada ficasse esperando o lock consultivo
enquanto um escritor material concorrente (qualquer um dos cinco escritores
auditados em `materialChangeGuard.ts` desde a v1.1/v1.2) mudava descarga,
House ou Master Free Time, tipo de equipamento ou retorno — e comitava — o
recálculo, ao finalmente adquirir o lock, prosseguia com o objeto `c`/`proc`
carregado **antes** do lock. Relógios, valores financeiros e lifecycle eram
então persistidos a partir de fatos **velhos**, mesmo depois de a chamada
ter corretamente esperado a trava. Diagnóstico confirmado por teste
(§4): o relógio (`relogios`, cache) relê sozinho os fatos do contêiner via
`RelogioRepository.lerEntradas` (consulta própria, sempre fresca) e por
isso nunca ficava errado por si só — o achado vive em **`valores_apurados`**
(o cálculo financeiro), que usava diretamente o objeto pré-lock para decidir
dias cobrados, equipamento/tarifa e até se uma linha deveria existir.

### 1.2 Ordem final de leitura e lock

`recalcularApuracaoContainerComClient` agora segue, sem excecão:

1. **Identidade** — `SELECT processo_id FROM containers WHERE id = $1`, SEM
   lock de linha mutável (a FK `processo_id` é estável, nunca reatribuída —
   ler sem lock é seguro).
2. **Lock consultivo** — `lockProcesso(client, processoId)`, ANTES de
   qualquer linha mutável.
3. **Relê e trava (`FOR UPDATE`) a linha do PROCESSO — PRIMEIRO**
   (`apuracao_status`, `armador_id`, `condicao_comercial_id`) — MESMA ordem
   de `finalizarProcesso`/`validarMinuta`/`autorizarReabertura` (processo
   primeiro). Decide FINAL **aqui**, com o status relido SOB o lock —
   `skipped: 'FINAL'` se já virou FINAL enquanto esperava.
4. **Relê e trava (`FOR UPDATE`) a linha do CONTÊINER — SEGUNDO**, depois do
   processo: descarga, House/Master Free Time, retorno (tracking e
   efetivo), equipamento (via `LEFT JOIN container_types`). Relê também a
   condição comercial (termo e tabela — FIXADA na condição, nunca
   reatribuída depois de criada por `registrarProcessoDemurrage`; lida sem
   lock de linha própria, como em todo o restante do sistema).
5. Clocks, valores e lifecycle são calculados **exclusivamente** a partir
   deste instantâneo pós-lock — nenhum campo do passo 1 sobrevive além da
   identidade do processo (um UUID estável, nunca um fato de cálculo).

Chamada por quem já segura o lock e as linhas (`finalizarProcesso`,
`validarMinuta`, `autorizarReabertura` — via
`recalcularApuracaoContainerComClient`/`recalcularApuracaoProcessoComClient`),
os `FOR UPDATE` acima são um no-op seguro na mesma transação — nenhuma
mudança de comportamento para esses chamadores além de agora lerem o
processo e o contêiner de novo (idempotente, mesma transação, sem custo
observável).

### 1.3 Por que a correção é suficiente (evidência de que não resta campo velho)

Toda variável usada no bloco de cálculo (`clocks`, `termoTipo`,
`condicaoTabelaId`, `equipamento`, `proc.armador_id`, `processoId`) é lida
**depois** do passo 4 (ou do passo 3, no caso de `processoId`/armador/
condição). Não existe mais nenhuma consulta de insumo de cálculo antes do
passo 2 (lock) — a única leitura pré-lock é a identidade do processo
(`processo_id`, estável). Os quatro testes de corrida "escritor vence"
(§4, A1–A5) provam isto por mutação: reintroduzindo deliberadamente a
leitura combinada pré-lock (a versão v1.2), os cinco cenários falham com
valores financeiros/lifecycle vindos do fato ANTIGO — a prova empírica de
que o teste, e não só a leitura do código, detecta a regressão.

## 2. Ganchos `_teste*` adicionados (só teste, nenhuma rota os expõe)

| Gancho | Em | Dispara | Usado por |
|---|---|---|---|
| `_testeAguardarAntesDoCommit` | `ApplyObservationInput` (`containerRepository.ts`) | Imediatamente antes do `COMMIT` do wrapper autônomo `applyObservation`, com o fato já persistido/promovido e o lock consultivo ainda retido. | Testes A1, A4, A5 (descarga, equipamento, retorno). |
| `_testeAguardarAntesDoCommit` | `PromoverHouseFreeTimeInput` (`houseFreeTimeService.ts`) | Mesmo ponto, dentro de `promoverHouseFreeTimeComClient`, antes do `return` ao wrapper autônomo. | Testes A2, B. |
| `_testeAguardarAntesDoCommit` | `PromoverMasterFreeTimeInput` (`masterFreeTimeService.ts`) | Mesmo ponto, dentro de `promoverMasterFreeTimeComClient`. | Testes A3, D. |
| `_testeAposSnapshotPosLock` | `RecalcularConfig` (`recalcularApuracao.ts`) | Depois que o instantâneo pós-lock inteiro já foi relido (passo 4), antes de calcular relógios/valores/lifecycle. | Teste B ("recálculo vence"). |
| `_testeAntesDoLock` | `RecalcularConfig` (`recalcularApuracao.ts`) | Depois da identidade do processo (passo 1, sem lock) e ANTES do lock consultivo (passo 2). | Testes A1–A5 (sincronização de dois estágios — ver §3). |

## 3. Por que os testes A precisam de sincronização de DOIS estágios

Os testes "escritor material vence" (A1–A5) precisam provar que o
recálculo **de fato esperou** o lock consultivo enquanto o escritor ainda
estava pausado (uncommitted) — não que, por coincidência de timing, o
recálculo só começou a rodar depois que o escritor já tinha comitado por
conta própria (nesse caso o teste passaria mesmo numa implementação com o
achado bloqueante, porque não haveria mais fato "velho" para ler no momento
em que o recálculo finalmente consultasse o banco — exatamente o que a
primeira tentativa desta entrega revelou ao sabotar deliberadamente o
código de volta à v1.2: a corrida só era genuína quando a sincronização
media o ponto exato antes do pedido de lock).

Por isso cada teste A usa dois portões determinísticos encadeados:

1. O escritor pausa dentro do próprio `_testeAguardarAntesDoCommit` — já
   escreveu o fato novo (uncommitted) e retém o lock consultivo + `FOR
   UPDATE` do processo/contêiner.
2. **Só então** o recálculo é iniciado, com `_testeAntesDoLock` — ele faz a
   identidade (passo 1, trivial, sem lock) e pausa exatamente ANTES de
   chamar `lockProcesso`.
3. O teste aguarda a confirmação do recálculo pausado (passo 2) e **só
   então** libera, nesta ordem: primeiro o recálculo (que agora dispara o
   pedido de lock ao Postgres — e bloqueia, porque o escritor ainda não foi
   liberado), depois o escritor (que comita, liberando o lock).

Esta ordem garante, por construção do Postgres (não por sorte de
agendamento do event loop), que o PEDIDO de lock do recálculo chega ao
servidor **antes** do commit do escritor — contenção real, reproduzível,
sem sleep.

## 4. Os 4 testes de corrida obrigatórios — evidência

Arquivo: `src/demurrage-engine/__tests__/closingD15AV13.test.ts`.

### A — escritor material vence (5 subcasos)

Cada subcaso parte do mesmo cenário com demurrage real (descarga
2026-09-01, House FT 5, Master FT 100, retorno de tracking 2026-09-10,
20DV, tabela Rocket semeada — cliente em 5 dias de demurrage, US$750,
provado em `apuracao.test.ts`). O escritor muda um fato, pausa retendo o
lock (§3); o recálculo concorrente só prossegue depois do commit do
escritor e usa o fato **novo**:

| Subcaso | Fato mudado | Prova | Esperado × Encontrado |
|---|---|---|---|
| A1 | Descarga 09-01 → 09-03 | `calcularDoisRelogios` com a descarga nova dá 3 dias/US$450 — `relogios.dias_demurrage` e `valores_apurados.total` do cliente igual a isso, nunca os 5 dias/US$750 do fato antigo. | ✅ |
| A2 | House FT 5 → 2 | Mesmo princípio: 8 dias/US$1200 esperados e encontrados (não 5/US$750). | ✅ |
| A3 | Master FT 100 → 3 | Relógio Rocket: 0 dias (velho) → 7 dias (novo). Como não há tabela do armador semeada, o motor devolve `UNAVAILABLE` (gap 5, comportamento inalterado) — mas uma linha **ATIVA** em `valores_apurados` só existe quando o cálculo usou o Master FT novo (com o antigo, 0 dias, nenhuma linha seria criada — ramo `else`/supersede). A existência da linha é a prova financeira, já que `dias_cobrados` fica `NULL` por desenho quando `UNAVAILABLE` (gap 5 — nada foi tarifado). | ✅ |
| A4 | Equipamento 20DV → 40HC | Dias inalterados (equipamento não afeta o relógio) — US$750 (20DV) vs US$1250 (40HC) esperado/encontrado: só a tarifa muda. | ✅ |
| A5 | Retorno de tracking 09-10 → 09-13 | `data_final_apuracao` do relógio e dias cobrados batem com o retorno NOVO (8 dias/US$1200), nunca o antigo (5/US$750). | ✅ |

**Verificação por mutação:** reintroduzindo deliberadamente a leitura
combinada pré-lock da v1.2 (patch temporário, nunca comitado), os cinco
subcasos falham — A1/A2/A4/A5 na asserção de `valores_apurados` (dias/
total vindos do fato velho); A3 na asserção de que existe uma linha ATIVA
em `valores_apurados` para o relógio Rocket (com o Master FT antigo, 0
dias, nenhuma linha seria criada). Restaurada a correção, os cinco voltam a
passar. Esta é a prova de que os testes detectam o achado, não apenas o
código-fonte.

### B — recálculo vence

O recálculo pausa (via `_testeAposSnapshotPosLock`) imediatamente depois
do seu próprio instantâneo pós-lock inteiro — ainda com os fatos antigos,
porque nada mudou até este ponto (House FT = 5). Um escritor de House Free
Time (novo valor = 2) é então iniciado — bloqueia naturalmente em
`lockProcesso`, porque o recálculo ainda retém o lock. O recálculo é
liberado: comita com os fatos **corretos para o instante em que os leu**
(5 dias/US$750 — não é um erro retroativo, era a verdade no momento em que
a trava foi tomada). O escritor prossegue, promove House FT=2 e, como
`valorMudou=true`, enfileira `recalculo_outbox` (`tipo='house_free_time'`,
`estado='PENDING'`). Prova: `house_free_time_days=2` persistido (nada
perdido), relógio/valor ainda refletem 5 dias/US$750 (o recálculo não os
recalculou de novo sozinho), e existe exatamente um item `PENDING` no
outbox — a garantia de que um recálculo subsequente (worker do outbox, já
existente desde D15-A v1.1) vai corrigir a projeção. Nenhuma atualização é
perdida; apenas fica, por desenho, pendente de um próximo ciclo.

### C — FINAL vence

`finalizarProcesso` pausa imediatamente antes do `COMMIT` (FINAL já
escrito na transação, ainda não visível a outras — lock consultivo
retido). O recálculo concorrente só adquire o lock depois do commit da
finalização, relê `apuracao_status` fresco sob o `FOR UPDATE` do passo 3 e
devolve `{ skipped: 'FINAL', containerId }` **sem tocar nada**. Prova:
dois fingerprints do contêiner (containers + relógios + valores_apurados)
— um capturado imediatamente depois do commit da finalização, outro
depois do retorno do recálculo — são `deepStrictEqual`. Como o recálculo
no caminho FINAL retorna antes de qualquer `FOR UPDATE` no contêiner ou
qualquer gravação, os dois fingerprints são idênticos por construção;
o teste confirma isso empiricamente.

### D — processo multi-contêiner

Dois contêineres (A e B) no mesmo processo, cenário zero-custo (House/
Master FT = 20, sem demurrage — necessário para que `finalizarProcesso`
feche pelo caminho `ZERO_CONFIRMADO`, sem exigir minuta/confirmação
financeira, igual ao padrão já usado pelos testes de FINAL da v1.1/v1.2).
Um escritor de Master Free Time no contêiner B (novo valor = 15) pausa
retendo o lock consultivo do PROCESSO (o mesmo lock que `finalizarProcesso`
usa — não há lock por contêiner). `finalizarProcesso` é então iniciado —
bloqueia no mesmo lock consultivo (a MESMA trava que protege o processo
inteiro, nunca uma por contêiner, então não há como dois contêineres do
mesmo processo entrarem em ciclos independentes entre si). O escritor é
liberado, comita; `finalizarProcesso` prossegue, trava **todos** os
contêineres do processo de uma vez (`FOR UPDATE ... ORDER BY id`, código
inalterado desde a v1.1) e, para cada um, chama
`recalcularApuracaoContainerComClient` (a função corrigida nesta versão).
Prova: sem deadlock (ambas as promessas resolvem), finalização com
sucesso, `apuracao_status = 'FINAL'`; o relógio Rocket do contêiner B usa
o Master FT **novo** (15) — `primeiro_dia_demurrage = 2026-09-16`, nunca
uma mistura com o antigo (20 → `2026-09-21`, data diferente, prova
direta); o contêiner A, não raceado, permanece correto e consistente com
seus próprios fatos (nunca contaminado pela corrida em B).

## 5. Auditoria estática fortalecida — AST em vez de linha a linha

### 5.1 A fragilidade do scanner da v1.2

O scanner anterior (regex linha a linha, `closingD15AV12.test.ts`) exigia
o nome da função e o `(` de abertura na **mesma linha de texto**. Uma
chamada quebrada entre linhas —

```ts
promoverMasterFreeTimeComClient
  (client, input)
```

— não seria detectada: um chamador de produção REAL ficaria sem auditoria,
e o teste passaria silenciosamente (falso negativo). Isto não chegou a
acontecer em nenhum chamador real desta entrega, mas era uma lacuna
estrutural do próprio scanner, explicitamente apontada pelo achado desta
versão.

### 5.2 A correção — travessia de AST do compilador TypeScript

Substituído por uma travessia da AST real (`typescript` — já dependência
transitiva via `ts-node`, nenhuma dependência nova):

```ts
const sourceFile = ts.createSourceFile(caminho, codigo, ts.ScriptTarget.Latest, true);
// percorre com ts.forEachChild, procurando ts.isCallExpression(node)
// cujo node.expression seja um Identifier (chamada não qualificada)
// ou um PropertyAccessExpression com .name Identifier (chamada qualificada)
```

Uma `CallExpression` na AST é a MESMA chamada independentemente de quebras
de linha ou espaços — a análise é puramente sintática (sem resolução de
tipos: não importa a QUEM o método pertence, só o nome escrito, que é
exatamente o que a auditoria precisa confirmar). Por construção, uma
declaração (`function nome(){}`, `static async nome(){}`, um método de
classe) ou um `import { nome }` **nunca** é uma `CallExpression` — a
exclusão que o scanner antigo precisava fazer com regex explícita (linhas
de declaração, linhas de comentário) deixa de ser necessária: a própria
forma da AST já garante isso. Detecta chamada qualificada
(`Algo.nomeFuncao(...)`) e não qualificada (`nomeFuncao(...)`) na mesma
passada.

### 5.3 Novo escopo auditado — as funções de recálculo

Como `recalcularApuracaoContainerComClient`/`recalcularApuracaoProcessoComClient`
agora adquirem o lock consultivo compartilhado do processo (§1.2) e têm a
MESMA precondição de ordem de chamador que as demais funções `*ComClient`
(nenhum `FOR UPDATE` anterior sem `lockProcesso` primeiro), ambas entraram
em `CHAMADORES_AUDITADOS_COM_CLIENT`:

| Função | Chamador | Por que é seguro |
|---|---|---|
| `recalcularApuracaoContainerComClient` | `recalcularApuracaoContainer`/`recalcularApuracaoProcessoComClient` (mesmo arquivo) | O wrapper autônomo abre `BEGIN`/`COMMIT` próprios (nenhum lock pré-existente); o laço roda dentro da transação do SEU próprio chamador (`autorizarReabertura`), que já adquiriu o consultivo antes de chamá-lo. |
| `recalcularApuracaoContainerComClient` | `closingService.ts` → `finalizarProcesso`, `validarMinuta` | `lockProcesso` já adquirido no passo 2 de cada uma, antes do `FOR UPDATE` em `processos`/`containers` e antes desta chamada. |
| `recalcularApuracaoProcessoComClient` | `closingService.ts` → `autorizarReabertura` | `lockProcesso` já adquirido no passo 2, antes do `FOR UPDATE` em `reaberturas`/`processos` e antes desta chamada. |

As quatro funções já auditadas desde a v1.2
(`applyObservationComClient`/`promoverHouseFreeTimeComClient`/
`promoverMasterFreeTimeComClient`/`fatoMaterialBloqueadoPorFinal`)
permanecem com a MESMA lista de chamadores — nenhum chamador novo surgiu
para elas nesta versão.

O teste único (`closingD15AV12.test.ts`, mantido no mesmo arquivo — não
duplicado para v1.3) agora varre as **seis** funções e confere, para cada
uma, que o conjunto de arquivos encontrado pela AST é exatamente o
documentado — tanto um chamador novo sem auditoria quanto uma entrada da
auditoria sem chamador real (`CHAMADORES_AUDITADOS_COM_CLIENT` desatualizado)
fazem o teste falhar.

## 6. Arquivos alterados (exatos)

### Novos

| Arquivo | Conteúdo |
|---|---|
| `src/demurrage-engine/__tests__/closingD15AV13.test.ts` | Os 8 testes desta versão (§4: A1–A5, B, C, D). |
| `docs/demurrage-fase-d15-a-v1-3.md` | Este documento. |

### Alterados — produção

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/apuracao/recalcularApuracao.ts` | `recalcularApuracaoContainerComClient` reescrito na ordem do §1.2 (identidade → lock → processo `FOR UPDATE` → guard FINAL → contêiner `FOR UPDATE` → condição comercial → cálculo). Novos ganchos `_testeAntesDoLock`/`_testeAposSnapshotPosLock` (só teste) em `RecalcularConfig`. |
| `src/demurrage-engine/persistence/containerRepository.ts` | Novo gancho `_testeAguardarAntesDoCommit` (só teste) em `ApplyObservationInput`, propagado ao wrapper `applyObservation` (genérico e via delegação a `promoverMasterFreeTime`). |
| `src/demurrage-engine/freeTime/houseFreeTimeService.ts` | Novo gancho `_testeAguardarAntesDoCommit` (só teste) em `PromoverHouseFreeTimeInput`, disparado antes do `return` de `promoverHouseFreeTimeComClient`. |
| `src/demurrage-engine/freeTime/masterFreeTimeService.ts` | Mesmo gancho em `PromoverMasterFreeTimeInput`, disparado antes do `return` de `promoverMasterFreeTimeComClient`. |
| `src/demurrage-engine/closing/materialChangeGuard.ts` | `CHAMADORES_AUDITADOS_COM_CLIENT` ampliado com `recalcularApuracaoContainerComClient`/`recalcularApuracaoProcessoComClient` (§5.3). Cabeçalho ampliado com o relato do achado bloqueante desta versão. |
| `src/demurrage-engine/__tests__/closingD15AV12.test.ts` | Scanner de auditoria estática substituído por travessia de AST (§5.2); teste único agora cobre as seis funções auditadas. Os 7 testes originais da v1.2 permanecem intactos. |

Nenhuma rota, nenhum arquivo de frontend, nenhum motor tarifário, nenhuma
regra de cadência/crédito de tracking foi tocado. Nenhuma trigger de banco
nova.

## 7. Migrations

**Nenhuma migration foi criada ou editada.** Migration `0035` permanece
intocada. O achado bloqueante desta versão é puramente de ORDEM DE LEITURA
(que insumo de cálculo é lido antes vs. depois do lock) — não exige nova
estrutura de dados, nova constraint ou novo índice. Os guards de banco já
existentes (trigger `demurrage.relogio_writer`, migrations 0017/0018 para
o congelamento de FINAL) continuam sendo a defesa em profundidade,
inalterados.

## 8. Totais de teste — regressão completa

Executado sequencialmente contra PostgreSQL 16 real
(`DEMURRAGE_TEST_DATABASE_URL` → `priora_demurrage_test`):

| Suíte | Resultado |
|---|---|
| D15-A v1.0 (`closingD15A.test.ts`) | **16/16**, preservados sem alteração |
| D15-A v1.1 (`closingD15AV11.test.ts`) | **14/14**, preservados sem alteração |
| D15-A v1.2 (`closingD15AV12.test.ts`) | **7/7**, preservados; auditoria estática agora cobre 6 funções (§5) |
| D15-A v1.3 (`closingD15AV13.test.ts`) | **8/8** — novos, §4 |
| Suíte completa da Demurrage Engine (`npm run test:demurrage-engine` — inclui recálculo/relógios/lifecycle, registro D10, Shipping Instructions, closing/reabertura, D11, D12, D14 e todo o D15-A acima) | **854/857**, 0 pulados — ver achado pré-existente abaixo |
| V1 (`npm test`) | **25/25** |
| D13 UI (`npm run test:demurrage-ui`) | **66/66** |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

Os 5 testes A (§4) foram adicionalmente validados por **mutação**: com a
leitura combinada pré-lock da v1.2 reintroduzida deliberadamente (patch
temporário, nunca comitado nesta entrega), todos os 5 falham; restaurada a
correção, todos os 5 voltam a passar — a prova de que detectam o achado
bloqueante, não apenas documentam a correção.

### Achado pré-existente, confirmado NÃO relacionado a esta correção

As 3 falhas remanescentes na suíte completa são as mesmas, nos mesmos 2
subtestes, do arquivo `leituraAutorizacao.test.ts` (D12 Gate G6 — RBAC e
isolamento): `HTTP: fluxo feliz resolve a organização real` e `HTTP:
CLIENT recebe 403` recebem HTTP 500 do servidor de teste em vez de 200/403
(uma exceção não tratada dentro do middleware `criarAutorizarInterno()` —
módulo D12, nunca tocado por esta entrega). Confirmado, via `git stash` das
seis alterações de produção desta versão e reexecução isolada do mesmo
arquivo, que a MESMA falha, com o MESMO erro, já ocorre no commit base
`368a986` (antes de qualquer mudança desta entrega) — portanto não é uma
regressão introduzida pela correção v1.3, é um defeito pré-existente e
ortogonal (D12, Gate G6), fora do escopo desta entrega (D15-A). Fica
registrado aqui para rastreabilidade; não foi corrigido por não ser D15-A.

## 9. O que esta entrega NÃO faz

- Não declara D15-A aprovada nem congelada.
- Não inicia D15-B, D15-C ou D16.
- Não adiciona rota, ação de frontend ou escopo de produto novo.
- Não edita a migration `0035`. Não cria migration nova (justificado em §7).
- Não altera nenhuma regra de negócio congelada de D10–D14.
- Não corrige o achado pré-existente de `leituraAutorizacao.test.ts`
  (D12 Gate G6) — confirmado fora do escopo e não introduzido por esta
  correção (§8).

Entrega para nova auditoria.
