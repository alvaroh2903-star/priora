# Produção P1 — Reabertura controlada: correção de minuta, documento e encerramento automático

> **Estado: correção ENTREGUE PARA REVISÃO — NÃO congelada.** Este relatório
> não declara a correção congelada nem a Produção P1 novamente concluída.
> Autenticação global, administração tarifária, frontend e design **não**
> foram iniciados (§12, §13, §14). A revisão adversarial feita antes do
> commit e o que ela mudou estão em §15.

Reabertura controlada do backend da Produção P1 (Entregas 1, 2 e 3 congeladas),
como entrega corretiva de backend anterior ao frontend. Nenhum arquivo de
frontend, HTML, CSS, JavaScript de apresentação ou design foi alterado; o
handoff de entrada (rota, autenticação HMAC, idempotência e controle de
capacidade) não foi tocado.

---

## 1. Baseline

### 1.1 Ponto de partida confirmado

- Branch `claude/practical-cerf-mnz7oj`, HEAD remoto `d0c8569`
  ("Produção P1: congela o controle de capacidade do handoff"), árvore limpa
  (`git status --porcelain` vazio) antes de qualquer edição.
- Relatórios congelados lidos antes de editar: Entrega 1 (`entrega-1*.md`,
  `handoff-capacidade.md`), Entrega 2 (`entrega-2*.md` — catálogo de ações,
  tabela de idempotência, máquina de estados v1.2) e Entrega 3
  (`entrega-3*.md` — `/minutas`, `/reaberturas`, `/pendencias`, cursores
  keyset).

### 1.2 Defeitos reproduzidos no baseline (antes de qualquer correção)

Um teste de reprodução foi executado **sobre o código do baseline `d0c8569`**
(arquivo temporário, fora do commit; banco PostgreSQL 16.15 novo). Os seis
cenários passaram — isto é, cada defeito existia:

| # | Defeito | Evidência registrada no baseline |
|---|---|---|
| R1 | Analista não consegue tornar a minuta válida — exige aprovação de gestor | `validarMinuta(ANALYST)` → `{"ok":false,"motivo":"apenas_manager_admin"}`; minuta coerente fica `RECEBIDA` |
| R2 | Minuta sem devolução no tracking **fabrica** a devolução | após `validarMinuta`: `{"tracking_return_date":null,"effective_return_date":"2026-09-20"}` |
| R3 | Gestor **substitui** a data do tracking pela da minuta | `aceitarDivergencia:true` → `{"tracking_return_date":"2026-09-14","effective_return_date":"2026-09-18"}` |
| R4 | Nada encerra sozinho — finalização manual obrigatória | devolução dentro do Free Time → `apuracao_status = OPEN`; só `finalizarProcesso(MANAGER)` fecha |
| R5 | Processo FINAL continua na fila padrão e nos contadores | fila: `total = 1` com o processo FINAL (item sem `apuracaoStatus`); `/filtros`: `CONCLUIDO_PARA_ROCKET: 1` |
| R6 | Segunda minuta em processo FINAL viola o índice e devolve 500; item irremovível | serviço: `23505 minutas_validada_ativa_unica`; rota: `HTTP 500 {"resultado":"FALHA","detalhe":{"motivo":"BANCO_DADOS_RESTRICAO_INTEGRIDADE"}}`; `/minutas` padrão continua listando a minuta `RECEBIDA` com `podeValidar:true` |

Os mesmos cenários estão cobertos, já com a regra corrigida, pelos testes
de `src/demurrage-engine/__tests__/minutaEncerramentoP1.test.ts` (§10).

---

## 2. Divergências confirmadas (código congelado × regra de produto)

1. **Aprovação humana de minuta**: `ClosingService.validarMinuta` exigia
   MANAGER/ADMIN e tinha `aceitarDivergencia` — a regra é aceite técnico
   automático, sem gestor.
2. **Minuta escrevia a devolução**: `validarMinuta` gravava
   `containers.effective_return_date`/`effective_return_minuta_id` e
   recalculava pela data da minuta, inclusive sem tracking — a regra é
   tracking oficial, minuta nunca substitui nem fabrica devolução.
3. **Gate de FINAL** exigia minuta `VALIDADA` (humana) correspondente a
   `COALESCE(effective, tracking)`.
4. **Encerramento manual obrigatório**: nenhum caminho levava o processo a
   FINAL sem `POST /processos/:id/finalizar` (MANAGER/ADMIN).
5. **Substituição incorreta**: o ramo FINAL de `validarMinuta` gravava a
   segunda `VALIDADA` sem `supersedes_id` → violação de
   `minutas_validada_ativa_unica` → 500; a minuta ficava `RECEBIDA` para
   sempre na lista "aguardando validação".
6. **Fila**: `FilaItemV1` sem situação de apuração; a seleção de candidatos
   não filtrava `apuracao_status`; `/filtros` contava FINAL; o estado do
   contêiner ignora o FINAL do processo (FINAL com demurrage aparece como
   `DEVOLVIDO_AGUARDANDO_TRATAMENTO`, em balde ativo).
7. **Documento**: a rota de minuta só aceitava um texto livre
   (`evidenciaRef`); a tabela `documentos` (Fase 8) existia sem nenhum
   escritor.
8. **Contrato E3 `/minutas`**: padrão "RECEBIDA aguardando validação" com
   `podeValidar` — vocabulário de aprovação humana.

---

## 3. Decisões de produto aplicadas

| Regra | Implementação |
|---|---|
| Tracking é a devolução oficial | O fluxo novo nunca grava data em `effective_return_date` (só limpa a efetiva legada cuja minuta foi substituída — §7). A verificação técnica compara a data da minuta com `tracking_return_date`. Sem tracking, a minuta fica `RECEBIDA` (`aguardando = DEVOLUCAO_TRACKING`) — nunca fabrica devolução. Gate Out nunca é devolução (já era assim). O encerramento **automático** só conclui sobre a devolução do tracking: uma devolução efetiva legada (data de minuta aprovada no fluxo antigo) ausente do tracking ou diferente dele bloqueia o automático (`devolucao_efetiva_legada`) e mantém a semântica antiga — só o acionamento administrativo humano a encerra. |
| Minuta registrada pelo analista, sem gestor | `POST /containers/:id/minutas` aceita qualquer papel interno (membership real da sessão); `CLIENT` é barrado (G6) e o serviço resolve o ator sob lock (`ator_nao_autorizado`). |
| Só checagens técnicas automáticas | `avaliarMinutaTecnicamente` (pura): número do contêiner, data legível/válida (data impossível ou texto → `DATA_ILEGIVEL`, nunca 500), cronologia descarga/Gate Out, data futura, comparação exata com o tracking. |
| Coerente → aceita sem gestor | `ACEITA` + evento `MINUTA_ACEITA` (`origem = automatico`). `validada_por`/`data_validada` nunca são escritos (CHECK `minutas_fluxo_tecnico_sem_aprovacao_humana`). |
| Incoerente/divergente → pendência do analista | `INCONSISTENTE` → pendência `minuta_inconsistente`; `DIVERGENTE` → pendência `minuta_divergente_tracking`. Ambas resolvidas **automaticamente** quando uma minuta substituta coerente é registrada. Ficam **fora** do catálogo de resolução manual (resolver "à mão" deixaria a pendência fechada com a minuta ainda divergente). |
| Divergência bloqueia o contêiner, sem ação de gestor | Gate: minuta vigente `DIVERGENTE` → `divergencia_pendente`; `INCONSISTENTE` → `minuta_inconsistente`. Não existe "aceitar divergência". |
| Sem pendência bloqueante | Sem gestor no caminho, o gate recusa o que o próprio sistema marcou como fato do relógio ainda em dúvida: pendência aberta `retorno_vazio_antes_descarga`, `cronologia_retorno_antes_gate_out`, `conflito_mesma_fonte` ou `fallback_manual_superado` no contêiner → bloqueio `<tipo>_pendente` (automático **e** administrativo). Todas são resolvíveis pelo ANALISTA com motivo (catálogo da Entrega 2) e a resolução dispara a reavaliação. Fora, deliberadamente: Gate Out rejeitado (não é devolução nem entra no relógio), `free_time_ausente` (já deixa a apuração INDETERMINADA) e `ft_divergencias` (sem rota de resolução nesta entrega — bloquear travaria sem saída; §11). |
| Encerramento automático | `ClosingService.avaliarEncerramentoAutomatico` (§6). Contêiner sem demurrage (devolvido no Free Time) conclui sem minuta, tarifa, responsabilidade ou gestor. Com demurrage: devolução no tracking + minuta `ACEITA` contra o tracking atual + sem pendência/divergência bloqueante + responsabilidade decidida + valores `ESTIMATED`/`CONFIRMED` + demais gates congelados. Todos os contêineres elegíveis → FINAL na mesma transação. |
| Rota manual de finalização | **Mantida** como acionamento ADMINISTRATIVO restrito (MANAGER/ADMIN), idempotente (`ja_final`), que roda **a mesma** avaliação (nenhum gate contornado). Não é mais etapa obrigatória. Escolha mais segura e compatível: preserva o contrato da Entrega 2 e dá ao gestor um meio de antecipar a varredura; remover a rota não traria ganho de segurança (ela não tem atalho). |
| Rota de validação | **Removida** do serviço; a rota HTTP responde `410 {"error":"rota_removida"}` sem nenhuma leitura ou escrita (para todos, inclusive gestor). |
| Documento real | Mecanismo documental existente (`documentos`, Fase 8) passa a guardar a referência auditável (§8). |
| Estados | `RECEBIDA`, `ACEITA`, `DIVERGENTE`, `INCONSISTENTE`, `SUBSTITUIDA`; `VALIDADA`/`REJEITADA` só leitura de legado. Nenhum nome de estado automático sugere aprovação de gestor. |
| FINAL fora da fila ativa | Filtro de processo `apuracaoStatus` (padrão `OPEN`), item com `apuracaoStatus`/`fechadoEm`/`encerramento`, `/filtros` só conta a visão ativa (§9). |
| Segunda minuta | Substitui a vigente (estado `SUBSTITUIDA` + vínculo), índice novo `minutas_vigente_unica`, idempotente, nunca 500 (§5). |
| "Fila da equipe" | Fila, `/filtros` e `/minutas` declaram `escopo: "fila_da_equipe"`; nenhuma lista diz "aguardando você" (§12). |

