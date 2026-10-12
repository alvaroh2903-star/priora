# Fase D15-C v1.1 (corretiva) — Publicação Tarifária e Seleção Determinística

Baseline candidata: `67acf84` (entrega D15-C v1.0 — ainda **não** aprovada
nem congelada, conforme já registrado). D15-A, D15-B e D15-B v1.1 permanecem
CONGELADOS; nenhum teste ou comportamento deles foi reaberto. Nenhuma
correção de queue, moeda, overlap, hash ou entrega de alerta foi tocada —
escopo estritamente limitado à publicação tarifária e à seleção
determinística, como instruído. **Esta entrega também não é declarada
aprovada nem congelada — fica para a auditoria final de D15. D16 não foi
iniciado.**

## 1. Os dois achados bloqueantes

### Achado #1 — rascunho selecionável

`criarRascunho` cria uma versão mutável com `ativada_em = NULL`, mas
`selecionarVigente` (v1.0) nunca filtrava por essa coluna — um rascunho já
entrava em cálculos reais desde a criação, e só ficava imutável por TER
SIDO USADO (uma das duas condições de `tariff_table_esta_congelada`), sem
nunca ter passado por uma aprovação explícita. Corrigido.

### Achado #2 — seleção não determinística em empate

Quando duas ou mais versões ativadas cobriam a mesma data de referência, a
prioridade dependia de um `.sort()` em JavaScript sobre um resultado sem
`ORDER BY` — a ordem física das linhas devolvidas pelo Postgres (não
garantida) podia influenciar o resultado em caso de empate de vigência.
Corrigido com ordenação inteiramente em SQL.

## 2. Ciclo de vida final

| Estado | `ativada_em` | Editável (`substituirFaixas`) | Visível a `selecionarVigente` | Visível a `buscarPorId` |
|---|---|---|---|---|
| **Rascunho** | `NULL`, nunca usado | Sim | **Não** | Sim (administração/revisão) |
| **Ativado** | preenchido | Não (`TariffTableImutavelError` + trigger) | Sim | Sim |
| **Usado** (por um `ValorApurado`, mesmo sem `ativar()` explícito) | pode ainda ser `NULL` | Não (trigger) | Só se também ativado | Sim |
| **Correção** | — | — | nova linha/versão própria | — |

- **Rascunho**: `criarRascunho` (tabela + faixas, mesma transação). Editável
  por `substituirFaixas`. Invisível ao fluxo normal de cálculo
  (`selecionarVigente`) — só `buscarPorId` o alcança (administração/revisão,
  e a condição "Termo por Embarque", que fixa a tabela por ID, nunca por
  data).
- **Ativado**: `tariffTableService.ativar()`, chamado DEPOIS que a tabela e
  TODAS as suas faixas já foram inseridas com sucesso. A partir daí:
  imutável (trigger de banco) e visível a `selecionarVigente`.
- **Usado**: um `ValorApurado` passa a referenciar a tabela — hoje só
  possível via `buscarPorId` (Termo por Embarque) ou sobre uma versão já
  ativada; imutável desde então, mesmo que `ativada_em` continue `NULL`
  (ver §5, migration 0038, para o caso legado desse estado).
- **Correção**: `criarVersaoCorrigida` — sempre uma linha/versão NOVA
  (`MAX(versao)+1` da mesma identidade), nunca uma edição da base; ativa por
  padrão, só depois de todas as faixas da correção já inseridas.

## 3. Ordem de seleção (determinística, 100% em SQL)

`TariffTableRepository.selecionarVigente` agora resolve em até três
consultas, cada uma com `ORDER BY ... LIMIT 1` — nunca um resultado
desordenado seguido de comparador em JavaScript:

1. **Vigência conhecida que cobre a data**, só entre ATIVADAS
   (`ativada_em IS NOT NULL`): `ORDER BY vigencia_inicio DESC, versao DESC,
   id ASC LIMIT 1` — a vigência mais recente vence; empate de vigência é
   decidido pela versão mais alta; o ID é o desempate final, puramente
   defensivo (sem significado de negócio).
