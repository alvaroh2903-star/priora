# Produção P1 — Entrega 1, corretiva v1.2 (segurança transacional final)

**Branch:** `claude/practical-cerf-mnz7oj`
**Base:** Entrega 1 v1.1, commit `d2db21f`
**Migrations tocadas:** nenhuma (0040 e 0041 permanecem intactas — corretiva só de aplicação e configuração)
**Frontend tocado:** nenhum arquivo (confirmado por teste executável e por `git status`, §7)

A auditoria da v1.1 foi aprovada nos três achados de identidade (vínculo
estável do processo, identidade imutável do evento, sanitização de erros).
Esta corretiva resolve os dois últimos achados bloqueantes, ambos
exclusivamente dentro de `resolverVinculoProcesso` (`handoff/handoffService.ts`):
(1) a conexão reservada do lock consultivo podia voltar ao pool dentro de
uma transação aberta ou abortada; (2) o `INSERT ... ON CONFLICT DO NOTHING`
do vínculo podia reportar sucesso mesmo quando um vínculo pré-existente ou
gravado por fora apontava para outro processo interno.

---

## 1. Causa raiz de cada achado

### 1.1 — Conexão podia voltar ao pool em transação aberta/abortada

O código da v1.1 tinha exatamente um caminho de `ROLLBACK` explícito — o
`catch` do erro do D10 que **não** é `PosCommitIncompletoError` — e nenhum
rastreamento do estado da transação. Qualquer outra falha entre o `BEGIN` e
o `COMMIT` (a própria query do lock consultivo, a leitura do vínculo, o
`INSERT` do vínculo, ou o `COMMIT` em si) pulava direto para o
`finally { lockClient.release() }`, devolvendo ao pool uma conexão PostgreSQL
ainda dentro de uma transação iniciada e nunca finalizada — a próxima
chamada a pegar essa conexão do pool herdaria esse estado indeterminado
(uma transação aberta que nenhum código novo sabia que existia, ou, pior,
uma transação já abortada pelo Postgres que rejeitaria qualquer comando
seguinte com `current transaction is aborted`).

### 1.2 — Conflito oculto no `INSERT` do vínculo

`INSERT INTO demurrage_handoff_processo_links (...) ON CONFLICT (...) DO
NOTHING` nunca verificava se o `DO NOTHING` disparou porque o vínculo já
existia **apontando para outro processo**. Sob o fluxo normal (concorrência
entre chamadas desta própria função), isso nunca acontece — o lock
consultivo serializa qualquer disputa antes do `INSERT` ser alcançado. Mas
nada impedia um vínculo gravado **por fora** dessa serialização (um script
manual, uma migração de dados, um bug em outro lugar) de already existir
quando esta função chegasse ao `INSERT` — e nesse caso a função
simplesmente devolveria `resolvido`, como se a aplicação ao D10 (já feita,
com outro `processoId`) tivesse sido vinculada corretamente.

---

## 2. Máquina de estados da transação (correção)

`resolverVinculoProcesso` agora rastreia o estado da transação numa
variável explícita, `transacaoAberta`, e garante que **toda saída** depois
de um `BEGIN` bem-sucedido passa por exatamente um dos dois caminhos:

```
BEGIN bem-sucedido
  └─ transacaoAberta = true
       │
       ├─ sucesso (leitura do vínculo OU INSERT+verificação) ──► COMMIT ──► transacaoAberta = false ──► return
       │
       └─ QUALQUER exceção (lock, leitura, D10 não-PosCommitIncompleto, INSERT, COMMIT)
              │
              ▼
          catch externo: transacaoAberta ainda true?
              │
              ├─ sim ──► tenta ROLLBACK (ou o gancho de teste que o substitui)
              │             │
              │             ├─ ROLLBACK bem-sucedido ──► transacaoAberta = false ──► throw erro ORIGINAL
              │             │
              │             └─ ROLLBACK também falha ──► liberarComoSuja = erro do rollback
              │                                            transacaoAberta = false
              │                                            throw erro ORIGINAL (nunca o do rollback)
              │
              └─ não (já tinha comitado) ──► throw erro ORIGINAL (nada a fazer)
       │
       ▼
   finally: lockClient.release(liberarComoSuja)
```

Dois pontos de projeto:

