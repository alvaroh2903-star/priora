# Fase D15 — Diagnóstico e Planejamento (Exceções Operacionais e Casos de Borda)

> **Status:** diagnóstico puro, **revisão 2** sobre o commit `84ccb34`.
> **Nenhum código de produção, migration, rota ou teste foi alterado nesta
> entrega.** Apenas este documento foi atualizado. A D15 **continua não
> implementada** — a revisão fixa as decisões de negócio e divide a
> implementação futura em três blocos auditáveis (D15-A, D15-B, D15-C), mas
> nenhum deles foi iniciado. A D16 não foi tocada.
>
> **O que mudou desde `84ccb34`:** o texto integral do Capítulo 31 do
> Blueprint foi fornecido pelo usuário e **substitui toda reconstrução
> indireta** da revisão anterior. Dez decisões antes listadas como
> bloqueantes foram **fixadas pelo próprio usuário** nesta rodada (ver §9).
> Os casos e contagens foram recalculados do zero (§4) em vez de corrigidos
> linha a linha, porque o texto exato do Blueprint desdobra alguns casos que
> antes estavam fundidos (ex.: 31.4, 31.5, 31.6/31.7, 31.13, 31.14) e dissolve
> distinções que antes pareciam necessárias.

## 1. Resumo executivo

Com o texto exato do Capítulo 31 em mãos, a cobertura real da base muda em
dois sentidos: (a) alguns casos que a revisão anterior havia classificado
como "cobertos estruturalmente" por aproximação (31.5, 31.6/31.7, 31.14) na
verdade não atendem ao enunciado literal do Blueprint e passam a **não
cobertos**; (b) todas as dez decisões de negócio que a revisão anterior
listava como bloqueantes foram **fixadas pelo usuário** nesta rodada —
nenhuma permanece em aberto como decisão de política. Resta exatamente
**uma** lacuna de projeto genuinamente indeterminada (§10): o mecanismo
concreto de "encaminhar para verificação de tracking" exigido pela 31.5.

O trabalho de implementação foi reorganizado em três blocos conforme
solicitado — **D15-A** (integridade de estado final e reabertura), **D15-B**
(integridade de dados e exceções) e **D15-C** (integridade tarifária e
recuperação) — cada um auditável e congelável de forma independente antes
do início do próximo. A versão/imutabilidade de tabela tarifária, antes
tratada como decisão a ser potencialmente separada, agora é **obrigatória
dentro de D15** (bloco D15-C), por determinação explícita do usuário.

**Contagem recalculada (detalhe em §4):** **66** casos revisados (a revisão
anterior contava 47; o Capítulo 31 exato desdobra subcasos que antes estavam
fundidos — ver §4.1 para o mapeamento exato); **29** já corretamente
cobertos; **31** exigem trabalho de D15 (7 no bloco A, 18 no bloco B, 6 no
bloco C); **6** permanecem deferidos (3 integração externa, 1 frontend, 1
Portal, 1 impossível sem fonte externa). Nenhuma decisão de negócio
bloqueante resta pendente de aprovação, exceto o item único de §10.

## 2. Decisões fixadas nesta rodada (aplicadas ao plano revisado)

Estas dez decisões, listadas como bloqueantes na revisão anterior (`84ccb34`,
§18), foram **resolvidas pelo usuário** e passam a ser tratadas como
especificação, não mais como escolha em aberto:

| Decisão | Resolução aplicada |
|---|---|
| Texto do Cap. 31 (antiga D-1) | Substituído pelo texto literal fornecido — ver §3. |
| Mudança material pós-FINAL (antiga D-30) | Registrar o fato tentado/recebido e devolver `exige_reabertura` controlado; **nunca mutar a projeção FINAL selecionada** até reabertura autorizada por gestor. → D15-A. |
| Empty Return inválido antes da descarga (antiga parte de D-12) | Preservar a evidência bruta, nunca promovê-la como retorno efetivo, criar inconsistência aberta, bloquear fechamento e notificar/rotear para gestão **e** verificação de tracking. → D15-B (ver lacuna residual em §10). |
| Gate Out antes da descarga / Empty Return antes do Gate Out (antiga D-12) | Preservar a evidência bruta, criar pendência de cronologia e impedir a promoção posterior afetada até resolução. **Não** criar incidente técnico, a menos que o próprio processamento tenha falhado. → D15-B. |
| Conflito de fonte (antiga D-17) | Preservar toda observação e usar o mecanismo de divergência já existente, **generalizado por campo/fonte** em vez de restrito a Master×SI. → D15-B. |
| Tabelas tarifárias (antiga D-21) | Imutáveis após ativação/uso. Correções geram nova versão. Processos históricos permanecem vinculados à versão original, salvo reabertura explícita com recálculo. **Obrigatório em D15** (bloco D15-C), não mais candidato a fase separada. |
| Histórico de tentativas de fonte de Free Time (antiga D-11) | Tabela satélite append-only associada à pendência; guarda fonte, timestamp da tentativa, resultado e evidência/referência sanitizada; última tentativa exposta por projeção/consulta; **nunca sobrescrita em JSONB**. → D15-B. |
| `mismatchCarrier` e condição comercial ausente (antigas D-14/D-15) | Novos tipos explícitos em `demurrage_pendencias` para ambos. → D15-B. |
| Descarga manual (antiga D-27) | Permanece proibida em D15; tracking oficial do armador continua sendo a fonte da verdade. Nenhuma mudança de código necessária — comportamento atual confirmado. |
| Observações de mesma autoridade (antiga D-9) | `observado_em` mais novo vence. Uma observação mais antiga que chega depois permanece no ledger, mas não pode substituir uma observação mais nova já selecionada. → D15-B. |
| Rotas públicas de mutação (antiga D-28) | D15 permanece em nível de serviço. Nenhuma rota pública de mutação antes da fase de frontend/fluxo de ação. Aplica-se a todos os blocos A/B/C. |

Nenhuma dessas dez decisões é tratada como aberta nesta revisão. A única
lacuna de projeto que resta genuinamente indeterminada está isolada em §10.