---

## 4. Arquivos e migrations

### 4.1 Migration (aditiva — nenhuma migration aplicada foi reescrita)

`src/demurrage-engine/db/migrations/0048_minuta_aceite_tecnico_encerramento_automatico.sql`

- `documentos`: colunas `organization_id`, `minuta_id`, `versao_minuta`,
  `referencia_armazenamento`, `nome_arquivo`, `tipo_conteudo`,
  `tamanho_bytes`, `hash_conteudo`, `incluido_por_membership_id`; FKs
  compostas (contêiner/processo × organização); CHECK
  `documentos_minuta_coerente`; índice único por minuta; trigger
  **append-only**.
- `minutas`: CHECK de estado ampliado; colunas `regra_avaliacao`, `versao`,
  `substituida_por_id` (FK **adiável**), `substituida_em`,
  `data_tracking_comparada`, `aguardando`, `fatos_avaliacao`, `avaliada_em`;
  CHECKs de coerência por estado; índice único `minutas_vigente_unica`
  (fluxo técnico, não substituída); `minutas_versao_unica`; índices de
  varredura e da lista "exige ação"; **constraint trigger adiável**
  `minutas_exige_documento` (nenhuma minuta do fluxo técnico comita sem
  documento).
- `demurrage_pendencias`: tipos `minuta_inconsistente`,
  `minuta_divergente_tracking`.
- `closing_events`: tipos `MINUTA_ACEITA`, `MINUTA_DIVERGENTE`,
  `MINUTA_INCONSISTENTE`, `MINUTA_SUBSTITUIDA`.
- `fechamentos.origem` (`humano` padrão — toda linha existente veio do fluxo
  humano antigo — | `automatico`), CHECKs de autoria (`automatico` sem autor;
  `humano` com autor, `NOT VALID` para não revalidar legado).
- `processos.encerramento_avaliado_em`, `encerramento_bloqueio`,
  `encerramento_bloqueio_container_id` + índice da varredura.

Nenhuma linha existente é reescrita pela migration (provado em
`P1 #18b`: upgrade 0047 → 0048 com minutas legadas preservadas; reexecução
no-op).

### 4.2 Código

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/closing/minutaTecnica.ts` (novo) | Fluxo ÚNICO de registro: lock do processo, ator real, idempotência, substituição, documento, aceite técnico, pendência, fato material pós-FINAL, re-derivação documental — uma transação. `reavaliarMinutasDoProcesso`. |
| `src/demurrage-engine/closing/minutaValidation.ts` | `avaliarMinutaTecnicamente` (pura) sobre a checagem estrutural existente. |
| `src/demurrage-engine/closing/closingService.ts` | `validarMinuta` removido; `registrarMinuta` delega ao fluxo único e avalia o encerramento; gate único `gateEncerramentoComClient`; núcleo único `encerrarSeElegivel`; `avaliarEncerramentoAutomatico(Seguro)`; `finalizarProcesso` = acionamento administrativo da mesma avaliação. |
| `src/demurrage-engine/closing/encerramentoAutomatico.ts` (novo) | Gatilhos pós-ação, pós-tracking e varredura periódica. |
| `src/demurrage-engine/closing/materialChangeGuard.ts` | Auditoria estática dos chamadores de recálculo atualizada. |
| `src/demurrage-engine/persistence/minutaRepository.ts` | Novo vocabulário, `vigenteTecnica`, `comprovacaoLegada`; `criarRecebida`/`marcarValidada`/`marcarRejeitada` mantidos só como fixture de legado (sem chamador de produção — auditoria estática no teste #15). |
| `src/demurrage-engine/persistence/closingEventRepository.ts` | Tipos de evento novos. |
| `src/demurrage-engine/persistence/lifecycleRepository.ts` | `documentaryStatus` considera só minuta vigente RECEBIDA/ACEITA/VALIDADA legada. |
| `src/demurrage-engine/acoes/minutaIdempotencia.ts` | Adaptador fino: hash v2 (inclui o documento), chave legada 0042 rejeitada, delega ao serviço. |
| `src/demurrage-engine/acoes/encerramentoAposAcao.ts` (novo) | Executa a ação e, se ela sucede, avalia o encerramento (rota continua chamando uma função). |
| `src/demurrage-engine/acoes/organizacaoRecurso.ts`, `pendenciaVerificacao.ts`, `pendenciaCatalogo.ts` | `processoDoContainer`; `processoId` da pendência; nota do catálogo. |
| `src/demurrage-engine/acoes/serializacaoPorChave.ts` | **Removido** (servia só à rota de validação removida). |
| `src/demurrage-engine/tracking/eventIngestion.ts` | Gatilho isolado pós-promoção (devolução/descarga/Gate Out). |
| `src/demurrage/schedulerBootstrap.ts` | Etapa isolada `encerramento` no tick. |
| `src/routes/demurrageAcoesRoutes.ts` | Minuta com documento e resposta do aceite; `validar` → 410; `finalizar` administrativo; avaliação pós-ação em fallback, responsabilidade e pendência. |
| `src/routes/demurrageV2Routes.ts` | `apuracaoStatus` em `/filtros`; `GET /minutas/:minutaId/documento`. |
| `src/demurrage-engine/leitura/contrato.ts`, `filaOperacional.ts`, `filtros.ts`, `detalhe.ts`, `minutasOperacionais.ts`, `documentoMinuta.ts` (novo), `timeline.ts`, `pendenciaContextoSeguro.ts` | Contrato de leitura (§9). |

---

## 5. Máquina de estados da minuta

### 5.1 Antiga (congelada até `d0c8569`)

```
upload → RECEBIDA ──validarMinuta (MANAGER/ADMIN)──► VALIDADA  (grava effective_return_date; recalcula)
                   │                                 ▲
                   ├─ divergente: divergente_do_tracking=true, fica RECEBIDA ──aceitarDivergencia──┘
                   └─ incoerente ─────────────────────► REJEITADA
