# Fase D14 v1.3 — correção estreita sobre a v1.2 (NÃO aprovada, NÃO congelada)

> **Status:** release corretivo estreito sobre o commit `dbc8e01` (D14 v1.2), em
> resposta a 2 achados bloqueantes. As correções corretas das versões
> anteriores foram preservadas. **Nenhuma regra de D7–D13, criação de decisão
> de responsabilidade, tracking, relógio, tarifa, fechamento, UI ou migration
> foi alterada** (nenhum arquivo congelado tocado; nenhum arquivo em `public/`;
> nenhuma migration). A D14 **continua NÃO aprovada e NÃO congelada**; a **D15
> não foi iniciada**. Entrega para auditoria final.

## 1. Achado #1 — `NAO_APLICAVEL` é uma decisão válida, não ausência de decisão

**Defeito (v1.2):** `eficiencia.ts` tratava como "sem responsabilidade" tudo que
não fosse `CONFIRMADA_ROCKET`/`CONFIRMADA_CLIENTE`/`DIVIDIDA`, incluindo uma
decisão vigente `NAO_APLICAVEL` (decisão válida, versionada e auditada de D11).
Na v1.2 eu havia alinhado a *composição* a esse residual; a definição em si
estava errada.

**Correção:**

- Novo campo `concluidos.responsabilidadeNaoAplicavel` (decisão vigente
  `NAO_APLICAVEL`).
- `semResponsabilidadeAtribuida` conta **somente** contêineres sem **nenhuma**
  decisão vigente (de qualquer status).
- As três contagens anteriores foram preservadas. As **5 categorias** (Rocket,
  cliente, dividida, não aplicável, sem decisão) são mutuamente exclusivas e
  **somam `totalContaineresFinal`**.
- Composições: novo `G-D-RESP-NAO-APLICAVEL` (grão contêiner, escopo de
  período); `G-D-SEM-RESPONSABILIDADE` usa `NOT EXISTS` de qualquer decisão
  vigente, sem filtro de status. Registro e documentação do contrato atualizados.

"Vigente" = nenhuma outra decisão a substitui (`substitui_decisao_id`); uma
decisão substituída nunca conta.

## 2. Achado #2 — detalhe de responsabilidade paginado

**Defeito (v1.2):** `GET /responsabilidade` carregava todas as decisões vigentes da
organização e devolvia o array `decisoes` completo (memória e resposta sem limite).

**Correção:**

| Rota | Contrato |
|---|---|
| `GET /api/demurrage/v2/gestao/responsabilidade` (resumo) | `{ contrato, porStatus[≤4, inclui NAO_APLICAVEL], diariasConfirmadasRocket }` — uma consulta `GROUP BY status`. **A coleção `decisoes` foi removida** (mudança de contrato; nenhum consumidor no repositório — nem em `public/`). |
| `GET /api/demurrage/v2/gestao/responsabilidade/decisoes` (detalhe, novo) | `{ contrato, total, itens[≤limite], cursor }` |

Detalhe paginado (`listarDecisoesResponsabilidade`, `responsabilidade.ts`):

- **Ordem completa e estável** `decidido_em DESC, id DESC`; keyset
  `(d.decidido_em, d.id) < ($ts::timestamptz, $id::uuid)`; `LIMIT + 1`; sem
  offset; nenhuma lista da população em memória.
- O timestamp do cursor preserva **microssegundos** (`to_char ... .US`), nunca
  um `Date` truncado para ms (que duplicaria/perderia linhas entre timestamps
  próximos).
- **Cursor assinado** (HMAC, `cursorAssinado.ts` inalterado) ligado a:
  organização, versão de ordenação (`d14.gestao.responsabilidade.decisoes.v1`),
  hash dos filtros e a chave `(ts, id)`; qualquer divergência → `400
  cursor_invalido`.
- `limite`: inteiro positivo (regex, `400 valor_invalido` caso contrário),
  máximo fixo 200, padrão 50.
- Filtros opcionais, sem regra nova: `status` (enum), `processo`, `container`
  (UUID); valor inválido → `400 valor_invalido`.
- Isolamento: a decisão **e** o processo precisam pertencer à organização
  (`JOIN processos ... AND p.organization_id = d.organization_id`); um
  processo/contêiner de outra organização devolve resposta **idêntica** à de um
  id inexistente (nada vaza).
- Campos aprovados preservados (processo, contêiner, status, dias, valores,
  justificativa, evidência, `decididoEm`); acrescentado `decisaoId` (chave do
  cursor). RBAC inalterado (ANALYST/MANAGER/ADMIN; CLIENT 403); `organizationId`
  continua rejeitado; somente leitura.

## 3. Arquivos

Alterados: `leitura/gestao/eficiencia.ts`, `leitura/gestao/drilldown.ts`,
`leitura/gestao/indicadorRegistry.ts`, `leitura/gestao/responsabilidade.ts`
(reescrito), `routes/demurrageGestaoRoutes.ts`, `__tests__/gestaoV12.test.ts` (só
o novo indicador no conjunto fixado e no benchmark), `__tests__/gestaoRoutes.test.ts`.
Novos: `__tests__/gestaoV13.test.ts`, `__tests__/responsabilidadeSinteticaHelper.ts`,
`docs/demurrage-fase-d14-v1-3.md`.

## 4. Testes novos (`gestaoV13.test.ts` 10 + 1 em `gestaoRoutes.test.ts`) — sensíveis a mutação

