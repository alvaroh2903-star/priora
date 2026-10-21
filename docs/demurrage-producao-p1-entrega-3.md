# Produção P1 — Entrega 3 (contratos de leitura operacional)

> **Atualizado pela corretiva v1.1** (`docs/demurrage-producao-p1-entrega-3-v1-1.md`),
> após a revisão final do commit `507bf67`. Os trechos marcados **[v1.1]**
> corrigem afirmações que não correspondiam ao código ou aos testes da
> entrega original. A Entrega 3 **ainda não está congelada** — aguarda nova
> revisão final.

**Base:** branch `claude/practical-cerf-mnz7oj`, commit de status/congelamento
`a2e72dd`. Entregas 1 e 2 **aprovadas e congeladas** — nenhuma delas foi
alterada nesta entrega. Migrations 0001–0044 **não foram tocadas**. Nenhum
arquivo de frontend foi alterado — nenhum HTML, CSS, JavaScript de
apresentação, Sidebar, Portal ou D13 foi editado.

Esta entrega completa os três contratos de leitura operacional, zero-escrita,
que faltavam para USAR as rotas de ação já congeladas (Entrega 2): listar
pendências acionáveis de um processo, descobrir reaberturas aguardando
autorização e descobrir minutas aguardando validação.

---

## 1. Contratos finais das rotas

### 1.1 `GET /api/demurrage/v2/processos/:processoId/pendencias`

Filtros: `estado` (`aberta`|`resolvida`, padrão `aberta`), `tipo`,
`containerId`, `criadoDesde`/`criadoAte`, `resolvidoDesde`/`resolvidoAte`,
`limite` (máx. 200), `cursor`. Ordem oficial: `criado_em DESC, id DESC`
(mais recente primeiro).

**[v1.1] Validação dos parâmetros (vale para as três rotas):** `limite` só
aceita inteiro decimal entre 1 e 200 — fração, expoente, sinal, espaços,
sufixo, valor repetido ou fora da faixa é `400 valor_invalido` (na v1, um
valor acima de 200 era limitado em silêncio e `1.5` virava HTTP 500). Datas
(`criadoDesde`/`criadoAte`/`resolvidoDesde`/`resolvidoAte`/
`recebidaDesde`/`recebidaAte`) só aceitam data de calendário real no formato
exato `AAAA-MM-DD` (ex.: `2026-02-30` é `400 valor_invalido`; na v1 virava
HTTP 500); período invertido continua `400 periodo_invertido`. Toda essa
validação acontece antes de qualquer consulta da leitura — em `/pendencias`,
inclusive antes da verificação de posse do processo. Falha inesperada é
`500 { "error": "erro_interno" }`, sem texto do banco.

```json
{
  "contrato": "demurrage.leitura.pendencias.v1",
  "itens": [{
    "pendenciaId": "uuid", "tipo": "armador_sem_tracking", "estado": "aberta",
    "abertaEm": "2026-09-20T12:00:00.000Z", "resolvidaEm": null,
    "processo": { "id": "uuid", "numero": "IM3001" },
    "container": { "id": "uuid", "numero": "ECSD0001234" },
    "contexto": { "rotulo": "Armador sem tracking", "campos": [{ "campo": "codigo", "rotulo": "Código do armador", "valor": "XYZ" }], "temEvidencia": false },
    "podeResolver": true
  }],
  "cursor": "string|null", "limite": 50
}
```

Isolamento: a rota confere `organizacaoDoProcesso` (reusado de
`acoes/organizacaoRecurso.ts`, Entrega 2) ANTES de chamar a leitura — um
`processoId` inexistente ou de outra organização é **sempre** `404
nao_encontrado`, corpo idêntico nos dois casos. **[v1.1]** Isso vale com
parâmetros válidos: os parâmetros agora são validados antes da verificação
de posse, então um parâmetro inválido devolve o mesmo 400 para qualquer
`processoId` (existente, inexistente ou de outra organização) — a
existência continua nunca revelada.

### 1.2 `GET /api/demurrage/v2/reaberturas`

Filtros: `estado` (vocabulário REAL — `SOLICITADA`|`AUTORIZADA`|`RECALCULADA`|`REFECHADA`,
padrão `SOLICITADA`), `processoId`, `solicitanteMembershipId`,
`criadoDesde`/`criadoAte`, `limite`, `cursor`. Ordem oficial: `criado_em ASC,
id ASC` (solicitação mais antiga primeiro — fila operacionalmente justa).

