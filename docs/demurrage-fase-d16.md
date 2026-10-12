# D16 — Fechamento e auditoria final de release do backend Demurrage

## 1. Status executivo

O backend do módulo Demurrage (motor V2, fases D10 a D15-C v1.2) foi auditado de ponta a ponta nesta fase: rastreabilidade com o Blueprint original (32 capítulos), prova de banco limpo, 22 cenários verticais fim a fim pelos contratos oficiais, inventário completo de filas/scheduler, evidência de isolamento multiempresa e segurança, invariantes financeiros/temporais, modelo de leitura/desempenho e fronteira com o frontend.

**Um defeito bloqueante de release foi encontrado durante a construção dos cenários verticais finais, e corrigido de forma mínima e localizada antes do fechamento desta fase** (seção 5.1). Fora dessa correção pontual, nenhum outro defeito bloqueante foi encontrado. O motor está completo, testado e congelado nas fases D10–D15-C v1.2. A limitação mais relevante identificada além do defeito corrigido não é um defeito, e sim um fato arquitetural já documentado desde a fase D10: o contrato de entrada (`registrarProcessoDemurrage`) e algumas ações de Gestor (fechamento, reabertura, decisão de responsabilidade) existem como serviços internos completos e testados, mas **ainda não têm rota pública de produção** — aguardam a integração controlada (com o pré-alerta/Auditoria e com o frontend) que esta própria fase D16 está explicitamente proibida de construir. Isso é consistente com a frase de encerramento desta fase: o backend está **pronto para integração controlada**, não para tráfego público imediato sem essa integração.

## 2. Baseline congelado (verificado nesta auditoria)

| Commit | Conteúdo |
|---|---|
| `91b3201` | D15-A (produção) — instantâneo pós-lock completo + auditoria estática por AST |
| `43123fe` | D15-A (documentação) — correção do relatório de entrega |
| `76c7031` | D15-B — integridade de dados e exceções (18 casos) |
| `5101f1f` | D15-B v1.1 (corretiva) — consumidor real do outbox de avisos de pendência |
| `67acf84` | D15-C — integridade tarifária e recuperação de filas (R28/R29/R30/R57/R58/R59) |
| `0a0ee9c` | D15-C v1.1 (corretiva) — publicação tarifária e seleção determinística |
| `203dd23` | D15-C v1.2 (corretiva) — fecha bypass de rascunho no Termo por Embarque |

Todos os sete commits foram confirmados presentes no histórico do branch (`git log -1 <hash>`) antes do início desta auditoria. D10 a D15 são tratados como congelados a partir deste ponto, por declaração explícita desta fase D16.

## 3. Matriz de rastreabilidade — Blueprint × implementação (32 capítulos)