2. **Vigência desconhecida**, elegível a partir de `verificada_em`, só entre
   ATIVADAS: `ORDER BY verificada_em DESC, versao DESC, id ASC LIMIT 1` —
   mesma prioridade, agora por data de verificação.
3. Se nenhuma consulta acima encontrar uma candidata: uma consulta adicional
   (sem `ORDER BY`, só existência) decide `TARIFF_TABLE_NOT_FOUND` (nenhuma
   linha da dimensão existe, nem em rascunho) vs. `TARIFF_VERSION_NOT_PROVEN`
   (a identidade existe — em rascunho e/ou ativada — mas nada é
   comprovadamente aplicável).

`buscarPorId` permanece exatamente como era (sem filtro de `ativada_em`) —
é leitura direta por ID, não seleção por data; é o caminho correto para
administração/revisão de um rascunho e para a condição "Termo por Embarque".

## 4. Concorrência de ativação

`ativar()` deixou de ser "SELECT, decide em JS, UPDATE" (uma janela de
corrida real entre as duas instruções) e passou a ser um ÚNICO `UPDATE`
condicional:

```sql
UPDATE tariff_tables SET ativada_em = now()
 WHERE id = $1 AND ativada_em IS NULL
 RETURNING ativada_em
```

Sob N chamadas concorrentes para o MESMO ID, o lock de linha do primeiro
`UPDATE` a chegar serializa as demais; cada uma, ao reavaliar sua própria
cláusula `WHERE` já contra o estado committado pela vencedora, afeta ZERO
linhas — o trigger de imutabilidade nem chega a disparar para quem perdeu a
corrida (triggers de linha só correm sobre linhas de fato afetadas).
Resultado: exatamente uma chamada transiciona (`ativada: true`); todas as
demais leem o estado real e devolvem um NO-OP idempotente (`ativada:
false`, mesmo `ativadaEm` da vencedora) — nunca um erro de trigger
escapando só porque outra chamada venceu a corrida. `criarVersaoCorrigida`
passou a reusar esta MESMA função (em vez de um `UPDATE` próprio) para a
ativação imediata.

**Pré-requisito descoberto por esta própria correção**: o trigger
`forbid_tariff_table_mutation` (0037) barrava qualquer `UPDATE` sobre uma
linha "congelada" — e uma versão já USADA (por um `ValorApurado`) já era
congelada mesmo com `ativada_em` ainda `NULL`. O comentário original da
0037 assumia que a única forma de chegar congelada era por `ativada_em` já
preenchido; por isso a PRÓPRIA publicação (`ativada_em` `NULL` →
preenchido) de uma versão usada-mas-nunca-ativada seria rejeitada pelo
trigger que deveria permiti-la. Corrigido na 0038 (função substituída via
`CREATE OR REPLACE`, nenhuma reescrita do arquivo 0037): essa transição
específica — SOZINHA, nenhuma outra coluna mudando na mesma instrução — passa
a ser permitida mesmo sobre uma linha congelada só por uso.

## 5. Migration 0038 (aditiva; 0001–0037 intocadas)

`src/demurrage-engine/db/migrations/0038_d15c_v1_1_publicacao_tarifaria.sql`.
Como a 0037 já foi entregue como candidata (commit `67acf84`) e pode já ter
sido aplicada fora dos bancos de teste descartáveis desta sessão, a correção
é um degrau NOVO — a 0037 não foi editada.

Conteúdo:

1. **Substitui** `forbid_tariff_table_mutation()` (função, não a migration
   0037) para permitir a transição de publicação descrita no §4.