## 3. Rastreabilidade exata do Capítulo 31

Texto literal fornecido pelo usuário, subseção por subseção, confrontado com
o comportamento real do código. A coluna "Classificação" usa os blocos
D15-A/B/C definidos em §5–§7, ou `COB` (já corretamente coberto), ou
`DEFER` quando o próprio Blueprint determina o deferimento.

### 31.1 — Contêiner sem descarga no tracking
> Relógios não iniciam; ETA, berço e HeadCargo não substituem a descarga; o
> processo espera o evento oficial; falhas de conector seguem a política de
> alerta.

**Código real:** `relogios` permanece sem linha/`PENDING` até evento de
descarga oficial via tracking; nenhum campo de ETA/berço/HeadCargo é
promovido como data de descarga (`eventIngestion.ts` só promove
`dischargeDate` a partir de `tracking_service`); falhas de conector seguem
`failurePolicy.ts` (incidente no 3º `falha` consecutivo). **Classificação: COB.**

### 31.2 — Datas de descarga diferentes
> Contêineres do mesmo processo podem ter datas de descarga diferentes. Cada
> contêiner inicia seus relógios a partir da própria descarga. O processo
> nunca aplica uma data a todos os contêineres.

**Código real:** `relogios` é por contêiner; `processConsolidation.ts` nunca
funde datas entre contêineres do mesmo processo. **Classificação: COB.**

### 31.3 — Free Time igual a zero
> Free Time zero só é válido quando confirmado por fonte aprovada. A
> cobrança desse relógio começa na data da descarga. Zero nunca deve ser
> tratado como dado ausente.

**Código real:** `relogios`/apuração tratam FT=0 como valor numérico válido,
distinto de `PENDING` (ausência); a cobrança usa D0 = data de descarga.
**Classificação: COB.**

### 31.4 — Free Time ausente
> Quando House ou Master Free Time não é encontrado em nenhuma fonte
> aprovada: o relógio afetado fica pendente; Priora mostra as fontes
> consultadas; Priora mostra o horário da última tentativa; os cálculos
> dependentes permanecem bloqueados. ANALYST pode usar MANUAL_FALLBACK só
> sob ausência total de fonte. Exige número de dias, identidade do relógio,
> fonte ou justificativa e, quando disponível, documento ou comunicação do
> processo. Priora registra autor e timestamp e notifica gestores. ANALYST
> não pode sobrescrever Free Time existente. Se uma fonte mais forte aparecer
> depois com valor diferente, Priora registra a divergência e a encaminha à
> gestão sem substituir silenciosamente o fallback manual.

Desdobrado em quatro subcasos porque o código trata cada um de forma distinta:

| Subcaso | Código real | Classificação |
|---|---|---|
| (a) relógio fica pendente, cálculos bloqueados | `PENDING` nunca convertido a zero; dependentes bloqueados (confirmado em `bracketEngine.ts`/`valorApuradoRepository.ts`) | **COB** |
| (b) fontes consultadas + horário da última tentativa exibidos | **não existe** — nenhuma estrutura registra tentativas de obtenção além do valor final promovido | **D15-B** |
| (c) governança do MANUAL_FALLBACK (dias, identidade, fonte/justificativa, doc, autor+timestamp, aviso a gestores) | implementado em `demurrage_fallback_manual_justificativas`/`avisos`, com validação de membership e evidência | **COB** |
| (d) fonte mais forte chega depois do fallback manual → não substitui silenciosamente, registra divergência, encaminha à gestão | **defeito**: a promoção por prioridade (`FIELD_OBSERVATION_SOURCE_PRIORITY`) substitui automaticamente sempre que a nova prioridade for ≥, **sem essa exceção** para o caso em que o valor vigente veio de `manual_fallback` | **D15-B** |

### 31.5 — Empty Return antes da descarga
> Um Empty Return antes da descarga é inválido. Priora deve: impedir
> fechamento automático; registrar uma inconsistência; enviar o caso para a
> gestão; enviar o caso para verificação de tracking. Preservar a observação
> bruta recebida para auditoria, mas não promovê-la como retorno efetivo
> válido até resolução.

**Código real hoje:** existe um estado `INVALID` em `relogios` que, por
construção, mantém o lifecycle em `INDETERMINADA`/pendência de dados
(bloqueia fechamento de forma indireta, via o gate geral de fechamento que
exige ausência de `INDETERMINADA`). A observação bruta já é preservada
(ledger append-only `field_observations`). **Porém** não existe: um registro
de inconsistência nomeado e consultável como artefato próprio; envio
explícito a gestão; envio explícito para verificação de tracking. Como o
Blueprint exige os quatro efeitos como conjunto, e três dos quatro não
existem como mecanismo observável, **este caso é reclassificado de "coberto
estruturalmente" (como constava em `84ccb34`) para não coberto.**
**Classificação: D15-B** (bloqueio indireto de fechamento já existe e deve
ser preservado; faltam os três efeitos explícitos).

### 31.6 — Empty Return retroativo (tardio)
> Quando o armador reporta depois um Empty Return retroativo: usar a data do
> evento para fechar os relógios operacionalmente; recalcular a apuração;
> preservar os cálculos anteriores no histórico; uma minuta válida, quando
> recebida, prevalece como a data final de fechamento. **Este é um evento
> tardio válido, não automaticamente uma violação de cronologia.**

**Código real:** hoje não há distinção entre "Empty Return tardio mas
cronologicamente válido" (este caso) e "Empty Return antes do Gate Out"
(violação real, ver 31.7/E-chronology abaixo) — ambos passam pelo mesmo
caminho de promoção por prioridade sem checagem de ordem de eventos.
O comportamento de recalcular e preservar histórico já existe genericamente
(pipeline de `recalcularApuracao.ts` + append-only de `valores_apurados`),
mas **a modelagem explícita deste caso como "válido por padrão, sujeito
apenas a prevalência de minuta posterior"** não existe — é indistinguível,
no código atual, de uma violação de cronologia. **Classificação: D15-B**
(precisa existir como caminho positivo e separado da pendência de cronologia
de §4/R39-R40).

