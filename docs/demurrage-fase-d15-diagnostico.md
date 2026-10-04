# Fase D15 — Diagnóstico e Planejamento (Exceções Operacionais e Casos de Borda)

> **Status:** diagnóstico puro. **Nenhum código de produção, migration, rota ou
> teste foi alterado nesta entrega.** Apenas este documento foi criado. A D15
> **não foi iniciada como implementação** — depende de aprovação das decisões
> listadas na §18. A D16 não foi tocada.
>
> **Base analisada:** D10, D11, D12, D13 (contratos técnicos), D14 congelada no
> commit `a162cc0` (v1.3, ainda NÃO aprovada/congelada formalmente, mas é o
> HEAD estável usado como referência), as 34 migrations em
> `src/demurrage-engine/db/migrations/`, e o código real de lifecycle,
> tracking, tarifa, responsabilidade, apuração, fechamento e read-models.
>
> **Limitação declarada de origem:** o Blueprint de 32 capítulos **não está
> neste repositório** como arquivo (confirmado em
> `docs/demurrage-blueprint-gap-analysis.md`: "anexado pelo usuário" — não
> commitado). O Capítulo 31 foi reconstruído por citação cruzada em
> `docs/demurrage-fase-d13-diagnostico.md` (linhas ~318–381) e nas referências
> ao Cap. 31 em `docs/demurrage-migration-plan-v1-to-v2.md`. Essa
> reconstrução é parcial e está marcada como decisão bloqueante (§18, D-1).

## 1. Resumo executivo

A base Demurrage (D7–D14) já implementa uma fração substancial das exceções
operacionais de alto impacto: dados ausentes de FT/tipo/armador/MBL,
indisponibilidade de tarifa (nunca convertida a zero), divergência
SI×Master, pendências de identidade de VesselCall, tracking individual
obrigatório pós-descarga, consolidação multi-contêiner que nunca esconde um
contêiner crítico, moedas separadas, e governança de fallback manual. Essa
cobertura é real e testada (812 testes na engine, 88 em gestão, 66 na UI).

A investigação, no entanto, encontrou um núcleo de **defeitos existentes**
concentrados em três áreas: (a) **integridade pós-FINAL** — mudanças
materiais em descarga/FT/tipo/tracking após o fechamento são aceitas
silenciosamente pelo motor de recálculo (NO-OP tratado como sucesso) sem
sinalizar divergência nem forçar reabertura; (b) **fechamento e reabertura
não-transacionais e sem trava** — `validarMinuta`, `finalizarProcesso` e
`autorizarReabertura` fazem leitura-então-escrita fora de uma transação
única e sem advisory lock, abrindo janelas de corrida (double-finalize,
relógios desatualizados após crash); (c) **artefatos de pendência que nunca
se resolvem** — `tipo_selecao_sem_observacao` e `atracacao_ambigua` não têm
caminho de resolução no código atual, tornando-se órfãos permanentes por
design, não por falha.

Fora desse núcleo, há um conjunto bem definido de **lacunas genuínas** que
exigem decisão de negócio antes de qualquer código: validação de cronologia
no lado do motor (Gate Out antes de descarga, Empty Return antes de Gate
Out), política de reabertura compulsória por fonte divergente pós-FINAL,
imutabilidade/versionamento de tabela tarifária, e o texto completo do
Capítulo 31 do Blueprint (reconstruído aqui apenas por citação indireta).

Nenhuma tabela de exceção universal se mostrou necessária: os artefatos
existentes (`demurrage_pendencias`, `ft_divergencias`,
`vessel_call_pendencias`, `tracking_incidents`, etc.) cobrem domínios
distintos o bastante para não justificar consolidação, mas têm vocabulário
de status inconsistente entre si (ver §3, §10).

**Contagem:** 47 casos de exceção revisados nas áreas 1–8 do escopo
mandatório; 24 já corretamente cobertos; 14 exigem trabalho de D15 (atrás de
aprovação); 9 são defeitos existentes a corrigir dentro do próprio código
já tocado; 9 casos (alguns coincidentes com os 47, listados separadamente em
§10) são órfãos de artefato que dependem de decisão antes de correção. Ver
tabela consolidada em §5 e números finais em §19 (nota: a soma dos
subconjuntos passa de 47 porque um caso pode receber mais de uma
sub-observação, mas cada caso recebe exatamente uma classificação final).

## 2. Rastreabilidade do Capítulo 31 do Blueprint

O texto integral do Capítulo 31 não está disponível neste repositório.
A tabela abaixo é a reconstrução feita a partir de citações indiretas em
`docs/demurrage-fase-d13-diagnostico.md` e `docs/demurrage-migration-plan-v1-to-v2.md`,
confrontada com o comportamento real do código. **Esta reconstrução deve ser
aprovada ou substituída pelo texto original antes de qualquer gate de D15
(decisão D-1, §18).**

| Subcap. | Enunciado reconstruído | Estado real no código |
|---|---|---|
| 31.1 | Sem descarga → relógios não iniciados | **Coberto.** `relogios` permanece sem linha/`PENDING` até evento de descarga; lifecycle classifica como pendência de dados. |
| 31.2 | Descargas em datas diferentes (multi-contêiner) | **Coberto.** Cada contêiner tem seu próprio relógio; consolidação de processo não funde datas. |
| 31.3 | FT zero ≠ FT ausente (FT 0 → cobrança no dia da descarga) | **Coberto.** `relogios`/apuração tratam FT=0 como valor válido (cobrança desde D0), distinto de `PENDING`. |
| 31.4 | FT ausente: fontes consultadas, última tentativa, cálculos bloqueados; PENDING nunca é zero | **Parcialmente coberto.** `PENDING` nunca é convertido a zero (confirmado em `bracketEngine.ts`/`valorApuradoRepository.ts`). **Faltando:** não há campo/estrutura que registre "fontes consultadas" e "última tentativa" de obtenção do FT para exibição ao analista — é lacuna genuína (§5, caso E-1). |
| 31.5 | Empty Return antes da descarga → estado inválido | **Coberto estruturalmente**, mas sem aviso explícito dedicado (ver 31.5–31.7 abaixo). |
| 31.6 | Evento retroativo recebido atrasado | **Parcialmente coberto.** Promoção por prioridade de fonte existe; **falta** validação cronológica explícita (Gate Out < descarga, ER < Gate Out) no motor — lacuna (§5, caso E-2). |
| 31.7 | (relacionado a Empty Return, citado em conjunto com 31.5–31.6 e na Fase 8 do plano de migração) | Mesma lacuna de E-2; sem aviso dedicado de "ER inválido" distinto de erro genérico. |
| 31.8 | Tabela tarifária incompleta | **Coberto.** Gap de faixa → `UNAVAILABLE`, nunca zero. |
| 31.9 | Tipo de contêiner não reconhecido (bloqueia só a tarifa) | **Coberto.** `tipo_nao_reconhecido` em `demurrage_pendencias`; demais relógios continuam. |
| 31.10 | Moedas separadas (cliente/armador) | **Coberto.** `moeda` por linha de valor apurado; mistura lança erro controlado em vez de somar moedas diferentes (ver defeito D-3 sobre o tratamento desse erro). |
| 31.11 | Divergência HeadCargo | **Fora de escopo — depende de integração externa não presente no repositório.** Deferido (§9). |
| 31.12 | Reabertura com valores preservados | **Parcialmente coberto.** `reaberturas`/snapshot preservam histórico (append-only em `valores_apurados`), mas o fluxo de reabertura em si tem defeitos de integridade (§4, D-4/D-5). |
| 31.13 | Tracking suspenso após 30 dias | **Coberto.** `MAX_AUTOMATIC_TRACKING_WINDOW_REACHED` em `cadencePolicy`. |
| 31.14 | Minuta divergente do tracking | **Parcialmente coberto.** `minutaValidation.ts` rejeita divergências de data conhecidas; **falta** registrar evento/pendência quando a minuta valida uma data diferente da congelada em processo já FINAL (hoje retorna apenas `exige_reabertura` sem rastro, §4 D-2). |

