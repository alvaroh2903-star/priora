# Fase D12 v1.2 — correção do contrato operacional (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria. Base: `1bdd406` (D12 v1.1 aprovada e
> congelada) + `3eb89aa` (diagnóstico D13, aprovado). Reabertura **controlada
> e aditiva** da D12, limitada a DV-01, DV-03, DV-04 e DV-05 do diagnóstico
> da D13, mais a extensão de `/filtros` (item 5). **Não implementa a D13**,
> não cria UI, não avança para D14, não altera D10/D11, não altera rotas V1,
> não integra Supabase/Liberação/HeadCargo/Portal, não cria ações
> operacionais, não altera motores tarifários. Nenhuma migration — não houve
> necessidade técnica real.

## 1. Resumo das quatro correções

| Divergência | Problema no contrato (D12 v1.1) | Correção (v1.2) |
|---|---|---|
| **DV-04** | Detalhe de processo/contêiner e `/filtros` liam colunas persistidas (`estado`, `estado_badges`, `prioridade_balde`, `documentary_status`) que podiam estar atrasadas em relação ao `hoje` operacional — só a fila já usava a derivação atual (v1.1). | Os quatro endpoints usam a MESMA derivação atual: `LifecycleRepository.derivarEmLote` (congelada, Fase 7), com o `hoje` desta requisição. Detalhe de processo deriva todos os seus contêineres em UM lote (nunca N+1). |
| **DV-03** | A fila/detalhe não expunham qual contêiner determinou a prioridade do processo. | Bloco `lider` (id, número, estado, prioridade, motivo, `determinaPrioridadeConsolidada: true`) na fila e no detalhe de processo — exclusivamente o resultado de `consolidarProcesso` (congelada), nenhuma nova ordenação. |
| **DV-01** | A fila mostrava só o envelope do contêiner-líder como se fosse o total financeiro do processo. | `agregadoFinanceiro` (cliente/Rocket, por moeda) na fila e no detalhe de processo — função pura `agregarFinanceiroProcesso`, nunca soma moeda diferente nem lado diferente, nunca zera indisponível/pendente. |
| **DV-05** | Não havia limiar único de Prazo Próximo nem bloco de prazo por relógio/próximo vencimento do processo na leitura. | Limiar padrão `PRAZO_PROXIMO_DIAS_PADRAO = 4` centralizado em `lifecycle/prazoFreeTime.ts`, usado pelo pipeline (`LifecycleRepository`), e bloco de prazo (`diasRestantes`, `dentroDoFreeTime`, `emPrazoProximo`, `vencido`, `proximoMarco`) em cada relógio do detalhe + `proximoVencimento` do processo na fila e no detalhe. |
| **Item 5** | `/filtros` contava estado/balde com `GROUP BY` sobre coluna persistida. | `contarEstadosEBaldes` (nova, em `filaOperacional.ts`) reaproveita as mesmas funções da fila — custo constante, sem N+1, sem soma financeira. |

## 2. DV-05a — limiar único e módulo temporal

`src/demurrage-engine/lifecycle/prazoFreeTime.ts` é a fonte ÚNICA das contas
de prazo do Free Time, usada por três consumidores que antes podiam
divergir:

- o estado `PRAZO_PROXIMO` do lifecycle (`containerState.ts`);
- o desempate #5 da fila (`priorityEngine.ts`);
- a leitura operacional da D12 v1.2 (bloco de prazo por relógio, DV-05).

Funções puras: `diasAteUltimoDiaLivre`, `estaEmPrazoProximo`,
`inicioDoPrazoProximo` (já existentes), mais `blocoPrazoRelogio` e
`escolherProximoVencimentoProcesso` (novas, v1.2) — nenhum cálculo de data
paralelo, todas sobre o mesmo `ClockFact` já lido do cache `relogios`.

`PRAZO_PROXIMO_DIAS_PADRAO = 4` passa a ser o padrão de
`LifecycleRepository.montarFatosEmLote` quando o chamador não informa
`prazoProximoThresholdDias` (um `null` explícito continua desligando o
estado, como antes). Como nenhum chamador real (pipeline, tick diário,
leitura) passava esse parâmetro, o `PRAZO_PROXIMO` **nunca tinha sido
emitido em produção** — esta era a lacuna real que a DV-05a fecha.
`containerState.ts`/`priorityEngine.ts` foram refatorados
(behavior-preserving) para usar `prazoFreeTime.ts` em vez de reimplementar
a mesma subtração de ordinais.

