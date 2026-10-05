# Fase D15-A — Integridade de Estado Final e Reabertura

> **Status:** implementação sobre o diagnóstico aprovado (commit `f22d153`).
> **D15-A não é declarada aprovada nem congelada.** Entrega para auditoria.
> D15-B e D15-C **não foram iniciadas**; D16 **não foi iniciada**. Nenhuma
> mudança em frontend, Portal do Cliente, HeadCargo, Liberação, Auditoria,
> Courier, cadência/crédito de tracking, motores tarifários ou regras de
> negócio congeladas de D10–D14.

## 1. Escopo coberto

Casos aprovados do diagnóstico: **R11/31.7b**, **R16/31.12**, **R19/31.14**,
**R51**, **R52**, **R53**, **R54**.

1. Fato material recebido após FINAL (descarga, House FT, Master FT, tipo de
   equipamento, retorno de tracking): preserva a evidência bruta, registra
   evento auditável, nunca muta a projeção FINAL, idempotente.
2. Minuta divergente em processo FINAL (31.14): preserva as duas evidências
   (tracking e minuta) **antes** de devolver `exige_reabertura`.
3. `validarMinuta`, `finalizarProcesso`, `solicitarReabertura`,
   `autorizarReabertura`: cada uma é **uma transação só**, com lock
   consultivo por processo, gates relidos depois do lock, rollback total sob
   qualquer falha.
4. `finalizarProcesso`: lock, releitura de todos os gates, transição só a
   partir de OPEN, exatamente um fechamento, idempotente, imune a corrida.
5. Reabertura: membership real obrigatório; autorização só MANAGER/ADMIN;
   ator e justificativa obrigatórios; histórico preservado; no máximo uma
   reabertura aberta por processo; duas autorizações concorrentes produzem
   uma só efetiva.
6. RBAC: ator e papel **sempre** resolvidos de `organization_memberships`
   dentro da transação — nunca do `papel` informado pelo chamador (que
   deixou de existir como campo de entrada).

## 2. Arquivos alterados (exatos)

### Novos

| Arquivo | Conteúdo |
|---|---|
| `src/demurrage-engine/closing/materialChangeGuard.ts` | Guarda central reutilizável: `fatoMaterialBloqueadoPorFinal` (decide bloquear) + `registrarFatoMaterialPosFinal` (registra o evento, idempotente por conteúdo). |
| `src/demurrage-engine/db/migrations/0035_d15a_integridade_final_reabertura.sql` | Migration aditiva (detalhe §3). |
| `src/demurrage-engine/__tests__/closingD15A.test.ts` | 16 testes de aceitação obrigatórios da D15-A (detalhe §8). |
| `docs/demurrage-fase-d15-a.md` | Este documento. |