FINAL: validação com data ≠ congelada → exige_reabertura (minuta fica RECEBIDA); igual → VALIDADA sem supersedes_id (→ 23505 na segunda)
```

### 5.2 Nova

```
registro (analista; documento obrigatório; mesma transação)
   │  substitui TODA minuta não substituída do contêiner ──► SUBSTITUIDA (+ substituida_por_id, evento)
   ▼
verificação técnica automática (no registro e quando tracking/descarga/Gate Out mudam):
   ├─ sem descarga ou sem devolução no tracking ──► RECEBIDA (aguardando DESCARGA | DEVOLUCAO_TRACKING)
   ├─ número/data/cronologia falham ─────────────► INCONSISTENTE  + pendência minuta_inconsistente
   ├─ coerente, data ≠ tracking ─────────────────► DIVERGENTE     + pendência minuta_divergente_tracking
   └─ coerente, data = tracking ─────────────────► ACEITA         (pendências de minuta resolvidas)
FINAL: minuta coerente com data ≠ data CONGELADA → FATO_MATERIAL_POS_FINAL (as duas evidências) + exigeReabertura; nada congelado muda.
Legado (regra_avaliacao NULL): VALIDADA / REJEITADA / RECEBIDA — só leitura; deixam de valer quando substituídas.
```

Garantias: no máximo uma vigente do fluxo técnico por contêiner (índice);
versão sequencial por contêiner (índice); substituição antes do INSERT com
FK adiável (o índice nunca vê duas vigentes); reavaliação é NO-OP estrito
quando os fatos não mudaram; eventos e documentos append-only.

---

## 6. Fluxo de encerramento

### 6.1 Antigo

`finalizarProcesso` (MANAGER/ADMIN) era o **único** caminho para FINAL: lock
→ processo → contêineres → recálculo → gate (minuta `VALIDADA`
correspondente a `COALESCE(effective, tracking)`) → valores FINAL →
processo FINAL. Sem a chamada humana, nada encerrava.

### 6.2 Novo

`ClosingService.avaliarEncerramentoAutomatico(processo)`:

`encerrarSeElegivel`, **uma** transação: `lockProcesso` → processo
`FOR UPDATE` (relê `apuracao_status`; FINAL → `ja_final`) → (varredura:
reabertura aberta → não encerra, conferido sob o lock) →
**reavaliação técnica das minutas** e limpeza da devolução efetiva legada de
minuta substituída (`reavaliarMinutasComClient`, mesma transação — o gate
nunca decide sobre avaliação velha) → contêineres `FOR UPDATE` → `SAVEPOINT`
→ todos devolvidos? → (automático: devolução efetiva legada ≠ tracking →
`devolucao_efetiva_legada`) → recálculo → **gate único** → valores
OPEN→FINAL → processo FINAL (`WHERE apuracao_status = 'OPEN'`),
`fechamentos.origem = 'automatico'`, `fechado_por` NULL, evento
`FECHAMENTO_FINAL` (ou `REFECHAMENTO`) `origem = automatico`. Bloqueado:
volta ao savepoint (nada projetado fica; a reavaliação técnica, anterior ao
savepoint, persiste) e o automático grava só `processos.encerramento_*`
(motivo + contêiner). Falha inesperada: `avaliacao_adiada` e
`encerramento_bloqueio = 'falha_avaliacao'` com `encerramento_avaliado_em`
atualizado (o processo sai do topo da ordem da varredura).

Gate por contêiner, nesta ordem: pendência bloqueante aberta
(`<tipo>_pendente`, §3) → apuração INDETERMINADA → minuta vigente
`DIVERGENTE`/`INCONSISTENTE`/aguardando (ou só legado: comprovação legada) →
sem demurrage conclui → com demurrage: responsabilidade decidida, minuta
comprovada, valores `ESTIMATED`/`CONFIRMED`.

Gatilhos (todos idempotentes; uma falha inesperada da avaliação nunca
desfaz a escrita principal já comitada — vira `avaliacao_adiada` e a
varredura reavalia):

- registro de minuta (dentro de `ClosingService.registrarMinuta`);
- rotas de decisão de responsabilidade, resolução de pendência e fallback
  manual (via `acoes/encerramentoAposAcao.ts`, só quando a ação sucede);
- ingestão de tracking que promove devolução/descarga/Gate Out;
- varredura no tick do scheduler (rede de segurança: tarifa publicada,
  passagem de calendário, falha transitória), ordem justa por
  `encerramento_avaliado_em`, limite por tick.

Processo com reabertura aberta: a varredura **não** o re-encerra (a
reabertura existe para incorporar uma correção) — regra aplicada na
seleção de candidatos **e** sob o lock; a leitura mostra
`encerramento.bloqueio = reabertura_em_andamento` desde a autorização. Ele
volta a FINAL (`REFECHAMENTO`) quando a correção chega por um gatilho de
ação/fato, ou pelo acionamento administrativo. A autorização da reabertura
já limpa a devolução efetiva legada de minuta substituída antes do
recálculo da reabertura.

Concorrência: duas avaliações, varredura e acionamento administrativo
simultâneos produzem exatamente um fechamento (`P1 #10`).

---

## 7. Estratégia de legado

- Nenhuma linha legada é reescrita pela migration. `VALIDADA`/`REJEITADA`
  e `RECEBIDA` com `regra_avaliacao` NULL continuam legíveis (detalhe,
  `/minutas?estado=…`, timeline com rótulo "(fluxo legado)").
- Enquanto um contêiner só tem minutas legadas, o gate aplica a
  **comprovação legada v1.3** (`VALIDADA` correspondente a
  `COALESCE(effective, tracking)`; `RECEBIDA` legada divergente bloqueia).
  Os testes congelados que montam legado (`apuracao*.test.ts`,
  `responsabilidade*.test.ts`) continuam passando sem alteração.
- A `RECEBIDA` legada aguardava uma validação humana que não existe mais:
  em processo OPEN ela aparece na lista padrão de `/minutas` com
  `acaoNecessaria = registrar_minuta_substituta`; em processo FINAL não é
  trabalho pendente (fora do padrão, `acaoNecessaria = null`, visível por
  `estado=RECEBIDA`).
- Devolução efetiva legada (data de minuta aprovada no fluxo antigo) ausente
  do tracking ou diferente dele: o encerramento **automático** nunca a
  congela (`devolucao_efetiva_legada`); o acionamento administrativo humano
  encerra, como no fluxo antigo.
- Registrar uma minuta nova num contêiner com legado substitui as linhas
  legadas (`SUBSTITUIDA` + evento com `estadoAnterior` e `legado: true`;
  `validada_por`/`data_validada` antigos ficam na linha). Se a
  `effective_return_date` legada vinha de uma minuta agora substituída
  (processo OPEN), ela perde a base e volta a valer o tracking (evento
  `RECALCULO` com `effectiveAnterior`, recálculo do contêiner). Em FINAL,
  nada congelado muda; se a substituição aconteceu com o processo FINAL, a
  limpeza ocorre na autorização da reabertura (antes do recálculo dela) e,
  de novo por segurança, em toda avaliação de encerramento sob o lock.

---

## 8. Documento da minuta

- **Mecanismo reaproveitado**: a tabela `documentos` (Fase 8) — não foi
  criada uma segunda solução de armazenamento. **Não existe armazenamento
  binário na Priora** (nenhum blob/S3/multipart; os documentos do sistema
  são referenciados por origem — ex.: anexos Graph `message_id`/
  `attachment_id` + `conteudo_hash` nas Shipping Instructions). Nenhum
  binário vai para tabela operacional.
