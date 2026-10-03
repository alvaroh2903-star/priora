# Fase D12 v1.2 (+ v1.2.1, v1.2.2 e v1.2.3 corretivas) — correção do contrato operacional (NÃO aprovada, NÃO congelada)

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

> **v1.2.2 (corretiva, sobre `73dc31f`):** corrige a última inconsistência
> operacional — o estado do lifecycle continuava preso ao cache do relógio
> entre a virada da data e o tick diário, e o processo podia sumir da fila
> padrão justamente no dia em que a demurrage começa. Correção da derivação
> pura da Fase 7 **explicitamente autorizada** e restrita; seção 00 abaixo.
> As seções 7, 8 e 9 foram atualizadas.

> **v1.2.3 (corretiva):** a auditoria final da v1.2.2 encontrou um achado
> bloqueante remanescente — o frescor do valor financeiro era decidido
> comparando os dias operacionais com o CACHE do relógio
> (`diasOperacionais > clock.diasDemurrage`), que só detecta a janela entre
> a virada da data e o tick diário. Um valor apurado para menos dias do que
> os operacionais de hoje podia continuar sendo exibido como atual sempre
> que o relógio já tivesse sido projetado mas o recálculo financeiro tivesse
> falhado ou ainda estivesse na fila — o relógio em dia escondia o valor
> desatualizado. Corrigido na seção 000 abaixo: o frescor passa a ser
> decidido pelos `dias_cobrados` da PRÓPRIA linha de `valores_apurados`
> escolhida, nunca pelo cache do relógio. As seções 8, 9 e 10 foram
> atualizadas.

## 000. v1.2.3 — frescor do valor financeiro pelos dias cobrados da própria linha

### Problema

O envelope financeiro decidia frescor comparando os dias operacionais de
hoje com o CACHE do relógio:

```
diasOperacionais > clock.diasDemurrage
```

Essa comparação só detecta a janela entre a virada da data e o tick diário
(achado que a v1.2.2 já cobria para o estado do lifecycle). Ela NÃO detecta
um valor desatualizado depois que o relógio já foi projetado — exatamente o
caso em que a projeção do relógio tem sucesso, mas o recálculo financeiro
falha ou fica na fila:

```
dias guardados no relógio (cache)  = 5
dias cobrados pelo valor ativo     = 4
dias operacionais de hoje          = 5
```

`5 > 5` é falso: o valor de 4 dias passava a ser exibido como se fosse o
valor atual, escondido pelo relógio em dia. Clock válido e valor válido são
duas perguntas diferentes — a v1.2.2 resolveu a primeira (estado do
lifecycle), não a segunda (frescor do valor monetário exibido).

### Correção

`valores_apurados.dias_cobrados` passa a entrar nas quatro leituras batch
que hoje decidem o envelope financeiro — fila, detalhe de processo, detalhe
de contêiner e, por consequência, a agregação financeira do processo — e o
frescor passa a ser decidido contra os dias cobrados da PRÓPRIA linha
escolhida, nunca contra o cache do relógio:

```ts
// leitura/contrato.ts
export interface ValorAtivoSelecionado {
  confirmationStatus: ConfirmationStatusValor;
  total: number | null;
  moeda: string | null;
  /** dias_cobrados da PRÓPRIA linha escolhida (null só em UNAVAILABLE, por schema). */
  diasCobrados: number | null;
}

// dentro de envelopeDeValor, depois do caso UNAVAILABLE:
if (input.valor.diasCobrados === null || dias > input.valor.diasCobrados) {
  return { situacao: 'PENDENTE', total: null, moeda: null };
}
```

Regras, todas confirmadas por teste:

- sem valor escolhido → `PENDENTE`;
- valor conhecido com menos dias cobrados do que os operacionais →
  `PENDENTE`;
- dias cobrados iguais aos operacionais → valor exposto normalmente;
- dias cobrados MAIORES do que os operacionais → exposto como está, nunca
  reduzido nem reescrito (invariante coberta por teste próprio);
- `UNAVAILABLE` continua `INDISPONIVEL` — sem `dias_cobrados` por schema,
  nunca comparado, nunca zero;
- `NAO_APLICAVEL` continua decidido pelos dias operacionais zero (regra da
  v1.2.2, inalterada);