```json
{
  "contrato": "demurrage.leitura.reaberturas.v1",
  "itens": [{
    "reaberturaId": "uuid", "processo": { "id": "uuid", "numero": "IM3001" },
    "solicitadaEm": "2026-09-20T12:00:00.000Z", "estado": "SOLICITADA",
    "solicitante": { "membershipId": "uuid", "nome": "Ana Analista" },
    "justificativaResumo": "minuta diverge do tracking",
    "podeAutorizar": false,
    "autorizadaEm": null, "autorizador": null
  }],
  "cursor": "string|null", "limite": 50
}
```

**[v1.1] `autorizadaEm`:** é o instante do evento `REABERTURA_AUTORIZADA`
do ledger append-only `closing_events`, gravado por
`ClosingService.autorizarReabertura` na mesma transação da autorização e
nunca alterado depois. Na v1 vinha de `reaberturas.atualizado_em`, que o
refechamento (`REFECHADA`) reescreve — uma reabertura refechada mostrava o
instante do refechamento como se fosse o da autorização. Sem evento
comprovável, `autorizadaEm` é `null` (nunca inferido de outra coluna).
`autorizador` continua vindo de `reaberturas.autorizada_por`.

**Nota sobre o vocabulário** (diferença deliberada do enunciado, que sugeria
`SOLICITADA|AUTORIZADA|REJEITADA`): o modelo congelado D15-A nunca tem
`REJEITADA` — uma reabertura só é `SOLICITADA`, `AUTORIZADA`, `RECALCULADA`
ou `REFECHADA` (migrations 0016/0035). O filtro `estado` usa o vocabulário
REAL e PERSISTIDO, nunca um rótulo inventado pelo enunciado.

Isolamento: `reaberturas` não carrega `organization_id` (chaveia por
`processo_id`, convenção da Fase 8) — o isolamento vem do `JOIN processos`
filtrado por `organization_id`, nunca de um campo confiado sem verificação.

### 1.3 `GET /api/demurrage/v2/minutas`

Filtros: `estado` (`RECEBIDA`|`VALIDADA`|`REJEITADA`, padrão `RECEBIDA`),
`processoId`, `containerId`, `recebidaDesde`/`recebidaAte`, `divergente`
(booleano), `limite`, `cursor`. Ordem oficial: `criado_em ASC, id ASC`
(recebida mais antiga primeiro).

```json
{
  "contrato": "demurrage.leitura.minutas.v1",
  "itens": [{
    "minutaId": "uuid", "estado": "RECEBIDA",
    "processo": { "id": "uuid", "numero": "IM3001" },
    "container": { "id": "uuid", "numero": "ECSD0001234" },
    "recebidaEm": "2026-09-20T12:00:00.000Z",
    "recebidaPor": { "membershipId": "uuid", "nome": "Ana Analista" },
    "numeroInformado": "ECSD0001234", "dataInformada": "2026-09-10",
    "divergenteDoTracking": false, "temEvidencia": false, "podeValidar": false
  }],
  "cursor": "string|null", "limite": 50
}
```

Esta entrega **nunca** expõe `evidencia_ref` (conteúdo/referência bruta de
documento) — só o booleano `temEvidencia`.

---

## 2. Matriz de campos seguros por tipo de pendência (`leitura/pendenciaContextoSeguro.ts`)

Allowlist FECHADA, um mapeamento por tipo, para os 14 tipos atuais de
`demurrage_pendencias.tipo` (migration 0036 / `acoes/pendenciaCatalogo.ts`).
Todos resolvem para a MESMA ação suportada (`resolver`, via
`resolverPendenciaManual` — já congelada na Entrega 2):