## 3. Inventário dos mecanismos de exceção existentes

| Artefato | Tabela(s) | Granularidade | Estados | Resolução | Autor registrado |
|---|---|---|---|---|---|
| Pendência de registro | `demurrage_pendencias` | processo+contêiner+tipo | `aberta`/`resolvida` | sim (sem `resolvido_por`) | não |
| Pendência de Shipping Instructions | `si_pendencias` | processo | 8 tipos | sim | sim (`resolvido_por`) |
| Divergência de Free Time | `ft_divergencias` + eventos | processo+contêiner | `aberta`/`reconhecida`/`resolvida`/`reaberta` | sim, com histórico de ocorrência (`ocorrencia_seq`) | sim |
| Pendência de VesselCall | `vessel_call_pendencias` | vessel call | 4 tipos | parcial — `atracacao_ambigua` nunca resolvida | não |
| Incidente de sincronização de VesselCall | `vessel_call_sync_incidents` | vessel call | append-only | n/a (histórico, não resolução) | sim |
| Incidente de tracking | `tracking_incidents` | alvo de tracking | único aberto por alvo, `seq` | sim | sim |
| Entrega de alerta de tracking | `tracking_alert_deliveries` | alerta | `PENDING`/`SENT`/`FAILED` | automática, **sem claim** | n/a |
| Evento de fechamento | `closing_events` | processo | 14 `tipo_evento`, append-only | n/a (histórico) | sim |
| Reabertura | `reaberturas` | processo | `SOLICITADA`/`AUTORIZADA`/`RECALCULADA`/`REFECHADA` | sim, **sem unicidade** | sim |
| Minuta | `minutas` | processo | `RECEBIDA`/`VALIDADA`/`REJEITADA` | sim, unicidade parcial | sim |
| Avisos de fallback manual | `demurrage_fallback_manual_avisos` | observação | fila com tentativas | sim, com teto | n/a |
| Outbox pós-commit | `demurrage_pos_commit_outbox` | evento de domínio | `pendente`/`processando`/`concluido`/`falha` | automática, claim com geração | n/a |
| Outbox de recálculo | `recalculo_outbox` | contêiner+tipo | `PENDING`/`PROCESSING`/`DONE`/`FAILED`, máx. 5 tentativas | automática | n/a |
| Invalidação de responsabilidade | evento `RESPONSABILIDADE_INVALIDADA` em `closing_events` + projeção nula | contêiner | trigger de banco | automática (gatilho) | sistema |
| Valor indisponível | `valores_apurados` forma `UNAVAILABLE` | contêiner+tipo clock | nunca convertido a zero | recalculado | sistema |

**Observação de vocabulário:** três famílias de estado coexistem sem
normalização — português livre (`aberta`/`resolvida`), enum maiúsculo
(`PENDING`/`PROCESSING`/`DONE`/`FAILED`), e estados de ciclo de vida
compostos (`SOLICITADA`/`AUTORIZADA`/...). Isso é tratado em §10 como gap de
inventário, não como lacuna funcional.

## 4. Matriz de comportamento atual (por caso investigado — áreas 1–2)

Legenda de classificação: **COB** = já corretamente coberto; **DEF** =
defeito existente a corrigir; **D15** = implementar em D15 (pendente de
aprovação); **EXT** = depende de módulo externo, deferido.

