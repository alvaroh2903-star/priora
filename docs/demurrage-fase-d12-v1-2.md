# Fase D12 v1.2 (+ v1.2.1 corretiva) — correção do contrato operacional (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria. Base: `1bdd406` (D12 v1.1 aprovada e
> congelada) + `3eb89aa` (diagnóstico D13, aprovado). Reabertura **controlada
> e aditiva** da D12, limitada a DV-01, DV-03, DV-04 e DV-05 do diagnóstico
> da D13, mais a extensão de `/filtros` (item 5). **Não implementa a D13**,
> não cria UI, não avança para D14, não altera D10/D11, não altera rotas V1,
> não integra Supabase/Liberação/HeadCargo/Portal, não cria ações
> operacionais, não altera motores tarifários. Nenhuma migration — não houve
> necessidade técnica real.
>
> **v1.2.1 (corretiva, sobre `17d7ace`):** a auditoria da v1.2 encontrou três
> problemas bloqueantes — prazo negativo com cache desatualizado, completude
> financeira no nível errado e soma monetária em ponto flutuante. Os três
> estão corrigidos na seção 0 abaixo; as seções 5, 6, 7, 8 e 9 foram
> atualizadas para refletir o estado atual. Escopo estritamente limitado aos
> três achados; nenhuma migration; D10, D11, rotas V1, motores tarifários,
> Portal, Supabase, HeadCargo e Liberação intocados.

## 0. v1.2.1 — correção dos três achados da auditoria

### Achado #1 — cache desatualizado nunca mais produz dias restantes negativos

**Defeito.** `blocoPrazoRelogio()` consultava `clock.diasDemurrage` (cache
`relogios`) ANTES de comparar `hoje` com `ultimoDiaLivre`. Na janela real
entre a virada da data civil e o próximo tick de recálculo
(`passagemDoCalendario`), o cache ainda diz `diasDemurrage = 0` mas `hoje`
já passou do último dia livre. Resultado: `diasRestantes = -1`,
`dentroDoFreeTime = true`, `vencido = false` e um `proximoMarco` no
passado — uma leitura autocontraditória, que ainda podia ser escolhida como
`proximoVencimento` do processo.

**Correção** (`lifecycle/prazoFreeTime.ts`). A comparação de data civil passa
a ser AUTORITATIVA para o bloco de prazo: com relógio `OK` e `hoje >
ultimoDiaLivre` → `vencido = true`, `diasRestantes = null`,
`dentroDoFreeTime = false`, `emPrazoProximo = false`, `proximoMarco = null`.
`diasDemurrage` não é mais consultado por esta função — o cache não é lido
para decidir, não é alterado, não é recalculado, não é persistido, e nenhum
`diasDemurrage` é fabricado (o campo `dias` do relógio e o `cache:
VALIDO/OBSOLETO` continuam exatamente os do cache). Relógio pendente
continua pendente.