| Tipo | Campos seguros expostos | Campos NUNCA expostos |
|---|---|---|
| `armador_ausente` | — | — |
| `armador_nao_cadastrado` | `codigo` | — |
| `armador_sem_tracking` | `codigo` | — |
| `mbl_ausente` | — | — |
| `tipo_ausente` | — | — |
| `tipo_nao_reconhecido` | `tipoOriginal`, `fonte` | — |
| `tipo_selecao_sem_observacao` | `motivo`, `tipoOriginalLegado`, `fonteLegado` | `origem`, `candidatas` (lista crua de `field_observations.id`) |
| `retorno_vazio_antes_descarga` | `campo`, `valorNovo`, `dischargeDate`, `gateOutDate`, `trackingReturnDate` | `observationId` |
| `cronologia_gate_out_antes_descarga` | idem acima | `observationId` |
| `cronologia_retorno_antes_gate_out` | idem acima | `observationId` |
| `condicao_comercial_ausente` | `diasDemurrageCliente` | — |
| `conflito_mesma_fonte` | `campo`, `fonte`, `valorRegistrado`, `valorConflitante` | `observationId` |
| `fallback_manual_superado` | `campo`, `valorManual`, `valorNovo`, `fonteNova` | `observationId` |
| `free_time_ausente` | `campo`, `motivo` | — |

**Tipo desconhecido ou futuro** (sem entrada nesta tabela, inclusive um tipo
que uma fase futura venha a introduzir sem atualizar este arquivo): rótulo
genérico fixo (`"Pendência"`), `campos: []`, `temEvidencia: false` — NUNCA o
JSON bruto de `contexto`. Prova: `Entrega 3 #10`.

`temEvidencia` é sempre `false` para todos os 14 tipos — nenhum deles carrega,
em produção, uma referência a documento/evidência bruta no `contexto`
(auditado nos seis arquivos de produção que abrem cada tipo). Nunca é um
placeholder — é o valor honesto.

`VesselCall`, administração de tracking e administração de tarifa
permanecem FORA desta rota (mesma exclusão já documentada em
`acoes/pendenciaCatalogo.ts`, Entrega 2).

---

## 3. Matriz de papel/capacidade

| Capacidade | ANALYST | MANAGER | ADMIN | Fonte da regra (reusada, nunca duplicada) |
|---|---|---|---|---|
| `podeResolver` (pendência) | ✅ | ✅ | ✅ | `PAPEIS_RESOLUCAO_PENDENCIA` (`registro/pendencias.ts`) |
| `podeAutorizar` (reabertura) | ❌ | ✅ | ✅ | `ehGestor` (`closing/closingService.ts`) |
| `podeValidar` (minuta) | ❌ | ✅ | ✅ | `ehGestor` (`closing/closingService.ts`) |

Nenhuma regra de papel foi reescrita — as três leituras só CHAMAM os
predicados já congelados. As flags são **puramente informativas**: a Entrega
2 sempre revalida papel e estado no momento da mutação (achado #2 da própria
Entrega 2 v1.2 — guarda definitiva dentro do serviço). Prova de que uma
leitura desatualizada nunca autoriza por si só: `Entrega 3 #17` (ANALYST com
`podeValidar`/`podeAutorizar` em `false` tenta mutar mesmo assim pela rota
congelada → `403`, idêntico ao que já acontecia sem esta entrega).

---

## 4. Contrato do cursor (keyset assinado) — `leitura/cursorKeyset.ts`

Reusa o MESMO primitivo HMAC-SHA256 do D12 (`cursorAssinado.ts` —
`codificarCursorAssinado`/`decodificarCursorAssinado`/`hmacLeitura`) —
nenhum formato de assinatura novo e incompatível. O payload é um keyset
verdadeiro (nunca OFFSET): `{ v, organizationId, filtrosHash, ultimaChave,
ultimoId }`, onde `ultimaChave`/`ultimoId` são o valor de ordenação e o `id`
do ÚLTIMO item da página anterior.

- `v` amarra o cursor a uma ROTA e VERSÃO DE ORDEM específicas
  (**[v1.1]** `p1e3.pendencias.v2` / `p1e3.reaberturas.v2` /
  `p1e3.minutas.v2`; os `.v1` da entrega original são rejeitados) — um
  cursor de uma rota nunca é aceito por outra (`Entrega 3 #20`).
- `organizationId` amarra o cursor à organização do pedido original — nunca
  aceito por outra organização, mesmo com assinatura válida (`Entrega 3 #19`).
- `filtrosHash` amarra o cursor à combinação EXATA de filtros ativos — `limite`
  NUNCA entra no hash (mudar só o tamanho da página preserva o cursor,
  `Entrega 3 #21` parte 2); qualquer outro filtro mudado invalida
  (`Entrega 3 #21` parte 1).
- Qualquer cursor malformado, adulterado, de outra organização, rota/versão
  ou filtros divergentes é `400 cursor_invalido` — nunca uma recuperação
  parcial (`Entrega 3 #18`).

