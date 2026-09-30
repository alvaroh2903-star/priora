# Fase D12 — Contrato operacional e API interna da Demurrage: diagnóstico e plano

> **Status:** diagnóstico técnico e plano, **sem código**, aguardando aprovação.
> Bases congeladas: D10 e D11 em `a4b07b3`. PostgreSQL local; sem Supabase;
> sem dados reais; Portal adiado. Nada foi alterado no repositório além deste
> documento.

## 0. Resumo e decisões que preciso de você

A D12 é uma camada **somente leitura** sobre projeções já persistidas. O
levantamento mostrou que quase tudo existe, mas quatro fatos moldam o plano:

1. **A fila oficial não é um `ORDER BY`.** O processo persiste só o balde, o
   motivo e o contêiner-líder (`processos.prioridade_balde`,
   `prioridade_motivo`, `container_lider_id`). A ordem dentro do balde é o
   comparador congelado `compararDesempate` (promoção 15+, dias, exposição,
   valor contextual, tracking, vencimento), que usa fatos de relógio, valor e
   tracking montados por `LifecycleRepository.montarFatos`. Reproduzir isso em
   SQL seria copiar a regra — proibido. A fila será ordenada **em memória com
   `ordenarFila`/`ordenarTodos`**, sobre o contêiner-líder persistido.
2. **Isso hoje é N+1 com custo medido.** Benchmark descartável (banco próprio,
   fora do repositório): `montarFatos` faz **6 queries por contêiner**. Fila de
   300 processos = 1.801 queries / ~480 ms; 1.000 processos = 6.001 queries /
   ~1,7 s **por requisição** (escala linear). É preciso uma versão em lote de
   `montarFatos` com **a mesma implementação** (ver Q7).
3. **A sessão não carrega organização.** Só há `homeAccountId` (conta MSAL
   ativa). A organização precisa ser **derivada do membership** do usuário da
   sessão, nunca de query/corpo (ver Q1).
4. **Várias tabelas de evento não têm `organization_id`** (`closing_events`,
   `minutas`, `reaberturas`, `fechamentos`, `relogios`, `valores_apurados`) e o
   tracking é **global** (`tracking_targets/events/fetches/incidents`). O
   isolamento terá de vir sempre do `JOIN` a partir de processo/contêiner da
   organização.

Decisões pendentes (detalhes na seção 14):

| # | Decisão | Minha recomendação |
|---|---|---|
| Q1 | Organização quando o usuário tem mais de um membership interno | Um só → automático; mais de um → `409 organizacao_ambigua` (seleção de organização fica fora da D12) |
| Q2 | Quem vê a exposição da Rocket | MANAGER/ADMIN; ANALYST recebe o campo como `restrito` |
| Q3 | Fila padrão com ou sem `SILENCIOSO` | Sem (Cap. 22.6, `ordenarFila`); `incluirSilenciosos=true` usa `ordenarTodos` |
| Q4 | Filtro por contêiner em processo multi-contêiner | O processo entra se **qualquer** contêiner satisfaz |
| Q5 | Data do filtro "período" | Descarga de qualquer contêiner; devolução como segunda opção |
| Q6 | Ordem da timeline | Data operacional, depois instante registrado, fonte, id |
| Q7 | Refatoração aditiva em `LifecycleRepository` (lote + reconstrução pública) | Aprovar; `montarFatos(id)` passa a ser o lote de um |
| Q8 | Composição (total/devolvidos) sem copiar regra | Extrair a contagem já existente de `consolidarProcesso` numa função pura exportada |
| Q9 | Evento de tracking sem número de contêiner em alvo compartilhado | Incluir como escopo "embarque"; nunca eventos de contêiner de outra organização |
| Q10 | Montagem da rota V2 | Montar `/api/demurrage/v2` **antes** de `/api/demurrage` no `index.ts` |
| Q11 | O que conta como "falha técnica" e "pendência aberta" | Ver seção 2.3 |

## 1. O que já está persistido (fontes da camada de leitura)

