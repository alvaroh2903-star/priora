# Fase D14 — Gestão e Indicadores: diagnóstico e plano de implementação (v1.1 CORRETIVO — NÃO aprovado, NÃO implementado)

> **Status:** diagnóstico apenas. Nenhum código foi alterado. D10, D11,
> D12 v1.2.3 (`f7ba55b`) e D13 (`fe37daf`) permanecem congelados/intocados.
> D13 é um protótipo técnico de frontend — prova que os contratos V2
> alimentam uma interface, mas **não** é referência visual para a D14 nem
> para o frontend definitivo. A D14 é **backend-first e independente de
> UI**.
>
> **Esta é a revisão corretiva do diagnóstico `bd721a9`.** O usuário
> aprovou a direção geral, mas apontou 4 problemas de modelagem
> bloqueantes e resolveu 14 decisões de negócio que no documento anterior
> estavam em aberto. Esta versão corrige os 4 bloqueios, aplica as 14
> decisões already aprovadas, acrescenta a exigência de frescor
> operacional do Grupo A, e documenta a investigação conclusiva de código
> para as métricas de tracking (G-E3/G-E9). Nenhuma outra premissa do
> documento anterior foi reaberta sem necessidade.

---

## 0. O que mudou nesta revisão (sumário das 4 correções bloqueantes)

1. **Seleção financeira.** O documento anterior agregava toda linha
   ATIVA de `valores_apurados` e argumentava que o índice único evitava
   duplicata. Isso é insuficiente: o grão do índice é
   `(container_id, relogio_tipo, motor_comercial)` — mais de um motor
   comercial pode ter linha ativa para o MESMO contêiner/lado. A D14
   agora usa, obrigatoriamente, a mesma função de seleção já congelada
   pela D12 (`selecionarValorAtivo`) **antes** de qualquer agregação de
   organização — nunca uma regra nova (§6).
2. **Conclusão "com/sem custo".** Os indicadores ambíguos G-D7/G-D8 foram
   substituídos por 8 indicadores separados e precisos, cada um com
   tratamento explícito de pendente/indisponível (§5, Grupo D).
3. **Independência das dimensões operacionais.** Removida a afirmação de
   que o Grupo A é mutuamente exclusivo como um todo. Cada indicador
   agora carrega a dimensão a que pertence; dimensões diferentes são
   independentes e um processo aparece em vários indicadores ao mesmo
   tempo — nunca somados a 100% (§5, Grupo A; §12-bis metadado de
   contrato).
4. **Snapshot histórico.** Removido da V1. Nenhuma migration `0035`,
   nenhum materializador, nenhum gate de snapshot nesta fase. A V1 cobre
   só indicadores vivos + histórico-por-período reconstruível de fatos já
   fechados + drill-down. O desenho do snapshot fica para uma fase
   controlada futura, com os campos tipados que o usuário exigiu (§9).

Também aplicadas: as 14 decisões de negócio do usuário (§21, agora
"decisões aprovadas", não mais em aberto), a exigência de frescor
operacional do Grupo A (§5-A, §10), e a investigação conclusiva de
`avaliarCadencia`/`schedulerWorker.ts` para G-E3/G-E9 (§4, §5-E).

---

## 1. Propósito e limites