Consulta de página: `... ORDER BY criado_em [DESC|ASC], id [DESC|ASC]
LIMIT (limite + 1)` — o `+1` nunca vaza para a resposta (`Entrega 3 #25`).

**[v1.1] Defeito da v1 e correção.** A v1 gravava `ultimaChave` com
`new Date(criado_em).toISOString()`: o driver `pg` entrega `TIMESTAMPTZ` como
`Date` do JavaScript (milissegundos), mas o PostgreSQL guarda
**microssegundos** e nenhuma escrita de produção define `criado_em` (é sempre
`DEFAULT now()`). A chave ficava truncada (`...16.004474` → `...16.004`), e a
comparação `criado_em [<|>] chave OR (criado_em = chave AND id [<|>] último)`
**repetia** a última linha de cada página nas rotas ASC (`/reaberturas`,
`/minutas` — com `limite=1` nunca terminava) e **omitia** linhas empatadas ou
no mesmo milissegundo na rota DESC (`/pendencias` — o registro de um processo
abre todas as pendências na mesma transação, com `now()` idêntico). Na v1.1:
a chave sai do próprio PostgreSQL como texto exato
(`to_char(criado_em AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`),
nunca passa por `Date`, e a página seguinte usa comparação por linha
`(criado_em, id) [<|>] ($chave::timestamptz, $id::uuid)`; as versões do
cursor passaram a `p1e3.pendencias.v2` / `p1e3.reaberturas.v2` /
`p1e3.minutas.v2` — cursores v1 são `400 cursor_invalido`.

**[v1.1] O que os testes de paginação realmente provam.** O teste original
`Entrega 3 #22-23-24-25` cobre **só** `/pendencias`, com `limite=4` **fixo**
nas duas travessias, linhas semeadas com 1 segundo de distância, e o empate
forçado fica nas posições 1–2 — nunca atravessa uma fronteira de página. Por
isso não detectou o defeito acima, e a afirmação anterior de "tamanhos de
página diferentes entre chamadas" era falsa. A v1.1 acrescenta
`Entrega 3 v1.1 #P1`–`#P3` (uma por rota; `#P1` percorre `aberta` e
`resolvida`): cada um insere linhas com `now()` normal, quatro linhas numa
única transação (empate exato) e quatro linhas no mesmo milissegundo
diferindo só nos microssegundos; percorre com tamanhos `[1]`, `[2]` e
`[1, 3, 2]` (tamanho mudando entre pedidos), exige como pré-condição que um
empate exato e um par sub-milissegundo caiam numa fronteira de página, e
verifica ordem oficial exata, cada id exatamente uma vez, término, nenhuma
página e nenhum cursor repetidos. `#P4` prova a rejeição de cursores v1 nas
três rotas. A implementação de `507bf67` falha `#P1`–`#P4`.

---

## 5. Contagem de consultas e evidência zero-escrita

- **Contagem de consultas**: `Entrega 3 #26` prova, com `contarConsultas`
  (mesmo instrumento de `gestaoBenchmarkG7.ts`, D14 Gate G7), que
  `buscarPendenciasProcesso` emite **exatamente 1 consulta SQL por página**,
  tanto com 100 quanto com 10.000 linhas na base — nenhuma consulta por
  linha devolvida, nenhuma consulta adicional proporcional ao tamanho da
  base. As três leituras seguem o mesmo desenho (uma única consulta com
  `JOIN`s fixos, nunca uma por item).
- **Zero-escrita**: `Entrega 3 #27` — fingerprint do banco inteiro (MD5 por
  tabela + contagem) idêntico antes/depois de uma amostra de leituras e de
  erros. **[v1.1] Escopo real do teste** (a redação anterior, "TODAS as
  combinações de sucesso e TODOS os caminhos de erro das três rotas", era
  mais ampla do que o teste): seis chamadas de sucesso (duas por rota, sem
  página 2 com cursor e sem a maioria dos filtros); 401, 403, 404
  e `valor_invalido` só em `/pendencias`; `cursor_invalido` só em
  `/reaberturas`; `parametro_nao_aceito` só em `/minutas`;
  `periodo_invertido` não é exercitado; a asserção confere os status, não os
  códigos de erro. A propriedade zero-escrita vale por construção (as três
  leituras só emitem `SELECT`), mas o teste cobre só essa amostra.