| Informação | Fonte persistida | Observação |
|---|---|---|
| Estado, badges, severidade, balde, motivo do contêiner | `containers.estado`, `estado_badges`, `severidade_dias`, `prioridade_balde`, `prioridade_motivo`, `lifecycle_calculated_at` | Derivados pelo pipeline e pelo tick diário |
| Estado/prioridade do processo | `processos.estado_mais_relevante`, `prioridade_balde`, `prioridade_motivo`, `container_lider_id`, `lifecycle_calculated_at` | Consolidação oficial (`consolidarProcessoDeCache`) |
| Situação apresentável | `registro/situacao.ts` (D10) | Traduz `PENDENCIA_DE_DADOS` + `DESCARGA_AUSENTE` em "Aguardando descarga" — reutilizar |
| Dois relógios | `relogios` (1 linha por tipo; `estado`, datas, `dias_demurrage`, `pendencias`, `motivo`, `calculated_at`, `input_hash`) | Só o estado atual; histórico vem de eventos/fotografia |
| Valores | `valores_apurados` ativos (`OPEN`/`FINAL`), histórico `SUPERSEDED` | `confirmation_status`, tabela, versão, faixas |
| Tabelas tarifárias | `tariff_tables` (fonte, qualidade, vigência, versão) | |
| Free Time e fontes | `containers.*_free_time_days` + `field_observations` + `demurrage_fallback_manual_justificativas` + `si_proveniencias` | |
| Responsabilidade | `responsabilidade_decisoes` (+ dias/períodos), `containers.responsabilidade*` | D11 |
| Minuta, fechamento, reabertura | `minutas`, `fechamentos`, `reaberturas`, `closing_events` | |
| VesselCall/ETA/rolagem | `vessel_calls`, `vessel_call_eventos`, `container_vessel_calls`, `container_vessel_call_eventos`, `vessel_call_participantes` | |
| Tracking | `container_tracking_targets` → `tracking_targets`/`events`/`fetches`/`incidents` (globais) | Isolamento só via contêiner |
| Pendências | `demurrage_pendencias`, `vessel_call_pendencias`, `si_pendencias`, `ft_divergencias` | |
| Fotografia | `snapshots` | Versões por contêiner |

**Nenhum dado novo precisa ser persistido na D12.** Nenhuma tabela nova.

## 2. Fila operacional

### 2.1 Como a ordem será obtida (sem copiar regra)

1. Carregar, da organização da sessão, os processos com seu contêiner-líder
   **persistido** (`processos.container_lider_id`) e as colunas persistidas
   desse contêiner.
2. Montar os fatos do líder com a **mesma** função do lifecycle
   (`montarFatos`, em lote — Q7) e reconstruir o `ContainerLifecycle` com as
   colunas persistidas (o que `reconstruirLifecyclePersistido` já faz hoje,
   tornado público sem mudar comportamento).
3. Ordenar com `ordenarFila` (padrão) ou `ordenarTodos` (Q3), com `hoje =
   hojeOperacional()`.
4. Aplicar filtros **antes** de ordenar; paginar **depois**.

Nada disso grava: `montarFatos` só lê (`containers`, `relogios`,
`valores_apurados`, condição comercial, `tracking_fetches`,
`tracking_incidents`, `minutas`). Processos ainda não consolidados
(`container_lider_id` nulo) vão para um grupo final "não derivado", ordenados
por número do processo.

### 2.2 Paginação estável

O comparador não é expressável como chave de índice, então não há *keyset*
em SQL. Proposta:

- A cada página a ordem completa é refeita (o custo é o da fila inteira, daí
  a importância do lote).
- O cursor é opaco: `{ ordemHash, offset }`, onde `ordemHash` = hash da lista
  ordenada de `processoId` + filtros + `hoje`.
- Se, na página seguinte, a ordem recalculada tiver outro hash, a resposta é
  `409 ordem_alterada` (o cliente recomeça da primeira página). Assim a
  paginação **nunca duplica nem omite** dentro de uma mesma ordem, e qualquer
  mudança de dados entre páginas é detectada em vez de silenciosamente
  embaralhar.
- Desempate final já é determinístico (o comparador termina em
  `containerId`); para o grupo "não derivado", `numero_processo`, `id`.
- `limite` padrão 50, máximo 200.

### 2.3 Contrato do item da fila (`demurrage.leitura.fila.v1`)