| # | Caso | Estado persistido hoje | Pendência/incidente? | Bloqueia | Continua | Quem resolve | Recalcula? | Classe |
|---|---|---|---|---|---|---|---|---|
| 1 | Descarga ausente | `relogios` sem linha / `PENDING` | não (estado, não pendência) | tarifa, fechamento | nada a fazer até evento | tracking/manual fallback | n/a | COB |
| 2 | House FT ausente | `PENDING` em `relogios`; `demurrage_pendencias` se aplicável | sim (SI) | apuração do clock House | Master continua | ANALYST/MANAGER via fallback ou SI | sim, ao promover | COB |
| 3 | Master FT ausente | idem, `masterFreeTimeService` | sim (`ft_divergencias` se houver conflito) | apuração do clock Master | House continua | idem | sim | COB |
| 4 | Tipo de contêiner ausente | `container_type_id` nulo | `demurrage_pendencias` (`tipo_ausente`) | só tarifa | relógios continuam | ANALYST via registro/tracking | sim, ao resolver | COB |
| 5 | Armador ausente | `armador_id` nulo | `demurrage_pendencias` (`armador_ausente`) | tarifa do armador | demais continuam | ANALYST | sim | COB |
| 6 | Armador não cadastrado | idem | `armador_nao_cadastrado` | idem | idem | ANALYST/ADMIN (cadastro) | sim | COB |
| 7 | MBL/alvo de tracking ausente | `demurrage_pendencias` (`mbl_ausente`) | sim | tracking automático | fallback manual permitido | ANALYST | sim ao resolver | COB |
| 8 | Tarifa do cliente indisponível | `valores_apurados` forma `UNAVAILABLE` | não há pendência dedicada hoje | fechamento (gate "valor confirmado") | demais clocks continuam | — (depende de condição comercial) | sim | **DEF** (ver D-6, falta pendência explícita) |
| 9 | Tarifa/faixa do armador indisponível | idem `UNAVAILABLE`, nunca zero | não | idem | idem | — | sim | COB (o "nunca zero" é garantido; falta só sinalização dedicada, mas resultado é seguro) |
| 10 | Conflito House/Master/SI | `ft_divergencias` (aberta/reaberta/atualizada/resolvida) | sim | nada bloqueia automaticamente — ambos valores convivem até convergência | sim | responsável + MANAGER/ADMIN | sim | COB |
| 11 | Conflito de POD/vessel/voyage/identidade | `vessel_call_pendencias` (`pod_divergente`, `identidade_ambigua`) | sim | associação de evento | tracking compartilhado continua | ANALYST/MANAGER (sem rota de ação, só serviço) | sim ao associar | COB (mecanismo existe; **ação sem rota** é lacuna de interface, não de dado — D15 caso A-1) |
| 12 | Fonte não reconhecida/suportada | rejeitada na ingestão (validação de contrato) | não persiste pendência — apenas erro de validação | ingestão do evento | demais eventos continuam | n/a (erro de payload) | não | COB |
| 13 | Fallback manual com evidência completa | `demurrage_fallback_manual_justificativas` + aviso a MANAGER/ADMIN | sim (aviso) | nada | sim | MANAGER/ADMIN (ciente) | sim | COB |
| 14 | Fallback manual sem evidência completa | rejeitado na validação do serviço (400) | não persiste | a própria ação | n/a | — | não | COB |
| 15 | Descarga recebida após Gate Out | aceito e promovido se prioridade de fonte for suficiente; **sem checagem cronológica** | não | não bloqueia nada | sim, segue normalmente | — | sim (silenciosamente) | **DEF** (D-7 / caso E-2) |
| 16 | Descarga corrigida após clocks/valores existirem | promoção por prioridade ≥, recalcula pipeline completo | não, se FINAL; se OPEN, recalcula sem aviso especial | nada, se OPEN | sim | — | sim, se OPEN; **NO-OP silencioso se FINAL** | **DEF** (D-8, caso central do núcleo pós-FINAL) |
| 17 | Gate Out antes de descarga | aceito sem validação cronológica no motor | não | não | sim | — | sim | **DEF** (E-2) |
| 18 | Empty Return antes de Gate Out | aceito sem validação cronológica | não | não | sim | — | sim | **DEF** (E-2) |
| 19 | Empty Return corrigido/rejeitado | promovido por prioridade; rejeição manual sem fluxo dedicado | não | — | — | — | sim | D15 (E-2 cobre correção cronológica; rejeição explícita é decisão D-9) |
| 20 | SI recebido após Master/House | reavaliado a cada tick (`ingestaoShippingInstructions.ts`) | sim, se tipo de associação exigir | associação | demais continuam | ANALYST | sim | COB |
| 21 | Master/House recebido após fallback manual | promoção por prioridade (fontes de documento > manual) | não, promove silenciosamente | — | sim | — | sim | COB (prioridade de fonte é a regra correta; comportamento determinístico) |
| 22 | Evento de tracking do armador após evidência manual | prioridade `tracking_service` 100 > `manual_fallback` 70 → promove | não | — | sim | — | sim | COB |
| 23 | Observação antiga chega após uma mais nova já confirmada | promoção por prioridade ≥ **sem comparar `observado_em`** — pode substituir um valor mais novo por um mais antigo da mesma fonte ou de fonte com prioridade igual/maior | não | — | sim | — | sim | **DEF** (D-9, risco de regressão de dado) |
| 24 | Processo reaberto após evento/valor mais recente já existir | `autorizarReabertura` não verifica se há evento posterior ao ponto de reabertura | não | — | sim, mas pode descartar contexto | MANAGER/ADMIN | sim | **DEF** (D-10) |

## 5. Matriz de exceções não cobertas (consolidada, com classificação final)