- Nenhuma das três leituras chama uma função que recalcula relógio, valor,
  lifecycle, processa fila, resolve pendência ou grava auditoria — cada
  handler só monta um filtro, chama UMA função de `leitura/*` (puro
  `SELECT`) e traduz a resposta.

---

## 6. Evidência de isolamento organizacional

| Garantia | Prova |
|---|---|
| Sem sessão → 401 | `Entrega 3 #1` |
| `CLIENT` → 403 | `Entrega 3 #2` |
| Membership revogada (removida) → 403, mesmo caminho fechado do CLIENT | `Entrega 3 #3` |
| `organizationId` em query/corpo/cabeçalho → 400 `parametro_nao_aceito` | `Entrega 3 #4` |
| Processo de outra organização → MESMO 404 de inexistente | `Entrega 3 #5` |
| `/reaberturas`/`/minutas` nunca vazam outra organização | `Entrega 3 #15` |
| Cursor de outra organização rejeitado | `Entrega 3 #19` |

Toda resolução de organização reusa `leitura/autorizacao.ts`
(`autorizarInterno`/`resolverAutorizacao`) — o MESMO middleware já congelado
do D12 Gate G6, montado no MESMO router (`demurrageV2Routes.ts`). Nenhuma
regra de RBAC nova foi escrita.

---

## 7. Decisão de migration/índice (EXPLAIN ANALYZE)

**Decisão:** uma migration aditiva, `0045_leitura_operacional_indices.sql`,
com DOIS índices — nenhum para `demurrage_pendencias` (a rota já é limitada
a UM processo e usa eficientemente o índice único parcial existente,
`demurrage_pendencias_aberta_unica`, migration 0028; o custo escala com o
número de pendências DAQUELE processo, não com o tamanho da organização).

**[v1.1] Essa justificativa só valia para `estado=aberta`.** O índice
parcial tem `WHERE estado = 'aberta'` e era o único índice secundário de
`demurrage_pendencias`; para `estado=resolvida` (filtro suportado pela rota)
o plano real era `Seq Scan` na tabela inteira — pendências resolvidas de
todas as organizações, que só crescem. Medido com o SQL exato da leitura
(`leituraOperacionalPlanoEntrega3V11.ts`, 125.000 pendências, 100.000
resolvidas): 7,56 ms (página 1) / 9,91 ms (página 2), descartando 124.980
linhas por filtro. A corretiva acrescenta a migration aditiva
`0046_leitura_operacional_pendencias_por_processo.sql` com
`demurrage_pendencias_processo_estado_criado_idx (processo_id, estado,
criado_em, id)`; depois dela, as duas páginas usam o índice (a comparação
keyset `(criado_em, id) < (...)` vira condição do próprio índice na página
2) — 0,26 ms / 0,12 ms. Resumo no relatório da v1.1, §4.3; saída completa
do script no Apêndice A daquele relatório.

Cenário de pior caso medido (`leituraOperacionalBenchmarkEntrega3.ts`,
script standalone — não entra na suíte automática, mesmo padrão de
`gestaoBenchmarkG7.ts`): organização com 10.000 processos/contêineres,
`ANALYZE` explícito (estatísticas atualizadas, como acontece via autovacuum
em produção).

**[v1.1] Requisitos de execução do benchmark:** o script faz
`DROP SCHEMA public CASCADE` no banco de `DEMURRAGE_TEST_DATABASE_URL` (ou
`DEMURRAGE_DATABASE_URL`/`DATABASE_URL`) — só use um banco descartável. O
comando documentado antes (`npx tsx ...`) dependia de um pacote que o
projeto não tem; o comando correto é
`node -r ts-node/register src/demurrage-engine/__tests__/leituraOperacionalBenchmarkEntrega3.ts`.
O script aplica todas as migrations antes de medir, então só reproduz os
números "Depois" da tabela abaixo; os números "Antes" não são reproduzíveis
por ele. Ele mede um SQL **simplificado** de `/reaberturas`/`/minutas`
(sem as junções de membership e, desde a v1.1, sem o `LEFT JOIN LATERAL`
de `autorizadaEm`) — os números abaixo descrevem o caminho de acesso por
índice, não a consulta exata atual. O script novo da v1.1
(`leituraOperacionalPlanoEntrega3V11.ts`) captura o SQL **exato** das
leituras, mede antes/depois da 0046 e o plano atual de `/reaberturas` com o
`LATERAL`, e só roda com `DEMURRAGE_PLANO_PERMITE_RESET=1`.