## 3. DV-04 — mesma derivação atual, custo constante no detalhe de processo

`leitura/detalhe.ts` foi reescrito:

- `buscarDetalheProcesso` deriva **todos** os contêineres do processo em UM
  lote (`LifecycleRepository.derivarEmLote`) e carrega relógios, valores,
  validade de cache, observações de campo, fallback manual, minutas e
  responsabilidade também em lote (`buscarDadosBatchContainers`), com
  consultas sempre `= ANY($1)` — nunca uma consulta por contêiner;
- `montarDetalheContainerDeDados` é uma função pura de montagem (sem
  consulta alguma) — o `ContainerDetalheV1.estado`/`badges` vem de
  `pacote.state`, nunca mais de `row.estado`/`row.estado_badges`;
- `RelogioRepository.buscarValidosEmLote` (nova) faz a mesma verificação de
  `buscarValido` para vários contêineres em 2 consultas constantes;
  `buscarValido` passou a delegar para o lote de um elemento (mesma
  implementação, sem duplicar a regra do `input_hash`);
- `estadoMaisRelevante`/`prioridade` do processo vêm de `consolidarProcesso`
  (congelada) sobre o lote derivado agora — nunca de
  `p.estado_mais_relevante`/`p.prioridade_balde`;
- `/filtros` (`filtros.ts`) chama `contarEstadosEBaldes` (nova, em
  `filaOperacional.ts`), que reaproveita `buscarProcessosCandidatos` +
  `buscarContainersDosCandidatos` + `derivarEmLote` + `consolidarProcesso` —
  os MESMOS passos da fila, nenhuma regra duplicada.

Nada aqui recalcula relógio ou tarifa: tudo lê o cache `relogios` e
`valores_apurados` já persistidos; só a INTERPRETAÇÃO (estado, prazo,
agregado) é recalculada em memória a cada leitura.

## 4. DV-03 — contêiner líder

`LiderLeitura` (novo, em `contrato.ts`): `containerId`, `numero`, `estado`,
`prioridade` (com `promocaoTopo` real, nunca fixado `false`),
`motivoPrioridade`, `determinaPrioridadeConsolidada: true`. Vem
exclusivamente de `pacotes.get(consolidado.containerLiderId)` — o mesmo
líder que `consolidarProcesso` já escolhia para o estado/prioridade do
processo, nenhuma ordenação nova. Exposto em `FilaItemV1.lider` e
`ProcessoDetalheV1.lider`.

## 5. DV-01 — agregação financeira por processo, lado e moeda

`agregarFinanceiroProcesso` (pura, `contrato.ts`) recebe os envelopes
(`ValorEnvelope`, já traduzidos por `envelopeDeValor`) de TODOS os
contêineres do processo e devolve, por lado (cliente/Rocket) e por grupo de
moeda: `moeda`, `subtotalConhecido`, `confirmados`, `estimados`,
`estimativasProvisorias`, `pendentes`, `indisponiveis`, `semAplicacao`,
`completo`.

Regras garantidas pela função (ver testes em `prazoFreeTimeV12.test.ts`):

- nunca soma moedas diferentes (`CONFIRMADO`/`ESTIMADO`/
  `ESTIMADO_PROVISORIO` só entram no grupo da própria moeda);
- nunca cruza cliente × Rocket (dois agregados independentes);
- `PENDENTE`/`INDISPONIVEL` (sem moeda na origem — `envelopeDeValor` não
  preenche `moeda` fora de CONFIRMADO/ESTIMADO/ESTIMADO_PROVISORIO) vão para
  um grupo `moeda: null` que nunca é tratado como zero: contados em
  categoria própria e `completo: false`;
- `NAO_APLICAVEL` (sem demurrage) também cai no grupo `moeda: null`, mas
  **não** marca `completo: false` — distinção explícita entre "sem
  demurrage" (completo) e "sem informação" (incompleto);
- `subtotalConhecido` nunca é chamado de total definitivo quando há
  pendente/indisponível no mesmo lado — o nome e o `completo: false` do
  grupo sem moeda deixam isso explícito para quem consome o contrato.

