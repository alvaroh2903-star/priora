# Fase D14 V1 — Gestão e Indicadores: relatório de entrega (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria, seguindo o diagnóstico corretivo
> aprovado no commit `b137a07`. Implementa os Gates **G1–G7**. Base
> intocada: D10/D11/D12 v1.2.3 congeladas; D13 (protótipo visual, ainda sem
> aprovação de design) **não** foi tocada — nenhum arquivo em `public/`
> muda nesta entrega. **Não** declaro a D14 aprovada nem congelada, e
> **não** iniciei a D15.

## 0. Escopo e o que esta fase NÃO faz

A D14 é um **read model de gestão**, backend-only:

- indicadores operacionais correntes (Grupo A);
- indicadores financeiros correntes e diferença potencial cliente×Rocket
  (Grupo B);
- indicadores de responsabilidade (Grupo C);
- indicadores históricos de eficiência/conclusão, reconstruídos a partir de
  fatos **FINAL** (Grupo D);
- indicadores de qualidade/tracking (Grupo E);
- drill-down de composição por indicador.

**Não existe** snapshot table, materializador, nova tabela, nova coluna ou
nova UI. Nenhuma regra de relógio, tarifa, cadência de tracking,
responsabilidade, fechamento, Free Time ou lifecycle foi reescrita — todo
módulo de `leitura/gestao/*` **só lê e agrega** o que os motores congelados
(D7–D13) já persistiram ou calculam sob demanda sem efeito colateral.

Nenhuma migration foi criada. Os únicos dois arquivos **congelados**
tocados tiveram só uma mudança de **visibilidade** (`function` →
`export function`), sem alterar corpo, assinatura ou comportamento — ver
§2.

## 1. Gates — o que cada um entrega e onde

| Gate | Entrega | Arquivo(s) |
|---|---|---|
| G1 | Seleção financeira autoritativa (≤1 envelope por lado/contêiner, nunca soma `valores_apurados` crua) | `leitura/gestao/selecaoFinanceira.ts` |
| G2 | Agregação exata (bigint centavos) + diferença potencial estruturada | `leitura/gestao/financeiro.ts` |
| G3 | Indicadores operacionais, dimensões independentes, frescor | `leitura/gestao/operacional.ts` |
| G4 | Eficiência/conclusão sobre FINAL, 8 indicadores separados + integridade | `leitura/gestao/eficiencia.ts` |
| G5 | RBAC/visibilidade por papel nas rotas | `routes/demurrageGestaoRoutes.ts` |
| G6 | Qualidade/tracking isolado por organização, drill-down, zero escrita | `leitura/gestao/qualidade.ts`, `leitura/gestao/drilldown.ts` |
| G7 | Desempenho, contagem de consultas constante, EXPLAIN ANALYZE | `__tests__/gestaoBenchmarkG7.ts` (benchmark) + correção em `eficiencia.ts` |

Grupo C (responsabilidade) não tinha gate próprio no diagnóstico — está em
`leitura/gestao/responsabilidade.ts`, coberto pelos testes de G5 (rota) e
pela leitura ponta a ponta.

## 2. Arquivos exatos alterados/criados

### 2.1 Tocados (frozen, mudança de visibilidade apenas)

- `src/demurrage-engine/leitura/contrato.ts` — `agregarLado` passou de
  privada para `export function agregarLado(...)`. Corpo idêntico. É a
  mesma soma em centavos `bigint` que a D12 v1.2.1 já usava; a Gestão a
  reaproveita para a agregação de organização (G2) em vez de reescrever a
  soma monetária.
- `src/demurrage-engine/persistence/lifecycleRepository.ts` —
  `clockFactDoCache` passou de privada para `export function
  clockFactDoCache(...)`. Corpo idêntico. É a mesma regra "ausente →
  PENDING" que a fila/detalhe já usam; a seleção financeira (G1) a
  reaproveita para montar o `ClockFact` usado em `selecionarValorAtivo`.
- `src/index.ts` — 2 linhas: import do novo router + `app.use('/api/demurrage/v2/gestao', demurrageGestaoRouter)`,
  montado **antes** de `/api/demurrage/v2` pelo mesmo motivo documentado
  no comentário já existente ali (evitar middleware duplicado da V1);
  confirmado sem colisão real de caminho (nem a V2 nem a V1 têm rota em
  `/gestao/*`).