| Consulta | Antes (sem índice) | Depois (com índice) | Ganho |
|---|---|---|---|
| `GET /reaberturas` (padrão `SOLICITADA`, 200 de 10.000 linhas) | 7,0–7,6 ms, varre os 10.000 processos da organização via `reaberturas_aberta_unica` | 0,25–0,31 ms, usa `reaberturas_estado_criado_idx` — filtra por `estado` PRIMEIRO | ~25–30× |
| `GET /minutas` (padrão `RECEBIDA`, 200 de 10.000 linhas) | 5,7–7,3 ms, `Seq Scan`/`Bitmap Heap Scan` sobre a tabela inteira | 0,38–0,56 ms, usa `minutas_estado_criado_idx` | ~12–19× |

Plano ANTES (reaberturas): `Bitmap Heap Scan` em `processos` por
`organization_id` (10.000 linhas) → `Nested Loop` com `Index Scan` em
`reaberturas` POR PROCESSO (10.000 probes) → filtra `estado` por último.
Plano DEPOIS: `Index Scan` em `reaberturas` por `estado` PRIMEIRO (200
linhas) → `Index Scan` em `processos` por `id` (51 probes, já limitado pelo
`LIMIT`). Mesmo padrão para minutas (filtra `estado_minuta` primeiro, depois
junta com `containers`/`processos`).

```sql
CREATE INDEX reaberturas_estado_criado_idx ON reaberturas (estado, criado_em, id);
CREATE INDEX minutas_estado_criado_idx ON minutas (estado_minuta, criado_em, id);
```

As colunas `criado_em, id` no mesmo índice não são acidente: são exatamente
a ordem oficial de cada rota e as duas colunas que o cursor keyset usa no
`WHERE`/`ORDER BY` — o índice já nasce na ordem que a consulta de página
realmente percorre. Migration estritamente aditiva (0001–0044 não
reescritas); testada em banco novo (0001→0045) nos arquivos de lista de
migrations já existentes, mecanicamente atualizados (ver §9). **[v1.1]**
A afirmação anterior de teste de "upgrade (0044→0045)" era imprecisa:
nenhum teste parava exatamente na 0044; vários testes de upgrade já
existentes (a partir de 0005, 0028, 0033, 0038, 0041, 0042 e 0043) aplicam a
0045 junto com as migrations seguintes. A 0046 da v1.1 tem teste específico
de upgrade a partir da 0045 com dados (`Entrega 3 v1.1 #M1`).

---

## 8. Consistência com as rotas de ação da Entrega 2

Cada leitura entrega exatamente o identificador que a rota congelada
correspondente exige:

| Leitura | Identificador exposto | Rota de ação (Entrega 2) que o consome | Prova |
|---|---|---|---|
| `GET /processos/:id/pendencias` | `pendenciaId` + tipo PERSISTIDO | `POST /pendencias/:id/resolver` | — |
| `GET /reaberturas` | `reaberturaId` | `POST /reaberturas/:id/autorizar` | `Entrega 3 #12` (chama a rota de ação de ponta a ponta com o ID lido) |
| `GET /minutas` | `minutaId` | `POST /minutas/:id/validar` | `Entrega 3 #14` (idem) |

Nenhum ID é traduzido, reformatado ou reconstruído entre a leitura e a
ação — é o MESMO UUID persistido, consumido sem adaptação pela rota
congelada.

---

## 9. Migrations

Uma única migration aditiva nesta entrega:

- **`0045_leitura_operacional_indices.sql`** — dois índices (`reaberturas_estado_criado_idx`,
  `minutas_estado_criado_idx`), justificados por EXPLAIN ANALYZE (§7). 0001–0044
  não foram reescritas.

Os 8 arquivos de teste com listas de migrations hardcoded (herdadas das
entregas anteriores) foram mecanicamente atualizados para incluir
`0045_leitura_operacional_indices.sql`: `migrate.test.ts`,
`responsavelOperacional.test.ts`, `registroDemurrageV12.test.ts`,
`responsabilidadeV12.test.ts`, `responsabilidadeAuditoria.test.ts`,
`schedulerClaimFencing.test.ts`, `demurrageAcoesEntrega2V11.test.ts`,
`demurrageAcoesEntrega2V12.test.ts` — mesma manutenção mecânica rotineira já
estabelecida e autorizada nas entregas anteriores, nunca uma mudança de
regra.

