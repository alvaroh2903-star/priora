# Fase D15-B v1.1 (corretiva) — Consumidor Real do Outbox de Avisos de Pendência

> **Status:** correção de dois achados bloqueantes de auditoria sobre a
> implementação D15-B (commit `76c7031`). **D15-B continua NÃO aprovada e
> NÃO congelada.** Entrega para NOVA auditoria. D15-C e D16 **não foram
> iniciadas**. D15-A permanece congelada em — código de produção `91b3201`;
> documentação `43123fe` — nenhum comportamento congelado foi reaberto.
> Nenhuma rota pública nova, nenhum arquivo de frontend. Cadência, seleção
> de target, claims, fetches e consumo de crédito de tracking inalterados.

## 1. Os dois achados e a causa raiz

### Achado bloqueante 1 — o outbox de avisos de pendência não tinha consumidor de produção

**Causa raiz:** D15-B criou `demurrage_pendencia_avisos` e a função
`processarAvisosPendenciaPendentes` (claim/posse completo), mas **nenhum
código de produção a chamava**. `enfileirarAvisoPendenciaComClient` grava a
entrega `PENDING` na mesma transação da pendência (R07/R08) — e ela ficava
ali para sempre. Não existia, além disso, nenhum transporte CONCRETO
(`AvisoPendenciaTransport`) — só a porta (interface). Gestores nunca eram
de fato notificados pelos dois casos que o Blueprint exige notificação
ativa (R07 — fallback manual superado; R08 — retorno vazio antes da
descarga).

**Correção:** o mesmo padrão já aprovado para
`demurrage_fallback_manual_avisos` (D10 v1.3) e `ft_divergencia_entregas`:

1. Transporte concreto por e-mail (Microsoft Graph), novo arquivo
   `src/demurrage/avisoPendenciaTransportGraph.ts`.
2. Nova etapa isolada `etapaAvisosPendencia` no tick do scheduler
   (`src/demurrage/schedulerBootstrap.ts`), rodando **depois** de todas as
   etapas pré-existentes (incluindo a etapa de avisos de fallback manual),
   com fronteira de erro própria.
3. Limite padrão de 50 por ciclo (igual às demais filas).
4. Mesmo protocolo de claim/posse (token, lease, fencing, limite de
   tentativas, envio fora de transação) — **reaproveitado sem reimplementar
   nada**: só a consulta de `processarAvisosPendenciaPendentes` ganhou o
   JOIN de papel (achado 2) e os dois contadores que faltavam.
5. `iniciarSchedulerDemurrage` passa a construir e injetar o transporte
   real automaticamente — nenhuma configuração manual adicional.

### Achado bloqueante 2 — papel do destinatário nunca revalidado no envio

**Causa raiz:** `enfileirarAvisoPendenciaComClient` já filtrava
MANAGER/ADMIN **na criação** da entrega (correto), mas a função de consumo
(`processarAvisosPendenciaPendentes`) nunca reconsultava
`organization_memberships` — nem no claim, nem na leitura que precede o
envio. Uma membership MANAGER/ADMIN no momento em que a pendência nasceu e
rebaixada a CLIENT depois seria reivindicada e notificada normalmente,
porque o papel nunca era relido.

**Correção:** o papel é revalidado **duas vezes**, sempre contra a tabela
`organization_memberships` no instante de cada leitura (nunca um papel
armazenado/reaproveitado):

1. **No CLAIM** — a subconsulta que escolhe a próxima entrega agora faz
   `JOIN organization_memberships m ON m.id = av.destinatario_membership_id`
   com `m.papel::text = ANY(['MANAGER','ADMIN'])` — mesma régua, mesma
   sintaxe de `processarAvisosFallbackManualPendentes`. Uma entrega cujo
   destinatário não é gestor **agora** nunca é reivindicada — fica `PENDING`
   indefinidamente, sem consumir tentativa, até o papel ser restituído (ou
   para sempre, se nunca for).
