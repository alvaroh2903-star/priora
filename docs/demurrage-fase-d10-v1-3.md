# Fase D10 v1.3 — ligação operacional das filas do registro (NÃO congelada)

> **Status:** entregue para auditoria. A D10 não é declarada congelada; nada da
> D11 foi iniciado. Base: commit `c1cd083` (v1.2 aprovada estruturalmente).

## O que mudou

As duas filas criadas na v1.2 passam a ser consumidas **automaticamente** pelo
tick do scheduler in-process da Demurrage (`src/demurrage/schedulerBootstrap.ts`),
em duas etapas próprias, identificáveis e **isoladas**, adicionadas **depois**
das etapas existentes:

| Etapa | Consumidor | Limite/ciclo (default) | Contadores no resultado e no log |
|---|---|---|---|
| `registro-posCommit` | `processarPosCommitOutboxPendentes` | 50 claims | reivindicados, reparados, falhos, possePerdida, restantes, erro |
| `avisos-fallback` | `processarAvisosFallbackManualPendentes` + transporte Graph real | 50 entregas | reivindicadas, enviadas, falhadas, possePerdida, restantes, esgotadas, semTransporte, erro |

- **Mesma data operacional:** o reparo recebe o `hoje` calculado UMA vez no
  tick (o mesmo do calendário e do claim de tracking). A etapa não relê o relógio.
- **Reparo:** reivindica `pendente`, `falha` e `processando` vencido; claim de
  posse, token e geração da v1.2 inalterados; `concluido` nunca é reivindicado.
  O orçamento de claims é do ciclo inteiro (somado entre processos).
  `restantes` = linhas não concluídas (contagem pelo índice parcial já existente).
- **Avisos:** envio pelo **mesmo canal** dos alertas da Demurrage (Microsoft
  Graph, token da conta ativa) em `src/demurrage/avisoFallbackManualTransportGraph.ts`,
  fora de qualquer transação; `PROCESSING` vencido recuperado; máximo de 5
  tentativas (`esgotadas` quando atinge o teto); fencing pelo `claim_token`;
  cada entrega é independente (a falha de um destinatário não bloqueia os
  demais); canal ausente/sem token → `FAILED` reprocessável; semântica "ao
  menos uma vez" do projeto. Nenhuma entrega é criada pelo tick — só as já
  gravadas pelo registro são enviadas.
- **Nunca a CLIENT:** a reivindicação só aceita entregas cujo destinatário é
  **hoje** MANAGER/ADMIN — um gestor rebaixado a CLIENT (ou uma linha forjada
  para CLIENT) nunca recebe; a entrega fica parada, sem envio.
- **E-mail:** só processo, contêiner, House/Master Free Time, valor,
  justificativa, referência da evidência, autor e data da observação. Nenhum
  id interno, token, payload bruto, corpo de e-mail ou documento.

## Isolamento

- Cada nova etapa captura a própria exceção e devolve `erro` nos contadores —
  nunca lança. Falha no reparo não bloqueia avisos; falha nos avisos não
  bloqueia nada.
- As etapas **pré-existentes** (calendário, tracking, entregas de alerta,
  SI, recálculo, avisos de divergência) ficaram **inalteradas** — mesma ordem,
  mesmos cálculos, mesmos indicadores e a mesma propagação de erro. A única
  diferença: se uma delas lançar, as duas etapas novas **ainda rodam no mesmo
  tick** e só então o erro original é repassado ao laço (que já o captura em
  `onError` e segue agendando ticks).
- O laço (`startSchedulerLoop`) não mudou; nenhuma exceção o derruba.

## O que NÃO mudou

`cadencePolicy`, janelas e claims de tracking (`tracking_schedule_claims`),
seleção de targets, VesselCall, consumo de créditos, relógios, tarifas,
responsabilidade, minutas, fechamento — nenhum arquivo de
`src/demurrage-engine/scheduler`, `tracking` ou `persistence` foi alterado.
Nenhuma rota pública, tela ou criação manual de processo. Auditoria, Courier,
Liberação, Portal e HeadCargo intocados.

**Migration:** nenhuma — todas as colunas/índices necessários (claim, token,
geração, índice parcial de pendentes, índice de status) já existiam desde a 0030.

## Evidência (`demurrageTickFilas.test.ts`, 18 testes, PostgreSQL real)

| # exigido | Teste |
|---|---|
| 1 | item em `falha` reparado pelo tick, relógios criados, **nenhum** novo registro no ledger |
| 2 | concluído: ticks seguintes reivindicam 0, tentativas e `concluido_em` inalterados |
| 3 | claim vencido (worker morto) recuperado; claim vivo de outro worker intocado (3b) |
| 4 | dois ticks concorrentes: exatamente 1 claim e 1 reparo, +1 tentativa |
| 5 | reparo quebrado → tick conclui, tracking e calendário rodam, aviso é enviado |
| 6 | aviso pendente enviado; e-mail contém os 8 campos e nenhum id/token |
| 7/8 | canal sem token e canal que lança → `FAILED` reprocessável; tick posterior → `SENT` (3 tentativas) |
| 7b | teto de tentativas: não reivindica, conta como esgotada |
| 9 | 4 ticks → 1 mensagem por gestor, nenhuma entrega nova |
| 10 | CLIENT nunca recebe (entrega não criada, gestor rebaixado, linha forjada) |
| 11 | duas instâncias concorrentes → cada entrega enviada uma vez; 11b: instância com posse vencida não finaliza |
| 12 | etapa de avisos quebrada → laço executa 2 ticks, `onError` nunca chamado, reparo e tracking rodam; 12b: falha do calendário ainda consome a fila de reparo no mesmo tick e o erro segue para o laço |
| 13 | tick com data ≠ relógio real: calendário, janela de tracking e reparo recebem a mesma data |
| 14 | mesmo cenário com e sem trabalho nas filas: **mesmas** consultas ao armador, mesmos claims de janela, mesmos fetches e indicadores de tracking; as etapas sozinhas não tocam tabelas de tracking |
| 15 | contadores no resultado e no log (`formatarLogTick`); limite por ciclo respeitado e drenado no tick seguinte; sem transporte → `semTransporte` |

Ajustes em testes anteriores: só o novo campo `reivindicados` no resultado de
`repararPosCommitOutbox`/`processarPosCommitOutboxPendentes`.

## Validação

| Suíte | Aprovados | Falhos | Ignorados |
|---|---|---|---|
| Engine completa (PostgreSQL 16 real, `priora_test`) | 510 | 0 | 0 |
| — gates D10: G1 12, G2 6, G3 11, G4 2, G5 1, G6 1 | 33 | 0 | 0 |
| V1 | 25 | 0 | 0 |
| `tsc --noEmit` / `npm run build` | sem erros | — | — |
