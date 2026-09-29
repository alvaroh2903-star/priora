# Fase D11 — Responsabilidade Rocket × Cliente (NÃO congelada)

> **Status:** entregue para auditoria. Gates G1–G7 implementados por completo.
> A D11 **não é declarada congelada**. Sem tela, sem rota pública, sem módulo
> Liberação. Base: D10 aprovada e congelada em `5c733a1`.

## O que existe agora

A responsabilidade pelo custo de demurrage — Rocket × cliente — passa a ter
uma **decisão versionada e auditável** (`responsabilidade_decisoes`,
migration `0031`), que substitui `containers.responsabilidade` como fonte de
verdade. A coluna do contêiner continua existindo, mas só como **projeção**
da decisão vigente, sob guarda de banco (migration `0032`).

### Dois universos temporais, nunca misturados

Cada decisão declara qual relógio sustentou os dias (`base_relogio`):

| Base | Quando se aplica | O que a decisão pode declarar |
|---|---|---|
| `RELOGIO_CLIENTE` | o relógio do cliente tem dias de demurrage (>0) | distribui os DIAS DO CLIENTE entre Rocket e cliente — `CONFIRMADA_CLIENTE`, `CONFIRMADA_ROCKET` ou `DIVIDIDA` |
| `RELOGIO_ROCKET` | cliente zero, só a exposição da Rocket tem dias | `CONFIRMADA_ROCKET` só com períodos CONCRETOS dentro do intervalo real do relógio Rocket — nunca "sem dias" |
| `NAO_APLICAVEL` | cliente zero, exposição só por diferença comercial de Free Time (Master < House) | `NAO_APLICAVEL` com `motivo_estruturado = DIFERENCA_COMERCIAL_FREE_TIME` — libera o gate de fechamento sem rotular a exposição como falha operacional |

O simples fato de a Rocket ter exposição perante o armador **nunca** produz
`CONFIRMADA_ROCKET` por conta própria — só o Gestor, com períodos concretos,
justificativa e evidência.

### Financeiro

A distribuição financeira incide **só sobre o valor comercial do cliente**
(base `RELOGIO_CLIENTE`). Cada dia conserva a diária da sua posição
cronológica **original** na tabela do cliente — nenhuma faixa reinicia. Isso
é feito **sem reabrir nenhum motor tarifário**: `responsabilidade/valoracao
PorDia.ts` só expande o `faixas_aplicadas` já persistido do valor ativo do
cliente (gravado pelo `bracketEngine` desde a Fase 4) em uma diária por dia,
na ordem cronológica em que os dias ocorreram. Rocket + cliente sempre bate
com o total do cliente (verificado antes de gravar; divergência → `valor_
status = INDISPONIVEL`, nunca um número aproximado).

Em `RELOGIO_ROCKET`/`NAO_APLICAVEL` não há valor comercial do cliente a
apurar (`valor_status = NAO_APLICAVEL`) — a exposição da Rocket ao armador
permanece **separada, íntegra e nunca dividida ou alterada** pela decisão.

### Granularidade e integridade

- `responsabilidade_decisao_periodos`: os períodos DECLARADOS pelo Gestor.
- `responsabilidade_decisao_dias`: a expansão dia a dia, `PRIMARY KEY
  (decisao_id, dia)` — impede duplicata/sobreposição do mesmo dia por
  construção do banco.
- Trigger de INSERT (`0031`) valida, antes de gravar: processo não FINAL,
  autoridade do autor (MANAGER/ADMIN, papel lido `FOR SHARE`), coerência da
  base com os relógios reais, intervalo de apuração fechado (`data_final_
  apuracao` do relógio-base == devolução efetiva) e sequência de versão
  (`substitui`/`versao` corretos).
- Trigger de dia (`0031`) valida que cada dia está DENTRO do intervalo real
  do relógio-base.
- Constraint trigger ADIADA (`0031`) valida, ao COMMIT, que os dias gravados
  batem exatamente com `dias_rocket`/`dias_cliente` e — só em `RELOGIO_
  CLIENTE` — cobrem TODO o relógio do cliente, sem buraco.

### Guarda de projeção + invalidação automática (migration `0032`)

