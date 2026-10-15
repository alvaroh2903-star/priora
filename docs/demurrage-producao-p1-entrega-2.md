# Produção P1 — Entrega 2: rotas internas de ação operacional

**Baseline:** branch `claude/practical-cerf-mnz7oj`, Entrega 1 congelada em `c8d49b2` (handoff automático, D10–D16 congelados, migrations 0001–0041). Esta entrega acrescenta a migration 0042 (aditiva) e um módulo novo (`src/demurrage-engine/acoes/`) mais um router novo (`src/routes/demurrageAcoesRoutes.ts`), sem alterar nenhum arquivo congelado do backend D10–D16, nenhuma migration existente, nenhum arquivo da Entrega 1 e **nenhum arquivo de frontend**.

---

## 1. Arquitetura

### 1.1 Rotas finas sobre serviços já congelados

`src/routes/demurrageAcoesRoutes.ts` expõe 7 rotas HTTP `POST` sob `/api/demurrage/v2/acoes`, montado **antes** do router de leitura `demurrageV2Router` (mesma razão já documentada para `demurrageGestaoRouter`: `/acoes` é um subcaminho mais específico de `/v2`, montar primeiro evita qualquer colisão com os padrões de rota do router de leitura).

Cada handler segue exatamente a mesma sequência, sem excecão:
1. **autentica** (`requireAuth`, sessão MSAL — mesmo middleware do resto do sistema);
2. **resolve o papel/organização da sessão** (`autorizarInterno`, D12 Gate G6, já congelado) — relido a cada requisição, nunca cacheado; bloqueia `CLIENT` (403); rejeita qualquer `organizationId` vindo de corpo/query/cabeçalho (400);
3. **confere a organização do recurso-alvo** (`acoes/organizacaoRecurso.ts`) — uma leitura estreita e própria desta entrega, feita **antes** de chamar qualquer serviço, porque nem todo serviço congelado devolve o mesmo "não encontrado" para um recurso de outra organização;
4. **valida só a forma do corpo** (presença/tipo dos campos de transporte — nunca uma regra de negócio);
5. **chama exatamente um serviço de aplicação já congelado**;
6. **traduz o resultado típado do serviço para HTTP** (nunca inventa um código novo de negócio).

Nenhum arquivo desta entrega grava ou lê uma tabela de negócio diretamente (`containers`, `field_observations`, `relogios`, `valores_apurados`, `responsabilidade_decisoes`, `minutas`, `fechamentos`, `reaberturas`) fora dos helpers de isolamento organizacional — isso é provado estaticamente (ver §7).

### 1.2 Correção de escopo em relação ao diagnóstico original

O fallback manual **não é** parte do handoff automatizado: `demurrage.handoff.v1` continua rejeitando `manual_fallback` (Entrega 1, inalterado). A nova rota de fallback é uma ação **humana**, autenticada, com justificativa e evidência obrigatórias — nunca uma rota de máquina-a-máquina.

### 1.3 Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `acoes/organizacaoRecurso.ts` | Resolve a organização dona de cada tipo de recurso (container, processo, minuta, reabertura, pendência) — isolamento, nunca regra |
| `acoes/erros.ts` | `ErroRotaAcao` (falhas de transporte desta entrega) + `classificarFalhaAcao` (mapeamento FECHADO de qualquer erro inesperado, mesmo desenho do `handoff/erros.ts` da Entrega 1) |
| `acoes/fallbackManualAdapter.ts` | Adaptador estreito: monta a entrada MÍNIMA do contrato `demurrage.registro.v1` para um fallback manual de um único contêiner e delega a `registrarProcessoDemurrage` (D10) — nunca escreve Free Time diretamente |
| `acoes/pendenciaCatalogo.ts` | Catálogo FECHADO de comandos de pendência suportados (família/ação/tipo) |
| `acoes/idempotencia.ts` | `comIdempotencia()` — chave de idempotência persistida (migration 0042), conexão dedicada (`pg.Client`), usada SÓ pela rota de registro de minuta |
| `acoes/leituraIdempotente.ts` | Leituras estreitas para traduzir um retry seguro do serviço congelado em resposta idempotente, sem chamar o serviço de novo |
| `routes/demurrageAcoesRoutes.ts` | As 7 rotas HTTP, finas |
| `db/migrations/0042_acoes_idempotencia.sql` | 1 tabela nova (`demurrage_acoes_idempotencia`), aditiva |