| Requisito | Teste | Mutação que o faz falhar (verificada) |
|---|---|---|
| #1 (1)(2)(3)(4) NA só no seu campo; sem decisão só em "sem"; substituída não é vigente | 7 cenários isolados (NA, sem, Rocket, cliente, dividida, ROCKET→NA, NA→CLIENTE) | `NAO_APLICAVEL` volta a cair em "sem decisão" |
| #1 (5) soma das 5 categorias = total do período | cenário com 8 contêineres (1 fora do período) → `[1,2,1,2,1]` = 7 | idem |
| #1 (6) composições reconciliam e **particionam** `G-D-TOTAL-FINAL` | 5 composições = indicadores, contêineres exatos, sem sobreposição | composição "sem decisão" volta a ignorar só 3 status |
| registro | `G-D-RESP-NAO-APLICAVEL` (período, contêiner); predicate sem filtro de status | idem |
| #2 resumo limitado, sem `decisoes`, `NAO_APLICAVEL` real; reconcilia com o detalhe (totais por status e dias Rocket) | cenário completo | — |
| #2 asserção estática: `LIMIT $` + keyset + `limite + 1`, sem `OFFSET`; resumo `GROUP BY` sem materializar decisões | análise do código | remover o `LIMIT`; keyset sem id |
| #2 chave completa: 10 timestamps **idênticos** + 5 a **1 µs** (limites 1, 3, 4) — ordem exata, sem repetir/perder | cenário sintético | keyset sem desempate por id; cursor com ms |
| #2 cursor adulterado (assinatura/corpo), de outra organização, de outra versão, de outros filtros, `id`/`ts` inválidos; troca de tamanho de página; limite máximo | — | cursor não liga organização; não liga filtros |
| #2 filtros, isolamento (recurso de outra org ≡ inexistente), valores inválidos 400 | — | — |
| #2 benchmark (§5) | 100 × 12.000 | remover o `LIMIT` |
| #2 HTTP (D11 real): ANALYST/MANAGER/ADMIN, campos aprovados, `limite` 0/1,5/abc, cursor lixo, status/processo inválidos, `organizationId` rejeitado, CLIENT 403/401 | `gestaoRoutes.test.ts` | — |

## 5. Benchmark de paginação de decisões (12.000 decisões vigentes)

Massa sintética (decisões dos 4 status; grupos de 7 linhas com `decidido_em`
**idêntico** e linhas separadas por poucos µs). Os triggers de USUÁRIO da tabela
são desligados e religados **na mesma transação**, só no banco de teste isolado
(as decisões reais exigem devolução/relógio/cobertura de D11 e não podem ser
inseridas em lote).

| Decisões vigentes | Consultas/página (100 → 12.000) | Itens/página | 1ª pág. (ms) | pág. do meio (ms) | última pág. (ms) | Páginas (tamanhos 200/137/50/199/1000 alternados) |
|---|---|---|---|---|---|---|
| 12.000 | **2 → 2** | 50 | 31 | 35 | 11 | 77 |

Percorrendo as 12.000 decisões trocando o tamanho da página a cada requisição:
12.000 linhas vistas, **0 repetidas, 0 perdidas**, ordem **idêntica** à de
referência do PostgreSQL (`decidido_em DESC, id DESC`); todas as consultas são
`count(*)` ou `LIMIT $n`; nunca mais linhas que o limite. O resumo
(`porStatus`, dias Rocket) reconcilia exatamente com o detalhe, e
`NAO_APLICAVEL` aparece como decisão vigente em escala. **Nenhum índice foi
criado** (sem migration): o ordenamento top-N roda no PostgreSQL sobre a
organização e ficou em dezenas de ms a 12.000 linhas; se a escala crescer por
ordens de grandeza, um índice `(organization_id, decidido_em DESC, id DESC)` é
a evolução natural (exigiria migration — fora deste escopo).

Benchmark v1.2 (10.000 processos) reexecutado com o contrato corrigido —
reconciliação com `/eficiencia` mantida: `G-D-RESP-NAO-APLICAVEL` = 200,
`G-D-SEM-RESPONSABILIDADE` = **1.200** (era 1.400 na v1.2: as 200 decisões
`NAO_APLICAVEL` saíram de "sem decisão"), `G-D-TOTAL-FINAL` = 2.000; consultas
3 → 3 em todas as 22 estratégias com composição.

## 6. Regressão (PostgreSQL 16 local, `--test-concurrency=1`)

| Suíte | Resultado |
|---|---|
| Testes corretivos D14 v1.3 (`gestaoV13.test.ts` + rota em `gestaoRoutes.test.ts`) | **10/10 + 1/1** |
| D14 completa (`gestao*.test.ts`, 10 arquivos) | **88/88** |
| Regressão completa da engine (`npm run test:demurrage-engine`) | **812/812** |
| V1 (`npm test`) | **25/25** |
| UI D13 (`npm run test:demurrage-ui`) | **66/66** |
| `npx tsc --noEmit` | limpo |
| `npm run build` | limpo |
| Zero-escrita (fingerprint md5 de 20 tabelas antes/depois de todas as rotas GET, incluindo o resumo e o detalhe de responsabilidade) | **verde** |

Nota de ambiente: a suíte HTTP de D12 usa o pool padrão e precisa de
`DATABASE_URL`/`DEMURRAGE_DATABASE_URL` além de `DEMURRAGE_TEST_DATABASE_URL`.

## 7. Limitações declaradas

- Contrato de `/responsabilidade` mudou (campo `decisoes` removido): quem
  precisar da lista usa `/responsabilidade/decisoes`. Nenhum consumidor interno.
- Os agregados de `/eficiencia` continuam calculados em lote (decisão explícita
  de v1.2: só a *composição* de conclusão financeira e `G-E9` foi retirada).
- Sem índice dedicado ao detalhe (ver §5).

## 8. Status final

- **D14 permanece NÃO aprovada e NÃO congelada.**
- **A D15 não foi iniciada.**
- Entrega pronta para a auditoria final.