**[v1.1]** A corretiva acrescenta a migration aditiva
`0046_leitura_operacional_pendencias_por_processo.sql` (um índice — §7; a
0045 não foi editada) e repete a mesma atualização mecânica nesses 8
arquivos para incluir a 0046.

---

## 10. Totais de teste — validação sequencial completa

Os números desta seção são os da entrega original (`507bf67`), confirmados
na revisão final. Os totais após a corretiva estão no relatório da v1.1.

**[v1.1] Variáveis de ambiente necessárias:** `DEMURRAGE_DATABASE_URL` (ou
`DATABASE_URL`) é **obrigatória** e deve apontar para um PostgreSQL
descartável — parte dos testes usa o `getPool()` de produção.
`DEMURRAGE_TEST_DATABASE_URL` é opcional (`testDb.ts` cai para as outras
duas); se definida, precisa apontar para o MESMO banco. Sem nenhuma URL, os
testes de integração são **pulados** (não falham — `testDb.ts`). Com só
`DEMURRAGE_TEST_DATABASE_URL`: dois subtestes HTTP de
`leituraAutorizacao.test.ts` (D12) falham com 500 (usam
`criarAutorizarInterno()` sem pool); os testes HTTP `#9`–`#15` de
`handoffProducaoP1.test.ts` falham por rejeição não tratada (o router de
handoff é criado sem pool); e `handoffProducaoP1V11.test.ts` pode travar —
reproduzido na corretiva v1.1. A suíte D13 UI precisa ainda de um Chromium
do Playwright disponível.

| Etapa | Resultado |
|---|---|
| 1. Novos testes Entrega 3 (`leituraOperacionalEntrega3.test.ts`) | **23/23** — 23 testes com rótulos `#1`–`#27` e `#30` (28 rótulos: `#6/#7`, `#16/#17` e `#22-25` são testes que cobrem mais de um item). **[v1.1]** A redação anterior ("item 20 é a etapa 5") estava errada: `#20` é o teste de cursor de outra rota, e a etapa 5 é a suíte V1. Os itens 28/29 (Entregas 1/2 intactas) são verificados pelas etapas 3 e 4. |
| 2. D12 read-model e autorização (`demurrageV2Routes.test.ts`, `leituraAutorizacao/Contrato/D12V12/Detalhe/Fila/FilaV11/Filtros/Timeline/TimelineV11.test.ts`) | **75/75** |
| 3. Entrega 2 ação (`demurrageAcoesEntrega2(.V11/.V12).test.ts`, `acoesSemLogicaDeNegocio.test.ts`) + Entrega 1 handoff (`handoffProducaoP1(V11).test.ts`, `handoffVinculoConcorrenciaV13.test.ts`, `handoffVinculoTransacaoV12.test.ts`) | **130/130** |
| 4. Suíte COMPLETA do Demurrage Engine (`npm run test:demurrage-engine`) | **1130/1130** — 0 falhas, 0 cancelamentos, 0 skips |
| 5. V1 (`npm run test`, auditoria pré-alerta) | **25/25** |
| 6. D13 UI (`npm run test:demurrage-ui`) | **66/66** |
| 7. `tsc --noEmit` | limpo, zero erros |
| 8. `npm run build` | limpo |

A etapa 4 já contém integralmente as etapas 1–3 (mesma suíte
`src/demurrage-engine/__tests__/*.test.ts`) — reportadas separadamente por
pedirem a ordem sequencial explícita; o número que importa para "zero
falhas/skips/cancelamentos" é o da etapa 4.

Durante a primeira tentativa da etapa 4, o runner real do projeto
(`ts-node`, usado por `npm run test:demurrage-engine` — diferente do `tsx`
usado nas verificações rápidas isoladas durante o desenvolvimento) recusou
compilar `leituraOperacionalEntrega3.test.ts` com `TS7022` (`'qs'`/`'body'`
implicitamente `any` por auto-referência dentro de um laço `do/while` sobre
`cursor`). Corrigido com anotações
de tipo explícitas (`const qs: string`, `const body: any`) nos dois laços de
paginação do teste `Entrega 3 #22-23-24-25`; a suíte completa foi
re-executada do zero depois da correção e terminou limpa (1130/1130).