---

## 2. Catálogo de rotas, papel exigido e serviço chamado

| # | Método + caminho | Papel mínimo | Serviço congelado chamado | Isolamento organizacional |
|---|---|---|---|---|
| 1 | `POST /containers/:containerId/fallback-manual` | ANALYST, MANAGER, ADMIN | `registrarProcessoDemurrage` (D10), via `acoes/fallbackManualAdapter.ts` | `organizacaoDoContainer` |
| 2 | `POST /containers/:containerId/responsabilidade` | MANAGER, ADMIN | `decidirResponsabilidade` (D11) | `organizacaoDoContainer` |
| 3a | `POST /containers/:containerId/minutas` | ANALYST, MANAGER, ADMIN (sem RBAC de Gestor — captura, não decisão) | `ClosingService.registrarMinuta` | `organizacaoDoContainer` |
| 3b | `POST /minutas/:minutaId/validar` | MANAGER, ADMIN (verificado pelo próprio serviço) | `ClosingService.validarMinuta` | `organizacaoDaMinuta` |
| 4 | `POST /processos/:processoId/finalizar` | MANAGER, ADMIN | `ClosingService.finalizarProcesso` | `organizacaoDoProcesso` |
| 5a | `POST /processos/:processoId/reabertura/solicitar` | ANALYST, MANAGER, ADMIN | `ClosingService.solicitarReabertura` | `organizacaoDoProcesso` |
| 5b | `POST /reaberturas/:reaberturaId/autorizar` | MANAGER, ADMIN (verificado pelo próprio serviço) | `ClosingService.autorizarReabertura` | `organizacaoDaReabertura` |
| 6 | `POST /pendencias/:pendenciaId/resolver` | ANALYST, MANAGER, ADMIN | `resolverPendenciaManual` (D15-B R45/R56) | `organizacaoDaPendencia` |

Em todas as 7, `CLIENT` recebe 403 antes mesmo de chegar à rota (middleware `autorizarInterno`, comum a todas). Nenhuma rota é montada para o Portal do Cliente.