| Campo | Origem |
|---|---|
| `processo` `{ id, numero }` | `processos` |
| `cliente` `{ id, nome }` | `clientes` |
| `house`, `mbl` | `processos.hbl`, `mbl` |
| `armador` `{ id, codigo, nome }` | `armadores` |
| `responsavelOperacional` `{ membershipId, nome }` | membership → `usuarios.nome` |
| `conteineres` `{ total, devolvidos, emDemurrage, comPendencia, concluidos }` | Composição oficial (Q8) sobre `containers.estado` persistido |
| `estadoMaisRelevante` `{ codigo, rotulo }` | `processos.estado_mais_relevante` + tradução de `situacao.ts` |
| `prioridade` `{ balde, promocaoTopo }` | `processos.prioridade_balde` + `derivarPrioridadeContainer` do líder |
| `motivoPrioridade` | `processos.prioridade_motivo` |
| `badges` | `containers.estado_badges` do líder e união dos demais (rotulada por contêiner no detalhe) |
| `ultimaAtualizacao` | maior entre `processos.lifecycle_calculated_at`, `containers.lifecycle_calculated_at`, `relogios.calculated_at` |
| `trackingAtualizadoEm` | maior `tracking_fetches.finalizado_em` (`ok`/`parcial`) dos alvos dos contêineres |
| `pendenciasAbertas` `{ total, porTipo }` | `demurrage_pendencias` (aberta) + `vessel_call_pendencias` (aberta) + `si_pendencias` (aberta, do processo) + `ft_divergencias` (`aberta`/`reaberta`/`reconhecida`) |
| `falhasTecnicas` `{ total, porTipo }` | `tracking_incidents` abertos dos alvos + `demurrage_pos_commit_outbox` e `recalculo_outbox` em `falha` |
| `exposicaoFinanceira` | Só MANAGER/ADMIN (Q2): valor do cliente e exposição Rocket ativos, cada um com situação (2.4); nunca somados entre moedas |
| `derivadoEm` | `lifecycle_calculated_at` — para a tela mostrar a idade da projeção |

Nada é calculado aqui além de contagens e máximos sobre linhas persistidas.

### 2.4 Envelope de confiabilidade (usado em todos os payloads)

Todo valor exibido carrega uma situação explícita, traduzida (não calculada)
do dado persistido:

| Situação | Quando |
|---|---|
| `CONFIRMADO` | `confirmation_status = CONFIRMED` |
| `ESTIMADO` | `ESTIMATED` |
| `ESTIMADO_PROVISORIO` | `ESTIMATED_PROVISIONAL` |
| `INDISPONIVEL` | `UNAVAILABLE` (total nulo — **nunca** zero) |
| `PENDENTE` | relógio `PENDING`/`INVALID`, ou relógio com dias e sem valor ativo |
| `NAO_APLICAVEL` | relógio `OK` sem dias |

## 3. Dois relógios separados

Cada contêiner retorna `relogioCliente` e `relogioRocket` como **objetos
independentes**, sem nenhum "status geral". Mesma forma, campos distintos:

| Campo | Cliente | Rocket |
|---|---|---|
| `descarga` `{ data, fonte, observadoEm, evidenciaRef }` | `discharge_date` + observação | idem |
| `freeTime` `{ dias, fonte, observadoEm, evidenciaRef, fallbackManual? }` | House | Master |
| `ultimoDiaLivre`, `primeiroDiaDemurrage`, `dataFinalApuracao` | `relogios` (cliente) | `relogios` (rocket) |
| `dias` | `diasDemurrage` | `diasExposicao` |
| `status`, `pendencias`, `motivo`, `calculadoEm` | `relogios` | `relogios` |
| `cache` `VALIDO`/`OBSOLETO`/`AUSENTE` | `RelogioRepository.buscarValido` (só leitura) | idem |
| `valor` `{ situacao, total, moeda, diasCobrados, motor }` | valor ativo do motor comercial aplicável | valor ativo `exposicao_armador` |
| `tabela` `{ id, versao, fonte, qualidade, vigencia }` | tabela comercial | tabela do armador |

- `cache` só **informa** que os fatos mudaram depois do último cálculo; a
  leitura **nunca** recalcula (o pipeline e o tick recalculam).
- A exposição Rocket segue Q2.

## 4. Responsabilidade (bloco `interno.responsabilidade`)