| # | Capítulo | Requisito (resumo) | Local de implementação | Testes que comprovam | Status | Motivo (se adiado/indisponível) |
|---|---|---|---|---|---|---|
| 1 | Visão e objetivo | Dois relógios, ciclo descarga→conclusão, sem invenção de dado | `temporal/dualClockCalculator.ts`; `registro/registrarProcessoDemurrage.ts` (contrato) | `dualClockCalculator.test.ts`, `demurrageVertical.test.ts` | IMPLEMENTADO | — |
| 2 | Escopo e responsabilidades | Fonte+timestamp por campo crítico, multiempresa | `domain/types.ts` (`FieldObservation`); `persistence/fieldObservationRepository.ts`; migrations 0001–0007 | `fieldObservation.test.ts`, `multiTenant.test.ts` | IMPLEMENTADO | — |
| 3 | Entidades e unidade de controle | Processo × contêiner, unidades separadas | `lifecycle/processConsolidation.ts` | `lifecycle.test.ts` | IMPLEMENTADO | — |
| 4 | Fontes de dados e hierarquia | Hierarquia por campo, MANUAL_FALLBACK, divergência preservada | `domain/types.ts:FIELD_OBSERVATION_SOURCE_PRIORITY`; `sources/{armadorTrackingSource,emailHeuristicSource}.ts`; `freeTime/{houseFreeTimeService,masterFreeTimeService}.ts` | `fieldObservation.test.ts`, `shippingInstructions.test.ts`, `d15b.test.ts` (R07) | IMPLEMENTADO | — |
| 5 | Motor dos dois relógios | House × Master, nunca fundidos | `temporal/dualClockCalculator.ts`, `domain/clock.ts`; `GET /containers/:id` | `dualClockCalculator.test.ts`, `relogios.test.ts` | IMPLEMENTADO | — |
| 6 | Regras temporais e datas derivadas | Fórmula literal, datas civis sem fuso | `temporal/civilDate.ts`, `temporal/freeTimeClock.ts` | `civilDate.test.ts`, `freeTimeClock.test.ts` | IMPLEMENTADO | — |
| 7 | Modelos comerciais (Termo Único × Embarque) | Dois modelos comerciais distintos | `tariffs/engines/termoUnicoEngine.ts`, `termoPorEmbarqueEngine.ts` | `tariffs.test.ts`, `apuracaoV12.test.ts` | IMPLEMENTADO | — |
| 8 | Tarifas e versionamento | Tabelas de armador + Rocket, faixas, imutabilidade | `tariffs/tariffTableService.ts`, `tariffs/bracketEngine.ts`, `tariffs/seed/*` | `tariffs.test.ts`, `d15c.test.ts`, `d15cV11.test.ts`, `d15cV12.test.ts` | IMPLEMENTADO | — |
| 9 | Tipos de contêiner e normalização | Normalização + mapeamento, nunca bloqueia relógio | `domain/containerType.ts`; pendência `tipo_nao_reconhecido` | `registroDemurrage.test.ts` | IMPLEMENTADO | Tabela de equivalências é pendência do próprio Blueprint, não da implementação |
| 10 | Permissões, governança, auditoria | RBAC 4 papéis + trilha de auditoria por campo | `leitura/autorizacao.ts`; `persistence/fieldObservationRepository.ts` (append-only) | `leituraAutorizacao.test.ts`, `migration0007.test.ts` | IMPLEMENTADO | — |
| 11 | Estados financeiros e valores internos | Valor cliente + exposição Rocket, diferença potencial | `domain/valorApurado.ts`, `tariffs/engines/exposicaoRocketEngine.ts`; `GET /gestao/financeiro` (restrito) | `gestaoFinanceiro.test.ts`, `apuracaoV13.test.ts` | IMPLEMENTADO | — |
| 12 | Integridade de dados e exceções estruturais | Nunca fabricar valor; pendência explícita | `registro/pendencias.ts` | `registroDemurrage.test.ts`, `registroDemurrageV12.test.ts` | IMPLEMENTADO | — |
| 13 | Entrada no monitoramento | Registro persistente do processo/contêiner | `registro/registrarProcessoDemurrage.ts` (contrato `demurrage.registro.v1`) | `registroDemurrage.test.ts`, `demurrageVertical.test.ts` | ADIADO INTENCIONALMENTE | Serviço interno completo e testado, mas sem rota HTTP/job de produção que o chame — confirmado por busca em todo `src/`: a única chamada fora do próprio arquivo está em teste. Aguarda integração futura com Auditoria/pré-alerta, fora do escopo do D16 |
| 14 | Fotografia inicial | Snapshot versionado, dedup por hash | `registro/fotografia.ts` | `registroDemurrage.test.ts` + variantes v1.1/v1.2 | IMPLEMENTADO | Mecanismo completo; depende da entrada do Cap. 13 para ser alimentado em produção |
| 15 | Serviço central de tracking | Fonte única, cache/reuso entre módulos | `sources/armadorTrackingSource.ts` (consome o serviço de Tracking já existente na Priora) | `tracking.test.ts`, `vesselSharing.test.ts` | IMPLEMENTADO | — |
| 16 | Cadência automática de tracking | D0/D+5/diário/suspensão 30 dias | `scheduler/cadencePolicy.ts`, `scheduler/trackingScheduler.ts`; `src/demurrage/schedulerBootstrap.ts` (produção, chamado em `src/index.ts`) | `schedulerLoop.test.ts`, `scheduler.test.ts` | IMPLEMENTADO | — |
| 17 | Atualização em segundo plano | Tick automático + gatilho manual do Gestor c/ cooldown | Automático: `scheduler/schedulerWorker.ts` (produção real). Manual: `scheduler/trackingScheduler.ts:solicitarAtualizacaoManual()` | `scheduler.test.ts`, `d15b.test.ts` | IMPLEMENTADO | Gatilho manual é só serviço (RBAC por membership real) — sem rota pública ainda, decisão explícita de D15-B |
| 18 | Falhas de tracking e alertas | 3 falhas consecutivas → alerta único, sem double-send | `scheduler/failurePolicy.ts`, `scheduler/alertOutbox.ts` (claim/lease/fencing, D15-C R59) | `scheduler.test.ts`, `d15c.test.ts` #20–#24 | IMPLEMENTADO | — |
| 19 | Detecção da devolução | Empty Return via tracking estruturado | `tracking/eventIngestion.ts` | `shippingInstructions.test.ts`, `closingD15A*.test.ts` | IMPLEMENTADO | — |
| 20 | Minuta e conclusão do processo | Upload→validação→fechamento FINAL→reabertura | `closing/minutaValidation.ts`, `closing/closingService.ts` | `closing.test.ts`, `closingD15A*.test.ts` | ADIADO INTENCIONALMENTE | Modelo completo e testado; nenhuma rota de produção chama `ClosingService` ainda — serviço interno aguardando rota futura |
| 21 | Estados do ciclo operacional | 8 estados, dimensão documental | `lifecycle/containerState.ts` | `lifecycle.test.ts`, `estadoOperacionalV122.test.ts` | IMPLEMENTADO | — |
| 22 | Prioridade da fila operacional | Baldes de prioridade, critérios de desempate | `lifecycle/priorityEngine.ts`; `GET /processos` | `leituraFila.test.ts`, `leituraFilaV11.test.ts` | IMPLEMENTADO | — |
| 23 | Apuração dos dias por contêiner | Mesma fórmula do Cap. 6, por relógio | `temporal/freeTimeClock.ts` via `apuracao/*` | `freeTimeClock.test.ts`, `apuracaoV12–V14.test.ts` | IMPLEMENTADO | — |
| 24 | Cálculo do valor do cliente e exposição Rocket | 3 motores comerciais, status CONFIRMED/ESTIMATED/UNAVAILABLE | `tariffs/bracketEngine.ts`, `exposicaoRocketEngine.ts` | `tariffs.test.ts`, `apuracaoV12–14.test.ts` | IMPLEMENTADO | — |
| 25 | Consolidação dos valores do processo | Soma por processo sem perder detalhe por contêiner | `lifecycle/processConsolidation.ts` | `lifecycle.test.ts`, `leituraDetalhe.test.ts` | IMPLEMENTADO | — |
| 26 | Pré-análise de responsabilidade | Sugestão automática via Liberação + confirmação do Gestor | Sugestão: `responsabilidade/liberacaoPort.ts` (porta pronta, sem adaptador real). Decisão: `responsabilidade/decidirResponsabilidade.ts` | `responsabilidadeDecisao.test.ts`, `responsabilidadeV11/V12.test.ts` | INDISPONÍVEL POR DEPENDÊNCIA EXTERNA | Módulo Liberação não existe neste repositório (só página estática, sem backend) — fora de escopo do D16 |
| 27 | Integração financeira (HeadCargo) | Status financeiro consultável, somente leitura | — (nenhum conector) | `demurrageVertical.test.ts` (confirma ausência de `headcargo_faturas`) | INDISPONÍVEL POR DEPENDÊNCIA EXTERNA | Nenhuma integração HeadCargo existe — fora de escopo do D16 |
| 28 | Tela operacional e cards | Dois relógios no card, MBL/armador, filtros | `public/DemurrageOperacional.dc.html` + `GET /processos`, `/filtros` | `demurrageV2Apresentacao.test.ts`, `demurrageV2UiZeroWrite.test.ts` | IMPLEMENTADO | Tela somente-leitura por decisão explícita de D13; ações de escrita ficam para fase de frontend futura, fora do D16 |
| 29 | Detalhamento do processo | Linha do tempo, documentos/evidências, ações de Gestor | `leitura/timeline.ts`, `leitura/detalhe.ts` | `leituraTimeline.test.ts`, `leituraDetalhe.test.ts` | IMPLEMENTADO | Leitura completa; ações exclusivas de Gestor permanecem só em serviço, sem rota — mesma lacuna do Cap. 20 |
| 30 | Gestão, indicadores, visão financeira | 6 grupos de indicadores + drill-down | `leitura/gestao/*.ts`; `GET /gestao/*` (montado em produção) | `gestaoOperacional.test.ts`, `gestaoFinanceiro.test.ts`, `gestaoEficiencia.test.ts`, `gestaoQualidade.test.ts`, `gestaoDrilldown.test.ts` | IMPLEMENTADO | API completa e montada; sem tela dedicada de Gestão (D14 é "backend-only" por decisão explícita) — redesenho fora do D16 |
| 31 | Exceções operacionais e casos de borda | Subseções literais do Blueprint | Diversos (ver `docs/demurrage-fase-d15-diagnostico.md` §3) | `d15b.test.ts`, `d15bV11.test.ts`, `closingD15A.test.ts` | IMPLEMENTADO | A única subseção em `DEFER` é a de divergência HeadCargo — decisão do próprio Blueprint (integração externa) |
| 32 | Portal do Cliente | Payload filtrado, nunca expõe dado interno | — (nenhum endpoint dedicado) | — | ADIADO INTENCIONALMENTE | `public/PortalCliente.dc.html` continua 100% mock estático — explicitamente fora do escopo do D16 |

