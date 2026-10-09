# Fase D15-B — Integridade de Dados e Exceções

Baseline congelada: D15-A aprovado e congelado em — código de produção
`91b3201`; correção documental `43123fe`. Nenhum comportamento congelado de
D15-A foi reaberto ou alterado nesta fase; nenhuma regressão o exigiu.

Escopo: os 18 casos aprovados em `docs/demurrage-fase-d15-diagnostico.md`
(§6) — **R05, R07, R08, R09, R18, R26, R36, R37, R38, R39, R40, R41, R44,
R45, R50, R55, R56, R61**. Esta entrega **não** é declarada aprovada nem
congelada — fica para auditoria. D15-C e D16 não foram iniciados.

## 1. Mapeamento dos 18 casos — código, mecanismo e teste

| Caso | O que muda | Mecanismo reaproveitado | Arquivo principal | Teste de aceitação |
|---|---|---|---|---|
| **R05** | Histórico append-only de tentativas de Free Time (fonte, resultado, evidência sanitizada), ligado à pendência quando existe | Nova tabela satélite `free_time_tentativas` + `demurrage_pendencias.free_time_ausente` | `freeTime/freeTimeTentativas.ts` (novo); chamado de `persistence/containerRepository.ts` (House), `freeTime/masterFreeTimeService.ts` (Master) e `shippingInstructions/ingestaoShippingInstructions.ts` (negativo da SI) | `d15b.test.ts` "R05" |
| **R07** | Fonte mais forte sobre `manual_fallback` vigente não substitui — abre divergência nomeada e notifica a gestão; valor manual preservado | `demurrage_pendencias.fallback_manual_superado` + `demurrage_pendencia_avisos` (outbox de claim) | `persistence/containerRepository.ts` (House), `freeTime/masterFreeTimeService.ts` (Master) | `d15b.test.ts` "R07" |
| **R08** | Empty Return antes da descarga: pendência nomeada, bloqueio explícito do fechamento, notificação ativa; reconciliação automática na próxima observação já autorizada (sem fetch/claim/crédito extra) | `demurrage_pendencias.retorno_vazio_antes_descarga` + gate explícito em `closingService.finalizarProcesso` + `demurrage_pendencia_avisos` | `registro/cronologia.ts` (novo), `persistence/containerRepository.ts`, `closing/closingService.ts` | `d15b.test.ts` "R08" (2 testes — bloqueio e reconciliação) |
| **R09** | Empty Return tardio mas cronologicamente consistente é evento tardio VÁLIDO (não violação) — promove pela data do evento, recalcula, preserva histórico; sob FINAL segue o contrato D15-A | Nenhum código novo — é a interação correta entre o guard de cronologia (direção única) e o guard de FINAL (D15-A, inalterado) | `registro/cronologia.ts` (guard unidirecional, documentado) | `d15b.test.ts` "R09" (2 testes — OPEN e FINAL) |
| **R18** | `podeAtualizarManual` (órfã, nunca chamada) exposta como serviço chamável com RBAC por membership real, sem rota pública | `solicitarAtualizacaoManual` reescrito para resolver `organizationId`+`membershipId` em vez de aceitar `papel` do chamador | `scheduler/trackingScheduler.ts` | `d15b.test.ts` "R18"; `scheduler.test.ts`, `vesselSharing.test.ts` (chamadas existentes corrigidas) |
| **R26** | Condição comercial ausente com relógio do cliente em demurrage: pendência nomeada de processo; resolvida quando a condição é cadastrada | `demurrage_pendencias.condicao_comercial_ausente` (nível de processo, `container_id` nulo) | `apuracao/recalcularApuracao.ts` | `d15b.test.ts` "R26" |
| **R36** | Conflito House-only (duas fontes reais, sem Master) agora abre divergência — mesmo mecanismo do conflito Master×SI | `ft_divergencias` generalizado por campo/par de fontes (`avaliarDivergenciaCampoComClient`) | `freeTime/masterFreeTimeService.ts`, chamado de `persistence/containerRepository.ts` | `d15b.test.ts` "R36" |
| **R37** | Conflito de mesma fonte/mesmo instante/valor diferente — persistido e nomeado, nunca só no retorno da chamada | `demurrage_pendencias.conflito_mesma_fonte` | `persistence/containerRepository.ts`, `freeTime/masterFreeTimeService.ts` | `d15b.test.ts` "R37" |
| **R38** | `mismatchCarrier` (referência que aparenta outro armador) computado e descartado — agora persistido como pendência nomeada, sem trocar o armador automaticamente | `vessel_call_pendencias.mismatch_carrier` | `persistence/vesselCallRepository.ts` (tipo), `registro/registrarProcessoDemurrage.ts` (wiring no vínculo do MBL) | `d15b.test.ts` "R38" |
| **R39** | Gate Out antes da descarga — pendência nomeada, bloqueia só a promoção do fato afetado, sem notificação ativa | `demurrage_pendencias.cronologia_gate_out_antes_descarga` | `registro/cronologia.ts`, `persistence/containerRepository.ts` | `d15b.test.ts` "R39/R40" |
| **R40** | Empty Return antes do Gate Out (violação real, distinta de R09) — mesmo tratamento de R39 | `demurrage_pendencias.cronologia_retorno_antes_gate_out` | `registro/cronologia.ts`, `persistence/containerRepository.ts` | `d15b.test.ts` "R39/R40" |
| **R41** | Dentro da mesma prioridade de fonte, a observação mais antiga chegando depois nunca substitui a mais nova já selecionada | Comparação de `observado_em` adicionada ao passo de decisão de prioridade (sem migration — a coluna já existe) | `persistence/containerRepository.ts`, `freeTime/masterFreeTimeService.ts` | `d15b.test.ts` "R41" |
| **R44** | Rollback de VesselCall por evento tardio/cache: evidência mais antiga que a associação ativa é recusada, nunca rola para trás | `container_vessel_calls.observado_em` (nova coluna) + recusa auditável em `associarContainer` | `persistence/vesselCallRepository.ts`, `tracking/vesselCallSync.ts` | `d15b.test.ts` "R44" |
| **R45** | `atracacao_ambigua` (órfã permanente — nenhuma fonte adicional desambigua) agora tem resolução MANUAL auditável, com RBAC e motivo obrigatório | `vessel_call_pendencias.resolvido_por`/`resolvido_motivo` + `resolverPendenciaManual` | `persistence/vesselCallRepository.ts` | `d15b.test.ts` "R45" |
| **R50** | `applyObservation` (variante autônoma, sem client) confirmado transacional e com o mesmo lock consultivo da variante `ComClient` | Nenhum código novo — já corrigido pelo próprio D15-A v1.1 (achado #1); este caso só precisava da prova dedicada | `persistence/containerRepository.ts` (inalterado nesta fase) | `d15b.test.ts` "R50" |
| **R55** | `reconhecerDivergencia`/`resolverDivergencia` aceitavam `usuario` livre do chamador e `motivo` opcional mesmo ao resolver | RBAC por membership real (mesma régua de `resolverPendenciaManualComClient`) + `motivo` obrigatório na resolução | `freeTime/divergenciaAvisos.ts` | 3 testes existentes corrigidos em `shippingInstructions.test.ts` (sem duplicar em `d15b.test.ts`) |
| **R56** | `tipo_selecao_sem_observacao` (backfill legado, órfã permanente) agora tem resolução manual auditável | `resolverPendenciaManualComClient`/`resolverPendenciaManual` (mecanismo já genérico sobre `demurrage_pendencias`) | `registro/pendencias.ts` | `d15b.test.ts` "R56" |
| **R61** | Vocabulário de status inconsistente entre artefatos de pendência — mapeamento de leitura, sem tabela universal | Documental apenas (ver §7 abaixo) | — | — |

## 2. Migrations e arquivos alterados

### Migration (uma, aditiva)

`src/demurrage-engine/db/migrations/0036_d15b_integridade_dados_excecoes.sql`:

1. `demurrage_pendencias`: 7 novos tipos (`retorno_vazio_antes_descarga`,
   `cronologia_gate_out_antes_descarga`, `cronologia_retorno_antes_gate_out`,
   `condicao_comercial_ausente`, `conflito_mesma_fonte`,
   `fallback_manual_superado`, `free_time_ausente`) + `resolvido_por`/
   `resolvido_motivo` (resolução manual auditável, mesmo padrão de
   `ft_divergencias`).
2. `vessel_call_pendencias`: tipo `mismatch_carrier` + `resolvido_por`/
   `resolvido_motivo`.
3. `ft_divergencias.campo`: generalizado para aceitar `houseFreeTimeDays`
   (conflito House-only), sem tocar o par Master×SI existente.
4. `free_time_tentativas` (nova tabela, append-only): histórico de
   tentativas de Free Time, ligado à pendência quando existe.
5. `demurrage_pendencia_avisos` (nova tabela): outbox de aviso aos gestores
   para pendências que exigem notificação ativa (R07, R08) — mesmo padrão
   de claim/posse de `demurrage_fallback_manual_avisos`/
   `ft_divergencia_entregas`.
6. `container_vessel_calls.observado_em` (nova coluna, nula para linhas
   legadas): data do evento que motivou a associação/rolagem (R44).
7. `container_vessel_call_eventos.tipo`: novo valor
   `rolagem_recusada_recencia`, auditável.

Nenhuma migration consolida os artefatos existentes em uma tabela de
exceção universal — cada caso estende um artefato já existente (`demurrage_
pendencias`, `vessel_call_pendencias`, `ft_divergencias`,
`container_vessel_calls`) com colunas/constraints pontuais, preservando a
granularidade já decidida em `docs/demurrage-fase-d15-diagnostico.md` §8.

### Arquivos novos (produção)

- `src/demurrage-engine/registro/pendencias.ts` — mecanismo compartilhado de
  `demurrage_pendencias` (abrir/resolver automático/resolver manual
  auditável), extraído de `registrarProcessoDemurrage.ts` sem mudança de
  comportamento, reaproveitado por todos os outros arquivos desta fase.
- `src/demurrage-engine/registro/cronologia.ts` — violação de cronologia
  (função pura) + abertura/resolução das pendências de Gate Out/Empty
  Return.
- `src/demurrage-engine/registro/notificacaoPendencia.ts` — outbox de aviso
  aos gestores (claim/posse) para pendências de notificação ativa.
- `src/demurrage-engine/freeTime/freeTimeTentativas.ts` — histórico de
  tentativas de Free Time (R05).
- `src/demurrage-engine/__tests__/d15b.test.ts` — 18 testes de aceitação.

### Arquivos alterados (produção)

- `persistence/containerRepository.ts` — `applyObservationComClient`:
  `ApplyObservationOutcome` ganha `bloqueada_cronologia`/
  `bloqueada_fallback_manual`; recência dentro da mesma prioridade (R41);
  blocos de conflito de mesma fonte (R37), tentativa de House (R05),
  cronologia (R08/R39/R40) e fallback manual superado (R07) inseridos
  dentro do protocolo universal de lock já existente, sem alterar sua
  ordem.
- `freeTime/masterFreeTimeService.ts` — mesmos R07/R37/R41/R05 espelhados
  para Master Free Time; `avaliarDivergenciaComClient` generalizado em
  `avaliarDivergenciaCampoComClient` (campo/par de fontes parametrizados),
  com o caso Master×SI preservado como wrapper fino; novo
  `avaliarDivergenciaHouseComClient` (R36).
- `freeTime/houseFreeTimeService.ts` — tipo de retorno `outcome` widened
  (reflete os novos desfechos).
- `tracking/eventIngestion.ts` — mesmo widening de tipo.
- `apuracao/recalcularApuracao.ts` — R26 (pendência de condição comercial
  ausente).
- `closing/closingService.ts` — R08: bloqueio explícito e nomeado no gate de
  `finalizarProcesso`, distinto do bloqueio indireto via `INDETERMINADA`.
- `persistence/vesselCallRepository.ts` — `TipoPendencia` + `mismatch_
  carrier`; `associarContainer` com recência (R44); `resolverPendenciaManual`
  (R45).
- `tracking/vesselCallSync.ts` — passa `observadoEm` (data do evento) para
  `associarContainer`; novo contador `rolagensRecusadasPorRecencia`.
- `scheduler/trackingScheduler.ts` — `solicitarAtualizacaoManual` com RBAC
  por membership real (R18).
- `freeTime/divergenciaAvisos.ts` — RBAC por membership + motivo obrigatório
  na resolução (R55).
- `shippingInstructions/ingestaoShippingInstructions.ts` — R05: tentativa
  "não encontrado" por contêiner já conhecido, quando a SI não traz Master
  Free Time.
- `registro/registrarProcessoDemurrage.ts` — R38: persiste `mismatchCarrier`
  no vínculo do MBL.
- Testes existentes corrigidos para as novas assinaturas/comportamento:
  `__tests__/shippingInstructions.test.ts` (R55 + migração-boundary +
  House-only agora É divergência), `__tests__/scheduler.test.ts`,
  `__tests__/vesselSharing.test.ts` (R18), `__tests__/fieldObservation.test.ts`
  (R07 — comportamento corrigido).
- Testes de migration-boundary com manutenção de rotina (nova migration
  0036 e tabelas novas; nenhuma mudança de comportamento testado — ver §9):
  `__tests__/migration0007.test.ts`, `__tests__/migrate.test.ts`,
  `__tests__/registroDemurrageV12.test.ts`,
  `__tests__/responsavelOperacional.test.ts`,
  `__tests__/responsabilidadeAuditoria.test.ts`,
  `__tests__/responsabilidadeV11.test.ts`,
  `__tests__/responsabilidadeV12.test.ts`.

## 3. Comportamento de transação e lock

Nenhuma alteração na ordem do protocolo universal de lock estabelecido pelo
D15-A (identidade sem lock → `lockProcesso` → relê/trava PROCESSO → relê/
trava CONTÊINER → persiste observação bruta → decide → promove ou
bloqueia+registra). Todo bloco novo (R05, R07, R08/R39/R40, R37, R36) foi
inserido **dentro** dessa sequência já auditada, nos pontos indicados nos
comentários do próprio código — nunca antes do lock consultivo, nunca
mudando a ordem processo→contêiner.

`R50` confirma que a variante autônoma (`applyObservation`, sem `client`)
já herda transação (`BEGIN`/`COMMIT`/`ROLLBACK`) e o mesmo lock consultivo
via `applyObservationComClient` — corrigido pelo próprio D15-A v1.1 (achado
#1); este trabalho apenas acrescenta a prova dedicada (`d15b.test.ts` "R50":
duas observações concorrentes idênticas resultam em exatamente uma criação
no ledger; falha injetada no meio da operação desfaz tudo).

`R44` (recência de VesselCall) e `R41` (recência de fonte) são comparações
de dados lidas dentro do MESMO lock já adquirido — nenhuma consulta extra,
nenhum lock adicional.

## 4. Ciclo de vida de pendências e notificação

Todas as pendências novas seguem o padrão já estabelecido de
`demurrage_pendencias`/`vessel_call_pendencias`: idempotentes por índice
parcial (uma ABERTA por identidade), nunca apagadas, resolução preserva a
linha (`estado='resolvida'`, timestamp). Duas formas de resolução,
distintas e nunca confundidas:

- **Automática** — a condição que abriu a pendência deixou de existir
  (reavaliada no mesmo ponto de decisão que a abriu: `conflito_mesma_fonte`
  nunca se resolve assim — exige revisão humana; cronologia e fallback
  manual superado resolvem quando o próximo fato correto chega; condição
  comercial ausente resolve quando a condição é cadastrada).
- **Manual auditável** (R45, R56, e o `resolverPendenciaManualComClient`
  genérico) — exige `autorMembershipId` resolvido contra
  `organization_memberships` (nunca papel informado pelo chamador) e
  `motivo` não vazio; grava `resolvido_por`/`resolvido_motivo`; idempotente
  (resolver de novo é no-op silencioso, a primeira resolução fica
  registrada).

Notificação ATIVA (outbox `demurrage_pendencia_avisos`, mesmo padrão de
claim/posse de `demurrage_fallback_manual_avisos`) só para os dois casos que
o Blueprint exige explicitamente: R07 (fallback manual superado) e R08
(retorno vazio antes da descarga). R39/R40 (cronologia de Gate Out/Empty
Return antes do Gate Out) ficam visíveis via leitura de pendências, sem
notificação ativa — escopo deliberadamente mais estreito, confirmado nos
testes ("R39 não notifica ativamente").

## 5. Prova de reconciliação de tracking (R08) — sem fetch, claim ou crédito extra

O teste `d15b.test.ts` "R08: reconciliação automática" prova exatamente o
enunciado do usuário: conta `tracking_fetches` e `recalculo_outbox` antes e
depois da observação corrigida chegar — `tracking_fetches` fica EXATAMENTE
igual (nenhum fetch novo), e a pendência de cronologia é resolvida pelo
MESMO caminho de decisão que a abriu (`applyObservationComClient`), sem
nenhum scheduler, claim ou gatilho de cadência novo. Isso satisfaz o
requisito do usuário ("agendar reconciliação automática só na próxima
janela de rastreamento já autorizada pela cadência congelada; nenhum fetch
extra, nenhum bypass de claim/cadência, nenhum crédito adicional
consumido") sem nenhum código de orquestração novo — a reavaliação já
acontece naturalmente sempre que o MESMO campo é reobservado em qualquer
ingestão futura normalmente autorizada.

## 6. Totais de teste — regressão completa

Ambiente: `DEMURRAGE_TEST_DATABASE_URL`, `DEMURRAGE_DATABASE_URL` e
`DATABASE_URL` apontando para o MESMO banco limpo, reconstruído pelas
migrations 0001-0036, conforme exigido.

Execução sequencial completa, exatamente na ordem exigida:

| Etapa | Resultado |
|---|---|
| D15-A v1.0–v1.3 (`closingD15A.test.ts`, `closingD15AV11/V12/V13.test.ts`, demais testes de regressão de D15-A) | Incluída na suíte completa abaixo — **0 falhas** |
| D15-B — 18 casos novos (`__tests__/d15b.test.ts`) | **18/18** testes — 1 por caso (R08 e R09 cobrem 2 cenários cada dentro do mesmo `test()`, via `t.test` interno) |
| Suíte completa do Demurrage Engine (`npm run test:demurrage-engine`, 65 arquivos `*.test.ts`, inclui D15-A + D15-B + toda a regressão pré-existente) | **875/875 pass, 0 fail, 0 cancelled, 0 skipped** |
| V1 (`npm test` — `src/auditoria/preAlerta/*.test.ts`) | **25/25 pass, 0 fail** |
| D13 UI (`npm run test:demurrage-ui` — `src/frontend-tests/*.test.ts`) | **66/66 pass, 0 fail** |
| `tsc --noEmit` | Limpo, 0 erros |
| Build de produção (`npm run build` → `tsc`) | Limpo, 0 erros |

Banco de teste real (PostgreSQL local), reconstruído do zero
(`DROP SCHEMA public CASCADE`) e recriado pelas migrations 0001–0036 em
cada arquivo de teste que o exige — nenhum teste usa mock de banco.

Comparado à última execução completa anterior a estes ajustes (875 testes,
863 pass, 12 fail), as 12 falhas eram todas esperadas e já diagnosticadas
antes desta rodada final — nenhuma delas indicava regressão de
comportamento:

- 1 falha em `fieldObservation.test.ts`: o próprio cenário do Blueprint que
  R07 corrige (fonte mais forte sobrescrevendo `manual_fallback` em
  silêncio) — asserção do teste atualizada para o comportamento correto.
- 11 falhas em 7 arquivos de teste de migration-boundary pré-existentes
  (`migration0007.test.ts`, `migrate.test.ts`, `registroDemurrageV12.test.ts`,
  `responsavelOperacional.test.ts`, `responsabilidadeAuditoria.test.ts`,
  `responsabilidadeV11.test.ts`, `responsabilidadeV12.test.ts`) — manutenção
  de rotina por causa da nova migration/tabelas (ver §9 para o detalhe de
  cada caso). Nenhum código de produção foi alterado para resolvê-las.

Nenhuma falha remanescente nesta execução final.

## 7. R61 — vocabulário de status entre artefatos de pendência (documental)

Conforme §6/item 14 do diagnóstico ("sem criar tabela universal... apenas
documentação/mapeamento de leitura"), o mapeamento de vocabulário entre os
artefatos de pendência existentes:

| Artefato | Estados | Observação |
|---|---|---|
| `demurrage_pendencias` | `aberta`, `resolvida` | Resolução automática OU manual (R45/R56 generalizam a manual) |
| `vessel_call_pendencias` | `aberta`, `resolvida` | Mesmo vocabulário; agora com `resolvido_por`/`resolvido_motivo` (R45) |
| `si_pendencias` | `aberta`, `resolvida` | Mesmo vocabulário; resolução automática por reaplicação ou manual via reprocesso |
| `ft_divergencias` | `aberta`, `reconhecida`, `resolvida`, `reaberta` | Vocabulário mais rico (reconhecimento intermediário, reabertura com nova ocorrência) — nunca confundido com os dois estados simples acima |
| `tracking_alert_deliveries`/`*_avisos`/`*_entregas` (outbox) | `PENDING`, `PROCESSING`, `SENT`/`DONE`, `FAILED` | Vocabulário de ENTREGA (claim/posse), ortogonal ao vocabulário de PENDÊNCIA — nunca o mesmo campo |

Não há inconsistência real de SIGNIFICADO (todo "aberta"/"resolvida" denota
o mesmo conceito em todos os artefatos de pendência); a inconsistência
identificada em D14 (G-A8 vs. fila) era de LEITURA — já responsabilidade do
read model (D12/D14), fora do escopo de escrita de D15-B. Nenhuma mudança
de código decorre deste item.

## 8. O que esta entrega NÃO faz

- Não declara D15-B aprovado nem congelado.
- Não inicia D15-C nem D16.
- Não reabre nenhum comportamento congelado de D15-A sem regressão
  demonstrada (nenhuma ocorreu).
- Não adiciona rota pública nem trabalho de frontend (R18 permanece serviço
  interno, sem caminho de chamada por rota).
- Não implementa a direção INVERSA de cronologia (uma `dischargeDate`
  retroativa invalidando um Gate Out/Empty Return já selecionado) —
  deliberado, documentado em `registro/cronologia.ts`: o Blueprint (31.2,
  31.6/31.7) não exige essa direção, e reabriria superfície de promoção de
  descarga extensivamente testada e congelada por D15-A sem mandato
  explícito. A reconciliação natural ocorre no próximo Gate Out/Empty
  Return reingerido.
- Não altera cadência, claims, consumo de crédito, relógios, tarifas,
  apuração financeira, responsabilidade ou qualquer regra congelada de
  D10-D14.

## 9. Achados e limitações

- **R50 já estava satisfeito** antes desta fase — o achado #1 de D15-A v1.1
  (lock order) já havia corrigido `applyObservation` para abrir sua própria
  transação e delegar a `applyObservationComClient` (que estabelece o lock
  consultivo). O diagnóstico D15-B catalogava o caso antes dessa correção
  ter sido confirmada neste nível de detalhe; este trabalho confirma e
  adiciona a prova dedicada, sem mudança de código.
- **Bug encontrado e corrigido durante a implementação**: a generalização
  de `avaliarDivergenciaComClient` (R36) expôs que o INSERT em
  `ft_divergencias` nunca incluía a coluna `campo` explicitamente — o valor
  sempre veio do `DEFAULT 'masterFreeTimeDays'` da coluna, mascarado porque,
  antes desta fase, a função só era chamada para o Master. Ao generalizar
  para `houseFreeTimeDays`, o teste de aceitação pegou o defeito
  imediatamente (divergência House-only sendo gravada com
  `campo='masterFreeTimeDays'`). Corrigido no mesmo commit — o INSERT agora
  sempre especifica `campo` explicitamente.
- **Teste pré-existente atualizado para refletir o comportamento correto**:
  `shippingInstructions.test.ts` tinha um teste intitulado "House e Master
  diferentes não são divergência" cuja asserção final (`ft_divergencias`
  count = 0) cobria exatamente o cenário House-only que R36 corrige —
  house_document(10) × shipping_instructions(14) no mesmo contêiner. Esse
  era o próprio gap documentado no diagnóstico (R36), não um comportamento
  correto a preservar. A asserção foi atualizada para refletir o
  comportamento corrigido (1 divergência House-only, aberta), mantendo
  intacta a asserção original sobre House×Master (que continua não sendo
  divergência).
- **Teste de migration-boundary ajustado**: o teste "banco que já executou
  a 0024 ORIGINAL recebe só a 0025" simulava um schema travado em migrations
  antigas e usava `promoverMasterFreeTime` (código de APLICAÇÃO atual) para
  popular dados — mas essa função agora depende de `demurrage_pendencias`
  (migration 0028, R05). Ajustado para popular os mesmos dados via INSERT
  direto, preservando o objetivo original do teste (provar que a migration
  0025 preserva dados escritos sob o schema anterior) sem depender de
  código de aplicação mais novo que o próprio degrau de migration sob teste.
- **Sete testes de migration-boundary pré-existentes precisaram de
  manutenção de rotina** (nenhum achado de comportamento — só dependência de
  schema): `migration0007.test.ts`, `migrate.test.ts`,
  `registroDemurrageV12.test.ts`, `responsavelOperacional.test.ts` tinham
  listas fixas ("golden list") de migrations/tabelas que precisavam incluir
  a nova `0036_d15b_integridade_dados_excecoes.sql` e as duas tabelas novas.
  Três testes (`responsabilidadeAuditoria.test.ts`,
  `responsabilidadeV11.test.ts`, `responsabilidadeV12.test.ts`) congelam o
  schema num degrau anterior a 0036 (0032/0033) e só então chamam
  `cenario()`/`novoContainer()` — que, depois desta fase, dependem
  incondicionalmente de `free_time_tentativas` (R05) em TODOS os cenários;
  corrigido nos três com um scaffold local da tabela (DDL idêntico ao da
  própria 0036), inserido logo após o `runMigrations` travado no degrau
  antigo. Em dois deles (`responsabilidadeAuditoria.test.ts`,
  `responsabilidadeV12.test.ts`) algum cenário também deixa o relógio do
  cliente em demurrage sem condição comercial, batendo no novo valor
  `condicao_comercial_ausente` do CHECK constraint de
  `demurrage_pendencias.tipo` (R26) — corrigido com o mesmo tipo de
  scaffold local (`ALTER TABLE ... DROP/ADD CONSTRAINT`, DDL idêntico ao da
  0036). Nenhum dos dois scaffolds altera código de produção nem o
  comportamento coberto pelo teste. Onde o teste prossegue depois para a
  migration 0036 de fato, o scaffold da TABELA é desfeito
  (`DROP TABLE free_time_tentativas`) antes de retomar `runMigrations` sem
  `until` — o scaffold do CONSTRAINT não precisa de desfazer, pois o `DROP
  CONSTRAINT` da própria 0036 sucede independente da expressão atual.