| Campo | Origem |
|---|---|
| `estadoDerivado` | `derivarResponsabilidade(apuracao, containers.responsabilidade)` — a mesma função do gate de fechamento |
| `decisaoVigente` | `containers.responsabilidade_decisao_id` → `responsabilidade_decisoes` |
| `versao`, `status`, `baseRelogio`, `diasRocket`, `diasCliente`, `valorStatus`, `valorRocket`, `valorCliente`, `moeda` | decisão |
| `justificativa`, `evidenciaRef`, `autor` `{ membershipId, nome, papel }`, `decididoEm` | decisão + membership |
| `periodos` | `responsabilidade_decisao_periodos` |
| `invalidada` `{ decisaoId, versao, motivo, em }` | Maior versão existente **sem** projeção + último `RESPONSABILIDADE_INVALIDADA` dessa decisão em `closing_events` |
| `historico` (só no detalhe) | Todas as versões, com `substitui`/`motivoCorrecao` |

- Todo o bloco fica sob a chave `interno`, separada do resto do payload, para
  deixar explícito que nada disso poderá ir ao Portal.
- **Observação sobre dado congelado:** a D11 grava o motivo de invalidação em
  duas grafias — `relogio_recalculado` (0032) e `VALOR_CLIENTE_RECALCULADO`
  (0033). A leitura normaliza as duas para um código único; a D11 não é
  alterada.

## 5. Timeline unificada

Nenhuma tabela nova: cada fonte ganha um **adaptador de leitura** que produz o
mesmo formato de evento, e a timeline é a união ordenada.

**Formato do evento:**

- `tipo`
- `dataOperacional` (data do fato) e `registradoEm` (instante da gravação)
- `origem` (`automatico`/`humano`) e `fonte` (tabela + campo de fonte)
- `autor` (quando humano) e `evidenciaRef`
- `resumo` (texto seguro montado por lista de campos permitidos)
- `ref` `{ tabela, id }`

| Tema | Fonte existente | Adaptador | Observação |
|---|---|---|---|
| Tracking (eventos) | `tracking_events` via `container_tracking_targets` | sim | `raw_ref` nunca sai; filtrar por número do contêiner (Q9) |
| Consultas de tracking | `tracking_fetches` | sim | status, contagem de eventos, cache |
| Descarga, Gate Out, retorno vazio | `field_observations` (`dischargeDate`, `gateOutDate`, `trackingReturnDate`) + `tracking_events` | sim | **`EMPTY_RETURN` existe no CHECK de `closing_events`, mas nenhum código o emite**; o Empty Return virá das observações e do tracking |
| Free Time e fontes | `field_observations`, `demurrage_fallback_manual_justificativas`, `si_proveniencias` | sim | De `si_proveniencias` só nome do anexo e data; **o trecho do e-mail não sai** |
| ETA | `vessel_call_eventos` (campo `eta`) | sim | |
| VesselCall e rolagem | `container_vessel_call_eventos`, `container_vessel_calls` | sim | |
| Minuta | `minutas` + `closing_events MINUTA_*` | sim | |
| Divergências | `closing_events DIVERGENCIA_TRACKING_MINUTA`, `ft_divergencias` + `ft_divergencia_eventos` | sim | |
| Recálculos | `closing_events RECALCULO`, histórico de `valores_apurados`, `snapshots` | sim | `relogios` não tem histórico |
| Responsabilidade | `closing_events RESPONSABILIDADE_*` + `responsabilidade_decisoes` | sim | |
| Fechamento e reabertura | `fechamentos`, `reaberturas`, `closing_events FECHAMENTO_FINAL`/`REFECHAMENTO`/`REABERTURA_*` | sim | |
| Falhas técnicas | `tracking_incidents`, `vessel_call_sync_incidents`, outboxes em falha | sim | Só etapa e estado; **mensagens de erro internas não saem** |
| Ações humanas | `closing_events` `origem=humano`, `field_observations.criado_por`, `demurrage_registros` | sim | |

**Regras do resumo seguro:** cada adaptador declara a lista de campos
permitidos; tudo o que não está nela é descartado. Nunca saem corpo de e-mail,
trecho de documento, token, `payload` bruto de `closing_events`, `raw_ref`,
`ultimo_erro` ou `falha_sanitizada`.

**Ordem (Q6):** `(dataOperacional ?? data de registradoEm, registradoEm,
fonte, id)`, totalmente determinística. Paginação por cursor dessa tupla
(*keyset* real, aqui é possível). Timeline por processo = união dos eventos do
processo e de todos os seus contêineres, cada evento indicando o contêiner.