2. **Na leitura de detalhe**, imediatamente antes do envio — mesmo filtro,
   defesa em profundidade contra a janela estreita entre o claim e o envio.
   Se essa segunda leitura não encontrar linha (papel mudou nesse intervalo,
   ou o membership foi removido), a posse é devolvida a `PENDING` sem
   incrementar nenhum contador de desfecho — **nunca lança, nunca marca
   como enviada**.

Um membership **removido** produz exatamente o mesmo efeito pelo mesmo
motivo estrutural (o `JOIN` não casa) — nunca uma exceção. Na prática isso é
inatingível em uso normal (a FK composta
`demurrage_pendencia_avisos_membership_org_fk`, já existente desde a
migration `0036`, impede excluir um membership referenciado por uma entrega)
— o teste §4 prova a defesa em profundidade mesmo assim, exatamente como já
feito para a mesma garantia em `responsavelOperacional.test.ts`.

## 2. Arquivos alterados (exatos)

### Novos

| Arquivo | Conteúdo |
|---|---|
| `src/demurrage/avisoPendenciaTransportGraph.ts` | Transporte concreto (Microsoft Graph) de `AvisoPendenciaTransport` — `montarEmailAvisoPendencia` + `criarAvisoPendenciaTransportGraph`, mesmo padrão de `avisoFallbackManualTransportGraph.ts`/`avisoDivergenciaTransportGraph.ts`. |
| `src/demurrage-engine/__tests__/d15bV11.test.ts` | Os 14 testes desta versão (§4). |
| `docs/demurrage-fase-d15-b-v1-1.md` | Este documento. |