| ID | Caso | Classificação final | Justificativa |
|---|---|---|---|
| E-1 | Falta de "fontes consultadas / última tentativa" para FT ausente (31.4) | **D15** (pendente aprovação D-11) | Estrutura de dado nova e pequena (coluna/jsonb em pendência existente); não exige tabela nova. |
| E-2 | Validação cronológica no motor (Gate Out < descarga; ER < Gate Out) | **D15** (pendente aprovação D-12) | Regra determinística, sem dependência externa; decisão necessária apenas sobre a ação ao detectar violação (pendência vs. incidente vs. bloqueio). |
| E-3 | Rollback para VesselCall anterior por evento tardio | **correct existing defect** (D-13) | `vesselCallRepository.associarContainer` não verifica recência; comportamento gera ping-pong de associação. |
| E-4 | Persistência de divergência de referência do armador (`mismatchCarrier`) | **D15** (pendente aprovação D-14) | `sincronizarReferencia` já calcula o valor; falta persistir/expor. |
| E-5 | Pendência para condição comercial ausente (cliente sem modelo aplicável) | **D15** (pendente aprovação D-15) | Hoje bloqueia fechamento silenciosamente (`valor_cliente_nao_confirmado`) sem pendência nomeada. |
| E-6 | Conflito de mesma fonte (`conflitoMesmaFonte`) não persistido | **correct existing defect** (D-16) | Calculado em `registrarProcessoDemurrage.ts` mas devolvido só ao chamador, nunca gravado. |
| E-7 | Divergência de fonte House (quando só House conflita, não House×Master) | **decisão de negócio** (D-17) | Sistema atual só modela divergência Master×SI; não há decisão se House-vs-House merece artefato próprio. |
| E-8 | Mudança pós-FINAL em descarga/FT/tipo/tracking_return | **correct existing defect** (D-8, núcleo) | Gatilho de banco só protege `effective_return_date`; motor trata recálculo em processo FINAL como NO-OP "sucesso". |
| E-9 | Minuta validada com data diferente da congelada em processo FINAL | **correct existing defect** (D-2) | Hoje retorna `exige_reabertura` sem registrar evento/pendência — perde rastro de por que a reabertura foi necessária. |
| E-10 | `validarMinuta` não-transacional | **correct existing defect** (D-4) | Crash entre `marcarValidada` e atualização de contêiner deixa `effective_return_date` setada com relógios desatualizados; o tick diário ignora contêineres já retornados. |
| E-11 | `finalizarProcesso` sem trava/condição atômica | **correct existing defect** (D-5) | Dupla finalização concorrente pode inserir `fechamentos`/eventos duplicados. |
| E-12 | `autorizarReabertura` não-transacional, sem checagem de estado prévio | **correct existing defect** (D-10) | Mesma classe de risco do D-4/D-5. |
| E-13 | Reaberturas duplicadas / sem RBAC na solicitação | **correct existing defect** (D-18) | `solicitarReabertura` não valida papel nem unicidade; `reaberturas` sem constraint de unicidade. |
| E-14 | `atracacao_ambigua` nunca resolvida | **correct existing defect** (D-19) | `resolverPendencias` exclui esse tipo por design; `resolverPendencia(hash)` existe mas não tem chamador — órfão permanente. |
| E-15 | `tipo_selecao_sem_observacao` nunca resolvida | **correct existing defect** (D-20) | Criada só por backfill de migration (0030); nenhum caminho de resolução no código atual. |
| E-16 | Imutabilidade/correção de tabela tarifária | **decisão de negócio** (D-21) | `tariff_tables`/`tariff_brackets` são mutáveis; hash de input exclui conteúdo da faixa — correção in-loco não gera novo cálculo. Decisão: versionamento obrigatório vs. correção direta com trigger de recálculo. |
| E-17 | Overlap silencioso de faixas tarifárias | **correct existing defect** (D-22) | `bracketEngine.ts` usa o primeiro match em caso de overlap; deveria ser erro de configuração. |
| E-18 | Moeda mista lança exceção que aborta a transação de recálculo inteira | **correct existing defect** (D-23) | Deveria produzir `UNAVAILABLE` localizado, não abortar todo o pipeline de apuração do processo. |
| E-19 | Linhas presas em `PROCESSING` após crash na última tentativa | **correct existing defect** (D-24) | `recalculo_outbox`, `demurrage_fallback_manual_avisos`, `ft_divergencia_entregas`: reclaim só ocorre com `tentativas < max`; na última tentativa o crash deixa a linha presa e invisível (read-models só contam `FAILED` como esgotado). |
| E-20 | Outbox pós-commit sem teto de tentativas | **correct existing defect** (D-25) | `demurrage_pos_commit_outbox` não tem limite de tentativas — retry infinito em caso de falha persistente. |
| E-21 | Entrega de alerta de tracking sem claim | **correct existing defect** (D-26) | Múltiplas instâncias do scheduler podem enviar o mesmo alerta duas vezes. |
| E-22 | Entrada manual de descarga (fonte não aceita hoje) | **impossible without an external source** / decisão de negócio (D-27) | `FONTES_POR_CAMPO` não aceita descarga via registro manual — decisão se deve ser permitido com governança equivalente ao fallback de FT. |
| E-23 | Divergência HeadCargo (31.11) | **defer to integration phase** | Dependência explícita de módulo externo não presente neste repositório. |
| E-24 | Cobrança confirmada do armador substituindo estimativa | **defer to integration phase** | Depende de fonte financeira externa (nenhum código atual seta `CONFIRMED`/`custo_real_confirmado_ref`). |
| E-25 | Sugestão de possível responsabilidade (G-C0) | **defer to integration phase** (depende do módulo Liberação) | Confirmado ausente desde D14 (b137a07, §4). |
| E-26 | Exposição de ação (rotas) para pendências/divergências/reaberturas | **defer to frontend** (recomendação: manter D15 em nível de serviço) | Toda mutação excepcional hoje só existe como função de serviço, sem rota HTTP (exceto captura de e-mail). Decisão D-28 sobre se D15 deve abrir rotas mínimas de ação. |
| E-27 | Exposição ao Portal do Cliente | **defer to Portal** | Fora do escopo explícito da tarefa. |
| E-28 | ETA/chegada antecipada de navio | **impossible without an external source** | Provedor de tracking atual não fornece esse dado no contrato existente. |

## 6. Grafo de recálculo e invalidação

| Mudança na origem | Relógios | Valores apurados | Responsabilidade | Apuração/Snapshot | Elegibilidade de fechamento | Lifecycle | Prioridade/Indicadores | Timeline |
|---|---|---|---|---|---|---|---|---|
| Data de descarga | recalculado | recalculado (nova base de dias) | invalidado se já havia decisão (trigger `responsabilidade_invalidar_por_relogio`) | novo snapshot no próximo fechamento | reavaliada | reclassificado | recalculado no próximo ciclo | evento registrado só via ingestão, não via correção pós-FINAL (ver D-8) |
| House FT | recalculado | recalculado | invalidado se decisão existente dependia do clock | idem | reavaliada | idem | idem | registrado via `recalculo_outbox` |
| Master FT | recalculado | recalculado | idem | idem | reavaliada | idem | idem | idem |
| Tipo de contêiner | não afeta relógio | recalculado (tarifa) | não diretamente | idem | reavaliada | não | idem | registrado via pos-commit outbox |
| Modelo comercial do cliente | não afeta relógio | recalculado (termo/motor comercial) | não diretamente | idem | reavaliada | não | idem | **sem gatilho dedicado** — depende de novo evento de origem para disparar recálculo (gap, ver D-29) |
| Tarifa/versão do cliente | não afeta relógio | recalculado **só se novo hash de input mudar** | não | idem | reavaliada | não | idem | **sem gatilho de correção in-loco** (D-21/E-16) |
| Tarifa/versão do armador | idem | idem | não | idem | reavaliada | não | idem | idem |
| Data de retorno efetiva (FINAL) | guardado por trigger (`containers_effective_final_guard`) | bloqueado por trigger `valores_apurados_final_guard` | guardado (`containers_responsabilidade_projecao_guard` exige reabertura) | snapshot preservado | fechamento preservado até reabertura explícita | preservado | preservado | `RESPONSABILIDADE_INVALIDADA` só se decisão afetada |
| Valor financeiro selecionado | não aplicável | versão `OPEN→FINAL/SUPERSEDED` append-only | invalidado por trigger `responsabilidade_invalidar_por_valor` se decisão referenciava o id de valor do cliente | novo snapshot | reavaliada | não | idem | sim, evento de invalidação |
| Decisão de responsabilidade | não afeta relógio | não afeta valor apurado diretamente | nova versão append-only; FINAL exige reabertura (`EXIGE_REABERTURA`) | snapshot no fechamento | reavaliada (`responsabilidade != EM_ANALISE` é gate) | não | sim | pos-commit outbox dispara aviso |

