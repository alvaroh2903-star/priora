# Fase D15-A v1.2 (corretiva) — Ordem Universal de Lock em Todo Chamador de Produção e Replay Sem Escrita de uma Observação Já Selecionada

> **Status:** correção de dois achados de auditoria sobre a implementação
> D15-A v1.1 (commit `bbb4d0a`). **D15-A continua NÃO aprovada e NÃO
> congelada.** Entrega para NOVA auditoria. D15-B, D15-C e D16 **não foram
> iniciadas**. Nenhuma mudança em frontend, Portal do Cliente, HeadCargo,
> Liberação, Auditoria, Courier, cadência/crédito de tracking, motores
> tarifários ou regras de negócio congeladas de D10–D14. Nenhuma rota nova,
> nenhum escopo de produto novo.

## 1. Achado #1 — a ordem universal de lock ainda era violada por chamadores

### 1.1 Causa raiz (duas, não uma)

**Causa raiz A — `registrarProcessoDemurrage.aplicar`:** a função tomava
`FOR UPDATE` em `processos` (para descobrir/travar o processo) **antes** de
qualquer um dos escritores de Free Time ser chamado — e só esses escritores
(`promoverHouseFreeTimeComClient`/`promoverMasterFreeTimeComClient`), mais
abaixo na mesma função, tentavam o lock consultivo de fechamento. Era
exatamente a ordem inversa de `finalizarProcesso` (lock consultivo primeiro,
linha depois) — o par clássico de uma corrida ABBA: `aplicar` prende
`processos`, tenta o consultivo; `finalizarProcesso` prende o consultivo,
tenta `processos`/`containers`.

**Causa raiz B — `recalcularApuracaoContainerComClient` (descoberta pelo
teste de corrida determinística desta versão, não prevista no escopo
original do achado):** mesmo depois de corrigida a causa raiz A, o teste de
corrida obrigatório continuou produzindo um **deadlock real do Postgres**
(`40P01`). O log do servidor mostrou o ciclo exato:

```
Process 1396 (finalizarProcesso) espera ShareLock, bloqueado por 1391.
Process 1391 espera ShareLock, bloqueado por 1396.
Process 1396: SELECT ... FROM containers WHERE processo_id = $1 ORDER BY id FOR UPDATE
Process 1391: UPDATE processos SET estado_mais_relevante = $2, ... WHERE id = $1
```

`1391` era o **reparo pós-commit** de `registrarProcessoDemurrage`
(`repararPosCommitOutbox` → `recalcularApuracaoContainer`, autônomo, SEM
nenhum lock consultivo) — uma transação **separada**, que só começa **depois**
que a transação principal de `aplicar` já comitou (por isso a correção da
causa raiz A não a protegia: ela nem existe mais quando o reparo pós-commit
roda). Dentro dela, `recalcularApuracaoContainerComClient` grava
`relogios`/`valores_apurados` e, via
`LifecycleRepository.derivarContainerEConsolidar`, também `containers`
(estado do contêiner) e só então `processos` (consolidação de prioridade,
`estado_mais_relevante`/`container_lider_id`) — ou seja, trava **contêiner
primeiro, processo depois**, a ordem EXATAMENTE inversa de
`finalizarProcesso` (processo primeiro, contêiner depois). Esta função é
chamada por `eventIngestion` e pelo próprio reparo pós-commit sem nenhum
lock consultivo — uma segunda via de deadlock, independente da primeira, e
que só a execução real do teste obrigatório revelou.

### 1.2 Correção de cada causa raiz

**A — `registrarProcessoDemurrage.aplicar`:** reescrito o passo de
descoberta/criação do processo (ver §1.3) para adquirir o lock consultivo
**antes** do `FOR UPDATE` em `processos`, e antes de qualquer chamada aos
escritores de Free Time ou a `fatoMaterialBloqueadoPorFinal` (bloco de tipo
de equipamento).