- zero confirmado que cobre os dias atuais continua zero (nunca é tratado
  como "sem valor");
- cliente e Rocket continuam separados — cada um com seu relógio e seu
  valor escolhido;
- cada motor comercial do cliente concorre só com sua própria linha ativa
  (`motorClienteAplicavelDe`, inalterado da v1.1);
- nenhum valor é recalculado nem persistido pela leitura (GET).

O parâmetro `valorDefasado` (comparação pelo cache, da v1.2.2) foi
removido — a validade do relógio (`cache: VALIDO/OBSOLETO`) e a validade do
valor são questões independentes, e só a segunda decide o envelope.

### Helper único (fila = detalhe de processo = detalhe de contêiner)

`envelopeDoRelogio` (novo, `contrato.ts`) substitui a lógica que a fila e o
detalhe implementavam cada um à sua maneira:

```ts
export function envelopeDoRelogio(
  clock: ClockFact, hoje: CivilDate, emptyReturn: boolean, valor: ValorAtivoSelecionado | null,
): ValorEnvelope {
  return envelopeDeValor({
    relogioStatus: clock.status,
    diasDemurrage: clock.status === 'OK' ? diasDemurrageOperacionais(clock, hoje, emptyReturn) : null,
    valor,
  });
}
```

`filaOperacional.ts` e `detalhe.ts` chamam exatamente esta função — a fila
não tem mais sua própria cópia de `envelope(...)` com a comparação pelo
cache, e `construirRelogio` (detalhe) não monta mais o `valorDefasado` à
mão. Como a agregação financeira (`agregarFinanceiroProcesso`) consome os
mesmos `ValorEnvelope` já traduzidos, a correção se propaga automaticamente
para `agregadoFinanceiro` sem tocar `moedaExata.ts` nem a função de soma.

### Nota: divergência cliente×Rocket de frescor não é alcançável pelo pipeline real hoje

O teste puro #10 cobre o caso em que cliente e Rocket têm frescor
DIFERENTE (um atual, outro `PENDENTE`) — a função `envelopeDoRelogio` é
chamada uma vez por lado, com o relógio e o valor daquele lado, então nada
na assinatura impede essa divergência. Na integração real, porém, os dois
lados de um mesmo contêiner são recalculados na MESMA transação
(`recalcularApuracaoContainer`) com a MESMA `data_final_apuracao`: uma
falha no worker de recálculo afeta a apuração do contêiner inteiro, não um
lado isolado, então os dois lados ficam com `dias_cobrados` desatualizados
juntos (ou nenhum). Por isso o teste de integração que demonstra "cliente e
Rocket com situações diferentes" (seção de testes abaixo) usa a divergência
que o pipeline real produz hoje — relógios com LFDs diferentes colocando um
lado em `PENDENTE` e o outro em `NAO_APLICAVEL` (ainda dentro do Free Time)
— em vez de dois lados "conhecidos" com frescor diferente, que exigiria uma
falha seletiva por lado que o orquestrador atual não produz. A regra em si
não depende disso: se um dia existir um caminho que recalcule os lados
separadamente, `envelopeDoRelogio` já trata cada lado de forma
independente, sem qualquer mudança de código.

### Correção de um texto desatualizado (seção 00)

A seção 00 descrevia o comportamento da janela de valor financeiro citando
o parâmetro `valorDefasado` de `envelopeDeValor`, removido nesta correção.
O texto abaixo já reflete a regra atual (dias cobrados da linha escolhida).

## 00. v1.2.2 — estado operacional vivo depois do fim do Free Time

### Problema

Entre a meia-noite e o recálculo diário (`passagemDoCalendario`), o relógio
guardado ainda tem `diasDemurrage = 0`. A v1.2.1 já fazia o bloco de prazo
dizer "vencido" pela data civil, mas o estado do contêiner, a prioridade, os
badges e o status de apuração do lifecycle continuavam lendo o cache: o
contêiner seguia `MONITORAMENTO_SILENCIOSO`, balde `SILENCIOSO`, e o processo
saía da fila operacional padrão exatamente no primeiro dia de demurrage.

### Regra única (`lifecycle/prazoFreeTime.ts`)