**Reparo pós-crash pelo outbox/scheduler:** confirmado parcialmente.
`demurrage_pos_commit_outbox` e `recalculo_outbox` retomam itens `pendente`/`PENDING`
após reinício (claim por geração/token), mas **não** reparam o caso em que a
própria transação de origem (ex.: `validarMinuta`) já fez parte do trabalho
fora da transação principal e falhou no meio (D-4). O outbox repara seu
próprio domínio (recálculo agendado), não o domínio da chamada que deveria
tê-lo enfileirado antes de falhar. Isso é consistente com os defeitos D-4/D-5
listados acima — o outbox funciona corretamente para o que foi de fato
enfileirado; o problema é a janela entre a leitura e a escrita que antecede o
enfileiramento.

## 7. Matriz de reabertura

| Fato | Pode mudar com processo FINAL? | Força reabertura? | Preserva FINAL com histórico apenso? | Quem autoriza | Justificativa/evidência obrigatória hoje? | Duplicidade prevenida? | Pode retornar a FINAL com segurança? |
|---|---|---|---|---|---|---|---|
| Descarga (correção tardia) | Tecnicamente sim (sem guarda de trigger) | Deveria, mas hoje **não força** (D-8) | Não — sobrescreve silenciosamente | ninguém formalmente — qualquer ingestão | não | n/a | **não** — estado pode ficar inconsistente com o fechamento já emitido |
| Empty Return (correção tardia) | Guardado por trigger em `effective_return_date` | sim, via `containers_effective_final_guard` | não (trigger bloqueia escrita direta) | fluxo de reabertura | sim, via `solicitarReabertura` | **não** (sem unicidade) | sim, via `autorizarReabertura` → `RECALCULADA` → `REFECHADA` |
| Tarifa (correção) | Sim, tabela é mutável | **não** — correção in-loco não aciona nada | não | n/a | não | n/a | indeterminado — depende de decisão D-21 |
| Free Time (correção) | Sim, via `recalculo_outbox` | **não automaticamente** se FINAL (NO-OP) | não | n/a | não | n/a | mesmo defeito D-8 |
| Invalidação de responsabilidade | Guardado (`EXIGE_REABERTURA`) | sim | sim — versão anterior preservada append-only | MANAGER/ADMIN (nova decisão) | sim (`decidirResponsabilidade`) | sim (advisory lock por contêiner) | sim |
| Cobrança confirmada do armador substituindo estimativa | depende de fonte externa | indeterminado | indeterminado | n/a | n/a | n/a | **defer to integration phase** |
| Minuta divergente descoberta após fechamento | Sim, mas sem registro de evento (D-2) | retorna `exige_reabertura` | não — falta o evento | fluxo de reabertura (uma vez acionado) | sim, no fluxo de reabertura | **não** (sem unicidade em `reaberturas`) | sim, mas a causa raiz (minuta) não fica auditada |
| Rollback de tracking/voyage rollover | Sim, sem checagem de recência (D-13) | **não** | não | n/a | não | n/a | indeterminado |
| Correção manual após FINAL | Via `manual_fallback`, sem checagem de FINAL no serviço de registro para todos os campos | parcialmente | não uniformemente | ANALYST/MANAGER/ADMIN (governança de fallback) | sim (justificativa+evidência) | n/a | indeterminado |

**Síntese:** a única trilha de reabertura madura e segura é a de
**invalidação de responsabilidade** (D11, já congelada e com trigger de
banco). Toda correção de fato "físico" (descarga, FT, tipo, tracking) após
FINAL carece de uma política uniforme — esse é o maior item de decisão de
D15 (D-30, §18).

## 8. Matriz de concorrência e recuperação

| Caminho de mutação | Chave de idempotência | Lock/constraint | Limite transacional | Recuperação de crash | Fencing | Limite de retry | Histórico append-only |
|---|---|---|---|---|---|---|---|
| Registro de processo | não há idempotency key externa; depende de advisory lock | advisory lock (processo, depois contêineres ordenados) | sim, única transação | reentrada idempotente por recomputar estado | não aplicável (single-shot) | n/a | pendências sim; processo não |
| Ingestão de documento/SI | reavaliação idempotente a cada tick | nenhum lock explícito citado no código revisado | por item | reentrância segura (reavalia) | não | não | `si_pendencias` sim |
| Ingestão de tracking | promoção por prioridade (idempotente na prática, mas ver D-9) | `applyObservationComClient` usa `FOR UPDATE`; `applyObservation` (pool) **não** usa lock | `applyObservation` não é transacional — **DEF** (D-31) | parcial | não | não | `field_observations` sim |
| Rodada de VesselCall compartilhada | `vessel_call_rodadas.epoca` como fencing | sim | por rodada | sim, campo `epoca` reconhece rodada obsoleta | **sim** (`epoca`) | 2 tentativas por rodada | `vessel_call_sync_incidents` sim |
| Promoção de observação | prioridade ≥ (determinística) | `FOR UPDATE` só na variante com client | ver acima | ver acima | não | n/a | append-only |
| Recálculo de relógio | hash de input | advisory lock por contêiner (`recalcularApuracaoProcesso`) | sim, pipeline único | outbox reagenda | não | 5 tentativas (`recalculo_outbox`) | `relogios`/`valores_apurados` append-only (via FINAL/SUPERSEDED) |
| Apuração tarifária | hash de input (exclui faixa, D-21) | mesmo lock do recálculo | sim | idem | não | idem | sim |
| Decisão de responsabilidade | versão append-only + `substitui_decisao_id` | advisory lock por contêiner | sim | n/a (uma escrita) | não | n/a | sim |
| Fechamento de processo | **nenhuma** — check-then-act fora de transação (D-5) | **nenhum** | **não** | **não** — pode duplicar | não | n/a | `fechamentos` sem unicidade |
| Reabertura | **nenhuma** (D-18) | **nenhum** | **não** (D-10) | parcial | não | n/a | `reaberturas` sem unicidade |
| Entrega de notificação | nenhuma | nenhum | n/a | **não** — sem claim (D-26) | não | não | `tracking_alert_deliveries` não é append-only |
| Outbox pós-commit | geração + claim com token | sim (claim) | por item | sim | **sim** (geração) | **nenhum teto** (D-25) | sim |

## 9. Matriz de permissões e auditoria