**B — `recalcularApuracaoContainerComClient`:** passou a adquirir
`lockProcesso` logo depois de descobrir `processo_id` (leitura inicial, sem
lock de linha) e **antes** de qualquer `UPDATE`/gravação —
`relogios`/`valores_apurados`/`containers`/`processos`. Como consequência,
o guard de FINAL (que antes lia `apuracao_status` da MESMA consulta inicial,
feita antes do lock) foi corrigido para **reler** `apuracao_status`
**depois** do lock — se a chamada ficou esperando o lock enquanto
`finalizarProcesso` comitava concorrentemente, a leitura original já estava
obsoleta; sem a releitura, a função tentaria gravar `relogios` de um
processo que já virou FINAL, rejeitada pelo trigger do banco (migrations
0017/0018) e reportada como falha do reparo pós-commit
(`PosCommitIncompletoError`) em vez de um skip limpo. Esta função é chamada
tanto por quem JÁ segura o lock (`finalizarProcesso`, `validarMinuta`,
`autorizarReabertura`, via `recalcularApuracaoContainerComClient`/
`recalcularApuracaoProcessoComClient`) — onde o novo `lockProcesso` é um
no-op seguro na mesma sessão — quanto por quem NÃO segura (o caminho
autônomo `recalcularApuracaoContainer`, usado por `eventIngestion` e pelo
reparo pós-commit) — onde agora ele estabelece a proteção que faltava.

### 1.3 Protocolo de descoberta do processo em `registrarProcessoDemurrage.aplicar`

Descobrir o `processoId` de um registro **novo** exige o próprio `INSERT` —
não há como travar "antes" de um recurso que ainda não existe. Protocolo:

1. descobre **sem** lock de linha mutável se o processo já existe
   (`SELECT id FROM processos WHERE organization_id = $1 AND numero_processo = $2`);
2. **existe** → lock consultivo (`lockProcesso`) AGORA, antes de qualquer
   `FOR UPDATE`;
3. **não existe** → tenta criar via `INSERT ... ON CONFLICT DO NOTHING
   RETURNING id`:
   - **criou** (RETURNING devolveu a linha): processo GENUINAMENTE NOVO — a
     linha não está comitada, logo é invisível a QUALQUER outra transação
     por MVCC; nenhuma operação de fechamento pode referenciar um
     `processoId` que nenhuma outra transação além desta já viu, então
     nenhuma reabertura/finalização concorrente é possível para ele ainda.
     O lock é adquirido mesmo assim, só por uniformidade do protocolo
     (barato — nunca disputado neste ramo);
   - **não criou** (0 linhas): perdemos a corrida de criação — outra
     transação já tinha o MESMO (organização, número) comitado ANTES de o
     nosso `INSERT` devolver (o próprio `INSERT` bloqueia no índice único
     enquanto a outra transação está em aberto; só devolve "0 linhas"
     depois que ela já comitou ou abortou) — uma releitura sem lock agora
     SEMPRE a vê;
4. em QUALQUER ramo, só depois do lock consultivo é que `processos` é relido
   com `FOR UPDATE` (status fresco, nunca uma leitura anterior ao lock) e o
   guard `PROCESSO_FINAL` é avaliado.

O lock de REGISTRO (`demurrage:processo:<org>:<numero>`/
`demurrage:container:<org>:<numero>`, namespace próprio, exclusivo desta
função) continua sendo adquirido **primeiro**, antes de tudo — nenhum outro
código do sistema usa esse namespace, então essa ordem nunca participa de
um ciclo: só esta função toma o lock de registro, e só depois de tomá-lo é
que ela tenta o consultivo — uma segunda chamada de registro concorrente
para o MESMO processo já fica bloqueada aí, antes mesmo de disputar o
consultivo.

## 2. Grafo de lock — antes e depois

### 2.1 Antes (v1.1, achado #1 ainda presente)

```
registrarProcessoDemurrage.aplicar:
  lock registro (demurrage:processo:…)
  → FOR UPDATE processos               ◄── linha ANTES do consultivo
  → [campos do processo]
  → por contêiner:
      → fatoMaterialBloqueadoPorFinal (tipo de equipamento)
      → promoverHouseFreeTimeComClient  → lockProcesso (SÓ AQUI, tarde demais)
      → promoverMasterFreeTimeComClient → lockProcesso (idem)
  → COMMIT
  → repararPosCommitOutbox (NOVA transação, SEM nenhum lock consultivo)
      → recalcularApuracaoContainer
          → relogios/valores_apurados
          → LifecycleRepository: UPDATE containers, DEPOIS UPDATE processos

finalizarProcesso:
  lockProcesso (PRIMEIRO)
  → FOR UPDATE processos
  → FOR UPDATE containers
  → recalcularApuracaoContainerComClient (relogios/valores/containers/processos)
```

Dois ciclos possíveis: `aplicar` (processos→consultivo) × `finalizarProcesso`
(consultivo→processos); e o reparo pós-commit (containers→processos, SEM
consultivo) × `finalizarProcesso` (processos→containers).