- `containers.responsabilidade`/`responsabilidade_decisao_id` só podem
  projetar exatamente a decisão VIGENTE (maior versão) daquele contêiner —
  qualquer escrita direta incompatível (`UPDATE containers SET
  responsabilidade = ...` fora do serviço) é **rejeitada pelo banco**
  (`PROJECAO_INCOMPATIVEL`). Não existe bypass de produção.
- Se o relógio-base muda depois (nova minuta, novo tracking, reabertura +
  recálculo) e o `input_hash` do relógio já não bate com o que a decisão
  vigente registrou em `base`, a projeção volta a `NULL` (== `EM_ANALISE`
  via `derivarResponsabilidade`, Fase 8) e um evento `RESPONSABILIDADE_
  INVALIDADA` é registrado — nunca mantém, silenciosamente, uma decisão que
  não reflete mais os fatos.

### Linha do tempo (aditivo)

Três tipos novos em `closing_events`: `RESPONSABILIDADE_CONFIRMADA`,
`RESPONSABILIDADE_CORRIGIDA`, `RESPONSABILIDADE_INVALIDADA`. Cada um
referencia versão da decisão, autor e motivo no `payload` — nunca o payload
documental bruto.

### Fotografia (alteração aditiva autorizada em `registro/fotografia.ts`)

`fatos.responsabilidade` só existe quando há uma decisão selecionada
(`undefined`, nunca `null`, quando não há — `jsonEstavel` filtra chaves
`undefined`, então o hash de um contêiner **sem** decisão permanece
idêntico ao de antes da D11). Guarda: id/versão, status, relógio-base, dias
Rocket/cliente, valores (quando aplicável), justificativa, referência da
evidência, autor, data da decisão e indicação de correção/supersessão. Uma
correção sempre gera nova versão de fotografia; o histórico anterior nunca é
reescrito.

### Momento da decisão

Proibido decidir antes da devolução efetiva (`ANTES_DA_DEVOLUCAO`) e antes
de o intervalo de apuração do relógio-base estar fechado (`INTERVALO_
ABERTO`). Sem módulo Liberação: nenhuma sugestão automática, nenhum período
fabricado — decisão só por MANAGER/ADMIN, com períodos, justificativa e
evidência (ver Gate G7 abaixo).

### Serviço (`responsabilidade/decidirResponsabilidade.ts`)

Em UMA transação: lock consultivo por contêiner, validação pura (forma,
coerência, expansão dos períodos — `responsabilidade/contrato.ts`), leitura
dos fatos reais (processo, contêiner, relógios, autor), valoração por dia
(só em `RELOGIO_CLIENTE`), INSERT decisão + períodos + dias, projeção no
contêiner, evento de timeline, upsert do outbox pós-commit da D10 (reusado
sem alteração). Fora da transação: `repararPosCommitOutbox` (recálculo
idempotente + fotografia) — o mesmo mecanismo durável da D10; uma falha aqui
nunca perde a decisão já commitada, o tick existente repara.

Nenhum caminho de produção grava `containers.responsabilidade` fora deste
serviço — os testes congelados da D8/D10 que faziam `UPDATE` direto foram
convertidos, mecanicamente, para criar a decisão pelo próprio serviço
(`__tests__/responsabilidadeTestHelper.ts`).

### Gate G7 — porta da Liberação (sem o módulo)

`responsabilidade/liberacaoPort.ts`: `NullLiberacaoPort` é o adaptador
vigente (sempre diz que não há sugestão disponível). `sugerirResponsabilidade`
é uma função PURA que, dados eventos de uma futura timeline da Liberação,
devolve uma sugestão por interseção — nunca fabrica período, nunca escreve
nada e não é chamada por nenhum caminho automático hoje. `decidirResponsabi
lidade` não tem nenhum atalho de "confirmar sugestão": só aceita períodos
declarados explicitamente pelo Gestor.

## O que NÃO mudou

Auditoria, Courier, Liberação, Portal, HeadCargo, tracking, Free Time,
motores tarifários (`bracketEngine`, `termoPorEmbarqueEngine`,
`termoUnicoEngine`, `exposicaoRocketEngine`), minuta e cadência — nenhum
arquivo alterado além da alteração aditiva autorizada em
`registro/fotografia.ts` e da extensão aditiva de `closing_events` (novos
tipos) e `containers` (nova coluna `responsabilidade_decisao_id`). O gate de
fechamento (`ClosingService.finalizarProcesso`) já lia `containers.
responsabilidade`/`derivarResponsabilidade` desde a Fase 8 — **nenhuma
alteração foi necessária ali**: a projeção da D11 já é a fonte que o gate
consome.

