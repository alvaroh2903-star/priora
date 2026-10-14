# Produção P1 — Entrega 1, corretiva v1.3 (segurança sob concorrência próxima ao limite do pool)

**Branch:** `claude/practical-cerf-mnz7oj`
**Base:** Entrega 1 v1.2, commit `8da3e3c`
**Migrations tocadas:** nenhuma
**Frontend tocado:** nenhum arquivo

A revisão final da v1.2 apontou corretamente que a validação `pool.max >= 2`
só prova que **uma chamada isolada** de `resolverVinculoProcesso` não se
autobloqueia — não prova nada sob **concorrência**. Esta corretiva
investiga o risco apontado, reproduz a falha com um teste determinístico e
com prazo explícito, e aplica a menor correção estrutural suficiente para
eliminá-la.

---

## 1. Investigação — o starvation foi reproduzido

**Sim, foi reproduzido**, exatamente como descrito na revisão, antes de
qualquer alteração de código.

- **Max do pool usado:** 2 (e também testado com 3).
- **Número de chamadas concorrentes:** igual ao max do pool (2 chamadas
  contra pool max=2; depois 3 contra pool max=3), cada uma para uma
  **identidade a montante DIFERENTE** (`origemProcessoId` distinto, sem
  nenhuma contenção no lock consultivo entre elas).
- **Starvation reproduzido:** sim — um script de investigação (não
  comitado) chamou `resolverVinculoProcesso` diretamente, N vezes em
  paralelo, contra um pool `max = N`. Com um prazo manual de 8 segundos
  (`Promise.race`), a chamada combinada **nunca resolveu** — timeout
  disparado toda vez.
- **Confirmação ao nível do banco:** consultando `pg_stat_activity` durante
  o travamento, as N conexões apareciam como `idle in transaction`,
  todas paradas exatamente na MESMA query (a leitura do vínculo,
  `SELECT l.processo_id ... FROM demurrage_handoff_processo_links ...`),
  confirmando que cada uma já tinha avançado até ali e estava esperando a
  SEGUNDA conexão (para o D10) que nunca ficaria livre. O próprio `pool.end()`
  do script de investigação também ficou pendurado (espera por clientes em
  uso) — precisou de `kill -9` no processo e `pg_terminate_backend` manual
  para limpar.

## 2. Causa exata

`resolverVinculoProcesso` adquire uma conexão (`lockClient`) do `pool`
**compartilhado**, abre uma transação, adquire o lock consultivo, e então
— quando o vínculo ainda não existe — chama `registrarProcessoDemurrage`
(D10) passando o **MESMO** `pool`. O D10 faz sua PRÓPRIA chamada a
`pool.connect()` para a transação principal dele, **enquanto** a conexão
do `lockClient` ainda está aberta em transação.

Isso significa que, para UMA chamada completar, o `pool` precisa entregar
**duas conexões simultâneas** a ela (uma para o lock, uma para o D10). Sob
concorrência, se N chamadas para N identidades DIFERENTES chegam ao mesmo
tempo (nenhuma contenção no lock as serializa), cada uma consome UMA
conexão como `lockClient` — e se N for igual (ou maior) que `pool.max`,
**todas** as conexões do pool ficam ocupadas como "primeira conexão" antes
de qualquer uma conseguir a "segunda". Nenhuma chamada nunca libera a sua
primeira conexão (está esperando a segunda); nenhuma chamada nunca consegue
a segunda (não há conexão livre). **Deadlock permanente** — o `pg-pool` não
tem timeout de aquisição de conexão por padrão (`connectionTimeoutMillis`
padrão é `0`, infinito).

A validação `pool.max >= 2` da v1.2 provava corretamente que **uma**
chamada isolada não se autobloqueia (ela só precisa de 2 conexões, e há 2
disponíveis). Mas sob N chamadas concorrentes, a necessidade total sobe
para `2×N` conexões simultâneas pela metade do caminho, e `pool.max`
continua fixo — **qualquer** `pool.max` finito pode ser saturado por
concorrência suficiente. Aumentar `pool.max` não resolve a causa raiz, só
eleva o N necessário para disparar o mesmo deadlock.

## 3. Correção aplicada

A menor mudança estrutural suficiente: a conexão do `lockClient` deixou de
ser obtida do `pool` compartilhado e passou a ser uma conexão **dedicada**
(`new Client({ connectionString: pool.options.connectionString })`),
conectada diretamente e nunca devolvida a pool nenhum — encerrada
(`.end()`) ao final de cada chamada.

- **O `pg_advisory_xact_lock` continua exatamente o mesmo mecanismo** —
  sua semântica no Postgres não depende de a conexão vir de um pool Node
  ou de uma conexão direta. A garantia de serialização entre instâncias/
  processos (achado #1 da v1.1: duas entregas concorrentes para o MESMO
  `origemProcessoId` convergem) permanece intacta — não foi removida nem
  substituída por nenhum mecanismo em memória (que não seria equivalente
  sob múltiplas instâncias do servidor).
- **O D10 não foi alterado.** Continua recebendo e usando o MESMO `pool`
  compartilhado, com a MESMA chamada `registrarProcessoDemurrage(entradaD10,
  { pool })`, exatamente como antes.
- **A identidade e a resolução de conflito não mudaram** — toda a lógica de
  decisão (vínculo existente/compatível/divergente, conflito oculto na
  inserção, estado da transação, rollback-e-relançamento do erro original)
  é idêntica à v1.2; só a ORIGEM da conexão do `lockClient` muda.