**Papel sempre relido, nunca confiado pelo chamador:** o `membershipId`/`papel`/`organizationId` usados em CADA rota vêm exclusivamente de `req.autorizacao` (resolvido por `autorizarInterno` a partir de `organization_memberships`, nesta mesma requisição) — nunca de um campo do corpo. Onde o corpo aceita `autorMembershipId`/`membershipId` (ver testes #12 e #28), o valor é **ignorado silenciosamente** em favor do membership real da sessão — nunca um erro, porque não é um parâmetro que a rota documenta aceitar.

---

## 3. Contratos de requisição e resposta

### 3.1 Fallback manual — `POST /containers/:containerId/fallback-manual`

```ts
// corpo
{
  campo: 'house' | 'master',       // obrigatório
  valorDias: number,               // obrigatório
  observadoEm: string,             // obrigatório (ISO 8601)
  evidenciaRef: string,            // obrigatório
  justificativa: string,           // obrigatório
}
// sucesso 200
{ resultado: 'aplicado', processoId, containers }
// pendência pós-commit (durável, não é falha de negócio) 200
{ resultado: 'aceito_com_pendencia', processoId }
// falha do contrato D10 400/409
{ error: <codigo D10>, detalhe }
```

Nunca chama `promoverHouseFreeTimeComClient`/`promoverMasterFreeTimeComClient` diretamente — monta a entrada mínima do contrato `demurrage.registro.v1` (um único contêiner, só o campo de Free Time em questão) e delega inteiramente a `registrarProcessoDemurrage`, herdando toda a governança já congelada do D10 v1.1/v1.2: justificativa + `autorMembershipId` reais obrigatórios, evidência obrigatória, papel permitido (`ANALYST`/`MANAGER`/`ADMIN`), nunca aceita `fonte: 'tracking_service'` para este campo, aviso durável aos gestores.

### 3.2 Decisão de responsabilidade — `POST /containers/:containerId/responsabilidade`

```ts
{
  status: 'CONFIRMADA_CLIENTE' | 'CONFIRMADA_ROCKET' | 'DIVIDIDA' | 'NAO_APLICAVEL' | ...,
  baseRelogio: 'RELOGIO_CLIENTE' | 'RELOGIO_ROCKET' | 'NAO_APLICAVEL',
  justificativa: string, evidenciaRef: string,
  periodos: Array<{ lado, inicio, fim }>,
  motivoEstruturado?: string, substituiDecisaoId?: string, motivoCorrecao?: string,
}
// sucesso 200
{ decisaoId, versao, status }
// falha 400/403/404/409
{ error: <codigo D11 fechado>, detalhe }
```

Delega inteiramente a `decidirResponsabilidade` (D11) — cobertura completa de dia, restrição de `NAO_APLICAVEL`, versionamento otimista, base de valoração e invalidação, histórico append-only: tudo preservado sem nenhuma duplicação de regra na rota.

### 3.3 Minuta — registro `POST /containers/:containerId/minutas`

```ts
// cabeçalho OBRIGATÓRIO: Idempotency-Key
{ numeroInformado?: string, dataInformada?: string, evidenciaRef?: string }
// sucesso 201
{ minutaId, estado: 'RECEBIDA' }
```

### 3.4 Minuta — validação `POST /minutas/:minutaId/validar`

```ts
{ aceitarDivergencia?: boolean }
// validada sem divergência 200
{ ok: true, resultado: 'validada', dataValidada, divergente: false }
// divergência detectada, aguardando revisão explícita 200
{ ok: true, resultado: 'divergencia_pendente', dataInformada, trackingReturnDate }
// aceita_divergência=true 200
{ ok: true, resultado: 'validada', dataValidada, divergente: true }
// já processada (idempotente) 200
{ resultado: 'ja_processada', estado, dataValidada, divergente }
// rejeitada pela coerência (NUMERO_DIVERGENTE etc.) 200
{ ok: true, resultado: 'rejeitada', motivo }
```

### 3.5 Finalização — `POST /processos/:processoId/finalizar`

```ts
{ justificativa?: string }
// sucesso 200
{ resultado: 'finalizado' }
// já final (idempotente) 200
{ resultado: 'ja_final', fechamentoId }
// gate bloqueado 403/404/409
{ error: <motivo fechado do ClosingService> }
```

### 3.6 Reabertura — solicitação `POST /processos/:processoId/reabertura/solicitar`

```ts
{ justificativa: string }
// nova 201
{ resultado: 'solicitada', reaberturaId }
// já existia uma aberta (idempotente) 200
{ resultado: 'ja_existe', reaberturaId }
```

### 3.7 Reabertura — autorização `POST /reaberturas/:reaberturaId/autorizar`

```ts
// sem corpo
// sucesso 200
{ resultado: 'autorizada' }
// já autorizada (idempotente) 200
{ resultado: 'ja_autorizada', estado }
```

### 3.8 Resolução de pendência — `POST /pendencias/:pendenciaId/resolver`

```ts
{ familia: 'demurrage_pendencia', acao: 'resolver', tipo: <um dos 14 tipos>, motivo: string }
// sucesso 200
{ resultado: 'resolvida' | 'ja_resolvida' }
// combinação fora do catálogo 400, ZERO leitura/escrita de linha
{ error: 'familia_nao_suportada' | 'acao_nao_suportada' | 'tipo_nao_suportado' }
```

---

## 4. Idempotência: decisão por rota

| Rota | Mecanismo natural | Precisou de chave nova? |
|---|---|---|
| Fallback manual | Dedup na camada de `field_observations`/hash do contrato D10 (o chamador informa `observadoEm`; retry idêntico hasheia igual) | Não |
| Decisão de responsabilidade | Versionamento otimista (D11) — retry sem `substituiDecisaoId` novo falha com `VERSAO_DESATUALIZADA`, nunca duplica versão | Não |
| **Registro de minuta** | **Nenhum** — `ClosingService.registrarMinuta` não tem RBAC nem chave natural; duas chamadas idênticas criam duas linhas `RECEBIDA` distintas | **Sim — `Idempotency-Key` obrigatória, migration 0042** |
| Validação de minuta | Nenhum no próprio serviço (confirmado por leitura direta do código — `validarMinuta` não verifica `estado !== 'RECEBIDA'` antes de revalidar) | Resolvido na ROTA: pré-leitura (`MinutaRepository.findById`) curto-circuita para `ja_processada` sem chamar o serviço de novo — sem tocar no serviço congelado |
| Finalização | `ja_final` (D15-A) | Não — a rota só traduz `ja_final` em 200 lendo o fechamento já existente |
| Solicitação de reabertura | Índice único parcial + `reabertura_ja_aberta` (D15-A) | Não — a rota traduz em 200 lendo a reabertura já aberta |
| Autorização de reabertura | `reabertura_ja_autorizada` (D15-A) | Não — a rota traduz em 200 lendo o estado já autorizado |
| Resolução de pendência | No-op silencioso `{resolvida:false}` quando já resolvida (D15-B) | Não |

**Por que uma conexão dedicada em `comIdempotencia()`:** a Entrega 1 (v1.3) corrigiu uma saturação de pool quando duas conexões do MESMO pool eram necessárias simultaneamente sob concorrência (`resolverVinculoProcesso`). `comIdempotencia()` reproduziria exatamente essa classe de risco se usasse `pool.connect()` para o lock consultivo enquanto a função `executar()` (que chama `ClosingService.registrarMinuta`, usando o MESMO pool) está em voo — por isso o lock usa um `pg.Client` dedicado, nunca o pool compartilhado.

---

## 5. Pendências suportadas nesta entrega vs. adiadas

Catálogo fechado (`acoes/pendenciaCatalogo.ts`): família `demurrage_pendencia` (tabela `demurrage_pendencias`), ação `resolver`, e os 14 tipos atuais da restrição `CHECK` da migration 0036:

`armador_ausente`, `armador_nao_cadastrado`, `armador_sem_tracking`, `mbl_ausente`, `tipo_ausente`, `tipo_nao_reconhecido`, `tipo_selecao_sem_observacao`, `retorno_vazio_antes_descarga`, `cronologia_gate_out_antes_descarga`, `cronologia_retorno_antes_gate_out`, `condicao_comercial_ausente`, `conflito_mesma_fonte`, `fallback_manual_superado`, `free_time_ausente`.

**Explicitamente adiado desta entrega** (conforme instrução do usuário):
- administração de `vessel_call_pendencias` (pendências de VesselCall);
- atualização manual de tracking;
- administração de tarifa;
- `ft_divergencias` (reconhecimento/resolução de divergência de Free Time).

Qualquer combinação família/ação/tipo fora do catálogo é rejeitada com 400 **antes** de qualquer leitura ou escrita (prova no teste #25).

---

## 6. Auditoria

Nenhuma tabela de auditoria nova foi criada — cada ação reaproveita o histórico append-only já congelado do serviço que ela chama:

| Ação | Onde fica a auditoria |
|---|---|
| Fallback manual | `demurrage_fallback_manual_justificativas` + `demurrage_fallback_manual_avisos` (D10 v1.2) |
| Decisão de responsabilidade | `responsabilidade_decisoes` (append-only, D11) |
| Minuta (registro/validação) | `minutas` + `closing_events` (D15-A) |
| Finalização | `fechamentos` + `closing_events` |
| Reabertura (solicitação/autorização) | `reaberturas` + `closing_events` |
| Resolução de pendência | `demurrage_pendencias.resolvido_por`/`resolvido_motivo` (D15-B) |

A única tabela nova desta entrega (`demurrage_acoes_idempotencia`) não é uma tabela de auditoria de negócio — é só a chave de deduplicação da ÚNICA rota sem garantia natural (minuta). Ela é append-only (mesmo gatilho `forbid_mutation()` da migration 0041) e grava `organization_id`/`membership_id`/`rota`/`chave`/`resultado`, mas nunca substitui nem compete com o histórico do serviço.

Em todos os casos o autor persistido é sempre o `membershipId` resolvido pela sessão autenticada (`req.autorizacao!.membershipId`) — nunca um valor aceito do corpo da requisição (provado nos testes #12 e #28).

**Nenhum erro bruto escapa:** `classificarFalhaAcao()` (espelha `handoff/erros.ts` da Entrega 1) nunca lê `.message`/`.stack`/corpo/evidência/justificativa — só `instanceof` e SQLSTATE. A resposta 500 é sempre `{ resultado: 'FALHA', detalhe: { motivo: <código fechado> } }`; o log do servidor também só imprime o código fechado (prova no teste #29, com injeção real de um erro marcado).

---

## 7. Nenhuma lógica de negócio em HTTP (prova estática)

`acoesSemLogicaDeNegocio.test.ts` (mesmo mecanismo AST do `closingD15AV12.test.ts`, D15-A v1.3) prova, lendo o código-fonte com o compilador TypeScript (não em runtime):

1. `demurrageAcoesRoutes.ts` nunca contém uma chamada `.query(` — toda leitura/escrita passa por um helper (`acoes/organizacaoRecurso.ts`, `acoes/leituraIdempotente.ts`) ou por um serviço congelado;
2. `demurrageAcoesRoutes.ts` nunca chama diretamente nenhuma das funções de escrita/cálculo que os serviços congelados usam internamente (`promoverHouseFreeTimeComClient`, `promoverMasterFreeTimeComClient`, `applyObservation`, `recalcularApuracaoContainer`/`recalcularApuracaoProcesso`, `abrirPendenciaComClient`, `resolverPendenciasComClient`, `marcarValidada`, `marcarRejeitada`, `registrarFatoMaterialPosFinal`, `lockProcesso`, entre outras);
3. a mesma checagem se aplica a TODOS os arquivos de `acoes/*.ts` — nenhum adaptador desta entrega chama esses writers/calculadores diretamente.

As 3 passam.

---

## 8. Mandatory acceptance tests

`demurrageAcoesEntrega2.test.ts` — **26 testes físicos**, mapeando os 32 cenários do escopo aprovado (alguns itens foram combinados num único teste físico por compartilharem o mesmo setup; ver numeração abaixo), todos com PostgreSQL real:

| Teste(s) | Cenário |
|---|---|
| #1 | sem sessão → 401 |
| #2 | CLIENT → 403 |
| #3 | membership revogado (linha apagada) rejeitado em TODA requisição subsequente |
| #4 | recurso de outra organização → 404 idêntico a inexistente (fingerprint de resposta igual) |
| #5/#6/#7 | `organizationId` em corpo, query e cabeçalho — sempre 400, nunca ignorado silenciosamente |
| #8/#9 | fallback manual governado aplica House e Master Free Time pelo serviço congelado |
| #10 | fallback manual sem justificativa → 400 |
| #11 | fallback manual sem evidência → 400 |
| #12 | fallback manual grava o autor REAL da sessão (nunca o do corpo) + enfileira aviso aos gestores |
| #13 | decisão de responsabilidade aplica pelo serviço real (D11), versão 1 |
| #14 | cobertura de responsabilidade inválida (períodos ausentes) → 400 |
| #15 | restrição `NAO_APLICAVEL` (D11 v1.1) preservada através da rota |
| #16 | registro de minuta usa o caminho oficial + exige `Idempotency-Key` |
| #17/#18 | validação de minuta usa o `ClosingService`; divergência preserva as DUAS evidências (tracking e minuta); aceitação explícita grava `effective_return_date`; retry idempotente nunca duplica o evento |
| #19 | finalização sucede quando todos os gates são válidos; retry depois do sucesso é idempotente (`ja_final`, nenhum fechamento duplicado) |
| #20 | um gate de fechamento bloqueado ainda bloqueia pela rota — nenhum fechamento gravado |
| #21 | solicitação de reabertura sucede pela rota |
| #22/#27 | duas solicitações de reabertura CONCORRENTES para o mesmo processo nunca duplicam — exatamente uma reabertura, vencedor determinístico |
| #23 | autorização de reabertura exige MANAGER/ADMIN; ANALYST rejeitado (403); retry pós-sucesso idempotente (`ja_autorizada`) |
| #24 | resolução típada de pendência funciona para um tipo suportado |
| #25 | combinação família/ação/tipo fora do catálogo rejeitada (400), ZERO escrita nas 3 tentativas |
| #26 | duas requisições concorrentes com a MESMA `Idempotency-Key` de minuta nunca duplicam — mesma `minutaId`, exatamente uma linha |
| #28 | decisão de responsabilidade grava o autor REAL da sessão, mesmo que o corpo mande outro |
| #29 | erro inesperado (injetado na escrita real) devolve só a resposta genérica — nenhum marcador do erro escapa na resposta nem no log |
| #30 | o router não expõe nenhuma rota GET — toda ação é explicitamente um comando |
| #32 | nenhum arquivo de frontend (`public/`, `.html`, `.css`) está entre as mudanças desta entrega |

**Resultado final: 26/26 passando** (mais 3/3 na suíte estática do §7 — total de 29 testes novos desta entrega).

Item #31 (regressão do handoff da Entrega 1) é coberto pela validação sequencial completa abaixo, não como teste duplicado nesta suíte.

---

## 9. Validação sequencial completa

Executada nesta ordem, contra PostgreSQL real:

| Etapa | Resultado |
|---|---|
| `demurrageAcoesEntrega2.test.ts` (novo) | 26/26 |
| `acoesSemLogicaDeNegocio.test.ts` (novo, estático) | 3/3 |
| `npm run test:demurrage-engine` (suíte completa — 77 arquivos, inclui as suítes de handoff da Entrega 1, D10–D16 focados, e as duas novas acima) | **1065/1066** (1 falha conhecida e documentada — ver abaixo) |
| `npm test` (V1) | 25/25 |
| `npm run test:demurrage-ui` (D13, proteção de UI) | 64/64 (2 skip — gated por banco, esperado) |
| `npx tsc --noEmit` | limpo, zero erro |
| `npm run build` | sucesso |

A suíte completa do motor (`test:demurrage-engine`) inclui, sem exceção, as suítes de handoff da Entrega 1 (`handoffProducaoP1.test.ts`, `handoffProducaoP1V11.test.ts`, `handoffVinculoTransacaoV12.test.ts`, `handoffVinculoConcorrenciaV13.test.ts`) e as suítes focadas de D10–D16 (fechamento, responsabilidade, registro, D15-A/B/C, D16) — todas executadas como parte desta mesma passada.

### 9.1 Manutenção de rotina: listas de migrations em testes pré-existentes

Seis testes de infraestrutura (não exclusivos da Entrega 1) hardcodeiam a lista completa de migrations aplicadas, para provar instalação limpa/idempotência — o mesmo padrão de manutenção já seguido em toda entrega anterior que adicionou uma migration (ex.: a lista foi atualizada quando a 0017, a 0031, a 0040 etc. foram introduzidas). Adicionar `0042_acoes_idempotencia.sql` a essas listas é exatamente essa mesma manutenção de rotina, não uma mudança de comportamento:

- `migrate.test.ts`
- `migration0007.test.ts` (lista de tabelas com `organization_id_immutable` — `demurrage_acoes_idempotencia` adicionada ao catálogo, mesma convenção de toda tabela nova com `organization_id`)
- `registroDemurrageV12.test.ts` (dois pontos)
- `responsabilidadeAuditoria.test.ts`
- `responsabilidadeV12.test.ts`
- `responsavelOperacional.test.ts`
- `schedulerClaimFencing.test.ts`

Nenhum desses arquivos pertence à Entrega 1 (são das Fases 1, D10, D11 e D16) — nenhum teve sua AFIRMAÇÃO DE COMPORTAMENTO alterada, só a lista literal de nomes de arquivo de migration que o runner aplica em ordem.

### 9.2 Falha conhecida e intencionalmente NÃO corrigida (arquivo congelado da Entrega 1)

`handoffVinculoTransacaoV12.test.ts` teste **"v1.2 #14: migrações 0001→0041 permanecem intactas e válidas — nenhuma migration nova nesta corretiva"** falha, porque seu código testa literalmente `!r.applied.some(nome => nome.startsWith('0042'))` — uma afirmação ESCRITA para provar que a corretiva v1.2 da Entrega 1, especificamente, não introduziu nenhuma migration nova (o que era e continua sendo verdade: a v1.2 realmente não introduziu nenhuma). A asserção, porém, foi implementada de um jeito que também proíbe qualquer migration futura de qualquer entrega posterior — o que a Entrega 2 agora contradiz, por ter uma migration 0042 legítima e autorizada pelo usuário.

Esta é a ÚNICA falha de toda a suíte completa (1065/1066). Por instrução explícita do usuário ("Entrega 1 está congelada e não deve ser modificada"), este arquivo **não foi tocado** — nem a asserção, nem nenhuma outra linha. A falha é relatada aqui como conhecida, documentada e não corrigida, para decisão humana na auditoria desta entrega (possíveis caminhos: aceitar a falha como esperada e arquivada; ou pedir uma correção pontual futura dessa asserção específica, fora do escopo desta entrega).

---

## 10. Prova de nenhuma mudança de frontend

```
$ git status --porcelain
 M src/demurrage-engine/__tests__/migrate.test.ts
 M src/demurrage-engine/__tests__/migration0007.test.ts
 M src/demurrage-engine/__tests__/registroDemurrageV12.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeAuditoria.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeV12.test.ts
 M src/demurrage-engine/__tests__/responsavelOperacional.test.ts
 M src/demurrage-engine/__tests__/schedulerClaimFencing.test.ts
 M src/index.ts
?? docs/demurrage-producao-p1-entrega-2.md
?? src/demurrage-engine/__tests__/acoesSemLogicaDeNegocio.test.ts
?? src/demurrage-engine/__tests__/demurrageAcoesEntrega2.test.ts
?? src/demurrage-engine/acoes/
?? src/demurrage-engine/db/migrations/0042_acoes_idempotencia.sql
?? src/routes/demurrageAcoesRoutes.ts
```

Nenhum caminho sob `public/`, nenhum `.html`, nenhum `.css`. `src/index.ts` só ganhou duas linhas (import + `app.use`) para montar o novo router — nenhuma rota existente foi alterada. Os 7 arquivos `*.test.ts` modificados são só a manutenção de rotina descrita em §9.1 (acrescentar `0042_acoes_idempotencia.sql`/a nova tabela às listas hardcoded de migrations/tabelas-com-organization_id) — nenhuma asserção de comportamento foi enfraquecida ou removida. O teste #32 prova a ausência de mudança de frontend automaticamente a cada execução da suíte.

---

## 11. Migrations

Uma única migration aditiva: `0042_acoes_idempotencia.sql` — cria `demurrage_acoes_idempotencia` (chave de deduplicação da única rota sem garantia natural, ver §4), com os mesmos gatilhos `forbid_mutation()`/`forbid_organization_change()` já usados pela migration 0041. As migrations 0001–0041 não foram tocadas. Instalação limpa (0001→0042) e upgrade a partir de 0041 confirmados.

---

## 12. Escopo explicitamente fora desta entrega (adiado)

Conforme instrução do usuário, permanecem fora:
- atualização manual de tracking;
- administração de tarifa;
- administração de pendências de VesselCall;
- qualquer ação do frontend/Portal do Cliente;
- qualquer arquivo HTML/CSS/JavaScript de apresentação, Sidebar, Portal ou D13.

---

## 13. Status

**Entrega 2 implementada e validada.** Produção P1 **não** está completa — a Entrega 3 permanece não iniciada, por instrução explícita do usuário. Esta entrega aguarda auditoria antes de qualquer trabalho adicional.