(inalterado do diagnóstico anterior) A D14 constrói a camada de **Gestão
e Indicadores** do Cap. 30 do Blueprint sobre os fatos já persistidos por
D10/D11/D12 v1.2.3. Nenhum dado novo de negócio é inventado. Backend only,
sem escrita de negócio nova, sem integração financeira nova (HeadCargo
continua sem integração — Cap. 27.3, texto fixo "Status financeiro não
disponível"). Sem alteração de D10/D11/D12/D13, rotas V1, Portal,
Supabase, HeadCargo, Auditoria, Courier, Release, cadência de tracking,
motores tarifários, relógios, responsabilidade ou fechamento.

---

## 2. Matriz de rastreabilidade com o Blueprint

(inalterada — ver detalhamento completo nas tabelas do §5; resumo mantido)

| Área | Capítulo | Fato(s) de origem |
|---|---|---|
| Visão operacional | 30.1 | `containers.estado/prioridade_balde`, `processos.estado_mais_relevante/prioridade_balde` (0015) |
| Visão financeira | 30.2, 24, 25 | `valores_apurados` (0009) **após seleção por `selecionarValorAtivo`** (ver §6) |
| Responsabilidade | 30.3, 26 | `responsabilidade_decisoes` + `_dias`/`_periodos` (0031) |
| Eficiência operacional | 30.4 | `containers.discharge_date/effective_return_date`, `processos.fechado_em`, `valores_apurados.dias_cobrados` FINAL, `demurrage_pendencias` |
| Qualidade/tracking | 30.5 | `tracking_fetches`/`tracking_incidents` (0011/0013, globais — ver §4), `cadencePolicy.ts` (ver §4) |
| Moeda | 30.6 | `moedaExata.ts`, `agregarLado` generalizada |

---

## 3. Fatos autoritativos já existentes

(inalterado — ver inventário completo no diagnóstico original; reconfirmado
nesta revisão sem alteração: `valores_apurados`, `responsabilidade_decisoes`,
`closing_events`, `reaberturas`, `snapshots`, `demurrage_registros`,
`demurrage_pendencias`, `tracking_fetches`, `tracking_incidents`,
`containers.estado/prioridade_balde`, `field_observations`,
`processo_campos_selecionados`.)

**Adição desta revisão — a cadeia de seleção financeira já congelada pela
D12** (base da correção §6):

`src/demurrage-engine/leitura/contrato.ts`:
- `selecionarValorAtivo(rows, relogioTipo, motorClienteAplicavel)` (linha
  280) — recebe TODAS as linhas ativas (`calculation_status IN
  ('OPEN','FINAL')`) de um contêiner, filtra pelo motor aplicável (só para
  o lado cliente) e escolhe **no máximo uma** linha por lado.
- `motorClienteAplicavelDe(termoTipo)` (linha 319) — traduz
  `condicoes_comerciais.termo_tipo` (`'embarque'|'unico'|null`) no motor
  comercial do cliente (`'termo_embarque'|'termo_unico'|null`).
- `envelopeDeValor`/`envelopeDoRelogio` — transformam a linha escolhida em
  `ValorEnvelope` (CONFIRMADO/ESTIMADO/ESTIMADO_PROVISORIO/PENDENTE/
  INDISPONIVEL/NAO_APLICAVEL), aplicando o frescor por `dias_cobrados`
  (D12 v1.2.3).

Chamadores (já em produção, D12): `filaOperacional.ts:499-500` e
`detalhe.ts:328-329`, ambos sobre uma consulta que já filtra
`calculation_status IN ('OPEN','FINAL')` por `container_id = ANY($1)`
(`detalhe.ts:105-112`, `filaOperacional.ts:468-491`).

---

## 4. Lacunas de dados — investigação conclusiva (revisada)

Itens 1, 4, 5, 6, 7 do diagnóstico anterior permanecem válidos sem
alteração (join de escopo de organização sobre tabelas globais de
tracking; sugestão de responsabilidade fora de escopo; nenhuma agregação
de organização existe hoje; índice `processos_prioridade_balde_idx` sem
`organization_id`; nenhum snapshot ponto-no-tempo existe).

**Itens 2 e 3 — investigados conclusivamente nesta revisão:**

### 4.2 "Consultas evitadas" (G-E3)

**Arquivo:** `src/demurrage-engine/scheduler/schedulerWorker.ts`,
função `runSchedulerOnce` (linha 92).

A cada tick, a função calcula `naJanela` (contêineres devidos para
consulta) e `suspensos` (contêineres com cadência suspensa) como
**contadores em memória**, devolvidos em `RunSchedulerOnceResultado`
(linha 70). Busquei por uma tabela que persista esse resultado tick a
tick (`scheduler_run`/`scheduler_tick`/`scheduler_log`) em todas as 34
migrations — **não existe**. `RunSchedulerOnceResultado` não é gravado em
nenhuma tabela; é só o retorno da função para quem chamou o tick
(provavelmente só logado em texto, fora do banco).

**Conclusão: G-E3 não tem fonte persistida. Fica ADIADO — nenhuma
estimativa é implementada.** Se o usuário quiser este indicador no
futuro, a correção mínima é persistir um resumo por tick (não por
contêiner) numa tabela `scheduler_tick_log` — fora do escopo da D14.

### 4.3 Suspensão de tracking após 30 dias (G-E9)

**Arquivos:** `src/demurrage-engine/scheduler/cadencePolicy.ts`
(`avaliarCadencia`, linha 78; `LIMITE_DIAS_DEMURRAGE = 30`, linha 30;
`FaseCadencia` inclui `'suspenso_30_dias'`, linha 26) e
`schedulerWorker.ts:96-108`, que chama `avaliarCadencia(cad)` e testa
`.automaticTracking === 'SUSPENDED'` a cada tick, sem persistir o
resultado por contêiner (só o contador agregado do tick, já coberto em
§4.2).

Busquei em `tracking_targets` (0011) e `container_tracking_targets`
(0011/0013) por uma coluna de fase/estado de suspensão — **não existe**
(0013 só acrescenta `ultima_consulta_manual_em`, nada sobre fase ou
suspensão). A suspensão é **recalculada a cada tick a partir dos fatos
correntes** (`discharge_date`, `house/master_free_time_days`/último dia
livre, `effective_return_date`, "algum relógio em demurrage"), nunca
gravada como evento com data de início.

**Conclusão:**
- **Série histórica de suspensão: impossível** — não há fato auditável de
  "quando" um contêiner entrou em suspensão. **Nenhuma métrica histórica
  de suspensão é exposta** (conforme instrução do usuário).
- **Contagem VIVA é legítima** — "quantos contêineres estão SUSPENSOS
  agora" pode ser respondida **reexecutando a própria `avaliarCadencia`
  (pura, congelada, sem duplicar a regra)** sobre os fatos atuais de cada
  contêiner rastreável da organização, em lote (`= ANY($1)`, mesmo padrão
  de `SchedulerRepository.carregarContainersRastreaveis`). G-E9 passa a
  ser um indicador **vivo apenas** (nunca histórico), reutilizando a
  função importada de `cadencePolicy.ts`, nunca uma reimplementação do
  limiar de 30 dias.

---

## 5. Catálogo completo de indicadores (revisado)

Convenção mantida: ID `G-<grupo><número>`; organização só do membership;
CLIENT nunca acessa; moedas nunca somadas; pendente/indisponível nunca
viram zero.

### Grupo A — Visão operacional (Cap. 30.1) — **dimensões independentes, não partes de um total**

> **Correção bloqueante 3.** Os indicadores abaixo NÃO são mutuamente
> exclusivos como grupo. Cada um pertence a uma DIMENSÃO; só indicadores
> da MESMA dimensão são mutuamente exclusivos entre si. Um processo pode
> aparecer em vários indicadores de dimensões diferentes simultaneamente
> (ex.: um processo pode estar em `CRITICA_15`, ter exposição Rocket E
> ter uma pendência de dados técnica, tudo ao mesmo tempo). **A soma dos
> cartões do Grupo A nunca deve ser interpretada como 100% de nada.**

| ID | Nome (PT) | Grão | Dimensão | Mutuamente exclusivo com | Regra de seleção | Fonte |
|---|---|---|---|---|---|---|
| G-A1 | Contêineres em monitoramento | contêiner | populacional (superconjunto) | — (contém todos os demais) | `estado IS NOT NULL` | `containers.estado` |
| G-A2 | Contêineres com prazo próximo | contêiner | **estado** | G-A3, G-A9-subset (demais valores do enum `estado`) | `estado = 'PRAZO_PROXIMO'` | idem |
| G-A3 | Em demurrage — Atenção (1–6) | contêiner | **estado** | G-A2 e demais valores do enum | `estado = 'EM_DEMURRAGE_ATENCAO'` | idem |
| G-A4 | Em demurrage — Crítico (7–14) | processo | **balde** (dimensão própria, derivada por regra diferente de `estado` — pode divergir do estado do mesmo contêiner) | G-A5 e demais baldes | `prioridade_balde = 'CRITICA_7_14'` | `processos.prioridade_balde` |
| G-A5 | Críticos 15+ dias | processo | **balde** | G-A4 e demais baldes | `prioridade_balde = 'CRITICA_15'` | idem |
| G-A6 | Contêineres com exposição Rocket | contêiner | **independente** (flag financeiro-operacional; coexiste com qualquer estado/balde) | nenhum | relógio Rocket `estado='OK'` e `dias_demurrage > 0` | `relogios` tipo=rocket |
| G-A7 | Processos com tracking desatualizado | processo | **independente** (badge de qualidade de dado) | nenhum | badge `TRACKING_DESATUALIZADO` presente | `containers.estado_badges` |
| G-A8 | Processos com dados críticos pendentes | processo | **independente** (pode coexistir com qualquer balde/estado — um processo crítico TAMBÉM pode ter pendência) | nenhum | `estado = 'PENDENCIA_DE_DADOS'` OU `demurrage_pendencias` aberta do processo | `containers.estado` + `demurrage_pendencias` |
| G-A9 | Processos aguardando tratamento | processo | **estado** (consolidado do processo) | demais valores de `estado_mais_relevante` | `estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'` | `processos.estado_mais_relevante` |
| G-A10 | Processos concluídos operacionalmente | processo | **fechamento** (dimensão própria, independente de estado/balde — um processo FINAL não participa mais da dimensão `estado` ativa) | nenhum (não compete com estado/balde) | `apuracao_status = 'FINAL'` | `processos.apuracao_status` |

**Frescor obrigatório (exigência adicional do usuário).** Toda resposta do
Grupo A inclui, ao lado das contagens:

```
{
  dataOperacional: "AAAA-MM-DD",            // dia civil operacional usado na consulta
  projecaoAtualizadaEm: {
    minima: "ISO-8601",                      // lifecycle_calculated_at mais antigo entre os registros contados
    maxima: "ISO-8601"                       // mais recente
  },
  statusFrescor: "atual" | "parcialmente_desatualizada" | "indeterminada",
  registrosComProjecaoDesatualizadaOuAusente: <int>
}
```

- `registrosComProjecaoDesatualizadaOuAusente` conta contêineres com
  `lifecycle_calculated_at IS NULL` (nunca derivado) OU cuja data civil
  de `lifecycle_calculated_at` é anterior à `dataOperacional` corrente —
  ou seja, que ainda não passaram pelo recálculo do dia civil atual. A
  regra exata de "quando a projeção deveria ter sido recalculada hoje"
  depende do ciclo de calendário interno
  (`src/demurrage-engine/lifecycle`/`passagemCalendario.ts`) e **precisa
  ser confirmada contra esse código na implementação** (G1) antes de
  fixar o limiar — esta seção propõe a FORMA do campo, não um número
  mágico.
- **Nunca chamar isso de "tempo real".** O texto fixo é **"projeção
  operacional atual"** (ou equivalente), em qualquer rótulo de API ou
  documentação voltada ao usuário final.

### Grupo B — Visão financeira (Cap. 30.2)

> **Correção bloqueante 1 aplicada.** Toda linha desta tabela soma
> **envelopes já selecionados por `selecionarValorAtivo`**, nunca linhas
> brutas de `valores_apurados`. Ver §6 para a prova de não-duplicação.

| ID | Nome (PT) | Grão | Fórmula | Fonte | Papel mínimo |
|---|---|---|---|---|---|
| G-B1 | Valor bruto do cliente, por moeda/status | organização×moeda×status | `agregarLado` generalizada sobre os envelopes `cliente` SELECIONADOS (um por contêiner) | `valores_apurados` via `selecionarValorAtivo` | ANALYST (decisão #10) |
| G-B2 | Valor efetivamente atribuído ao cliente | organização×moeda | soma `responsabilidade_decisoes.valor_cliente`, `valor_status='CALCULADO'`, decisão vigente (não superseded) | `responsabilidade_decisoes` | ANALYST (decisão #10) |
| G-B3 | Valor atribuído à Rocket (responsabilidade) | organização×moeda | idem, `valor_rocket` | idem | ANALYST (decisão #10) |
| G-B4 | Exposição estimada da Rocket | organização×moeda | `agregarLado` sobre envelopes `rocket` selecionados, `confirmation_status IN ('ESTIMATED','ESTIMATED_PROVISIONAL')` | `valores_apurados` via `selecionarValorAtivo` | ANALYST (decisão #10) |
| G-B5 | Exposição confirmada da Rocket | organização×moeda | idem, `CONFIRMED` | idem | ANALYST (decisão #10) |
| G-B6 | Diferença potencial total | organização×moeda×qualidade | soma das diferenças ELEGÍVEIS por contêiner (§7), classificada por qualidade (decisão #8) | par cliente/Rocket selecionado do mesmo contêiner | **MANAGER/ADMIN apenas** (decisão #11) |
| G-B7/8/9 | Faturado/recebido/saldo | — | **Sem fonte** — "Status financeiro não disponível" | HeadCargo (não integrado) | — |

### Grupo C — Responsabilidade da Rocket (Cap. 30.3)

| ID | Nome (PT) | Grão | Regra | Papel |
|---|---|---|---|---|
| G-C1 | Processos com responsabilidade confirmada | processo | decisão vigente `status IN (CONFIRMADA_ROCKET, CONFIRMADA_CLIENTE, DIVIDIDA)` em algum contêiner | ANALYST — leitura do estado e evidência (decisão #10); decidir continua exclusivo de MANAGER/ADMIN (já garantido pela 0031, `autor_papel`) |
| G-C2 | Diárias confirmadas para a Rocket | organização | soma `dias_rocket` de decisões vigentes `CONFIRMADA_ROCKET`/`DIVIDIDA` | ANALYST |
| G-C3 | Valor correspondente (Rocket) | organização×moeda | = G-B3 | ANALYST (decisão #10 cobre "estado de responsabilidade e evidência operacional", que inclui o valor associado à decisão já tomada) |
| G-C4 | Cliente/responsável/processo por decisão | linha (drill-down) | — | ANALYST |
| G-C5 | Justificativa e evidências | linha | `justificativa`, `evidencia_ref` | ANALYST (decisão #10: "evidência operacional") — nunca ao Portal/CLIENT (Cap. 26.4) |
| G-C6 | Recorrência por período | organização×período | `GROUP BY` de decisões por `decidido_em` | ANALYST |
| ~~G-C0~~ | Possível responsabilidade sugerida | — | **Fora de escopo** (§4, Liberação inexistente) | — |

**Nota sobre "comparação organização-level entre custo do cliente e
exposição Rocket" (decisão #11):** restrita a MANAGER/ADMIN. G-C1 a G-C6
listam ESTADOS e VALORES JÁ DECIDIDOS (não uma comparação agregada de
organização), por isso ficam abertos ao ANALYST; só uma comparação
agregada do tipo "total cliente vs. total Rocket da organização" (que é
exatamente G-B6, diferença potencial) fica restrita.

### Grupo D — Eficiência e conclusão operacional (Cap. 30.4)

**Metodologia aplicada em todo o grupo (decisões #1, #2, #3, #4, #5, #7):**

- Só processos com `apuracao_status = 'FINAL'` entram em qualquer média
  ou indicador de conclusão (decisão #2 — médias históricas excluem
  processos abertos).
- Duração = dias corridos (decisão #3), nunca dias úteis.
- "Dias de demurrage" usa `valores_apurados.dias_cobrados` da linha
  **FINAL** (decisão #1), nunca `relogios.dias_demurrage` (cache vivo,
  mutável) para médias históricas.
- Um processo com reaberturas conta **uma vez**, pelo **ciclo de
  fechamento mais recente** (`fechado_em` mais recente,
  `closing_events` tipo `FECHAMENTO_FINAL` mais recente); ciclos
  anteriores aparecem só no drill-down via `reaberturas`/`closing_events`,
  nunca como processos concluídos adicionais (decisão #5).
- Totais de processo somam **todos os contêineres aplicáveis**, nunca só
  o líder (decisão #7) — reaproveita `agregarFinanceiroProcesso`/
  `agregarLado`, que já soma todos os contêineres do processo.
- Data natural de cada indicador (decisão #4, ver §11): fechamento para
  eficiência/conclusão; Empty Return para indicadores de devolução;
  1º dia de demurrage para indicadores de início de custo.

| ID | Nome (PT) | Grão | Fórmula | Data natural |
|---|---|---|---|---|
| G-D1 | % devolvido dentro do House FT | organização, período | `COUNT(effective_return_date <= discharge_date + house_free_time_days - 1) / COUNT(effective_return_date IS NOT NULL)`, só containers de processos FINAL | Empty Return |
| G-D2 | % devolvido dentro do Master FT | idem, `master_free_time_days` | idem | Empty Return |
| G-D3 | Média de dias descarga→Empty Return | organização, período | média de `(tracking_return_date - discharge_date)`, só FINAL | Empty Return |
| G-D4 | Média de dias de demurrage por contêiner | organização, período | média de `valores_apurados.dias_cobrados` (linha FINAL), só processos FINAL | 1º dia de demurrage |
| G-D5 | Tempo médio Empty Return → conclusão | organização, período | média de `(fechado_em − effective_return_date)`, FINAL, ciclo mais recente | Fechamento |
| G-D6 | Tempo médio de resolução de pendências | organização, período | média de `(resolvido_em − criado_em)`, só resolvidas | Fechamento (data de resolução) |

**Correção bloqueante 2 — conclusão "com/sem custo" substituída por 8
indicadores separados.** Todos no grão **contêiner** dentro de processos
`apuracao_status='FINAL'` (ciclo mais recente), exceto onde indicado
"processo". Em todos: um lado `PENDENTE`/`INDISPONIVEL` **nunca** classifica
o contêiner como "sem custo" — é excluído das duas contagens (com/sem) e
reportado à parte, numa contagem de integridade (nunca deveria ocorrer se
o gate de fechamento v1.3-3 exige comprovação sem pendência, mas a
medição real confirma isso em vez de presumir).

| ID | Nome (PT) | Regra | Tratamento pendente/indisponível |
|---|---|---|---|
| G-D7.1 | Concluído SEM custo ao cliente | contêiner cujo envelope `cliente` selecionado é `NAO_APLICAVEL` (dias de demurrage do cliente = 0) | excluído se `PENDENTE`/`INDISPONIVEL` — reportado em G-D-INTEGRIDADE |
| G-D7.2 | Concluído COM custo ao cliente | contêiner cujo envelope `cliente` é `CONFIRMADO`/`ESTIMADO`/`ESTIMADO_PROVISORIO` com `total` — reportado por moeda e por status, nunca combinado | idem |
| G-D7.3 | Concluído SEM exposição Rocket | contêiner cujo envelope `rocket` é `NAO_APLICAVEL` | idem |
| G-D7.4 | Concluído COM exposição Rocket | contêiner cujo envelope `rocket` é `CONFIRMADO`/`ESTIMADO`/`ESTIMADO_PROVISORIO` | idem |
| G-D7.5 | Concluído SEM valor em nenhum lado | interseção de G-D7.1 e G-D7.3 (mesmo contêiner, ambos os lados `NAO_APLICAVEL`) | idem |
| G-D7.6 | Concluído com responsabilidade CONFIRMADA_ROCKET | contêiner cuja decisão vigente (`responsabilidade_decisoes`) tem `status='CONFIRMADA_ROCKET'` | contêineres sem decisão vigente (`NULL`/`EM_ANALISE`) ficam fora, contados à parte como "sem responsabilidade atribuída" |
| G-D7.7 | Concluído com responsabilidade CONFIRMADA_CLIENTE | idem, `status='CONFIRMADA_CLIENTE'` | idem |
| G-D7.8 | Concluído com responsabilidade DIVIDIDA | idem, `status='DIVIDIDA'` | idem |

G-D-INTEGRIDADE (contagem de apoio, não um KPI de negócio): contêineres de
processos FINAL cujo envelope cliente OU rocket ainda está
`PENDENTE`/`INDISPONIVEL` — esperado ser **zero** pelo gate de fechamento
v1.3-3, mas medido e exposto em vez de presumido; um valor > 0 aqui é um
sinal de regressão a investigar, nunca escondido.

### Grupo E — Qualidade de dados e tracking (Cap. 30.5) — revisado após investigação (§4)

| ID | Nome (PT) | Grão | Regra | Natureza |
|---|---|---|---|---|
| G-E1 | Consultas de tracking realizadas | organização, período | `COUNT(tracking_fetches)` via join de escopo | Histórico-por-período |
| G-E2 | Respostas reaproveitadas pelo cache | idem | `cached=true` | idem |
| ~~G-E3~~ | Consultas evitadas | — | **ADIADO — sem fonte persistida** (§4.2) | — |
| G-E4 | Taxa de sucesso por armador | organização, período | `status='ok'` agrupado por `carrier` | Histórico-por-período |
| G-E5 | Conectores com 3+ falhas consecutivas | organização | `tracking_incidents` aberto, via join de escopo | Vivo |
| G-E6 | House/Master FT automático × MANUAL_FALLBACK | organização, período | `field_observations.fonte` | Histórico-por-período |
| G-E7 | Tipos de contêiner não reconhecidos | organização | `demurrage_pendencias` aberta | Vivo |
| G-E8 | Tabelas/faixas indisponíveis | organização | `valores_apurados.confirmation_status='UNAVAILABLE'` ativo | Vivo |
| G-E9 | Processos com tracking suspenso agora | organização | reexecução de `avaliarCadencia` (congelada) sobre fatos atuais — **só VIVO, nunca histórico** (§4.3) | Vivo apenas |

### Grupo F — Moeda (Cap. 30.6)

(inalterado) Transversal — todo indicador monetário é reportado por
moeda separadamente, nunca somado entre moedas; sem conversão.

---

## 6. Prova de não-duplicação entre motores comerciais (correção bloqueante 1)

**Problema identificado pelo usuário:** o índice único
`valores_apurados_ativo_unico` é sobre
`(container_id, relogio_tipo, motor_comercial)` — ele impede DUAS linhas
ativas do MESMO trio, mas não impede que um contêiner tenha, ao mesmo
tempo, uma linha ativa para `motor_comercial='termo_embarque'` E outra
para `'termo_unico'` no lado cliente (teoricamente possível pelo schema,
mesmo que a prática de negócio só escreva um dos dois por processo).

**Solução — reusar a seleção já congelada pela D12, nunca inventar uma
nova regra:**

1. Para cada contêiner da organização, buscar `termo_tipo` do processo
   (`processos.condicao_comercial_id → condicoes_comerciais.termo_tipo`),
   exatamente a mesma consulta que `filaOperacional.ts:474` já faz, em
   lote.
2. Buscar todas as linhas ativas de `valores_apurados` do contêiner
   (`calculation_status IN ('OPEN','FINAL')`), mesma consulta de
   `detalhe.ts:105-112`, em lote por `container_id = ANY($1)`.
3. Para o lado **cliente**: `selecionarValorAtivo(rows, 'cliente',
   motorClienteAplicavelDe(termoTipo))` — o filtro interno da função
   (`contrato.ts:273`) descarta qualquer linha cujo `motor_comercial`
   não seja o aplicável ao processo. **Resultado: no máximo UMA linha
   candidata chega ao passo de escolha, nunca duas de motores
   diferentes.**
4. Para o lado **rocket**: `selecionarValorAtivo(rows, 'rocket', null)`
   — por construção do enum `valor_motor_comercial` (`'termo_embarque' |
   'termo_unico' | 'exposicao_armador'`), só `'exposicao_armador'` grava
   linha com `relogio_tipo='rocket'`; os motores de cliente nunca
   escrevem nesse lado. **A ausência de filtro aqui é segura porque o
   motor_comercial é, por construção do domínio, único para o lado
   Rocket** — documentado explicitamente, não presumido silenciosamente.
5. O resultado de `selecionarValorAtivo` (no máximo uma linha por lado)
   alimenta `envelopeDoRelogio`/`envelopeDeValor`, produzindo **um único
   `ValorEnvelope` por contêiner por lado** — exatamente a mesma forma
   que a D12 já usa para a fila e o detalhe.
6. Só então os envelopes (um por contêiner, por lado) entram na
   agregação de organização (`agregarLado` generalizada, §6-bis).

**Prova de que o total de organização não pode incluir dois motores
comerciais para o mesmo lado de um contêiner:** por indução — cada
contêiner contribui com exatamente 0 ou 1 envelope por lado (passo 5), e
a soma de organização é a soma desses envelopes (um por contêiner) — logo
nunca dois motores do MESMO contêiner/lado entram na soma. Isso é uma
propriedade da função `selecionarValorAtivo`, já testada pela suíte da
D12 (`src/demurrage-engine/__tests__/*`), reaproveitada sem reescrita.

**Gate de aceitação explícito (G1, §17):** teste de regressão que cria um
contêiner com DUAS linhas ativas de `valores_apurados` no lado cliente
(`motor_comercial` diferentes — cenário artificial, só para provar a
blindagem) e confirma que a agregação de organização soma **exatamente
um** dos dois, nunca os dois. Mesmo teste espelhado para o caso (real)
onde só `exposicao_armador` escreve o lado Rocket.

### 6-bis. Generalização de `agregarLado` (mantido do diagnóstico anterior, sem alteração de regra)

`agregarLado`/`moedaExata.ts` generalizada para aceitar qualquer lista de
`ValorEnvelope` (processo, organização ou subconjunto filtrado),
preservando: soma em centavos `bigint`, nunca `Number`/`+`; nunca somar
`cliente` com `rocket`; nunca somar moedas diferentes;
`PENDENTE`/`INDISPONIVEL`/`NAO_APLICAVEL` nunca entram na soma; `completo`
= `false` sempre que `pendentes>0 || indisponiveis>0`.

---

## 7. Matriz de elegibilidade da diferença potencial (atualizada — decisão #8)

`diferença potencial = valor do cliente − exposição da Rocket`, avaliada
**por contêiner**, sobre os envelopes JÁ SELECIONADOS pelo §6 (nunca sobre
linhas brutas).

| Condição | Checagem | Se falhar |
|---|---|---|
| Mesma moeda | `cliente.moeda === rocket.moeda` | `incompatível_moeda` |
| Ambos disponíveis | `situacao NOT IN (PENDENTE, INDISPONIVEL)` nos dois lados | `pendente`/`indisponivel` |
| Período compatível | mesma `data_final_apuracao` do relógio correspondente | `periodo_incompativel` |
| Frescor por `dias_cobrados` | ambos os valores cobrem os dias operacionais atuais (mesma regra de `envelopeDeValor`, D12 v1.2.3) | `obsoleto` |
| **Status de confirmação (decisão #8 — RESOLVIDA)** | **permitido mesmo quando um lado é só `ESTIMADO`/`ESTIMADO_PROVISORIO`**, desde que as demais condições passem | — |

**Classificação de qualidade obrigatória (decisão #8):** toda diferença
elegível carrega um campo `qualidade` = o **pior** dos dois lados, na
ordem `confirmado > estimado > provisório`:

```
qualidade =
  (cliente.situacao === 'CONFIRMADO' && rocket.situacao === 'CONFIRMADO') ? 'confirmado'
  : (cliente.situacao === 'ESTIMADO_PROVISORIO' || rocket.situacao === 'ESTIMADO_PROVISORIO') ? 'provisorio'
  : 'estimado'
```

Nunca oculta a composição: a resposta sempre inclui `qualidade` ao lado
do valor da diferença — nunca um número "limpo" sem essa classificação.
Quando inválida, resposta estruturada
`{ elegivel: false, motivo: 'pendente'|'indisponivel'|'incompativel_moeda'|'periodo_incompativel'|'obsoleto' }`,
nunca `null`/`0` silencioso. **Estritamente interno — MANAGER/ADMIN
apenas (decisão #11)**, nunca `CLIENT`, nunca um Portal futuro (Cap. 24.3/
32.2).

---

## 8. Indicadores vivos × histórico-por-período (V1 — sem snapshot)

(mantido do diagnóstico anterior, com a distinção REFORÇADA pela
correção bloqueante 4)

- **Vivo:** estado atual, recalculável a qualquer momento a partir das
  colunas persistidas/cache (Grupo A, B, C, G-E5/E7/E8/E9).
- **Histórico-por-período:** agregação sobre fatos **já fechados/
  append-only**, filtrada por uma data de atribuição passada — **não
  precisa de snapshot**, é uma query com `WHERE` de data sobre o estado
  atual dos fatos fechados (Grupo D inteiro, G-E1/E2/E4/E6).
- **Snapshot ponto-no-tempo:** **fora da V1** (correção bloqueante 4) —
  nenhuma série temporal de backlog (Grupo A ao longo do tempo) é
  entregue nesta fase.

---

## 9. Snapshot histórico — REMOVIDO da V1 (correção bloqueante 4)

**Nenhuma tabela `demurrage_gestao_snapshots`, nenhuma migration `0035`,
nenhum materializador, nenhum bootstrap de scheduler de Gestão fazem
parte desta entrega.** O modelo genérico `metricas JSONB` proposto no
diagnóstico anterior é insuficientemente estrito para um contrato
histórico permanente — correto o apontamento do usuário.

**Escopo da D14 V1:** indicadores vivos (Grupos A/B/C/E5/E7/E8/E9) +
histórico-por-período reconstruível de fatos já fechados (Grupo D,
G-E1/E2/E4/E6) + drill-down de composição. **Nenhuma série temporal de
backlog** (ex.: "evolução de `CRITICA_15` ao longo do tempo") é entregue.

**Desenho futuro (fora desta fase, explicitamente adiado):** quando
aprovado, o snapshot precisa definir, por métrica, ANTES de qualquer
migration:

- **identificador da métrica** (um ID estável, versionado — não um texto
  livre dentro de um JSONB);
- **dimensões** (quais filtros/cortes aquela métrica suporta, tipados,
  não um objeto aberto);
- **grão** (organização/processo/contêiner/dia — explícito por métrica,
  não um campo genérico `grao` compartilhado por todas);
- **unidade** (contagem, dias, valor monetário — tipado);
- **moeda** (quando aplicável, nunca implícita);
- **qualidade financeira** (confirmado/estimado/provisório/indisponível —
  mesma taxonomia do resto do sistema, nunca uma nova);
- **contagens incluídas/excluídas** (o que entrou na métrica e o que
  ficou de fora por pendência/indisponibilidade, sempre ao lado do
  número, nunca escondido);
- **versão da regra** (quando a fórmula de cálculo muda, uma nova versão
  nunca reescreve snapshots antigos calculados pela versão anterior);
- **linhagem de correção** (se um dia materializado precisa ser corrigido,
  como isso é registrado sem apagar o snapshot original — append-only,
  nunca `UPDATE`);
- **contrato de consulta tipado** (schema de resposta explícito por
  métrica, não um `JSONB` genérico interpretado por convenção no
  frontend).

Este desenho é trabalho de uma fase própria (D14.1 ou preparação da D15),
**não parte dos gates desta entrega**.

---

## 10. Contratos de API propostos

Mesma convenção da D12 (organização só do membership, `organizationId`
nunca aceito, `GET` nunca escreve/recalcula, moedas/status separados,
`CLIENT` nunca alcança). **Removida** a rota de histórico/snapshot do
diagnóstico anterior (correção bloqueante 4).

| Rota | Propósito | Indicadores |
|---|---|---|
| `GET /api/demurrage/v2/gestao/operacional` | Visão operacional atual, com bloco de frescor (§5-A) | Grupo A |
| `GET /api/demurrage/v2/gestao/financeiro` | Visão financeira atual | Grupo B (G-B6 só para MANAGER/ADMIN — 403 de campo, não da rota inteira, se ANALYST pedir e o backend expuser o campo mesmo assim) |
| `GET /api/demurrage/v2/gestao/responsabilidade` | Responsabilidade Rocket | Grupo C |
| `GET /api/demurrage/v2/gestao/eficiencia` | Eficiência/conclusão operacional | Grupo D (período obrigatório — sem período, nenhuma média é exibida) |
| `GET /api/demurrage/v2/gestao/qualidade` | Qualidade de dados/tracking | Grupo E (G-E3 ausente da resposta — não um campo vazio, o próprio indicador não existe no contrato) |
| `GET /api/demurrage/v2/gestao/indicadores/:id/composicao` | Drill-down (Cap. 30.7) | qualquer indicador acima, cursor igual ao da D12 |

**Visibilidade em nível de CAMPO, não só de rota (decisões #10/#11):** a
rota `/financeiro` é acessível a ANALYST/MANAGER/ADMIN, mas o campo
`G-B6` (diferença potencial) só aparece no payload para MANAGER/ADMIN —
para ANALYST, o campo é **omitido** (nunca um valor fabricado/zerado),
com uma marca explícita `acessoRestrito: true` em vez do valor, para que
o consumidor saiba que o campo existe mas não está disponível para o
papel atual — nunca confundível com "não calculado".

---

## 11. Filtros e períodos de relatório (decisão #4 — RESOLVIDA, sem override genérico)

**Removido** o campo de override genérico `periodoCampo` proposto no
diagnóstico anterior — o usuário determinou que cada indicador usa sua
**data natural fixa**, nunca uma data trocável que mudaria o significado
de negócio do indicador:

| Indicador/família | Data natural | Justificativa |
|---|---|---|
| Entrada em monitoramento (Grupo A, quando filtrado por período) | **Descarga** | É quando o contêiner entra no acompanhamento (Cap. 13) |
| Indicadores de devolução (G-D1, G-D2, G-D3) | **Empty Return** (`tracking_return_date`/`effective_return_date`) | Medem o que foi devolvido, não o que foi concluído |
| Eficiência e conclusão (G-D4 parcialmente, G-D5, G-D6, G-D7.\*) | **Fechamento** (`processos.fechado_em`) | Só fazem sentido para processos concluídos; evita viés de "mês incompleto" |
| Indicadores de início de custo (G-D4) | **1º dia de demurrage** (`relogios.primeiro_dia_demurrage` da apuração FINAL) | Mede quando o custo começou, não quando descarregou nem quando fechou |

Filtros comuns não-temporais (mantidos): `cliente`, `armador`,
`responsavel`, `tipoEquipamento` (novo nesta fase — hoje a D12 não filtra
por tipo).

---

## 12. Matriz de visibilidade por papel (decisões #10/#11 — RESOLVIDA)

| Indicador/grupo | ANALYST | MANAGER | ADMIN | CLIENT |
|---|---|---|---|---|
| Grupo A (operacional) | ✅ | ✅ | ✅ | ❌ |
| G-A6 (contagem de exposição Rocket) | ✅ | ✅ | ✅ | ❌ |
| Grupo B, exceto G-B6 (valores: cliente, exposição Rocket, status financeiro) | ✅ (decisão #10) | ✅ | ✅ | ❌ |
| **G-B6 (diferença potencial)** | ❌ (decisão #11) | ✅ | ✅ | ❌ sempre |
| Grupo C (responsabilidade — estado, valores já decididos, evidência) | ✅ leitura (decisão #10) | ✅ leitura + decide | ✅ leitura + decide | ❌ sempre |
| **Comparação organização-level cliente×Rocket** (equivalente a G-B6 em outra lente) | ❌ (decisão #11) | ✅ | ✅ | ❌ |
| Grupo D (eficiência) | ✅ | ✅ | ✅ | ❌ |
| Grupo E (qualidade/tracking) | ✅ | ✅ | ✅ | ❌ |

A diferenciação é implementada em **nível de campo** (§10), não só de
rota — testada explicitamente no gate G5 (§17).

### 12-bis. Metadado de dimensão no contrato (correção bloqueante 3)

Todo indicador do Grupo A (e qualquer outro indicador de contagem futuro)
carrega, no contrato de resposta:

```
{
  id: "G-A3",
  dimensao: "estado" | "balde" | "populacional" | "independente" | "fechamento",
  mutuamenteExclusivoCom: ["G-A2", "G-A9-DEVOLVIDO_AGUARDANDO_TRATAMENTO", ...],  // outros IDs da MESMA dimensão
  valor: <int>
}
```

Documentação de API inclui, de forma destacada: **"Os indicadores do
Grupo A medem dimensões independentes do mesmo conjunto de processos. Um
processo pode aparecer em vários indicadores simultaneamente. A soma dos
valores nunca representa o total de processos da organização."** Este
texto é um requisito de aceitação (G3, §17), não uma sugestão de
redação.

---

## 13. Isolamento de organização

(inalterado do diagnóstico anterior) `organizationId` nunca aceito em
nenhum canal; toda tabela global de tracking filtra por JOIN através de
`container_tracking_targets`/`containers`, nunca por filtro pós-agregação.
Teste de isolamento com `tracking_target` compartilhado entre duas
organizações (vessel sharing) é gate obrigatório (§17, §18).

---

## 14. Estratégia de consulta e desempenho (atualizada com o padrão §6)

### Leituras em lote reaproveitáveis da D12

(mantido) `buscarProcessosCandidatos`/`buscarContainersDosCandidatos`,
`buscarAgregadosPorProcesso` — padrão `= ANY($1)`, nunca N+1.

**Novo nesta revisão — padrão de lote para a seleção financeira do §6:**
a consulta de `termo_tipo` + linhas ativas de `valores_apurados` deve
rodar **uma vez para toda a organização** (não por processo), com
`container_id = ANY($1)` sobre TODOS os contêineres candidatos da
organização (ou do filtro aplicado), exatamente como `detalhe.ts:105-112`
já faz por página — generalizado para o universo completo em vez de uma
página de 50. `selecionarValorAtivo` roda em memória sobre esse lote
único (função pura, sem I/O), nunca uma consulta por contêiner.

### Risco de N+1 e custo linear (mantido, com adição)

`contarEstadosEBaldes` não escala — recomendação mantida: Grupo A usa
`GROUP BY` sobre colunas persistidas, não re-derivação em memória
(decisão pendente de aprovação explícita, já registrada no diagnóstico
anterior, mantida sem mudança).

**Adição:** a seleção financeira do §6, mesmo rodando sobre o lote
completo da organização, é O(contêineres ativos) em memória **uma vez por
requisição** — aceitável para a visão de Gestão (consultada com menor
frequência que a fila operacional), mas precisa de medição real (abaixo)
antes de aprovar para 10.000 processos.

### Tabela de custo esperado (mantida, estimativa — não substitui medição)

| Processos | Grupo A (`GROUP BY` proposto) | Grupo B (seleção em lote, §6) | Grupo D/E (histórico-por-período) |
|---|---|---|---|
| 100 | instantâneo | instantâneo | rápido |
| 1.000 | rápido (índice composto) | rápido | rápido |
| 10.000 | O(índice), não O(N) | depende de `EXPLAIN` sobre `valores_apurados` filtrado por `container_id = ANY(milhares)` — medir | depende do volume no período, paginar evita problema |

### Índices potenciais (mantidos do diagnóstico anterior, não criados nesta fase)

1. `containers (organization_id, estado)`.
2. `processos (organization_id, prioridade_balde)`.
3. `valores_apurados (relogio_tipo, confirmation_status,
   calculation_status)` combinado com `container_id` — confirmar com
   `EXPLAIN` se o índice existente já basta para a consulta em lote do
   §6 em organizações grandes.
4. `tracking_fetches (criado_em)` — confirmar necessidade com `EXPLAIN`.

Nenhum índice novo entra em migration sem o `EXPLAIN ANALYZE` que o
justifica, anexado ao PR da implementação.

---

## 15. Migrations propostas

**Nenhuma migration nesta fase.** A migration `0035` e o materializador
de snapshot, propostos no diagnóstico anterior, **foram removidos**
(correção bloqueante 4) — nenhuma tabela nova é necessária para a D14
V1: todos os indicadores do §5 leem tabelas/colunas já existentes.

Se, após medição real (§14), os índices do item 14 forem aprovados, eles
entram numa migration aditiva separada (`0035` ou seguinte — o número
volta a ficar livre), cada um com o `EXPLAIN ANALYZE` que o motivou.
Nenhuma coluna existente muda de tipo; nenhuma tabela existente é alterada
estruturalmente.

---

## 16. Arquivos a criar/alterar (implementação futura)

(mantido do diagnóstico anterior, com remoção dos itens de snapshot)

- `src/demurrage-engine/leitura/gestao/contrato.ts` — tipos dos payloads
  (A–F), incluindo o bloco de frescor (§5-A) e o metadado de dimensão
  (§12-bis). **Sem** tipo de resposta de histórico/snapshot.
- `src/demurrage-engine/leitura/gestao/selecaoFinanceira.ts` — **novo
  módulo isolado** que encapsula o padrão do §6 (busca em lote +
  `selecionarValorAtivo` por contêiner), reusado por `financeiro.ts`,
  `responsabilidade.ts` e `eficiencia.ts` — para que a prova de
  não-duplicação (§6) viva em UM lugar, nunca reimplementada em cada
  grupo.
- `src/demurrage-engine/leitura/gestao/operacional.ts` — Grupo A, com
  bloco de frescor.
- `src/demurrage-engine/leitura/gestao/financeiro.ts` — Grupos B/F, sobre
  `selecaoFinanceira.ts`.
- `src/demurrage-engine/leitura/gestao/responsabilidade.ts` — Grupo C.
- `src/demurrage-engine/leitura/gestao/eficiencia.ts` — Grupo D, com os 8
  indicadores de conclusão (+ G-D-INTEGRIDADE).
- `src/demurrage-engine/leitura/gestao/qualidade.ts` — Grupo E (sem
  G-E3; G-E9 vivo via `avaliarCadencia` importada, não duplicada).
- `src/routes/demurrageGestaoRoutes.ts` — as 6 rotas (§10), com
  visibilidade de campo por papel (§10, §12).
- ~~`src/demurrage-engine/gestao/snapshotMaterializer.ts`~~ — **removido**.
- ~~`0035_demurrage_gestao_snapshots.sql`~~ — **removido**.
- Testes: `gestaoSelecaoFinanceira.test.ts` (prova de não-duplicação,
  §6, gate G1), `gestaoOperacional.test.ts` (dimensões independentes,
  gate G3), `gestaoFinanceiro.test.ts`, `gestaoResponsabilidade.test.ts`,
  `gestaoEficiencia.test.ts` (8 indicadores + integridade, gate G4),
  `gestaoQualidade.test.ts`, `gestaoDiferencaPotencial.test.ts` (§7) +
  equivalente de zero-escrita/RBAC/isolamento para as novas rotas.
- `docs/demurrage-fase-d14.md` — relatório de entrega, só após
  implementação e validação.

**Nada em `public/**`, rotas V1/V2 existentes, nem em qualquer motor de
D10/D11/D12.**

---

## 17. Gates de aceitação revisados G1–G7

- **G1 — Seleção financeira autoritativa.** `selecaoFinanceira.ts`
  implementa exatamente o padrão do §6, reusando `selecionarValorAtivo`/
  `motorClienteAplicavelDe` sem reescrita. Teste prova que um contêiner
  com múltiplas linhas ativas em motores diferentes contribui no máximo
  um envelope por lado para a agregação de organização (cenário
  artificial de duas linhas ativas no lado cliente; cenário real de
  `exposicao_armador` único no lado Rocket).
- **G2 — Agregação decimal exata.** `agregarLado` generalizada, mesmos
  testes de não-soma de moeda/não-zero-para-pendente já existentes na
  D12, reexecutados sem alteração de expectativa sobre a função
  original.
- **G3 — Dimensões operacionais independentes.** Grupo A carrega
  `dimensao`/`mutuamenteExclusivoCom` no contrato; teste de fixture prova
  que um único processo aparece simultaneamente em indicadores de
  dimensões diferentes (ex.: `CRITICA_15` + exposição Rocket + pendência
  de dados no mesmo processo); documentação de API contém o aviso
  obrigatório do §12-bis.
- **G4 — Indicadores de conclusão separados.** Os 8 indicadores do §5
  (Grupo D, correção 2) implementados com teste de cada caso (com/sem
  custo cliente, com/sem exposição Rocket, sem valor em nenhum lado, as 3
  responsabilidades) e do caso de integridade (pendência remanescente
  num processo FINAL nunca vira "sem custo").
- **G5 — Visibilidade em nível de campo.** Teste por papel×rota×campo:
  ANALYST recebe `/financeiro` sem o campo `G-B6` (marcado
  `acessoRestrito`, nunca um valor fabricado); MANAGER/ADMIN recebem o
  valor completo.
- **G6 — Isolamento, zero-escrita e SEM snapshot em V1.** Rotas só `GET`,
  fingerprint de schema completo antes/depois (zero-escrita); teste de
  isolamento com `tracking_target` compartilhado entre duas organizações
  (§18); **confirmação explícita no PR de que nenhuma migration `0035`
  nem materializador de snapshot existe no diff**.
- **G7 — Desempenho e regressão completa.** Contagem de queries por rota
  (nunca N+1), `EXPLAIN ANALYZE` real contra volume sintético de
  100/1.000/10.000 processos (§14) anexado ao PR; suíte completa da
  engine (`test:demurrage-engine`, baseline 724/724), V1 (25/25),
  `tsc --noEmit`, `npm run build` limpos; `git diff` vazio em
  `src/demurrage-engine/db/migrations/0001`–`0034` e em todos os
  arquivos protegidos de D10/D11/D12/D13.

---

## 18. Plano de teste PostgreSQL (atualizado)

1. **Seleção financeira (G1).** Fixtures com múltiplas linhas ativas por
   motor comercial no mesmo contêiner/lado (cenário artificial) +
   fixture real de Termo Único vs. Termo por Embarque em processos
   diferentes da mesma organização.
2. **Fixtures de volume sintético** — 100/1.000/10.000 processos,
   `EXPLAIN ANALYZE` real para Grupo A (proposto), Grupo B (seleção em
   lote), Grupo D/E.
3. **Zero-escrita** — fingerprint de `information_schema` antes/depois
   nas 6 rotas (mesmo padrão `demurrageV2UiZeroWrite.test.ts`).
4. **RBAC de rota.** `CLIENT` 403, sem sessão 401, `organizationId` em
   qualquer canal 400 `parametro_nao_aceito`.
5. **RBAC de campo (G5).** `ANALYST` nunca recebe `G-B6`/diferença
   potencial no payload; `MANAGER`/`ADMIN` recebem.
6. **Isolamento multi-organização, incluindo tracking compartilhado.**
   Duas organizações com um `tracking_target` em comum (cenário de
   vessel sharing real, F9v1.1) — G-E1/E2/E4/E5/E9 de cada organização
   nunca contam o fato da outra.
7. **Elegibilidade e qualidade da diferença potencial (§7).** Cada motivo
   de inelegibilidade isoladamente; caso elegível com um lado estimado
   (decisão #8) classificado corretamente como `estimado`/`provisorio`.
8. **Dimensões independentes (G3).** Fixture de um processo em múltiplos
   indicadores simultaneamente (balde crítico + exposição Rocket +
   pendência).
9. **8 indicadores de conclusão + integridade (G4).** Cada um dos casos
   do §5/Grupo D, incluindo o caso de integridade (pendência
   remanescente nunca vira zero).
10. **Regressão completa.** `test:demurrage-engine` (724/724), V1
    (25/25), `tsc --noEmit`, `npm run build`.

---

## 19. Riscos de regressão

(mantido do diagnóstico anterior) Nenhum risco para D10/D11/D12/D13 —
leitura aditiva. Risco real mitigado nesta revisão: a generalização de
`agregarLado` e a reutilização de `selecionarValorAtivo` em
`selecaoFinanceira.ts` (módulo único) eliminam o risco antes identificado
de "reaproveitar mal" a lógica de seleção — ela não é reescrita, só
chamada em lote maior.

**Risco novo identificado nesta revisão:** se um desenvolvedor futuro
implementar o Grupo D sem passar pelo `selecaoFinanceira.ts` central
(ex.: consultando `valores_apurados` diretamente "só para os 8
indicadores de conclusão"), reintroduziria o bug da correção bloqueante
1. Mitigação: `selecaoFinanceira.ts` é a ÚNICA porta de entrada para
envelopes selecionados — gate G1 inclui uma checagem estática (grep) que
nenhum outro arquivo de `gestao/` consulta `valores_apurados` diretamente.

---

## 20. Itens explicitamente adiados

- Integração financeira HeadCargo (G-B7/8/9).
- Responsabilidade SUGERIDA (G-C0) — depende de Liberação.
- **G-E3 (consultas evitadas)** — sem fonte persistida (§4.2).
- **Série histórica de suspensão (G-E9 histórico)** — sem fato auditável
  (§4.3); só a contagem viva permanece.
- **Snapshot ponto-no-tempo / série temporal de backlog** — removido da
  V1 inteira (correção bloqueante 4); desenho futuro descrito no §9.
- Qualquer ação de escrita a partir de Gestão.
- Conversão de moeda.
- UI de Gestão.

---

## 21. Decisões de negócio — APROVADAS (aplicadas nesta revisão)

Todas as 14 decisões do diagnóstico anterior foram resolvidas pelo
usuário e aplicadas ao longo deste documento. Resumo de onde cada uma foi
incorporada:

1. **Duração média usa `dias_cobrados` FINAL** → §5 Grupo D, metodologia.
2. **Médias excluem processos abertos** → idem.
3. **Dias corridos** → idem.
4. **Data natural fixa por indicador, sem override genérico** → §11.
5. **Processo conta uma vez; ciclos anteriores só em drill-down** → §5
   Grupo D, metodologia.
6. **Confirmado/estimado/provisório nunca combinados** → §5 Grupo B
   (herda de `agregarLado`, inalterado) e §7 (qualidade da diferença
   potencial).
7. **Totais incluem todos os contêineres, nunca só o líder** → §5 Grupo
   D, metodologia; §6 (seleção é por contêiner, soma é de todos).
8. **Diferença potencial permite estimado, com classificação de
   qualidade** → §7.
9. **Snapshots diários adiados da V1** → §9 (correção bloqueante 4).
10. **ANALYST vê valor do cliente, exposição Rocket, status financeiro,
    responsabilidade (estado+evidência)** → §12.
11. **MANAGER/ADMIN apenas: diferença potencial, indicadores de margem,
    comparação organização-level cliente×Rocket** → §12.
12. **Registros históricos incompletos ficam pendentes/indisponíveis,
    nunca zero** → aplicado transversalmente (§5 Grupo D,
    G-D-INTEGRIDADE; §7; princípio geral de `agregarLado`).
13. **Monitoramento silencioso entra na população total, não na fila de
    ação** → G-A1 (populacional) vs. G-A2+ (dimensão estado, que exclui
    silencioso por definição do próprio enum).
14. **Contêineres devolvidos ficam no backlog operacional até FINAL** →
    G-A9 (aguardando tratamento, dimensão estado) permanece até
    `apuracao_status='FINAL'`; só então sai para a dimensão fechamento
    (G-A10).

Nenhuma decisão nova foi introduzida silenciosamente por esta revisão —
onde uma definição de implementação precisou de um critério próprio (ex.:
regra de composição dos indicadores de responsabilidade por processo,
§5 Grupo D), a escolha foi declarada explicitamente no texto, nunca
embutida sem explicação.

---

**A D14 não está implementada, aprovada nem congelada.** Nenhum código
foi alterado por esta revisão. A implementação só começa após aprovação
final deste diagnóstico corrigido. A D15 não foi iniciada.