**Consistência lifecycle × prioridade × contrato.** O mesmo padrão (filtrar
por `dias >= 0` sobre a data civil, nunca por `diasDemurrage`) já era usado
por `containerState.ts` (`menorDiasAteVencimento`, que decide
`PRAZO_PROXIMO`) e por `priorityEngine.ts` (`diasAteVencimento`, desempate
#5). A v1.2 introduziu a única divergência — `blocoPrazoRelogio` — e a
v1.2.1 a alinha. Na janela de cache desatualizado, agora:

| Camada | Comportamento na janela |
|---|---|
| Bloco de prazo do relógio (contrato) | `vencido = true`, sem dias, sem marco |
| `proximoVencimento` do processo (fila e detalhe) | o relógio vencido não é candidato; nunca um prazo passado |
| Estado do lifecycle (`containerState`, congelado) | nunca `PRAZO_PROXIMO` (o relógio sai da conta); a severidade de demurrage continua a do cache até o tick |
| Prioridade/desempate #5 (`priorityEngine`, congelado) | o relógio vencido não conta como "vencimento próximo" |

Nenhuma camada afirma mais "dentro do prazo" ou "prazo próximo" para um
relógio cuja data já passou. O que permanece, por desenho e documentado na
seção 7, é que o **estado** do contêiner (ex.: `EM_DEMURRAGE_ATENCAO`) só
aparece depois que o tick diário recalcula o relógio — a leitura não pode
inventar `diasDemurrage`. O teste de integração da janela mostra os dois
momentos: antes do tick (bloco vencido, estado ainda do cache, nunca
`PRAZO_PROXIMO`) e depois do tick (estado, líder, bloco e próximo
vencimento convergem).

### Achado #2 — completude financeira no nível do LADO

**Defeito.** Pendente/indisponível/sem aplicação viravam um "grupo de moeda"
`moeda: null`, ao lado de grupos reais (`BRL`, `USD`), e cada grupo tinha seu
próprio `completo`. Um grupo `BRL` dizia `completo: true` mesmo com o lado
cliente incompleto (outro contêiner pendente) — duas leituras possíveis do
mesmo dado.

**Correção** (`leitura/contrato.ts`). Novo `AgregadoFinanceiroLado`, um por
lado, nunca somados entre si:

```ts
interface GrupoFinanceiroPorMoeda {
  moeda: string;               // sempre uma moeda real
  subtotalConhecido: string;   // decimal exato, ver achado #3
  confirmados: number;
  estimados: number;
  estimativasProvisorias: number;
}
interface AgregadoFinanceiroLado {
  gruposPorMoeda: GrupoFinanceiroPorMoeda[];
  pendentes: number;
  indisponiveis: number;
  semAplicacao: number;
  completo: boolean;           // AUTORITATIVO
}
interface AgregadoFinanceiroLeitura { cliente: AgregadoFinanceiroLado; rocket: AgregadoFinanceiroLado }
```

- `completo = false` ⇔ algum contêiner do lado está pendente ou
  indisponível; `completo = true` quando todo contêiner aplicável tem valor
  conhecido, inclusive zero confirmado;
- `NAO_APLICAVEL` (sem demurrage) é contado em `semAplicacao` e nunca torna
  o lado incompleto;
- pendente, indisponível e sem aplicação não são grupos de moeda; não existe
  mais `moeda: null`;
- os grupos de moeda NÃO têm `completo` próprio — a completude só existe no
  lado, eliminando a segunda interpretação. A forma anterior foi substituída
  (não mantida em paralelo): a v1.2 não estava aprovada e a D13 não começou,
  então não havia consumidor a preservar.

Fila e detalhe de processo chamam a MESMA função sobre os mesmos envelopes;
os testes comparam os dois agregados com `deepEqual`.

### Achado #3 — soma monetária exata

**Defeito.** `subtotalConhecido` era acumulado com `+` em ponto flutuante:
`0.1 + 0.2 = 0.30000000000000004`, e `20.02 + 30.03 + 10.01 =
60.059999999999995` — o resultado dependia até da ordem dos contêineres.

**Correção** (`leitura/moedaExata.ts`, fonte única de soma monetária da
leitura). Representação canônica:

- **interna:** centavos exatos em `bigint` — precisão ilimitada, a soma
  nunca perde dígito nem estoura;
- **saída:** `subtotalConhecido` é **string decimal com duas casas**
  (`"60.06"`, `"0.00"`, `"99999999999999.00"`), formatada só na fronteira e
  levada assim até a apresentação. Não é `number` porque a soma de vários
  valores perto do limite de `NUMERIC(14,2)` passa de 15 dígitos
  significativos, onde o `double` já não representa o decimal exato;
- **entrada:** o `total` de cada envelope individual continua `number`
  (como no contrato desde a D12). A conversão para centavos é pela
  representação decimal (`String(valor)` + parser estrito), nunca por
  `valor * 100`: um `NUMERIC(14,2)` tem no máximo 14 dígitos significativos,
  e o IEEE 754 garante que `String(Number(s))` devolve o mesmo decimal de
  `s` até 15 dígitos — logo a conversão é exata. (Uma primeira versão desta
  correção usava `valor * 100` com tolerância; um fuzz de 2 milhões de
  valores mostrou que ela rejeitava ~10% dos valores válidos acima de
  ~10¹⁰ — descartada antes da entrega. O fuzz ficou como teste.)

Falha explícita, nunca arredondamento silencioso: valor não finito, notação
exponencial, mais de duas casas decimais, texto malformado ou mais de 12
dígitos inteiros (fora de `NUMERIC(14,2)`) lançam erro. Não há conversão de
moeda nem soma entre moedas ou entre lados.


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
contêineres do processo e devolve um `AgregadoFinanceiroLado` para o
cliente e outro para a Rocket (forma e regras na seção 0, achados #2 e #3).

Regras garantidas pela função (testes em `prazoFreeTimeV12.test.ts`):

- nunca soma moedas diferentes (`CONFIRMADO`/`ESTIMADO`/
  `ESTIMADO_PROVISORIO` só entram no grupo da própria moeda);
- nunca cruza cliente × Rocket (dois agregados independentes);
- `PENDENTE`/`INDISPONIVEL` nunca viram zero nem grupo de moeda: são
  contados no lado e o tornam incompleto (`completo: false`);
- `NAO_APLICAVEL` (sem demurrage) é contado em `semAplicacao` e **não**
  torna o lado incompleto — "sem demurrage" é resposta definitiva, "sem
  informação" não;
- `subtotalConhecido` é exato (string decimal) e nunca é apresentado como
  total definitivo quando o lado está incompleto — `completo: false` no lado
  é o sinal autoritativo.

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
- `hoje > ultimoDiaLivre` (comparação de data civil, autoritativa — v1.2.1,
  achado #1) → `vencido: true`, `diasRestantes: null` (nunca um negativo),
  `dentroDoFreeTime: false`, `emPrazoProximo: false`, `proximoMarco: null`,
  esteja o cache `relogios` já recalculado ou não;
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
- **Janela de cache desatualizado (virada da data → tick diário).** Entre a
  virada da data civil e o momento em que `passagemDoCalendario` recalcula
  o relógio, o cache `relogios` ainda tem o `diasDemurrage` da véspera.
  Desde a v1.2.1 o **contrato de leitura** já trata essa janela corretamente
  pela data civil (relógio vencido, sem dias negativos, fora do próximo
  vencimento — seção 0, achado #1). O que permanece por desenho: o **estado
  e a severidade** do contêiner (ex.: `EM_DEMURRAGE_ATENCAO`, dias de
  demurrage, balde) vêm das funções congeladas da Fase 7 sobre o cache e só
  mudam depois do tick — a leitura não pode recalcular o relógio nem
  fabricar `diasDemurrage`. Nessa janela o estado nunca é `PRAZO_PROXIMO`
  para o relógio já vencido (pode continuar, por exemplo,
  `MONITORAMENTO_SILENCIOSO` até o tick). Se for desejável que o estado do
  lifecycle sinalize a janela por si só, isso exige decisão de produto e
  alteração de regra congelada da Fase 7 — fora do escopo desta corretiva;
  fica registrado para decisão.

## 8. Testes (`__tests__/prazoFreeTimeV12.test.ts` + `__tests__/leituraD12V12.test.ts`)

### Puros (sem banco) — `prazoFreeTimeV12.test.ts`, 46 testes (25 → 46 na v1.2.1)

| Ponto | Testes |
|---|---|
| DV-05 bordas (11) | limiar padrão 4; faltam 5 dias (fora do limiar); faltam exatamente 4 (limiar inclusivo); falta 1; no próprio último dia livre (`diasRestantes=0`); primeiro dia de demurrage com cache já recalculado; Free Time zero (chega a vencido, não a pendente); relógio `PENDING`; House ≠ Master; limiar `null`; funções de base |
| **v1.2.1 #1** — cache desatualizado (7) | cache `diasDemurrage=0` e hoje 1 dia após o LFD → vencido, nunca `-1`; cache `0` e hoje vários dias após o LFD → vencido, nunca `-7`; cache `≥1` e hoje após o LFD → vencido; exatamente no LFD → dentro, `0`; antes do LFD → dentro, positivo; relógio pendente continua pendente; o próximo vencimento do processo nunca escolhe um prazo passado |
| DV-05 próximo vencimento (3) | menor `diasRestantes`; lista vazia → `null`; desempate data/contêiner/cliente-antes-de-rocket |
| **v1.2.1 #3** — soma exata (9) | `0.10 + 0.20 = "0.30"`; `10.01 + 20.02 + 30.03 = "60.06"` em três ordens (inclusive a ordem em que o ponto flutuante falha); zero confirmado `"0.00"`; limite de `NUMERIC(14,2)` e somas de 100 e 1.000 parcelas no limite (16–18 dígitos) exatas; string do Postgres e `number` equivalente dão os mesmos centavos; fuzz de 200.000 valores `NUMERIC(14,2)` aleatórios (string → `Number` → centavos → string) idênticos; não finito, mais de duas casas, exponencial, texto malformado e acima de `NUMERIC(14,2)` lançam erro |
| DV-01 agregação (16) | um confirmado; mesma moeda; moedas diferentes; confirmado+estimado; **v1.2.1 #2:** confirmado+indisponível (lado incompleto, grupo de moeda intacto); confirmado+pendente; confirmado+sem aplicação (completo); todos indisponíveis; todos pendentes; todos sem aplicação (completo); zero confirmado; múltiplas moedas no mesmo lado (exatas); cliente completo × Rocket incompleto e o inverso; cliente×Rocket nunca se cruzam; estimado nunca confirmado; estimativa provisória em categoria própria |

### Integração (PostgreSQL real, pipeline oficial) — `leituraD12V12.test.ts`, 14 testes (11 → 14 na v1.2.1)

| Ponto | Testes |
|---|---|
| DV-04 | persistido SILENCIOSO → hoje PRAZO_PROXIMO: fila, detalhe de processo, detalhe de contêiner e `/filtros` concordam, coluna persistida intocada · persistido PRAZO_PROXIMO → leitura num `hoje` anterior volta a SILENCIOSO |
| DV-03 | líder = contêiner mais prioritário, igual na fila e no detalhe · empate resolvido pelo desempate congelado #1 · líder muda só pela passagem da data, fingerprint do schema inteiro idêntico · líder nunca de outro processo/organização · `promocaoTopo=true` igual na fila, no detalhe e no líder |
| DV-01 | Termo por Embarque: subtotal = soma exata dos envelopes, lado completo, fila = detalhe · Termo Único · contêiner `INDISPONIVEL`: nenhum grupo de moeda, lado Rocket incompleto |
| DV-05 | próximo vencimento certo, muda com a data, fila = detalhe |
| **v1.2.1 #1** | relógio com cache de 2026-11-05 lido em 2026-11-15 (5 dias após o LFD, sem recálculo): bloco vencido, `diasRestantes=null`, sem marco; detalhe de contêiner = detalhe de processo; estado nunca `PRAZO_PROXIMO`; `proximoVencimento` aponta o outro contêiner (nunca o prazo passado), fila = detalhe; **fingerprint de todas as tabelas idêntico** (zero escrita); depois do tick diário `passagemDoCalendario`: cache com 5 dias, estado `EM_DEMURRAGE_ATENCAO`, líder e próximo vencimento convergentes |
| **v1.2.1 #2** | um contêiner com valor + um pendente no mesmo lado: um grupo de moeda íntegro, `pendentes=1`, lado `completo=false`; fila = detalhe (`deepEqual`) |
| **v1.2.1 #3** | três contêineres reais (motor Termo por Embarque) com `NUMERIC(14,2)` 20.02, 30.03 e 10.01, nessa ordem de exibição (a ordem em que a soma ingênua dá `60.059999999999995`): `subtotalConhecido = "60.06"`; fila = detalhe |

**Prova de que os testes pegam os defeitos (mutação).** Reintroduzi
temporariamente cada defeito e rodei os testes: (a) `blocoPrazoRelogio`
voltando a checar `diasDemurrage` antes da data → 3 testes puros e o teste
de integração #1 falham; (b) soma voltando a ponto flutuante → o teste de
integração #3 falha. Os arquivos originais foram restaurados em seguida.

## 9. Validação completa

> **v1.2.1:** corrida final da v1.2.1 em andamento — os números desta seção
> ainda são os da v1.2 e serão substituídos no commit seguinte.

| Suíte | Resultado |
|---|---|
| Engine completa (`npm run test:demurrage-engine`, inclui D10, D11, D12 completa — G1–G7, v1.1, v1.2 —, lifecycle/prioridade, relógios, tarifas/apuração, rotas V2, os novos `prazoFreeTimeV12.test.ts` e `leituraD12V12.test.ts`) | **662/662** (626 da base v1.1 + 25 de `prazoFreeTimeV12.test.ts`¹ + 11 de `leituraD12V12.test.ts`) |
| V1 (`npm test`) | 25/25 |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

¹ A primeira corrida da engine completa foi feita duas vezes em paralelo com
o benchmark de queries (abaixo) e mostrou 29–33 falhas transitórias — todas
em arquivos sem relação com esta entrega (ex.: `vesselSharing.test.ts`,
erro genérico de pool do `pg`), reproduzidas só sob disputa de conexões
Postgres entre a suíte e o benchmark correndo ao mesmo tempo. Uma corrida
**isolada** (nada mais acessando o banco), registrada no log completo de
4.042 linhas sem nenhuma ocorrência de `not ok`, deu **662/662** — o número
reportado acima. Nenhum teste foi pulado para obter este resultado.

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