- **Contrato**: `documento = { origem: "email_anexo" | "referencia_externa",
  referencia, nomeArquivo, tipoConteudo (pdf/png/jpeg/tiff/webp/heic),
  tamanhoBytes (≤ 50 MiB), hashConteudo (SHA-256 hex) }`, obrigatório.
- **Vínculos**: organização, processo, contêiner, minuta, versão da minuta,
  autor (usuário + membership), data — com FKs compostas por organização e
  CHECK de coerência; append-only.
- **Leitura autorizada**: `GET /api/demurrage/v2/minutas/:minutaId/documento`
  (papel interno; organização da sessão no próprio WHERE; outra organização
  = 404). As demais leituras expõem só metadados (nome, tipo, tamanho, hash),
  nunca a referência.
- **Atomicidade**: minuta, documento, substituição, avaliação, pendência e
  eventos numa transação; o constraint trigger adiável garante que nenhuma
  minuta do fluxo técnico comita sem documento (`P1 #17`).
- **Dependência documentada**: guardar o **arquivo** em si (upload,
  armazenamento e download do binário) depende de um repositório de arquivos
  que o sistema não tem. Até lá, a Priora prova a integridade pela referência
  + hash; o arquivo permanece na origem (caixa de e-mail ou repositório
  externo).

---

## 9. Fila e contrato de leitura

- `GET /processos`: parâmetro `apuracaoStatus` = `OPEN` (padrão) | `FINAL` |
  `TODOS`; filtro de processo em SQL; entra no hash do cursor
  (`VERSAO_CURSOR_FILA` → `d12.fila.v1.2`; cursores antigos → 400). Busca,
  ordem, total e paginação operam sobre o mesmo conjunto; cursor de uma
  situação nunca serve para outra. Item: `apuracaoStatus`, `fechadoEm`,
  `encerramento { modo, bloqueio, avaliadoEm }`. Resposta: `escopo`,
  `apuracaoStatus`. Com `apuracaoStatus=FINAL|TODOS` e sem
  `incluirSilenciosos` explícito, os silenciosos entram (encerrado sem
  demurrage é `CONCLUIDO_PARA_ROCKET`, balde silencioso — sem isso o filtro
  explícito não acharia a maioria dos finalizados); o valor efetivo vai para
  o hash do cursor e para `incluiuSilenciosos`.
- `GET /filtros`: mesmo `apuracaoStatus`; opções e contagens por
  estado/balde só da situação pedida (padrão: ativos);
  `apuracao { abertos, finalizados }`.
- Detalhe direto (`/processos/:id`) sempre acessível; `fechamento.origem`;
  `encerramento`.
- `GET /minutas` → contrato `demurrage.leitura.minutas.v2` (cursor
  `p1e3.minutas.v3`): padrão = vigentes **de processos OPEN** que exigem
  ação do analista (`DIVERGENTE`, `INCONSISTENTE`, `RECEBIDA` legada);
  `acaoNecessaria` é sempre `null` em processo FINAL; `podeValidar` removido;
  itens com `legado`, `vigente`, `versao`, `dataTrackingComparada`,
  `motivoInconsistencia`, `aguardando`, `substituidaPorId`,
  `acaoNecessaria`, `temDocumento`; `escopo: "fila_da_equipe"`.
- Detalhe de contêiner: minutas com os mesmos campos + metadados do
  documento.
- `GET /processos/:id/pendencias`: `podeResolver` é sempre `false` para
  `minuta_divergente_tracking`/`minuta_inconsistente` (a rota de resolução as
  recusa; a ação é a minuta substituta).
- Gestão: o indicador G-A9 ("Processos aguardando tratamento") e sua
  composição contam só processo OPEN (o estado consolidado persistido não
  conhece o FINAL).

Impacto no frontend atual (não alterado): a UI D13 não usa
`/minutas`, `validar` nem `finalizar`; a fila agora não traz FINAL por
padrão (antes trazia) e os campos novos são aditivos. A adequação visual fica
para a entrega de frontend.

---

## 10. Testes

### 10.1 Testes novos — `src/demurrage-engine/__tests__/minutaEncerramentoP1.test.ts`

| Exigido | Teste |
|---|---|
| 1 | `P1 #1` tracking dentro do FT conclui sem minuta (automático, nenhum membro na organização) |
| 2 | `P1 #2` com demurrage não conclui sem minuta (`comprovacao_pendente` registrado) |
| 3, 4 | `P1 #3/#4` analista registra, ACEITA sem gestor, nenhum campo de aprovação humana; CLIENT barrado |
| 5, 6 | `P1 #5/#6` divergência e inconsistência abrem pendência e bloqueiam; substituta coerente resolve, histórico preservado, encerra |
| 7 | `P1 #7` segunda minuta (FINAL e sobre VALIDADA legada) nunca viola índice nem 500; divergência pós-FINAL = fato material |
| 8 | `P1 #8` último gate liberado pela rota → FINAL automático (2 contêineres) |
| 9 | `P1 #9` um contêiner bloqueado impede o encerramento; varredura idem |
| 10 | `P1 #10` concorrência: avaliações + varredura + acionamento administrativo = 1 fechamento; registros simultâneos = 1 vigente; mesma chave = 1 linha |
| 11 | `P1 #11` repetição idempotente = mesmo resultado, zero escrita; corpo diferente = 409 |
| 12, 13, 14 | `P1 #12/#13/#14` FINAL fora da fila e dos contadores; filtro explícito, busca, paginação, cursor e detalhe |
| 15 | `P1 #15` ANALYST sem poder de gestor; 410 para todos; auditoria estática sem chamador de produção da aprovação antiga |
| 16 | `P1 #16` outra organização: documento, minuta, processo → 404, zero escrita |
| 17 | `P1 #17` falha ao gravar o documento desfaz tudo; o banco recusa minuta sem documento; retry com a mesma chave aplica |
| 18 | `P1 #18` legado legível e com semântica preservada; `#18b` migration aditiva |
| regra | `P1 pura` verificação técnica; `P1 regra 1` minuta antes do tracking não fabrica devolução |

Regressão da revisão adversarial (§15), no mesmo arquivo — cada um foi
executado **antes** contra o código pré-revisão e falhou pelo motivo do
achado (exceto `#15` e `#16`, cobertura de caminhos que já funcionavam):

| Achado | Teste |
|---|---|
| devolução legada sobrevive à reabertura | `P1 revisão #1` |
| pendência de revisão humana ignorada pelo automático | `P1 revisão #2` |
| avaliação velha / reavaliação em FINAL | `P1 revisão #3` |
| falha da avaliação monopoliza a varredura | `P1 revisão #4` |
| varredura re-encerra reaberto | `P1 revisão #5` |
| réplica idempotente diferente da resposta original | `P1 revisão #6` |
| contexto de pendência desatualizado | `P1 revisão #7` |
| `/minutas` padrão com processo FINAL | `P1 revisão #8` |
| segunda conexão do pool com a primeira retida (pool travado) | `P1 revisão #9` |
| filtro FINAL esconde encerrados sem demurrage | `P1 revisão #10` |
| automático congelava devolução legada sem tracking | `P1 revisão #11` |
| U+0000/surrogate → 500; documento malformado | `P1 revisão #12` |
| `podeResolver` em pendência de minuta | `P1 revisão #13` |
| G-A9 contava FINAL | `P1 revisão #14` |
| tick → varredura → FINAL (cobertura) | `P1 revisão #15` |
| fallback manual pela rota → FINAL na mesma resposta (cobertura) | `P1 revisão #16` |

### 10.2 Testes antigos atualizados (expectativa antiga documentada como inválida)

Cada arquivo traz, no próprio teste, o motivo da mudança.