## 6. Filtros

Todos mapeiam para **colunas ou badges já persistidos**, nunca para regra
reimplementada.

| Filtro | Predicado |
|---|---|
| organização | sempre a da sessão (não é parâmetro) |
| responsável, cliente, armador | colunas do processo |
| estado | `processos.estado_mais_relevante` |
| prioridade | `processos.prioridade_balde` |
| com pendência | existe pendência aberta (2.3) |
| com falha técnica | existe falha técnica (2.3) |
| dentro do Free Time | algum contêiner com estado persistido `MONITORAMENTO_SILENCIOSO` ou `PRAZO_PROXIMO` (Q4) |
| em demurrage | algum contêiner com badge `clienteEmDemurrage` ou `rocketExposta` |
| devolvido | algum contêiner com estado `DEVOLVIDO_AGUARDANDO_TRATAMENTO` ou `CONCLUIDO_PARA_ROCKET` (mesma regra da composição oficial, Q8) |
| responsabilidade em análise | badge `responsabilidadeEmAnalise` |
| exposição indisponível | valor Rocket ativo `UNAVAILABLE` |
| período | Q5 |
| busca | processo, MBL, House (processo) ou número de contêiner — `ILIKE` dentro da organização |

- Filtros combinam em `AND`.
- Valores de lista são validados contra os enums congelados; valor
  desconhecido → `400`.
- `GET /filtros` devolve as opções disponíveis na organização (responsáveis,
  clientes e armadores em uso, estados, baldes) e contagens por estado e por
  balde, feitas com `GROUP BY` sobre colunas persistidas.

## 7. Segurança e isolamento

**Fluxo de toda rota V2:**

1. `requireAuth` (já existente): sessão válida e conta MSAL ativa.
2. Resolver `usuarios` por `home_account_id` e os memberships **internos**
   (`ANALYST`/`MANAGER`/`ADMIN`).
3. Organização = a do membership (Q1). `CLIENT` → `403`. Nenhum
   `organizationId` é lido de query, corpo ou cabeçalho; se vier, é
   **ignorado**.
4. Toda query leva `organization_id = $org`, direto ou pelo `JOIN` a partir de
   `processos`/`containers` (tabelas sem `organization_id` nunca são
   consultadas soltas).
5. Recurso de outra organização ou inexistente → `404` idêntico, sem distinguir
   os dois casos.

**Tracking global:** alvos e eventos são compartilhados entre organizações. A
leitura parte sempre de `containers` da organização, depois
`container_tracking_targets`, depois o alvo, e filtra eventos pelo número do
contêiner (Q9).

**O que nunca sai:** corpo de e-mail, trecho de documento, token, segredo,
cache MSAL, `raw_ref`, `payload` bruto, erros internos.

**Observação sobre o modelo de autenticação atual:** o backend atende uma
única conta Microsoft ativa por vez (MVP). O RBAC da D12 valida o membership
dessa conta. A troca desse modelo não é escopo da D12.

## 8. Rotas propostas (somente GET)

| Rota | Retorno |
|---|---|
| `GET /api/demurrage/v2/processos` | Fila paginada (2.3), `cursor`, `limite`, filtros (6) |
| `GET /api/demurrage/v2/processos/:processoId` | Processo, contêineres (relógios separados, envelopes, `interno.responsabilidade` vigente), pendências, falhas, fechamento/reabertura |
| `GET /api/demurrage/v2/processos/:processoId/timeline` | Timeline paginada (5) |
| `GET /api/demurrage/v2/containers/:containerId` | Detalhe do contêiner, histórico de responsabilidade, versões de fotografia (metadados) |
| `GET /api/demurrage/v2/filtros` | Opções e contagens (6) |

- Arquivo novo `src/routes/demurrageV2Routes.ts`, montado no `index.ts`
  **antes** de `app.use('/api/demurrage', demurrageRouter)` (Q10). Hoje o
  router da V1 roda seu próprio `requireAuth` para **qualquer** caminho sob
  `/api/demurrage`, inclusive `/v2/...`.
- A V1 só tem `GET /` e `POST /solicitar-minuta`, então não há colisão de
  caminho; a ordem de montagem só evita o middleware duplicado.
- A V1 não é tocada, e não há endpoint do Portal.
- Cada payload traz `contrato: 'demurrage.leitura.v1'`, para a D13 depender
  de uma versão explícita.