### 2.2 Depois (v1.2)

```
registrarProcessoDemurrage.aplicar:
  lock registro (demurrage:processo:…)                 ◄── namespace próprio, sempre 1º
  → descobre processoId SEM lock de linha (§1.3)
  → lockProcesso                                        ◄── SEMPRE antes de qualquer FOR UPDATE
  → FOR UPDATE processos (status fresco)
  → [campos do processo]
  → por contêiner:
      → fatoMaterialBloqueadoPorFinal (tipo de equipamento)  — lock já detido
      → promoverHouseFreeTimeComClient  → lockProcesso (no-op, já detido)
      → promoverMasterFreeTimeComClient → lockProcesso (no-op, já detido)
  → COMMIT (libera o lock consultivo)
  → repararPosCommitOutbox (NOVA transação)
      → recalcularApuracaoContainer
          → lockProcesso                                ◄── NOVO (achado #1-B)
          → relê apuracao_status FRESCO, sob o lock      ◄── NOVO (evita o skip tardio)
          → relogios/valores_apurados/containers/processos

finalizarProcesso / validarMinuta / autorizarReabertura:
  lockProcesso (PRIMEIRO, inalterado)
  → FOR UPDATE processos → FOR UPDATE containers/minutas/reaberturas
  → recalcularApuracaoContainerComClient → lockProcesso (no-op, já detido)
```

Toda operação, sem exceção, adquire o lock consultivo **antes** de qualquer
`FOR UPDATE`/`UPDATE` em `processos`/`containers`/`minutas`/`reaberturas` —
eliminando os dois ciclos.

## 3. Auditoria de todo chamador de produção

Enumeração completa (idêntica à registrada em `materialChangeGuard.ts`,
`CHAMADORES_AUDITADOS_COM_CLIENT`), verificada por um teste estático que
varre o código-fonte e confere que o conjunto de chamadores encontrado é
EXATAMENTE este — um chamador novo sem auditoria falha o teste:

| Função | Chamador | Por que é seguro |
|---|---|---|
| `applyObservationComClient` | `ContainerRepository.applyObservation` (mesmo arquivo) | Wrapper autônomo — abre `BEGIN`/`COMMIT` próprios, nenhum lock de linha pré-existente. |
| `applyObservationComClient` | `houseFreeTimeService.ts` → `promoverHouseFreeTimeComClient` | Delega inteiramente — nunca toma `FOR UPDATE` antes de delegar. |
| `promoverHouseFreeTimeComClient` | `registrarProcessoDemurrage.aplicar` | **Corrigido nesta versão** — `lockProcesso` adquirido no passo 3, antes do `FOR UPDATE` em `processos` e antes desta chamada. |
| `promoverHouseFreeTimeComClient` | `ingestaoShippingInstructions.ts` → `aplicarIntencoes` | Nunca toma `FOR UPDATE` em `processos`/`containers` antes — o único `FOR UPDATE` anterior é em `si_versoes` (tabela/namespace não relacionado). |
| `promoverMasterFreeTimeComClient` | `masterFreeTimeService.ts` → `promoverMasterFreeTime` (mesmo arquivo) | Wrapper autônomo — `BEGIN`/`COMMIT` próprios. |
| `promoverMasterFreeTimeComClient` | `registrarProcessoDemurrage.aplicar` | Mesma correção acima. |
| `promoverMasterFreeTimeComClient` | `ingestaoShippingInstructions.ts` → `aplicarIntencoes` | Mesma razão acima. |
| `fatoMaterialBloqueadoPorFinal` | `containerRepository.ts` → `applyObservationComClient`, passo 7 | `lockProcesso` já adquirido no passo 2 da MESMA função. |
| `fatoMaterialBloqueadoPorFinal` | `masterFreeTimeService.ts` → `promoverMasterFreeTimeComClient`, passo 7 | Mesma razão. |
| `fatoMaterialBloqueadoPorFinal` | `registrarProcessoDemurrage.aplicar`, bloco de tipo de equipamento | **Corrigido nesta versão** — mesma causa raiz A. |

`closingService.ts` não chama nenhuma das quatro funções diretamente (usa
`registrarFatoMaterialPosFinal`, fora do escopo auditado aqui — já
implementa o protocolo universal desde a v1.1). `eventIngestion.ts` só
chama o wrapper autônomo `ContainerRepository.applyObservation` (nunca
`...ComClient` diretamente), que abre sua própria transação — por
definição livre de lock pré-existente.