Nenhuma outra linha de nenhum arquivo congelado foi tocada.

### 2.2 Novos — produção

| Arquivo | Linhas | Conteúdo |
|---|---|---|
| `leitura/gestao/selecaoFinanceira.ts` | 173 | G1 — seleção autoritativa por lote |
| `leitura/gestao/financeiro.ts` | 217 | G2 — agregação + diferença potencial |
| `leitura/gestao/operacional.ts` | 155 | G3 — Grupo A + frescor |
| `leitura/gestao/responsabilidade.ts` | 82 | Grupo C |
| `leitura/gestao/eficiencia.ts` | 256 | G4 — Grupo D |
| `leitura/gestao/qualidade.ts` | 194 | G6 — Grupo E |
| `leitura/gestao/drilldown.ts` | 199 | Drill-down de composição |
| `routes/demurrageGestaoRoutes.ts` | 146 | G5/G6 — as 6 rotas |

### 2.3 Novos — testes

| Arquivo | Testes |
|---|---|
| `__tests__/gestaoSelecaoFinanceira.test.ts` | 8 |
| `__tests__/gestaoFinanceiro.test.ts` | 17 |
| `__tests__/gestaoOperacional.test.ts` | 10 |
| `__tests__/gestaoEficiencia.test.ts` | 5 |
| `__tests__/gestaoRoutes.test.ts` | 8 |
| `__tests__/gestaoQualidade.test.ts` | 6 |
| `__tests__/gestaoBenchmarkG7.ts` | script standalone (não `*.test.ts`, não entra na suíte automática) |
| **Total** | **54 testes novos**, todos passando |

## 3. Contrato das rotas (API)

Conjunto EXATO, nenhuma a mais:

```
GET /api/demurrage/v2/gestao/operacional
GET /api/demurrage/v2/gestao/financeiro
GET /api/demurrage/v2/gestao/responsabilidade
GET /api/demurrage/v2/gestao/eficiencia
GET /api/demurrage/v2/gestao/qualidade
GET /api/demurrage/v2/gestao/indicadores/:indicadorId/composicao
```

Todas: `requireAuth` → `autorizarInterno` (D12 G6, reaproveitado sem
alteração) → handler que só chama uma função de `leitura/gestao/*`. Nenhum
handler escreve, recalcula, dispara tracking ou envia notificação.

Filtros aceitos:
- `/operacional`: `cliente`, `armador`, `responsavel`, `tipoEquipamento` (query).
- `/eficiencia`, `/qualidade`: `periodoInicio`, `periodoFim` (`AAAA-MM-DD`; `400 valor_invalido` se mal formado).
- `/indicadores/:id/composicao`: `limite`, `cursor` (cursor assinado — mesmo mecanismo HMAC de `cursorAssinado.ts`, D12, sem alteração).

`organizationId` — em query, corpo **ou** cabeçalho `x-organization-id` —
é sempre `400 parametro_nao_aceito`, nas 6 rotas (reaproveita a checagem
de `autorizacao.ts`, não reescrita).

## 4. Matriz de papéis (Gate G5)

| Papel | `/operacional` | `/financeiro` (campos gerais) | `/financeiro.diferencaPotencial` | `/responsabilidade` | `/eficiencia` | `/qualidade` | `/indicadores/.../composicao` |
|---|---|---|---|---|---|---|---|
| sem sessão | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| CLIENT | 403 | 403 | 403 | 403 | 403 | 403 | 403 |
| ANALYST | 200 | 200 (custo cliente, exposição Rocket, status financeiro visíveis) | `{ acessoRestrito: true }` | 200 | 200 | 200 | 200 |
| MANAGER | 200 | 200 | valor real (`grupos`/`inelegiveis`) | 200 | 200 | 200 | 200 |
| ADMIN | 200 | 200 | valor real | 200 | 200 | 200 | 200 |

O marcador `{ acessoRestrito: true }` (exportado como
`RESTRITO_MANAGER_ADMIN` em `demurrageGestaoRoutes.ts`) é um **tipo
distinto** de pendente/indisponível: nunca aparece dentro de
`diferencaPotencial.grupos`/`inelegiveis` (testado explicitamente — G5,
teste "marcador de restrição nunca se confunde com pendente/indisponível").