## Evidência (`__tests__/responsabilidadeDecisao.test.ts`, 25 testes, PostgreSQL real)

| Caso obrigatório | Teste |
|---|---|
| 1 | cliente com dias positivos, todos ao cliente → `CONFIRMADA_CLIENTE` |
| 2 | cliente com dias positivos, todos causados pela Rocket → `CONFIRMADA_ROCKET` (base `RELOGIO_CLIENTE`) |
| 3 | divisão 3+3 dias Rocket/cliente → `DIVIDIDA`, valores batem com o total do cliente |
| 4 | cliente zero, Rocket positivo, atraso comprovado → `CONFIRMADA_ROCKET` (base `RELOGIO_ROCKET`) |
| 5 | cliente zero, Rocket positivo só por diferença de Free Time → `NAO_APLICAVEL`/`DIFERENCA_COMERCIAL_FREE_TIME` |
| 6 | exposição Rocket positiva nunca produz responsabilidade Rocket automaticamente (fica `EM_ANALISE`) |
| 7 | decisão sem dias Rocket não pode declarar `CONFIRMADA_ROCKET` (`STATUS_INCOERENTE`, validação pura) |
| 8 | decisão antes da devolução é rejeitada (`ANTES_DA_DEVOLUCAO`) |
| 9 | data fora do relógio escolhido é rejeitada (`DIA_FORA_DA_BASE`) |
| 10 | alteração direta incompatível da projeção é rejeitada pelo banco (`PROJECAO_INCOMPATIVEL`) |
| 11 | correção cria nova versão, evento `RESPONSABILIDADE_CORRIGIDA` e nova fotografia |
| 12 | mudança no relógio invalida a decisão vigente (volta a `EM_ANALISE`) e registra `RESPONSABILIDADE_INVALIDADA` |
| 13 | fechamento permanece bloqueado sem decisão válida (`EM_ANALISE`) |
| 14 | fechamento é liberado com decisão válida |
| 15 | regressão completa da D10 e das fases congeladas (ver tabela de validação) |

Testes adicionais dos Gates G1–G7: autoridade (`AUTOR_NAO_AUTORIZADO`),
versão desatualizada (`VERSAO_DESATUALIZADA`), sobreposição de dias
(`SOBREPOSICAO`), cobertura incompleta (`LACUNA`), append-only da tabela de
decisões, correção em processo FINAL (`EXIGE_REABERTURA`), porta da
Liberação (G7 — pura, sem escrita, sem atalho de sugestão) e valoração por
dia (expansão de `faixasAplicadas` preservando a diária original).

Ajuste mecânico em testes congelados: `apuracao.test.ts`, `apuracaoV13.
test.ts` e `demurrageVertical.test.ts` — o `UPDATE containers SET
responsabilidade = ...` direto foi substituído por uma chamada ao serviço
real da D11 (`__tests__/responsabilidadeTestHelper.ts`), sem alterar o que
cada teste verifica.

## Validação

| Suíte | Aprovados | Falhos | Ignorados |
|---|---|---|---|
| Engine completa (PostgreSQL 16 real, `priora_test`) | 535 | 0 | 0 |
| — `responsabilidadeDecisao.test.ts` (G1–G7 + 15 casos) | 25 | 0 | 0 |
| — gates D10 (regressão): `apuracao`/`apuracaoV12`/`apuracaoV13`/`demurrageVertical`/`closing`/`registroDemurrage*`/`demurrageTickFilas` | todos | 0 | 0 |
| V1 | 25 | 0 | 0 |
| `tsc --noEmit` / `npm run build` | sem erros | — | — |

## Não fechado nesta entrega

- Módulo Liberação em si (rota, tela, timeline real) — deliberadamente fora
  de escopo (ajuste 8 aprovado). A porta (`liberacaoPort.ts`) e a função pura
  de sugestão existem, prontas, sem nenhuma automação ligada.
- Tela/rota pública de decisão — a decisão só existe hoje como serviço
  interno (`decidirResponsabilidade`), chamável por código de aplicação e
  pelos testes da engine.