2. **Backfill truthful**: toda versão já USADA (`EXISTS (SELECT 1 FROM
   valores_apurados WHERE tabela_id = t.id)`) mas nunca ativada
   explicitamente (`ativada_em IS NULL`) recebe `ativada_em = now()` — o
   momento REAL em que esta migration corre, nunca uma data histórica
   inventada (não há como saber com certeza quando ela "deveria" ter sido
   ativada; o único fato já registrado é que está em uso). Sem essa
   publicação, a correção do achado #1 teria introduzido uma regressão real:
   uma versão já em uso, já imutável, ficaria de repente INVISÍVEL à
   seleção por data, quebrando o próximo recálculo autorizado de um
   processo OPEN que dependesse exatamente dela.
3. Uma versão que NUNCA foi usada e nunca foi ativada (rascunho genuíno)
   **não** é tocada — continua, corretamente, invisível até ser revisada e
   ativada de verdade.

Nenhuma coluna nova, nenhuma constraint nova — só a correção da função de
trigger e o backfill direcionado. Comprovado em `d15c.test.ts` #25 (4º
sub-caso, acrescentado nesta fase): uma versão legada usada-mas-nunca-
ativada é publicada com `ativada_em` real e recente (nunca anterior a
`criado_em`); um rascunho genuíno, nunca usado, no MESMO banco, permanece
intocado.

## 6. Seeds oficiais atualizados

`seedArmadorTables` (`tariffs/seed/armadorTables.ts`) e `seedRocket`
(compartilhado por `seedRocketTermoPorEmbarque`/`seedRocketTermoUnico`, em
`tariffs/seed/rocketTermoPorEmbarque.ts`) agora chamam
`tariffTableService.ativar()` como a ÚLTIMA instrução, só depois que a
tabela e TODAS as suas faixas já foram inseridas com sucesso — se qualquer
inserção de faixa falhar no meio (ex.: uma faixa sobreposta violando a
`EXCLUDE` constraint de R28), a tabela fica presa como rascunho (nunca
publicada com conteúdo incompleto), provado em `d15cV11.test.ts` #4.

## 7. Testes existentes afetados pela invisibilidade de rascunho

Toda tabela tarifária criada por `INSERT` direto em testes (fora dos seeds
oficiais) nascia, até aqui, implicitamente selecionável. Levantamento
completo de todo `INSERT INTO tariff_tables` do repositório (produção e
testes) e correção de cada site cujo caminho real passa por
`selecionarVigente` (os que são lidos só por `buscarPorId` — Termo por
Embarque fixado por ID — não precisaram de nada):

- `gestaoEficiencia.test.ts` e `demurrageVertical.test.ts`
  (`seedArmadorTabelaNormalizada`, tabela de armador usada pela exposição
  Rocket).