## 9. Ações futuras (D13) — só mapeamento

| Ação | Serviço existente | Cuidado para a D13 |
|---|---|---|
| Atualizar tracking manualmente | `scheduler/trackingScheduler.solicitarAtualizacaoManual` (MANAGER/ADMIN, cooldown 2 h) | Rodar em segundo plano |
| Registrar ou corrigir Free Time | `registro/registrarProcessoDemurrage` (contrato D10; `manual_fallback` com justificativa, autor e evidência) | Nunca `UPDATE` direto na coluna |
| Reconhecer ou resolver divergência de Free Time | `freeTime/divergenciaAvisos.reconhecerDivergencia` / `resolverDivergencia` | |
| Confirmar ou corrigir responsabilidade | `responsabilidade/decidirResponsabilidade` (D11) | |
| Tratar minuta | `ClosingService.registrarMinuta` / `validarMinuta` | |
| Fechar | `ClosingService.finalizarProcesso` | |
| Solicitar reabertura | `ClosingService.solicitarReabertura` | |
| Autorizar reabertura | `ClosingService.autorizarReabertura` | |

**Atenção:**

- **Papel vindo do chamador.** `ClosingService` e `solicitarAtualizacaoManual`
  recebem o **papel como parâmetro**, sem validá-lo no banco. A D13 terá de
  derivar o papel do membership da sessão (a mesma resolução da seção 7),
  nunca da requisição.
- **Identificação do autor.** `divergenciaAvisos` recebe `usuario` como texto.
  A D13 deve passar o identificador vindo da sessão.

## 10. Desempenho

**Evidência (benchmark descartável, PostgreSQL local, banco próprio removido
depois):**

| Processos (2 contêineres cada) | Queries por requisição | Tempo por requisição |
|---|---|---|
| 300 | 1.801 | ~480 ms |
| 1.000 | 6.001 | ~1,7 s |

- **Fila:** o custo é N+1 do `montarFatos` (6 queries por líder, cada uma
  indexada). A correção é um carregamento em lote com `= ANY($1)`: as mesmas
  6 queries por requisição, não por processo (Q7). Critério: fila de 1.000
  processos abaixo de 300 ms e com número de queries constante.
- **Índices:** as queries do lote e do detalhe usam índices existentes:
  - `relogios_container_idx`;
  - `valores_apurados_container_idx`;
  - `container_tracking_targets_unica` (começa por `container_id`);
  - `tracking_fetches_target_idx`;
  - `tracking_incidents_aberto_unico`;
  - `containers_processo_numero_unique`;
  - `closing_events_processo_idx` / `_container_idx`;
  - `field_observations_entidade_idx`;
  - `minutas_container_idx`;
  - `snapshots_container_versao_unique`;
  - `responsabilidade_decisoes_container_idx`;
  - `demurrage_pendencias_aberta_unica`.

  **Nenhuma migration de índice está proposta.** Candidatos, só com `EXPLAIN`
  que prove necessidade no G5:
  - busca por MBL/House/número (`ILIKE` dentro da organização; com milhares
    de linhas, o filtro por `organization_id` já limita o conjunto);
  - `tracking_events (tracking_target_id, container_numero)` se a timeline
    filtrar muitos eventos.
- **Timeline:** cerca de 15 adaptadores indexados por processo ou contêiner,
  cada um com `LIMIT` do cursor. Custo proporcional aos eventos do processo,
  não da organização.
- **Consolidação multi-contêiner:** a fila usa o líder e a composição já
  persistidos, então não re-deriva os demais contêineres.
- **Volume:** sem dado real. O plano assume até ~2.000 processos ativos por
  organização e mede no G2 com 1.000 e 2.000.

## 11. Gates

### G1 — Contratos dos payloads

- **Arquivos:** `src/demurrage-engine/leitura/contrato.ts` (tipos da fila, do
  detalhe, da timeline e dos filtros; envelope de situação; mapeamentos puros
  persistido → contrato).
- **Queries e migrations:** nenhuma.
- **Testes:** unitários dos mapeamentos: `UNAVAILABLE` nunca vira zero;
  estimado nunca vira confirmado; relógios nunca se fundem; `interno`
  separado.