Cada uma das três funções `*ComClient` e `fatoMaterialBloqueadoPorFinal` tem
uma PRECONDIÇÃO documentada no próprio código (JSDoc) que nenhuma delas pode
verificar em runtime: o chamador não pode ter tomado `FOR UPDATE` em
`processos`/`containers`/`minutas`/`reaberturas` deste processo antes de
chamá-las sem primeiro ter chamado `lockProcesso`. As três `*ComClient`
estabelecem o protocolo completo toda vez que são chamadas (nunca assumem
que o lock já está retido) — por isso são seguras tanto "a frio" quanto
depois de o próprio chamador já ter adquirido o consultivo (no-op). O único
caso que nenhuma verificação em runtime pode corrigir é o chamador ter
tomado a linha ANTES do consultivo — coberto pela auditoria estática acima,
não por uma checagem dinâmica (decisão registrada e justificada: dado o
custo/risco de introspecção de locks via `pg_locks` dentro da própria
transação, a auditoria estática + o teste de corrida determinística dão a
mesma garantia com muito menos superfície de regressão).

## 4. Teste de corrida determinística (achado #1) — evidência

Dois testes, pelo contrato REAL (`registrarProcessoDemurrage`, não pelo
repositório direto), cobrindo House E Master Free Time no MESMO contêiner:

- **Registro vence:** o registro (correção de House/Master FT para 25 dias)
  é pausado logo depois de travar `processos` (lock consultivo + `FOR
  UPDATE` já adquiridos) e antes de tocar qualquer Free Time.
  `finalizarProcesso` concorrente tenta o MESMO lock consultivo e fica
  bloqueado no Postgres até o registro comitar. Depois da liberação:
  registro comita primeiro (House/Master FT = 25), `finalizarProcesso`
  comita depois, incorporando os novos valores — `ok: true` para os dois,
  zero eventos `FATO_MATERIAL_POS_FINAL`.
- **Fechamento vence:** `finalizarProcesso` é pausado imediatamente antes
  do `COMMIT` (FINAL já escrito na transação, lock consultivo ainda
  retido). O registro concorrente (mesma correção) fica bloqueado no MESMO
  lock. Depois da liberação: `finalizarProcesso` comita primeiro (processo
  agora FINAL); o registro, ao finalmente conseguir o lock, relê
  `apuracao_status = 'FINAL'` sob lock e rejeita com `PROCESSO_FINAL` — a
  regra congelada de D10 que impede registrar em processo FINAL (nenhuma
  mudança nesta regra). House/Master FT permanecem em 20 (valor original);
  nenhum estado parcial.

