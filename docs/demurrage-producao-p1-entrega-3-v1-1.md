# Produção P1 — Entrega 3 v1.1: corretiva (chave exata do cursor, validação de parâmetros, erro inesperado genérico, índice de pendências resolvidas, `autorizadaEm`, documentação)

**Baseline:** branch `claude/practical-cerf-mnz7oj`, Entrega 3 original no
commit `507bf67` (não congelada). Entregas 1 e 2 **congeladas** — nenhum
arquivo-fonte delas foi alterado (ver §11). Migrations 0001–0045 **não foram
tocadas**; esta corretiva acrescenta só a `0046` (aditiva, um índice).
**Nenhum arquivo de frontend foi alterado.**

A revisão final de `507bf67` verificou seis problemas. Os cinco de código
(#1–#5) foram reproduzidos contra o PostgreSQL real antes da correção e
estão cobertos por testes novos que **falham na implementação de `507bf67`**
e passam nesta corretiva (§10); o #6 (documentação) é resolvido pelas
correções descritas em §6. Antes do commit, a corretiva passou por uma
revisão adversarial própria; os pontos que ela levantou foram corrigidos
dentro deste mesmo escopo (§5.3, §2.2, §8) ou registrados em §12.

| # | Achado | Gravidade na revisão | Correção |
|---|---|---|---|
| 1 | Chave do cursor truncada em milissegundos: páginas repetem linhas (rotas ASC, laço infinito com `limite=1`) ou omitem linhas (rota DESC) | bloqueador | Chave exata (microssegundos) vinda do PostgreSQL, comparação por linha, cursor `.v2` |
| 2 | `limite` fracionário e datas impossíveis chegavam ao PostgreSQL (HTTP 500); `limite > 200` era limitado em silêncio | menor | Validação estrita antes de qualquer consulta da leitura |
| 3 | Falha inesperada devolvia a mensagem do banco ao cliente | menor | `500 { "error": "erro_interno" }` genérico + log sanitizado, só nas três rotas |
| 4 | `estado=resolvida` sem índice utilizável: `Seq Scan` na tabela inteira | maior | Migration `0046` com índice `(processo_id, estado, criado_em, id)` |
| 5 | `autorizadaEm` vinha de `atualizado_em`, reescrito pelo refechamento | menor | Instante do evento `REABERTURA_AUTORIZADA` do ledger append-only |
| 6 | Relatório da Entrega 3 com afirmações mais amplas que os testes | menor | `docs/demurrage-producao-p1-entrega-3.md` corrigido (marcas **[v1.1]**) |

---

## 1. Achado #1 — chave do cursor keyset (precisão)

### 1.1 Causa raiz

As três leituras ordenam por `criado_em` (`TIMESTAMPTZ NOT NULL DEFAULT now()`
em `reaberturas`/`minutas` — migration 0016 — e `demurrage_pendencias` —
migration 0028), com resolução de **microssegundos**. Nenhuma escrita de
produção define `criado_em` explicitamente. A v1 montava o cursor com
`ultimaChave: new Date(ultima.criado_em).toISOString()`: o driver `pg`
(`pg-types` → `postgres-date`) já entrega a coluna como `Date` do
JavaScript, que só guarda **milissegundos**. Exemplo real da revisão: banco
`…16.004474Z`, cursor `…16.004Z`.

A página seguinte comparava `criado_em > chave OR (criado_em = chave AND id > último)`
(ASC) ou `<` (DESC) com a chave truncada:

- **ASC (`/reaberturas`, `/minutas`)**: a última linha da página (`.004474`)
  é `> .004000` — volta no início da página seguinte. Com `limite=1`, a
  mesma linha e o mesmo cursor se repetem para sempre.
- **DESC (`/pendencias`)**: linhas empatadas com a última (mesma transação —
  o registro de um processo abre todas as pendências numa transação só,
  com `now()` idêntico) ou no mesmo milissegundo não são `< .004000` nem
  `= .004000` — somem, e o cursor termina como se a lista estivesse completa.

Reprodução na revisão (funções reais de leitura, registro real de processo):
`/pendencias` com `limite=2` devolveu 2 de 6; `/minutas` e `/reaberturas`
com `limite=1` nunca terminaram (30 páginas, sempre o mesmo item).

### 1.2 Correção

- `leitura/cursorKeyset.ts`: `expressaoChaveExata(coluna)` gera
  `to_char(coluna AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` —
  a chave sai do **próprio PostgreSQL** como texto com 6 dígitos de fração,
  independente de `TimeZone`/`DateStyle` da sessão.
- As três consultas selecionam essa expressão (`chave_ordenacao`, nunca
  exposta no item) e o cursor de saída usa esse texto **sem passar por
  `Date`**.
- Página seguinte por comparação de linha, mantendo a direção de cada rota:
  `(dp.criado_em, dp.id) < ($chave::timestamptz, $id::uuid)` em `/pendencias`
  (DESC); `(r.criado_em, r.id) > (...)` e `(m.criado_em, m.id) > (...)` em
  `/reaberturas`/`/minutas` (ASC). O `id` continua o desempate
  determinístico. Nenhum OFFSET.
- `decodificarCursorKeyset` passou a exigir `ultimaChave` no formato exato
  (`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$`) e `ultimoId` UUID —
  defesa em profundidade além da assinatura HMAC.

### 1.3 Mudança de formato do cursor

| | v1 (`507bf67`) | v2 (esta corretiva) |
|---|---|---|
| `v` | `p1e3.pendencias.v1` / `p1e3.reaberturas.v1` / `p1e3.minutas.v1` | `p1e3.pendencias.v2` / `p1e3.reaberturas.v2` / `p1e3.minutas.v2` |
| `ultimaChave` | `Date#toISOString()` — `2026-10-20T23:28:16.004Z` | texto do PostgreSQL — `2026-10-20T23:28:16.004474Z` |
| `ultimoId`, `organizationId`, `filtrosHash` | inalterados | inalterados (o hash inclui `v`, então também muda) |
| Assinatura | HMAC-SHA256 do D12 (`cursorAssinado.ts`) | a mesma |

Um cursor v1 é sempre `400 cursor_invalido` (versão divergente) — nunca
reinterpretado. Os campos de data/hora **do item** (`abertaEm`,
`solicitadaEm`, `recebidaEm`, `autorizadaEm`) continuam no formato ISO com
milissegundos do contrato v1; só o cursor carrega microssegundos.

---

## 2. Achado #2 — validação de parâmetros

### 2.1 Causa raiz

As três rotas usavam `paginacaoDaQuery` (D12), que aceita qualquer número
finito ≥ 1: `limite=1.5` chegava ao SQL como `LIMIT 2.5` e o PostgreSQL
rejeitava (`invalid input syntax for type bigint`) → HTTP 500. Valores acima
de 200 eram reduzidos a 200 em silêncio. As datas só passavam por
`/^\d{4}-\d{2}-\d{2}$/`: `2026-02-30` chegava ao `::date` e o PostgreSQL
rejeitava (`date/time field value out of range`) → HTTP 500.

### 2.2 Correção

`leitura/parametrosOperacionais.ts` (novo), usado **só** pelas três rotas —
`paginacaoDaQuery` e as rotas D12 não mudaram:

- `limite`: só `^[0-9]+$` e 1 ≤ n ≤ 200; qualquer outra forma (fração,
  expoente, `+`/`-`, vazio, espaços, sufixo, valor repetido na query, fora
  da faixa) → `400 { error: 'valor_invalido', campo: 'limite' }`.
  **Mudança de contrato deliberada (pedida pela revisão):** `limite > 200`
  agora é 400, não mais reduzido a 200.
- Datas: formato exato `AAAA-MM-DD` **e** data de calendário real
  (gregoriano, bissextos, ano 0001–9999) →
  `400 { error: 'valor_invalido', campo }`. Período invertido continua
  `400 periodo_invertido`.
- Data repetida na query (array) → `400 valor_invalido` — um segundo valor
  malformado nunca é ignorado em favor do primeiro.
- `tipo` (único filtro de texto livre, só em `/pendencias`): uma única
  string sem caracteres de controle; senão `400 valor_invalido`. Sem isso,
  `tipo=%00` chegava ao SQL e o próprio PostgreSQL rejeitava (SQLSTATE
  22021 → 500). Um tipo desconhecido mas bem-formado continua devolvendo
  lista vazia, como antes.
- `cursor` repetido na query → `400 cursor_invalido`.
- Ordem na rota `/pendencias`: id do caminho, filtros, paginação e cursor
  (validação pura do HMAC/contexto) são validados **antes** de
  `organizacaoDoProcesso` — a resposta 400 não depende do processo, então
  não revela existência. Prova com pool espião: `#V1` (`limite`, inclusive
  repetido) e `#V2` (datas, inclusive repetidas, e período invertido) nas
  três rotas; `#V3` em `/pendencias` para `estado`, `containerId`, `tipo`
  com caractere de controle ou repetido, cursor inválido ou repetido,
  `limite` e datas — com processo inexistente, de outra organização e
  próprio: o mesmo 400 e **nenhuma** consulta (nem a de posse). O
  middleware de autenticação/autorização (`autorizarInterno`) continua
  consultando o banco antes de qualquer validação de parâmetro — isso é
  inerente e não mudou.

---

## 3. Achado #3 — resposta para falha inesperada

### 3.1 Causa raiz

Erros que não eram `ErroLeitura` seguiam por `next(err)` até o tratador
central (`src/index.ts`), que devolve `err.message` — para um erro do `pg`,
texto do PostgreSQL (tipos, valores, nomes de tabela).

### 3.2 Correção (a mais estreita possível)

`leitura/falhaLeituraOperacional.ts` (novo), mesma disciplina já congelada
em `handoff/erros.ts`/`acoes/erros.ts`:

- `ErroLeitura` → status e corpo explícitos **inalterados** (400
  `valor_invalido`/`cursor_invalido`/`periodo_invertido`/
  `parametro_nao_aceito`, 403, 404, 409 `organizacao_ambigua`; 401 vem do
  `requireAuth` e não passa por aqui).
- Qualquer outro erro → `500 { "error": "erro_interno" }` (corpo fixo) e uma
  linha de log: `[demurrage-leitura] erro inesperado em <molde da rota>:
  <código>` (+ ` (SQLSTATE xxxxx)` quando houver). A classificação lê só a
  identidade do erro e o SQLSTATE do `pg` — nunca `.message`, `.stack`,
  `.detail`, tabela ou SQL.
- Aplicado nos três handlers e num tratador de erro **restrito aos três
  caminhos** no fim do router (`router.use(caminho, (err, …) => …)`), que
  cobre falhas levantadas antes do handler (ex.: `autorizarInterno` sem
  banco). Erros das rotas D12 não casam esses caminhos e continuam indo para
  o tratador do app como antes (provado em `#E2`). `src/index.ts` não mudou.

---

## 4. Achado #4 — índice para pendências resolvidas

### 4.1 Causa raiz

O único índice secundário de `demurrage_pendencias` era
`demurrage_pendencias_aberta_unica` (0028, parcial `WHERE estado = 'aberta'`).
Para `estado=resolvida` (filtro suportado pela rota) não havia índice
utilizável. A justificativa da Entrega 3 ("o custo escala com as pendências
daquele processo") só valia para `aberta`.

### 4.2 Migration `0046_leitura_operacional_pendencias_por_processo.sql`

```sql
CREATE INDEX demurrage_pendencias_processo_estado_criado_idx
  ON demurrage_pendencias (processo_id, estado, criado_em, id);
```

- Igualdades da consulta primeiro (`processo_id`, `estado`), depois a ordem
  keyset exata da rota (`criado_em`, `id`), percorrida para trás para
  `DESC, DESC`; a comparação `(criado_em, id) < (...)` do cursor vira
  condição do próprio índice.
- **Não é parcial de propósito**: a consulta compara `estado = $n`
  (parâmetro); um índice `WHERE estado = 'resolvida'` só seria utilizável em
  plano customizado. Com `estado` como coluna, serve a qualquer plano.
- Estritamente aditiva: nenhum dado alterado, nenhuma regra nova, `0045` não
  editada. `#M1` prova instalação limpa (0001→0046), upgrade a partir da
  0045 com dados (impressão digital MD5 de **todas** as tabelas idêntica
  antes/depois) e reexecução no-op.
- Operação: o runner aplica cada migration numa transação, então
  `CREATE INDEX CONCURRENTLY` não é possível (mesmo padrão da 0045).
  Durante a construção do índice a tabela fica com lock `SHARE`: leituras
  seguem, mas `INSERT`/`UPDATE` em `demurrage_pendencias` esperam. Aplicar
  em janela de baixo tráfego (anotado também no comentário da migration).

### 4.3 Planos de consulta — antes e depois

Script `src/demurrage-engine/__tests__/leituraOperacionalPlanoEntrega3V11.ts`
(standalone; **apaga o schema** do banco alvo e por isso exige
`DEMURRAGE_PLANO_PERMITE_RESET=1`). Captura o SQL **exato** que
`buscarPendenciasProcesso` envia (página 1 e página 2 com cursor), roda
`EXPLAIN (ANALYZE, BUFFERS)` no schema até a 0045, aplica só a 0046 e
repete. Dados: 5 organizações × 1.000 processos; 125.000 pendências, das
quais 100.000 resolvidas; o processo-alvo tem 20 resolvidas. `ANALYZE`
explícito.

Resumo da execução final (a saída **completa** do script, sem cortes, está
no Apêndice A):

| Consulta real (`estado=resolvida`) | Até a 0045 | Com a 0046 |
|---|---|---|
| Página 1 | `Seq Scan on demurrage_pendencias`, `Rows Removed by Filter: 124980` — 7,563 ms | `Bitmap Index Scan on demurrage_pendencias_processo_estado_criado_idx`, `Index Cond: (processo_id = …) AND (estado = 'resolvida')` — 0,261 ms |
| Página 2 (cursor) | `Parallel Seq Scan on demurrage_pendencias`, `Rows Removed by Filter: 62495` por worker (2 loops), a comparação keyset só como `Filter` — 9,907 ms | mesmo índice, com `ROW(criado_em, id) < ROW('2026-01-01 11:19:02.123501+00', …)` **dentro do `Index Cond`** — 0,116 ms |

Antes, o custo crescia com o **total** de pendências resolvidas de todas as
organizações; depois, com as linhas daquele processo. No mesmo run, a
impressão digital de todas as tabelas foi idêntica antes/depois da 0046 e a
reexecução das migrations aplicou `[]`. A leitura padrão `estado=aberta`
continuou usando `demurrage_pendencias_aberta_unica` (o planejador escolhe o
índice adequado). `#M2` prova o mesmo de forma automatizada e estrutural
(`EXPLAIN (FORMAT JSON)`: nenhum nó de índice antes; o índice da 0046
depois, com a comparação keyset na condição do índice na página 2).

### 4.4 Plano de `/reaberturas` com o `LATERAL` de `autorizadaEm`

A correção do achado #5 acrescentou à consulta de `/reaberturas` um
`LEFT JOIN LATERAL` em `closing_events`. O mesmo script captura o SQL exato
de `buscarReaberturas` (`estado=RECALCULADA`, `limite=50`, páginas 1 e 2)
com 1.000 reaberturas e 6.000 eventos (um `REABERTURA_AUTORIZADA` e cinco
`RECALCULO` por processo): `Index Scan using reaberturas_estado_criado_idx`
dirige a ordem com o `LIMIT`, e o agregado do `LATERAL` roda exatamente
**51 vezes** (`loops=51` = `limite + 1`), cada uma por
`Bitmap Index Scan on closing_events_processo_idx` — 0,634 ms (página 1) e
0,674 ms (página 2). O custo do `LATERAL` é por linha devolvida, não por
linha candidata. (O benchmark original da Entrega 3 continua medindo um SQL
simplificado de `/reaberturas`, sem esse `LATERAL` nem as junções de
membership — seus números não descrevem a consulta atual.)

---

## 5. Achado #5 — semântica de `autorizadaEm`

### 5.1 Causa raiz

`reaberturasOperacionais.ts` usava `autorizadaEm = atualizado_em` quando
havia `autorizada_por`. `reaberturas` não tem coluna de instante de
autorização, e `ReaberturaRepository.marcarEstado`
(`persistence/reaberturaRepository.ts:52`) faz `atualizado_em = now()` —
chamado com `REFECHADA` por `ClosingService.finalizarProcesso`
(`closing/closingService.ts:498`) numa transação **posterior**. Toda
reabertura refechada mostrava o instante do refechamento.

### 5.2 Transição oficial de autorização (serviço congelado)

`ClosingService.autorizarReabertura` (`closing/closingService.ts:574`), numa
única transação: trava processo e reabertura, exige `MANAGER`/`ADMIN` e
estado `SOLICITADA`, chama `ReaberturaRepository.autorizar` (`:616` —
`estado = 'AUTORIZADA'`, `autorizada_por`, snapshot), grava o evento
`REABERTURA_AUTORIZADA` com `payload: { reaberturaId }` (`:625-628`),
recalcula e marca `RECALCULADA` (`:635`), e só então `COMMIT`.

### 5.3 Decisão: derivar do ledger, sem tocar o caminho de escrita

`autorizadaEm` passou a ser o `criado_em` do evento `REABERTURA_AUTORIZADA`
cujo `payload->>'reaberturaId'` é a própria reabertura (`LEFT JOIN LATERAL`
na mesma consulta — continua uma consulta por página, `#A4`; plano em
§4.4). A comparação é `lower(ce.payload->>'reaberturaId') = r.id::text`: a
rota congelada de autorização aceita o UUID em maiúsculas (regex com `/i`)
e o serviço grava no `payload` o id exatamente como veio na URL, enquanto
`r.id::text` é sempre minúsculo — sem o `lower`, uma autorização feita com
o id em maiúsculas teria `autorizadaEm: null` (achado da revisão
adversarial desta corretiva; `#A5`). A correção é só de leitura e também
recupera eventos já gravados assim.

- **Gravado exatamente quando a autorização é bem-sucedida:** o evento nasce
  na mesma transação (mesmo `now()` da linha — `#A1` confere até o
  microssegundo); se a transação desfaz, o evento também.
- **Nunca muda depois:** `closing_events` é append-only por trigger
  (`closing_events_append_only`, migration 0016 — `UPDATE`/`DELETE`
  proibidos). Recalcular ou refechar não toca o evento.
- **`null` antes da autorização:** não há evento.
- **Nenhuma mudança nas Entregas 1/2 nem no serviço congelado:** nenhuma
  coluna nova, nenhum `UPDATE` novo, nenhum arquivo de `closing/`, `acoes/`,
  `persistence/` ou `handoff/` alterado. Por isso **não foi necessária
  alteração de schema** para este achado — a 0046 contém só o índice.

### 5.4 Comportamento para dados legados

O evento com `payload.reaberturaId` existe desde a Fase 8 (commit
`501d0cc`, que o introduziu), e `ClosingService.autorizarReabertura` é o
único escritor de `REABERTURA_AUTORIZADA`. A gravação do evento **na mesma
transação** da autorização (com a guarda de estado `SOLICITADA`) existe
desde a D15-A (commit `86461d0`); antes disso o serviço gravava a linha e o
evento em comandos separados, mas não havia nenhum chamador de produção
desse serviço até a D15-A (a rota de ação só nasceu na Entrega 2). Logo,
toda reabertura autorizada por um caminho de produção tem o instante real
recuperado — **sem backfill e sem inventar nada**. Uma linha com
`autorizada_por` mas sem evento correspondente (escrita fora do serviço —
SQL manual, dados de teste — ou falha entre os dois comandos na era pré-D15-A,
sem uso em produção) mostra `autorizadaEm: null` — nunca um instante
inferido de `atualizado_em` ou de outra coluna (`#A2`, que também prova que
o evento de **outra** reabertura do mesmo processo nunca é atribuído). Se
houver mais de um evento para a mesma reabertura (impossível desde a D15-A),
vale o mais antigo (`min`). `autorizador` continua vindo de
`autorizada_por`, como antes.

Observação (sem mudança): como a autorização marca `RECALCULADA` na mesma
transação, nenhuma linha fica `AUTORIZADA` depois do `COMMIT`; o filtro
`estado=AUTORIZADA` devolve vazio em dados reais.

### 5.5 Regressão da autorização congelada

`#A3` exercita a rota congelada `POST /acoes/reaberturas/:id/autorizar`:
`ANALYST` → `403 apenas_manager_admin` sem evento; duas autorizações
concorrentes → exatamente uma `autorizada` e uma `ja_autorizada`, **um**
evento; repetição → `ja_autorizada`, nenhum evento novo, `autorizadaEm`
inalterado. As suítes da Entrega 2 continuam passando sem alteração de
comportamento (§9).

---

## 6. Achado #6 — documentação

`docs/demurrage-producao-p1-entrega-3.md` foi corrigido (trechos marcados
**[v1.1]**):

- §4: o que `#22-23-24-25` realmente testa (só `/pendencias`, `limite=4`
  fixo, linhas a 1 s, empate fora das fronteiras) — a afirmação de
  "tamanhos de página diferentes" era falsa — e os testes novos `#P1`–`#P4`.
- §1.1/§1.2: validação estrita de parâmetros, 500 genérico e o novo
  significado de `autorizadaEm`.
- §5: escopo real do teste zero-escrita `#27`.
- §7: a justificativa "nenhum índice para pendências" só valia para
  `aberta`; a 0046 e a evidência de plano; requisitos de execução do
  benchmark (`ts-node`, não `tsx`) e o fato de ele **apagar o schema**;
  imprecisão sobre o "upgrade 0044→0045".
- §9: a 0046 e a nova atualização mecânica dos 8 arquivos.
- §10: variáveis de ambiente — `DEMURRAGE_DATABASE_URL` (ou `DATABASE_URL`)
  é obrigatória, porque parte dos testes usa o `getPool()` de produção;
  `DEMURRAGE_TEST_DATABASE_URL` é opcional (o helper de teste cai para as
  outras) e, se definida, precisa apontar para o MESMO banco descartável.
  Com só `DEMURRAGE_TEST_DATABASE_URL`: dois subtestes HTTP de
  `leituraAutorizacao.test.ts` falham com 500, os testes HTTP `#9`–`#15` de
  `handoffProducaoP1.test.ts` falham por rejeição não tratada, e
  `handoffProducaoP1V11.test.ts` pode travar (reproduzido nesta corretiva);
  `tsc` **não** verifica `*.test.ts` (excluídos pelo `tsconfig.json` — quem
  verifica é o `ts-node` ao executar as suítes); contagem correta de
  testes/itens (23 testes, 28 rótulos; `#20` é o teste de cursor de outra
  rota, não "a etapa 5").
- §1.1: o 404 "sempre" para processo inexistente/de outra organização vale
  com parâmetros válidos; com parâmetro inválido a resposta é o mesmo 400
  para qualquer processo. §4: os nomes de versão do cursor passaram a `.v2`.
- §11: `#30` só olha mudanças não commitadas; o commit `507bf67` também
  alterou `docs/demurrage-producao-p1-diagnostico.md`.
- Status: corrigido e marcado como **não congelado**.

O comentário de cabeçalho de `leituraOperacionalBenchmarkEntrega3.ts` também
foi corrigido (comando com `ts-node`, aviso de `DROP SCHEMA`) — só
comentário, nenhuma lógica.

---

## 7. Arquivos alterados

**Código de produção (só leituras da Entrega 3):**

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/leitura/cursorKeyset.ts` | `expressaoChaveExata`; decodificação exige chave exata e id UUID |
| `src/demurrage-engine/leitura/pendenciasOperacionais.ts` | chave exata, comparação por linha, cursor `.v2`, datas de calendário, `cursorPendenciasOuErro` (validação pura do cursor) |
| `src/demurrage-engine/leitura/reaberturasOperacionais.ts` | idem (ASC) + `autorizadaEm` do evento `REABERTURA_AUTORIZADA` |
| `src/demurrage-engine/leitura/minutasOperacionais.ts` | chave exata, comparação por linha, cursor `.v2`, datas de calendário |
| `src/demurrage-engine/leitura/parametrosOperacionais.ts` (novo) | `limite`/datas/cursor estritos |
| `src/demurrage-engine/leitura/falhaLeituraOperacional.ts` (novo) | 500 genérico + log sanitizado |
| `src/routes/demurrageV2Routes.ts` | só os três handlers da Entrega 3 e o tratador de erro restrito aos três caminhos; rotas D12 intactas |
| `src/demurrage-engine/db/migrations/0046_leitura_operacional_pendencias_por_processo.sql` (novo) | um índice |

**Testes e scripts:**

| Arquivo | Mudança |
|---|---|
| `__tests__/leituraOperacionalEntrega3V11.test.ts` (novo) | 17 testes de integração (§8) |
| `__tests__/leituraOperacionalEntrega3V11Unidade.test.ts` (novo) | 7 testes de unidade (§8) |
| `__tests__/leituraOperacionalPlanoEntrega3V11.ts` (novo) | script de evidência de plano (§4.3, §4.4, Apêndice A) |
| `__tests__/leituraOperacionalBenchmarkEntrega3.ts` | só o comentário de cabeçalho |
| `__tests__/migrate.test.ts`, `registroDemurrageV12.test.ts`, `responsabilidadeAuditoria.test.ts`, `responsabilidadeV12.test.ts`, `responsavelOperacional.test.ts`, `schedulerClaimFencing.test.ts`, `demurrageAcoesEntrega2V11.test.ts`, `demurrageAcoesEntrega2V12.test.ts` | atualização mecânica da lista de migrations hardcoded para incluir a 0046 (mesma manutenção já feita para a 0045) |

**Documentação:** `docs/demurrage-producao-p1-entrega-3.md` (corrigido) e
este relatório (novo). `docs/demurrage-producao-p1-diagnostico.md` **não**
foi alterado (mesma convenção das corretivas anteriores).

---

## 8. Mapa de testes

`src/demurrage-engine/__tests__/leituraOperacionalEntrega3V11.test.ts`
(integração, PostgreSQL real; só importa módulos que já existiam em
`507bf67`, por isso também roda contra a implementação antiga):

| Teste | Requisito | O que prova |
|---|---|---|
| `#P1` | 1 | `/pendencias` (`aberta` e `resolvida`): linhas com `now()` normal, 4 numa transação (empate exato), 4 no mesmo milissegundo (só µs diferentes); tamanhos `[1]`, `[2]`, `[1,3,2]`; pré-condição de empate e de par sub-ms em fronteira; ordem oficial exata, cada id uma vez, término, sem página/cursor repetidos; ruído de outro processo/organização nunca aparece |
| `#P2` | 1 | idem para `/reaberturas` (uma reabertura aberta por processo) |
| `#P3` | 1 | idem para `/minutas` |
| `#P4` | 1 | cursor v1 (exatamente como a v1 emitia: versão, hash e chave em ms) → `400 cursor_invalido` nas três rotas; e cursor com versão `.v1` + hash `.v1` mas chave já EXATA e id UUID válido (só a versão pode rejeitá-lo) → `400 cursor_invalido` — pino da troca de versão |
| `#V1` | 2 | 22 formas inválidas de `limite` + valor repetido → `400 {"error":"valor_invalido","campo":"limite"}` nas três rotas, sem nenhuma consulta da leitura (pool espião); 1, 50 e 200 aceitos e ecoados |
| `#V2` | 2 | 21 datas inválidas e o valor repetido (`2026-01-01` + `2026-02-30`) em cada um dos 8 parâmetros de data das três rotas → `400 valor_invalido` sem consulta da leitura; 29/02 de anos bissextos aceito; período invertido → `400 periodo_invertido` sem consulta; mesmo dia nas duas pontas aceito |
| `#V3` | 2 | `/pendencias` com processo inexistente, de outra organização e próprio: `estado`, `containerId`, `tipo` com `%00`/`%0A` ou repetido, cursor inválido ou repetido, `limite=0`, data impossível e período invertido → o mesmo 400 e **nenhuma** consulta (nem a verificação de posse); tipo desconhecido bem-formado → 200 com lista vazia |
| `#E1` | 3 | falha do `pg` na consulta principal de cada rota → `500 {"error":"erro_interno"}`; nem a resposta nem o log contêm mensagem/detalhe/tabela/SQL; uma linha de log com código e SQLSTATE |
| `#E2` | 3 | falha no middleware de autorização → mesmo 500 genérico nas três rotas; `/filtros` e `/processos/:id` (D12) continuam no tratador do app |
| `#E3` | 3 | 401, 403, 409 `organizacao_ambigua`, 400 `valor_invalido`/`cursor_invalido`/`parametro_nao_aceito` nas três rotas; 404 idêntico para processo inexistente e de outra organização |
| `#A1` | 5 | ciclo real pelas rotas congeladas: `null` antes; instante do evento depois — `RECALCULADA` acontece na mesma transação da autorização (evento e linha com o mesmo `now()`, conferido até o microssegundo), então só o REFECHAMENTO (transação posterior, que muda `atualizado_em`) distingue a correção da v1; `autorizadaEm` inalterado após ele; um único evento |
| `#A2` | 5 | sem evento comprovável → `null`; evento de outra reabertura não é atribuído |
| `#A3` | 5 | autorização congelada inalterada: RBAC, concorrência, repetição — um evento, um instante |
| `#A4` | 5 | `/reaberturas` continua com uma consulta por página |
| `#A5` | 5 | autorização pela rota congelada com o UUID em MAIÚSCULAS: o ledger guarda o id em maiúsculas (pré-condição verificada) e `autorizadaEm` ainda é o instante do evento |
| `#M1` | 4 | instalação limpa 0001→0046; upgrade a partir da 0045 com dados, impressão digital idêntica; reexecução no-op; definição exata do índice |
| `#M2` | 4 | plano da consulta real de `resolvida` (páginas 1 e 2): nenhum índice até a 0045; índice da 0046 depois, com a comparação keyset na condição do índice |

`src/demurrage-engine/__tests__/leituraOperacionalEntrega3V11Unidade.test.ts`
(sem banco): `#U1` `limiteEstrito`; `#U2` `cursorDaQuery`; `#U3` datas de
calendário (inclusive valor repetido/não-string); `#U4` contratos explícitos
400/403/404/409 e 500 genérico com log sanitizado; `#U5` classificação só
por tipo/SQLSTATE; `#U6` chave exata e versão no decodificador do cursor;
`#U7` `textoFiltroOuErro` (caracteres de controle, valor repetido).

Fora do escopo dos testes novos: a resposta 500 quando falha a consulta de
posse do processo em `/pendencias` (`organizacaoDoProcesso`) não tem teste
próprio — está no mesmo `try`/`catch` provado por `#E1`. A zero-escrita
continua provada só pela amostra de `Entrega 3 #27` (que roda sobre o código
corrigido).

---

## 9. Validação sequencial (PostgreSQL real)

Executada num **worktree limpo** criado com `git worktree add --detach
d86132e` (o commit de código desta corretiva; este relatório é completado
no commit seguinte, que só altera documentação), com `npm ci` a partir do
lockfile — sem `node_modules` nem arquivos compartilhados com o worktree de
desenvolvimento. PostgreSQL 16.15 real, banco novo e vazio; Node v22.22.0;
`DEMURRAGE_DATABASE_URL` e `DEMURRAGE_TEST_DATABASE_URL` apontando para o
mesmo banco. Uma etapa por vez, na ordem abaixo, nunca em paralelo.

| # | Etapa | Comando / arquivos | Testes | Pass | Fail | Skipped | Cancelled | Todo | Duração |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Novos testes da corretiva | `leituraOperacionalEntrega3V11Unidade.test.ts` + `leituraOperacionalEntrega3V11.test.ts` | 24 | 24 | 0 | 0 | 0 | 0 | 19,0 s |
| 2 | Entrega 3 | `leituraOperacionalEntrega3.test.ts` | 23 | 23 | 0 | 0 | 0 | 0 | 15,9 s |
| 3 | Entrega 2 (ações) | `demurrageAcoesEntrega2(.V11/.V12).test.ts`, `acoesSemLogicaDeNegocio.test.ts` | 70 | 70 | 0 | 0 | 0 | 0 | 51,1 s |
| 4 | Entrega 1 (handoff) | `handoffProducaoP1(V11).test.ts`, `handoffVinculoConcorrenciaV13.test.ts`, `handoffVinculoTransacaoV12.test.ts` | 60 | 60 | 0 | 0 | 0 | 0 | 48,5 s |
| 5 | D12 read-model (com as duas variáveis de banco) | `demurrageV2Routes.test.ts` + `leitura{Autorizacao,Contrato,D12V12,Detalhe,Fila,FilaV11,Filtros,Timeline,TimelineV11}.test.ts` | 75 | 75 | 0 | 0 | 0 | 0 | 72,9 s |
| 6 | Suíte completa do Demurrage Engine | `npm run test:demurrage-engine` | **1154** | **1154** | 0 | 0 | 0 | 0 | 710,2 s |
| 7 | V1 | `npm run test` | 25 | 25 | 0 | 0 | 0 | 0 | 2,7 s |
| 8 | D13 UI | `npm run test:demurrage-ui` | 66 | 66 | 0 | 0 | 0 | 0 | 26,2 s |
| 9 | TypeScript | `tsc --noEmit` | — | limpo (saída vazia, exit 0) | | | | | |
| 10 | Build de produção | `npm run build` | — | limpo (exit 0) | | | | | |

A etapa 6 contém as etapas 1–5 (mesma pasta `__tests__`): 1154 = 1130 da
Entrega 3 original + 24 testes novos. Etapas 3 + 4 = 130, o mesmo total da
regressão das Entregas 1/2 na validação original. Lembrete (§6): `tsc`
(etapas 9 e 10) não verifica `*.test.ts`; os tipos dos testes são
verificados pelo `ts-node` nas etapas 1–8.

`git status --porcelain` no worktree limpo: vazio antes e depois de todas
as etapas (só `dist/` e `node_modules/`, ignorados pelo `.gitignore`).

---

## 10. Reprodução antes/depois

### 10.1 Testes novos contra a implementação ANTIGA

Worktree limpo em `507bf67` + **só** os dois arquivos de teste novos,
PostgreSQL real:

- `leituraOperacionalEntrega3V11.test.ts`: **13 de 17 falham**, cada um pelo
  defeito que prova —

  | Teste | Falha observada em `507bf67` |
  |---|---|
  | `#P1` | página 8 veio vazia — cursor pulou linhas (omissão, DESC) |
  | `#P2`, `#P3` | página 2 repete a página 1 (duplicação, ASC) |
  | `#P4` | cursor v1 aceito: `200` em vez de `400` |
  | `#V1` | `limite=1.5` → `500` em vez de `400` |
  | `#V2` | `criadoDesde=2026-02-30` → `500` em vez de `400` |
  | `#V3` | `estado=NAO_EXISTE` em processo inexistente → `404` (a posse era verificada antes da validação) em vez de `400` |
  | `#E1`, `#E2` | corpo da resposta contém a mensagem do banco |
  | `#A1` | `autorizadaEm` = instante do refechamento |
  | `#A2` | `autorizadaEm` inventado a partir de `atualizado_em` |
  | `#M1`, `#M2` | não existe migration 0046 |

  Os 4 que passam também na versão antiga são guardas de regressão de
  comportamento que **deve** permanecer igual: `#E3` (contratos
  explícitos), `#A3` (autorização congelada), `#A4` (uma consulta por
  página) e `#A5` — que na v1 passa só porque, em `RECALCULADA`,
  `atualizado_em` ainda coincide com o instante da autorização; ele fixa
  que a derivação nova pelo ledger também cobre o id em maiúsculas.
- `leituraOperacionalEntrega3V11Unidade.test.ts`: não compila na versão
  antiga (`TS2307`: `parametrosOperacionais`/`falhaLeituraOperacional` não
  existem).

### 10.2 Reproduções da revisão final — antes e depois

Os mesmos scripts usados na revisão (funções reais de leitura, registro real
de processo, PostgreSQL real), sem nenhuma alteração, contra `507bf67` e
contra esta corretiva:

| Caso | Antes (`507bf67`) | Depois (v1.1) |
|---|---|---|
| `/pendencias`, 6 pendências do registro real (mesma transação), `limite=1` | 1 de 6 (5 omitidas) | 6 de 6, 6 páginas |
| `/pendencias`, `limite=2` | 2 de 6 (4 omitidas) | 6 de 6, 3 páginas |
| `/pendencias`, `limite=4` | 4 de 6 (2 omitidas) | 6 de 6, 2 páginas |
| `/minutas`, 6 linhas, `limite=1` | não termina (mesmo item em 30 páginas) | 6 de 6, 6 páginas |
| `/minutas`, `limite=2` / `4` | 10 / 7 itens (4 / 1 duplicados) | 6 de 6 / 6 de 6 |
| `/reaberturas`, 5 linhas, `limite=1` | não termina | 5 de 5, 5 páginas |
| `/reaberturas`, `limite=2` / `4` | 8 / 6 itens (3 / 1 duplicados) | 5 de 5 / 5 de 5 |
| chave no cursor vs. banco | `…16.004Z` vs `…16.004474Z` | `…51.100567Z` vs `…51.100567Z` |
| `GET /minutas?limite=1.5` | `500`, `invalid input syntax for type bigint: "2.5"` | `400 {"error":"valor_invalido","campo":"limite"}` |
| `GET /reaberturas?limite=2.5` | `500`, idem | `400 valor_invalido` (`limite`) |
| `GET /processos/:id/pendencias?limite=1.5` | `500`, idem | `400 valor_invalido` (`limite`) |
| `GET /reaberturas?criadoDesde=2026-02-30` | `500`, `date/time field value out of range` | `400 valor_invalido` (`criadoDesde`) |
| `GET /minutas?recebidaAte=2026-13-01` | `500`, idem | `400 valor_invalido` (`recebidaAte`) |
| `GET /processos/:id/pendencias?criadoDesde=2026-02-30` | `500`, idem | `400 valor_invalido` (`criadoDesde`) |

---

## 11. Isolamento e escopo

Verificado sobre `git diff 507bf67 d86132e`:

- **Nenhuma dependência de trabalho não commitado:** a validação do §9 rodou
  num worktree limpo do próprio commit, com dependências instaladas do
  lockfile; `git status --porcelain` vazio antes e depois.
- **Nenhum arquivo de frontend:** 0 caminhos em `public/`, `*.html`,
  `*.css`, `*.jsx` ou `src/frontend-tests/`; D13 UI 66/66.
- **Entrega 1 sem mudança de comportamento:** 0 arquivos em
  `src/demurrage-engine/handoff/`, `src/demurrage-engine/registro/` ou
  `src/routes/demurrageHandoffRoutes.ts`; testes de handoff 60/60 sem
  alteração.
- **Entrega 2 — código-fonte intocado:** 0 arquivos em
  `src/demurrage-engine/acoes/`, `closing/`, `persistence/` ou
  `src/routes/demurrageAcoesRoutes.ts`. O instante real de autorização foi
  obtido **sem nenhuma mudança** no caminho de escrita (derivado do ledger
  — §5.3), então a "menor mudança comprovada" na Entrega 2 acabou sendo
  nenhuma. Nos testes da Entrega 2, só a atualização mecânica da lista de
  migrations (`demurrageAcoesEntrega2V11.test.ts`: `0045` → `0046` como
  última e uma linha `includes(0046)`; `demurrageAcoesEntrega2V12.test.ts`:
  `0045` → `0046` como última). Testes de ações 70/70.
- **Migrations:** 0001–0045 intocadas; só `0046` adicionada.
- **D12 e app:** `src/index.ts`, `src/middleware/`, `leitura/autorizacao.ts`,
  `filaOperacional.ts`, `timeline.ts`, `detalhe.ts`, `filtros.ts`,
  `contrato.ts`, `cursorAssinado.ts` e `pendenciaContextoSeguro.ts`: 0
  mudanças. Em `src/routes/demurrageV2Routes.ts`, fora dos imports, todos os
  trechos alterados estão na seção da Entrega 3 (os handlers D12 nas linhas
  69–140 não mudaram); `#E2` prova que os erros D12 continuam no tratador do
  app.
- **Nenhuma regra de negócio nova:** as mudanças são de leitura (formato do
  cursor, validação de parâmetros de consulta, resposta de erro, derivação
  de `autorizadaEm` de um evento já gravado) e um índice. Nenhum cálculo,
  relógio, tarifa, estado ou permissão foi alterado.

---

## 12. Limitações remanescentes aceitas

- Os campos de data/hora dos itens continuam em milissegundos (contrato v1
  inalterado); só o cursor carrega microssegundos.
- `autorizadaEm` é `null` para uma reabertura com `autorizada_por` sem o
  evento do ledger — escrita fora de `ClosingService.autorizarReabertura`
  ou falha entre comandos na era pré-D15-A, sem chamador de produção (§5.4).
- Parâmetros enumerados/UUID repetidos na query (`estado`, `processoId`,
  `containerId`, `solicitanteMembershipId`, `divergente`) continuam
  resolvidos pelo primeiro valor (convenção D12); o valor ignorado nunca
  chega ao PostgreSQL. `limite`, `cursor`, datas e `tipo` repetidos são
  rejeitados.
- Log de falha inesperada: só código fechado + SQLSTATE, por convenção já
  congelada nas Entregas 1/2 (nunca a mensagem ou a pilha). Uma falha sem
  SQLSTATE (ex.: conexão recusada, `TypeError`) aparece como
  `FALHA_INESPERADA` sem mais detalhe; e um código de erro de socket de 5
  letras do Node (ex.: `EPIPE`) é rotulado como SQLSTATE — mesma regex dos
  módulos congelados `acoes/erros.ts`/`handoff/erros.ts`.
- A chave exata do cursor assume `criado_em` finito entre os anos 0001 e
  9999 (premissa documentada em `expressaoChaveExata`); nas três tabelas o
  valor é sempre `DEFAULT now()`.
- `docs/demurrage-producao-p1-diagnostico.md` não foi alterado: seu status
  da Entrega 3 ("implementada, aguardando auditoria final … não
  aprovada") continua verdadeiro, mas os totais e a lista de migrations ali
  são os de `507bf67` (até a 0045) até a decisão de congelamento.
- O filtro `estado=AUTORIZADA` de `/reaberturas` devolve vazio em dados
  reais (a autorização congelada passa direto a `RECALCULADA` na mesma
  transação) — comportamento congelado, não alterado.
- As rotas D12 (`/processos`, `/filtros`, detalhe, timeline) mantêm
  `paginacaoDaQuery` e o tratador central do app (que devolve
  `err.message`) — fora do escopo desta corretiva por instrução de não
  alterar rotas não relacionadas.
- O middleware de autenticação/autorização consulta o banco antes da
  validação de parâmetros (inerente: a organização vem da sessão).
- O benchmark original (`leituraOperacionalBenchmarkEntrega3.ts`) continua
  apagando o schema sem trava; só a documentação dele foi corrigida. O
  script novo (`leituraOperacionalPlanoEntrega3V11.ts`) exige
  `DEMURRAGE_PLANO_PERMITE_RESET=1`.
- Achados informativos/menores da revisão que **não** estavam na lista
  desta corretiva e continuam como estão: `temEvidencia` das pendências é
  sempre `false` (mesmo quando há tentativa de Free Time com evidência
  ligada por `pendencia_id`); `Entrega 3 #9` confere campos proibidos só
  pelo nome da chave; a tabela de §8 do relatório da Entrega 3 cita as rotas
  de ação sem o prefixo `/acoes`; `Entrega 3 #30` é vácuo depois do commit
  (documentado em §11 daquele relatório).

---

## 13. Status

- Entrega 3 com a corretiva v1.1: **implementada e validada (§9),
  aguardando nova revisão final. Não congelada.**
- Entregas 1 e 2: congeladas, sem alteração de código-fonte.
- Frontend: **nenhum arquivo alterado**. Nenhum redesenho iniciado.

---

## Apêndice A — saída completa de `leituraOperacionalPlanoEntrega3V11.ts`

Execução final, sem cortes (banco descartável, PostgreSQL 16, `DEMURRAGE_PLANO_PERMITE_RESET=1`). As linhas de `Planning`/`Buffers` e os UUIDs são os originais.

```
Schema até 0045_leitura_operacional_indices.sql: 45 migrations aplicadas.
Dados: 125000 pendências (100000 resolvidas no total; 20 resolvidas no processo-alvo).

===== ANTES (schema até 0045) — página 1, estado=resolvida =====
Limit  (cost=4245.95..4245.96 rows=4 width=180) (actual time=7.540..7.543 rows=11 loops=1)
  Buffers: shared hit=2053
  ->  Sort  (cost=4245.95..4245.96 rows=4 width=180) (actual time=7.539..7.541 rows=11 loops=1)
        Sort Key: dp.criado_em DESC, dp.id DESC
        Sort Method: quicksort  Memory: 30kB
        Buffers: shared hit=2053
        ->  Nested Loop Left Join  (cost=0.28..4245.91 rows=4 width=180) (actual time=0.020..7.521 rows=20 loops=1)
              Join Filter: (c.id = dp.container_id)
              Buffers: shared hit=2053
              ->  Nested Loop  (cost=0.28..4245.84 rows=4 width=116) (actual time=0.014..7.452 rows=20 loops=1)
                    Buffers: shared hit=2053
                    ->  Index Scan using processos_id_org_unique on processos p  (cost=0.28..8.30 rows=1 width=38) (actual time=0.008..0.011 rows=1 loops=1)
                          Index Cond: (id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid)
                          Buffers: shared hit=3
                    ->  Seq Scan on demurrage_pendencias dp  (cost=0.00..4237.50 rows=4 width=94) (actual time=0.005..7.430 rows=20 loops=1)
                          Filter: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid) AND (estado = 'resolvida'::text))
                          Rows Removed by Filter: 124980
                          Buffers: shared hit=2050
              ->  Seq Scan on containers c  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=20)
Planning:
  Buffers: shared hit=8
Planning Time: 0.169 ms
Execution Time: 7.563 ms

===== ANTES (schema até 0045) — página 2 (cursor), estado=resolvida =====
Limit  (cost=4712.76..4712.88 rows=1 width=180) (actual time=7.138..9.879 rows=10 loops=1)
  Buffers: shared hit=2098
  ->  Gather Merge  (cost=4712.76..4712.88 rows=1 width=180) (actual time=7.137..9.877 rows=10 loops=1)
        Workers Planned: 1
        Workers Launched: 1
        Buffers: shared hit=2098
        ->  Sort  (cost=3712.75..3712.75 rows=1 width=180) (actual time=4.371..4.373 rows=5 loops=2)
              Sort Key: dp.criado_em DESC, dp.id DESC
              Sort Method: quicksort  Memory: 27kB
              Buffers: shared hit=2098
              Worker 0:  Sort Method: quicksort  Memory: 25kB
              ->  Nested Loop Left Join  (cost=0.28..3712.74 rows=1 width=180) (actual time=0.946..4.341 rows=5 loops=2)
                    Join Filter: (c.id = dp.container_id)
                    Buffers: shared hit=2080
                    ->  Nested Loop  (cost=0.28..3712.72 rows=1 width=116) (actual time=0.942..4.325 rows=5 loops=2)
                          Buffers: shared hit=2080
                          ->  Parallel Seq Scan on demurrage_pendencias dp  (cost=0.00..3704.41 rows=1 width=94) (actual time=0.936..4.305 rows=5 loops=2)
                                Filter: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid) AND (estado = 'resolvida'::text) AND (ROW(criado_em, id) < ROW('2026-01-01 11:19:02.123501+00'::timestamp with time zone, 'f2c5933c-7206-464a-b264-f4ee9ae93c7c'::uuid)))
                                Rows Removed by Filter: 62495
                                Buffers: shared hit=2050
                          ->  Index Scan using processos_id_org_unique on processos p  (cost=0.28..8.30 rows=1 width=38) (actual time=0.003..0.003 rows=1 loops=10)
                                Index Cond: (id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid)
                                Buffers: shared hit=30
                    ->  Seq Scan on containers c  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=10)
Planning:
  Buffers: shared hit=8
Planning Time: 0.191 ms
Execution Time: 9.907 ms

Migrations aplicadas agora: ["0046_leitura_operacional_pendencias_por_processo.sql"]
Impressão digital de TODAS as tabelas idêntica antes/depois da 0046: true

===== DEPOIS (0046) — página 1, estado=resolvida =====
Limit  (cost=87.49..87.50 rows=4 width=180) (actual time=0.226..0.228 rows=11 loops=1)
  Buffers: shared hit=23 read=4
  ->  Sort  (cost=87.49..87.50 rows=4 width=180) (actual time=0.225..0.226 rows=11 loops=1)
        Sort Key: dp.criado_em DESC, dp.id DESC
        Sort Method: quicksort  Memory: 30kB
        Buffers: shared hit=23 read=4
        ->  Nested Loop Left Join  (cost=4.90..87.45 rows=4 width=180) (actual time=0.142..0.206 rows=20 loops=1)
              Join Filter: (c.id = dp.container_id)
              Buffers: shared hit=23 read=4
              ->  Nested Loop  (cost=4.90..87.38 rows=4 width=116) (actual time=0.126..0.169 rows=20 loops=1)
                    Buffers: shared hit=23 read=4
                    ->  Index Scan using processos_id_org_unique on processos p  (cost=0.28..8.30 rows=1 width=38) (actual time=0.056..0.057 rows=1 loops=1)
                          Index Cond: (id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid)
                          Buffers: shared hit=3
                    ->  Bitmap Heap Scan on demurrage_pendencias dp  (cost=4.62..79.04 rows=4 width=94) (actual time=0.066..0.104 rows=20 loops=1)
                          Recheck Cond: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (estado = 'resolvida'::text))
                          Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                          Heap Blocks: exact=20
                          Buffers: shared hit=20 read=4
                          ->  Bitmap Index Scan on demurrage_pendencias_processo_estado_criado_idx  (cost=0.00..4.62 rows=20 width=0) (actual time=0.056..0.056 rows=20 loops=1)
                                Index Cond: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (estado = 'resolvida'::text))
                                Buffers: shared read=4
              ->  Seq Scan on containers c  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=20)
Planning:
  Buffers: shared hit=12
Planning Time: 0.345 ms
Execution Time: 0.261 ms

===== DEPOIS (0046) — página 2 (cursor), estado=resolvida =====
Limit  (cost=43.56..43.57 rows=2 width=180) (actual time=0.084..0.087 rows=10 loops=1)
  Buffers: shared hit=16
  ->  Sort  (cost=43.56..43.57 rows=2 width=180) (actual time=0.084..0.085 rows=10 loops=1)
        Sort Key: dp.criado_em DESC, dp.id DESC
        Sort Method: quicksort  Memory: 27kB
        Buffers: shared hit=16
        ->  Nested Loop Left Join  (cost=4.80..43.55 rows=2 width=180) (actual time=0.048..0.075 rows=10 loops=1)
              Join Filter: (c.id = dp.container_id)
              Buffers: shared hit=16
              ->  Nested Loop  (cost=4.80..43.52 rows=2 width=116) (actual time=0.040..0.056 rows=10 loops=1)
                    Buffers: shared hit=16
                    ->  Index Scan using processos_id_org_unique on processos p  (cost=0.28..8.30 rows=1 width=38) (actual time=0.011..0.012 rows=1 loops=1)
                          Index Cond: (id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid)
                          Buffers: shared hit=3
                    ->  Bitmap Heap Scan on demurrage_pendencias dp  (cost=4.52..35.20 rows=2 width=94) (actual time=0.027..0.040 rows=10 loops=1)
                          Recheck Cond: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (estado = 'resolvida'::text) AND (ROW(criado_em, id) < ROW('2026-01-01 11:19:02.123501+00'::timestamp with time zone, 'f2c5933c-7206-464a-b264-f4ee9ae93c7c'::uuid)))
                          Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                          Heap Blocks: exact=10
                          Buffers: shared hit=13
                          ->  Bitmap Index Scan on demurrage_pendencias_processo_estado_criado_idx  (cost=0.00..4.52 rows=8 width=0) (actual time=0.020..0.020 rows=10 loops=1)
                                Index Cond: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (estado = 'resolvida'::text) AND (ROW(criado_em, id) < ROW('2026-01-01 11:19:02.123501+00'::timestamp with time zone, 'f2c5933c-7206-464a-b264-f4ee9ae93c7c'::uuid)))
                                Buffers: shared hit=3
              ->  Seq Scan on containers c  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=10)
Planning:
  Buffers: shared hit=8
Planning Time: 0.239 ms
Execution Time: 0.116 ms

===== DEPOIS (0046) — padrão estado=aberta (informativo) =====
Limit  (cost=32.01..32.01 rows=1 width=180) (actual time=0.053..0.055 rows=5 loops=1)
  Buffers: shared hit=22
  ->  Sort  (cost=32.01..32.01 rows=1 width=180) (actual time=0.052..0.053 rows=5 loops=1)
        Sort Key: dp.criado_em DESC, dp.id DESC
        Sort Method: quicksort  Memory: 26kB
        Buffers: shared hit=22
        ->  Nested Loop Left Join  (cost=4.61..32.00 rows=1 width=180) (actual time=0.027..0.045 rows=5 loops=1)
              Join Filter: (c.id = dp.container_id)
              Buffers: shared hit=22
              ->  Nested Loop  (cost=4.61..31.98 rows=1 width=116) (actual time=0.020..0.032 rows=5 loops=1)
                    Buffers: shared hit=22
                    ->  Bitmap Heap Scan on demurrage_pendencias dp  (cost=4.33..23.67 rows=1 width=94) (actual time=0.014..0.019 rows=5 loops=1)
                          Recheck Cond: ((processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid) AND (estado = 'aberta'::text))
                          Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                          Heap Blocks: exact=5
                          Buffers: shared hit=7
                          ->  Bitmap Index Scan on demurrage_pendencias_aberta_unica  (cost=0.00..4.32 rows=5 width=0) (actual time=0.008..0.008 rows=5 loops=1)
                                Index Cond: (processo_id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid)
                                Buffers: shared hit=2
                    ->  Index Scan using processos_id_org_unique on processos p  (cost=0.28..8.30 rows=1 width=38) (actual time=0.002..0.002 rows=1 loops=5)
                          Index Cond: (id = '03b88d62-fd92-4b03-af0b-67d30a51a83c'::uuid)
                          Buffers: shared hit=15
              ->  Seq Scan on containers c  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=5)
Planning:
  Buffers: shared hit=8
Planning Time: 0.232 ms
Execution Time: 0.081 ms

Reexecução das migrations: aplicadas=[] (já aplicadas: 46)

Dados /reaberturas: 1000 reaberturas RECALCULADA (organização-alvo), 6000 closing_events.

===== /reaberturas?estado=RECALCULADA (v1.1, com LATERAL de autorizadaEm) — página 1 =====
Limit  (cost=24.41..1434.74 rows=51 width=194) (actual time=0.051..0.599 rows=51 loops=1)
  Buffers: shared hit=615
  ->  Nested Loop Left Join  (cost=24.41..5555.15 rows=200 width=194) (actual time=0.050..0.594 rows=51 loops=1)
        Buffers: shared hit=615
        ->  Nested Loop Left Join  (cost=0.56..780.61 rows=200 width=154) (actual time=0.022..0.213 rows=51 loops=1)
              Join Filter: (u_aut.id = r.autorizada_por)
              Buffers: shared hit=207
              ->  Nested Loop Left Join  (cost=0.56..776.60 rows=200 width=141) (actual time=0.021..0.200 rows=51 loops=1)
                    Join Filter: (om_aut.usuario_id = r.autorizada_por)
                    Buffers: shared hit=206
                    ->  Nested Loop Left Join  (cost=0.56..774.10 rows=200 width=141) (actual time=0.020..0.182 rows=51 loops=1)
                          Join Filter: (u_sol.id = r.solicitada_por)
                          Buffers: shared hit=206
                          ->  Nested Loop Left Join  (cost=0.56..770.09 rows=200 width=144) (actual time=0.016..0.164 rows=51 loops=1)
                                Join Filter: (om_sol.usuario_id = r.solicitada_por)
                                Buffers: shared hit=205
                                ->  Nested Loop  (cost=0.56..767.59 rows=200 width=128) (actual time=0.015..0.143 rows=51 loops=1)
                                      Buffers: shared hit=205
                                      ->  Index Scan using reaberturas_estado_criado_idx on reaberturas r  (cost=0.28..105.09 rows=1000 width=90) (actual time=0.008..0.030 rows=51 loops=1)
                                            Index Cond: (estado = 'RECALCULADA'::text)
                                            Buffers: shared hit=52
                                      ->  Index Scan using processos_pkey on processos p  (cost=0.28..0.66 rows=1 width=54) (actual time=0.002..0.002 rows=1 loops=51)
                                            Index Cond: (id = r.processo_id)
                                            Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                                            Buffers: shared hit=153
                                ->  Seq Scan on organization_memberships om_sol  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=51)
                                      Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                          ->  Materialize  (cost=0.00..1.01 rows=1 width=29) (actual time=0.000..0.000 rows=1 loops=51)
                                Buffers: shared hit=1
                                ->  Seq Scan on usuarios u_sol  (cost=0.00..1.01 rows=1 width=29) (actual time=0.002..0.002 rows=1 loops=1)
                                      Buffers: shared hit=1
                    ->  Seq Scan on organization_memberships om_aut  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=51)
                          Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
              ->  Materialize  (cost=0.00..1.01 rows=1 width=29) (actual time=0.000..0.000 rows=1 loops=51)
                    Buffers: shared hit=1
                    ->  Seq Scan on usuarios u_aut  (cost=0.00..1.01 rows=1 width=29) (actual time=0.000..0.000 rows=1 loops=1)
                          Buffers: shared hit=1
        ->  Aggregate  (cost=23.85..23.86 rows=1 width=8) (actual time=0.007..0.007 rows=1 loops=51)
              Buffers: shared hit=408
              ->  Bitmap Heap Scan on closing_events ce  (cost=4.33..23.85 rows=1 width=8) (actual time=0.003..0.006 rows=1 loops=51)
                    Recheck Cond: (processo_id = r.processo_id)
                    Filter: ((tipo_evento = 'REABERTURA_AUTORIZADA'::text) AND (lower((payload ->> 'reaberturaId'::text)) = (r.id)::text))
                    Rows Removed by Filter: 5
                    Heap Blocks: exact=306
                    Buffers: shared hit=408
                    ->  Bitmap Index Scan on closing_events_processo_idx  (cost=0.00..4.33 rows=6 width=0) (actual time=0.001..0.001 rows=6 loops=51)
                          Index Cond: (processo_id = r.processo_id)
                          Buffers: shared hit=102
Planning:
  Buffers: shared hit=23
Planning Time: 0.658 ms
Execution Time: 0.634 ms

===== /reaberturas?estado=RECALCULADA (v1.1) — página 2 (cursor) =====
Limit  (cost=24.41..1441.09 rows=51 width=194) (actual time=0.051..0.637 rows=51 loops=1)
  Buffers: shared hit=613
  ->  Nested Loop Left Join  (cost=24.41..5302.25 rows=190 width=194) (actual time=0.050..0.632 rows=51 loops=1)
        Buffers: shared hit=613
        ->  Nested Loop Left Join  (cost=0.56..766.44 rows=190 width=154) (actual time=0.023..0.212 rows=51 loops=1)
              Join Filter: (u_aut.id = r.autorizada_por)
              Buffers: shared hit=205
              ->  Nested Loop Left Join  (cost=0.56..762.58 rows=190 width=141) (actual time=0.022..0.198 rows=51 loops=1)
                    Join Filter: (om_aut.usuario_id = r.autorizada_por)
                    Buffers: shared hit=204
                    ->  Nested Loop Left Join  (cost=0.56..760.20 rows=190 width=141) (actual time=0.021..0.180 rows=51 loops=1)
                          Join Filter: (u_sol.id = r.solicitada_por)
                          Buffers: shared hit=204
                          ->  Nested Loop Left Join  (cost=0.56..756.34 rows=190 width=144) (actual time=0.017..0.162 rows=51 loops=1)
                                Join Filter: (om_sol.usuario_id = r.solicitada_por)
                                Buffers: shared hit=203
                                ->  Nested Loop  (cost=0.56..753.96 rows=190 width=128) (actual time=0.015..0.140 rows=51 loops=1)
                                      Buffers: shared hit=203
                                      ->  Index Scan using reaberturas_estado_criado_idx on reaberturas r  (cost=0.28..106.59 rows=950 width=90) (actual time=0.009..0.031 rows=51 loops=1)
                                            Index Cond: ((estado = 'RECALCULADA'::text) AND (ROW(criado_em, id) > ROW('2026-02-02 21:14:38.49731+00'::timestamp with time zone, 'b7d4c8ff-54e9-47e7-ae97-1f948a0f63b5'::uuid)))
                                            Buffers: shared hit=50
                                      ->  Index Scan using processos_pkey on processos p  (cost=0.28..0.68 rows=1 width=54) (actual time=0.002..0.002 rows=1 loops=51)
                                            Index Cond: (id = r.processo_id)
                                            Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                                            Buffers: shared hit=153
                                ->  Seq Scan on organization_memberships om_sol  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=51)
                                      Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
                          ->  Materialize  (cost=0.00..1.01 rows=1 width=29) (actual time=0.000..0.000 rows=1 loops=51)
                                Buffers: shared hit=1
                                ->  Seq Scan on usuarios u_sol  (cost=0.00..1.01 rows=1 width=29) (actual time=0.001..0.002 rows=1 loops=1)
                                      Buffers: shared hit=1
                    ->  Seq Scan on organization_memberships om_aut  (cost=0.00..0.00 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=51)
                          Filter: (organization_id = '19f47290-d33b-4abf-aafd-9becc55ca3b5'::uuid)
              ->  Materialize  (cost=0.00..1.01 rows=1 width=29) (actual time=0.000..0.000 rows=1 loops=51)
                    Buffers: shared hit=1
                    ->  Seq Scan on usuarios u_aut  (cost=0.00..1.01 rows=1 width=29) (actual time=0.000..0.000 rows=1 loops=1)
                          Buffers: shared hit=1
        ->  Aggregate  (cost=23.85..23.86 rows=1 width=8) (actual time=0.007..0.007 rows=1 loops=51)
              Buffers: shared hit=408
              ->  Bitmap Heap Scan on closing_events ce  (cost=4.33..23.85 rows=1 width=8) (actual time=0.003..0.007 rows=1 loops=51)
                    Recheck Cond: (processo_id = r.processo_id)
                    Filter: ((tipo_evento = 'REABERTURA_AUTORIZADA'::text) AND (lower((payload ->> 'reaberturaId'::text)) = (r.id)::text))
                    Rows Removed by Filter: 5
                    Heap Blocks: exact=306
                    Buffers: shared hit=408
                    ->  Bitmap Index Scan on closing_events_processo_idx  (cost=0.00..4.33 rows=6 width=0) (actual time=0.001..0.001 rows=6 loops=51)
                          Index Cond: (processo_id = r.processo_id)
                          Buffers: shared hit=102
Planning:
  Buffers: shared hit=23
Planning Time: 0.656 ms
Execution Time: 0.674 ms
```
