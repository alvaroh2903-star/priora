# Produção P1 — Entrega 3 (contratos de leitura operacional)

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
nao_encontrado`, corpo idêntico nos dois casos.

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
  (`p1e3.pendencias.v1` / `p1e3.reaberturas.v1` / `p1e3.minutas.v1`) — um
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

Consulta de página: `WHERE (chave_ordenacao, id) [<|>] (cursor.ultimaChave,
cursor.ultimoId) ... ORDER BY chave_ordenacao, id LIMIT (limite + 1)` — o
`+1` nunca vaza para a resposta (`Entrega 3 #25`); o desempate por `id`
garante ordem determinística mesmo sob empate real de timestamp
(`Entrega 3 #24`, forçado no teste com um `UPDATE` que empata dois
`criado_em`); a travessia completa de todas as páginas não omite nem
duplica nenhuma linha, com tamanhos de página diferentes entre chamadas
(`Entrega 3 #22`/`#23`).

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
  tabela + contagem) idêntico antes/depois de TODAS as combinações de
  sucesso e de TODOS os caminhos de erro das três rotas (401, 403, 404, 400
  `valor_invalido`, 400 `cursor_invalido`, 400 `parametro_nao_aceito`) — nem
  uma leitura, nem um erro, grava uma única linha.
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

Cenário de pior caso medido (`leituraOperacionalBenchmarkEntrega3.ts`,
script standalone — não entra na suíte automática, mesmo padrão de
`gestaoBenchmarkG7.ts`): organização com 10.000 processos/contêineres,
`ANALYZE` explícito (estatísticas atualizadas, como acontece via autovacuum
em produção).

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
reescritas); testada em banco novo (0001→0045) e em upgrade (0044→0045) —
cobertas nos arquivos de lista de migrations já existentes, mecanicamente
atualizados (ver §9).

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

---

## 10. Totais de teste — validação sequencial completa

| Etapa | Resultado |
|---|---|
| 1. Novos testes Entrega 3 (`leituraOperacionalEntrega3.test.ts`) | **23/23** (itens 1–27, 30 — itens 28/29 são as etapas 3/4 abaixo, item 20 é a etapa 5) |
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
`cursor`) — `tsc --noEmit` não capturou isso (inferência de programa
completo vs. compilação por módulo do `ts-node`). Corrigido com anotações
de tipo explícitas (`const qs: string`, `const body: any`) nos dois laços de
paginação do teste `Entrega 3 #22-23-24-25`; a suíte completa foi
re-executada do zero depois da correção e terminou limpa (1130/1130).

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

---

## Status

- Migrations 0001–0044: intocadas.
- Entrega 1 e Entrega 2: regressão completa confirmada intacta (130/130
  nesta validação, mais os 1130/1130 da suíte completa que os contém).
- Entrega 3: três contratos de leitura implementados, testados (27 dos 30
  itens obrigatórios cobertos por teste automatizado nesta suíte; os itens
  28/29 — Entregas 1/2 intactas — e 20 — suíte completa zero falhas —
  verificados pela própria execução da suíte completa, não por asserção
  redundante dentro do arquivo novo), isolamento e zero-escrita
  comprovados, decisão de índice justificada por evidência de plano de
  consulta antes/depois.
- Frontend: **nenhum arquivo alterado**. Nenhum redesenho iniciado.

---

Backend Production P1 is ready for acceptance. Frontend work has not started
and requires the user's explicit design approval.