- **Nenhum `release()` cego.** O `finally` sempre chama
  `lockClient.release(liberarComoSuja)`. Quando `liberarComoSuja` é
  `undefined` (o caso comum — COMMIT ou ROLLBACK bem-sucedidos), isso é uma
  liberação normal. Quando o ROLLBACK **também** falhou, `liberarComoSuja`
  recebe o erro do rollback — e `PoolClient.release(err)`, da própria
  biblioteca `pg`, instrui o `pg-pool` a **descartar** essa conexão física
  em vez de devolvê-la ao pool para reuso. Uma conexão cujo estado
  transacional não pudemos confirmar como limpo nunca volta a ser
  emprestada — ela é fechada, e o pool abre uma nova na próxima necessidade.
- **O erro original nunca é substituído.** O `throw erro` final sempre
  relança o erro de negócio ORIGINAL que entrou no `catch`, nunca o erro do
  rollback (que só é usado para decidir `liberarComoSuja` e para o log —
  nunca propagado). Provado pelo teste #9 (§5).

Não foi introduzido um helper genérico de transação (`comTransacao(...)`
ou similar) — a máquina de estados acima é específica desta função (tem
dois pontos de `COMMIT` possíveis e um gancho de teste condicional no
`ROLLBACK`, que um helper genérico tornaria mais opaco, não mais seguro) e
reduz exatamente o risco apontado, sem adicionar uma abstração nova ao
módulo.

---

## 3. Comportamento de rollback e sanitização