- **`pool.max` não foi alterado** (nem elevado nem reduzido) — a correção
  não depende de "ter conexões suficientes": a conexão do lock agora é
  estruturalmente INDEPENDENTE de qualquer limite de pool, então não existe
  mais um N de concorrência que a sature por este caminho.
- A validação de `pool.max >= 2` (`db/pool.ts`) foi **mantida** como piso
  mínimo de defesa em profundidade (não removida, não relaxada), com o
  comentário atualizado para refletir que ela deixou de ser a ÚNICA
  proteção contra autobloqueio — essa proteção agora é estrutural.

Por que uma conexão dedicada (e não um segundo pool compartilhado)? Um
segundo pool só desloca o MESMO risco para um recurso diferente, ainda
finito — e exigiria threading de uma segunda configuração por todos os
pontos de chamada (produção e cada teste) ou uma derivação automática com
problemas de ciclo de vida (pools órfãos nunca fechados). Uma conexão
dedicada, uma por chamada, elimina o recurso compartilhado por completo
para este ponto específico — sem adicionar nenhuma superfície de
configuração nova, sem mudar a assinatura pública de `resolverVinculoProcesso`
nem de `processarEventoHandoff`, e sem exigir nenhuma mudança nos arquivos
de teste já existentes (v1.1, v1.2) ou na rota HTTP.

## 4. Prova de que uma chamada que falha não deixa conexão/lock preso

A conexão dedicada é SEMPRE encerrada (`await lockClient.end()`) no bloco
`finally`, incondicionalmente — nunca "release(err)" nem "release()", já
que não há pool para devolvê-la. Mesmo quando a tentativa de `ROLLBACK`
também falha, `.end()` roda imediatamente depois, fechando a conexão TCP —
o que faz o Postgres abortar qualquer transação remanescente do lado do
servidor, independentemente do resultado do `ROLLBACK` explícito.

Teste `v1.3 #3` prova isto diretamente: depois de uma rodada concorrente de
sucesso (saturando o pool) E depois de uma rodada concorrente com falha
injetada em TODAS as chamadas (mesmo pool saturado), uma consulta a
`pg_stat_activity` confirma **zero** sessões `idle in transaction` na base
de teste em ambos os casos.

## 5. Evidência de teste (PostgreSQL real)

### 5.1 Nova suíte — `handoffVinculoConcorrenciaV13.test.ts` (3/3, 100% verde)

| # | Cenário | Max do pool | Chamadas concorrentes | Resultado |
|---|---|---|---|---|
| 1 | N identidades distintas, pool saturado (N=4) | 4 | 4 | ok — todas resolvidas, 4 vínculos distintos, sem timeout |
| 2 | Combinação mínima sugerida pela revisão (max=2, 2 chamadas) | 2 | 2 | ok — ambas resolvidas, sem timeout |
| 3 | Zero sessões presas após rodada de sucesso saturante E após rodada com falha injetada (max=3) | 3 | 3 (duas rodadas) | ok — `pg_stat_activity` confirma zero `idle in transaction` em ambos os casos |

Cada teste usa um prazo explícito (`Promise.race`, 15s) — se uma regressão
futura reintroduzir o deadlock, o teste falha rapidamente com uma mensagem
clara em vez de travar a suíte indefinidamente.

### 5.2 Regressão combinada — v1.3 + v1.2 + v1.1 + Entrega 1 original

**60/60 testes — 100% verde**, sem nenhuma alteração de comportamento nos
três arquivos reexecutados junto com a suíte nova
(`handoffVinculoTransacaoV12.test.ts`, `handoffProducaoP1V11.test.ts`,
`handoffProducaoP1.test.ts`).

### 5.3 Regressão completa

- **Suíte completa do Demurrage Engine** (`npm run test:demurrage-engine`): **1037/1037 testes — 100% verde, 0 falhas** (schema recriado do zero antes da corrida; inclui as 3 suítes novas desta corretiva, as 60 da v1.2/v1.1/Entrega 1 reexecutadas, e todas as entregas D1–D16 e v1.x anteriores sem nenhuma regressão).
- **V1** (`npm test`): 25/25 passam.
- **D13 UI** (`npm run test:demurrage-ui`, navegador real): 66/66 passam — zero regressão de frontend.
- **`tsc --noEmit`**: limpo.
- **`npm run build`**: limpo.

## 6. Migrações

Nenhuma migration nova. 0040 e 0041 permanecem intactas.

## 7. Nenhuma mudança de frontend

Confirmado por `git status --porcelain`: os únicos arquivos tocados são
`src/demurrage-engine/db/pool.ts`, `src/demurrage-engine/handoff/handoffService.ts`,
o novo `src/demurrage-engine/__tests__/handoffVinculoConcorrenciaV13.test.ts`
e este relatório. Nenhum caminho sob `public/`, nenhum `.html`, nenhum
`.css`. Reconfirmado também pela suíte D13 UI (navegador real) permanecendo
66/66 verde.

## 8. Status

O risco de pool starvation sob concorrência próxima ao limite do pool foi
investigado, reproduzido deterministicamente, e corrigido pela menor
mudança estrutural suficiente (conexão dedicada para o lock consultivo),
preservando integralmente a identidade estável do processo, a resolução de
conflito, o D10 e o isolamento transacional — sem migration nova, sem
mudança de frontend, sem depender de aumentar `pool.max`.

**Produção P1 não está declarada completa.** Entrega 2, Entrega 3 e
qualquer trabalho de frontend permanecem não iniciados. A decisão final de
congelamento da Entrega 1 permanece com o usuário.