- **Risco:** baixo.
- **Critério de aprovação:** todos os tipos com `contrato` versionado e 100%
  dos mapeamentos cobertos.

### G2 — Read model da fila

- **Arquivos:**
  - `leitura/filaOperacional.ts`;
  - aditivo em `persistence/lifecycleRepository.ts` (lote de `montarFatos`,
    reconstrução pública; Q7);
  - aditivo em `lifecycle/processConsolidation.ts` (composição exportada; Q8).
- **Queries:** processos + líder da organização; lote de fatos; contagens de
  pendências e falhas por processo.
- **Migrations:** nenhuma.
- **Testes:**
  - **equivalência:** `montarFatos(id)` e o lote retornam fatos idênticos
    para todos os cenários de fixture;
  - ordem oficial com dois processos de prioridades diferentes;
  - desempate idêntico ao `ordenarFila`;
  - multi-contêiner consolidado;
  - regressão completa do lifecycle.
- **Risco:** médio (toca código congelado de forma aditiva). Mitigação: um
  único caminho de implementação e o teste de equivalência.
- **Critério de aprovação:** ordem idêntica à do serviço oficial; 1.000
  processos abaixo de 300 ms com queries constantes; suítes F7/F8/D10/D11
  verdes.

### G3 — Detalhe de processo e contêiner

- **Arquivos:** `leitura/detalhe.ts`.
- **Queries:** relógios, valores ativos, tabelas, observações das datas e
  Free Time, responsabilidade (vigente, invalidada, histórico), minutas,
  pendências, fechamento/reabertura.
- **Migrations:** nenhuma.
- **Testes:**
  - relógios separados;
  - estimado ≠ confirmado; indisponível permanece indisponível;
  - responsabilidade invalidada volta como "em análise", com motivo
    normalizado;
  - `cache OBSOLETO` sinalizado sem recalcular.
- **Risco:** baixo.
- **Critério de aprovação:** payload completo contra cenários reais do
  pipeline (sem mock), com zero escrita no banco.

### G4 — Timeline

- **Arquivos:** `leitura/timeline.ts` (um adaptador por fonte, com lista de
  campos permitidos).
- **Queries:** união dos adaptadores com cursor.
- **Migrations:** nenhuma.
- **Testes:**
  - ordem determinística (mesmo resultado em repetições e com empates de
    instante);
  - nenhum campo proibido no payload (teste de contrato permanente);
  - evento de tracking de contêiner de outra organização nunca aparece;
  - paginação sem duplicar nem omitir.
- **Risco:** médio (muitas fontes).
- **Critério de aprovação:** todas as fontes da seção 5 cobertas; teste de
  campo proibido verde.

### G5 — Filtros e paginação

- **Arquivos:** `leitura/filtros.ts`.
- **Queries:** predicados da seção 6; opções e contagens.
- **Migrations:** só índice com `EXPLAIN` anexado ao pedido.
- **Testes:**
  - cada filtro isolado;
  - filtros combinados;
  - valor inválido → `400`;
  - paginação da fila sem duplicar nem omitir;
  - `409 ordem_alterada` quando os dados mudam entre páginas.
- **Risco:** baixo.
- **Critério de aprovação:** matriz de filtros verde; paginação percorrida de
  ponta a ponta igual à lista completa.

### G6 — RBAC e isolamento

- **Arquivos:** `leitura/autorizacao.ts` (sessão → usuário → membership →
  organização e papel).
- **Queries:** membership por `home_account_id`.
- **Migrations:** nenhuma.
- **Testes:**
  - organização A nunca vê B, em cada rota e por id direto;
  - `CLIENT` → `403`;
  - sem sessão → `401`;
  - `organizationId` na query ou no corpo é ignorado;
  - recurso de outra organização → `404`;
  - ANALYST sem exposição Rocket (Q2);
  - Q1 com mais de um membership.
- **Risco:** alto se errar. Mitigação: resolução única da organização e
  testes em todas as rotas.
- **Critério de aprovação:** matriz papel × rota × organização 100% verde.

### G7 — Rotas V2 e regressão da V1

- **Arquivos:** `src/routes/demurrageV2Routes.ts`; `src/index.ts` (uma linha,
  antes da V1).