- `apuracaoV12.test.ts` (dois sites: tabela de armador do cenário "gap4
  rocket"; tabela Termo Único de vigência desconhecida do cenário "gap5").
- `apuracao.test.ts` (o site Termo Único `PROVISORIA_INCOMPLETA`; o site
  Termo por Embarque, fixado por ID na condição, ficou intacto de
  propósito).
- `d15c.test.ts` (`cenarioMoedaMista`/`tabelaArmador`, usados pelos
  cenários de moeda mista R29).

Três testes de FRONTEIRA DE MIGRATION (`responsabilidadeAuditoria.test.ts`,
`responsabilidadeV11.test.ts`, `responsabilidadeV12.test.ts`) congelam o
schema num degrau anterior a 0037 e só então chamam `cenario()`, que usa
`seedRocketTermoPorEmbarque` ou aciona `selecionarVigente` via
`recalcularApuracaoContainer` — ambos agora dependentes da coluna
`ativada_em`, que não existe nesse degrau. Corrigidos com o MESMO padrão de
scaffold local já estabelecido em D15-B (`ALTER TABLE tariff_tables ADD
COLUMN ativada_em TIMESTAMPTZ`, DDL idêntico ao da 0037, inserido logo após
o `runMigrations` travado no degrau antigo); nos dois testes que depois
avançam para a 0037 de verdade, o scaffold é desfeito (`DROP COLUMN`) antes
de retomar `runMigrations` sem `until` — mesmo padrão do `DROP TABLE
free_time_tentativas` já usado para o scaffold de R05.

Golden lists de migration atualizadas (`migrate.test.ts`,
`registroDemurrageV12.test.ts`, `responsabilidadeAuditoria.test.ts`,
`responsabilidadeV12.test.ts`, `responsavelOperacional.test.ts`, e os três
sub-casos de `d15c.test.ts` #25) para incluir
`0038_d15c_v1_1_publicacao_tarifaria.sql`.

## 8. Os 14 cenários exigidos (`d15cV11.test.ts`)

| # | Cenário | Resultado |
|---|---|---|
| 1 | Rascunho com datas de resto aplicáveis nunca é selecionado | ok |
| 2 | Rascunho não afeta cálculo OPEN (UNAVAILABLE, nunca total fabricado) | ok |
| 3 | `ativar()` publica — passa a ser selecionável imediatamente | ok |
| 4 | Ativação só ocorre depois de TODAS as faixas existirem (falha no meio do seed deixa rascunho) | ok |
| 5 | Empate de vigência conhecida entre ativadas — versão mais alta vence | ok |
| 6 | Vigência desconhecida — `verificada_em` decide primeiro, versão só desempata no empate | ok |
| 7 | Seleção repetida devolve a mesma versão, independente da ordem de inserção/consulta | ok |
| 8 | Duas chamadas concorrentes a `ativar()` são idempotentes | ok |
| 9 | Seeds oficiais continuam produzindo tabelas selecionáveis | ok |
| 10 | OPEN passa a usar a versão corretiva recém-ativada (`criarVersaoCorrigida`) | ok |
| 11 | FINAL permanece ligado à versão histórica mesmo com correção já ativada | ok |
| 12 | Edição de rascunho permanece possível antes da ativação | ok |
| 13 | Edição de rascunho é rejeitada depois da ativação | ok |
| 14 | D15-C v1.0 permanece 100% verde | validado na regressão (ver §9) |

## 9. Totais de regressão (ordem exigida)

| Suíte | Resultado |
|---|---|
| D15-A v1.0–v1.3 (4 arquivos) | 45/45 |
| D15-B + D15-B v1.1 | 32/32 |
| D15-C v1.0 (`d15c.test.ts`, 25 cenários/28 subtestes) + D15-C v1.1 (`d15cV11.test.ts`, 14 cenários) | 43/43 |
| Demurrage Engine completo (69 arquivos) | 932/932 |
| V1 (`npm test`) | 25/25 |
| D13 UI (`npm run test:demurrage-ui`) | 66/66 |
| `tsc --noEmit` | limpo |
| `npm run build` (produção) | limpo |

Nenhuma regressão em D15-A, D15-B ou D15-C v1.0. Três testes de fronteira de
migration precisaram do scaffold descrito no §7 (manutenção mecânica,
mesmo padrão já usado em D15-B — nenhuma mudança de comportamento do que
cada um verifica).

## 10. Limitações e observações

- A janela de "ao menos uma vez" das filas de claim/posse (R57/R58/R59,
  documentada em `docs/demurrage-fase-d15-c.md`) é inalterada — fora do
  escopo desta corretiva, como instruído.
- O defeito do trigger `forbid_tariff_table_mutation` (§4) é um achado NOVO,
  surgido diretamente da implementação desta corretiva (nunca exercido por
  nenhum teste de D15-C v1.0, já que nada ali chamava `ativar()` sobre uma
  versão já usada); corrigido na mesma migration 0038, com prova dedicada.
- Nenhum outro defeito novo foi encontrado em D15-A, D15-B ou nos domínios
  cobertos pelos 69 arquivos da suíte completa.

---

**Esta entrega não é declarada aprovada nem congelada.** Fica para a
auditoria final de D15. D16 não foi iniciado.