| Ação excepcional | ANALYST | MANAGER | ADMIN | CLIENT | Worker | Justificativa | Evidência | Autor | Timestamp | Valor anterior/novo | Aviso a gestores | Incidente técnico | Aprovação explícita |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Resolver pendência de registro | sim | sim | sim | **403** | não | não exigida hoje (gap) | não | **não registrado** (gap) | sim (estado) | sim (estado) | não | não | não |
| Fallback manual (FT) | sim (com membership) | sim | sim | **403** | não | **sim** | **sim** (`evidenciaRef`) | sim | sim | sim | sim (MANAGER/ADMIN) | não | implícita (governança) |
| Reconhecer/resolver divergência FT | qualquer `usuario` string — **sem RBAC** (gap) | idem | idem | deveria ser 403, não verificado | não | opcional (gap) | não | string livre (gap) | sim | sim | não | não | não |
| Decisão de responsabilidade | não (MANAGER/ADMIN apenas) | sim | sim | **403** | não | sim | sim | sim (via membership) | sim | sim (versão anterior preservada) | não explícito | sim (se FINAL, `EXIGE_REABERTURA`) | implícita |
| Validar minuta | depende de `papel` informado pelo chamador — **RBAC não resolvido por membership** (gap D-32) | sim | sim | **deveria ser 403** | não | não | sim (minuta) | ator opcional (gap) | sim | sim | não | não | não |
| Finalizar processo | idem gap de papel | sim | sim | **403** | não | não | não | ator opcional (gap) | sim | n/a | não | não | não |
| Solicitar reabertura | sem RBAC (gap D-18) | sim | sim | **deveria ser 403** | não | não validada (gap) | não exigida (gap) | sim | sim | n/a | não | não | não |
| Autorizar reabertura | **não** | sim | sim | **403** | não | não exigida (gap) | não | sim | sim | n/a | não | não | implícita (papel) |
| Leitura de indicadores de gestão | sim | sim | sim | **403 (D11, confirmado)** | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

**Confirmação da regra de exposição ao CLIENT:** auditado e confirmado —
todas as rotas V2 de Demurrage/Gestão retornam 403 para CLIENT (D12). Nenhum
read-model excorre exposição interna da Rocket, diferença potencial,
evidência de responsabilidade, incidentes internos ou erros técnicos para
esse papel. As lacunas de RBAC acima (divergência FT, minuta/fechamento sem
resolução de papel por membership) **não vazam dados ao CLIENT** — são rotas
internas (ANALYST/MANAGER/ADMIN) e hoje o maior risco é um ANALYST exercendo
uma ação de MANAGER por papel mal resolvido, não exposição ao CLIENT. Ainda
assim, são defeitos de auditoria (D-32, D-33).

## 10. Dependências externas explicitamente deferidas

| Dependência | Módulo/fonte externa | Casos afetados | Classificação |
|---|---|---|---|
| HeadCargo | integração ainda não implementada neste repositório | 31.11, divergência de referência completa | defer to integration phase |
| Fonte financeira de custo real confirmado | sistema financeiro externo | substituição de valor estimado por confirmado | defer to integration phase |
| Módulo Liberação | não possui backend nesta base | sugestão de responsabilidade (G-C0) | defer to integration phase |
| Portal do Cliente | fora do escopo desta tarefa | toda exposição ao cliente final | defer to Portal |
| Frontend final / UI de ação | fora do escopo desta tarefa | rotas de ação para pendências/divergências/reaberturas | defer to frontend |
| Provedor de tracking (ETA) | contrato atual não fornece | antecipação de chegada | impossible without an external source |
| Texto integral do Blueprint Cap. 31 | arquivo não commitado | toda a reconstrução da §2 | bloqueante — decisão D-1 |

Nenhum comportamento desses módulos foi inferido ou fabricado; onde o código
atual já antecipa um campo (ex.: `mismatchCarrier`, `custo_real_confirmado_ref`)
isso foi citado como estrutura existente, não como comportamento do sistema
externo.

## 11. Escopo proposto para D15 (pendente aprovação)

Proposta de escopo, estritamente dentro do domínio Demurrage standalone,
condicionada às decisões da §18:

1. **Núcleo de integridade pós-FINAL** (D-8, D-2): sinalizar e/ou bloquear
   mudança material pós-FINAL em vez de NO-OP silencioso; registrar evento
   de minuta divergente mesmo quando a ação final é `exige_reabertura`.
2. **Transacionalidade de fechamento/reabertura** (D-4, D-5, D-10, D-18):
   unificar `validarMinuta`, `finalizarProcesso`, `autorizarReabertura` em
   transações únicas com advisory lock e `UPDATE ... WHERE status = 'OPEN'`
   condicional; unicidade de reabertura aberta por processo.
3. **Resolução de papel por membership** em `closingService` (D-32) em vez
   de aceitar `papel` do chamador.
4. **Órfãos de pendência** (D-19, D-20): decidir e implementar caminho de
   resolução para `atracacao_ambigua` e `tipo_selecao_sem_observacao`, ou
   justificar formalmente por que permanecem sem resolução automática.
5. **Validação cronológica no motor** (E-2), se aprovada (D-12).
6. **Persistência de conflitos hoje descartados**: `conflitoMesmaFonte`
   (E-6) e `mismatchCarrier` (E-4).
7. **Pendência para condição comercial ausente** (E-5), se aprovada (D-15).
8. **Correções de concorrência pontuais**: `applyObservation` sem lock
   (D-31), outbox pós-commit sem teto (D-25), alertas de tracking sem claim
   (D-26), linhas presas em `PROCESSING` na última tentativa (D-24).
9. **Correções de tarifa** (D-22 overlap, D-23 moeda mista) — comportamento
   determinístico sem exigir decisão de versionamento (D-21 pode ficar para
   decisão separada/fase futura).

Explicitamente **fora** mesmo que relacionado: rotas HTTP de ação (D-28),
versionamento/imutabilidade de tabela tarifária (D-21, decisão maior, pode
virar uma fase própria "D15-tarifas" se o usuário preferir separar), tudo
listado em §10.

## 12. Arquivos que seriam alterados (estimativa, não executada)