Interpretação adotada (decisão explícita desta implementação, registrada
aqui): da lista do diagnóstico, "valores de responsabilidade já decididos"
(G-B2/G-B3, `valorAtribuidoCliente`/`valorAtribuidoRocket`) e "exposição
Rocket" (G-B4/B5, `exposicaoRocket`) são indicadores **agregados**
distintos de "diferença potencial" (G-B6, comparação cliente×Rocket) — só
este último é restrito. A rota nunca restringe `valorAtribuidoRocket` para
ANALYST.

## 5. Gate G1 — prova da seleção financeira autoritativa

`buscarEnvelopesSelecionadosDaOrganizacao` (`selecaoFinanceira.ts`):

1. Carrega, em **3 consultas em lote** (nunca uma por contêiner): (a)
   containers + processos + `condicoes_comerciais` (para resolver
   `termo_tipo`), (b) `relogios` do cache, (c) `valores_apurados` ativos
   (`calculation_status IN ('OPEN','FINAL')`).
2. Para cada contêiner, resolve o motor comercial aplicável via
   `motorClienteAplicavelDe` (congelada) e chama `selecionarValorAtivo`
   (congelada) **com esse filtro** para o lado cliente — reduz
   estruturalmente a **no máximo uma linha ativa** mesmo que existam duas
   linhas de motores diferentes no banco.
3. Para o lado Rocket, `selecionarValorAtivo` é chamado sem filtro de
   motor — seguro porque, por construção do schema/motor (D4), só
   `exposicao_armador` grava linhas do lado `rocket`; nunca mais de uma
   fica ativa ao mesmo tempo (índice único `valores_apurados_ativo_unico`
   em `(container_id, relogio_tipo, motor_comercial)` já impede duas
   linhas ativas do MESMO motor).
4. O `ClockFact` usado para resolver pendência/frescor é o MESMO
   `clockFactDoCache` (agora exportado) que `filaOperacional.ts` já usa —
   nunca uma segunda regra "ausente → PENDING".

**Prova de não-duplicação entre módulos**: `financeiro.ts`, `eficiencia.ts`
e `drilldown.ts` chamam todos `buscarEnvelopesSelecionadosDaOrganizacao` —
nenhum escreve sua própria consulta a `valores_apurados`. `grep -rn
"FROM valores_apurados" src/demurrage-engine/leitura/gestao/` confirma: a
única leitura direta da tabela é dentro de `selecaoFinanceira.ts`
(seleção) e `qualidade.ts` (G-E8, contagem de UNAVAILABLE — métrica
diferente, nunca uma soma monetária).