```ts
diasDemurrageOperacionais(clock, hoje, emptyReturn) =
  max(clock.diasDemurrage, max(0, hoje − clock.ultimoDiaLivre))
```

- Semântica de dia civil igual à do motor temporal (`finalDate − LFD`): no
  último dia livre 0; no dia seguinte 1; sétimo dia após 7; décimo quinto 15.
- Só extrapola relógio `OK` com `ultimoDiaLivre`. `PENDING`/`INVALID` nunca
  são extrapolados.
- Com Empty Return, vale o cache, apurado com a data efetiva de devolução —
  nunca se acumula depois dela; devolvido dentro do Free Time fica em zero
  para sempre.
- `max`: o cache nunca é reduzido (caso de cache à frente da data civil).
- Nada é gravado nem recalculado; nenhum valor monetário nasce da regra.
- Cliente só com o relógio House, Rocket só com o Master — a função recebe
  UM relógio de cada vez; os dois continuam separados.

`relogioOperacional(clock, hoje, emptyReturn)` devolve o mesmo `ClockFact`
com os dias operacionais. `menorDiasAteVencimentoOperacional` e
`blocoPrazoRelogio` também passaram a usá-la.

### Quem consome a regra (a mesma, não uma exceção da D12)

| Consumidor | Arquivo | O que passa a usar dias operacionais |
|---|---|---|
| Estado do contêiner | `containerState.derivarEstadoContainer` | `clienteEmDemurrage`, `rocketExposta`, severidade, `EM_DEMURRAGE_ATENCAO`/`CRITICO`, escalada 15+, badges, `PRAZO_PROXIMO` |
| Status de apuração do lifecycle | `containerState.derivarApuracaoDemurrageStatusOperacional` (usado por `LifecycleRepository`) | relógio válido com dias ≥ 1 → `DEMURRAGE_CONFIRMADA`; nunca `ZERO_CONFIRMADO` para ativo além do LFD; relógio faltante segue a regra de pendência existente |
| Prioridade | `priorityEngine` | balde (via severidade), desempate #1 (via severidade), desempate #5 (vencimento futuro pela mesma regra) |
| Consolidação e líder | `consolidarProcesso` (inalterado) | recebe os pacotes já corrigidos |
| Fato de cadência do lifecycle | `LifecycleRepository` (`algumEmDemurrage`) | mesma semântica que o scheduler já usava (`schedulerWorker`: `hoje > menor LFD`); a política de cadência não mudou |
| Leitura D12 | `blocoPrazoRelogio`, envelopes da fila e do detalhe | bloco de prazo, `diasOperacionais`, `PENDENTE` quando o valor guardado é de menos dias |

O `LifecycleRepository` continua guardando em `facts` os relógios do CACHE;
as engines aplicam a regra sobre eles (o pipeline persiste, nos dias em que
o tick roda, exatamente o mesmo resultado que a leitura já mostrava).

### Responsabilidade

Nenhuma decisão é criada ou confirmada. Com `DEMURRAGE_CONFIRMADA`, a
derivação existente (`derivarResponsabilidade`) passa a `EM_ANALISE` quando
não há decisão gravada — como já acontecia depois do tick. Nenhuma
responsabilidade Rocket é inferida.

### Valor financeiro na janela

O valor ativo de `valores_apurados` foi apurado para um número de dias
próprio (`dias_cobrados`). Quando os dias operacionais de hoje são maiores
do que os dias cobrados pelo valor ativo, o envelope sai `PENDENTE` — nunca
`NAO_APLICAVEL` ("sem demurrage"), nunca um valor fabricado. O agregado do
lado fica `completo: false` até o recálculo legítimo do pipeline. **Nota
v1.2.3:** esta comparação era originalmente feita contra o CACHE do
relógio (`diasOperacionais > clock.diasDemurrage`), o que só cobria a
janela desta seção (virada da data → tick diário). A correção da v1.2.3
(seção 000) trocou a comparação pelos `dias_cobrados` da própria linha de
valor escolhida, cobrindo também o caso em que o relógio já está em dia
mas o recálculo financeiro falhou ou está na fila — ambas as janelas usam
hoje a mesma regra, sem duplicação.

### Contrato de leitura (aditivo)

- `RelogioLeitura.diasOperacionais` — dias que decidem estado/prioridade/prazo;
  `dias` continua sendo o do relógio guardado.