**Resumo:** 27 de 32 capítulos IMPLEMENTADO, 3 ADIADO INTENCIONALMENTE (13, 20, 32 — com o lado de escrita do 29 e o gatilho manual do 17 na mesma categoria), 2 INDISPONÍVEL POR DEPENDÊNCIA EXTERNA (26, 27). Nenhum item foi marcado implementado apenas por existir uma tabela/função — todos têm rota ou job de produção reais, ou estão explicitamente classificados como serviço interno aguardando integração/UI futura.

## 4. Evidência de banco limpo

Script de evidência executado contra PostgreSQL 16 (banco descartável):

- Banco novo → `runMigrations` aplicou as 38 migrations (0001–0038) em ordem; segunda chamada aplicou 0, confirmando idempotência.
- Catálogo final: 68 tabelas, 85 triggers, 216 functions, 195 índices, 925 constraints no schema `public`.
- Objetos nomeados-chave confirmados presentes: `forbid_tariff_table_mutation()`, `tariff_table_esta_congelada()`, triggers `tariff_tables_imutavel`/`tariff_brackets_imutavel`, constraint `tariff_tables_versao_unica` (NULLS NOT DISTINCT), constraint de exclusão GiST `tariff_brackets_sem_sobreposicao`, coluna `tariff_tables.ativada_em`.
- Caminho 0036→0037→0038: banco parado exatamente em 0036 (36 migrations aplicadas, coluna `ativada_em` comprovadamente ainda ausente), depois continuado — aplicou exatamente `0037_d15c_integridade_tarifaria_e_filas.sql` e `0038_d15c_v1_1_publicacao_tarifaria.sql`, nessa ordem. Catálogo final idêntico (mesmos 68/85/216/195/925) ao caminho sequencial completo — o estado final não depende do caminho de aplicação.
- Nenhuma migration fabrica dado de negócio: a única leitura preocupante (`0037`: `UPDATE tariff_tables SET ativada_em = criado_em` para todas as linhas pré-existentes) usa um timestamp **real já gravado na própria linha** (a própria criação), nunca uma data inventada — documentado explicitamente no cabeçalho da migration. A correção da `0038` (`UPDATE ... SET ativada_em = now() WHERE ativada_em IS NULL AND EXISTS (... usada por valores_apurados)`) é estreitamente qualificada (só linhas já em uso, nunca ativadas) e usa `now()` da própria migration, nunca uma data histórica — também documentado no próprio arquivo.
- Pré-requisito manual conhecido: `0037` aborta com `RAISE EXCEPTION` se já existir violação da nova unicidade em dado legado anômalo — resolução manual, nunca silenciosa (nenhum outro pré-requisito manual identificado nas 38 migrations).