**Prova de não-duplicação de contagem (double counting)**: como o passo 2
já reduz a ≤1 envelope por lado/contêiner ANTES de qualquer soma, a
agregação de organização (`agregarLado`, D12, reaproveitada) nunca soma
duas linhas do mesmo contêiner/lado — testado em
`gestaoSelecaoFinanceira.test.ts` ("dois motores comerciais ativos: só o
motor aplicável contribui") e `gestaoFinanceiro.test.ts` ("organização
nunca soma cliente-total menos rocket-total já agregados").

8 testes cobrindo: dois motores ativos (só o aplicável conta), Rocket com
no máximo um envelope, condição comercial ausente, relógio PENDING, valor
desatualizado (`dias_cobrados` insuficiente → PENDENTE, nunca "atual"),
múltiplas moedas (nunca misturadas), `NAO_APLICAVEL` dentro do Free Time
(zero dias nunca é fabricado), `UNAVAILABLE` com demurrage ativa (nunca
vira zero nem é omitido).

## 6. Gate G2 — agregação exata e diferença potencial

- Toda soma usa `centavosExatos`/`formatarCentavos` (bigint), nunca
  `Number`/ponto flutuante — testado até perto do limite de
  `NUMERIC(14,2)`.
- Confirmado/estimado/estimativa-provisória **separados** por grupo
  (moeda × status) — nunca combinados num único subtotal.
- `calcularDiferencaPotencial` (pura, por contêiner) checa, nesta ordem:
  `pendente` → `indisponivel` (inclui `NAO_APLICAVEL`, decisão explícita:
  sem número para comparar) → `incompativel_moeda` → `periodo_incompativel`
  (datas finais de apuração dos dois relógios divergem) → `obsoleto`
  (apuração anterior a hoje E contêiner não devolvido — devolução congela,
  nunca é "obsoleta"). Elegível carrega a **pior** qualidade dos dois
  lados (provisório > estimado > confirmado).
- `agregarDiferencaPotencial` soma as diferenças **já elegíveis por
  contêiner** — nunca `totalCliente − totalRocket` de dois agregados de
  organização já somados (isso misturaria contêineres onde só um lado
  está disponível). Inelegíveis contados à parte, por motivo, nunca
  escondidos.
- `valorAtribuidoCliente`/`valorAtribuidoRocket` vêm de
  `responsabilidade_decisoes` (D11), nunca de `valores_apurados` — fonte
  diferente, nunca combinada na mesma soma. Um lado com decisão
  calculando exatamente **zero** (ex.: 100% dos dias ao cliente) aparece
  como um grupo real de `0.00`, `valor_status='CALCULADO'` — não é
  "indisponível convertido em zero"; é um zero real, distinguível por
  `naoCalculadas` (decisões sem valor calculado, contadas à parte).

17 testes.

## 7. Gate G3 — indicadores operacionais

`montarGestaoOperacional` roda **2 consultas totais** (nunca por
contêiner): uma no grão contêiner (`estado`, badges, frescor), uma no
grão processo (`prioridade_balde`, `estado_mais_relevante`,
`apuracao_status`, pendência). G-A1–G-A10, cada um com `dimensao` e
`mutuamenteExclusivoCom` — só indicadores da MESMA dimensão (`estado`:
G-A2/G-A3/G-A9; `balde`: G-A4/G-A5) se excluem; `independente` (G-A6/A7/A8)
nunca exclui nada. `AVISO_DIMENSOES_INDEPENDENTES` vai em todo payload,
verbatim.

Frescor (`frescor.statusFrescor`): `atual` (zero desatualizado/ausente),
`parcialmente_desatualizada` (≥1 `lifecycle_calculated_at` nulo ou mais
antigo que 36h), `indeterminada` (zero contêineres — nunca "atual" por
omissão).

**Bug real encontrado e corrigido durante os testes**: o filtro
`responsavelMembershipId` referenciava a coluna `processos.responsavel_operacional_id`,
removida pela migration 0006 (Fase 1 corretiva) e substituída por
`responsavel_operacional_membership_id`. A consulta SQL nunca tinha sido
exercida com esse filtro antes dos testes de G3 — corrigida em
`operacional.ts`, sem qualquer outra mudança de comportamento.

10 testes: sobreposição de dimensões (um contêiner conta em 3 indicadores
independentes ao mesmo tempo), frescor nos 3 estados, G-A1 inclui
SILENCIOSO mas nunca os indicadores de "estado", contêiner nunca ingerido
não conta, filtros `clienteId`/`armadorId`/`responsavelMembershipId`.

## 8. Gate G4 — eficiência e conclusão

Só `apuracao_status='FINAL'` entra em qualquer média ou indicador de
conclusão. Dias corridos (subtração nativa de `DATE`, nunca `CivilDate`
reimplementada). "Dias de demurrage" usa `valores_apurados.dias_cobrados`
da linha FINAL — nunca o cache vivo. Reabertura/refechamento conta UMA VEZ
(linha única por processo; histórico de ciclos anteriores fica fora do
total atual, no drill-down).

8 indicadores de conclusão + 2 contadores de integridade, todos grão
contêiner:
`semCustoCliente`, `comCustoCliente`, `semExposicaoRocket`,
`comExposicaoRocket`, `semValorNenhumLado`,
`responsabilidadeConfirmadaRocket`, `responsabilidadeConfirmadaCliente`,
`responsabilidadeDividida`, mais `integridadePendenciaRemanescente`
(FINAL com envelope pendente/indisponível — **esperado 0**, medido
sempre) e `semResponsabilidadeAtribuida` (FINAL sem decisão — legítimo
quando `ZERO_CONFIRMADO` fecha sem exigir decisão).

Datas naturais por família, SEM override genérico: Empty Return
(`COALESCE(effective_return_date, tracking_return_date)`) para G-D1/D2/D3;
`primeiro_dia_demurrage` para G-D4; `fechado_em` para G-D5/D6 e os 8
indicadores de conclusão.

**Prova de que `integridadePendenciaRemanescente` é estruturalmente
inatingível pela via real**: confirmado empiricamente que o gate de
fechamento (`ClosingService.finalizarProcesso`, D10 v1.3) bloqueia
qualquer processo com relógio `PENDING`/`INVALID`
(`apuracao_indeterminada`) ou valor `UNAVAILABLE`/`ESTIMATED_PROVISIONAL`
em demurrage (`valor_*_nao_confirmado`) ANTES de permitir FINAL — e, em
profundidade, a migration 0017 instala triggers (`relogios_final_guard`,
`valores_apurados_final_guard`) que impedem qualquer escrita em
`relogios`/`valores_apurados` depois que o processo já é FINAL. O teste
que exercita esse contador o faz contra um cenário construído por `UPDATE
processos SET apuracao_status='FINAL'` **direto** (nunca pelo gate real) —
documentado no próprio teste como prova da rede de segurança, não como
caminho de produção.

5 testes: os 8 indicadores + integridade num único cenário com 4
contêineres FINAL reais (construídos pelo gate de fechamento real,
`ClosingService`), OPEN nunca conta, reabertura/refechamento conta uma
vez, datas naturais por família, integridade defensiva.

## 9. Gate G5 — RBAC e visibilidade (ver §4 para a matriz)

8 testes HTTP ponta a ponta (harness igual ao de `demurrageV2Routes.test.ts`,
D12 G7): CLIENT 403/sem sessão 401 nas 6 rotas, `organizationId`
rejeitado em query e em cabeçalho, ANALYST nunca recebe
`diferencaPotencial` real, marcador nunca se confunde com
pendente/indisponível, ANALYST lê `/operacional`/`/responsabilidade`
normalmente.

## 10. Gate G6 — qualidade, drill-down, isolamento, zero escrita

### 10.1 Isolamento de organização sobre tabelas globais de tracking

`tracking_fetches`/`tracking_incidents` são chaveadas só por
`tracking_target_id` (sem `organization_id` direto). Todo acesso em
`qualidade.ts` passa por `JOIN container_tracking_targets ctt ON
ctt.tracking_target_id = f.tracking_target_id JOIN containers c ON c.id =
ctt.container_id WHERE c.organization_id = $1` — o filtro de organização
entra ANTES da agregação, nunca depois.

**Teste de isolamento com target compartilhado** (duas organizações, um
MBL em comum): confirma que o target compartilhado é contado por AMBAS
(correto — uma consulta real serviu as duas), e que um target EXCLUSIVO
de uma organização nunca aparece na contagem da outra.

### 10.2 G-E9 (suspensão de tracking) — só vivo, via função congelada

`processosSuspensosAgora` carrega os fatos em lote e chama
`avaliarCadencia` (`cadencePolicy.ts`, pura, congelada, **importada**) —
nenhum limiar de 30 dias duplicado. Teste confirma, com a MESMA função,
que um contêiner com 36 dias de demurrage sem Empty Return é
`SUSPENDED` e outro sem demurrage não é.

### 10.3 G-E3 ausente

`GestaoQualidadeV1` **não tem** nenhum campo de "consultas evitadas" —
investigação conclusiva do diagnóstico (sem fonte persistida) confirmada;
teste garante que nenhuma chave como essa aparece no contrato.

### 10.4 Drill-down

`buscarComposicaoIndicador`: para cada `indicadorId`, busca os IDs com a
**MESMA predicate SQL** usada para contá-lo em
`operacional.ts`/`eficiencia.ts`/`responsabilidade.ts` — a composição
reconcilia com a contagem **por construção**, não por coincidência.
Paginação por cursor assinado (reaproveita `cursorAssinado.ts`, D12, sem
alteração) — nunca N+1 (os dados de exibição da página são buscados em
UM `= ANY($1)`, nunca por item).

### 10.5 Zero escrita — prova por fingerprint completo

Teste dedicado (`gestaoRoutes.test.ts`) calcula um fingerprint MD5 de
**20 tabelas** (`organizations`, `usuarios`,
`organization_memberships`, `processos`, `containers`, `relogios`,
`valores_apurados`, `responsabilidade_decisoes`, `demurrage_pendencias`,
`minutas`, `fechamentos`, `reaberturas`, `closing_events`,
`tracking_targets`, `container_tracking_targets`, `tracking_fetches`,
`tracking_incidents`, `condicoes_comerciais`, `tariff_tables`,
`tariff_brackets`, `field_observations`) via `md5(string_agg(t::text, '|'
ORDER BY t::text))` — sensível a QUALQUER INSERT/UPDATE/DELETE em
qualquer coluna. Bate as 6 rotas (incluindo drill-down) e confirma
`antes === depois`.

14 testes (6 no arquivo de qualidade + 8 no arquivo de rotas, somados ao
§9 acima).

## 11. Gate G7 — desempenho e regressão

### 11.1 Metodologia

Massa sintética gerada por SQL em lote (nunca pelo pipeline real —
inviável em escala de 10.000 processos) em
`__tests__/gestaoBenchmarkG7.ts` (script standalone, não entra na suíte
automática): N processos/contêineres com `estado`/`balde`/`apuracao_status`
distribuídos deterministicamente, 2 relógios e 2 valores apurados por
contêiner, decisões de responsabilidade para 1 em 10, pendências para 1
em 20, tracking para todos (sem compartilhamento — o isolamento já tem
suíte própria no Gate G6).

Executar:
```
DEMURRAGE_TEST_DATABASE_URL=... npx ts-node src/demurrage-engine/__tests__/gestaoBenchmarkG7.ts
```

### 11.2 Resultado — contagem de consultas (prova de ausência de N+1)

| Rota | N=100 | N=1.000 | N=10.000 |
|---|---|---|---|
| `/operacional` | 2 | 2 | 2 |
| `/financeiro` | 5 | 5 | 5 |
| `/responsabilidade` | 1 | 1 | 1 |
| `/eficiencia` | 9 | 9 | 9 |
| `/qualidade` | 7 | 7 | 7 |
| `/indicadores/G-A1/composicao` | 2 | 2 | 2 |

**Constante em todas as rotas, nas três ordens de grandeza — nenhuma
cresce com N.**

### 11.3 Resultado — tempo de execução (N=10.000, PostgreSQL 16, máquina de desenvolvimento)

| Rota | Tempo |
|---|---|
| `/operacional` | ~27-30 ms |
| `/financeiro` | ~205-252 ms |
| `/responsabilidade` | ~2 ms |
| `/eficiencia` | ~300-330 ms (após correção — ver 11.4) |
| `/qualidade` | ~87-103 ms |
| `/indicadores/G-A1/composicao` | ~10-11 ms |

### 11.4 Achado real e correção (sem migration)

`EXPLAIN (ANALYZE, BUFFERS)` em `mediaEmptyReturnAteConclusao`
(`eficiencia.ts`, G-D5) revelou que o PostgreSQL 16, dependendo da
qualidade da estimativa de linhas pós-carga em lote, escolhia um plano de
**Nested Loop reexecutando a agregação da CTE uma vez por processo
FINAL** (`loops=2000` sobre 10.000 contêineres) — O(processos ×
contêineres), medido em **~700–4.700 ms** com 10.000 processos.

Correção (reescrita de consulta, **sem índice novo, sem migration**):
1. Filtra `processos` por `FINAL` numa CTE própria ANTES de agregar
   `containers` (nunca depois) — reduz o universo agregado à ordem de
   grandeza relevante.
2. `AS MATERIALIZED` explícito nas duas CTEs (PostgreSQL 12+) — remove a
   possibilidade de o planner reexecutar a CTE por linha externa,
   independentemente da qualidade da estimativa.

Resultado após a correção: **~6–7 ms** no `EXPLAIN ANALYZE` isolado;
**~300 ms** medido via a aplicação completa (9 consultas de `/eficiencia`
juntas, com parametrização `$1` em vez de literal). Suíte de testes de G4
reexecutada após a correção: 5/5 continuam passando, resultado idêntico.

**Nenhuma migration foi necessária.** Este foi o único achado de
desempenho da fase; não há evidência de que algum índice novo seja
necessário — todas as consultas restantes usam `Index Scan`/`Index Only
Scan`/`Bitmap Index Scan` sobre índices já existentes
(`containers_org_idx`, `processos_org_idx`, `processos_prioridade_balde_idx`,
`valores_apurados_container_idx`, `responsabilidade_decisoes_org_idx`,
`tracking_fetches_target_idx`, `container_tracking_targets_target_idx`,
entre outros já cadastrados pelas migrations 0003–0034).

### 11.5 EXPLAIN ANALYZE — consultas dominantes (N=10.000)

Capturado pelo script (`explainPrincipais`); resumo:

| Consulta | Plano | Linhas reais | Buffers (shared hit) |
|---|---|---|---|
| `operacional.ts` consulta 1 (grão contêiner) | Nested Loop, `Index Scan` em `containers_org_idx` + `Index Only Scan` em `processos_id_org_unique` | 10.000 | ~30.700 |
| `operacional.ts` consulta 2 (grão processo) | `Index Scan` em `processos_org_idx` | 10.000 | ~240 |
| `selecaoFinanceira.ts` (containers+processos+condições) | Nested Loop indexado | 10.000 | ~31.000 |
| `selecaoFinanceira.ts` (valores_apurados em lote) | Nested Loop + `Bitmap Index Scan` em `valores_apurados_container_idx` | 20.000 | ~40.300 |
| `qualidade.ts` (fetches por organização) | Nested Loop duplo, `Index Only Scan` em `container_tracking_targets_unica` + `Index Scan` em `tracking_fetches_target_idx` | 10.000 | ~60.300 |

Nenhum `Seq Scan` sobre as tabelas de volume (`containers`, `processos`,
`valores_apurados`, `tracking_fetches`) nas consultas acima — todas usam
índice.

## 12. Indicadores adiados / fora de escopo (registrados, nenhum escondido)

- **G-C0** (possível responsabilidade sugerida) — depende do módulo
  Liberação, sem backend nesta base (diagnóstico §4). Fora de escopo.
- **G-E3** (consultas evitadas) — investigação conclusiva: sem fonte
  persistida, nenhuma estimativa produzida. Deliberadamente **ausente**
  do contrato (não um campo zerado).
- **Histórico de séries de G-E9** (suspensão) — só vivo; nenhum fato
  auditável de "quando" existe hoje para reconstruir uma série.
- **Snapshot/backlog histórico de indicadores** — fora de escopo desta
  fase por decisão explícita do pedido ("NO snapshot table, NO
  materializer").

## 13. Limitações conhecidas

- O benchmark de G7 roda numa única máquina de desenvolvimento, sem
  isolamento de I/O; os tempos absolutos (ms) são indicativos, não um SLA.
  A evidência que importa — contagem de consultas constante e ausência de
  `Seq Scan` sobre tabelas grandes — é estrutural e não depende da
  máquina.
- `integridadePendenciaRemanescente` (G4) é uma rede de segurança para um
  estado que o motor congelado impede estruturalmente de ocorrer pela via
  real (§8) — o teste que a exercita usa uma escrita direta no banco
  (fora do pipeline) para simular a condição, exatamente como já é
  prática estabelecida em `gestaoSelecaoFinanceira.test.ts`/D11.
- A interpretação de quais campos ficam restritos a MANAGER/ADMIN em
  `/financeiro` (§4) é uma decisão desta implementação sobre uma lista do
  diagnóstico que não detalhava campo a campo — documentada aqui para
  revisão explícita na auditoria.

## 14. Regressão completa

Executado nesta ordem, todos sem falha:

| Suíte | Resultado |
|---|---|
| D14 (6 arquivos de teste novos) | 54/54 |
| `npm run test:demurrage-engine` (D7–D14 completo) | **778/778** |
| `npm run test:demurrage-ui` (D13, navegador) | 66/66 |
| `npm test` (V1 — pré-alerta) | 25/25 |
| `npx tsc --noEmit` | sem erros |
| `npm run build` | sem erros |

Nenhum teste congelado (D10/D11/D12/D13) mudou de resultado.

## 15. Entrega

Commit e push para `claude/practical-cerf-mnz7oj`. **A D14 não está
aprovada nem congelada.** A D15 não foi iniciada.