### Alterados — produção

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/registro/notificacaoPendencia.ts` | `processarAvisosPendenciaPendentes`: subconsulta do CLAIM ganha `JOIN organization_memberships` + filtro de papel (achado 2); leitura de detalhe pré-envio ganha o MESMO filtro + guarda explícita (sem linha → devolve a `PENDING`, nunca lança); `ProcessarAvisosPendenciaResultado` ganha `restantes`/`esgotadas` (achado 1, item 6). Nenhuma mudança de assinatura pública — só comportamento interno. |
| `src/demurrage/schedulerBootstrap.ts` | Nova etapa `etapaAvisosPendencia` (mesma forma de `etapaAvisosFallback`, isolada, roda depois dela); `TickDeps` ganha `avisoPendenciaTransport?`, `limites.avisosPendencia?`, `processarAvisosPendencia?` (hook de teste); `TickResultado` ganha `avisosPendencia: EtapaAvisosPendenciaResultado`; `formatarLogTick` ganha a linha `avisos-pendencia: ...`; `iniciarSchedulerDemurrage` constrói `criarAvisoPendenciaTransportGraph()` e injeta no tick real — nenhuma configuração manual adicional para ligar o consumidor em produção. |

Nenhuma migration nova (o schema de `demurrage_pendencia_avisos`, criado na
migration `0036`, já tinha tudo que esta correção precisa — inclusive a FK
composta que torna o achado 2/"membership removido" inatingível em uso
normal). Nenhuma rota, nenhum arquivo de frontend, nenhum motor tarifário,
nenhuma regra de cadência/crédito de tracking foi tocado.

## 3. Comportamento de transação, lock, retry e isolamento de etapa

Protocolo de claim/posse **idêntico** ao já aprovado para
`demurrage_fallback_manual_avisos` — nenhuma peça nova inventada:

1. **CLAIM** — um único `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
   LOCKED LIMIT 1)` por iteração, token (`claim_token`) + `worker_id` +
   lease (`expira_em`, padrão 5 min) gravados no mesmo `UPDATE`;
   `tentativas` incrementada nesse mesmo passo. Candidatas: `PENDING`,
   `FAILED` com tentativas abaixo do máximo (padrão 5), ou `PROCESSING` com
   lease vencida (recuperação de worker morto) — e, agora, só quando o
   destinatário é MANAGER/ADMIN **nesse instante**.
2. **ENVIO** — fora de qualquer transação de banco: entre o `UPDATE` do
   claim (autocommit, uma única instrução) e a leitura de detalhe
   (autocommit, outra instrução), não há `BEGIN` nenhum; o `await
   transport.enviar(...)` roda depois que o claim já está COMMITADO e
   visível a qualquer outra conexão — provado empiricamente no teste §4.14
   (uma sonda, dentro do próprio `enviar`, lê o `status` por uma consulta
   independente e só pode ver `'PROCESSING'` se o `UPDATE` já tiver sido
   commitado — sob `READ COMMITTED`, uma transação em aberto nunca seria
   visível a outra conexão).
3. **FINALIZAÇÃO** — `UPDATE ... WHERE id = $1 AND status = 'PROCESSING' AND
   claim_token = $2`: só o dono vigente do token finaliza; se outro worker
   já recuperou a lease e reivindicou de novo, a condição não casa
   (`rowCount = 0`) e o worker antigo conta `possePerdida`, nunca sobrescreve
   o novo dono.

**Isolamento de etapa**: `etapaAvisosPendencia` tem sua própria `try/catch`
— uma falha na etapa inteira (ou numa única entrega, capturada dentro do
próprio `processarAvisosPendenciaPendentes`) nunca impede: a etapa de
tracking/cadência, o calendário, a etapa de pós-commit, a etapa de avisos de
fallback manual, nem o laço do scheduler (que recebe o `erro` nos
contadores, nunca uma exceção). Confirmado nos testes §4.10/§4.11.

**Limite por ciclo**: `deps.limites?.avisosPendencia ?? 50` — mesmo valor e
mesmo mecanismo das demais filas.

**Contadores** (seis, mesma forma de `EtapaAvisosFallbackResultado`):
`reivindicadas`, `enviadas`, `falhadas`, `possePerdida`, `restantes`,
`esgotadas` — mais `semTransporte`/`erro` no nível da etapa do tick.

## 4. Testes novos (14 itens, cobrindo os 13 cenários exigidos)

Arquivo: `src/demurrage-engine/__tests__/d15bV11.test.ts`. Reaproveita os
helpers de cenário de `d15b.test.ts` (R07/R08) e os helpers de tick de
`demurrageTickFilas.test.ts` (`portContador`, `transportFake`, `deps`).

| # | Teste | Cenário exigido |
|---|---|---|
| 1 | aviso PENDING de R07 enviado pelo tick | "an R07 pending notification is automatically sent by the scheduler tick" |
| 2 | aviso PENDING de R08 enviado pelo tick | "an R08 pending notification is automatically sent by the scheduler tick" |
| 1–14 | nenhum teste chama `processarAvisosPendenciaPendentes` diretamente para provar o envio — só `executarTickDemurrage`/o laço do scheduler | "no manual service call is required" |
| 3 e 4 | transporte indisponível (erro e exceção) deixa `FAILED`/retentável; tick seguinte reenvia com sucesso (3 tentativas) | "unavailable transport leaves the delivery retryable" / "the next tick successfully retries it" |
| 4b | entrega com `tentativas = max` nunca mais reivindicada, contada em `esgotadas` | (cobertura adicional do limite de retry, mesmo padrão das demais filas) |
| 5 | dois ticks concorrentes (`Promise.all`, transporte lento) — uma única entrega, uma única mensagem | "two concurrent ticks do not send the same delivery twice" |
| 6 e 7 | lease vencido recuperado por um novo worker; o worker antigo (posse perdida) não finaliza — `SENT` do novo dono prevalece | "an expired lease is recovered" / "the old worker cannot finalize after losing ownership" |
| 8 | gestor rebaixado a CLIENT entre o nascimento da entrega e o tick nunca recebe; fica `PENDING`; restituído o papel, o PRÓXIMO tick entrega sem intervenção manual | "a recipient demoted to CLIENT is never sent the notification" |
| 8b | linha forjada para um destinatário que sempre foi CLIENT nunca é reivindicada | (cobertura adicional do mesmo achado, caminho de criação) |
| 9 | membership removido (FK dropada deliberadamente para simular, depois restaurada) — o tick inteiro completa sem lançar, zero reivindicações, zero envios | "a removed membership does not crash the tick" |
| 10 | duas entregas (orgs distintas), a primeira falha, a segunda é enviada mesmo assim; tracking/calendário seguem rodando | "one failing notification does not block other notifications or any existing scheduler stage" |
| 11 | etapa INTEIRA quebrada (`processarAvisosPendencia` lança) não interrompe o laço do scheduler nem as demais etapas do mesmo tick | (mesmo requisito, nível de etapa inteira — complementa o #10) |
| 12 | cenário com tracking real (MBL/armador) comparado a um cenário idêntico mais trabalho da nova fila numa outra organização — mesmas chamadas ao armador, mesmos claims, mesmos fetches | "running the new queue produces zero tracking fetches, zero tracking claims and zero additional credit consumption" |
| 13 | limite de ciclo (`0` força `reivindicadas=0`; padrão 50 drena no tick seguinte); contadores no resultado e no log (`formatarLogTick`); etapa sem transporte configurado sinaliza `semTransporte` sem falhar | (verificação estrutural dos contadores e do limite, exigidos em conjunto com os 13 cenários) |
| 14 | sonda dentro do `transport.enviar` lê o status da entrega por outra consulta — só vê `'PROCESSING'` porque o claim já estava commitado | "no external send occurs inside a database transaction" |

Todos os 14, verdes (ver §6 para a regressão completa).

## 5. O que esta entrega NÃO faz

- Não declara D15-B aprovada nem congelada.
- Não inicia D15-C nem D16.
- Não reabre nenhum comportamento congelado de D15-A ou do restante de
  D15-B sem regressão demonstrada (nenhuma ocorreu).
- Não adiciona rota pública nem trabalho de frontend.
- Não altera cadência, seleção de target, claims, fetches ou consumo de
  crédito de tracking — provado empiricamente no teste §4.12.
- Não cria migration nova.
- Não altera as demais 17 pendências de D15-B (R05, R08-cronologia sem
  notificação ativa, R09, R18, R26, R36-R41, R44, R45, R50, R55, R56, R61) —
  escopo estritamente limitado ao outbox de avisos de pendência (R07/R08) e
  à revalidação de papel no envio.

## 6. Totais de teste — regressão completa

Executado sequencialmente contra PostgreSQL 16 real
(`DEMURRAGE_TEST_DATABASE_URL`/`DEMURRAGE_DATABASE_URL`/`DATABASE_URL`
apontando para o mesmo banco, reconstruído do zero pelas migrations
0001–0036), nenhum teste pulado:

| Suíte | Resultado |
|---|---|
| D15-A v1.0–v1.3 (`closingD15A.test.ts`, `closingD15AV11/V12/V13.test.ts`) | Incluída na suíte completa abaixo — **0 falhas** |
| D15-B — 18 casos (`d15b.test.ts`) | **18/18** |
| D15-B v1.1 (`d15bV11.test.ts`) — os 14 testes desta versão (§4) | **14/14** |
| Suíte completa do Demurrage Engine (`npm run test:demurrage-engine`, 66 arquivos `*.test.ts`) | **889/889 pass, 0 fail, 0 cancelled, 0 skipped** |
| V1 (`npm test` — `src/auditoria/preAlerta/*.test.ts`) | **25/25 pass, 0 fail** |
| D13 UI (`npm run test:demurrage-ui` — `src/frontend-tests/*.test.ts`) | **66/66 pass, 0 fail** |
| `tsc --noEmit` | Limpo, 0 erros |
| Build de produção (`npm run build` → `tsc`) | Limpo, 0 erros |

Comparado à última execução completa de D15-B (875/875), a diferença de 14
testes corresponde exatamente aos 14 testes novos desta versão
(`d15bV11.test.ts`) — nenhum teste pré-existente precisou de ajuste nesta
correção; nenhuma regressão.