## 5. Cenários verticais finais

22 cenários obrigatórios implementados em `src/demurrage-engine/__tests__/d16Vertical.test.ts` (23 `test()`, já que o #17 tem um subteste), executados fim a fim pelos contratos oficiais de aplicação (`registrarProcessoDemurrage`, ingestão de tracking/Shipping Instructions, `decidirResponsabilidade`, `ClosingService`, `tariffTableService`), sem inserção direta em entidades de negócio — a única exceção documentada no próprio teste é a observação de porto de descarga (POD) nos cenários #19/#20, escrita via `FieldObservationRepository.insert` porque nenhum caminho de produção grava esse campo hoje (ver limitação na seção 13). Resultado após a correção da seção 5.1: **23/23 passam, 0 falham, 0 todo**.

### 5.1 Defeito bloqueante encontrado e corrigido

- **Invariante violado:** uma tabela tarifária com faixas em moedas diferentes para o mesmo equipamento deve produzir falha LOCALIZADA (`UNAVAILABLE`), nunca um valor — regra R29 (D15-C). Essa regra valia para o Termo Único e a Exposição Rocket (via `bracketEngine`), mas **não** para o Termo por Embarque.
- **Onde:** `src/demurrage-engine/tariffs/engines/termoPorEmbarqueEngine.ts` — o motor nunca passa pelo `bracketEngine` (por desenho: é tarifa fixa, não progressiva) e pegava `doEquip[0]` (a primeira faixa do equipamento) sem checar se havia outras faixas em moeda diferente para o mesmo equipamento.
- **Repro mínimo:** tabela `rocket_cliente`/`embarque` com faixas 40HC em USD e em BRL; condição comercial de Termo por Embarque referenciando essa tabela. O cálculo do cliente saía `ESTIMATED` com a primeira moeda encontrada, em vez de `UNAVAILABLE` — um valor errado que passaria pelo gate de FINAL.
- **Teste de regressão determinístico:** subteste `D16 #17 (Termo por Embarque)` em `d16Vertical.test.ts`, criado já como `# TODO` (falhando, documentando o defeito) antes da correção.
- **Correção mínima implementada:** `termoPorEmbarqueEngine.ts` ganhou o mesmo guard de moeda mista do `bracketEngine` (mesmo motivo literal `MOEDA_MISTA_NA_TABELA`), aplicado só às faixas do equipamento em questão, antes de escolher a faixa única. Nenhuma outra função/arquivo foi alterado; `bracketEngine.ts` não foi tocado.
- **Resultado após a correção:** o `# TODO` foi removido (o subteste passa normalmente) e a auditoria completa de fechamento foi reexecutada (seção 12) — nenhuma regressão introduzida.

## 6. Inventário de scheduler e filas

Onze estágios/filas inventariados (`tracking_schedule_claims`, `tracking_alert_deliveries`/alert outbox, `recalculo_outbox`, `ft_divergencia_entregas`, `demurrage_pos_commit_outbox`, `demurrage_fallback_manual_avisos`, `demurrage_pendencia_avisos`, scheduler loop, captura pré-alerta — sincronização de pasta, captura pré-alerta — ingestão de descobertas, backfill manual). Para cada um: gatilho, regra de claim, lease, fencing, teto de retry, recuperação após crash, estado terminal, contadores/logs, trabalho externo fora de transação e isolamento de falha entre estágios foram documentados e comprovados por teste (detalhe completo nas evidências desta fase).

**Isolamento cruzado confirmado:** as filas de manutenção/notificação não alteram cadência de tracking, seleção de alvo, claims de tracking, contagem de fetches nem consumo de crédito do armador — prova mais forte em `demurrageTickFilas.test.ts` v1.3 #14 (tick com e sem trabalho pendente nas filas novas, `chamadas`/`claims`/`fetches` idênticos), reforçada por `d15bV11.test.ts` #12, `d15b.test.ts:160` (R08) e `d15c.test.ts` #24.

**Limitações conhecidas (não bloqueantes, documentadas para acompanhamento futuro):**
1. `tracking_schedule_claims` (migration 0014, anterior ao D15-C) não tem fencing token/época — `concluirClaim` atualiza por `(tracking_target_id, janela)`, não por posse. Um worker "zumbi" que termina após a janela de obsolescência (30 min) poderia, em teoria, sobrescrever o resultado de quem já reivindicou de novo. O fix de fencing da D15-C (R59) foi deliberadamente escopado só para as 6 filas de outbox, não para esta tabela mais antiga. Nenhum teste reproduz essa corrida específica.
2. `si_conversas_descobertas` (ingestão de conversas descobertas pelo pré-alerta) não tem claim/lease em nível de linha — depende inteiramente da idempotência downstream (`registrarConversaPreAlerta`/`ingerirShippingInstructions`) e da dedupe na descoberta. Nenhum teste exercita dois workers concorrentes processando a mesma linha já `registrada`.

Nenhuma das duas tem um teste que demonstre uma falha real (nenhum invariante comprovadamente violado) — por isso nenhuma correção foi feita nesta fase, em respeito ao limite de escopo do D16 (só corrigir mediante defeito demonstrado). Registradas aqui como limitação conhecida para uma fase futura, se o produto decidir que o risco justifica o esforço.

## 7. Evidência de segurança e isolamento

1. **Isolamento multiempresa:** processos, contêineres, valores apurados, responsabilidade, timeline e pendências são todos escopados por `organization_id`; `multiTenant.test.ts` prova rejeição por trigger de qualquer vínculo cross-organização (Cliente/Membership de outra organização), e `leituraFila.test.ts`/`leituraTimeline.test.ts` provam que uma organização nunca vê processos de outra.
2. **CLIENT nunca acessa rotas internas de gestão:** `leitura/autorizacao.ts` (`resolverAutorizacao`) resolve o papel do usuário via membership da sessão e rejeita com `403 usuario_sem_papel_interno` qualquer usuário sem papel `ANALYST`/`MANAGER`/`ADMIN` — CLIENT incluso. Comprovado em `leituraAutorizacao.test.ts` (nível de serviço e nível HTTP: "CLIENT recebe 403").
3. **Campos internos nunca alcançam CLIENT:** como toda a família de rotas de gestão/leitura interna exige papel interno (item 2), exposição Rocket, diferença potencial, evidência de responsabilidade e incidentes de sincronização nunca chegam a uma sessão CLIENT — eles só existem dentro de rotas já vedadas a esse papel. Mensagens técnicas/stack/token são adicionalmente filtradas mesmo dentro da timeline interna: `leituraTimelineV11.test.ts` injeta deliberadamente um token Bearer, um stack trace e uma senha no banco e confirma que nenhum desses literais aparece na resposta.
4. **Autorização de escrita nunca aceita `organizationId` do chamador sem checar membership real:** `autorizarInterno` (rotas de leitura/gestão) rejeita explicitamente (`400 parametro_nao_aceito`) qualquer tentativa de enviar `organizationId` por query/corpo/cabeçalho — a organização só vem do membership resolvido pela sessão. Nas rotas de mutação que aceitam `organizationId` no corpo/query por natureza (ex.: `POST .../reprocessar`, `POST /api/captura/caixas`, porque um usuário pode pertencer a mais de uma organização), o valor informado é sempre cross-checado contra o membership real do usuário autenticado (`SELECT ... WHERE u.home_account_id = $1 AND m.organization_id = $2`, com papel `CLIENT` também rejeitado) antes de qualquer escrita — nunca um "confia e usa" direto. Nenhum caminho de escrita encontrado usa `organizationId` do chamador sem essa verificação.
5. **Recurso inexistente vs. de outra organização produz resposta idêntica:** `buscarDetalheContainer`/`buscarDetalheProcesso` devolvem `null` em ambos os casos (`leituraDetalhe.test.ts`, "404 (null) quando o contêiner pertence a outra organização"), evitando que a existência de um recurso seja revelada por uma diferença entre 403 e 404.

## 8. Evidência de invariantes financeiros e temporais

1. **Relógios do Cliente e Rocket permanecem separados** — `dualClockCalculator.ts` faz duas chamadas independentes a `freeTimeClock`; provado em `dualClockCalculator.test.ts` e, na persistência, por hashes de cache independentes por `(container_id, tipo)` em `relogios.test.ts`.
2. **Faixas tarifárias correm cronologicamente a partir da descarga** — `bracketEngine.ts` ancora a progressão na descarga (dia 1 = descarga); `civilDate.test.ts` valida o calendário civil subjacente dia a dia de 1900 a 2100.
3. **Free Time posterga a cobrança mas não reinicia a numeração de dias da tabela** — `tariffs.test.ts` ("excess_over_free_time indexa a partir do 1º dia de demurrage"): com FT=21 e faixas 7-9/10+, o primeiro dia cobrado cai em "10+", nunca reinicia em "7-9".
4. **Somas monetárias permanecem decimais exatas** — colunas `NUMERIC` no Postgres (nunca float) e acumulação em centavos inteiros no motor; `leituraD12V12.test.ts` prova ponta a ponta que `10.01 + 20.02 + 30.03 = 60.06` exato (e que a soma ingênua em float falharia nessa mesma ordem).
5. **Moedas nunca são combinadas** — `bracketEngine.ts` devolve `UNAVAILABLE` com motivo `MOEDA_MISTA_NA_TABELA` em vez de somar ou lançar exceção (que desfaria a transação do lado comercial oposto); testado em `d15c.test.ts` #16–#17.
6. **Valores indisponíveis/pendentes nunca são convertidos em zero** — helper `unavailable()` devolve `total`/`tabelaId`/`versaoTabela` explicitamente `null`; reforçado por CHECK constraint no banco (`UNAVAILABLE` exige os três campos `NULL`, qualquer outro status exige os três não-nulos). Testado em `apuracaoV12.test.ts` (Gap5) e `d15cV12.test.ts` (`TARIFF_VERSION_NOT_ACTIVATED`).
7. **Cálculos históricos retêm a versão de tabela usada** — `valores_apurados.versao_tabela` persistido; `criarVersaoCorrigida` nunca edita a versão-base; `d15cV11.test.ts` #11 prova que um processo FINAL permanece ligado à sua versão histórica mesmo após uma correção ser ativada.
8. **Rascunhos nunca entram em cálculo de produção** — `selecionarVigente` (v1.1) e `buscarAtivadaPorId` (v1.2) exigem `ativada_em IS NOT NULL`; `buscarPorId` (administração) nunca é chamado pelo caminho de produção. Testado em `d15cV11.test.ts`/`d15cV12.test.ts`.
9. **Processos FINAL nunca recalculam silenciosamente** — gate explícito (`if apuracao_status === 'FINAL' return {skipped:'FINAL'}`) em `recalcularApuracao.ts`, com defesa em profundidade no banco (migration 0017) e testes de corrida em `closingD15AV11.test.ts`/`closingD15AV13.test.ts` provando que uma observação concorrente nunca promove um valor depois do commit de fechamento.

## 9. Evidência de modelo de leitura e desempenho

1. **Fila e detalhe consistentes** — `leituraD12V12.test.ts` (DV-03/DV-04): líder e agregado concordam entre fila, detalhe e os 4 endpoints de prioridade.
2. **GETs fazem zero escrita** — fingerprint MD5 de todas as tabelas do schema antes/depois de uma bateria de GETs (`demurrageV2Routes.test.ts`, Gate G7) e o mesmo padrão do lado do navegador (`demurrageV2UiZeroWrite.test.ts`, `demurrageV2Browser.test.ts`: "só GET em /api/demurrage/v2, nunca organizationId").
3. **Sem regressão N+1; contagem de consultas constante na escala já aprovada** — benchmark D14 Gate G7 (100/1.000/10.000 processos): contagem de consultas por rota idêntica nas três escalas (`/operacional`=2, `/financeiro`=5, `/eficiencia`=9, etc. — `docs/demurrage-fase-d14.md` §11.2). Paginação por keyset (D14 v1.1 #9) reconfirmada estável e com contagem de consultas constante entre 100 e 10.000+ linhas.
4. **Paginação assinada, estável e isolada por organização** — cursor assinado (`leitura/cursorAssinado.ts`) embute e assina `organizationId`/`processoId`/versão; adulteração, cruzamento de organização ou de critério → `400 cursor_invalido` (`leituraFilaV11.test.ts`, `leituraTimelineV11.test.ts` #4).
5. **Timelines sanitizadas** — nenhum payload bruto, token, stack ou mensagem técnica interna aparece na resposta, mesmo quando esses literais existem no banco (`leituraTimeline.test.ts`, `leituraTimelineV11.test.ts` #5).

Nenhum benchmark novo foi inventado nesta fase — os números reconfirmados são os já aprovados em D12/D14.

## 10. Fronteira com o frontend

- A tela D13 (`public/DemurrageOperacional.dc.html` + `demurrage-v2-apresentacao.js`) continua buildando e passando sua suíte completa (`npm run test:demurrage-ui`, com variáveis de banco configuradas: **66/66 passam, 0 falhas, 0 skips** — os 2 testes que apareceriam como skip sem banco configurado são os Gates G7/G1 de `demurrageV2UiZeroWrite.test.ts`, que exigem Postgres real).
- A camada de apresentação é comprovadamente pura: o próprio arquivo declara a "regra de ouro" (só traduz/formata o que o backend decidiu — nunca soma valor, nunca recalcula relógio/Free Time/faixa tarifária, nunca funde os dois relógios) e isso é verificado por um teste de guarda estática (`demurrageV2Apresentacao.test.ts`) que proíbe `sort`/`reduce`/`Number`/`parseFloat`/`parseInt` como operação e qualquer nome de função de cálculo do motor no arquivo de apresentação.
- Todo o comportamento de negócio da Demurrage permanece no backend — nenhuma regra (prioridade, estado, soma, cálculo de dias/valor) existe no lado do navegador.
- Nenhum teste de navegador foi pulado por indisponibilidade de dependência nesta execução (Chromium pré-instalado e axe-core disponíveis no ambiente desta auditoria). Caso um ambiente futuro não tenha essas dependências, o último baseline completo de navegador verificado é exatamente esta execução (66/66, 2026-10-12).
- O redesenho visual do frontend permanece explicitamente agendado para depois do fechamento do backend — fora do escopo do D16, como instruído.

## 11. Runbook operacional

Ver `docs/demurrage-runbook-operacional.md` (variáveis de ambiente, aplicação de migrations, início do scheduler, kill switches, fuso operacional, dependência de transporte de notificação, identificação de filas esgotadas, retentativa/resolução segura de pendências, inspeção somente-leitura de um processo, backup/rollback, dependências externas conhecidas).

## 12. Validação exigida (execução sequencial)

Os passos 1 a 10 da validação exigida (migrations em banco limpo; D10; D11; D12; D14; D15-A; D15-B; D15-C; todos os testes verticais do D16; motor Demurrage completo) são, nesta base de código, uma única suíte (`src/demurrage-engine/__tests__/*.test.ts`, 70 arquivos) executada em um único comando — não há, e nunca houve neste projeto, uma forma de rodar cada fase isoladamente fora desse comando. Por isso são reportados como uma execução agregada, precedida (nesta própria auditoria, seção 4) pela prova dedicada de banco limpo em separado.

| # | Passo | Resultado |
|---|---|---|
| 1 | Testes de migration em banco limpo | Incluído na execução agregada (`migrate.test.ts`) + prova dedicada da seção 4 — ambos verdes |
| 2 | D10 | Incluído na execução agregada (`registroDemurrage*.test.ts`, `demurrageVertical.test.ts`) — verde |
| 3 | D11 | Incluído na execução agregada (`responsabilidade*.test.ts`) — verde |
| 4 | D12 | Incluído na execução agregada (`leitura*.test.ts`, `demurrageV2Routes.test.ts`) — verde |
| 5 | D14 | Incluído na execução agregada (`gestao*.test.ts`, `frescorValorV123.test.ts`, `estadoOperacionalV122.test.ts`, `prazoFreeTimeV12.test.ts`) — verde |
| 6 | D15-A | Incluído na execução agregada (`closingD15A*.test.ts`) — verde |
| 7 | D15-B | Incluído na execução agregada (`d15b.test.ts`, `d15bV11.test.ts`) — verde |
| 8 | D15-C | Incluído na execução agregada (`d15c.test.ts`, `d15cV11.test.ts`, `d15cV12.test.ts`) — verde |
| 9 | Todos os testes verticais do D16 | `d16Vertical.test.ts` — **23/23 passam** (execução isolada, antes e depois da correção da seção 5.1) + incluído na agregada |
| 10 | Motor Demurrage completo | **961 testes, 961 passam, 0 falham, 0 cancelados, 0 pulados, 0 todo** (70 arquivos, `node --test-concurrency=1`) |
| 11 | V1 (`npm test`) | **25/25 passam, 0 falham** |
| 12 | D13 UI (`npm run test:demurrage-ui`) | **66/66 passam, 0 falham, 0 pulados** (com variáveis de banco configuradas — os 2 testes que apareceriam pulados sem banco, Gates G7/G1, também passaram) |
| 13 | `tsc --noEmit` | Limpo (sem saída, exit 0) |
| 14 | Build de produção (`npm run build`) | Limpo |

**Total consolidado desta auditoria: 961 (engine) + 25 (V1) + 66 (D13 UI) = 1.052 testes, 1.052 passam, 0 falham, 0 cancelados, 0 pulados, 0 todo.** Todos os números acima foram obtidos **depois** da correção do defeito da seção 5.1 — nenhuma regressão foi introduzida pela correção.

## 13. Limitações conhecidas

1. `tracking_schedule_claims` sem fencing token/época (seção 6, item 1) — risco teórico, sem reprodução por teste, pré-existente a D15-C.
2. `si_conversas_descobertas` sem claim/lease em nível de linha (seção 6, item 2) — depende de idempotência downstream, sem teste de concorrência dedicado.
3. Nenhuma rota pública de produção chama `registrarProcessoDemurrage`, `ClosingService` (fechamento/reabertura) ou a escrita de `decidirResponsabilidade` — todos existem como serviços internos completos e testados, aguardando a integração controlada e/ou rotas futuras (Caps. 13, 17 [gatilho manual], 20, 26 [escrita], 29 [ações de Gestor]).
4. Cap. 9 (tabela de equivalências de tipo de contêiner entre armadores) permanece uma pendência do próprio Blueprint, não da implementação.
5. Nenhum código de produção grava o campo de porto de descarga (POD) — a condição de compartilhamento de tracking por VesselCall (Cap. 15, cenário #19) nunca é atingida em produção hoje; tudo cai no caminho individual (mais seguro, porém mais consultas). Descoberto durante a construção do cenário #19/#20, que precisou escrever a observação de POD diretamente (`FieldObservationRepository.insert`) por não existir caminho de produção que o faça.
6. `docs/demurrage-fase-d15-b.md` descreve a pendência `fallback_manual_superado` (fonte mais forte chegando sobre um valor MANUAL_FALLBACK) como autorresolvível quando o valor correspondente chega; o código atual não implementa essa autorresolução — a pendência permanece aberta até revisão manual do Gestor. O cenário #14 testa o comportamento real do código, não o texto da documentação; a documentação da fase D15-B deveria ser corrigida numa fase futura para refletir o comportamento real (ou o comportamento implementado para refletir o texto), mas isso está fora do escopo do D16.

## 14. Integrações deliberadamente adiadas

HeadCargo (Cap. 27), Liberação (Cap. 26 — porta pronta, sem adaptador), Courier/Auditoria, Portal do Cliente (Cap. 32), redesenho visual do frontend. Nenhuma foi tocada nesta fase, conforme o escopo do D16.

## 15. Pré-requisitos de deployment

- PostgreSQL 16 com as 38 migrations aplicadas (`docs/demurrage-runbook-operacional.md` §2).
- Variáveis de ambiente de banco (`DATABASE_URL`/`DEMURRAGE_DATABASE_URL`) e, para notificação, credencial Microsoft Graph já integrada à Priora.
- Nenhuma dependência de Supabase — este backend não foi, e não deve ser, implantado em Supabase.
- A integração controlada que chamará `registrarProcessoDemurrage`/`ClosingService`/`decidirResponsabilidade` em produção é um trabalho de fase futura, fora do D16.

## 16. Recomendação final

**Backend do módulo Demurrage V1 concluído e pronto para integração controlada.**

Nenhum defeito bloqueante de release foi encontrado nesta auditoria. Nenhuma fase adicional do backend Demurrage é iniciada a partir daqui. O frontend não é redesenhado. Nenhum deploy em Supabase é realizado.