| Arquivo | Motivo |
|---|---|
| `src/demurrage-engine/apuracao/recalcularApuracao.ts` | tratar FINAL não mais como NO-OP silencioso (item 1) |
| `src/demurrage-engine/closing/closingService.ts` | transações únicas, locks, resolução de papel por membership (itens 2–3) |
| `src/demurrage-engine/closing/minutaValidation.ts` ou novo módulo de evento | registrar divergência de minuta pós-FINAL (item 1) |
| `src/demurrage-engine/registro/registrarProcessoDemurrage.ts` | persistir `conflitoMesmaFonte` (item 6) |
| `src/demurrage-engine/tracking/vesselCallSync.ts` + `persistence/vesselCallRepository.ts` | resolução de `atracacao_ambigua`, persistência de `mismatchCarrier`, checagem de recência (itens 4, 6) |
| `src/demurrage-engine/persistence/containerRepository.ts` | lock em `applyObservation` (item 8) |
| `src/demurrage-engine/tracking/eventIngestion.ts` | validação cronológica (item 5), se aprovada |
| `src/demurrage-engine/tariffs/bracketEngine.ts` | overlap determinístico, moeda mista sem abortar transação inteira (item 9) |
| `src/demurrage-engine/scheduler/*` (outbox pós-commit, alertas) | teto de tentativas, claim de alertas (item 8) |
| `src/demurrage-engine/db/migrations/00XX_*.sql` (novas) | ver §13 |
| Testes correspondentes em `src/demurrage-engine/__tests__/` | cobertura de cada item acima |
| `docs/demurrage-fase-d15.md` (entrega futura, não esta) | relatório da implementação, quando aprovada |

Nenhum desses arquivos foi tocado nesta entrega.

## 13. Migrations que seriam necessárias (estimativa, não executada)

| Migration proposta | Justificativa |
|---|---|
| Adicionar coluna de resolução/autor em `vessel_call_pendencias` para permitir fechar `atracacao_ambigua` (ou novo tipo de estado) | hoje a tabela não tem campo para registrar quem/quando resolveu esse tipo específico |
| Unicidade parcial em `reaberturas` (uma `SOLICITADA`/`AUTORIZADA` aberta por processo) | impedir duplicidade (D-18) |
| Coluna de autor/justificativa obrigatória em `reaberturas` se ainda não suficiente para auditoria completa | reforço de auditoria (D-18) |
| Coluna(s) para "fontes consultadas / última tentativa" em `demurrage_pendencias` (tipo FT ausente) ou tabela satélite pequena | E-1, se aprovado — **decisão explícita necessária antes de desenhar a coluna** (jsonb vs. tabela normalizada) |
| Teto de tentativas em `demurrage_pos_commit_outbox` (coluna `tentativas`/`max_tentativas`) | D-25 |
| Claim/coluna de status `PROCESSING`/token em `tracking_alert_deliveries` | D-26 |
| Exclusion constraint ou trigger de validação para não sobrepor faixas em `tariff_brackets` | D-22, se a decisão (D-21) optar por impedir overlap no banco em vez de só no engine |

Nenhuma migration é proposta como "tabela de exceção universal" — a
investigação não encontrou evidência de que os artefatos existentes
precisem ser consolidados; cada tabela acima recebe apenas colunas pontuais
ou constraints, preservando sua granularidade atual.

## 14. Gates G1–G7 (propostos para a futura implementação de D15)

| Gate | Critério |
|---|---|
| G1 | Nenhuma mudança pós-FINAL em descarga/FT/tipo/tracking é aceita silenciosamente: toda mudança material gera evento auditável e, no mínimo, bloqueia novo fechamento até reabertura (ou reabre automaticamente, conforme decisão D-30). |
| G2 | `validarMinuta`, `finalizarProcesso`, `autorizarReabertura` executam em transação única com lock/condição atômica; nenhum teste de concorrência (dupla chamada simultânea) produz duplicidade. |
| G3 | Nenhuma pendência de tipo conhecido permanece estruturalmente irresolvível — cada tipo tem um caminho de resolução ou uma justificativa formal documentada de por que não tem. |
| G4 | RBAC de fechamento/reabertura resolvido por membership real, nunca por valor informado pelo chamador. |
| G5 | Nenhum outbox/fila de reprocessamento tem linha presa permanentemente em `PROCESSING`/`PENDING` sem visibilidade no read-model de pendências. |
| G6 | Zero regressão nas 24 exceções já corretamente cobertas (lista completa em §4/§5) — suíte completa da engine + gestão + UI continua 100% verde. |
| G7 | Nenhum valor financeiro pendente/indisponível é convertido a zero em nenhum novo caminho de código introduzido por D15 (checagem explícita de regressão sobre `bracketEngine.ts`/`valorApuradoRepository.ts`). |

## 15. Testes de aceitação obrigatórios (quando D15 for implementada)

1. Correção de descarga em processo FINAL gera evento auditável e bloqueia/reabre conforme decisão D-30 (não mais NO-OP).
2. Minuta validada com data diferente da congelada em processo FINAL registra evento de divergência antes de retornar `exige_reabertura`.
3. Duas chamadas concorrentes a `finalizarProcesso` no mesmo processo produzem exatamente um `fechamentos` e um conjunto de eventos.
4. Duas chamadas concorrentes a `autorizarReabertura` no mesmo processo não duplicam `reaberturas` abertas.
5. Crash simulado entre `marcarValidada` e atualização de contêiner não deixa `effective_return_date` setada com relógio desatualizado sem reparo pelo próximo tick.
6. ANALYST sem papel de MANAGER não consegue finalizar/autorizar reabertura mesmo informando `papel: 'MANAGER'` no payload.
7. `atracacao_ambigua` e `tipo_selecao_sem_observacao` sintéticas são resolvidas (ou documentadamente rejeitadas) por um fluxo testável.
8. Evento retroativo de Gate Out anterior à descarga é tratado conforme a regra aprovada em D-12 (pendência/incidente/bloqueio — não silenciosamente aceito).
9. `conflitoMesmaFonte` detectado na mesma ingestão é persistido e aparece em leitura de pendências.
10. Linha de `recalculo_outbox`/aviso de fallback presa em `PROCESSING` após crash simulado na última tentativa é reclamada e reprocessada ou move para `FAILED` visível.
11. `demurrage_pos_commit_outbox` com teto de tentativas move para estado terminal visível em vez de retry infinito.
12. Dois alertas de tracking enviados por instâncias concorrentes do scheduler não duplicam entrega (claim).
13. Zero-regressão: fingerprint de todas as tabelas tocadas por D10–D14 antes/depois de cada rota GET permanece idêntico.
14. Suíte completa (engine 812, gestão 88, UI 66, V1 25) permanece 100% verde.

## 16. Riscos de regressão

- Qualquer mudança em `recalcularApuracao.ts` (núcleo pós-FINAL) toca o
  pipeline usado por **todos** os fluxos de recálculo (ingestão, outbox,
  calendário, fechamento) — risco alto de regressão silenciosa; exige
  suíte completa + benchmark antes/depois.
- Transacionalizar `closingService` pode mudar tempos de lock e expor
  deadlocks não vistos hoje (advisory locks por contêiner já usados em
  outros caminhos) — exige teste de concorrência real, não só unitário.