### 31.7 — Mudança retroativa de tracking
> Mudanças retroativas: recalculam relógios e valores enquanto o processo
> está aberto; permanecem registradas em histórico; nunca modificam
> silenciosamente um processo concluído; exigem reabertura autorizada por
> gestor quando afetam financeiramente um processo concluído.

Desdobrado em dois subcasos pela própria condição do Blueprint ("enquanto o
processo está aberto" vs. "processo concluído"):

| Subcaso | Código real | Classificação |
|---|---|---|
| (a) processo OPEN: recalcula relógios/valores, mantém histórico | `recalcularApuracao.ts` já recalcula via pipeline transacional único; `valores_apurados`/`relogios` append-only preservam histórico | **COB** |
| (b) processo FINAL: nunca modifica silenciosamente, exige reabertura autorizada | **defeito central**: `recalcularApuracao.ts` trata FINAL como NO-OP e devolve `skipped`, que o chamador trata como sucesso — não há sinalização nem exigência de reabertura | **D15-A** |

### 31.8 — Tabela tarifária incompleta
> Nunca selecionar uma tarifa semelhante por aproximação. Os dias continuam
> sendo apurados, enquanto o valor permanece indisponível ou provisório
> conforme o status da tabela tarifária. Tabelas parciais permanecem
> `ESTIMATED_PROVISIONAL` até validação.

**Código real:** `bracketEngine.ts` nunca aproxima — gap de faixa produz
`UNAVAILABLE`; o motor nunca busca "a faixa mais próxima". A nomenclatura
`ESTIMATED_PROVISIONAL` já existe como uma das formas de
`valores_apurados` e é usada exatamente para tabela com validade não
comprovada (`TARIFF_VERSION_NOT_PROVEN`). Os dias são sempre apurados
independentemente do status monetário (relógios e valores são domínios
separados). **Classificação: COB.**

### 31.9 — Tipo de contêiner não reconhecido
> Preservar o código original, manter os relógios ativos e bloquear apenas a
> seleção de tarifa. Um gestor aprova um novo mapeamento antes do cálculo
> definitivo.

**Código real:** `demurrage_pendencias` tipo `tipo_nao_reconhecido`; código
original preservado (não sobrescrito); relógios continuam normalmente;
apenas a seleção de tarifa fica bloqueada até resolução. **Classificação: COB.**

### 31.10 — Moedas diferentes
> Manter moedas diferentes separadas. Nunca produzir um total combinado sem
> taxa de câmbio, data e fonte explícitas.

**Código real:** `moeda` é campo por linha de `valores_apurados`; não existe
nenhum caminho de código que some valores de moedas diferentes em um total
único — a mistura de moeda dentro do mesmo cálculo de faixa hoje lança
exceção (comportamento a corrigir por ser um abort de transação inteira, não
por produzir total incorreto — ver §6/R29). Nenhuma conversão automática de
câmbio existe em lugar algum do código. **Classificação: COB** quanto ao
enunciado do Blueprint (nunca combina moedas sem taxa/data/fonte); o defeito
do abort de transação é tratado separadamente em D15-C (R29) por ser um
problema de robustez, não de regra de negócio.

### 31.11 — Divergência financeira HeadCargo
> Divergência financeira é informação de gestão. Demurrage exibe o estado do
> HeadCargo, mas não altera cobrança, pagamento ou saldo, e não retorna o
> processo à fila operacional só por isso. **Deferir este item para a fase
> de integração externa.**

O próprio Blueprint determina o deferimento. **Classificação: DEFER
(integração externa)** — nenhuma integração HeadCargo existe neste
repositório; nada a implementar em D15.

### 31.12 — Reabertura de processo concluído
> Exige MANAGER ou outro papel explicitamente autorizado; justificativa;
> histórico preservado; valores anteriores retidos para comparação.

**Código real:** o mecanismo existe (`reaberturas`,
`autorizarReabertura`/`solicitarReabertura`, histórico append-only em
`valores_apurados`/snapshots), mas com defeitos de integridade: RBAC
resolvido pelo papel informado pelo chamador em vez de membership real;
fluxo não-transacional; sem proteção contra solicitação/reabertura
duplicada. O enunciado literal do Blueprint ("exige MANAGER... justificativa
... histórico preservado") é atendido em espírito, mas não com a robustez
transacional/RBAC que o próprio sistema já aplica em outros fluxos (ex.:
decisão de responsabilidade). **Classificação: D15-A.**

### 31.13 — Tracking suspenso após 30 dias
> Tracking automático para conforme o Capítulo 16. O processo permanece
> aberto. Gestores podem realizar atualizações manuais de tracking sujeitas
> ao cooldown aprovado.

Desdobrado porque o código cobre uma parte e deixa a outra sem ponto de
entrada:

| Subcaso | Código real | Classificação |
|---|---|---|
| (a) suspensão automática após 30 dias, processo permanece aberto | `MAX_AUTOMATIC_TRACKING_WINDOW_REACHED` em `cadencePolicy` | **COB** |
| (b) atualização manual por gestor sob cooldown aprovado | `podeAtualizarManual` (MANAGER/ADMIN, cooldown de 2h) **existe como função pura, mas sem nenhum serviço ou caminho de chamada** — função órfã, nunca invocada | **D15-B** (expor como função de serviço chamável, sem rota pública — consistente com a decisão de permanecer em nível de serviço) |

### 31.14 — Minuta divergente do tracking
> Quando uma minuta válida contém uma data diferente do tracking: preservar
> as duas evidências; usar a data da minuta como `effective_return_date`
> para o fechamento final; se isso mudar um processo concluído ou gerar
> custo, enviar o caso à gestão para reabertura e revisão. **Não modelar a
> divergência como simples rejeição.**

**Código real:** para processo OPEN, `minutaValidation.ts` já usa a data da
minuta validada como `effective_return_date` (comportamento correto, já
alinhado ao enunciado). Para processo **FINAL**, se a data validada diverge
da data congelada, o código hoje **apenas retorna `exige_reabertura` sem
registrar evento/pendência** — não há um registro formal de que "a minuta
diverge do tracking e por isso a reabertura foi exigida", e a evidência de
tracking não é explicitamente preservada lado a lado com a evidência da
minuta no mesmo registro consultável. Isso não é "modelar como rejeição
simples" — é pior: não modela a divergência como artefato algum. **Correção
necessária:** registrar a divergência (ambas as evidências) antes/junto do
`exige_reabertura`, e usar esse registro para rotear à gestão.
**Classificação: D15-A.**

## 4. Registro consolidado de casos e contagens

O registro completo (66 casos, cobrindo as subseções do Capítulo 31 — já
detalhadas em §3 — mais as áreas 1–10 do escopo mandatório de investigação)
está tabulado abaixo. Todas as contagens de §1 e §9 derivam exatamente desta
tabela — nenhum número é estimado separadamente.

### 4.1 Mapeamento de desdobramento em relação à revisão anterior (47 → 66)

A revisão anterior (`84ccb34`) contava 47 casos porque fundia em uma única
linha subcasos que o texto exato do Blueprint trata separadamente:
31.4 (1 linha → 4 linhas, R04–R07), 31.5 (1 linha, reclassificada, R08),
31.6/31.7 (fundidos em "evento retroativo" → 3 linhas distintas, R09–R11),
31.13 (1 linha → 2 linhas, R17–R18), 31.14 (1 linha, agora com defeito
preciso, R19). O restante do registro (R20–R66) preserva a substância da
revisão anterior, com reclassificação onde uma decisão antes pendente agora
está fixada (§2).

### 4.2 Registro (R01–R19 = Capítulo 31, detalhado em §3; R20–R66 = demais áreas mandatórias)

| ID | Caso | Área | Classificação |
|---|---|---|---|
| R01–R19 | Ver §3 (Capítulo 31 completo) | Blueprint Cap. 31 | 12 COB · 6 D15 (1-A, 5-B) · 1 DEFER |
| R20 | Master FT ausente | 1 | COB |
| R21 | House FT ausente | 1 | COB |
| R22 | Tipo de contêiner ausente (sem observação) | 1 | COB |
| R23 | Armador ausente | 1 | COB |
| R24 | Armador não cadastrado | 1 | COB |
| R25 | MBL/alvo de tracking ausente | 1 | COB |
| R26 | Tarifa do cliente indisponível (condição comercial ausente) | 1, 7 | D15-B |
| R27 | Tarifa/faixa do armador indisponível (gap) | 7 | COB |
| R28 | Overlap de faixas tarifárias | 7 | D15-C |
| R29 | Moeda mista aborta toda a transação de apuração | 7 | D15-C |
| R30 | Tabela/faixa tarifária mutável após uso (imutabilidade/versionamento/hash) | 7 | D15-C |
| R31 | Valor zero de tarifa válido vs. valor negativo rejeitado | 7 | COB |
| R32 | Confirmação de cobrança do armador substituindo estimativa | 7 | DEFER (integração) |
| R33 | Valor desatualizado com relógio fresco / valor fresco com relógio desatualizado | 7 | COB |
| R34 | Mais de um motor comercial ativo / motor ausente | 7 | COB |
| R35 | Conflito Master×SI (divergência de Free Time) | 1, 2 | COB |
| R36 | Conflito apenas entre fontes House (sem Master) | 1, 2 | D15-B |
| R37 | Conflito de mesma fonte (`conflitoMesmaFonte`) não persistido | 1, 2 | D15-B |
| R38 | Divergência de referência do armador (`mismatchCarrier`) não persistida | 1, 6 | D15-B |
| R39 | Gate Out antes da descarga | 2 | D15-B |
| R40 | Empty Return antes do Gate Out (violação real, distinta de 31.6) | 2 | D15-B |
| R41 | Observação da mesma fonte: a mais antiga chegando depois não substitui a mais nova já selecionada | 2, 8 | D15-B |
| R42 | Associação ambígua de VesselCall (`identidade_ambigua`) | 6 | COB |
| R43 | POD divergente mesma autoridade (`pod_divergente`) | 6 | COB |
| R44 | Rollback para VesselCall anterior por evento tardio/cache | 6 | D15-B |
| R45 | `atracacao_ambigua` nunca resolvida (órfã permanente) | 6, 10 | D15-B |
| R46 | Tracking individual obrigatório após descarga de destino | 6 | COB |
| R47 | Multi-contêiner: contêiner crítico nunca escondido por um concluído | 5 | COB |
| R48 | Multi-contêiner: moedas/FT diferentes por contêiner no mesmo processo | 5 | COB |
| R49 | Rodada compartilhada de VesselCall com uma referência falha (fencing, 2 tentativas) | 6, 8 | COB |
| R50 | `applyObservation` sem lock/transação na ingestão | 8 | D15-B |
| R51 | `validarMinuta` não-transacional | 3, 8 | D15-A |
| R52 | `finalizarProcesso` sem trava/condição atômica (double-finalize) | 4, 8 | D15-A |
| R53 | `autorizarReabertura` não-transacional, sem checagem de estado/duplicidade | 4, 8 | D15-A |
| R54 | RBAC de fechamento/reabertura resolvido por papel informado pelo chamador, não por membership | 4, 9 | D15-A |
| R55 | Reconhecimento/resolução de divergência de FT sem RBAC/motivo obrigatório | 9 | D15-B |
| R56 | `tipo_selecao_sem_observacao` nunca resolvida (órfã permanente) | 10 | D15-B |
| R57 | Linhas presas em `PROCESSING` na última tentativa (`recalculo_outbox`, avisos fallback, entregas FT) | 8 | D15-C |
| R58 | Outbox pós-commit sem teto de tentativas | 8 | D15-C |
| R59 | Entrega de alerta de tracking sem claim (double-send) | 8 | D15-C |
| R60 | Exposição ao CLIENT (Rocket interna, diferença potencial, evidência de responsabilidade, incidentes, erros técnicos) | 9 | COB |
| R61 | Vocabulário de status inconsistente entre artefatos de pendência | 10 | D15-B |
| R62 | Entrada manual de descarga (decisão fixada: permanece proibida) | 1 | COB |
| R63 | Sugestão de possível responsabilidade (depende de Liberação) | — | DEFER (integração) |
| R64 | ETA/chegada antecipada | 6 | IMPOSSÍVEL sem fonte externa |
| R65 | Exposição a rotas públicas de mutação para ações excepcionais | — | DEFER (frontend) |
| R66 | Exposição ao Portal do Cliente | — | DEFER (Portal) |

### 4.3 Totais

| Classificação | Quantidade |
|---|---|
| Já corretamente coberto (COB) | **29** |
| D15-A (integridade de estado final e reabertura) | **7** |
| D15-B (integridade de dados e exceções) | **18** |
| D15-C (integridade tarifária e recuperação) | **6** |
| Subtotal D15 (A+B+C) | **31** |
| Deferido à integração externa | **3** |
| Deferido ao frontend | **1** |
| Deferido ao Portal | **1** |
| Impossível sem fonte externa | **1** |
| Subtotal deferido/impossível | **6** |
| **Total de casos revisados** | **66** |

29 + 31 + 6 = 66. Nenhuma decisão de negócio bloqueante resta associada a
qualquer linha deste registro, exceto a lacuna isolada em §10 (que afeta
R08/31.5 apenas no detalhe do mecanismo, não na classificação do caso).

## 5. Bloco D15-A — Integridade de estado final e reabertura

**Casos cobertos por este bloco:** R11 (31.7b), R16 (31.12), R19 (31.14),
R51, R52, R53, R54. **7 casos.**

**Objetivo:** nenhuma mudança material em processo FINAL é aceita ou
rejeitada sem rastro; fechamento e reabertura passam a ser transacionais,
travados e resolvidos por papel real de membership.

**Trabalho proposto:**

1. `recalcularApuracao.ts`: substituir o NO-OP silencioso em processo FINAL
   por um caminho que registra o fato recebido (nova entrada de auditoria,
   reaproveitando o padrão de `closing_events`) e devolve `exige_reabertura`
   controlado — **sem mutar** relógio/valor/projeção FINAL.
2. `closing/minutaValidation.ts` + `closingService.ts`: ao validar minuta com
   data divergente da congelada em processo FINAL, registrar evento com
   **ambas** as evidências (data da minuta e data do tracking) antes de
   devolver `exige_reabertura`.
3. `closingService.validarMinuta`: unificar em uma única transação
   (`marcarValidada` + atualização de contêiner + eventos + enfileiramento de
   recálculo).
4. `closingService.finalizarProcesso`: `UPDATE ... WHERE apuracao_status =
   'OPEN'` condicional dentro de transação com advisory lock por processo;
   elimina double-finalize concorrente.
5. `closingService.autorizarReabertura`/`solicitarReabertura`: transação
   única, advisory lock por processo, verificação de reabertura já aberta
   (impede duplicidade).
6. RBAC: resolver papel por membership real (padrão já usado em
   `decidirResponsabilidade.ts`) em vez de aceitar `papel` do chamador;
   tornar ator (quem executa) obrigatório, não opcional.

## 6. Bloco D15-B — Integridade de dados e exceções

**Casos cobertos por este bloco:** R05, R07, R08, R09, R18, R26, R36, R37,
R38, R39, R40, R41, R44, R45, R50, R55, R56, R61. **18 casos.**

**Objetivo:** cada exceção de dado tem um caminho de resolução determinístico
e nenhuma observação mais forte é descartada ou sobrescrita silenciosamente.

**Trabalho proposto:**

1. Histórico de tentativas de Free Time (31.4b): nova tabela satélite
   append-only ligada a `demurrage_pendencias` (fonte, timestamp da
   tentativa, resultado, evidência sanitizada); projeção expõe a última
   tentativa por pendência.
2. Promoção com fallback manual vigente (31.4d): ao promover uma nova
   observação sobre um valor atualmente `manual_fallback`, não substituir
   diretamente — abrir divergência (mecanismo generalizado do item 5) e
   notificar gestão, preservando o valor manual até decisão.
3. Empty Return antes da descarga (31.5): registrar inconsistência nomeada
   (novo tipo em `demurrage_pendencias`), bloquear fechamento
   explicitamente (não só via `INDETERMINADA` indireto) e rotear à gestão —
   o mecanismo de "verificação de tracking" fica isolado como item de
   decisão residual (§10).
4. Empty Return retroativo válido (31.6): caminho positivo distinto da
   pendência de cronologia — recalcula, preserva histórico, aceita
   prevalência posterior de minuta (reaproveita item 1 de D15-A quando
   aplicável a processo FINAL).
5. Generalização do mecanismo de divergência (`ft_divergencias` →
   divergência por campo/fonte): permite modelar conflito House-only,
   conflito de mesma fonte (`conflitoMesmaFonte`) e `mismatchCarrier` sem
   criar artefatos novos por tipo.
6. Pendência de cronologia (Gate Out < descarga; ER < Gate Out): novo tipo
   em `demurrage_pendencias`; preserva evidência bruta; bloqueia a promoção
   downstream afetada; nunca cria incidente técnico a menos que o
   processamento em si tenha falhado.
7. Recência de observação de mesma autoridade: `applyObservation`/
   `applyObservationComClient` passam a comparar `observado_em` como
   critério de desempate dentro da mesma prioridade — observação mais
   antiga da mesma fonte chegando depois não substitui a mais nova já
   selecionada (permanece no ledger).
8. Pendência para condição comercial ausente (31.4 contexto de tarifa):
   novo tipo em `demurrage_pendencias`.
9. Rollback por evento tardio de VesselCall anterior: checagem de recência
   em `vesselCallRepository.associarContainer` antes de rolar associação.
10. Resolução de `atracacao_ambigua` e `tipo_selecao_sem_observacao`: definir
    e implementar caminho de resolução (hoje ambas são excluídas de
    `resolverPendencias` ou nunca alcançadas por nenhum chamador).
11. `applyObservation` (variante sem client/lock): adicionar transação e
    lock equivalentes à variante `ComClient`.
12. Atualização manual de tracking por gestor (31.13b): expor
    `podeAtualizarManual` como função de serviço chamável (sem rota
    pública).
13. RBAC/motivo obrigatório em `divergenciaAvisos.ts`
    (`reconhecerDivergencia`/`resolverDivergencia`): resolver `usuario` por
    membership real; tornar motivo obrigatório na resolução.
14. Normalização leve de vocabulário de status entre artefatos de pendência
    (sem criar tabela universal) — apenas documentação/mapeamento de
    leitura, para eliminar a inconsistência G-A8 vs. fila (D14).

## 7. Bloco D15-C — Integridade tarifária e recuperação

**Casos cobertos por este bloco:** R28, R29, R30, R57, R58, R59. **6 casos.**

**Objetivo:** tabela tarifária imutável e versionada conforme o escopo de
versionamento tarifário exigido pelo usuário (abaixo), e filas/outboxes sem
linhas presas indefinidamente.

**Escopo de versionamento tarifário (obrigatório, conforme determinado):**

- versões de tabela ativadas/usadas não podem ser editadas ou apagadas;
- o conteúdo das faixas (`tariff_brackets`) participa do hash de input do
  cálculo (hoje `calcularInputHashValor` o exclui — correção necessária);
- correções criam nova versão de tabela, nunca edição in-loco;
- cálculos históricos retêm tabela e versão usadas no momento;
- faixas sobrepostas são rejeitadas (constraint/validação, não apenas
  "primeiro match" silencioso);
- lacunas de faixa continuam `UNAVAILABLE` ou provisórias conforme a
  qualidade da fonte (comportamento já correto, preservado);
- uma nova versão nunca recalcula automaticamente processos FINAL
  históricos.

**Demais correções deste bloco:**

- `bracketEngine.ts`: moeda mista produz falha localizada (`UNAVAILABLE` ou
  erro por linha) em vez de abortar a transação de apuração inteira do
  processo.
- `recalculo_outbox`, `demurrage_fallback_manual_avisos`,
  `ft_divergencia_entregas`: reclaim cobre também a linha presa em
  `PROCESSING` após crash na última tentativa (hoje só reclama enquanto
  `tentativas < max`).
- `demurrage_pos_commit_outbox`: adicionar teto de tentativas com estado
  terminal visível.
- `tracking_alert_deliveries`: adicionar claim/token de posse para impedir
  envio duplicado por instâncias concorrentes do scheduler.

## 8. Migrations por bloco (estimativa, nenhuma executada)

| Bloco | Migration proposta | Justificativa |
|---|---|---|
| D15-A | nenhuma migration de schema nova identificada — o trabalho é de transação/lock/RBAC em código de serviço | os estados (`fechamentos`, `reaberturas`, `closing_events`) já existem; falta unicidade em `reaberturas` (abaixo) |
| D15-A | unicidade parcial em `reaberturas` (uma `SOLICITADA`/`AUTORIZADA` aberta por processo) + coluna de ator obrigatória | impedir reabertura duplicada (item 5 de D15-A) |
| D15-B | nova tabela satélite append-only para tentativas de fonte de Free Time (fonte, tentativa_em, resultado, evidência sanitizada, pendência_id) | decisão fixada: "append-only satellite table", nunca JSONB sobrescrito |
| D15-B | novos tipos em `demurrage_pendencias`: inconsistência de Empty Return pré-descarga, pendência de cronologia (Gate Out/ER), condição comercial ausente, `mismatchCarrier` | decisões fixadas (§2); evita tabela de exceção universal, reaproveita o artefato existente |
| D15-B | generalizar `ft_divergencias` (ou colunas que hoje assumem Master×SI) para registrar o par de fontes/campo em conflito genericamente | suporta conflito House-only e `conflitoMesmaFonte` sem novo artefato |
| D15-B | coluna de recência (`observado_em`) já existe em `field_observations` — **sem migration**, apenas lógica de comparação no código de promoção | nenhuma mudança de schema necessária para o item 7 de D15-B |
| D15-B | coluna de resolução/autor para `atracacao_ambigua`/`tipo_selecao_sem_observacao` (ou reaproveitar colunas já existentes em `vessel_call_pendencias`/`demurrage_pendencias`) | permitir fechamento auditável desses tipos órfãos |
| D15-C | remover/substituir a unicidade ineficaz de `tariff_tables` (hoje `UNIQUE(organization_id, tipo, armador_id, termo_comercial, versao)` não funciona com colunas NULL) por `NULLS NOT DISTINCT` ou constraint equivalente, mais trigger de imutabilidade pós-ativação | base para versionamento obrigatório |
| D15-C | exclusion constraint (ou trigger de validação) em `tariff_brackets` para rejeitar faixas sobrepostas por tabela/equipamento | item do escopo de versionamento tarifário |
| D15-C | coluna(s) de teto de tentativas em `demurrage_pos_commit_outbox` | estado terminal visível em vez de retry infinito |
| D15-C | coluna(s) de claim/token em `tracking_alert_deliveries` | impedir envio duplicado |

Nenhuma migration consolida os artefatos existentes em uma tabela de
exceção universal — cada uma estende um artefato já existente com colunas ou
constraints pontuais, preservando a granularidade atual (confirmado
necessário caso a caso, não por padrão).

## 9. Gates e testes de aceitação por bloco

### D15-A

| Gate | Critério |
|---|---|
| GA1 | Nenhuma mudança material pós-FINAL muta relógio/valor/projeção FINAL sem reabertura autorizada; toda tentativa gera registro auditável. |
| GA2 | `validarMinuta`, `finalizarProcesso`, `autorizarReabertura` executam em transação única com lock/condição atômica. |
| GA3 | RBAC de fechamento/reabertura resolvido por membership real; nenhum teste consegue elevar papel via payload. |
| GA4 | Nenhuma reabertura duplicada é possível para o mesmo processo simultaneamente. |

**Testes obrigatórios:** (1) correção de descarga/FT/tipo/tracking em
processo FINAL gera evento auditável e nunca muta a projeção FINAL; (2)
minuta validada com data diferente da congelada em processo FINAL registra
evento com ambas evidências antes de `exige_reabertura`; (3) duas chamadas
concorrentes a `finalizarProcesso` produzem exatamente um fechamento; (4)
duas chamadas concorrentes a `autorizarReabertura` não duplicam reabertura
aberta; (5) crash simulado entre `marcarValidada` e atualização de contêiner
não deixa `effective_return_date` desalinhada sem reparo; (6) ANALYST não
consegue finalizar/reabrir informando `papel: 'MANAGER'` no payload.

### D15-B

| Gate | Critério |
|---|---|
| GB1 | 31.5 atende aos quatro efeitos exigidos (bloqueio, inconsistência registrada, gestão notificada, tracking roteado — mecanismo de roteamento conforme §10). |
| GB2 | 31.6 e 31.7(a) são tratados por caminho distinto de pendência de cronologia — nenhum Empty Return tardio válido é rejeitado como violação. |
| GB3 | Nenhuma observação mais forte ou mais nova é descartada silenciosamente; toda substituição de fallback manual gera divergência visível. |
| GB4 | Nenhum tipo de pendência conhecido permanece estruturalmente irresolvível sem justificativa documentada. |

**Testes obrigatórios:** (7) Empty Return antes da descarga bloqueia
fechamento, registra inconsistência nomeada e aparece em leitura de
pendência de gestão; (8) Empty Return retroativo válido recalcula e não é
classificado como violação de cronologia; (9) Gate Out antes da descarga
cria pendência de cronologia e bloqueia a promoção afetada sem criar
incidente técnico; (10) observação antiga da mesma fonte chegando depois de
uma mais nova já selecionada não a substitui; (11) nova fonte mais forte
chegando sobre valor `manual_fallback` não substitui diretamente — gera
divergência; (12) `atracacao_ambigua` e `tipo_selecao_sem_observacao`
sintéticas são resolvidas (ou documentadamente mantidas abertas por regra
explícita) por um fluxo testável; (13) `conflitoMesmaFonte` e
`mismatchCarrier` são persistidos e aparecem em leitura de pendências.

### D15-C

| Gate | Critério |
|---|---|
| GC1 | Nenhuma versão de tabela tarifária ativada/usada é editável; correção sempre gera nova versão. |
| GC2 | Hash de input do cálculo muda quando o conteúdo da faixa muda. |
| GC3 | Faixas sobrepostas são rejeitadas na escrita, não silenciosamente resolvidas na leitura. |
| GC4 | Nenhuma linha de outbox/fila fica presa em `PROCESSING`/`PENDING` indefinidamente sem visibilidade terminal. |
| GC5 | Nenhum alerta de tracking é entregue duas vezes por concorrência de instâncias. |

**Testes obrigatórios:** (14) editar/apagar uma versão de tabela tarifária
ativada é rejeitado; (15) correção de faixa gera nova versão e novo hash de
input, recalculando apenas processos ainda OPEN; (16) processo FINAL
histórico permanece com os valores da versão original após nova versão ser
criada; (17) faixas sobrepostas são rejeitadas na criação; (18) moeda mista
produz falha localizada sem abortar a apuração completa do processo; (19)
linha de `recalculo_outbox`/aviso presa em `PROCESSING` após crash simulado
na última tentativa é reclamada; (20) outbox pós-commit com teto de
tentativas atinge estado terminal visível; (21) dois alertas concorrentes
não duplicam entrega.

### Comum a todos os blocos

- Zero-regressão: fingerprint de todas as tabelas tocadas por D10–D14
  idêntico antes/depois de cada rota de leitura.
- Suíte completa (engine, gestão, UI, V1) 100% verde ao final de cada
  bloco, antes de iniciar o próximo.
- Nenhum valor financeiro pendente/indisponível é convertido a zero em
  nenhum código introduzido por qualquer bloco.

## 10. Comportamento exato: observação bruta vs. fato selecionado/promovido

Esta distinção atravessa várias seções do Blueprint (31.4d, 31.5, 31.6,
31.7, 31.14) e precisa de uma regra única e consistente:

1. **Toda observação recebida é preservada** em `field_observations`
   (append-only, já existente) — isso vale mesmo para a observação que
   causa uma violação de cronologia (31.6/31.7) ou que é inválida por
   definição (Empty Return antes da descarga, 31.5). **Nenhum bloco de D15
   altera essa garantia; todos os blocos dependem dela.**
2. **O fato selecionado/promovido** (o que vira `relogios`, `container_type_id`,
   `armador_id` etc.) só é atualizado quando a observação vence a promoção
   por prioridade **e**, a partir de D15-B, pelo critério de recência
   (`observado_em`) dentro da mesma prioridade, **e** não estiver sujeita a
   uma das exceções fixadas: (i) processo FINAL (bloqueia qualquer promoção
   de fato material — D15-A); (ii) valor atual vindo de `manual_fallback`
   sendo superado por fonte mais forte (abre divergência em vez de
   substituir — D15-B); (iii) violação de cronologia não resolvida
   (D15-B) — a observação fica registrada, mas não promovida, até a
   pendência de cronologia ou a inconsistência de Empty Return ser
   resolvida.
3. **Nenhuma observação bruta é apagada ou editada** em nenhum cenário —
   correções e reaberturas sempre produzem uma nova observação/decisão,
   nunca uma edição da anterior. Isso já é garantido estruturalmente hoje
   (ledgers append-only) e nenhum bloco de D15 o altera.
4. **A minuta é um caso especial de fato selecionado**: quando válida, sua
   data se torna `effective_return_date` (31.14), mas a evidência de
   tracking que ela eventualmente contradiz permanece preservada e
   consultável — nunca é substituída ou ocultada pela promoção da minuta.

## 11. Grafo de recálculo e invalidação (atualizado)

Idêntico em estrutura ao grafo da revisão anterior (relógios, valores,
responsabilidade, snapshot, elegibilidade de fechamento, lifecycle,
indicadores, timeline), com duas correções de comportamento agora fixadas:

- **Mudança em descarga/FT/tipo/retorno em processo FINAL:** antes
  "recalculado silenciosamente (NO-OP)"; agora, por decisão fixada,
  **bloqueado e registrado** — nenhum dos artefatos downstream (relógio,
  valor, snapshot, elegibilidade) é tocado até reabertura autorizada
  (D15-A).
- **Correção de tarifa/versão:** antes "sem gatilho dedicado para correção
  in-loco"; agora, por decisão fixada, **correção sempre cria nova versão**
  — processos FINAL existentes nunca recalculam automaticamente; processos
  OPEN recalculam normalmente na próxima passagem do pipeline, usando a
  nova versão (D15-C).

O restante do grafo (mudança de House/Master FT, tipo de contêiner,
decisão de responsabilidade, valor financeiro selecionado) permanece como
descrito na revisão anterior — nenhuma dessas trilhas foi alterada pelo
texto exato do Capítulo 31 ou pelas decisões fixadas nesta rodada.
Confirma-se, como antes, que o outbox/scheduler repara corretamente o que
foi de fato enfileirado, mas não repara a janela entre leitura e escrita que
antecede o enfileiramento em fluxos não-transacionais — essa janela é
exatamente o que D15-A fecha.

## 12. Matriz de concorrência, permissões e auditoria

Mantida em relação à revisão anterior nos pontos não afetados pelo
Capítulo 31 exato (registro de processo, ingestão de SI, rodada de
VesselCall, decisão de responsabilidade, outbox pós-commit — ver `84ccb34`
§8–§9 para o detalhe linha a linha). As linhas alteradas pela revisão são:

- `applyObservation`/promoção de observação: ganha critério de recência
  (R41/D15-B) e exceção de fallback manual (R07/D15-B) — ver §10.
- Fechamento/reabertura: RBAC passa a ser resolvido por membership real,
  não por payload (R54/D15-A).
- Divergência de FT: RBAC e motivo passam a ser obrigatórios na resolução
  (R55/D15-B).
- Confirmação da regra de exposição ao CLIENT (R60) permanece congelada e
  verificada: nenhuma rota V2 de Demurrage/Gestão expõe dados internos a
  CLIENT (403 confirmado); nenhuma correção de D15 altera essa garantia.

## 13. Áreas congeladas (explícitas)

Sem alteração nesta entrega, e sem alteração planejada em nenhum bloco de
D15:

- Regras de criação de decisão de responsabilidade (D11), incluindo a
  invalidação por trigger já existente.
- Cálculo de tarifa Rocket por data de descarga, termo embarque/único
  (D9/D10) — D15-C versiona a tabela, não a regra de seleção de termo.
- Contrato de leitura de Gestão e Indicadores D14 v1.3.
- Toda a UI (D13).
- Todas as 34 migrations existentes (nenhuma alterada; apenas novas
  propostas em §8).
- RBAC de leitura (D11/D12) — CLIENT 403 confirmado.
- Mecanismo de fencing de rodada compartilhada de VesselCall (`epoca`).
- Tracking individual obrigatório pós-descarga de destino.

## 14. Dependências externas deferidas (atualizado)

| Dependência | Casos afetados | Classificação |
|---|---|---|
| HeadCargo | 31.11 (R15) — o próprio Blueprint determina o deferimento | DEFER integração |
| Fonte financeira de custo real confirmado | R32 | DEFER integração |
| Módulo Liberação | R63 (sugestão de responsabilidade) | DEFER integração |
| Portal do Cliente | R66 | DEFER Portal |
| Frontend / rotas de ação | R65 — decisão fixada: D15 permanece em nível de serviço | DEFER frontend |
| Provedor de tracking (ETA) | R64 | Impossível sem fonte externa |

Nenhum comportamento desses módulos foi inferido ou fabricado.

## 15. Decisões eliminadas pelo Blueprint / fixadas pelo usuário

As dez decisões bloqueantes da revisão anterior (`84ccb34`, §18: D-1, D-9,
D-11, D-12, D-14, D-15, D-17, D-21, D-27, D-28, D-30) foram **todas**
resolvidas — nove pelo texto exato do Capítulo 31 e pela lista de "Decisions
fixed for D15" fornecida pelo usuário nesta rodada (ver §2 para a resolução
aplicada de cada uma). Nenhuma delas é reaberta nesta revisão.

## 16. Decisão genuinamente indeterminada remanescente

Apenas **uma** lacuna de projeto permanece sem determinação suficiente no
texto do Blueprint ou nas decisões fixadas:

**D-R1 — Mecanismo de "encaminhar o caso para verificação de tracking"
(31.5).** O Blueprint exige que um Empty Return antes da descarga seja
"enviado para verificação de tracking", mas não especifica se isso significa
(a) disparar automaticamente uma nova tentativa de busca de tracking para o
alvo afetado na próxima janela do scheduler, (b) apenas deixar a pendência
visível para um ANALYST verificar manualmente o tracking, ou (c) ambos.
Isso tem consequência de implementação real: (a) exigiria um gatilho novo no
scheduler reaproveitando o mecanismo de busca já existente; (b) não exigiria
nenhum código de scheduler, apenas a pendência nomeada (já proposta em
D15-B item 3).

**Recomendação:** adotar (c) — a pendência nomeada (visível e resolvível por
ANALYST/MANAGER) **e**, adicionalmente, uma tentativa automática de
reconciliação de tracking na próxima janela do scheduler, reaproveitando o
mecanismo de busca já existente (sem criar um caminho de busca novo). A
pendência permanece aberta até resolução humana mesmo que a tentativa
automática não produza uma data consistente — a verificação automática é
um auxílio, não uma resolução por si só. Esta recomendação não foi
implementada; aguarda confirmação antes de entrar no detalhamento de D15-B.

## 17. Status final

- **Nenhum código de produção, migration, rota ou teste foi alterado nesta
  entrega.** Apenas este documento foi revisado.
- **D15-A não foi implementada.** A implementação não começa até aprovação
  explícita desta revisão.
- **D16 não foi iniciada.**