- **Queries:** as dos gates anteriores.
- **Migrations:** nenhuma.
- **Testes:**
  - HTTP ponta a ponta de cada rota;
  - **GETs não gravam nem recalculam:** impressão digital do banco antes e
    depois, e espiões garantindo que `recalcularApuracao*`, `RelogioRepository
    .recalcular*`, `atualizarFotografia` e `decidirResponsabilidade` não são
    chamados;
  - **V1 idêntica:** `GET /api/demurrage` e `POST /solicitar-minuta` com a
    mesma resposta de antes, e a suíte V1 verde.
- **Risco:** baixo.
- **Critério de aprovação:** engine, V1, `tsc` e build verdes; V1 sem
  diferença.

## 12. Testes de aceitação

| Aceitação | Gate |
|---|---|
| Dois processos com prioridades diferentes saem na ordem oficial | G2 |
| Processo multi-contêiner consolida corretamente | G2 |
| Os dois relógios nunca se misturam | G1/G3 |
| Valor estimado não aparece como confirmado | G1/G3 |
| Exposição indisponível permanece indisponível | G1/G3 |
| Responsabilidade invalidada volta a aparecer em análise | G3 |
| Timeline mantém ordem determinística | G4 |
| Filtros combinados funcionam | G5 |
| Paginação não duplica nem omite itens | G5 |
| Organização A nunca enxerga organização B | G6 |
| `CLIENT` recebe 403 | G6 |
| V1 permanece idêntica | G7 |
| GETs não gravam nem recalculam nada | G7 |

Todos com PostgreSQL real e cenários construídos pelo pipeline oficial (sem
dados mockados na implementação).

## 13. Achados em código congelado (registrados, não alterados)

1. `closing_events.tipo_evento` aceita `EMPTY_RETURN`, mas nada o emite.
2. O motivo de `RESPONSABILIDADE_INVALIDADA` tem duas grafias (0032 e 0033).
3. `ClosingService` e `solicitarAtualizacaoManual` confiam no papel informado
   pelo chamador.
4. `relogios` guarda só o estado atual; o histórico temporal vem de eventos,
   valores e fotografias.
5. Tracking é global; o isolamento depende do `JOIN` a partir do contêiner.

## 14. Decisões pendentes (detalhe)

- **Q1 — Organização.** Hoje a sessão não tem organização.
  - *Opção A (recomendada):* um único membership interno → usá-lo; mais de
    um → `409 organizacao_ambigua`.
  - *Opção B:* criar agora a seleção de organização na sessão (rota de
    escrita de sessão), que extrapola "somente GET" da D12.
- **Q2 — Exposição Rocket.**
  - *Recomendada:* MANAGER/ADMIN veem; ANALYST recebe `{ restrito: true }`.
    O valor do cliente fica visível a todos os papéis internos.
  - *Alternativa:* os três papéis veem tudo.
- **Q3 — `SILENCIOSO` na fila.** Recomendo excluir por padrão (Cap. 22.6) e
  permitir `incluirSilenciosos=true`.
- **Q4 — Semântica multi-contêiner.** Recomendo que o processo entre no filtro
  se qualquer contêiner satisfaz. A alternativa é olhar só o líder.
- **Q5 — Período.** Recomendo intervalo sobre a descarga de qualquer
  contêiner, com devolução como alternativa selecionável.
- **Q6 — Ordem da timeline.** Recomendo data operacional primeiro.
  Alternativa: instante de registro primeiro.
- **Q7 — Lote de `montarFatos`.** Refatoração aditiva no `LifecycleRepository`
  (F7/F8 congelados): `montarFatos(id)` passa a delegar ao lote, com uma única
  implementação das regras. Sem isso, a fila é N+1 (seção 10).
- **Q8 — Composição.** Extrair a contagem já existente em `consolidarProcesso`
  para uma função pura exportada, usada pela própria consolidação. Sem mudança
  de comportamento; evita copiar a regra de "devolvido/em demurrage" para SQL.
- **Q9 — Eventos sem número de contêiner em alvo compartilhado.** Recomendo
  incluir, marcados como `escopo: embarque`. Alternativa: excluir.
- **Q10 — Montagem da rota.** Montar a V2 antes da V1 no `index.ts`.
- **Q11 — Falhas técnicas e pendências.** Composição proposta na seção 2.3:
  - falhas = incidentes de tracking abertos + outboxes em `falha`;
  - pendências = as quatro fontes listadas, contadas por tipo.

Nada será implementado antes da sua aprovação.