Os dois são a prova empírica dos dois resultados aceitos pela especificação
("registro vence e o fechamento incorpora os valores promovidos" ou
"fechamento vence e a tentativa concorrente é rejeitada sem nenhum valor
promovido") — em NENHUM dos dois um valor material é promovido depois de
FINAL sem reabertura.

**Evidência do deadlock antes da correção (achado #1-B):** antes de corrigir
`recalcularApuracaoContainerComClient`, o teste "registro vence" produzia um
erro real do Postgres (`40P01 deadlock detected`), com o ciclo exato citado
em §1.1. Depois da correção, o mesmo teste roda de forma determinística —
repetido 3 vezes consecutivas nesta entrega, sempre verde, sem nenhum
`deadlock detected` nem `lock_timeout`.

## 5. Achado #2 — replay de uma observação já selecionada não deve escrever

### 5.1 Causa raiz

A correção da v1.1 (`promover = !conflito` em vez de `if (criada)`)
corrigiu corretamente o caso "replay de uma tentativa BLOQUEADA por FINAL"
(precisa reavaliar a decisão, nunca pular). Mas essa mudança também fez o
`UPDATE` de projeção rodar de novo para o caso "replay de uma observação JÁ
SELECIONADA" (`!criada`, sem conflito, e a observação já é exatamente a
apontada pela coluna de proveniência do contêiner) — nada mudou, mas a
linha era reescrita (mesmo valor, `atualizado_em` tocado) a cada
reprocessamento.

### 5.2 Máquina de estados do replay (contrato exato)

| Caso | Condição | `outcome` | `exigeReabertura` | Escreve? |
|---|---|---|---|---|
| **Fato novo** | `criada = true` | avalia prioridade; `'promovida'` ou `'registrada_sem_promover'`; `'bloqueada_final'` se FINAL e vencedora | `true` sse `'bloqueada_final'` | sim, se promove |
| **Já selecionada** | `!criada`, sem conflito, `c.obs_id === observacao.id` | `'promovida'` | `false` | **NÃO** — nenhum `UPDATE`, `atualizado_em` intocado, sem outbox, sem evento, sem recálculo |
| **Bloqueada por FINAL, reprocessada (ainda FINAL)** | `!criada`, sem conflito, NÃO selecionada, processo FINAL | `'bloqueada_final'` | `true` | evento preservado, nunca duplicado (dedupe por conteúdo) |
| **Bloqueada por FINAL, reprocessada (depois de reabertura)** | igual acima, mas processo agora OPEN | reavalia prioridade; promove se ainda vencedora | `false` se promoveu | sim, exatamente uma vez |
| **Conflito de mesma fonte** | `!criada`, valor divergente do já registrado no mesmo instante/fonte | `'registrada_sem_promover'` (nunca `'promovida'`, mesmo que `c.obs_id` aponte para a observação conflitante) | `false` | não — preserva o histórico, nunca promove silenciosamente |

O curto-circuito "já selecionada" é verificado **antes** de qualquer
decisão de prioridade/FINAL — por isso nunca interfere com os outros casos
(que continuam sendo decididos exatamente como na v1.1). Implementado em
`ContainerRepository.applyObservationComClient` e, mirrorado, em
`promoverMasterFreeTimeComClient` (mesma estrutura, nomes de variável
distintos). `promoverHouseFreeTimeComClient` herda o comportamento sem
código algum — delega inteiramente, e `valorAnterior === valorSelecionado`
no caso "já selecionada" já faz `valorMudou = false` no seu próprio cálculo
(nenhum outbox enfileirado). A divergência SI×Master em
`promoverMasterFreeTimeComClient` É reavaliada no caminho "já selecionada"
(leitura idempotente, documentada — nunca escreve quando as observações
subjacentes não mudaram) para que o campo `divergencia` sempre reflita o
estado atual ao chamador; a prova de que isso nunca escreve está no
fingerprint (§6). A ingestão de tracking (`eventIngestion.ts`) não precisou
de nenhuma mudança de código — herda o contrato correto automaticamente
através de `ContainerRepository.applyObservation`.

## 6. Evidência de fingerprint — replay é NO-OP estrito

Três testes (descarga genérica, House Free Time, Master Free Time), cada um
com DUAS fases (processo OPEN e depois FINAL), comparam um fingerprint
COMPLETO do contêiner antes × depois do replay de uma observação já
selecionada:

```
containers (linha inteira, incl. atualizado_em) · field_observations ·
closing_events · recalculo_outbox · ft_divergencias · ft_divergencia_eventos
· ft_divergencia_entregas · relogios · valores_apurados
```

Em TODOS os seis casos (3 campos × 2 estados), `assert.deepStrictEqual`
confirma: os dois snapshots são byte-a-byte idênticos — nenhum `UPDATE`,
nenhum `atualizado_em` novo, nenhuma linha nova em nenhuma tabela derivada.
Para popular `relogios`/`valores_apurados` com dados REAIS (não vazios)
antes do teste, o cenário é semeado pelo contrato real
(`registrarProcessoDemurrage`) seguido de um recálculo explícito — o replay
testado depois é que precisa provar não tocar em nada disso.

Um sétimo teste encadeia a máquina de estados inteira num só contêiner:

1. submissão inicial de uma correção de descarga em processo FINAL →
   `'bloqueada_final'`, 1 evento `FATO_MATERIAL_POS_FINAL`;
2. replay #1 da MESMA tentativa (ainda FINAL) → continua `'bloqueada_final'`,
   **ainda 1 evento** (nunca duplicado), projeção intocada;
3. reabertura solicitada e autorizada → processo volta a OPEN;
4. replay #2 da MESMA tentativa (agora OPEN) → `'promovida'`, projeção
   agora reflete a correção — promovida **exatamente uma vez**;
5. replay #3 (um terceiro reenvio, agora depois de já promovida) →
   `'promovida'`, `exigeReabertura: false`, e fingerprint completo
   **idêntico** ao estado pós-promoção — NO-OP estrito.

## 7. Arquivos alterados (exatos)

### Novos

| Arquivo | Conteúdo |
|---|---|
| `src/demurrage-engine/__tests__/closingD15AV12.test.ts` | Os 7 testes desta versão (§4, §6, auditoria estática). |
| `docs/demurrage-fase-d15-a-v1-2.md` | Este documento. |

### Alterados — produção

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/registro/registrarProcessoDemurrage.ts` | `aplicar` reescrito: lock consultivo adquirido antes do `FOR UPDATE` em `processos`, com o protocolo de descoberta/criação do processo (§1.3). Novo gancho `_testeAntesDoFreeTime` (só teste). |
| `src/demurrage-engine/apuracao/recalcularApuracao.ts` | `recalcularApuracaoContainerComClient` adquire `lockProcesso` logo depois de descobrir `processo_id`, antes de qualquer gravação; guard de FINAL agora relê `apuracao_status` fresco, sob o lock. |
| `src/demurrage-engine/closing/materialChangeGuard.ts` | Novo `CHAMADORES_AUDITADOS_COM_CLIENT` (registro estático de todo chamador de produção, §3) e precondição documentada em `fatoMaterialBloqueadoPorFinal`. Cabeçalho ampliado com o relato dos dois achados desta versão. |
| `src/demurrage-engine/persistence/containerRepository.ts` | `applyObservationComClient`: curto-circuito NO-OP para observação já selecionada (achado #2, §5.2); precondição documentada no JSDoc (achado #1). |
| `src/demurrage-engine/freeTime/masterFreeTimeService.ts` | `promoverMasterFreeTimeComClient`: mesmo curto-circuito, mirrorado; mesma precondição documentada. |
| `src/demurrage-engine/freeTime/houseFreeTimeService.ts` | Só documentação (herda o comportamento correto sem mudança de código) + precondição documentada. |

Nenhuma rota, nenhum arquivo de frontend, nenhum motor tarifário, nenhuma
regra de cadência/crédito de tracking foi tocado. Nenhuma trigger de banco
nova.

## 8. Migrations

**Nenhuma migration foi criada ou editada.** Migration `0035` permanece
intocada. Os dois achados desta versão são puramente de ORDEM DE EXECUÇÃO
(lock) e de LÓGICA DE DECISÃO (replay) — nenhum deles exige nova estrutura
de dados, nova constraint ou novo índice. O guard de FINAL em `relogios`/
`valores_apurados` (migrations 0017/0018, já existentes) continua sendo a
defesa de banco em profundidade, inalterada.

## 9. Totais de teste — regressão completa

Executado sequencialmente contra PostgreSQL 16 real
(`DEMURRAGE_TEST_DATABASE_URL`/`DEMURRAGE_DATABASE_URL`/`DATABASE_URL` →
`priora_demurrage_test`), nenhum teste pulado:

| Suíte | Resultado |
|---|---|
| D15-A v1.0 (`closingD15A.test.ts`) | **16/16**, preservados sem alteração |
| D15-A v1.1 (`closingD15AV11.test.ts`) | **14/14**, preservados sem alteração |
| D15-A v1.2 (`closingD15AV12.test.ts`) | **7/7** |
| `closing.test.ts` (fechamento/minuta/reabertura base) | **21/21** |
| D10 (`registroDemurrage*.test.ts`) | **69/69** |
| Shipping Instructions (`shippingInstructions.test.ts`) | **32/32** |
| Suíte completa da Demurrage Engine (`npm run test:demurrage-engine` — inclui D10/D11/D12/D14/D15-A completo/SI e todo o restante) | **849/849**, 0 falhas, 0 pulados |
| V1 (`npm test`) | **25/25** |
| D13 UI (`npm run test:demurrage-ui`) | **66/66** |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

O teste de corrida "registro vence" (achado #1) foi executado 3 vezes
consecutivas de forma isolada, sempre verde, para confirmar que a correção
do deadlock (achado #1-B) é determinística e não um acaso de timing.

## 10. O que esta entrega NÃO faz

- Não declara D15-A aprovada nem congelada.
- Não inicia D15-B, D15-C ou D16.
- Não adiciona rota, ação de frontend ou escopo de produto novo.
- Não edita a migration `0035`. Não cria migration nova (justificado em §8).
- Não altera nenhuma regra de negócio congelada de D10–D14 (o guard
  `PROCESSO_FINAL` de `registrarProcessoDemurrage`, por exemplo, continua
  rejeitando qualquer registro num processo FINAL — exercitado, não
  alterado, pelo teste "fechamento vence" de §4).

Entrega para nova auditoria.