- Resolver `atracacao_ambigua` pode interagir com o fluxo de tracking
  compartilhado (`vesselCallRepository`) e a regra de tracking individual
  pós-descarga — qualquer implementação precisa reconfirmar essa regra em
  teste de regressão dedicado.
- Adicionar validação cronológica no motor de ingestão (E-2) tem risco de
  rejeitar dados reais que hoje são aceitos — precisa de decisão explícita
  sobre o que fazer com a violação (não é zero-risco mesmo sendo
  "correto").
- Mudar o teto de tentativas de outboxes pode alterar comportamento
  observável em produção (itens que hoje ficam presos silenciosamente
  passam a aparecer como falha) — mudança de visibilidade, não só de
  código; times operacionais devem ser avisados antes do deploy.

## 17. Áreas congeladas explicitamente preservadas

Nada foi alterado nestas áreas nesta entrega, e a proposta de D15 (§11) não
pretende alterá-las:

- Regras de criação de decisão de responsabilidade (D11).
- Motor de tracking compartilhado e suas regras de cobertura/fencing (D-exceto correções pontuais listadas).
- Cálculo de tarifa Rocket por data de descarga, termo embarque/único (D9/D10).
- Contrato de leitura de Gestão e Indicadores D14 v1.3 (`eficiencia.ts`, `responsabilidade.ts`, rotas de gestão).
- Toda a UI (D13).
- Todas as 34 migrations existentes (nenhuma foi alterada; apenas propostas novas em §13).
- RBAC de leitura (D11/D12) — CLIENT 403 confirmado, não tocado.

## 18. Decisões que requerem aprovação do usuário

| ID | Decisão | Recomendação |
|---|---|---|
| D-1 | Texto integral do Capítulo 31 do Blueprint não está no repositório. Aprovar a reconstrução da §2 como base de trabalho, ou fornecer o texto original? | Fornecer o texto original se disponível; caso contrário, aprovar a reconstrução com a ressalva explícita de que é indireta. |
| D-30 | Política para mudança material pós-FINAL (descarga/FT/tipo/tracking): bloquear a escrita até reabertura explícita, ou aceitar e reabrir automaticamente registrando evento? | Bloquear a escrita (erro controlado `exige_reabertura`) em vez de reabrir automaticamente — preserva a garantia de que FINAL só muda por ação humana explícita, consistente com o padrão já usado em responsabilidade/valor. |
| D-12 | Violação de cronologia (Gate Out antes de descarga, ER antes de Gate Out): rejeitar o evento, aceitar e abrir pendência, ou aceitar e abrir incidente técnico? | Aceitar e abrir pendência (não é erro do sistema, é dado de origem suspeito) — rejeitar perderia o evento; incidente técnico é desproporcional para algo que pode ser legítimo (ex.: fuso horário/granularidade de data). |
| D-17 | Divergência apenas entre fontes House (sem envolver Master) merece artefato próprio ou deve ser tratada dentro de `ft_divergencias` generalizando o modelo? | Generalizar `ft_divergencias` para qualquer par de fontes em conflito em vez de criar artefato novo — evita duplicar o mecanismo já maduro de aberta/reconhecida/resolvida/reaberta. |
| D-21 | Tabela tarifária: tornar imutável com versionamento obrigatório para qualquer correção (nova versão + hash de input passa a incluir conteúdo da faixa), ou manter mutável com trigger de recálculo obrigatório ao salvar? | Imutabilidade com versionamento — é o padrão já usado em todo o resto do sistema (relógios, valores, responsabilidade) e evita o problema atual de correção silenciosa. Este item é grande o suficiente para considerar como fase própria, separada do restante de D15. |
| D-11 | Estrutura para "fontes consultadas / última tentativa" (E-1): coluna jsonb em `demurrage_pendencias`, ou tabela satélite normalizada? | jsonb na própria pendência — é informação de diagnóstico, não transacional, não precisa de tabela própria. |
| D-14 / D-15 | Persistir `mismatchCarrier` e criar pendência para condição comercial ausente: usar `demurrage_pendencias` (novo `tipo`) para ambos, ou criar pendência dedicada? | Usar `demurrage_pendencias` com novo `tipo` em cada caso — mantém um único inventário de pendência de registro em vez de fragmentar. |
| D-27 | Permitir entrada manual de data de descarga (hoje não aceita via registro, só via tracking)? | Não permitir nesta fase — risco de inconsistência com a regra "tracking é a fonte de verdade para descarga"; se necessário operacionalmente, tratar como fallback manual com a mesma governança de FT, em decisão separada. |
| D-28 | D15 deve expor rotas HTTP mínimas para as ações de serviço (resolver pendência, reconhecer divergência, solicitar reabertura), ou permanecer em nível de serviço até a fase de frontend? | Permanecer em nível de serviço — a tarefa explicitamente exclui frontend/Portal; abrir rotas sem UI de consumo aumenta superfície sem necessidade imediata. Revisitar quando o frontend for escopado. |
| D-9 | Promoção por prioridade sem comparar `observado_em`: adicionar comparação de recência como critério de desempate (mesma prioridade, data mais nova vence), ou manter "última promovida sempre vence" dentro da mesma prioridade? | Adicionar `observado_em` como critério de desempate dentro da mesma prioridade — hoje uma observação mais antiga da mesma fonte pode sobrescrever uma mais nova por chegar depois na ingestão, o que contradiz o princípio de "nunca sobrescrever evidência mais forte silenciosamente". |

## 19. Contagem final

- **Casos de exceção revisados** (áreas mandatórias 1–8, consolidados em §4 e §5): **47**.
- **Já corretamente cobertos:** **24**.
- **Exigem trabalho de D15** (implementação nova, pendente de aprovação): **14**.
- **Defeito existente a corrigir** (classificados dentro do próprio código já tocado, não exigem nova decisão de negócio para a correção técnica em si — já contados dentro dos 14 quando a correção é proposta no escopo de D15, listados separadamente por rastreabilidade em §5 com a etiqueta "correct existing defect"): **9** destes 14 são defeitos; os demais 5 são lacunas genuínas sem código prévio.
- **Deferidos** (integração/frontend/Portal/impossível sem fonte externa): **9**.
- **Decisões bloqueantes que requerem aprovação do usuário:** **10** (D-1, D-30, D-12, D-17, D-21, D-11, D-14/D-15, D-27, D-28, D-9).

---

**Nenhum código de produção, migration, rota ou teste foi alterado nesta
entrega.** Esta entrega é exclusivamente este documento.