- `closing.test.ts` (Parte B), `closingD15A.test.ts` (#3, #7),
  `closingD15AV11.test.ts` (#2 de deadlock), `apuracaoV13.test.ts` (v1.3-2),
  `demurrageVertical.test.ts`, `d16Vertical.test.ts` (#10, isolamento,
  helper `minutaValidadaEFinaliza`), `gestaoEficiencia.test.ts`,
  `demurrageAcoesEntrega2.test.ts` (#16, #17/#18),
  `demurrageAcoesEntrega2V11.test.ts` (#21 + corpo com documento),
  `demurrageAcoesEntrega2V12.test.ts` (#7, #8, #9, #12 + corpo com documento):
  codificavam **aprovação de minuta por gestor**, **minuta escrevendo a
  devolução** ou **finalização manual obrigatória** — regras que deixaram de
  valer. A garantia de fundo de cada um (atomicidade, idempotência,
  concorrência, RBAC, isolamento, evidências preservadas) foi mantida e
  reprovada sobre o fluxo novo.
- `d16Vertical.test.ts` (#4, #11, #12) e `demurrageVertical.test.ts` (gate5
  cenário A, HeadCargo): o contêiner sem custo agora fecha **na própria
  ingestão do tracking** (encerramento automático); o `finalizar` manual
  posterior passa a responder `ja_final` em vez de ser o passo que fecha.
- `migration0007.test.ts`: `documentos` passou a ter `organization_id`, então
  entra na lista de tabelas de tenant com o trigger de imutabilidade (a 0048
  cria o trigger).
- `responsabilidadeV11.test.ts` (0032 → 0033): a verificação da 0033 é a
  mesma; só a última asserção (a decisão pré-0033 passa pelo gate de
  fechamento) agora roda depois do upgrade real até a última migration,
  porque o gate atual lê colunas da 0048.
- Listas exatas de migrations (`migrate`, `registroDemurrageV12`,
  `responsavelOperacional`, `responsabilidadeAuditoria`,
  `responsabilidadeV12`, `schedulerClaimFencing`, E2 V11/V12) ganham a
  `0048`; `handoffCapacidade` #22/#23 passa a escopar o upgrade em `0047`.
- `leituraOperacionalEntrega3*.test.ts`: contrato `/minutas` v2 e os 2 tipos
  novos de pendência.
- `src/frontend-tests/fixtures/demurrageV2Fixtures.ts`: dados tipados de
  teste receberam só os campos aditivos do contrato (nenhum arquivo de
  apresentação).

### 10.3 Totais

Validação sequencial (nunca duas suítes de banco ao mesmo tempo) em worktree
limpo no commit de código `c38b06b`, `npm ci` do zero, banco PostgreSQL 16
recém-criado; árvore limpa antes e depois (só `dist/` e `node_modules/`,
ignorados). O commit final difere desse apenas por este relatório.

| Etapa | Resultado |
|---|---|
| Testes novos (`minutaEncerramentoP1`: 18 exigidos agrupados + regras + 16 de regressão da revisão) | 33/33 |
| Fechamento/minuta (`closing` + D15-A v1.0–v1.3) | 65/65 |
| Entrega 1 — handoff (+ vínculo, concorrência, capacidade) | 87/87 |
| Entrega 2 — ações (+ v1.1, v1.2, auditoria estática) | 70/70 |
| Entrega 3 — leituras operacionais (+ v1.1) | 47/47 |
| D12 — read-model (rotas, autorização, contrato, fila, filtros, detalhe, timeline) | 75/75 |
| Suíte completa do Demurrage Engine | 1213/1213 |
| V1 (`npm run test`) | 25/25 |
| D13 UI (`npm run test:demurrage-ui`) | 66/66 |
| `tsc --noEmit` | 0 erros |
| `npm run build` | ok |

Antes da revisão adversarial a suíte completa tinha 1197 testes; as 9
falhas daquela rodada (testes antigos que esperavam finalização manual ou
liam o schema parcial) estão justificadas em §10.2.

---

## 11. Riscos remanescentes

1. **Tracking errado sem caminho de correção manual**: a devolução oficial é a
   do tracking; se o próprio tracking estiver errado e a minuta certa, a
   divergência só se resolve com correção do tracking (atualização manual de
   tracking segue fora do escopo, por decisão anterior) ou com uma minuta que
   repita a data do tracking. A pendência deixa o caso visível.
2. **Arquivo da minuta não é guardado pela Priora**: só a referência + hash
   (§8). Se a origem (caixa de e-mail, repositório externo) perder o arquivo,
   resta a prova de integridade, não o conteúdo. Depende de um repositório de
   arquivos que ainda não existe.
3. **Reabertura e re-encerramento**: um processo reaberto volta a FINAL no
   primeiro gatilho de ação/fato em que todos os gates passem — se a correção
   que motivou a reabertura ainda não chegou e outra ação liberar os gates, o
   processo re-encerra com os fatos atuais (a varredura nunca o faz sozinha,
   nem numa corrida — conferido sob o lock). Ao contrário, se a correção já
   veio na própria autorização (recálculo da reabertura) e nenhum gatilho
   chegar depois, o processo fica OPEN (`reabertura_em_andamento`) até uma
   ação ou o acionamento administrativo. Mitigação: a correção normalmente é
   o próprio gatilho; o gestor pode reabrir de novo (histórico preservado).
4. **Custo da avaliação**: cada gatilho (ingestão de tracking com fato
   promovido, ações, varredura) recalcula os contêineres do processo dentro da
   avaliação (desfeito quando bloqueado). A varredura é limitada por tick e
   ordenada por `encerramento_avaliado_em` (inclusive quando a avaliação
   falha — `falha_avaliacao`); em volume muito alto de processos devolvidos e
   bloqueados, o intervalo até reavaliar cada um cresce. Um bloqueio desfaz o
   recálculo projetado (só a reavaliação técnica da minuta persiste): manter
   relógios/valores persistidos em dia continua sendo papel do pipeline de
   recálculo existente.
5. **`encerramento.bloqueio` é informativo**: reflete a última avaliação
   automática; entre gatilhos pode estar desatualizado (o campo `avaliadoEm`
   torna isso explícito). A decisão é sempre do gate no momento da avaliação.
6. **Legado com `effective_return_date` de minuta aprovada**: limpa-se quando
   uma minuta nova substitui a legada em processo OPEN (ou na autorização da
   reabertura, se a substituição foi em FINAL) — o que pode mudar relógios e,
   pelo trigger da 0033, invalidar uma decisão de responsabilidade de base
   cliente (exigindo nova decisão). Enquanto vale, o automático nunca a
   congela: devolução legada sem tracking (ou diferente dele) só encerra pelo
   acionamento administrativo humano, como no fluxo antigo — é o único caso
   em que o acionamento manual continua necessário. O sistema nunca esteve
   em produção (precedente da 0035), então o volume esperado é zero.
10. **Armador sem tracking**: sem devolução no tracking, nenhum contêiner
    encerra automaticamente e a minuta fica `RECEBIDA` aguardando — a regra
    "tracking é a devolução oficial" sem atualização manual de tracking (fora
    do escopo) não tem saída para esse caso. Visível pelo bloqueio
    `conteiner_nao_devolvido`.
11. **Pendências bloqueantes exigem a revisão do analista**: um
    `conflito_mesma_fonte` ou `fallback_manual_superado` em aberto mantém o
    contêiner fora do encerramento até o analista resolvê-lo com motivo (não
    há resolução automática dessas). `ft_divergencias` (divergência de Free
    Time entre fontes) **não** bloqueia: não tem rota de resolução nesta
    entrega e o valor promovido segue a regra de prioridade de fontes já
    congelada; fica visível na gestão.
7. **Publicação de tarifa** (fora do escopo, §13): ao nascer valor do
   cliente, o trigger da 0033 invalida a decisão de responsabilidade e o
   encerramento automático passa a esperar nova decisão humana — comportamento
   herdado, agora visível em `encerramento.bloqueio`.
8. **Contrato de leitura mudou** em pontos não aditivos: `/minutas`
   (v1 → v2: padrão, `podeValidar` removido, cursor v3) e o padrão da fila
   (FINAL fora). A UI D13 atual não consome `/minutas`; a fila passa a não
   mostrar FINAL por padrão. Adequação visual: entrega de frontend.
9. **Autenticação**: os defeitos do §12.2 (logout anônimo desconecta a conta
   global; login de qualquer conta troca a conexão de todos) continuam no
   código — não fazem parte desta correção e pedem hotfix próprio.

## 12. Diagnóstico separado — autenticação de conta única e filas pessoais

> **Atualização (ponteiro):** a entrega separada planejada aqui foi implementada e depois auditada. Está **APROVADA E CONGELADA** em `8266fba` (baseline anterior `29a3830`; commits aprovados `4bb0efc`, `b03b463`, `8266fba`). O desenho final difere deste plano em alguns pontos; por exemplo, não há o flag `PRIORA_MULTISESSAO`. Vale `docs/demurrage-producao-p1-autenticacao-filas.md` (§19 congelamento; §19.4 limitação do MVP: uma única organização em produção). Este ponteiro não altera o status desta correção de minuta e encerramento.

Somente leitura; **nada foi implementado nesta entrega** (nenhuma linha de
`src/auth`, `src/middleware`, `/api/me` ou do shell foi alterada). Achados
verificados por uma segunda leitura adversarial independente (16 confirmados,
3 parcialmente — correções incorporadas abaixo).

### 12.1 Como funciona hoje (comprovado no código)

- **Login**: `GET /auth/login` → state HMAC (15 min, sem vínculo com o
  navegador, sem PKCE) com escopos de e-mail (Mail.Read/ReadWrite/Send);
  `GET /auth/callback` troca o code, chama `connectMicrosoftAccount` e grava
  `session.homeAccountId/username` sem `regenerate()`.
- **Sessão**: `express-session` em arquivo local por instância
  (`FileSessionStore`), cookie padrão, `sameSite=lax`, 30 dias, sem purga.
- **"Conta ativa" GLOBAL**: um singleton do processo (`activeAccount.ts`,
  linha única `msal_conta_ativa id='default'`), declarado no código como
  regra provisória de MVP. Só a captura relê o banco; `requireAuth`,
  `/api/me`, os 4 transportes de aviso e `connectMicrosoftAccount` usam a
  cópia em memória (correção da verificação).
- **`requireAuth`** autentica E obtém o token do Graph ao mesmo tempo: 401
  se a sessão não for a conta ativa ("A conta Microsoft foi trocada"), se não
  houver token em cache ou se a renovação falhar — inclusive nas rotas V2,
  que não usam token algum.
- **`autorizarInterno`** (V2) já é por sessão: `home_account_id` →
  membership interno → organização/papel, a cada requisição. O RBAC da V2
  funcionaria com várias sessões; o bloqueio é só o `requireAuth` anterior.
- **Por que a conta é única**: o Graph usa endpoints `/me` (a caixa é a da
  conta do token); derivados do Outlook ficam em arquivos globais; jobs de
  background precisam de UM token sem sessão; a troca de conta faz
  `wipe` dos derivados.
- **Impacto em toda a aplicação**: todo router de produto passa por
  `requireAuth` (e-mails, análise, parse, processos, couriers, tracking,
  Demurrage V1/V2/gestão/ações, auditoria, captura). Só o handoff M2M (HMAC
  próprio) e as rotas públicas escapam.
- **`/api/me`** devolve só `{authenticated, username}`, compara sessão ×
  conta ativa sem consultar banco nem conferir o token em cache; o shell
  abre o login em QUALQUER 401 sob `/api/`.
- **Fila por responsável hoje**: `GET /processos?responsavel=<uuid>` já
  existe (validado, no hash do cursor); não há `me` nem "sem responsável";
  `/minutas` e `/reaberturas` são da organização inteira; a gestão aceita
  `responsavel`, `cliente`, `armador`, `tipoEquipamento` SEM validação (valor
  inválido chega ao banco e vira 500).
- **Processo sem responsável**: estado válido (`responsavel_operacional_
  membership_id` nullable, FK composta por organização, CLIENT barrado por
  trigger). O responsável só chega pelo handoff com a fonte `outro`
  (prioridade mínima); não existe rota de atribuição; o backfill cria NULL.
  Atribuição por `UPDATE` direto seria sobrescrita pela próxima observação do
  handoff (ledger de prioridade).
- **Provisionamento**: não existe (nenhum chamador de produção de
  `UsuarioRepository.create`/memberships). Revogação hoje: desvincular
  `usuarios.home_account_id` (403 na V2 em todas as organizações, sem apagar
  histórico) ou trocar papel para CLIENT; não há revogação por membership.

### 12.2 Defeitos de segurança encontrados (não corrigidos aqui — ver §12.4)

1. **`POST /auth/logout` sem sessão desconecta a conta GLOBAL**: um POST
   anônimo (ou cross-site, `urlencoded` aceito) apaga todos os tokens, os
   derivados e a conta ativa — derruba o operador, para a captura e deixa os
   avisos sem transporte. Explorável sem credencial.
2. **Login de outra pessoa troca a conexão de todos**: qualquer conta que
   conclua o callback (com `AZURE_TENANT_ID=common` no `render.yaml`; quem
   consegue logar depende do app registration — não comprovado) passa a ser
   a caixa de onde saem os avisos de TODAS as organizações.
3. Sessão sem `regenerate()` (fixação), state reutilizável por 15 min sem
   PKCE (login CSRF), sem token CSRF nas POST da API.
4. Cache residual entre contas na auditoria (`auditCache`/`preAlertaCache`
   não são limpos no wipe).
5. Filtros da gestão sem validação → 500 com mensagem do banco.

### 12.3 Plano fechado — entrega SEPARADA "Sessões simultâneas + filas pessoais"

Todas as mudanças são aditivas aos contratos D12/E2/E3, atrás de um flag de
reversão (`PRIORA_MULTISESSAO`, padrão `off`). Numeração de migrations a
partir da **próxima livre (0049)** — a 0048 é desta correção.

- **Fase 0 — hotfix de segurança (primeiro, independente do flag, com testes
  próprios)**: logout destrói só a própria sessão e só desconecta a conta se
  a sessão FOR a conta ativa; `regenerate()` no callback; **allowlist de
  tenant/UPN para `connectMicrosoftAccount`** (achado da verificação: sem ela
  o vetor 2 continua aberto); limpeza dos caches da auditoria no wipe (via
  módulo de store, não importando rotas em `src/auth`); validação estrita dos
  4 filtros da gestão (400); checagem de `Origin` em métodos não-GET.
- **Fase 1 — separar IDENTIDADE (pessoa) de CONEXÃO DE SERVIÇO (caixa)**:
  `requireSessao` (só sessão de identidade, idade máxima) para a V2;
  `requireAuth` continua como guard do V1 (conexão + token Graph); para
  sessões de identidade TODOS os "401 de conexão" viram `403` com código
  (evita o laço de login do shell); login de identidade com cliente MSAL
  descartável por login (`removeAccount` logo após ler as claims — nenhum
  token de pessoa fica em memória), escopos `openid/profile/User.Read`,
  cookie de pré-login assinado + PKCE; conexão de serviço por rotas próprias
  restritas a um **papel de PLATAFORMA** (allowlist do operador — não ADMIN
  de organização, porque a conexão é global e serve a todas as
  organizações); nova redirect URI no app Azure.
- **Fase 2 — contratos de identidade**: `GET /api/me` (sem banco) acrescenta
  só `conexaoOutlook: esta_sessao | outra_conta | nenhuma`, nunca UPN da
  conta de serviço, ids ou estado de token; **novo `GET
  /api/demurrage/v2/eu`** (depois de `requireSessao` + `autorizarInterno`,
  só SELECT): `{usuario:{nome}, organizacao:{id,nome}, membershipId, papel,
  capacidades:{...}}` derivadas das funções existentes (`ehGestor`,
  `PAPEIS_RESOLUCAO_PENDENCIA`, …; **sem** `validarMinuta`, que não existe
  mais). Nunca expõe `homeAccountId`, `usuarioId` global, e-mail de
  terceiros, outras organizações ou dados da conta de serviço. Organização
  ambígua → o mesmo 409; CLIENT → o mesmo 403.
- **Fase 3 — filas pessoais (somente leitura)**: `responsavel` aceita
  `<uuid> | me | nenhum`; `me` é resolvido NA ROTA para o `membershipId` da
  sessão antes de serializar o cursor (o cursor de A nunca vale para B);
  `nenhum` = `IS NULL`; o mesmo em `/minutas`, `/reaberturas` e na gestão
  (cursores versionados e documentados); `/filtros` ganha
  `contagensFila:{minha, semResponsavel, total}`. **Sem filtro implícito no
  backend**: o padrão continua a fila da EQUIPE.
- **Fase 4 — atribuição**: `POST /acoes/processos/:id/responsavel` com
  `Idempotency-Key`; a escrita passa pelo LEDGER (fonte nova
  `atribuicao_interna`, prioridade acima de `outro`), sob o MESMO advisory
  lock do registro, reaplicando a mesma regra de promoção; MANAGER/ADMIN
  atribuem/limpam; ANALYST só "assume" processo sem responsável (decisão
  pendente).
- **Fase 5 — provisionamento mínimo**: `organization_memberships.revogado_em`
  + filtro em TODOS os pontos que resolvem membership por id (inclusive
  `closingService.resolverAtor`, `decidirResponsabilidade`, scheduler e
  destinatários de aviso); CLI operado pelo time; vínculo no 1º login por
  `oid+tid` das claims (não por e-mail mutável).
- **Fase 6 — endurecimento**: store de sessão em PostgreSQL (multi-instância,
  derrubar sessões de revogado), cookie nomeado, runbook de tenant único.
- **Ordem**: atribuição (Fase 4) antes de a UI abrir em "Minha fila" — sem
  ela a fila pessoal fica vazia para todos.

**Tratamento de processos sem responsável**: continuam visíveis na fila da
equipe; ganham a visão explícita "Sem responsável" (`responsavel=nenhum`);
avisos seguem o precedente existente (sem responsável → só gestores).

**Até a fila pessoal existir** (esta entrega): fila, `/filtros` e
`/minutas` declaram `escopo: "fila_da_equipe"`; nenhum contrato diz "ações
aguardando você". Nenhuma ocultação de botão substitui autorização: toda
ação continua autorizada no backend (G6 + serviço).

### 12.4 Por que nada de autenticação entrou agora

`/api/me` com organização/papel não é seguro nem útil neste momento (fora do
RBAC da V2; exigiria banco e uma decisão sobre organização ambígua numa rota
que o shell usa para detectar login; com conta única a identidade é sempre a
da conta ativa). O guard do logout (12.2-1) e a validação dos filtros da
gestão são pequenos e isolados, mas o código de autenticação tem cobertura
de teste ZERO e a instrução desta entrega é não misturar autenticação com a
correção de minuta. **Recomendação explícita: executar a Fase 0 como hotfix
imediato, com testes próprios, antes de qualquer outra fase** — o defeito
12.2-1 é explorável por qualquer pessoa na internet.

### 12.5 Decisões pendentes (negócio)

Fila pessoal é só visão ou também autorização; ANALYST pode assumir
processo; prioridade de `atribuicao_interna` e se o handoff pode retomar;
conexão de serviço é caixa compartilhada ou conta de um ADMIN; signInAudience
do app Azure; canal de provisionamento; destino dos processos de um
membership revogado; validade máxima da sessão; usuário em várias
organizações.

## 13. Diagnóstico separado — tarifas (somente leitura, nada implementado)

### 13.1 Tabelas exigidas pelo motor

`tariff_tables` (tipo `rocket_cliente` por organização | `armador` global,
termo, versão, vigência, qualidade, `day_count_basis`, `verificada_em`,
`ativada_em`) e `tariff_brackets` (equipamento em texto livre, faixa de dias,
`valor_dia`, moeda); dados de apoio: `armadores` (global),
`container_types` (12 códigos da 0009), `condicoes_comerciais` (+ `tabela_id`),
`processos.armador_id/condicao_comercial_id`, `containers.container_type_id`
+ datas + Free Times. Rascunho (`ativada_em` NULL) é invisível ao cálculo;
versão publicada ou usada é imutável (0037/0038), inclusive `vigencia_fim`.

### 13.2 Valores que bloqueiam o encerramento

Em contêiner com DEMURRAGE_CONFIRMADA, cada relógio em demurrage precisa de
valor ativo `ESTIMATED` ou `CONFIRMED`; `UNAVAILABLE`,
`ESTIMATED_PROVISIONAL` (tabela `PROVISORIA_INCOMPLETA`) ou ausência de linha
bloqueiam (`valor_cliente_nao_confirmado` primeiro, depois
`valor_rocket_nao_confirmado`). Nenhum caminho de produção gera `CONFIRMED`
— na prática só `ESTIMATED` libera. Causas de `UNAVAILABLE`:
`TARIFF_TABLE_NOT_FOUND`, `TARIFF_VERSION_NOT_PROVEN`,
`TARIFF_VERSION_NOT_ACTIVATED`, equipamento não reconhecido, sem faixa para o
equipamento/dia, moeda mista — o motivo **não é persistido** (a leitura só
mostra INDISPONIVEL). Sem condição comercial: nenhum valor do cliente +
pendência `condicao_comercial_ausente`. Zero demurrage fecha sem tarifa
(continua assim no encerramento automático). **Interação descoberta pela
verificação**: quando nasce um novo valor ativo do cliente (ex.: publicação
de tarifa), o trigger da 0033 invalida a decisão de responsabilidade de base
`RELOGIO_CLIENTE` → o contêiner volta a `responsabilidade_em_analise` até nova
decisão humana.

### 13.3 Como os testes criam os dados

Seeds (`seedArmadorTables`: 12 armadores globais com o vocabulário próprio
de cada armador; `seedRocketTermoPorEmbarque`/`TermoUnico` por organização),
o serviço `tariffTableService` (rascunho/ativar/substituir faixas/versão
corrigida) e INSERTs diretos com `UPDATE ativada_em` manual. Os testes de
encerramento com demurrage usam uma tabela de armador "normalizada" (`40HC`)
criada no próprio teste.

### 13.4 Caminho operacional ausente (lacuna real)

**Não existe** caminho operacional para criar/publicar/encerrar tabelas nem
para cadastrar armadores: seeds e `tariffTableService` não têm chamador de
produção (nenhum script, CLI, rota ou bootstrap). O handoff/registro só
VINCULA uma tabela existente (e um `tabelaId` de outra organização ou
inexistente termina em 500 via trigger da 0009). Um banco que recebeu só as
migrations tem `armadores` vazio → `armador_nao_cadastrado`,
`armador_id` NULL → exposição Rocket `UNAVAILABLE` → FINAL com demurrage
bloqueado. Mesmo rodando `seedArmadorTables`, os códigos de equipamento do
seed (`40DRYHC`, `20_40REEFER`, …) **não casam** com `container_types`
(`40HC`, …) — a exposição continuaria `UNAVAILABLE` (limitação documentada e
testada). Estado real do banco de produção: não comprovado (conexão proibida).

### 13.5 Menor superfície administrativa segura (proposta — não implementada)

Script operacional auditado (`npm run tarifas:admin -- <subcomando>`), em
dry-run por padrão, sem rota HTTP nesta fase (tabelas de armador são globais
e o RBAC não tem papel de plataforma):

- `armador:cadastrar` (código normalizado `trim().toUpperCase()`; sem exigir
  código de tracking), `rascunho:criar` (versão calculada sob advisory lock da
  identidade, dentro da transação), `rascunho:faixas` (conjunto completo),
  `revisar` (relatório de validação e de impacto — inclusive decisões de
  responsabilidade que seriam invalidadas), `publicar` (lock da linha da
  tabela + validação + `ativar` + evento com hash), `listar`; encerrar
  vigência = publicar sucessora (encerrar sem sucessora fica fora — exige
  migration de exceção).
- Validações puras de publicação: tipo × organização, termo × tipo,
  equipamento ∈ `container_types`, moeda ISO única, faixas sem buraco e com
  última aberta, embarque com exatamente uma faixa `[1,∞)` e sem
  `PROVISORIA_INCOMPLETA`, pelo menos uma faixa, regras de
  `day_count_basis`, `vigencia_inicio` NULL com `vigencia_fim` proibido.
- Auditoria: tabela append-only `tariff_admin_eventos` (incl. bloqueio de
  TRUNCATE, FK de membership com mesma organização) na mesma transação. A
  verificação mostrou que, sem role de banco dedicada, a autoria é
  **declarativa** (quem tem a credencial escolhe `--operador`): ou se cria
  uma role com GRANT restrito / constraint adiada exigindo o evento, ou a
  auditoria deve ser declarada best-effort.
- Pós-publicação: recálculo imediato dos contêineres OPEN afetados pode usar
  `recalcularApuracaoContainer` (idempotente, já existente) sem migration; o
  encerramento automático desta correção fecha depois, pela varredura,
  quando o valor `ESTIMATED` liberar o último gate.

Decisões de negócio pendentes: equivalência entre o vocabulário dos armadores
e `container_types` (e o 45'); quem é o "operador de plataforma"; publicação
de tabela Rocket×cliente só por ADMIN ou também MANAGER; política para PIL
(`PROVISORIA_INCOMPLETA` bloqueia o FINAL indefinidamente); vigência no Termo
por Embarque; como a Liberação descobre o `tabelaId`.

## 14. Confirmação: nenhuma alteração de frontend

- Nenhum arquivo em `public/` (HTML, CSS, JavaScript de apresentação,
  `demurrage-v2-apresentacao.js`, shells `.dc.html`) foi alterado — conferido
  por `git diff --stat` e pelos testes `Entrega 2 #32`/`v1.1 #24`/`v1.2 #21`
  (nenhum arquivo de frontend entre as mudanças).
- O único arquivo sob `src/frontend-tests/` alterado é o fixture tipado
  `fixtures/demurrageV2Fixtures.ts`, que recebeu apenas os campos aditivos do
  contrato de leitura para continuar compilando; nenhum teste de UI mudou de
  expectativa.
- Design, layout e textos de tela: intocados. A entrega de frontend/design
  não foi iniciada.
- Handoff de entrada (`/api/integracoes/demurrage/handoff/processos`, HMAC,
  idempotência, capacidade): intocado.

---

## 15. Revisão adversarial (antes do commit)

Feita sobre o diff completo, só leitura, em três frentes: um revisor focado
em transação/concorrência/idempotência/isolamento/legado/migration, e um
workflow com quatro lentes complementares (leitura/fila, rotas e erros,
gatilhos do encerramento, adequação dos testes). Cada achado da primeira
frente passou por dois verificadores independentes (um tentando refutar pelo
caminho de código, outro julgando contra as regras de produto); todos foram
confirmados. Os achados das lentes complementares foram conferidos no código
antes de corrigir.

| # | Achado | Gravidade | Correção |
|---|---|---|---|
| 1 | Devolução efetiva legada de minuta substituída com o processo FINAL nunca era limpa: após a reabertura, o re-encerramento congelava relógios/valores na data da minuta antiga | major | `limparDevolucaoLegadaSubstituida` decide pelo estado da minuta apontada (não por "substituída agora"); roda no registro, em toda reavaliação sob o lock e na autorização da reabertura |
| 2 | O gate só bloqueava `retorno_vazio_antes_descarga`; pendências que o próprio sistema marca para revisão humana (conflito da mesma fonte, fallback manual superado, cronologia da devolução) eram congeladas pelo automático | major | `TIPOS_PENDENCIA_BLOQUEIAM_ENCERRAMENTO` (§3) |
| 3 | Reavaliação da minuta numa transação separada do encerramento: um fato comitado entre as duas fechava sobre ACEITA velha; reavaliação rodava também em FINAL (pendência aberta em processo congelado, sem fato material) | minor | reavaliação dentro da transação do encerramento, sob o lock; NO-OP em FINAL |
| 4 | Falha da avaliação não atualizava `encerramento_avaliado_em`: processos que falham sempre ficavam no topo da varredura | minor | `falha_avaliacao` + `avaliado_em` |
| 5 | Regra "varredura não re-encerra reaberto" só na seleção, não sob o lock | minor | `respeitarReabertura` conferido sob o lock; leitura `reabertura_em_andamento` |
| 6 | Réplica idempotente respondia `exigeReabertura=false` e `substituidas=[]` | minor | decisão tomada antes do evento de registro e gravada nele; a réplica lê o evento |
| 7 | Pendência de minuta mantinha contexto velho quando a minuta seguia DIVERGENTE com outro tracking | minor | resolve a antiga e abre outra (linha nunca editada; histórico) |
| 8 | `/minutas` padrão listava RECEBIDA legada de processo FINAL como ação pendente | minor | padrão só OPEN; `acaoNecessaria = null` em FINAL |
| 9 | Cabeçalho da 0048 descrevia normalização e preservação que o código não faz | minor (doc) | cabeçalho e comentários corrigidos |
| 10 | Registro pedia uma segunda conexão ao pool com a primeira retida (leitura pós-COMMIT e réplica pós-ROLLBACK): N registros concorrentes num pool de N conexões travavam o pool inteiro | major | tudo pela mesma conexão; estado final lido antes do COMMIT (nada pode falhar depois dele) |
| 11 | `apuracaoStatus=FINAL` escondia o encerrado sem demurrage (balde silencioso) | minor | silenciosos incluídos por padrão em FINAL/TODOS |
| 12 | Automático congelava devolução efetiva legada sem tracking (data de minuta) | major (teste) / decisão | automático bloqueia `devolucao_efetiva_legada`; administrativo encerra (semântica legada) |
| 13 | U+0000 ou surrogate isolado em texto da minuta → 500 | minor | 400 `valor_invalido`/`documento_invalido` (`textoArmazenavel`) |
| 14 | `podeResolver = true` para pendência de minuta que a rota sempre recusa | minor | `false` para os dois tipos |
| 15 | Indicador G-A9 contava processo FINAL como "aguardando tratamento" | minor | só OPEN (contagem e composição) |
| 16 | Sem teste de tick → varredura → FINAL, nem do gatilho na rota de fallback manual | cobertura | `P1 revisão #15`, `#16` (o gatilho da rota de pendência é coberto por `#2`) |

Achados avaliados e **não** alterados (com o motivo):

- *Recálculo projetado desfeito quando o encerramento bloqueia*: o gate
  decide sobre o estado projetado na mesma transação (correto); persistir
  relógios/valores é papel do pipeline de recálculo — gravar a cada
  avaliação bloqueada criaria versões a cada tick (§11.4).
- *Varredura nunca reavalia processo reaberto*: decisão de produto (§6.2,
  §11.3).
- *Os 18 testes exigidos estão agrupados em menos casos*: o mapeamento
  exigido → teste está em §10.1; cada caso falha com mensagem própria.
- *Filtro `apuracaoStatus` em `/minutas`*: opcional; o padrão já é OPEN e
  `estado=…` encontra qualquer situação.
- *`apuracaoV13` v1.3-2 não distingue "data congelada" de "data do tracking"*:
  a distinção é coberta por `P1 revisão #1` (FINAL congelado em 09-05,
  tracking 09-10, minuta 09-10 → `ACEITA` com `exigeReabertura = true`).
- Divergência entre verificadores: os das lentes complementares refutaram
  sete achados — filtro FINAL com silenciosos, `/minutas` padrão sem FINAL,
  leitura do processo reaberto (tratados como escolha de contrato),
  reavaliação em FINAL, avaliação velha, pendências de revisão humana e
  devolução legada sem tracking — que os verificadores da primeira frente
  confirmaram (2/2) ou que foram reproduzidos por teste no código anterior
  (`P1 revisão #2, #3, #8, #10, #11`). As correções foram mantidas: cada uma
  tem teste que falhava antes, e as de leitura mexem só em contrato novo
  desta entrega.