**[v1.1] Causa correta:** `tsc --noEmit` não capturou o `TS7022` porque o
`tsconfig.json` **exclui** `src/**/*.test.ts` — o `tsc` (etapas 7 e 8) nunca
verifica tipos de arquivos de teste. A explicação anterior ("inferência de
programa completo vs. compilação por módulo") estava errada. Quem verifica
os tipos dos testes é o `ts-node` (sem `transpileOnly`) durante a própria
execução das suítes (etapas 1–6).

---

## 11. Confirmação explícita: nenhum arquivo de frontend foi alterado

Coberto estruturalmente por `Entrega 3 #30` (mesma disciplina de `v1.1 #24`/`v1.2 #21`
das entregas anteriores): varre `git status --porcelain` e falha se
qualquer caminho sob `public/`, `.html` ou `.css` estiver entre as mudanças
não commitadas. `git status --porcelain` nesta sessão, ao final da
implementação, lista exclusivamente:

```
 M src/demurrage-engine/__tests__/demurrageAcoesEntrega2V11.test.ts
 M src/demurrage-engine/__tests__/demurrageAcoesEntrega2V12.test.ts
 M src/demurrage-engine/__tests__/migrate.test.ts
 M src/demurrage-engine/__tests__/registroDemurrageV12.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeAuditoria.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeV12.test.ts
 M src/demurrage-engine/__tests__/responsavelOperacional.test.ts
 M src/demurrage-engine/__tests__/schedulerClaimFencing.test.ts
 M src/routes/demurrageV2Routes.ts
?? src/demurrage-engine/__tests__/leituraOperacionalBenchmarkEntrega3.ts
?? src/demurrage-engine/__tests__/leituraOperacionalEntrega3.test.ts
?? src/demurrage-engine/db/migrations/0045_leitura_operacional_indices.sql
?? src/demurrage-engine/leitura/cursorKeyset.ts
?? src/demurrage-engine/leitura/minutasOperacionais.ts
?? src/demurrage-engine/leitura/pendenciaContextoSeguro.ts
?? src/demurrage-engine/leitura/pendenciasOperacionais.ts
?? src/demurrage-engine/leitura/reaberturasOperacionais.ts
```

Todos os caminhos são backend (migration, módulos de leitura, rota, testes,
script de benchmark). Nenhum arquivo em `public/`, `.html`, `.css`,
JavaScript de apresentação, Sidebar, Portal ou D13. Nenhum redesenho de
frontend foi iniciado.

**[v1.1] Limites dessa prova e documento omitido.** `Entrega 3 #30` só olha
mudanças **não commitadas** — depois do commit ele passa por construção e
não prova nada sobre o que foi commitado. A prova real é o diff do commit:
`git diff --name-only a2e72dd 507bf67` não contém nenhum caminho de
frontend. A lista acima também omitia a documentação: o commit `507bf67`
adicionou este relatório **e alterou `docs/demurrage-producao-p1-diagnostico.md`**
(status da Entrega 3 marcado como "implementada, aguardando auditoria final"
e totais de regressão da entrega).

---

## Status

- Migrations 0001–0044: intocadas. **[v1.1]** 0045 também intocada; a
  corretiva acrescenta só a 0046 (aditiva).
- Entrega 1 e Entrega 2: regressão completa confirmada intacta (130/130
  nesta validação, mais os 1130/1130 da suíte completa que os contém).
- Entrega 3: três contratos de leitura implementados e testados — 23 testes
  com 28 rótulos de item (`#1`–`#27`, `#30`); os itens 28/29 (Entregas 1/2
  intactas) verificados pelas etapas 3 e 4 da validação (**[v1.1]** a
  contagem anterior, "27 dos 30 … e 20 — suíte completa", estava errada —
  ver §10). Isolamento comprovado; zero-escrita comprovada por construção e
  por amostra (§5).
- **[v1.1]** A revisão final de `507bf67` encontrou seis problemas (chave do
  cursor truncada, validação de parâmetros, mensagem do banco em erro
  inesperado, falta de índice para pendências resolvidas, semântica de
  `autorizadaEm` e imprecisões deste relatório). Todos corrigidos na
  corretiva v1.1 — ver `docs/demurrage-producao-p1-entrega-3-v1-1.md`.
- Frontend: **nenhum arquivo alterado**. Nenhum redesenho iniciado.

---

Delivery 3 (with the v1.1 corrective) is ready for a new final review; it is
**not** frozen yet. Frontend work has not started and requires the user's
explicit design approval.