A falha do `ROLLBACK` (quando ocorre) é tratada com a MESMA disciplina de
sanitização já estabelecida na v1.1 (achado #3): `classificarFalhaHandoff`
é a única função que decide o que é logado, e ela nunca lê `.message`,
`.stack`, corpo da requisição, assinatura ou segredo — só `instanceof` e o
código SQLSTATE fixo de 5 caracteres do driver `pg`. A linha de log
(`console.error`) do rollback-que-também-falhou usa exclusivamente esse
código fechado. Nenhuma persistência adicional foi criada para esse caso —
o erro ORIGINAL já segue o caminho normal de `classificarFalhaHandoff` /
`concluirEvento` em `processarEventoHandoff`, como antes.

---

## 4. Verificação do conflito no `INSERT` do vínculo

O `INSERT` agora usa `RETURNING processo_id`:

```sql
INSERT INTO demurrage_handoff_processo_links (organization_id, origem_sistema, origem_processo_id, processo_id)
VALUES ($1, $2, $3, $4) ON CONFLICT (organization_id, origem_sistema, origem_processo_id) DO NOTHING
RETURNING processo_id AS "processoId"
```

- Se `RETURNING` devolve uma linha: foi esta chamada que acabou de gravar o
  vínculo — `processoIdPersistido` é trivialmente o mesmo `processoId` que
  acabamos de produzir. Nenhuma query extra no caminho comum.
- Se `RETURNING` devolve zero linhas: o `DO NOTHING` disparou — uma
  **releitura autoritativa**, ainda dentro da mesma transação/lock, busca o
  vínculo persistido (`processo_id` + `numero_processo`, mesmo JOIN usado na
  leitura inicial).
- Antes de devolver `resolvido`, a função exige
  `processoIdPersistido === processoIdEstabelecido`. Uma divergência
  devolve `{ tipo: 'conflito', processoIdVinculado, numeroProcessoVinculado }`
  explícito — nunca "resolvido por engano".
- O vínculo já persistido **nunca é mutado ou reatribuído** — a função só
  constata; o trigger append-only da migration 0041
  (`demurrage_handoff_processo_links_append_only`) impediria de qualquer
  forma um `UPDATE`.

**Nota sobre zero-escrita neste caminho patológico:** quando o conflito
oculto é detectado, o D10 **já pode ter aplicado** `entradaD10` contra
`processoIdEstabelecido` nesta mesma chamada — não há como desfazer uma
transação já comitada dentro de `registrarProcessoDemurrage` (conexão e
transação próprias, separadas do lock consultivo). Isto é diferente do
conflito NORMAL (vínculo já existia, verificado **antes** do D10 ser
chamado — ver v1.1 testes #3/#4), que continua sendo estritamente
zero-escrita. O conflito oculto é defesa em profundidade contra um vínculo
gravado por fora do lock consultivo desta função (nunca pode ser outra
chamada desta própria função, que está serializada por aquele mesmo lock)
— um cenário que o desenho normal (achado #1 da v1.1) já torna
extremamente improvável, mas que agora é detectado e reportado em vez de
mascarado como sucesso.

---

## 5. Ganchos de teste e prova de inalcançabilidade pelo HTTP

`GanchosTesteResolverVinculo` (interface exportada só para a suíte de
teste) define cinco pontos de injeção: `antesDoLockConsultivo`,
`antesDaLeituraDoVinculo`, `antesDoInsertDoVinculo`, `antesDoCommit`,
`antesDoRollback`. Cada um, se lançar, interrompe a transação exatamente no
ponto que nomeia.

`resolverVinculoProcesso` é exportada para a suíte de teste chamar
diretamente, mas `processarEventoHandoff` — o **único** ponto de entrada
que a rota HTTP (`demurrageHandoffRoutes.ts`) usa — invoca
`resolverVinculoProcesso(pool, ctx.organizationId, norm, entradaD10)` **sem
o 5º argumento**. Não existe rota, campo do contrato ou variável de
ambiente que alcance esse parâmetro — confirmado por leitura direta de
`demurrageHandoffRoutes.ts` (só importa `processarEventoHandoff`) e por
`tsc --noEmit` (o parâmetro é opcional e nunca referenciado fora do arquivo
de teste e da própria função).

---

## 6. Auditoria de uso do pool — tamanho mínimo exigido

`resolverVinculoProcesso` mantém **uma conexão reservada em transação**
(`lockClient`, com o lock consultivo já adquirido) durante toda a janela em
que chama `registrarProcessoDemurrage` (D10) — e o D10 pega sua **própria**
conexão do **mesmo** pool (`pool.connect()` interno, em
`registrarProcessoDemurrage.ts:272`) para a transação principal dele. Com
`max = 1`, a segunda chamada a `pool.connect()` nunca teria uma conexão
livre: ela ficaria bloqueada esperando a primeira liberar — mas a primeira
está bloqueada esperando a segunda terminar. **Autobloqueio determinístico,
não uma condição de corrida rara** — reproduzido deliberadamente durante o
desenvolvimento desta corretiva (um teste inicial com `max: 1` travou o
processo de teste em "idle in transaction" exatamente como descrito aqui).

**Correção:** `src/demurrage-engine/db/pool.ts` agora resolve `max`
explicitamente (`resolverPoolMax()`), lendo a variável opcional
`DEMURRAGE_DATABASE_POOL_MAX`:

- Variável ausente → `10` (o mesmo padrão histórico da biblioteca `pg`,
  agora uma decisão **explícita e documentada**, não mais implícita).
- Variável presente e `< 2` → **falha de configuração na subida**
  (`throw` síncrono em `getPool()`, antes de qualquer tentativa de
  conexão), com mensagem nomeando a causa exata (a janela de duas conexões
  simultâneas que o handoff precisa).
- Variável presente e `>= 2` → aceita.

A configuração de produção atual nunca definiu `DEMURRAGE_DATABASE_POOL_MAX`
nem qualquer outro override de `max` — ou seja, já operava com o padrão
`10` da biblioteca `pg`, que é seguro. Esta corretiva não muda o
comportamento de produção; ela torna o requisito mínimo **explícito e
validado**, em vez de uma suposição implícita do padrão de uma biblioteca
de terceiros. Teste dedicado (`v1.2: pool de produção exige max >= 2 …`)
prova as quatro combinações (ausente, `0`, `1`, `2`).

---

## 7. Comportamento preservado (não redesenhado)

Nenhuma das garantias já aprovadas foi alterada: autenticação HMAC,
tolerância de timestamp, proteção de replay por nonce, criptografia de
credencial, derivação de organização pela credencial, adaptador HTTP fino,
chamada oficial de registro do D10, reconciliação de backlog de Shipping
Instructions, exigência de reabertura em `FINAL`, campos operacionais
proibidos, proibição de fallback manual. O D10 (`registrarProcessoDemurrage`)
não foi tocado — seu próprio par `BEGIN/COMMIT/ROLLBACK/finally` (linhas
272-283) tem uma forma semelhante à que esta corretiva endureceu em
`resolverVinculoProcesso`, mas está **fora do escopo** desta corretiva
(limitada explicitamente a `resolverVinculoProcesso` pelo usuário) e não
foi modificado.

---

## 8. Evidência de teste (PostgreSQL real)

### 8.1 Suíte nova — `handoffVinculoTransacaoV12.test.ts` (15/15, 100% verde)

| # | Cenário | Resultado |
|---|---|---|
| 1 | Primeiro vínculo bem-sucedido comita normalmente | ok |
| 2 | Vínculo existente e compatível é NO-OP (zero escrita extra) | ok |
| 3 | Vínculo existente e `numeroProcesso` divergente conflita (zero escrita) | ok |
| 4 | Falha forçada ANTES do INSERT (na leitura) → ROLLBACK, zero escrita, D10 nunca chamado | ok |
| 5 | Falha forçada DURANTE o INSERT → ROLLBACK, nenhum vínculo persistido | ok |
| 6 | Falha forçada no COMMIT → ROLLBACK, nenhum vínculo persistido | ok |
| 7 | Depois de cada falha, a conexão do pool (mínimo seguro, max=2) executa transação limpa | ok |
| 8 | Retry depois da falha, causa removida, aplica normalmente | ok |
| 9/10 | Rollback também falha → erro ORIGINAL relançado; log sem segredo, só classificação fechada | ok |
| 11 | Entregas concorrentes idênticas continuam convergindo | ok |
| 12 | Entregas concorrentes conflitantes continuam com vencedor determinístico | ok |
| 13 | Replay de evento concluído continua zero-escrita | ok |
| 14 | Migrações 0001→0041 intactas — nenhuma migration nova nesta corretiva | ok |
| 15 | Nenhum arquivo de frontend entre as mudanças | ok |
| — | Pool de produção exige `max >= 2` (4 combinações) | ok |

Os testes 4/5/6 usam ganchos de injeção determinística (§5); o teste 9/10
combina um erro ORIGINAL marcado e um erro de ROLLBACK marcado — a
asserção confirma que a rejeição é exatamente o erro ORIGINAL (comparação
de mensagem) e que **nenhum** dos dois marcadores (nem o original, nem o do
rollback, que embute um texto parecido com segredo) aparece em
`console.error` capturado — só a classificação fechada `FALHA_INESPERADA`.

### 8.2 Suíte v1.1 (`handoffProducaoP1V11.test.ts`) + suíte original da Entrega 1 (`handoffProducaoP1.test.ts`) — reexecutadas juntas

**42/42 testes — 100% verde** (19 da v1.1 + 23 da Entrega 1 original), sem
nenhuma alteração de comportamento. A primeira tentativa de rodar essa
dupla nesta corretiva reportou 8 falhas — causa identificada como um erro
de invocação do comando de teste (a variável `DEMURRAGE_DATABASE_URL` não
tinha sido exportada naquela chamada específica, então a rota HTTP real do
teste #16 não conseguia resolver o pool de produção); reexecutada com a
variável exportada corretamente, 42/42 passam — não é uma regressão de
código.

### 8.3 Regressão completa

- **Suíte completa do Demurrage Engine** (`npm run test:demurrage-engine`): **1034/1034 testes — 100% verde, 0 falhas** (execução completa contra PostgreSQL real, schema recriado do zero antes da corrida; inclui as 15 suítes novas desta corretiva, as 42 da v1.1/Entrega 1 reexecutadas, e todas as entregas D1–D16 e v1.x anteriores sem nenhuma regressão).
- **V1** (`npm test`): 25/25 passam.
- **D13 UI** (`npm run test:demurrage-ui`, navegador real): 66/66 passam — zero regressão de frontend.
- **`tsc --noEmit`**: limpo.
- **`npm run build`**: limpo.

---

## 9. Migrações

Nenhuma migration nova nesta corretiva. 0040 e 0041 permanecem exatamente
como a v1.1 as deixou — confirmado pelo teste #14 (migração limpa
0001→0041, e uma segunda chamada a `runMigrations` é um no-op). Esta
corretiva é inteiramente de aplicação (`handoff/handoffService.ts`) e
configuração (`db/pool.ts`).

---

## 10. Nenhuma mudança de frontend

Confirmado por `git status --porcelain`: os únicos arquivos tocados são
`src/demurrage-engine/db/pool.ts`, `src/demurrage-engine/handoff/handoffService.ts`,
o novo `src/demurrage-engine/__tests__/handoffVinculoTransacaoV12.test.ts`
e este relatório. Nenhum caminho sob `public/`, nenhum `.html`, nenhum
`.css`. HTML, CSS, JavaScript de apresentação, Sidebar, Portal e D13 não
foram tocados — confirmado também pelo teste executável #15 e pela suíte
D13 UI (navegador real, §8.3) permanecendo 66/66 verde.

---

## 11. Status

Os dois achados bloqueantes da auditoria de segurança transacional
(conexão podendo voltar ao pool em transação aberta/abortada; conflito
oculto no `INSERT` do vínculo) estão corrigidos e comprovados por teste
determinístico contra PostgreSQL real, sem regressão em nenhuma suíte
existente.

**Produção P1 não está declarada completa.** Esta corretiva encerra o
trabalho de código pendente para a Entrega 1; o próximo passo é a decisão
final de congelamento da Entrega 1 pelo usuário. Entrega 2, Entrega 3 e
qualquer trabalho de frontend permanecem não iniciados.