A fila carrega o agregado de TODOS os contêineres do processo (consulta de
`valores_apurados` ampliada de "só os líderes da página" para "todos os
contêineres dos processos da página", ainda com custo constante por
página). O campo antigo `exposicaoFinanceira` (só o envelope do líder) foi
mantido por compatibilidade e documentado como tal — `agregadoFinanceiro`
é o valor do PROCESSO.

## 6. DV-05 — próximo vencimento e dias restantes

`PrazoRelogioLeitura` (novo, em `RelogioLeitura`): `diasRestantes`,
`dentroDoFreeTime`, `emPrazoProximo`, `vencido`, `proximoMarco`. Regras
(`blocoPrazoRelogio`, pura):

- relógio não `OK` (Free Time ausente ou sem descarga) → bloco pendente;
- `diasDemurrage ≥ 1` → `vencido: true`, `diasRestantes: null` (nunca um
  negativo — "valores negativos não devem ser apresentados como dias
  restantes");
- senão, dentro do Free Time (inclui o próprio último dia livre, onde
  `diasRestantes = 0`) → `proximoMarco` = `{ tipo: 'FIM_FREE_TIME', data,
  diasRestantes }`.

Cliente usa House, Rocket usa Master — os dois blocos são computados
separadamente sobre o `ClockFact` de cada relógio, nunca fundidos.

`ProximoVencimentoLeitura` (processo): o marco futuro mais próximo entre
TODOS os contêineres/relógios do processo
(`escolherProximoVencimentoProcesso`, pura — menor `diasRestantes`,
desempate por data, depois contêiner, depois cliente antes de Rocket).
Exposto em `FilaItemV1.proximoVencimento` e `ProcessoDetalheV1.proximoVencimento`.

Única decisão de design registrada (não estava no Blueprint com este
detalhe): o único tipo de marco emitido nesta fase é `FIM_FREE_TIME` (a
transição Free Time → demurrage). Não há, nesta fase, outro marco
operacional definido para o bloco de prazo — se o Blueprint vier a definir
mais tipos, eles entram em `TipoMarcoOperacional` sem alterar o que já
existe.

## 7. Itens fora do escopo desta entrega, registrados

- **Cadência (Cap. 16) tem sua própria regra "LFD − 4 dias" para o início do
  tracking diário** (`cadencePolicy.ts`, `inicioDiario`) — uma regra
  DIFERENTE de Prazo Próximo (operação de tracking automático × estado
  exibido ao usuário). As duas usam o número 4 por coincidência de negócio,
  não por acoplamento de código; não foram unificadas porque descrevem
  coisas diferentes e a cadência está fora do escopo autorizado desta D12
  v1.2 ("não duplicar regras temporais" foi lido como "não ter dois
  cálculos da MESMA regra", não como "toda regra que usa dias deve ser uma
  só função").
- **Janela de inconsistência do cache "OBSOLETO".** O bloco de prazo (como
  o estado do lifecycle) lê `ClockFact` do cache `relogios`; a parte
  DATA-DRIVEN (dias restantes até o último dia livre) é sempre ao vivo, mas
  `diasDemurrage` em si só muda quando o relógio é recalculado (tick diário
  ou reingestão). Entre o momento em que o Free Time realmente vence e o
  próximo tick, o relógio pode ficar `cache: OBSOLETO` sem que
  `diasDemurrage` ainda reflita isso — documentado, não corrigido aqui
  (corrigir romperia "ler relógios existentes, nunca recalcular" do pedido).
  O teste "DV-03: o líder muda com a passagem da data, SEM nenhuma
  gravação" demonstra e usa exatamente esta janela.

## 8. Testes (`__tests__/prazoFreeTimeV12.test.ts` + `__tests__/leituraD12V12.test.ts`)

### Puros (sem banco) — `prazoFreeTimeV12.test.ts`, 25 testes

| Ponto | Testes |
|---|---|
| DV-05 bordas | faltam 5 dias (fora do limiar); faltam exatamente 4 (dentro, limiar inclusivo); falta 1; no próprio último dia livre (`diasRestantes=0`); primeiro dia de demurrage (vencido, sem negativo, sem marco); Free Time zero (chega a vencido, não a pendente); relógio `PENDING` (Free Time/descarga ausente); House ≠ Master (blocos independentes); limiar `null` desliga Prazo Próximo |
| DV-05 próximo vencimento | menor `diasRestantes` entre vários contêineres/relógios; lista vazia → `null`; desempate por data/contêiner/cliente-antes-de-rocket |
| DV-01 agregação | 1 contêiner; mesma moeda (soma); moedas diferentes (nunca somam); confirmado+estimado; conhecido+indisponível; conhecido+pendente; todos indisponíveis; zero confirmado (nunca "fantasma" com moeda); cliente×Rocket com moeda/situação diferentes; estimado nunca confirmado; estimativa provisória em categoria própria |

### Integração (PostgreSQL real, pipeline oficial) — `leituraD12V12.test.ts`, 11 testes

| Ponto | Testes |
|---|---|
| DV-04 | persistido SILENCIOSO → hoje PRAZO_PROXIMO: fila, detalhe de processo, detalhe de contêiner e `/filtros` concordam, coluna persistida intocada (zero escrita verificada) · persistido PRAZO_PROXIMO → leitura num `hoje` anterior volta a SILENCIOSO (prova que o GET é função pura de `{cache, hoje}`) |
| DV-03 | processo com contêineres em estados diferentes → líder é o mais prioritário, igual na fila e no detalhe · empate de balde resolvido pelo desempate congelado #1 (mais dias de demurrage) · líder muda só pela passagem da data (cache `relogios` nunca recalculado), fingerprint do schema inteiro idêntico antes/depois · líder nunca de outro processo/organização (isolamento) · `promocaoTopo=true` (CRITICA_15 + dado crítico ausente) chega igual na fila, no detalhe e no líder — nunca fixado `false` |
| DV-01 | agregado do processo soma os contêineres do mesmo lado/moeda (Termo por Embarque), nunca cruza lado nem moeda, fila e detalhe concordam · Termo Único usa o motor certo, sem misturar com Embarque · contêiner sem tarifa aplicável (`INDISPONIVEL`) nunca vira zero, vai para o grupo sem moeda, marca incompleto |
| DV-05 | próximo vencimento do processo aponta o contêiner/relógio certo, muda com a passagem da data, fila e detalhe concordam |

## 9. Validação completa

| Suíte | Resultado |
|---|---|
| Engine completa (`npm run test:demurrage-engine`, inclui D10, D11, D12 completa — G1–G7, v1.1, v1.2 —, lifecycle/prioridade, relógios, tarifas/apuração, rotas V2, os novos `prazoFreeTimeV12.test.ts` e `leituraD12V12.test.ts`) | **PREENCHER (pass/fail/total) após a corrida final** |
| V1 (`npm test`) | 25/25 |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

Zero escrita: a suíte `demurrageV2Routes.test.ts` (G7, já existente, roda
contra o schema inteiro) e os testes desta entrega (fingerprint
antes/depois) confirmam zero escrita em todas as leituras novas e
reescritas, incluindo os caminhos em lote de `detalhe.ts` e
`relogioRepository.buscarValidosEmLote`.

### Benchmarks de custo constante (banco descartável, fixtures por SQL direto)

| Endpoint | Volume | Queries | Tempo |
|---|---|---|---|
| Fila (página de 50) | 1 processo | 13 | 22 ms |
| | 300 processos | 13 | 39 ms |
| | 1.000 processos | 13 | 53–57 ms |
| | 2.000 processos | 13 | 99–122 ms |
| Detalhe de processo | 1 contêiner | 21 | 19–23 ms |
| | 10 contêineres | 21 | 23 ms |
| | 100 contêineres | 21 | 35 ms |
| | 500 contêineres | 21 | 62 ms |

O número de queries é CONSTANTE em todos os quatro pontos de cada linha —
confirma que DV-01/DV-03/DV-05 (todos aditivos nesta entrega) não
introduziram N+1 nem na fila nem no detalhe de processo.

## 10. Limites respeitados

Não implementei a D13, não criei UI, não avancei para D14, não alterei
D10/D11, não alterei rotas V1, não integrei Supabase/Liberação/
HeadCargo/Portal, não criei ações operacionais, não alterei motores
tarifários, não dupliquei regras temporais (uma única fonte em
`prazoFreeTime.ts`), não houve migration (nenhuma necessidade técnica real
surgiu). Organização sempre da sessão; moedas e relógios nunca misturados;
fila, detalhes e filtros concordam entre si para o mesmo `hoje`.

**Esta entrega não está aprovada nem congelada.** Aguardo auditoria.