- `PrazoRelogioLeitura.encerradoPorDevolucao` — relógio parado pela
  devolução: sem prazo futuro, sem marco; `vencido` só se houve demurrage
  até a devolução. Isto também corrige um efeito colateral da v1.2.1: um
  contêiner devolvido dentro do Free Time, lido depois do LFD, aparecia
  "vencido" no bloco de prazo.

### Ajustes em testes existentes (transparência)

- `lifecycle.test.ts`: 26 relógios de fixtures puras tinham o cache **um dia
  atrás** do próprio `hoje` da fixture (ex.: `hoje = 2026-09-13`, LFD
  `09-09`, cache 3 dias; pela semântica do motor temporal seriam 4). Com a
  regra autorizada, o motor passa a ler 4. Movi o LFD dessas fixtures para o
  dia em que o cache está exatamente atual (`09-10`); **nenhuma expectativa
  foi alterada**.
- `leituraFiltros.test.ts`: o teste semeava dados em `2026-09-20` mas
  chamava `buscarOpcoesFiltros` sem `hoje`, lendo na data real do relógio da
  máquina. Só passava porque o cache congelava a severidade; agora recebe o
  `hoje` do próprio teste.
- `leituraD12V12.test.ts`, "DV-03: o líder muda com a passagem da data": a
  versão anterior só funcionava porque o contêiner vencido SAÍA da disputa —
  o próprio defeito desta correção. Reescrita com uma troca legítima:
  contêiner com Free Time faltante (pendência) lidera enquanto o outro está
  silencioso; quando o LFD do outro passa, ele entra em demurrage e assume a
  liderança, sem nenhuma gravação.