### Alterados — produção

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/closing/closingService.ts` | Reescrita completa dos quatro métodos (`validarMinuta`, `finalizarProcesso`, `solicitarReabertura`, `autorizarReabertura`): transação única por operação, lock consultivo `demurrage:closing:<processoId>`, RBAC por `membershipId` (nunca `papel`), minuta divergente em FINAL registra as duas evidências, ganchos `_teste*` só-teste para injeção de falha. `registrarMinuta` inalterada (upload não é RBAC-gated). |
| `src/demurrage-engine/apuracao/recalcularApuracao.ts` | Extraído `recalcularApuracaoContainerComClient`/`recalcularApuracaoProcessoComClient` (núcleo sem BEGIN/COMMIT próprios) para permitir que `closingService` compartilhe a MESMA transação do recálculo. `recalcularApuracaoContainer`/`recalcularApuracaoProcesso` continuam existindo com o comportamento idêntico de antes (wrappers finos). |
| `src/demurrage-engine/persistence/containerRepository.ts` | `applyObservation` e `applyObservationComClient` ganham a guarda de FINAL antes de qualquer `UPDATE containers`: valor diferente do selecionado + processo FINAL → bloqueia e registra; valor igual → nunca bloqueia (idempotente). Novo outcome `'bloqueada_final'`. |
| `src/demurrage-engine/freeTime/masterFreeTimeService.ts` | `promoverMasterFreeTimeComClient` ganha a mesma guarda antes do `UPDATE containers SET master_free_time_days`. Novo campo `bloqueadoPorFinal` no resultado. |
| `src/demurrage-engine/freeTime/houseFreeTimeService.ts` | Só o tipo de retorno (`outcome`) ampliado para incluir `'bloqueada_final'` — a guarda em si já vem de `applyObservationComClient` (reuso, nenhuma lógica duplicada). |
| `src/demurrage-engine/registro/registrarProcessoDemurrage.ts` | Guarda equivalente adicionada ao bloco de tipo de equipamento (normalizado e "zerar para NULL") — documentada como defensiva: este caminho específico já é inalcançável em FINAL pela rejeição de alto nível `PROCESSO_FINAL` (congelada de D10, com teste próprio); o caso exigido é exercido de fato pelo caminho genérico e compartilhado (`ContainerRepository.applyObservation`). |
| `src/demurrage-engine/tracking/eventIngestion.ts` | Só o tipo `PromocaoAplicada.outcome` ampliado para incluir `'bloqueada_final'` (nenhuma lógica alterada — a guarda já é herdada de `containerRepository.applyObservation`). |

### Alterados — testes (mecânico: `papel` → `membershipId` real)

`validarMinuta`/`finalizarProcesso`/`autorizarReabertura` deixaram de aceitar
`papel`; `solicitarReabertura` passou a exigir `membershipId`. Todo teste
pré-existente que chamava esses quatro métodos foi atualizado para criar um
membership real (`novoGestor`/`novoMembro`, ambos em
`responsabilidadeTestHelper.ts`) e passá-lo — nenhuma regra de negócio desses
testes foi alterada, só a forma de autenticar o ator:

`apuracao.test.ts`, `apuracaoV13.test.ts`, `apuracaoV14.test.ts`,
`closing.test.ts`, `demurrageVertical.test.ts`, `gestaoEficiencia.test.ts`,
`leituraTimeline.test.ts`, `responsabilidadeDecisao.test.ts`,
`responsabilidadeV11.test.ts`. Em `closing.test.ts`, o teste de RBAC foi
reescrito para provar explicitamente o requisito 6 (ator forjado, CLIENT,
membership de outra organização).

`responsabilidadeTestHelper.ts` ganhou `novoMembro(pool, orgId, papel)`
(genérico); `novoGestor` passou a ser um atalho para `novoMembro(..., 'MANAGER')`.

`migrate.test.ts`, `registroDemurrageV12.test.ts`,
`responsabilidadeAuditoria.test.ts`, `responsabilidadeV12.test.ts`,
`responsavelOperacional.test.ts`: listas de migrations esperadas (`r.applied`)
atualizadas para incluir `0035_d15a_integridade_final_reabertura.sql` — mesmo
padrão mecânico já usado quando migrations anteriores foram adicionadas (ex.:
`0017`).

**Nenhuma rota, nenhum arquivo de frontend, nenhum motor tarifário, nenhuma
regra de cadência/crédito de tracking foi tocado.**

## 3. Migration 0035 — detalhe e estratégia de compatibilidade

O diagnóstico (`f22d153`) continha uma contradição editorial: dizia que
D15-A não exigia migration e, na mesma seção, apontava a falta de unicidade
em `reaberturas` e de ator obrigatório. Inspecionado o schema real
(`0016_fase8_minuta_fechamento.sql`), confirmou-se que nenhuma das duas
garantias existia. A migration resolve a contradição a favor da evidência.

1. **`closing_events.tipo_evento`**: `DROP`/`ADD CONSTRAINT` (mesmo padrão
   já usado em `0032`) acrescentando `'FATO_MATERIAL_POS_FINAL'` à lista —
   aditivo, nenhum valor removido.
2. **`reaberturas_aberta_unica`**: índice único parcial em `processo_id`
   `WHERE estado IN ('SOLICITADA','AUTORIZADA','RECALCULADA')` — no máximo
   uma reabertura "aberta" por processo, garantido pelo PostgreSQL mesmo sob
   corrida (defesa em profundidade atrás do lock consultivo).
3. **Ator obrigatório para escrita NOVA**: dois `CHECK ... NOT VALID`:
   `solicitada_por IS NOT NULL` (sempre) e
   `estado = 'SOLICITADA' OR autorizada_por IS NOT NULL` (a partir do
   momento em que deixa de ser SOLICITADA).

**Estratégia de compatibilidade (requisito explícito — nunca fabricar
autor para dado legado):** os dois `CHECK` são `NOT VALID`. Em PostgreSQL,
isso significa que a constraint **vale para toda escrita nova** a partir da
migration, mas **não revalida linhas já existentes** na criação — uma
reabertura antiga sem autor (se existisse) permaneceria exatamente como
está, sem reescrita e sem autor inventado. Como esta base nunca esteve em
produção (D14 segue "NÃO aprovada e NÃO congelada") e todo teste constrói o
schema do zero, não há dado legado real sujeito a essa regra hoje — a
estratégia é, ainda assim, a correta para o caso em que houvesse. O índice
único segue a mesma lógica de honestidade: se um ambiente já tivesse
duplicatas, a criação do índice **falharia alto** (erro de migration), nunca
escolheria silenciosamente qual das duas manter.

Nenhuma migration existente foi reescrita. Nenhuma tabela de exceção
universal foi criada — tudo aditivo sobre os artefatos já existentes
(`closing_events`, `reaberturas`).

## 4. Desenho de transação e lock

Lock consultivo por **processo**, namespace próprio
(`pg_advisory_xact_lock(hashtextextended('demurrage:closing:<processoId>', 0))`),
distinto do namespace de contêiner (`decidirResponsabilidade.ts`, sem prefixo)
e do namespace de registro (`demurrage:processo:<org>:<numero>`,
`registrarProcessoDemurrage.ts`) — nenhuma colisão cruzada, cada domínio
serializa só consigo mesmo.

Padrão idêntico nos quatro métodos:

1. `BEGIN`.
2. Lê a linha-chave com `FOR UPDATE` (minuta/reabertura/processo, conforme o
   método) — primeiro contato com o banco, antes do lock, só para descobrir
   o `processoId` quando o input não o dá diretamente (minuta, reabertura).
3. Adquire o lock do processo.
4. **Relê** `apuracao_status` (e tudo que o gate precisa) **depois** do
   lock, com `FOR UPDATE` — nunca reaproveita uma leitura anterior ao lock.
5. Resolve o ator (`organization_memberships`, `FOR SHARE`) — ver §6.
6. Executa a lógica de negócio (preservada byte a byte onde não mudou).
7. `COMMIT`. Qualquer exceção em qualquer ponto → `ROLLBACK` (bloco
   `try/catch/finally` com `client.release()` no `finally`).

O recálculo (`recalcularApuracaoContainerComClient`/
`recalcularApuracaoProcessoComClient`, extraídos de
`apuracao/recalcularApuracao.ts`) roda **na mesma transação e no mesmo
`client`** — antes de D15-A, `validarMinuta`/`finalizarProcesso`/
`autorizarReabertura` abriam uma transação **separada** para o recálculo, o
que deixava uma janela real entre "minuta validada" e "relógios
recalculados". Essa janela foi eliminada: ambos os passos agora são
atômicos como uma unidade só.

## 5. Comportamento antes × depois de FINAL

| Fato | Antes de D15-A | Depois de D15-A |
|---|---|---|
| Descarga/FT/tipo/retorno corrigidos para processo FINAL | Promovido silenciosamente se a prioridade de fonte vencesse — a projeção FINAL mudava sem rastro, dessincronizada dos relógios/valores congelados | Evidência bruta preservada (sempre); promoção **bloqueada**; evento `FATO_MATERIAL_POS_FINAL` registrado com campo, valor anterior e valor novo; projeção nunca muda |
| Minuta divergente da data congelada em FINAL | `exige_reabertura` devolvido **sem** registrar nada — nenhuma evidência, nenhuma pista de por que a reabertura foi exigida | Evento `FATO_MATERIAL_POS_FINAL` registra a data congelada, a data da minuta E a evidência de tracking **antes** de devolver `exige_reabertura` |
| `validarMinuta`/`finalizarProcesso`/`autorizarReabertura` | Múltiplas transações separadas; crash no meio podia deixar `effective_return_date` setada com relógios desatualizados, ou `fechamentos` duplicado sob corrida | Uma transação só por operação; crash no meio desfaz tudo (testado com falha injetada) |
| RBAC | `papel` informado pelo chamador, nunca verificado contra membership real | Ator sempre resolvido de `organization_memberships`; `papel` não existe mais como campo de entrada |
| Reabertura | Sem checagem de FINAL, sem RBAC na solicitação, sem proteção contra duplicidade, sem exigência de ator | Só aceita em processo FINAL; exige membership real (qualquer papel interno) + justificativa; no máximo uma aberta por processo (app + índice único); autorização exige MANAGER/ADMIN; ator sempre gravado |

Fato material **idêntico** ao valor selecionado nunca é bloqueado nem gera
evento — é reconfirmação, não correção (evitando uma exigência de
reabertura falsa, requisito explícito).

## 6. Matriz de RBAC (D15-A)

| Operação | Papel exigido | Membership precisa pertencer a | Falha de autorização |
|---|---|---|---|
| `validarMinuta` | MANAGER ou ADMIN | organização do contêiner/processo | `apenas_manager_admin` |
| `finalizarProcesso` | MANAGER ou ADMIN | organização do processo | `apenas_manager_admin` |
| `solicitarReabertura` | Qualquer papel interno (ANALYST/MANAGER/ADMIN) — CLIENT recusado | organização do processo | `ator_nao_autorizado` |
| `autorizarReabertura` | MANAGER ou ADMIN | organização do processo | `apenas_manager_admin` |

Em todos os casos, um `membershipId` inexistente, de outro papel, ou **de
outra organização**, devolve exatamente o mesmo código de falha — nunca
revela se o problema era o papel ou a organização (requisito 10, "sem
vazar existência do recurso"). `papel`/`role`/`organizationId` informados
pelo chamador deixaram de ser campos aceitos pelas quatro operações; o ator
e o papel efetivos vêm sempre de `organization_memberships`, resolvido
dentro da própria transação (`FOR SHARE`), e é esse `usuario_id` resolvido
— nunca um valor informado — que fica gravado em `fechado_por`,
`realizado_por`, `solicitada_por`, `autorizada_por` e
`closing_events.ator_usuario_id`.

**Decisão de design não explicitamente fixada pelo diagnóstico, registrada
aqui:** `solicitarReabertura` aceita qualquer papel interno (não só
MANAGER/ADMIN), mantendo simetria com o resto do sistema, onde ANALYST pode
resolver pendências operacionais; só a **autorização** exige Gestor. Se essa
decisão não for a desejada, é uma alteração de uma linha (`ehPapelInterno` →
`ehGestor` em `solicitarReabertura`).

## 7. Evidência: observação bruta e valores anteriores sempre preservados

- `field_observations` é append-only (trigger de `0004`) — a guarda de D15-A
  nunca impede o `INSERT` da observação, só a posterior `UPDATE` em
  `containers`. Testado explicitamente (`closingD15A.test.ts`, casos #1):
  após uma tentativa bloqueada, a contagem de observações do campo sobe de
  1 para 2 (original preservada + nova tentativa preservada), nunca
  permanece em 1.
- `valores_apurados`/`relogios` continuam congelados em FINAL pelos guards
  de banco de `0017`/`0018` (inalterados) — D15-A não precisou tocar essas
  triggers porque, com a promoção do fato bloqueada na origem, não há mais
  nada para o pipeline de recálculo tentar escrever.
- `reaberturas.valores_anteriores` (snapshot JSONB, nunca sobrescrito desde
  D10) continua preservando o estado do processo/contêineres no momento da
  autorização — comportamento inalterado.
- Após reabertura + correção + recálculo + refechamento, o `fechamentos` e
  os `closing_events` anteriores permanecem na tabela (nunca apagados nem
  atualizados) — testado explicitamente (`closingD15A.test.ts`, caso
  #12/#13): 2 linhas em `fechamentos` para o mesmo processo depois do
  refechamento, a reabertura concluída consultável com estado `REFECHADA`.

## 8. Testes de aceitação obrigatórios — cobertura exata

`src/demurrage-engine/__tests__/closingD15A.test.ts` — **16 testes**, um por
requisito (alguns dos 5 campos do requisito 1 em testes separados):

| # | Teste | Requisito |
|---|---|---|
| 1 | Descarga corrigida após FINAL: preserva, bloqueia, registra, idempotente | #1, #2 |
| 2 | House Free Time corrigido após FINAL | #1 |
| 3 | Master Free Time corrigido após FINAL | #1 |
| 4 | Tipo de equipamento corrigido após FINAL | #1 |
| 5 | Retorno de tracking corrigido após FINAL | #1 |
| 6 | Valor idêntico nunca bloqueia nem gera evento | #1 (idempotência, caso negativo) |
| 7 | Minuta divergente em FINAL registra as duas evidências antes de `exige_reabertura`, idempotente | #3 |
| 8 | Dois `finalizarProcesso` concorrentes → exatamente um fechamento | #5 |
| 9 | Duas `solicitarReabertura` concorrentes → nunca duplicam a reabertura aberta | #6 |
| 10 | Duas `autorizarReabertura` concorrentes → exatamente uma efetiva | #6 |
| 11 | Falha entre validação da minuta e recálculo → rollback total | #7 |
| 12 | Falha durante finalização → rollback total (processo permanece OPEN) | #8 |
| 13 | Falha durante autorização de reabertura → rollback total | #8 |
| 14 | ANALYST (papel forjado), CLIENT e membership de outra organização nunca finalizam/autorizam | #9, #10 |
| 15 | Ator real gravado em todos os campos (nunca o papel informado) | #11 |
| 16 | Ciclo completo: reabre → corrige → recalcula → refecha; histórico permanece consultável | #12, #13 |

Os testes 8, 9 e 10 usam **concorrência real** (`Promise.all` com duas
chamadas ao serviço, cada uma com sua própria conexão do pool do
PostgreSQL) — não simulam a corrida, deixam o PostgreSQL arbitrar o lock
consultivo de verdade. Os testes 11, 12 e 13 usam os ganchos `_teste*`
(só-teste, nunca expostos por nenhuma rota ou integração, mesmo padrão já
usado em `registrarProcessoDemurrage.ts`/`decidirResponsabilidade.ts`) para
injetar uma exceção no meio exato da transação e provar o rollback total via
leitura do banco depois.

Os requisitos #4 (minuta em processo OPEN, atômico) e #12/#13 (reabertura
aplicando correção e refechando) já tinham cobertura substancial nos testes
congelados de D8/D10 (`closing.test.ts` casos 1-10, `apuracao.test.ts` teste
de reabertura) — preservados sem alteração de asserção, só a forma de
autenticar o ator (`membershipId` em vez de `papel`).

## 9. Regressão completa (PostgreSQL 16 local, `--test-concurrency=1`, sequencial)

| Suíte | Resultado |
|---|---|
| D15-A dedicada (`closingD15A.test.ts`) | **16/16** |
| Engine completa (`npm run test:demurrage-engine`, inclui D10/D11/D12/D14, closing/minuta/reabertura, D15-A) | **828/828** |
| V1 (`npm test`) | **25/25** |
| UI D13 (`npm run test:demurrage-ui`) | **66/66** |
| `npx tsc --noEmit` | limpo |
| `npm run build` | limpo |

Nenhum teste pulado, nenhum teste modificado para passar artificialmente —
os 5 testes que quebraram na primeira rodada (listas de migrations
hardcoded terminando em `0034`) foram corrigidos acrescentando
`0035_d15a_integridade_final_reabertura.sql`, mesmo padrão mecânico já usado
quando `0017` foi adicionada em fase anterior.

## 10. Limitações declaradas e decisões tomadas sem bloquear a entrega

- **`solicitarReabertura` aceita qualquer papel interno** (não só
  MANAGER/ADMIN) — decisão registrada em §6, não fixada explicitamente pelo
  diagnóstico; reversível em uma linha se o usuário preferir restringir a
  MANAGER/ADMIN também na solicitação.
- **Correção de tipo de equipamento via o contrato de registro
  (`registrarProcessoDemurrage`)** permanece bloqueada pela rejeição de alto
  nível `PROCESSO_FINAL` já existente (congelada de D10, com teste de
  regressão próprio) — **não** pela nova guarda granular. A guarda granular
  foi adicionada ali por consistência e defesa em profundidade, mas é hoje
  inalcançável por esse caminho específico (documentado no próprio código,
  §2). O caso exigido "correção de tipo de equipamento após FINAL" está
  coberto de fato pelo caminho genérico e compartilhado
  (`ContainerRepository.applyObservation`), usado por outros chamadores
  (ex.: backfill) e testado diretamente.
- **`backfill/runBackfill.ts`** não foi alterado: ao processar um fato
  bloqueado por FINAL, classifica o resultado como `'ignorado'` (mesmo
  tratamento de "não promovido" que já existia) em vez de um rótulo
  específico "bloqueado por FINAL" — não é um defeito (nenhuma mutação
  incorreta ocorre), só uma granularidade de relatório que D15-A não exigia
  e não alterou.
- **D15-B e D15-C não foram tocadas**: validação de cronologia (Gate Out
  antes da descarga, Empty Return antes do Gate Out), recência de
  observação por `observado_em`, conflito de mesma fonte persistido,
  `mismatchCarrier`, pendência de condição comercial ausente, resolução de
  `atracacao_ambigua`/`tipo_selecao_sem_observacao`, imutabilidade/
  versionamento de tabela tarifária, overlap de faixas, moeda mista,
  outboxes presos, claim de alertas — todos permanecem exatamente como o
  diagnóstico os descreveu, aguardando aprovação de D15-B/D15-C.
- **Nenhuma rota pública foi criada.** `validarMinuta`, `finalizarProcesso`,
  `solicitarReabertura` e `autorizarReabertura` continuam só código de
  serviço, sem tela — consistente com a decisão fixada no diagnóstico
  ("D15 permanece em nível de serviço").

## 11. Status final

- **D15-A não é declarada aprovada nem congelada.**
- **D15-B e D15-C não foram iniciadas.**
- **D16 não foi iniciada.**
- Entrega pronta para auditoria.