- O teste de integração da janela (v1.2.1 #1) passou a exigir o estado
  correto antes do tick (`EM_DEMURRAGE_ATENCAO`, `dias = 0`,
  `diasOperacionais = 5`).

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
- com Empty Return (v1.2.2) → `encerradoPorDevolucao: true`, sem prazo nem
  marco; `vencido` só se houve demurrage até a devolução;
- dias operacionais ≥ 1 (v1.2.2; a v1.2.1 já fazia a data civil prevalecer)
  → `vencido: true`, `diasRestantes: null` (nunca um negativo),
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
- **Janela de cache desatualizado (virada da data → tick diário).**
  Resolvida na v1.2.2 (seção 00): estado, prioridade, badges, apuração do
  lifecycle e leitura usam os mesmos dias operacionais; o tick só atualiza
  o relógio guardado, a validade do cache (`OBSOLETO` → `VALIDO`) e o valor
  financeiro. Fora desta regra continuam, por desenho: o valor monetário
  (só o pipeline apura) e o fechamento (`closingService`, que lê relógios
  guardados de contêineres devolvidos — nos quais a regra não extrapola).

## 8. Testes (`__tests__/prazoFreeTimeV12.test.ts` + `__tests__/leituraD12V12.test.ts` + `__tests__/frescorValorV123.test.ts`)

### Puros (sem banco) — `prazoFreeTimeV12.test.ts`, 46 testes (25 → 46 na v1.2.1)

| Ponto | Testes |
|---|---|
| DV-05 bordas (11) | limiar padrão 4; faltam 5 dias (fora do limiar); faltam exatamente 4 (limiar inclusivo); falta 1; no próprio último dia livre (`diasRestantes=0`); primeiro dia de demurrage com cache já recalculado; Free Time zero (chega a vencido, não a pendente); relógio `PENDING`; House ≠ Master; limiar `null`; funções de base |
| **v1.2.1 #1** — cache desatualizado (7) | cache `diasDemurrage=0` e hoje 1 dia após o LFD → vencido, nunca `-1`; cache `0` e hoje vários dias após o LFD → vencido, nunca `-7`; cache `≥1` e hoje após o LFD → vencido; exatamente no LFD → dentro, `0`; antes do LFD → dentro, positivo; relógio pendente continua pendente; o próximo vencimento do processo nunca escolhe um prazo passado |
| DV-05 próximo vencimento (3) | menor `diasRestantes`; lista vazia → `null`; desempate data/contêiner/cliente-antes-de-rocket |
| **v1.2.1 #3** — soma exata (9) | `0.10 + 0.20 = "0.30"`; `10.01 + 20.02 + 30.03 = "60.06"` em três ordens (inclusive a ordem em que o ponto flutuante falha); zero confirmado `"0.00"`; limite de `NUMERIC(14,2)` e somas de 100 e 1.000 parcelas no limite (16–18 dígitos) exatas; string do Postgres e `number` equivalente dão os mesmos centavos; fuzz de 200.000 valores `NUMERIC(14,2)` aleatórios (string → `Number` → centavos → string) idênticos; não finito, mais de duas casas, exponencial, texto malformado e acima de `NUMERIC(14,2)` lançam erro |
| DV-01 agregação (16) | um confirmado; mesma moeda; moedas diferentes; confirmado+estimado; **v1.2.1 #2:** confirmado+indisponível (lado incompleto, grupo de moeda intacto); confirmado+pendente; confirmado+sem aplicação (completo); todos indisponíveis; todos pendentes; todos sem aplicação (completo); zero confirmado; múltiplas moedas no mesmo lado (exatas); cliente completo × Rocket incompleto e o inverso; cliente×Rocket nunca se cruzam; estimado nunca confirmado; estimativa provisória em categoria própria |

### Puros (sem banco) — `estadoOperacionalV122.test.ts`, 20 testes (novo na v1.2.2)

| Ponto | Testes |
|---|---|
| Regra (4) | LFD → 0, LFD+1 → 1, LFD+7 → 7, LFD+15 → 15, antes do LFD → 0; `PENDING`/`INVALID` nunca extrapolados; `OK` sem LFD nunca extrapolado; função pura (entrada intacta) |
| Casos 1–11 (11) | 1 no LFD: zero, `PRAZO_PROXIMO`, apuração `ZERO_CONFIRMADO`; 2 LFD+1 com cache 0: `EM_DEMURRAGE_ATENCAO`, `ATENCAO_1_6`, bloco vencido; 3 LFD+6: atenção; 4 LFD+7: crítico, `CRITICA_7_14`; 5 LFD+15: crítico, escalada, `CRITICA_15`; 6 só cliente vencido: só o badge do cliente; 7 só Rocket vencido: só o badge Rocket; 8 um pendente + outro vencido: demurrage + `pendenciaDadosCliente`, `DEMURRAGE_CONFIRMADA`; 9 Empty Return dentro do Free Time lido meses depois: zero, `CONCLUIDO_PARA_ROCKET`, bloco encerrado e não vencido; 10 Empty Return depois do LFD: preserva 4 dias, nunca acumula, `DEVOLVIDO_AGUARDANDO_TRATAMENTO`; 11 cache maior que a extrapolação: nunca reduz |
| Caso 12 puro (1) | em LFD+1, +7 e +15: estado, prioridade, apuração e bloco de prazo idênticos com cache 0 e com cache atualizado |
| Apuração, responsabilidade, prioridade, envelope (4) | ativo além do LFD nunca `ZERO_CONFIRMADO`; responsabilidade `EM_ANALISE`, nunca decisão nem Rocket automática; recém-vencido passa à frente do ainda livre; valor de menos dias → `PENDENTE`, valor atual segue normal |

### Puros (sem banco) — `frescorValorV123.test.ts`, 14 testes (novo na v1.2.3)

| Ponto | Testes |
|---|---|
| Casos 1–10 do pedido (10) | 1 operacional 5/relógio 5/valor 4 → `PENDENTE`; 2 operacional 5/relógio 5/valor 5 → valor normal; 3 operacional 5/relógio 4/valor 4 → `PENDENTE`; 4 operacional 5/relógio 4/valor 5 → valor normal (a validade do relógio não decide o frescor do valor); 5 operacional 0 → `NAO_APLICAVEL` mesmo com valor guardado; 6 sem valor escolhido → `PENDENTE`; 7 `UNAVAILABLE` com dias cobrados nulos → `INDISPONIVEL`, nunca zero, nunca pendente, mesmo com dias operacionais avançando; 8 zero confirmado que cobre os dias atuais → `CONFIRMADO` zero, se não cobre → `PENDENTE`; 9 `ESTIMATED`/`ESTIMATED_PROVISIONAL`/`CONFIRMED` seguem a mesma regra de frescor; 10 cliente e Rocket com frescor diferente — cada lado com seu relógio e seu valor, agregado reflete a diferença |
| Invariante e defensivo (2) | valor que cobre MAIS dias do que os operacionais é exibido como está, nunca reduzido nem reescrito; valor conhecido sem `diasCobrados` (o schema proíbe) → `PENDENTE`, nunca exibido como atual |
| Empty Return e seleção (2) | o valor apurado até a devolução continua atual por mais tarde que seja hoje; `selecionarValorAtivo` carrega os dias cobrados da PRÓPRIA linha escolhida, por motor comercial aplicável e por lado (inclusive `UNAVAILABLE` com `diasCobrados: null`) |

### Integração (PostgreSQL real, pipeline oficial) — `leituraD12V12.test.ts`, 18 testes (11 → 14 na v1.2.1 → 16 na v1.2.2 → 18 na v1.2.3)

| Ponto | Testes |
|---|---|
| **v1.2.2 janela** | processo persistido `MONITORAMENTO_SILENCIOSO`/`SILENCIOSO`; leitura em LFD+1 sem tick: a **fila padrão** já inclui o processo, `EM_DEMURRAGE_ATENCAO`, `ATENCAO_1_6`, líder = o contêiner vencido (fila e detalhe), `/filtros` conta o mesmo estado/balde, bloco vencido com `dias = 0`, `diasOperacionais = 1`, cache `OBSOLETO`, valor `PENDENTE`, lado cliente incompleto, fila = detalhe no agregado, responsabilidade `EM_ANALISE` sem decisão, próximo vencimento = o outro contêiner; **fingerprint de todas as tabelas idêntico**. Depois de `passagemDoCalendario`: estado persistido igual ao que a leitura já mostrava; estado, prioridade, líder, badges, contagens, próximo vencimento e interpretação de prazo idênticos; só `dias` (0 → 1), `cache` (`OBSOLETO` → `VALIDO`) e o valor (`PENDENTE` → `ESTIMADO`, por recálculo legítimo) mudam |
| **v1.2.2 Empty Return** | devolvido dentro do Free Time, lido 40 dias depois do LFD: `CONCLUIDO_PARA_ROCKET`, cliente e Rocket com 0 dias e 0 dias operacionais, não vencidos, encerrados, sem marco; sem próximo vencimento; fora da fila padrão; zero escrita |
| **v1.2.3 relógio em dia, valor desatualizado** | relógio projetado a 5 dias, valor ativo do cliente apurado para só 4 (o Rocket fica `NAO_APLICAVEL` neste cenário — Master dentro do Free Time o tempo todo, deliberadamente fora do caminho exercido): fila, detalhe de processo e detalhe de contêiner concordam em `PENDENTE` para o cliente; `cache: VALIDO` no relógio (a validade do relógio não decide o frescor do valor); agregado do lado cliente incompleto, lado Rocket completo (`NAO_APLICAVEL` nunca bloqueia); falha técnica (`recalculo_reprocessavel`) visível nos indicadores existentes, tanto na fila quanto no detalhe; **fingerprint de todas as tabelas idêntico** (zero escrita) durante toda a janela `PENDENTE`. Depois do recálculo legítimo (mesmo worker, orquestrador real): cliente `ESTIMADO` com o total correto (5 dias × diária), agregado cliente completo, indicador de falha técnica some, fila = detalhe em todos os pontos |
| **v1.2.3 cliente × Rocket independentes** | House LFD alcançado (cliente 4 dias cobrados, hoje 5 → `PENDENTE`), Master ainda dentro do Free Time (Rocket `NAO_APLICAVEL`): fila, detalhe de processo e detalhe de contêiner concordam nos dois lados; agregado cliente incompleto, agregado Rocket completo (lados independentes — a pendência de um nunca contamina o outro); zero escrita; depois do recálculo legítimo, cliente passa a `ESTIMADO` e o Rocket continua `NAO_APLICAVEL`, sem qualquer relação entre os dois recálculos |

**Mutação (v1.2.2).** Com a regra operacional desligada (devolvendo só o
cache), 12 dos 20 testes puros e 3 testes de integração falham; o arquivo
original foi restaurado.

**Mutação (v1.2.3).** Desativei temporariamente a comparação por
`dias_cobrados` em `envelopeDeValor` (mantendo só o caso `UNAVAILABLE`) —
5 dos 14 testes puros de `frescorValorV123.test.ts` (casos 1, 3, 8, 9 e 10
do pedido) e os dois testes de integração novos falham, exatamente o
cenário "relógio em dia, valor de menos dias" que a correção resolve. O
arquivo original foi restaurado em seguida e as duas suítes voltaram a
32/32.

### Integração anterior — detalhamento (v1.2/v1.2.1)

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

## 9. Validação completa (v1.2.3)

Todas as corridas **isoladas** (nada mais acessando o PostgreSQL ao mesmo
tempo), na ordem: testes novos, grupos, engine completa, V1, `tsc`, build,
benchmark.

| Suíte | Resultado |
|---|---|
| Testes puros novos da v1.2.3 (`frescorValorV123`) | 14/14 |
| Integração D12 novos da v1.2.3 (dentro de `leituraD12V12`) | 2/2 |
| Integração D12 completa (`leituraD12V12`, v1.2 → v1.2.3) | 18/18 |
| Lifecycle e prioridade (`lifecycle`, `estadoOperacionalV122`) | 49/49 |
| Relógios (`relogios`, `dualClockCalculator`, `freeTimeClock`, `civilDate`) | 66/66 |
| D10 (`registroDemurrage`, v1.1, v1.2) | 69/69 |
| D11 (`responsabilidadeDecisao`, v1.1, v1.2, auditoria) | 59/59 |
| D12 completa (`leitura*`, `demurrageV2Routes`, `prazoFreeTimeV12`) | 121/121 (119 na v1.2.2 + 2 testes de integração novos) |
| Rotas V2 (`demurrageV2Routes`, `leituraAutorizacao`) | 17/17 |
| Tarifas e apuração (`tariffs`, `apuracao` v1–v1.4, `closing`, `demurrageTickFilas`) | 105/105 — **motores tarifários intocados** |
| **Engine completa** (`npm run test:demurrage-engine`) | **724/724** (708 da v1.2.2 + 14 puros + 2 de integração), nenhum `not ok` |
| V1 (`npm test`) | 25/25 |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

Zero falhas e **zero testes ignorados** em todas as linhas. Todos os
grupos fora do escopo direto da v1.2.3 (lifecycle/prioridade, relógios,
D10, D11, tarifas/apuração, rotas V2) mantêm exatamente a mesma contagem
da v1.2.2 — nenhum efeito colateral fora de `contrato.ts`,
`filaOperacional.ts`, `detalhe.ts` e os dois arquivos de teste.

**Mutação, prova de que os testes pegam o defeito original.** Ver seção 8
— desativar a comparação por `dias_cobrados` (voltando ao comportamento
anterior à v1.2.3) derruba 5 dos 14 testes puros novos e os 2 testes de
integração novos; arquivo original restaurado e as duas suítes
confirmadas em 32/32 depois.

**Zero escrita em todos os GETs.** O G7 de `demurrageV2Routes` (fingerprint
de todas as tabelas em torno de todas as rotas) segue verde; os dois testes
de integração novos da v1.2.3 tiram o fingerprint do schema inteiro em
torno de toda a janela `PENDENTE` (antes do recálculo legítimo) — igual ao
padrão já usado pelas janelas da v1.2.1/v1.2.2.

**Fila × detalhe de processo × detalhe de contêiner × agregado.** Nos dois
testes de integração novos, os três endpoints de leitura e o agregado
financeiro do processo concordam byte a byte (`deepEqual`) tanto na janela
`PENDENTE` (valor desatualizado, falha técnica visível) quanto depois do
recálculo legítimo (`ESTIMADO`) — cliente e Rocket conferidos
separadamente nos dois momentos.

### Benchmarks de custo constante (banco descartável, fixtures por SQL direto, rodados após as suítes)

| Endpoint | Volume | Queries | Tempo |
|---|---|---|---|
| Fila (página de 50) | 1 processo | 13 | 15 ms |
| | 300 processos | 13 | 68 ms |
| | 1.000 processos | 13 | 79 ms |
| | 2.000 processos | 13 | 145 ms |
| Detalhe de processo | 1 contêiner | 21 | 16 ms |
| | 10 contêineres | 21 | 15 ms |
| | 100 contêineres | 21 | 28 ms |
| | 500 contêineres | 21 | 83 ms |

**Mesmo número de consultas da v1.2/v1.2.1/v1.2.2** (13 na fila, 21 no
detalhe, constante em todos os volumes): a leitura de `dias_cobrados`
entrou como coluna adicional nas MESMAS consultas batch já existentes
(`va.dias_cobrados` no `SELECT`), nenhuma consulta nova por contêiner ou
por página. Os tempos são de uma única execução, só como observação.

Mesmo número de consultas da v1.2 e da v1.2.1: a regra operacional é pura,
nenhuma consulta nova. Os tempos são de uma única execução, só como
observação (nesta rodada, 1,5× os da v1.2.1 nos volumes maiores; com a
mesma contagem de consultas, isso é variação de execução do contêiner, não
custo novo — a regra acrescenta só aritmética de datas por relógio).

## 10. Limites respeitados

Não implementei a D13, não criei UI, não avancei para D14, não alterei
D10/D11, não alterei rotas V1, não integrei Supabase/Liberação/
HeadCargo/Portal, não criei ações operacionais, não alterei motores
tarifários, não dupliquei regras temporais (uma única fonte em
`prazoFreeTime.ts`), não houve migration (nenhuma necessidade técnica real
surgiu). Organização sempre da sessão; moedas e relógios nunca misturados;
fila, detalhes e filtros concordam entre si para o mesmo `hoje`.

Na v1.2.1, além disso: nenhuma migration; D10, D11, rotas V1, motores
tarifários, Portal, Supabase, HeadCargo e Liberação intocados (diff restrito
a `prazoFreeTime.ts`, `contrato.ts`, o novo `moedaExata.ts`, os dois arquivos
de teste da v1.2 e este relatório).

Na v1.2.2: nenhuma migration; nenhuma UI; nenhuma escrita em GET; cadência
inalterada (`cadencePolicy.ts` e o scheduler intocados); motores tarifários,
apuração financeira, fechamento, decisões da D11, rotas V1, Portal,
Supabase, HeadCargo e Liberação intocados; nenhuma extensão de demurrage
após Empty Return. Código alterado: `prazoFreeTime.ts`,
`containerState.ts`, `priorityEngine.ts` (correção autorizada da Fase 7),
`lifecycleRepository.ts` (só a montagem de fatos passa a usar a regra),
`contrato.ts`, `filaOperacional.ts`, `detalhe.ts`.

Na v1.2.3: nenhuma migration (`dias_cobrados` já existia desde a Fase 4,
migration 0009 — só passou a ser LIDO pelas quatro leituras batch);
nenhuma UI; nenhuma escrita em GET (as duas escritas do novo teste de
integração são o próprio pipeline oficial —
`recalcularApuracaoContainer`/`processarRecalculosPendentes` — nunca a
leitura); D10, D11, V1, cadência, Portal, Supabase, HeadCargo e Liberação
intocados; **motores tarifários intocados** (`termoPorEmbarqueEngine.ts`,
`termoUnicoEngine.ts`, `exposicaoRocketEngine.ts`, `bracketEngine.ts` sem
diff — confirmado pela suíte de tarifas/apuração em 105/105, idêntica à
v1.2.2); nenhum valor é calculado ou recalculado no caminho de leitura — só
traduzido/escolhido, exatamente como antes. Código alterado: `contrato.ts`
(`ValorAtivoSelecionado.diasCobrados`, regra de frescor em
`envelopeDeValor`, helper novo `envelopeDoRelogio`, remoção do parâmetro
`valorDefasado`), `filaOperacional.ts` e `detalhe.ts` (coluna
`dias_cobrados` nas leituras batch existentes, chamada ao helper único),
mais os arquivos de teste (`frescorValorV123.test.ts`, novo;
`leituraD12V12.test.ts`, `leituraContrato.test.ts` e
`estadoOperacionalV122.test.ts`, ajustados) e este relatório.

**A D12 v1.2/v1.2.1/v1.2.2/v1.2.3 não está aprovada nem congelada, e a D13
não foi iniciada.** Aguardo auditoria.
