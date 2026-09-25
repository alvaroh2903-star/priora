# Plano de Migração — Demurrage V1 → Demurrage Engine V2

**Data:** 24/09/2026 (revisão 8)
**Base:** `docs/demurrage-blueprint-gap-analysis.md` (diagnóstico aprovado, com as 3 correções de premissa da revisão 1)
**Status:** Fases 1–5 concluídas (migrations 0001–0012). Fase 6 — Scheduler e cadência **concluída e revisada** (migrations 0013–0014): cadência oficial (D0/D+5/a cada 4 dias/diário 4 dias antes do menor LFD/a cada 2 dias em demurrage/Empty Return encerra), **suspensão automática aos 30 dias sem Empty Return (restaurada na revisão 12 — processo/relógios seguem, manual disponível)**, seleção MBL→CONTAINER (HBL nunca dispara tracking), reuso do cache central, alerta de falha multiempresa (incidente único por target, entregas operacionais segregadas por organização), **worker real com claim de janela em PostgreSQL (dois workers/reinício não duplicam a consulta)**, **outbox de alerta (PENDING/SENT/FAILED atrás de uma porta de transporte)**, **acionamento in-process no Web Service existente (tick no boot + a cada ~1h, sem serviço/cron novo)** e **transporte de alerta sobre Microsoft Graph / e-mail (desacoplado do tracking)**. Fase 7 aguarda autorização. Ver "Relatório de entrega — revisão 13" no final deste documento.

**Decisões aprovadas na revisão 7:**
1. **Seleção de versão do Termo Único:** a versão da tabela aplicada é a **vigente no 1º dia de demurrage do cliente** (fim do House Free Time). Não se cria um `fato_gerador_data` universal.
2. **`tariff_tables` também é imutável quanto à organização** (convenção da DECISÃO 1): recebeu o trigger `organization_id_immutable` na 0009.

**Decisões aprovadas na revisão 8:**
3. **Vigência tarifária desconhecida** (migration 0010): `tariff_tables.vigencia_inicio` passa a NULLABLE (NULL = início desconhecido, nunca -infinito) e ganha `verificada_em TIMESTAMPTZ NOT NULL`. Uma versão de início desconhecido só é aplicável a partir da data civil de `verificada_em`; versão datada que cubra a data tem prioridade; sem versão comprovada → `UNAVAILABLE`/`TARIFF_VERSION_NOT_PROVEN` (nunca zero).
4. **Seleção da versão da tabela de ARMADOR pela data de descarga** (Blueprint). Termo Único continua pelo 1º dia de demurrage; Termo por Embarque fixa na condição comercial.
5. **Hapag-Lloyd é a exceção aprovada** com `day_count_basis = excess_over_free_time`; todas as outras tabelas de armador `since_discharge_absolute`. O **Master FT vem do processo**; o "FT padrão" das tabelas é informativo e não entra no cálculo (nem é cadastrado).

## Aprovações e decisões da revisão 5

1. `Processo.numero_processo` e `Processo.cliente_id` nullable quando a informação ainda não existe — pendência real, nunca placeholder.
2. `BackfillRun` operacional/mutável; `BackfillItem` append-only.
3. Responsável operacional passa a ser `Processo.responsavel_operacional_membership_id → OrganizationMembership`, da mesma organização do processo, garantido pelo PostgreSQL — implementado pela migration corretiva `0006` (as migrations já aplicadas não foram reescritas).
4. `TrackingTarget` global/compartilhado, sem `organization_id`, ligado aos contêineres pela tabela N:N `ContainerTrackingTarget` (Fase 5). Não existe coluna de target em `Contêiner`. As entidades de tracking operam por `TrackingTarget`; o isolamento multiempresa segue no acesso via `Processo`/`Contêiner`.
5. Motor temporal com datas civis, sem hora e sem conversão UTC.

## Decisões finais desta revisão (obrigatórias, incorporadas ao schema e à implementação)

1. **Multiempresa desde a fundação.** `Organization` + `OrganizationMembership` desde a primeira migration. `Usuario` continua sendo a identidade global da pessoa (vinculada ao `home_account_id` do MSAL já existente); o papel (`ANALYST`/`MANAGER`/`ADMIN`/`CLIENT`) vive em `OrganizationMembership`, por organização. Entidades de tenant (`Cliente`, `Processo`, `CondicaoComercial`, tabelas tarifárias privadas, dados derivados de Processo/Contêiner) carregam `organization_id` direto ou por relacionamento inequívoco; unicidades antes globais passam a ser escopadas por organização (ex.: `UNIQUE(organization_id, numero_processo)`).
2. **PostgreSQL definitivo desde a Fase 1** — sem SQLite intermediário. Uso de FKs, unique constraints, índices compostos/parciais e transações nativas do Postgres para integridade; nenhuma dependência de fornecedor além do próprio Postgres.
3. **Não existe fato gerador universal.** `CondicaoComercial` perde `fato_gerador_data` como campo genérico. Os três motores comerciais (`TermoPorEmbarqueEngine`, `TermoUnicoEngine`, `ExposicaoRocketEngine`) continuam isolados e cada um determina sua própria regra temporal/tarifária; `ValorApurado` (Fase 4) passa a registrar explicitamente motor, versão do motor, tabela+versão, regra/day-count basis aplicada, período, inputs relevantes, resultado, status de confirmação e hash dos inputs — reconstruível sem depender da regra atual do sistema.
4. **Todos os ajustes da revisão 3 são preservados** (campos críticos tipados + `FieldObservation`, `Relogio` como cache, `TrackingTarget`, `TrackingFetch`×`TrackingEvent`, dedupe hash, `ContainerType`×`ContainerTypeMapping`, `confirmation_status`×`calculation_status`, qualidade de tabela × confirmação de custo, `day_count_basis`, datas civis, `BackfillRun`+`BackfillItem`, `ShadowRun`+`ShadowDiff`, supressão de alerta por incidente, HBL/responsável/condição comercial em Processo).
5. **Governança durante a implementação:** o Blueprint continua sendo a fonte de verdade funcional. Nenhuma regra de negócio, fluxo, estado, fonte de verdade, permissão, cálculo, prioridade, tracking ou estrutura aprovada é alterada para simplificar a implementação. Quando a implementação encontrar uma necessidade real de mudar algo já aprovado, a regra é **parar antes de implementar** e reportar `PRECISA DE SUA VALIDAÇÃO` com: o que foi encontrado, por que a estrutura atual gera problema, alternativas, impactos de cada uma, e recomendação. Decisões puramente técnicas que preservam integralmente o comportamento aprovado seguem normalmente, sem parar.
6. **Fase 1 implementada nesta revisão** — ver seção "Relatório de entrega — Fase 1" ao final do documento.

## Ajustes incorporados na revisão 2 (mantidos)

1. Estratégia explícita de bootstrap/backfill para processos já ativos na virada para V2 — nada ausente é inventado, tudo vira pendência rastreável (ver Fase 1).
2. Contrato do Tracking Service expandido: timestamp da coleta, fonte/armador, identificador original do evento, status da consulta e referência ao dado bruto para auditoria (ver Fase 5).
3. Princípio de arquitetura explícito: a Demurrage V2 é exclusivamente consumidora do Tracking Service central — nunca acessa Scrapfly ou o armador diretamente (ver abaixo e Fase 5).
4. Shadow mode adicionado antes do corte de frontend: V1 permanece produtiva enquanto V2 calcula os mesmos processos em paralelo, só para comparação (ver "Estratégia de coexistência e corte").
5. Idempotência explícita para scheduler, ingestão de eventos e alertas — contra execução/disparo duplicado (ver Fases 5 e 6).
6. Fixtures oficiais de cálculo como pré-requisito bloqueante das Fases 2–4, cobrindo off-by-one, House×Master, múltiplos contêineres, mudança de faixa, Empty Return, minuta e tabelas provisórias (nova seção antes da Fase 2).
7. Separação explícita dos três motores comerciais (Termo por Embarque, Termo Único, Exposição Rocket) como estratégias distintas, não uma função genérica (ver Fase 4).

## Correções de premissa incorporadas (vs. o diagnóstico anterior)

1. **Tracking de armador é da própria Priora** (revisões 9–10): a Priora tem uma **API central de Tracking construída internamente** (Playwright + Scrapfly como navegador remoto), que consulta os portais dos armadores. Arquitetura: `Armador → Scrapfly/Playwright → API central de Tracking da Priora → módulos`. O Demurrage **consome exclusivamente** essa API central, in-process, pela camada `src/demurrage/trackingService.ts`; **não** cria outro serviço/scraper nem chamada direta a Scrapfly. Scrapfly/Playwright ficam sempre atrás dessa camada. **Fase 5 NÃO está bloqueada por serviço externo** — a implementação real foi localizada no branch `claude/demurrage-api-playwright-5q2lqq` (contrato em `docs/tracking-api-contract.md`), integrada sem trazer alterações alheias e consumida in-process. **Fatos do contrato real** (substituem as premissas antigas): a API não fornece **ID estável de evento** (`external_event_id` pode ser `NULL`; a identidade técnica é o `dedupe_hash`); **não persiste payload bruto** hoje (`raw_ref = NULL`, não inventar entidade/coluna); a **hierarquia de fontes é por campo** (descarga/empty return = tracking é fonte de verdade; House/Master FT e tipo não são sobrescritos pelo tracking); a **identidade real do TrackingTarget é `armador + referência canônica`** (a API recebe uma ref genérica; a origem — MBL/CONTAINER — vira contexto do vínculo). **A API marítima consulta SOMENTE MBL e CONTAINER (revisão 11): HBL nunca dispara tracking, nunca é fallback, nunca gera custo Scrapfly.** HBL continua existindo no domínio Processo/Auditoria, mas não é target executável. Ver os relatórios das revisões 9, 10 e 11.
2. **Liberação é desacoplada.** A pré-análise de responsabilidade Rocket × cliente (Cap. 26 do Blueprint) não bloqueia o Demurrage Core. Ela entra como módulo plugável na Fase 11, consumindo eventos estruturados da Liberação quando existirem — sem gate no fechamento operacional (Fase 8).
3. **RBAC inicial:** `ANALYST`, `MANAGER`, `ADMIN`, `CLIENT`. "Responsável técnico/desenvolvedor" deixa de ser um papel de sistema e passa a ser um **destinatário configurável de alertas técnicos** (lista de e-mail/webhook em configuração, sem login nem permissões no app).

## Princípio geral: sem reescrita destrutiva

A V1 (`src/demurrage/*`, `src/routes/demurrageRoutes.ts`, `public/Demurrage.dc.html`, `public/PortalCliente.dc.html`) **permanece intocada e funcional** até o momento explícito de corte descrito na seção "Estratégia de coexistência e corte" mais abaixo. A V2 nasce em um namespace novo (`src/demurrage-engine/*` — nome proposto, ajustável), com sua própria rota (`/api/demurrage/v2` ou equivalente), sua própria persistência e seus próprios testes, sem tocar nos arquivos da V1 até que uma fase específica diga explicitamente "agora sim, isto afeta a V1".

## Princípio de arquitetura: única porta de saída para tracking

A partir da Fase 5, **toda** a Demurrage V2 (motor, scheduler, UI, Gestão) consome tracking exclusivamente através do Tracking Service central da Priora. Nenhum código de `src/demurrage-engine/*` faz — nem pode fazer — chamada direta a Scrapfly, a um endpoint de armador, ou a qualquer scraper. O adaptador `armadorTrackingSource.ts` (Fase 5) é a única peça do sistema autorizada a conhecer a existência do Tracking Service; todo o resto do motor conhece apenas a porta `ContainerDataSource` (Fase 1), agnóstica de onde o dado veio. Isso vale também para o scheduler (Fase 6): ele decide **quando** pedir uma atualização, nunca **como** — o "como" é sempre delegado ao mesmo adaptador único.

Cada fase abaixo segue este roteiro fixo: **objetivo · arquivos/modelos novos · arquivos existentes afetados · migrations · dependências · testes obrigatórios · condição de aceite · risco de regressão.**

---

## Busca realizada para a correção #1 (tracking de armador)

Antes de propor a Fase 5, busquei o conector/serviço existente:
- Grep completo neste repositório por armador/carrier/MSC/Maersk/Hapag/CMA CGM/ONE/Evergreen/COSCO/OOCL/ZIM/Yang Ming/HMM/PIL/vessel/discharge/gate out/empty return — **nenhum resultado fora de listas de palavras-chave de e-mail** (`demurrageFilters.ts`, `auditoria/*`). O único tracking real implementado é `src/fedex/fedexClient.ts` e `src/dhl/dhlClient.ts` (courier de encomenda, domínio diferente).
- `render.yaml` não referencia nenhum serviço de tracking de armador nem variável de ambiente correspondente.
- Verifiquei os outros dois repositórios visíveis nesta sessão (`alvaroh2903-star/desktop-tutorial`, `alvaroh2903-star/miamoohelem`) — nenhum tem relação com logística/tracking (um é um stub vazio do tutorial do GitHub Desktop, o outro é uma loja de bebidas/sobremesas em React+Supabase).

**Conclusão:** o serviço existe, mas **fora do alcance desta sessão** (outro repositório/serviço interno da Priora não conectado aqui). A Fase 5 não pode nomear o serviço com certeza — ela define o **contrato de consumo assumido** e trata a obtenção de acesso/documentação real como pré-condição de início da fase, não como parte do escopo de código da fase.

---

## Trilhos transversais (não são fases numeradas, mas correm em paralelo)

Estes dois trilhos não aparecem na lista de 12 fases do pedido, mas são pré-requisito de ações específicas dentro delas — por isso ficam registrados aqui em vez de forçar uma 13ª fase:

**T1 — RBAC (`ANALYST`/`MANAGER`/`ADMIN`/`CLIENT`) + auditoria genérica.**
Necessário *antes* de qualquer ação com gate de papel aparecer em fases posteriores: atualização manual de tracking (Fase 6, exclusiva de `MANAGER`/`ADMIN`), correção de dado crítico e reabertura de processo (Fase 8), e a própria existência do papel `CLIENT` como pré-condição do Portal (Fase 12). Pode ser desenvolvido em paralelo às Fases 1–4, já que é ortogonal ao motor de cálculo. Não altera `requireAuth.ts` da V1 nem nenhuma rota existente — nasce como camada nova (`src/auth/roles.ts` ou `src/demurrage-engine/rbac/`) que só passa a ser consumida pelas rotas novas da V2.

**T2 — Alertas técnicos configuráveis.**
Lista de destinatários (e-mail/webhook) configurada via `config.ts`/variável de ambiente (ex.: `TRACKING_ALERT_RECIPIENTS`), consumida pela Fase 6 (3 falhas consecutivas → alerta ao `MANAGER` responsável pelo processo + a esses destinatários técnicos). Não é um papel de RBAC, é config pura — sem tela de gestão de usuário associada nesta V1 do RBAC.

---

## Fase 1 — Modelo persistente por contêiner

**Objetivo:** substituir o "recalcula tudo a cada `GET`" por um registro persistente e versionado por contêiner, que é o alicerce de todas as fases seguintes. Introduzir a abstração de fonte de dados (`ContainerDataSource`) já prevista para acomodar, mais tarde, o Tracking Service real (Fase 5) sem retrabalho.

**Arquivos/modelos novos** (lista real do que foi construído no "Relatório de entrega — Fase 1"):
- `src/demurrage-engine/domain/types.ts` (tipos de domínio de todas as entidades da Fase 1 — Contêiner com os campos críticos tipados, Snapshot, identidade/organização, backfill).
- `src/demurrage-engine/persistence/fieldObservationRepository.ts` e `containerRepository.ts` (os campos críticos de `Contêiner` são colunas tipadas, cada uma com um ponteiro para a `FieldObservation` append-only que a originou — não um valor em tabela EAV genérica), mais os demais repositórios.
- `src/demurrage-engine/sources/containerDataSource.ts` (porta/interface).
- `src/demurrage-engine/sources/emailHeuristicSource.ts` (adaptador que **reaproveita** `demurrageFilters.ts` + `demurrageParser.ts` da V1 como fonte de contingência — ver nota abaixo).
- `src/demurrage-engine/db/migrations/*.sql` e `db/migrate.ts` (schema e runner PostgreSQL).

**Arquivos existentes afetados:** nenhum é modificado. `demurrageFilters.ts` e `demurrageParser.ts` são **importados/reaproveitados** por `emailHeuristicSource.ts`, não alterados — eles continuam servindo a V1 exatamente como hoje.

**Migrations:**
- Persistência em **PostgreSQL** (decisão final #2 da revisão 4). Migrations `0001`–`0006` em `src/demurrage-engine/db/migrations/`, aplicadas pelo runner `db/migrate.ts`.
- Schema: `Contêiner` com os campos críticos em colunas tipadas, cada uma com ponteiro para a `FieldObservation` (append-only) que a originou; `Snapshot`; `BackfillRun`/`BackfillItem`; identidade/organização — detalhado na seção "Schema — Fase 1" mais abaixo.
- **Backfill (não é migração de schema, é carga inicial):** rodar `emailHeuristicSource` uma vez sobre as threads atualmente identificadas pela V1 para popular a base V2 com um estado inicial equivalente ao que a V1 mostra hoje; e importar os registros existentes de `demurrage-minutas.json`/`demurrage-atividades.json` (via `procKey`) para os novos registros de contêiner/processo, preservando o que já foi feito operacionalmente (ex.: "minuta já solicitada" não pode ser perdido na virada).

**Estratégia de bootstrap para processos já ativos (ponto de atenção explícito):**
Quando a V2 entra em operação, já existem processos em pleno andamento (contêiner descarregado há dias, alguns já em demurrage) que a V1 está acompanhando via e-mail. O backfill **não inventa histórico que não existe**:
- Para cada contêiner identificado pela V1 hoje, o backfill cria o contêiner V2 com os campos que a heurística de e-mail conseguir extrair **no momento do backfill**, cada um registrado como `FieldObservation` de `fonte = 'email_heuristic'` e selecionado na coluna tipada correspondente do `Contêiner`.
- Todo campo que a V1 mostra como "a confirmar" (ou que a heurística de e-mail nunca conseguiu extrair) nasce na V2 **`null`, sem ponteiro de observação** — que é como o schema representa pendência. Nunca um valor plausível é fabricado para preencher a lacuna, mesmo que isso signifique que o contêiner nasça com o relógio do cliente ou da Rocket incompleto.
- **Não há tentativa de reconstruir a data de descarga retroativa** a partir de heurísticas (ex.: "data do primeiro e-mail que menciona o contêiner"). Se a Fase 5 (Tracking Service) ainda não estiver acoplada no momento do backfill, `discharge_date` nasce `null` para todo contêiner cuja única fonte disponível seja e-mail — mesmo que o texto do e-mail mencione uma data de retirada/Gate Out (esse valor vai para `gate_out_date`, nunca é usado como substituto silencioso da descarga).
- Cada execução do backfill grava um `BackfillRun` (contagem de processos processados, campos pendentes e erros) e um `BackfillItem` por processo/contêiner tocado — auditoria de quando/como cada registro "nasceu" na V2.
- O backfill é **idempotente**: reexecutá-lo sobre o mesmo conjunto de threads não duplica contêineres nem regride um campo já promovido a uma fonte melhor (ex.: se a Fase 5 já tiver preenchido `discharge_date` via tracking real, uma nova rodada de backfill de e-mail não pode sobrescrever esse valor — a hierarquia de fontes do Cap. 4 vale desde o primeiro backfill).

**Dependências:** PostgreSQL (decidido); nenhuma dependência de Fase 5 (Tracking Service) — a fonte inicial é a heurística de e-mail, tratada desde já como fonte de **contingência**, não prioritária (alinhado ao Cap. 4 do Blueprint: quando a Fase 5 acoplar o Tracking Service real, ele entra como fonte prioritária sem precisar redesenhar o modelo).

**Testes obrigatórios:**
- CRUD do repositório de contêiner com versionamento de snapshot (nova versão preserva a anterior, não sobrescreve).
- `emailHeuristicSource` produzindo o mesmo resultado que a V1 produz hoje para o mesmo conjunto de e-mails de teste (teste de caracterização, para garantir que a base V2 nasce equivalente à V1 e não diverge por acidente nesta fase).
- Backfill idempotente (rodar duas vezes não duplica registros nem regride campo já promovido a fonte melhor — teste explícito desse cenário).
- Teste dedicado de "nada é inventado": para um contêiner sem `discharge_date` em nenhuma fonte disponível no momento do backfill, o campo nasce `null`, nunca com um valor derivado de heurística de data de e-mail.

**Condição de aceite:** para um conjunto de threads de teste, a base V2 populada via backfill contém um contêiner por número de contêiner extraído, com cada campo crítico apontando para uma `FieldObservation` de fonte `email_heuristic` (ou `null`/sem ponteiro, quando não encontrado) e o mesmo valor que a V1 mostraria hoje; um `BackfillRun` com suas contagens agregadas; e um `BackfillItem` por contêiner processado, rastreando individualmente o resultado (`criado`/`pendencia_marcada`/etc.).

**Risco de regressão:** **nulo para a V1** (nenhum arquivo da V1 é alterado). Risco interno: erro no backfill pode gerar uma base V2 inconsistente — mitigado por rodar o backfill em ambiente de teste antes de qualquer uso real, por ele ser reexecutável (idempotente) sem side effect na V1, e pelo registro em `BackfillRun` permitir auditar exatamente o que cada execução fez.

---

## Fixtures oficiais de cálculo — pré-requisito bloqueante das Fases 2–4

Antes de escrever qualquer código das Fases 2, 3 e 4, um conjunto único de fixtures oficiais deve existir e ser revisado — todas as três fases (motor temporal, dois relógios, motor tarifário) são testadas contra o **mesmo** conjunto de casos, para garantir que não há divergência de premissa entre elas. As fixtures cobrem, no mínimo:

1. **Off-by-one:** a tabela literal do Cap. 23.1 do Blueprint (descarga 01/09, FT 14 dias → 14/09:0, 15/09:1, 16/09:2, 20/09:6), mais um caso de FT=0 confirmado e um caso de FT ausente (pendente).
2. **House × Master divergentes:** um contêiner onde o relógio do cliente vence antes do relógio da Rocket, outro onde é o inverso, e um onde os dois vencem no mesmo dia.
3. **Múltiplos contêineres por processo:** um processo com 3 contêineres em estados diferentes (um devolvido sem custo, um em demurrage, um ainda dentro do free time) — para validar que a consolidação no processo preserva o detalhamento individual (Cap. 3/25) e não "contamina" um contêiner com o estado de outro.
4. **Mudança de faixa tarifária:** um contêiner cujo free time é maior que o padrão da tabela do armador, fazendo a primeira diária cair numa faixa que não é a primeira (exemplo do Cap. 24), tanto para Termo Único (faixas paralelas ao FT) quanto para a tabela de armador (Cap. 24.3.1).
5. **Empty Return:** evento chegando antes da descarga (caso inválido, Cap. 31.5), evento com data retroativa recebido atrasado (Cap. 31.6), e o caso normal (encerra os dois relógios daquele contêiner, não afeta os demais do mesmo processo/BL).
6. **Minuta:** minuta com data igual ao Empty Return (caso trivial), minuta com data divergente (preserva as duas evidências, usa a da minuta), e minuta chegando depois de um fechamento sem custo, criando custo (vai para reabertura).
7. **Tabelas provisórias/incompletas:** um cálculo com a tabela da PIL (estimativa por ponto médio, sempre `ESTIMATED_PROVISIONAL`) e um com uma tabela incompleta (Yang Ming/COSCO/ZIM) caindo numa faixa sem dado (`UNAVAILABLE`, nunca aproximação por semelhança).

Essas fixtures vivem em um único arquivo compartilhado, `src/demurrage-engine/__fixtures__/casosOficiais.ts`, referenciado pelos testes das Fases 2, 3 e 4 — nunca duplicadas em cada fase. **Estado (revisão 5):** o arquivo foi criado como primeiro entregável da Fase 2, antes do `freeTimeClock`, com os casos do motor temporal (off-by-one, FT 0, FT ausente, virada de mês, virada de ano, fevereiro/ano bissexto, data final anterior à descarga, devolução no último dia livre e no primeiro dia de demurrage). Os casos 2 e 3 (dois relógios House × Master e múltiplos contêineres por processo) foram preenchidos na revisão 6, como primeiro entregável da Fase 3, antes do `dualClockCalculator` — grupos A–K de `CASOS_DOIS_RELOGIOS` e o processo misto de `CASOS_MULTIPLOS_CONTEINERES`, todos conferidos contra o oráculo de `DATE` do PostgreSQL. As seções dos casos 4–7 (faixas, Empty Return, minuta, tabelas provisórias) seguem vazias até a Fase 4 ser autorizada.

---

## Fase 2 — Motor temporal e testes de off-by-one

**Objetivo:** implementar (e testar exaustivamente) a fórmula de contagem de dias do Cap. 6/23 do Blueprint, corrigindo os dois problemas identificados no diagnóstico: âncora temporal (`discharge_date`, não retirada/Gate Out) e o aparente off-by-one da V1. Este motor é **puro**: sem tracking, sem Outlook, sem banco como dependência do cálculo, sem tarifa, sem frontend e sem o dual clock (Fase 3).

**Regras obrigatórias (revisão 5):**
- A única âncora é `discharge_date`. Nenhum dado é inferido a partir de Gate Out.
- Input em data civil `YYYY-MM-DD`, nunca `Date` JavaScript como representação do dia operacional. Não há hora, fuso ou conversão UTC em nenhuma etapa.
- Dias corridos. Para FT de N dias: dia 1 = descarga; último dia livre = descarga + (N − 1); primeiro dia de demurrage = descarga + N; dias de demurrage contam do primeiro dia de demurrage até a data final, inclusive, e são 0 se a data final vier antes do primeiro dia de demurrage.
- FT ausente = `PENDING`, nunca zero. FT explicitamente igual a zero é válido e diferente de ausente.
- Data final anterior à descarga = resultado `INVALID` explícito, nunca um número negativo.
- Caso não definido pelo Blueprint que exija regra nova → `PRECISA DE SUA VALIDAÇÃO` antes de implementar.

**Arquivos/modelos novos:**
- `src/demurrage-engine/__fixtures__/casosOficiais.ts` (fixtures oficiais compartilhadas — criado antes do motor).
- `src/demurrage-engine/temporal/civilDate.ts` (data civil: validação, aritmética de dias, sem `Date`).
- `src/demurrage-engine/temporal/freeTimeClock.ts` (último dia livre, primeiro dia de demurrage e dias de demurrage, dada a descarga + N dias de FT + data final de apuração).
- `src/demurrage-engine/__tests__/civilDate.test.ts` e `src/demurrage-engine/__tests__/freeTimeClock.test.ts`.

**Arquivos existentes afetados:** nenhum.

**Migrations:** nenhuma. O motor não lê o banco; a coluna `discharge_date` (DATE) de `Contêiner` é quem o alimentará a partir da Fase 3. `gate_out_date` é informativo, nunca âncora.

**Dependências:** nenhuma em tempo de execução. Conceitualmente, a coluna `discharge_date` da Fase 1 é a origem futura do input.

**Testes obrigatórios:**
- Reprodução literal da tabela do Cap. 23.1 do Blueprint (descarga 01/09, FT 14 dias → 14/09:0, 15/09:1, 16/09:2, 20/09:6) — não negociáveis.
- FT = 0 confirmado por fonte → cobrança começa no dia da descarga (Cap. 31.3).
- FT ausente → `PENDING`, nunca tratado como zero.
- Virada de mês, virada de ano, fevereiro em ano bissexto.
- Data final anterior à descarga → `INVALID` explícito.
- Devolução no último dia livre (0 dias) e no primeiro dia de demurrage (1 dia).
- Pureza: o motor rejeita `Date`/timestamp como dia operacional e não importa banco, tracking, Outlook ou tarifa.

**Condição de aceite:** suíte de testes do motor temporal passando 100%, guiada pelas fixtures oficiais, incluindo a tabela literal do Blueprint. Nenhum outro código consome este motor ainda nesta fase — é aceito isoladamente.

**Risco de regressão:** nulo (código novo, não conectado a nada em produção ainda).

---

## Fase 3 — Dois relógios House × Master

**Objetivo:** aplicar o motor temporal da Fase 2 duas vezes por contêiner — uma para o relógio do cliente (House Free Time) e uma para o relógio da Rocket (Master Free Time) — mantendo os dois resultados sempre separados, nunca fundidos em um único "status genérico".

**Arquivos/modelos novos:**
- `src/demurrage-engine/domain/clock.ts` (`ClienteClock`/`RocketClock`: free time, fonte, último dia livre, primeiro dia de demurrage, dias de demurrage, estado).
- `src/demurrage-engine/temporal/dualClockCalculator.ts` (orquestra os dois `freeTimeClock` por contêiner).
- Extensão de `container.ts` (Fase 1) para carregar `clienteClock` e `rocketClock`.

**Arquivos existentes afetados:** nenhum arquivo da V1.

**Migrations:** aditiva `0008_relogios.sql` (revisão 6) — cria a tabela `relogios` (cache/projeção pura, uma linha por `tipo` `cliente`/`rocket` por contêiner) com `UNIQUE(container_id, tipo)`, a constraint de forma por estado, e o trigger `relogios_somente_recalculador` que só deixa o recalculador escrever. Usa `master_free_time_days`/`house_free_time_days`/`discharge_date` (já tipados em `Contêiner` desde a Fase 1). Nenhuma reescrita de 0001–0007.

**Dependências:** Fase 2 (motor temporal pronto e testado). Não depende de Fase 4/5 — Master Free Time pode vir inicialmente como `null`/pendente (fonte ainda não conectada) sem travar o desenvolvimento desta fase; o relógio do cliente já fica funcional isoladamente.

**Testes obrigatórios:**
- Caso onde só o relógio do cliente vence (Rocket ainda dentro do prazo) e vice-versa.
- Caso onde os dois vencem em datas diferentes — o resultado consolidado nunca deve "escolher um dos dois" para representar o contêiner.
- Caso Master Free Time ausente → cálculo do cliente continua normalmente (isolamento entre relógios, Cap. 12).

**Condição de aceite:** para um contêiner com House FT e Master FT diferentes (fixture), o motor retorna os dois relógios com seus próprios último-dia-livre e dias-de-demurrage, sem interferência mútua.

**Risco de regressão:** nulo (ainda não conectado a nenhuma rota pública).

---

## Fase 4 — Motor tarifário e versionamento

**Objetivo:** substituir o "número solto que a IA encontrou no e-mail" por um motor de tabelas versionadas — tabela Rocket×cliente (Termo por Embarque/Único) e as tabelas de armador do Cap. 24.3.1 — com faixas progressivas em paralelo ao free time e estados `CONFIRMED`/`ESTIMATED`/`ESTIMATED_PROVISIONAL`/`UNAVAILABLE`.

**Separação explícita dos três motores comerciais (não um cálculo genérico):**
o Blueprint trata Termo por Embarque, Termo Único e Exposição da Rocket como três regras de negócio diferentes (Cap. 24.1/24.2/24.3), com fontes de tabela, gatilhos de vigência e (no caso do Termo Único) lógica de faixa paralela ao free time distintos entre si. A Fase 4 implementa isso como **três estratégias nomeadas e isoláveis**, nunca uma função única "calcula tarifa" com `if`s internos:
- **`TermoPorEmbarqueEngine`** → usa a Tabela Rocket vinculada ao embarque/termo assinado (Cap. 24.1): `valor = dias_demurrage_cliente × diária da tabela Rocket para o tipo de equipamento`, versão fixada no processo.
- **`TermoUnicoEngine`** → usa a tabela Rocket do Termo Único vigente no **1º dia de demurrage do cliente** (decisão aprovada, revisão 7 — Cap. 24.2), com o motor de faixas (`bracketEngine`) avançando em paralelo ao free time desde a descarga, sem reiniciar na primeira faixa ao fim do FT.
- **`ExposicaoRocketEngine`** → usa Master FT + tabela do armador (Cap. 24.3), com os estados `ESTIMATED`/`ESTIMATED_PROVISIONAL`/`CONFIRMED`/`UNAVAILABLE`, totalmente independente da tabela usada para o cliente.

Cada motor produz um `ValorApurado` com um campo `motorComercial` identificando qual dos três o gerou (rastreabilidade obrigatória — nunca dá pra confundir "quanto o cliente paga" com "quanto a Rocket está exposta").

**Arquivos/modelos novos:**
- `src/demurrage-engine/tariffs/tariffTable.ts` (entidade: armador/Rocket, tipo de equipamento, faixas, vigência, versão, status).
- `src/demurrage-engine/tariffs/bracketEngine.ts` (posiciona um dia na faixa certa, contando desde a data-âncora, sem reiniciar na 1ª faixa ao fim do free time — reaproveitado pelo `TermoUnicoEngine` e pelo `ExposicaoRocketEngine`, nunca pelo `TermoPorEmbarqueEngine`, que é tarifa fixa por dia).
- `src/demurrage-engine/tariffs/engines/termoPorEmbarqueEngine.ts`
- `src/demurrage-engine/tariffs/engines/termoUnicoEngine.ts`
- `src/demurrage-engine/tariffs/engines/exposicaoRocketEngine.ts`
- `src/demurrage-engine/tariffs/seed/` (dados iniciais: as 12 tabelas de armador + tabela Rocket×cliente, literalmente copiadas do Blueprint Cap. 24.1/24.3.1).
- `src/demurrage-engine/domain/containerType.ts` (normalização de tipo de contêiner + mapeamento — Cap. 9; mapeamento inicial vazio/mínimo, já que o próprio Blueprint deixa a tabela de equivalências como pendência dele mesmo).

**Arquivos existentes afetados:** nenhum arquivo da V1.

**Migrations:** aditiva `0009_tariffs.sql` — `tariff_tables` (versionada, imutável quanto à organização), `tariff_brackets`, `valores_apurados` (append-only exceto a transição de `calculation_status`, via trigger), vínculo `condicoes_comerciais.tabela_id` (mesma organização), e seed global das 12 classes de equipamento em `container_types`. A tabela Rocket do Termo por Embarque (valores reais do Blueprint) é seedada por organização em `tariffs/seed/rocketTermoPorEmbarque.ts`. Seed das tabelas de armador/Termo Único: pendente dos números do Blueprint.

**Dependências:** Fase 3 (dias de demurrage por relógio já calculados) para o motor tarifário ter "quantos dias" e "em qual data" aplicar a faixa. Não depende de Fase 5.

**Testes obrigatórios:**
- Exemplo do Cap. 24: contêiner com free time maior que o padrão da tabela do armador cai numa faixa posterior à primeira.
- PIL: estimativa por ponto médio, status sempre `ESTIMATED_PROVISIONAL`, nunca `CONFIRMED`.
- Tabelas incompletas (Yang Ming/COSCO/ZIM) retornando `UNAVAILABLE` nas faixas sem dado — nunca aproximação por semelhança.
- Tipo de contêiner não reconhecido → bloqueia só a seleção de tarifa, mantém os relógios ativos (Cap. 31.9).
- Um mesmo contêiner processado pelos três motores em paralelo (Termo por Embarque para o cliente, Exposição Rocket para o armador) produz dois `ValorApurado` com `motorComercial` diferentes e valores independentes — teste explícito de que nenhum motor lê ou influencia o resultado do outro.

**Condição de aceite:** para cada armador com tabela completa no Blueprint, o motor reproduz os valores de exemplo do próprio documento; para os incompletos, retorna `UNAVAILABLE`/`ESTIMATED_PROVISIONAL` conforme o caso, nunca um número inventado. Os três motores comerciais existem como módulos separados e testáveis isoladamente (nenhum teste de um motor depende de código dos outros dois).

**Risco de regressão:** nulo (motor isolado, sem consumidor em produção ainda).

---

## Fase 5 — Integração com a API central de Tracking da Priora

**Correção de premissa (revisão 9):** a fonte de tracking é a **API central de Tracking da própria Priora** (construída internamente, com Scrapfly atrás dela). O Demurrage é apenas **consumidor** dela; não há serviço de terceiros, não se cria outro scraper nem cliente Scrapfly. `Demurrage Engine → armadorTrackingSource → API central de Tracking → Scrapfly → armador`.

**Objetivo:** conectar `ContainerDataSource` (Fase 1) a um adaptador (`armadorTrackingSource`) que consome a **API central de Tracking da Priora**, promovendo-a a fonte prioritária **por campo** conforme a hierarquia do Cap. 4. A `emailHeuristicSource` (Fase 1) segue como contingência.

**Hierarquia de fontes — POR CAMPO (revisão 9; a API ser nossa não muda a autoridade funcional):**
- **Descarga** e **Empty Return** → tracking do armador (via nossa API) é **fonte de verdade**.
- **House FT** → House/Auditoria → HeadCargo. Tracking **não sobrescreve**.
- **Master FT** → MBL → HeadCargo. Tracking **não sobrescreve**.
- **Tipo de contêiner** → MBL → HeadCargo. Tracking pode ser preservado como evidência (`FieldObservation`), mas **não promove** o campo tipado automaticamente.
- Toda informação recebida pode virar `FieldObservation`; a promoção ao campo tipado segue a regra específica daquele campo (a hierarquia de prioridade já implementada na Fase 1 respeita isso: uma observação de `tracking_service` só promove um campo se sua prioridade vencer a fonte atual — e para House/Master FT e tipo, as fontes documentais têm prioridade maior).

**Reutilização e custo (revisão 9):** `TrackingTarget` continua global (`armador + reference_type + reference_value`) e pode alimentar vários contêineres/módulos. Antes de pedir uma nova atualização, a Demurrage verifica se a **API central** já tem resposta recente/reutilizável — **não** se cria uma segunda política de cache concorrente; a lógica de fetch/cache pertence ao serviço central. A Demurrage mantém só seus metadados de ingestão (`TrackingFetch`, `TrackingEvent`).

**`TrackingFetch` (revisão 9):** representa uma tentativa da Demurrage de **consumir** tracking pela API central — **não** é 1:1 com uma chamada Scrapfly. Uma resposta pode ter sido reutilizada do cache da API central, vinda de nova consulta Scrapfly, parcial ou falha. Quando a API informar isso, registrar (`origem_resposta`: `cache_central` | `scrapfly_novo` | `parcial` | `falha`), para depois medir consultas solicitadas × realizadas, respostas reutilizadas, chamadas Scrapfly evitadas e custo por processo/armador.

**Pré-condição resolvida (revisão 10):** o contrato real está em `docs/tracking-api-contract.md` (branch de tracking). A resposta do `enrich` traz `events[]` + `containers[]` (datas por contêiner: `dischargeDate`/`availableDate`/`gateOut`/`emptyReturn`; `lastFreeDay` sempre `null`) + `cached`/`resolved`. O adaptador `armadorTrackingSource` consome o `trackingService` in-process; nada mais precisa do contrato.

**Princípio de fonte única (reforço):** `armadorTrackingSource.ts` é o **único** arquivo de todo o sistema autorizado a saber que o Tracking Service existe. Nenhum outro módulo da V2 — scheduler, motor de cálculo, UI, Gestão — chama Scrapfly, o armador ou qualquer conector diretamente; todos passam pela porta `ContainerDataSource`. Isso é tratado como regra de arquitetura, não sugestão: um code review que encontre uma chamada de rede fora deste único arquivo em direção a tracking é um bug de arquitetura, independente de funcionar ou não.

**Contrato assumido (a validar contra o serviço real assim que houver acesso) — expandido:**
- Entrada: identificador de armador + BL (House/Master) e/ou número de contêiner.
- Saída esperada, **por evento normalizado** (não só por contêiner — cada evento é um registro auditável independente):
  - tipo de evento (descarga, gate out, empty return, outro);
  - data do evento;
  - **timestamp da coleta** (quando o Tracking Service obteve esse dado do armador — distinto da data do evento em si);
  - **fonte/armador** (qual armador originou o evento);
  - **identificador original do evento** no Tracking Service (para deduplicação e para poder perguntar "de onde veio exatamente este dado" depois);
  - **status da consulta** (sucesso, falha, parcial);
  - **referência ao dado bruto** (um ponteiro/ID que permita, em auditoria, recuperar o payload original do armador que originou o evento — não necessariamente o payload inteiro trafegando em toda resposta, mas uma referência resolvível).
- Assumir que o serviço já resolve cache/consulta ao armador internamente (não duplicar cache na Priora se o serviço existente já fizer isso — a decisão exata depende do contrato real).

**Arquivos/modelos novos:**
- `src/demurrage-engine/sources/armadorTrackingSource.ts` (implementa `ContainerDataSource`, chamando o serviço existente via HTTP/SDK — a definir conforme o contrato real; **único ponto de contato com o Tracking Service em todo o sistema**).
- `src/demurrage-engine/sources/sourceHierarchy.ts` (orquestra prioridade: tracking do armador > House/MBL estruturado, quando existir > heurística de e-mail > `MANUAL_FALLBACK`).
- `src/demurrage-engine/sources/eventIngestion.ts` (registra a execução da consulta como `TrackingFetch`, normaliza a resposta em zero ou mais `TrackingEvent`, calcula `dedupe_hash` e decide se cada evento já foi processado — ver idempotência abaixo).

**Arquivos existentes afetados:** nenhum arquivo da V1. `config.ts` ganha uma nova seção (`trackingService: { baseUrl, apiKey, ... }`, nomes a definir com o contrato real).

**Migrations:** as entidades de tracking já desenhadas no schema (`TrackingTarget` global, o vínculo N:N `ContainerTrackingTarget`, `TrackingFetch`, `TrackingEvent` — ver "Schema — Fase 1", seção Tracking); nenhuma coluna de target é adicionada a `Contêiner`. Passa a popular os campos tipados já existentes em `Contêiner` (`discharge_date`, `master_free_time_days`, etc.) com observações de `fonte = 'tracking_service'` em vez de `'email_heuristic'` quando disponível, preservando ambos os valores em caso de divergência (Cap. 4: "a Priora mantém ambos os registros, aplica a hierarquia e sinaliza a divergência").

**Idempotência da ingestão (ponto de atenção explícito):** cada evento recebido do Tracking Service é deduplicado pelo `dedupe_hash` de `TrackingEvent` — calculado a partir do `external_event_id` quando o serviço fornecer um identificador estável, ou por um fallback determinístico (armador+target+tipo_evento+contêiner+data_evento) quando não fornecer. Reprocessar a mesma resposta do Tracking Service duas vezes (ex.: por retry de rede, por reprocessamento manual, por dois workers concorrentes) não cria dois eventos nem aplica o mesmo evento duas vezes ao relógio do contêiner — `eventIngestion.ts` verifica a chave antes de gravar e é seguro para chamada concorrente/repetida. Falhas de consulta (sem nenhum evento retornado) ficam registradas só em `TrackingFetch.status_consulta`, nunca geram um `TrackingEvent` fantasma.

**Dependências:** acesso ao serviço real (pré-condição acima); Fase 1 (porta `ContainerDataSource` já definida).

**Testes obrigatórios:**
- Contrato do adaptador testado contra um mock do serviço real (respostas de sucesso, falha, timeout).
- Divergência entre `armador_tracking` e `email_heuristic` para o mesmo campo → ambos preservados, hierarquia aplicada, divergência sinalizada (não silenciosa).
- Campo presente só na heurística de e-mail (tracking não retornou) → continua usável como contingência.
- **Idempotência:** o mesmo evento normalizado (mesmo `dedupe_hash`) ingerido duas vezes — inclusive de forma concorrente (duas chamadas simultâneas) — resulta em um único `TrackingEvent` gravado e um único efeito sobre o relógio do contêiner.
- Teste estático/arquitetural: nenhuma chamada de rede em direção a tracking existe fora de `armadorTrackingSource.ts` (pode ser um teste de lint/import-boundary, não só um teste funcional).

**Condição de aceite:** para um contêiner de teste, o adaptador retorna os campos do contrato assumido (incluindo timestamp de coleta, identificador original e referência ao dado bruto) e o `sourceHierarchy` prioriza corretamente `armador_tracking` sobre `email_heuristic` quando ambos têm valor. Reingestão do mesmo evento é comprovadamente um no-op.

**Risco de regressão:** nulo para a V1. Risco técnico principal desta fase: o contrato assumido acima pode não bater com o serviço real — o adaptador deve ser a **única** peça a mudar se o contrato real for diferente (por isso ele fica isolado atrás da porta `ContainerDataSource`, sem vazar formato específico do serviço para o resto do motor).

---

## Fase 6 — Scheduler e cadência

**Objetivo:** implementar a cadência automática oficial (revisão 11) e o alerta de falha multiempresa. **Concluída** (migration 0013).

**Cadência oficial (revisão 11):** Descarga = D0 → D+5 → a cada 4 dias enquanto nenhum vencimento estiver próximo (D+17 é só uma dessas janelas, consulta de controle) → **4 dias antes do MENOR último dia livre (House × Master): DIÁRIO** → qualquer relógio em demurrage: **a cada 2 dias** → **Empty Return: PARA** o tracking automático daquele contêiner. D+17 não determina o início do diário — se o menor vencimento exigir diário antes, começa antes (ex.: House LFD 20/09, Master 25/09 → menor 20/09 → início diário 16/09). Implementada em `scheduler/cadencePolicy.ts` (pura). **Suspensão automática aos 30 dias de demurrage SEM Empty Return (revisão 12 — restaurada):** ao atingir 30 dias em demurrage sem devolução do vazio, o **tracking AUTOMÁTICO é suspenso** (`automaticTracking = SUSPENDED`, `motivoSuspensao = MAX_AUTOMATIC_TRACKING_WINDOW_REACHED`). Isto **não** é um estado de encerramento: o processo **continua aberto e sinalizado**, os relógios **seguem avançando**, nada é zerado, nenhuma devolução é presumida, e a **atualização manual pelo Gestor continua disponível**. Um Empty Return posterior (por consulta manual ou consulta válida) é processado normalmente e aí sim encerra o tracking daquele contêiner.

**Seleção de target (revisão 11):** MBL → CONTAINER; **HBL nunca dispara tracking**. Havendo MBL válido/resolvido, usa o MBL e NÃO consulta o contêiner separadamente; se o MBL não resolver, cai para o número do contêiner. Um MBL que alimenta N contêineres/processos é consultado UMA vez (reuso do cache central; nunca uma consulta por processo/contêiner).

**Alerta multiempresa (revisão 11):** `FalhaTracking` global por `TrackingTarget` — o incidente técnico é único. A 3ª falha consecutiva abre o incidente; o responsável técnico recebe um **alerta técnico global** e cada organização afetada recebe **sua própria entrega operacional** (uma por `incidente + organization_id`), vendo só os próprios processos/contêineres — nunca misturando organizações. 4ª/5ª falhas do mesmo incidente não geram novo alerta; um sucesso encerra/reseta a sequência; nova sequência de 3 falhas = novo incidente. Falha nunca apaga o último resultado, nunca interrompe relógios, nunca presume Empty Return.

**Atualização manual (revisão 11):** só MANAGER/ADMIN; cooldown ~2h por `TrackingTarget`; reutiliza o cache se houver resposta válida; execução em background (a interface nunca bloqueia). Sem a regra antiga de "duas atualizações por dia".

**Arquivos/modelos novos:**
- `src/demurrage-engine/scheduler/cadencePolicy.ts` (função pura: dado o estado do contêiner + histórico, decide se/quando a próxima consulta deve ocorrer).
- `src/demurrage-engine/scheduler/schedulerWorker.ts` (job em background — mecanismo concreto, ex. `node-cron` ou execução periódica no próprio processo Node, a decidir conforme infra do Render disponível).
- `src/demurrage-engine/scheduler/failureTracker.ts` (contagem de falhas consecutivas por BL/armador, zera em sucesso, agrupa incidentes do mesmo armador).
- `src/demurrage-engine/alerts/technicalAlertRecipients.ts` (lê a lista configurável — trilho T2).

**Arquivos existentes afetados:** `src/config.ts` ganha `trackingAlertRecipients: string[]` (env var). Nenhum arquivo da V1.

**Migrations:** nenhuma nova além das já reservadas no schema (`FalhaTracking`, `AgendamentoConsulta`, `AlertaTecnico` — ver "Schema — Fase 1").

**Idempotência do scheduler e dos alertas (ponto de atenção explícito):**
- Cada disparo previsto pela cadência (uma "janela", ex.: "D+9 deste BL") tem uma **chave de idempotência** própria em `AgendamentoConsulta` (`tracking_target_id + janela_prevista`) — agendado por `TrackingTarget`, não por contêiner (ponto 3): um BL que alimenta vários contêineres é consultado uma vez só, não uma vez por contêiner. Antes de consultar o Tracking Service, o scheduler verifica se aquela janela já foi executada (ou está em execução); se sim, não dispara de novo — isso protege contra o próprio processo Node reiniciar no meio de um ciclo (comum no plano free do Render, que "dorme" por inatividade) e contra duas instâncias do worker rodarem simultaneamente por engano.
- Para alertas técnicos, o comportamento pedido é **suprimir, não só deduplicar**: a 3ª falha consecutiva de um `TrackingTarget` dispara um `AlertaTecnico` e marca `FalhaTracking.alerta_disparado = true`; a 4ª, 5ª... falha consecutiva **não** gera novo alerta, porque a condição de disparo (`contador_consecutivo=3 AND alerta_disparado=false`) deixou de ser satisfeita. Só um sucesso (que zera `contador_consecutivo` e `alerta_disparado`) seguido de uma nova sequência até 3 falhas (incrementando `incidente_seq`) libera um novo disparo — um incidente novo, não um reforço do mesmo.
- Esse desenho reaproveita o mesmo padrão de dedupe da ingestão de eventos (Fase 5) — chave/condição de idempotência + estado do que já foi processado — para manter a mesma lógica em todo o sistema, não inventar um mecanismo novo por fase.

**Dependências:** Fase 5 (a cadência só faz sentido chamando o adaptador real); trilho T2 (lista de destinatários configurável) e T1 (papel `MANAGER` já existir para receber o alerta operacional).

**Testes obrigatórios:**
- Simulação de relógio (mock de tempo) percorrendo D0→D+5→D+9→D+13→D+17→diário→a cada 2 dias→suspensão aos 30 dias, verificando a data da próxima consulta em cada etapa.
- Reaproveitamento: se outro consumidor já tiver tracking válido dentro da janela, a cadência não dispara nova consulta (Cap. 16.9) — depende do serviço real informar "quando foi obtido", conforme contrato da Fase 5.
- Falha consecutiva zera `contador_consecutivo`/`alerta_disparado` após sucesso; a 3ª falha consecutiva dispara **um** `AlertaTecnico` (com o `MANAGER` responsável e os destinatários técnicos configurados — T2 — como destinatários do mesmo registro, não dois alertas separados), agrupando por armador quando múltiplos targets são afetados simultaneamente.
- **Supressão (ponto 14):** simular uma 4ª e 5ª falha consecutiva após a 3ª já ter dispara o alerta — nenhum novo `AlertaTecnico` é criado. Só depois de uma consulta bem-sucedida (reset) e uma nova sequência até 3 falhas (novo `incidente_seq`) um novo alerta é permitido.
- **Idempotência do scheduler:** disparar o job da mesma janela duas vezes (simulando reinício do processo ou dupla execução) resulta em uma única consulta real ao Tracking Service.

**Condição de aceite:** para um contêiner de teste avançando no tempo simulado, o scheduler gera exatamente as consultas previstas pela cadência do Cap. 16 e suspende automaticamente aos 30 dias de demurrage sem Empty Return; reexecuções da mesma janela são comprovadamente no-op; uma sequência de 3, 4 e 5 falhas consecutivas gera exatamente **um** `AlertaTecnico`, não três.

**Risco de regressão:** nulo para a V1 (job novo, isolado). Risco operacional: um scheduler mal calibrado pode gerar volume de chamadas ao serviço de tracking real acima do esperado — mitigar rodando primeiro em ambiente de teste/staging com o adaptador mockado antes de apontar para o serviço real.

---

## Fase 7 — Estados/prioridade

**Objetivo:** implementar a máquina de estados por contêiner do Cap. 21 (~10 estados, incluindo as faixas de dias 1–6/7–14/15+) e a fila de prioridade de 5 níveis com desempate de 5 critérios do Cap. 22, substituindo a classificação simplificada (`custo_ativo`/`risco`/`pendencia`/`encerrado`/`indefinido`) da V1 **apenas no motor V2** — a V1 continua com sua própria classificação até o corte (ver seção de coexistência).

**Arquivos/modelos novos:**
- `src/demurrage-engine/lifecycle/containerState.ts` (máquina de estados do Cap. 21).
- `src/demurrage-engine/lifecycle/priorityEngine.ts` (5 níveis + 5 critérios de desempate do Cap. 22).

**Arquivos existentes afetados:** nenhum arquivo da V1.

**Migrations:** campo `estado` (enum ampliado) e `prioridade` + `motivoPrioridade` (texto, Cap. 28.5 — "cada card explica por que está na fila... em texto") na entidade Contêiner/Processo.

**Dependências:** Fases 3 (dois relógios), 6 (tracking desatualizado como um dos estados depende de saber a cadência esperada).

**Testes obrigatórios:**
- Transições de estado cobrindo os ~10 estados do Cap. 21, incluindo os limiares exatos (dia 6→7 crítico, dia 14→15 escalada).
- Ordenação da fila reproduzindo o exemplo de desempate do Cap. 22.7 (dias de demurrage > exposição Rocket existente > maior valor > tracking mais antigo/falha > menor tempo até vencimento).
- "Prazo próximo" nunca é rotulado como "Atenção"/"Crítico" (distinção explícita exigida pelo Cap. 21.2).

**Condição de aceite:** fixture com processos variados produz a mesma ordenação e os mesmos rótulos de prioridade que os exemplos do Cap. 22 do Blueprint.

**Risco de regressão:** nulo para a V1.

---

## Fase 8 — Empty Return/minuta/fechamento

**Objetivo:** implementar a detecção de devolução (Cap. 19), a distinção `trackingReturnDate` × `effective_return_date` da minuta (Cap. 19.1) e o fechamento operacional (Cap. 20/27.1) — **sem** gate de responsabilidade Rocket×cliente (correção de premissa #2: essa análise é plugável e chega na Fase 11; um processo pode fechar operacionalmente sem ela resolvida, ficando "responsabilidade em análise" como estado, não como bloqueio).

**Arquivos/modelos novos:**
- `src/demurrage-engine/closing/returnDetection.ts` (consome evento Empty Return do adaptador de tracking, Fase 5).
- `src/demurrage-engine/closing/minutaValidation.ts` (validação de minuta: nº de contêiner + data coerente → `effective_return_date`; divergência preserva as duas evidências).
- `src/demurrage-engine/closing/processClosure.ts` (estados separados do Cap. 20.3: interno da Rocket / documental do cliente / financeiro HeadCargo — este último inicialmente sempre "não disponível", já que HeadCargo é fora de escopo desta migração).
- `src/demurrage-engine/closing/reopening.ts` (reabertura restrita a `MANAGER`/`ADMIN` + justificativa, preservando valores anteriores).

**Arquivos existentes afetados:** nenhum arquivo da V1. `src/demurrage/demurrageStore.ts` (minuta solicitada + atividades) é **lido** no backfill da Fase 1, mas a partir da Fase 8 a V2 passa a ter seu próprio fluxo de minuta — a ação "solicitar minuta" da V1 (que cria rascunho no Outlook) pode ser reaproveitada como está, já que é só uma ação de e-mail, não faz parte do motor de cálculo.

**Migrations:** campos `trackingReturnDate`, `effectiveReturnDate`, `minutaDivergence`, estado `responsabilidade: 'em_analise' | 'confirmada_rocket' | 'confirmada_cliente' | 'dividida'` (valor default `em_analise`, sem bloquear fechamento).

**Dependências:** Fase 5 (evento Empty Return estruturado), Fase 7 (estados). T1 (papéis `MANAGER`/`ADMIN` para reabertura).

**Testes obrigatórios:**
- Minuta com data diferente do Empty Return → preserva as duas, usa a da minuta, registra divergência (Cap. 19.1).
- Processo sem custo concluído internamente mesmo com minuta pendente (Cap. 20.1) — confirma que a ausência de análise de responsabilidade **não** impede esse fechamento (validação direta da correção de premissa #2).
- Minuta chegando depois de um fechamento sem custo e criando custo → vai para reabertura (`MANAGER`), não recalcula silenciosamente (Cap. 19.1 último parágrafo).

**Condição de aceite:** ciclo completo simulado (descarga → free time → demurrage → Empty Return → minuta) fecha o processo operacionalmente sem exigir responsabilidade resolvida, e reabre corretamente quando uma minuta divergente chega depois.

**Risco de regressão:** nulo para a V1. Ponto de atenção: se a ação "solicitar minuta" for reaproveitada da V1 (`src/routes/demurrageRoutes.ts`), garantir que ela grave o evento tanto no `demurrageStore.ts` (V1, para não quebrar a tela atual) quanto no novo modelo (V2) enquanto as duas coexistirem — evitar que uma ação do operador apareça numa tela e não na outra.

---

## Fase 9 — UI operacional

**Objetivo:** construir a tela operacional V2 (Cap. 28/29: dois relógios visíveis separadamente, MBL/armador no card, filtros do Cap. 28.7, linha do tempo, ações de Gestor) **como uma tela nova**, mantendo `Demurrage.dc.html` (V1) funcionando em paralelo até o corte controlado (ver seção de coexistência abaixo, que detalha exatamente este ponto conforme pedido).

**Arquivos/modelos novos:**
- Novo endpoint `GET /api/demurrage/v2` (ou `/api/demurrage-engine`) em `src/routes/demurrageEngineRoutes.ts`, servindo o payload do motor V2.
- Nova tela `public/DemurrageV2.dc.html` (nome de trabalho) ou uma variante da existente controlada por flag — a decidir na hora, mas **sem sobrescrever** `Demurrage.dc.html` até o corte.
- Endpoints auxiliares: histórico/timeline do processo, filtros (Cap. 28.7), ação de correção de dado (gated por RBAC), botão "Atualizar tracking" (gated por `MANAGER`/`ADMIN`, respeitando cooldown de 2h da Fase 6/T1).

**Arquivos existentes afetados:** `src/index.ts` ganha o novo mount de rota (adição, não alteração da rota V1). `Demurrage.dc.html` só é tocado no momento do corte, não antes.

**Migrations:** nenhuma nova (consome o que já existe das Fases 1–8).

**Dependências:** Fases 1–8 completas o suficiente para o payload ter dado real; T1 (RBAC) para os gates de ação; **shadow mode concluído** (seção "Estratégia de coexistência e corte") — nenhuma tela V2 é exposta antes de todas as diferenças V1×V2 estarem catalogadas e explicadas.

**Testes obrigatórios:**
- Contrato do novo endpoint (schema do payload) coberto por teste, incluindo os campos que o Cap. 28.2/28.4 exigem (MBL, armador, os dois relógios separados, etc.).
- Teste de que ações restritas (correção de dado, atualizar tracking) retornam 403 para papéis sem permissão.
- Teste de regressão cruzada: `GET /api/demurrage` (V1) continua respondendo exatamente como antes, mesmo com a V2 montada no mesmo processo Express.

**Condição de aceite:** a tela V2 é navegável em paralelo à V1 (ex.: acessível por uma URL/flag separada), mostrando os dois relógios e os filtros, sem que a V1 apresente qualquer diferença de comportamento.

**Risco de regressão:** baixo, mas não nulo — é a primeira fase que toca `src/index.ts` (adição de rota) e potencialmente compartilha middlewares (sessão, `requireAuth`) com a V1. Mitigação: testes de regressão da V1 rodando no CI a cada mudança desta fase em diante.

---

## Fase 10 — Gestão

**Objetivo:** construir a visão de Gestão do Cap. 30 (indicadores operacionais, financeiros somente-leitura, responsabilidade Rocket, qualidade de tracking, segregação por moeda), consumindo os dados já existentes das Fases 1–9. Não introduz cálculo novo, é camada de agregação/apresentação.

**Arquivos/modelos novos:**
- `src/demurrage-engine/reporting/managementIndicators.ts` (agregações do Cap. 30.1–30.6).
- Nova tela/rota `GET /api/demurrage/v2/gestao` + view correspondente (gated por `MANAGER`/`ADMIN`).

**Arquivos existentes afetados:** nenhum.

**Migrations:** possivelmente índices de consulta para acelerar agregação (dependendo do motor de persistência escolhido na Fase 1) — não é migração de schema de domínio, é otimização.

**Dependências:** Fases 1–9 (precisa de volume real de dados para os indicadores fazerem sentido); T1 (gate de papel).

**Testes obrigatórios:**
- Cada indicador do Cap. 30.1/30.2/30.4/30.5 testado contra uma base fixture conhecida (valor esperado calculado à mão).
- Segregação por moeda: nenhum total soma USD+BRL sem conversão explícita (Cap. 30.6) — teste garantindo que valores em moedas diferentes nunca aparecem somados sem indicação de taxa/fonte.
- Todo indicador permite abrir sua composição (Cap. 30.7) — teste de que a agregação sempre carrega a lista de itens que a compõem, não só o total.

**Condição de aceite:** a tela de Gestão reflete corretamente os indicadores para a base de teste, com pendências/estimativas destacadas separadamente de valores confirmados.

**Risco de regressão:** nulo (tela nova, sem tocar V1).

---

## Fase 11 — Responsabilidade via Liberação

**Objetivo:** implementar a pré-análise de responsabilidade Rocket × cliente do Cap. 26 **como módulo plugável e opcional**, ativado somente quando o módulo Liberação expuser eventos estruturados (linha do tempo consultável). Até lá, o campo `responsabilidade` de todo contêiner permanece `em_analise` (default já estabelecido na Fase 8) sem nenhum efeito bloqueante — confirmando a correção de premissa #2 do usuário.

**Arquivos/modelos novos:**
- `src/demurrage-engine/responsibility/liberacaoTimelineSource.ts` (porta/interface — implementação real só quando a Liberação existir; até lá, um stub que sempre retorna "sem dados suficientes").
- `src/demurrage-engine/responsibility/responsibilitySuggestionEngine.ts` (interseção entre dias de demurrage e período de responsabilidade interna da Rocket, Cap. 26.2).
- Fluxo de confirmação do `MANAGER` (Cap. 26.3): confirmar Rocket / confirmar cliente / dividir / manter em análise, com registro completo da decisão (Cap. 26.4).

**Arquivos existentes afetados:** nenhum.

**Migrations:** entidade `responsibility_decision` (data apta, data efetiva, intervalo sugerido, dias confirmados, justificativa, evidências, gestor, timestamp).

**Dependências:** **bloqueada externamente** até o módulo Liberação existir/expor uma fonte consultável — esta fase pode ser desenvolvida e testada inteiramente com um `liberacaoTimelineSource` mockado, mas só entra em uso real quando a fonte real existir. Não bloqueia nenhuma fase anterior nem posterior (confirma a decisão do usuário de desacoplar).

**Testes obrigatórios:**
- Exemplo literal do Cap. 26.2 (demurrage 15/09, liberação possível em 15/09, liberação efetiva em 17/09, Empty Return 20/09 → sugestão 15–17 Rocket, 18–20 cliente).
- Evidência insuficiente → mantém `em_analise`, nunca presume responsabilidade (Cap. 26.1 último parágrafo).
- Confirmação do Gestor é a única ação que altera definitivamente o campo — sugestão sozinha nunca muda a cobrança exibida ao cliente (Cap. 26.3/26.4 último parágrafo — isso também é pré-requisito direto da Fase 12).

**Condição de aceite:** com o `liberacaoTimelineSource` mockado, o motor reproduz o exemplo do Cap. 26.2 e respeita o fluxo de confirmação humana. Com a fonte real ausente (caso de hoje), todo contêiner permanece `em_analise` sem erro nem bloqueio.

**Risco de regressão:** nulo — módulo aditivo e desligado por padrão até a fonte real existir.

---

## Fase 12 — Portal do Cliente

**Objetivo:** substituir o mock estático da aba Demurrage de `PortalCliente.dc.html` por um endpoint **dedicado e filtrado**, implementando a lista de campos permitidos/proibidos do Cap. 32.1/32.2 e as cores/estados do Cap. 32.3, para o papel `CLIENT` do RBAC.

**Arquivos/modelos novos:**
- `src/demurrage-engine/portal/clientPayloadBuilder.ts` (monta o payload do portal a partir do modelo interno, **nunca** reaproveitando o payload do endpoint do analista — mitigação direta do risco de vazamento identificado no diagnóstico, item D10).
- Nova rota `GET /api/demurrage/v2/portal/:processo` gated por `CLIENT` (só vê os próprios processos) e pelos demais papéis (para pré-visualização/QA).
- Teste de contrato "campo proibido nunca aparece" (lista fixa do Cap. 32.2, testada contra o payload real do portal a cada mudança futura — teste de regressão permanente).

**Arquivos existentes afetados:** `public/PortalCliente.dc.html` — a aba Demurrage passa a consumir o novo endpoint em vez do mock hard-coded no componente; nenhuma outra aba do portal é tocada.

**Migrations:** nenhuma nova.

**Dependências:** Fases 1–9 (dado real precisa existir), T1 (papel `CLIENT`), Fase 11 idealmente pronta (para garantir que nada da análise de responsabilidade escape — mas não é bloqueante, já que o payload é construído por lista de campos permitidos, não por exclusão).

**Testes obrigatórios:**
- Teste de contrato citado acima (nenhum campo do Cap. 32.2 no payload), rodando a cada build, não só uma vez.
- Estados/cores do Cap. 32.3, incluindo o caso explícito "0 dias restantes ainda é dentro do prazo, nunca aparece como demurrage".
- Cliente só enxerga os próprios processos (isolamento por identidade, não só por filtro de campo).
- Upload de minuta pelo portal não altera datas/valores até validação (Cap. 32.6).

**Condição de aceite:** para um processo de teste com dado de Rocket completo (Master FT, exposição, responsabilidade), o payload do portal não contém nenhum desses campos, mesmo que o payload interno do analista os tenha.

**Risco de regressão:** médio para o Portal (é a única fase que efetivamente substitui um comportamento visível da V1 — o mock atual). Mitigação: como o mock de hoje não reflete dado real nenhum, qualquer usuário que hoje vê a aba Demurrage do portal já está vendo dado fictício; a virada para dado real é, em si, uma correção, não uma regressão — mas deve ser comunicada como tal (o conteúdo muda de "exemplo" para "real").

---

## Estratégia de coexistência e corte (cutover) da API — atenção especial pedida

**Enquanto isso (Fases 1–8):** `GET /api/demurrage` (V1) e `Demurrage.dc.html` continuam servindo os usuários normalmente, sem nenhuma alteração de comportamento. A V2 evolui em arquivos, rotas e (na Fase 9) tela totalmente separados. Nenhum usuário é afetado nesse período.

**Shadow mode (novo estágio, obrigatório, entre o fim da Fase 8 e a exposição de qualquer tela V2 na Fase 9):**
Antes de qualquer usuário ver a V2, ela roda **sem UI e sem tráfego de usuário**, calculando os mesmos processos que a V1 está mostrando em produção, só para comparação:
- Um job de shadow (reaproveita o scheduler da Fase 6, ou um script dedicado) processa, em paralelo à V1, o mesmo conjunto de processos ativos, gerando o resultado completo da V2 (estados, dias de demurrage, valores) para cada um.
- Cada resultado V2 é comparado ao resultado que a V1 mostra **hoje** para o mesmo processo, e a diferença é gravada em `ShadowDiff` (ver schema) — nunca corrigida automaticamente, nunca exibida a nenhum usuário.
- Diferenças esperadas (ex.: V2 usa `discharge_date` e a V1 usa `dataRetirada` — Fase 2 corrigiu isso de propósito) são **catalogadas e explicadas**, não tratadas como bug; diferenças inesperadas (ex.: um contêiner que a V1 mostra em demurrage e a V2 não encontra) são investigadas antes de prosseguir.
- Critério para sair do shadow mode e entrar no "paralelo controlado" da Fase 9: todas as diferenças observadas estão catalogadas e explicadas (esperadas pela correção de regras, ou por lacuna de dado ainda pendente de fonte) — nenhuma diferença "misteriosa" sem explicação.
- O shadow mode não expõe nenhuma rota nova a usuários finais — é um processo interno/job, sem tela.

**Fase 9 (paralelo controlado, só depois do shadow mode ter sido concluído):** o novo endpoint (`GET /api/demurrage/v2`) e a nova tela ficam disponíveis **ao lado** da V1, atrás de uma flag de acesso (ex.: rota separada acessível só a quem souber o link, ou flag de config `DEMURRAGE_V2_ENABLED`). Isso permite validar a V2 com dado real em produção sem expor todos os usuários a ela.

**Corte (não é uma fase numerada — é um evento controlado, proposto para acontecer só depois da Fase 9 estar validada, tipicamente em paralelo às Fases 10–12):**
1. Trocar, em `public/Demurrage.dc.html` (ou por uma variável de config lida por `index.ts`), a URL que o front chama de `/api/demurrage` para `/api/demurrage/v2` — **atrás de flag**, reversível sem novo deploy (só mudando a config).
2. Rodar as duas rotas montadas simultaneamente por um período de observação (sugestão: até haver confiança operacional, sem prazo fixo imposto aqui — decisão do time operacional).
3. `GET /api/demurrage` (V1) **não é removida nesta migração** — o pedido foi evitar reescrita destrutiva, então o código V1 pode ficar como rota "legada" mantida por segurança até uma decisão explícita e futura de descomissionamento, fora do escopo deste plano.
4. Se qualquer problema aparecer na V2 em produção, reverter a flag imediatamente volta o front a consumir `/api/demurrage` (V1), que nunca parou de funcionar.

**Dado histórico:** como a V1 não tem persistência real (recalcula do e-mail a cada request), não há "dado histórico da V1" a migrar além do que já foi coberto no backfill da Fase 1 (`demurrage-minutas.json`/`demurrage-atividades.json`). Não há risco de perda de dado no corte, porque a V1 nunca guardou dado de cálculo — só ações do operador, já cobertas.

---

## Resumo de dependências entre fases (visão rápida)

```
Fase 1 ──► Fase 2 ──► Fase 3 ──► Fase 4
              │                    │
              └────────────────────┴──► Fase 5 (bloqueada por acesso externo) ──► Fase 6 ──► Fase 7 ──► Fase 8 ──► Fase 9 ──► Fase 10
                                                                                                            │
                                                                                    Fase 11 (paralela, plugável, sem bloquear) 
                                                                                                            │
                                                                                                         Fase 12
```

Fases 2, 3 e 4 são motores puros e podem ser desenvolvidas e 100% testadas por fixtures **antes** até de a Fase 5 ter acesso ao serviço real — não há motivo para esperar o acesso externo para começar o trabalho de cálculo. O único bloqueio externo real do plano inteiro é a Fase 5 (acesso ao Tracking Service existente); a Fase 11 depende de outro bloqueio externo (Liberação), mas foi desenhada para não travar nada além de si mesma.

---

# Schema — Fase 1 (revisão 4, aprovado e implementado)

**Status: APROVADO. Migrations escritas e aplicadas (ver "Relatório de entrega — Fase 1" ao final).** Esta revisão incorpora as 6 decisões finais da revisão 4 (multiempresa desde a fundação, PostgreSQL definitivo e a remoção de `fato_gerador_data` como premissa genérica de `CondicaoComercial`) e as aprovações da revisão 5 (responsável operacional via `OrganizationMembership`, `TrackingTarget` global com vínculo N:N). Tipos são conceituais nesta seção narrativa (TEXT, INTEGER, DATE, TIMESTAMP, BOOLEAN, ENUM, JSON) — o DDL real (tipos `UUID`/`JSONB`/`TIMESTAMPTZ` do Postgres) está nos arquivos `.sql` em `src/demurrage-engine/db/migrations/`.

**Nota de investigação (ponto 11):** verifiquei `src/routes/processRoutes.ts` — o único candidato a "registro central de Processo" já existente na Priora — e confirmei que ele também é *stateless* (monta "processos" ao vivo agrupando e-mail por `conversationId`, sem persistência). Não há hoje, neste código, nenhum cadastro central de Cliente/Processo para referenciar em vez de criar. `Cliente` e `Processo` abaixo nascem, portanto, como registros **locais e operacionais do módulo Demurrage**, não como cadastro corporativo — cada um leva um campo de referência externa nullable (`ref_externa`) reservado para o dia em que uma integração (HeadCargo ou outro cadastro central) existir, para então *linkar* em vez de duplicar. Já `Usuario` **evita** duplicar identidade: em vez de criar um sistema de contas paralelo, ele referencia o `homeAccountId` do MSAL que `requireAuth.ts` já usa — RBAC só adiciona `papel`/`cliente_id` em cima da identidade que já existe.

## Convenções

- **DATE** (data civil, sem hora) é usado em todo campo que participa da contagem de dias de demurrage (ponto 10) — nunca TIMESTAMP. O motor temporal trabalha só com datas civis: não há hora, não há fuso e não há conversão UTC em nenhuma etapa da contagem. A data civil de um evento é a data do evento como informada pela fonte; como um evento vindo do Tracking Service vira data civil é parte do contrato da Fase 5, nunca uma conversão feita pelo motor.
- **TIMESTAMP** (`TIMESTAMPTZ` no Postgres) é reservado para coleta/auditoria/execução (quando algo foi registrado pela Priora), nunca para contagem de dias.
- Toda entidade marcada **append-only** não sofre `UPDATE` de conteúdo — só `INSERT`, e isso é aplicado por *trigger* no Postgres, não só por convenção de código (ver Fase 1 implementada); quando uma transição de status é necessária (ex.: `ValorApurado.calculation_status`), é a única exceção documentada por entidade.
- **Multiempresa:** toda entidade de tenant carrega `organization_id` — direto quando é uma entidade "de primeira classe" (Cliente, Processo, CondicaoComercial, FieldObservation, Snapshot, BackfillRun, Contêiner), ou por relacionamento inequívoco quando é claramente subordinada a uma entidade que já o carrega (ex.: `BackfillItem` via `backfill_run_id`). Entidades de **dado de referência compartilhado** entre todas as organizações (Armador, ContainerType, ContainerTypeMapping) não carregam `organization_id` — MSC é o mesmo MSC para qualquer tenant da Priora. **`TrackingTarget` também é global** (revisão 5), assim como as entidades operacionais penduradas nele (`TrackingFetch`, `TrackingEvent`, `FalhaTracking`, `AgendamentoConsulta`): um mesmo MBL é a mesma consulta para qualquer consumidor. O isolamento multiempresa do tracking é feito pelo acesso via `Processo`/`Contêiner` (tabela de vínculo `ContainerTrackingTarget`) — compartilhar internamente o resultado bruto de um target não autoriza exposição entre organizações. `TabelaTarifaria` é o caso misto: `organization_id` **nullable** — `NULL` = tabela de referência pública/compartilhada (ex.: as tabelas de armador do Blueprint), preenchido = tabela privada negociada por uma organização (ex.: uma tabela Rocket×cliente específica). Toda constraint de unicidade que antes era global passa a ser escopada por organização (ex.: `UNIQUE(organization_id, numero_processo)`). A consistência de organização das referências é garantida no Postgres: por *trigger* no lado filho em `cliente_id`, `processo_id`, `condicao_comercial_id` e `entidade_id` polimórfico (migrations 0003/0004), e por **FK composta** em `responsavel_operacional_membership_id` (migration 0006). **Resolvido na revisão 6 (DECISÃO 1, migration 0007):** o `organization_id` de toda tabela de tenant é agora **imutável** — um único trigger `organization_id_immutable` (`BEFORE UPDATE`, disparado só quando `OLD.organization_id IS DISTINCT FROM NEW.organization_id`) rejeita mover qualquer registro para outra organização, fechando também o caminho da linha *pai*. UPDATEs que não mudam a organização seguem livres. **Convenção padrão:** toda tabela de tenant futura com `organization_id` nasce com esse trigger, salvo decisão funcional explícita — um teste de catálogo (`migration0007.test.ts`) falha se alguma tabela com `organization_id` ficar sem ele.

## Entidades

### Identidade e organização

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **Organization** | id, nome, slug, criado_em | UNIQUE(slug) |
| **Usuario** *(identidade global — não pertence a uma organização)* | id, nome, email, home_account_id (nullable — referência à identidade MSAL já existente em `requireAuth.ts`), criado_em | UNIQUE(email), UNIQUE(home_account_id) |
| **OrganizationMembership** | id, organization_id → Organization, usuario_id → Usuario, papel (`ANALYST`\|`MANAGER`\|`ADMIN`\|`CLIENT`), cliente_id → Cliente (nullable — só relevante quando papel=`CLIENT`; trigger garante que o `Cliente` referenciado pertence à mesma `organization_id`), criado_em | UNIQUE(organization_id, usuario_id) — leitura literal de "o papel" (singular) do pedido: um papel por pessoa por organização nesta V1 do RBAC. UNIQUE(id, organization_id) — chave candidata que sustenta a FK composta do responsável operacional (migration 0006). |

### Cadastro de referência (compartilhado entre organizações)

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **Armador** | id, nome, codigo_interno | UNIQUE(codigo_interno) |
| **ContainerType** | id, codigo (ex. `40HC`), nome, categoria (`dry`\|`reefer`\|`open_top`\|`flat_rack`\|`especial`), tamanho_pes (`20`\|`40`\|`45`) | UNIQUE(codigo) |
| **ContainerTypeMapping** | id, valor_original, fonte, container_type_id → ContainerType, regra_aplicada, vigente_desde (DATE), vigente_ate (DATE, nullable) | UNIQUE(valor_original, fonte, vigente_desde) — permite reversionar sem apagar histórico |

### Núcleo operacional (escopado por organização)

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **Cliente** | id, **organization_id** → Organization, nome, documento (nullable — Blueprint não define regra de unicidade, não inventada aqui), contatos (JSON), ref_externa (nullable), criado_em | — |
| **CondicaoComercial** | id, **organization_id** → Organization, termo_tipo (`embarque`\|`unico`), fonte_documental (nullable), criado_em. **`fato_gerador_data` removido** (decisão final #3) — não existe fato gerador genérico; cada motor comercial (Fase 4) determina sua própria regra temporal a partir do próprio instrumento. `tabela_id` → TabelaTarifaria é adicionado por `ALTER TABLE` só na Fase 4, quando a tabela existir — a entidade nasce mínima aqui. | — |
| **Processo** | id, **organization_id** → Organization, numero_processo (nullable — aprovado na revisão 5: processo ainda sem número identificado é pendência real, nunca placeholder), cliente_id → Cliente (nullable — idem), mbl, hbl (nullable), armador_id → Armador (referência global), condicao_comercial_id → CondicaoComercial (nullable), **responsavel_operacional_membership_id** → OrganizationMembership (nullable — revisão 5, migration 0006; substitui o antigo `responsavel_operacional_id → Usuario`, removido), ref_externa (nullable), criado_em | UNIQUE(organization_id, numero_processo) — vários `NULL` coexistem. Trigger garante `cliente_id` e `condicao_comercial_id` (quando presentes) da mesma `organization_id`. **FK composta** `(responsavel_operacional_membership_id, organization_id) → organization_memberships(id, organization_id)` garante o responsável da mesma organização nos dois sentidos (também impede mover para outra organização um membership que já é responsável); responsável `NULL` permitido; excluir membership que é responsável é bloqueado (o Blueprint não define reatribuição automática). |
| **Contêiner** | id, **organization_id** → Organization (denormalizado do Processo pai, com trigger de consistência — ver nota), processo_id → Processo, numero (ISO 6346), container_type_id → ContainerType (nullable, referência global), container_type_source_observation_id → FieldObservation (nullable), **discharge_date** (DATE, nullable) + discharge_date_observation_id, **house_free_time_days** (INTEGER, nullable) + house_free_time_observation_id, **master_free_time_days** (INTEGER, nullable) + master_free_time_observation_id, **gate_out_date** (DATE, nullable) + gate_out_observation_id, **tracking_return_date** (DATE, nullable) + tracking_return_observation_id, **effective_return_date** (DATE, nullable — derivado), criado_em, atualizado_em | UNIQUE(processo_id, numero) — já org-seguro por transitividade (o processo já é único por organização); `organization_id` denormalizado existe para índice/consulta direta e é validado por trigger contra `processo_id`. `estado`/`prioridade`/`motivo_prioridade` (Cap. 21) **não** entram na Fase 1 — nada os calcula ainda; entram no `ALTER TABLE` da Fase 7, decisão puramente técnica de sequenciamento (não muda regra aprovada). |

*Nota sobre `Contêiner`: os 7 campos em negrito são os dados críticos tipados (ponto 1 da revisão 3) — cada um é o valor **atualmente selecionado** pela hierarquia de fontes, com um ponteiro `<campo>_observation_id` apontando para o `FieldObservation` que o originou. `pendente` não precisa de enum próprio: é simplesmente o campo estar `null`. `effective_return_date` é recalculado (não é uma observação direta) sempre que `tracking_return_date` ou uma `Minuta` validada mudam.*

*Vínculo com tracking (revisão 5): `Contêiner` **não** tem coluna de target de tracking. A relação é N:N pela tabela `ContainerTrackingTarget` (Fase 5) — um target (ex.: um MBL) alimenta vários contêineres, e um contêiner pode ser coberto por mais de um target (ex.: MBL e o próprio número do contêiner).*

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **FieldObservation** *(append-only, protegido por trigger no Postgres)* | id, **organization_id** → Organization, entidade_tipo (`processo`\|`container`), entidade_id, campo, valor (JSONB), fonte (`tracking_service`\|`email_heuristic`\|`manual_fallback`\|`house_document`\|`master_bl`\|`headcargo`\|`outro`), observado_em (TIMESTAMPTZ), coletado_em (TIMESTAMPTZ), evidencia_ref (nullable), criado_por → Usuario (nullable), criado_em | UNIQUE(entidade_tipo, entidade_id, campo, fonte, observado_em) — **não limita quantas fontes distintas** observam o mesmo campo. Trigger garante `organization_id` bate com a organização real de `entidade_id` (via `processos`/`containers`, conforme `entidade_tipo`) — nunca uma observação "vaza" para a organização errada. |
| **Snapshot** *(append-only, protegido por trigger)* | id, **organization_id** → Organization, container_id → Contêiner, versao (INTEGER), criado_em, evento_origem_id (nullable — FK para `TrackingEvent`, adicionada na Fase 5), dados_congelados (JSONB) | UNIQUE(container_id, versao). Trigger garante `organization_id` = organização do `container_id`. |

### Relógio (projeção/cache) — Fase 2/3, não construído na Fase 1

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **Relogio** *(projeção/cache — descartável, nunca fonte de verdade)* | id, container_id → Contêiner, tipo (`cliente`\|`rocket`), ultimo_dia_livre (DATE), primeiro_dia_demurrage (DATE), data_final_apuracao (DATE), dias_demurrage (INTEGER), estado (`OK`\|`PENDING`\|`INVALID`), pendencias (TEXT[]), motivo (TEXT, nullable), **calculated_at** (TIMESTAMP), **engine_version** (TEXT), **input_hash** (TEXT) | UNIQUE(container_id, tipo). `organization_id` não é coluna própria — herdado via `container_id` (é puro cache, recalculável; não há risco de vazamento entre organizações que sobreviva a um recomputo). Escrita só pelo recalculador (trigger `relogios_somente_recalculador`); `DELETE` livre. **Revisão 6:** `estado` passou de `aberto`\|`fechado`\|`pendente` (revisão 3) para `OK`\|`PENDING`\|`INVALID`, espelhando 1-para-1 o `FreeTimeClockResult` do motor — ver PRECISA DE SUA VALIDAÇÃO no relatório da revisão 6. |

### Tarifas — três motores comerciais explícitos — Fase 4, não construído na Fase 1

**Decisão final #3 (revisão 4):** não existe fato gerador universal. Cada motor abaixo é responsável por determinar sua própria regra temporal/tarifária a partir do instrumento que lhe é próprio — nenhum campo genérico em `CondicaoComercial` tenta representar isso de antemão.

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **TabelaTarifaria** | id, **organization_id** (nullable — `NULL`=referência pública/compartilhada entre organizações, ex. tabelas de armador do Blueprint; preenchido=tabela privada de uma organização, ex. tabela Rocket×cliente negociada), tipo (`rocket_cliente`\|`armador`), armador_id → Armador (nullable), termo_comercial (`embarque`\|`unico`, nullable), versao, vigencia_inicio (DATE), vigencia_fim (DATE, nullable), **qualidade_fonte** (`OFICIAL_VALIDADA`\|`OFICIAL_NAO_VALIDADA`\|`PUBLICA_ESTIMATIVA`\|`PROVISORIA_INCOMPLETA`), **day_count_basis** (`since_discharge_absolute`\|`excess_over_free_time`), fonte | UNIQUE(organization_id, tipo, armador_id, termo_comercial, versao) — `NULL` em `organization_id` participa da unicidade normalmente (Postgres trata `NULL`s como não-conflitantes por padrão; se duas tabelas públicas idênticas precisarem ser impedidas, um índice único parcial `WHERE organization_id IS NULL` resolve — decisão de detalhe da Fase 4, não da Fase 1). |
| **FaixaTarifaria** | id, tabela_id → TabelaTarifaria, tipo_equipamento, dia_inicial (INTEGER), dia_final (INTEGER, nullable = aberto), valor_dia, moeda | UNIQUE(tabela_id, tipo_equipamento, dia_inicial) |
| **ValorApurado** *(append-only, exceto a transição de `calculation_status`)* | id, container_id → Contêiner, relogio_tipo (`cliente`\|`rocket`), **motor_comercial** (`termo_embarque`\|`termo_unico`\|`exposicao_armador`), tabela_id → TabelaTarifaria (nullable se UNAVAILABLE), versao_tabela, **day_count_basis_aplicada** (nullable — copiado no momento do cálculo, não lido de `TabelaTarifaria` em consultas futuras; `TermoPorEmbarqueEngine`, tarifa fixa, não usa faixa e deixa `null`), period_start (DATE), period_end (DATE), dias_cobrados (INTEGER), faixas_aplicadas (JSONB), total, moeda, **confirmation_status** (`ESTIMATED`\|`ESTIMATED_PROVISIONAL`\|`CONFIRMED`\|`UNAVAILABLE` — só chega a `CONFIRMED` com `custo_real_confirmado_ref` preenchido, nunca só por a tabela ser `OFICIAL_VALIDADA`), custo_real_confirmado_ref (nullable), **calculation_status** (`OPEN`\|`FINAL`\|`SUPERSEDED`), **engine_version**, **input_hash**, **supersedes_id** → ValorApurado (nullable), calculated_at, criado_em | Índice parcial único: no máximo um `ValorApurado` com `calculation_status IN ('OPEN','FINAL')` por (container_id, relogio_tipo, motor_comercial). `organization_id` herdado via `container_id`. |

*Os três motores (`TermoPorEmbarqueEngine` → `TabelaTarifaria.tipo='rocket_cliente', termo_comercial='embarque'`, tarifa fixa por dia, sem faixa; `TermoUnicoEngine` → `tipo='rocket_cliente', termo_comercial='unico'`, usa `FaixaTarifaria` + `day_count_basis`; `ExposicaoRocketEngine` → `tipo='armador'`, usa `FaixaTarifaria` + `day_count_basis` do armador) permanecem três estratégias de código isoláveis (Fase 4). A memória de cálculo em `ValorApurado` (`motor_comercial`, `engine_version`, `tabela_id`+`versao_tabela`, `day_count_basis_aplicada`, `period_start`/`period_end`, `faixas_aplicadas` como inputs relevantes, `total` como resultado, `confirmation_status`, `input_hash`) é suficiente para reconstruir **por que** um valor foi calculado sem depender da regra atual do sistema — exigência explícita da decisão final #3.*

### Tracking (target → fetch → evento) — Fase 5/6, não construído na Fase 1

**Desenho aprovado na revisão 5:** `TrackingTarget` é global/compartilhado (sem `organization_id`) e se liga aos contêineres por uma tabela N:N, `Contêiner ← ContainerTrackingTarget → TrackingTarget`. Um único target (ex.: um MBL) alimenta vários contêineres e pode ser reaproveitado entre consumidores sem duplicar consulta. Todas as entidades operacionais do tracking (`TrackingFetch`, `TrackingEvent`, `FalhaTracking`, `AgendamentoConsulta`, `AlertaTecnico`) operam **por `TrackingTarget`**, nunca por contêiner. O isolamento multiempresa continua no acesso: uma organização só enxerga o tracking pelos seus próprios `Contêiner`s — o compartilhamento interno do resultado bruto de um target nunca autoriza exposição entre organizações.

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **TrackingTarget** *(global — sem organization_id)* | id, armador_id → Armador, reference_type (`bl_master`\|`bl_house`\|`container`), reference_value (TEXT) | UNIQUE(armador_id, reference_type, reference_value) |
| **ContainerTrackingTarget** *(vínculo N:N — escopado via Contêiner)* | container_id → Contêiner, tracking_target_id → TrackingTarget, criado_em | PRIMARY KEY/UNIQUE(container_id, tracking_target_id). Sem `organization_id` próprio: herda a organização pelo `container_id`, e é por ele que o acesso de cada organização ao tracking é filtrado. Se o vínculo deve registrar a própria proveniência (de onde se soube que o target cobre o contêiner) é detalhe da Fase 5. |
| **TrackingFetch** *(append-only após conclusão; global, por target)* | id, tracking_target_id → TrackingTarget, iniciado_em, finalizado_em (nullable), **status_consulta** (`sucesso`\|`falha`\|`parcial`\|`timeout`), erro_mensagem (nullable), origem_disparo (`scheduler`\|`manual`\|`shadow`\|`backfill`), usuario_id → Usuario (nullable, disparo manual — nunca exposto a outra organização que compartilhe o target), referencia_dado_bruto (nullable) | — |
| **TrackingEvent** *(append-only)* | id, tracking_fetch_id → TrackingFetch, tracking_target_id → TrackingTarget (denormalizado), tipo_evento (`descarga`\|`gate_out`\|`empty_return`\|`outro`), numero_contêiner (nullable — o evento pode ser do target inteiro), data_evento (DATE), **external_event_id** (nullable, ponto 5), **dedupe_hash** (NOT NULL — hash(external_event_id) quando existe; senão fallback determinístico hash(armador+target+tipo_evento+numero_contêiner+data_evento)), referencia_dado_bruto, criado_em | UNIQUE(tracking_target_id, dedupe_hash) |
| **FalhaTracking** | id, tracking_target_id → TrackingTarget, contador_consecutivo (INTEGER), **incidente_seq** (INTEGER, default 0 — incrementa cada vez que, após reset por sucesso, o contador volta a atingir 3), **alerta_disparado** (BOOLEAN), ultima_falha_em, ultima_resposta_valida_em, atualizado_em | UNIQUE(tracking_target_id) — global, uma sequência de falhas por target; atualizada in-place a cada `TrackingFetch` concluído para o target (incrementa em falha, zera `contador_consecutivo`+`alerta_disparado` em sucesso). |
| **AlertaTecnico** *(append-only)* | id, falha_tracking_id → FalhaTracking, incidente_seq (copiado no disparo), armador_id → Armador (denormalizado, para agrupar mensagem — Cap. 18 "34 processos afetados"), disparado_em, destinatarios (JSON) | UNIQUE(falha_tracking_id, incidente_seq) — **ponto 14:** dispara só na transição para a 3ª falha (`contador_consecutivo=3 AND alerta_disparado=false`); 4ª/5ª falha não geram novo alerta porque `alerta_disparado` já é `true`; só um sucesso (zera o contador) seguido de nova sequência até 3 (novo `incidente_seq`) libera um novo disparo. Com o target compartilhado, o alerta **operacional** ao Gestor precisa ser emitido por organização afetada e contar só os processos dela — nunca revelando a uma organização os processos de outra que compartilhe o target; como isso se reflete na unicidade do alerta é detalhe da Fase 6. |
| **AgendamentoConsulta** *(global, por target)* | id, tracking_target_id → TrackingTarget, janela_prevista (DATE), executado_em (TIMESTAMP, nullable), tracking_fetch_id → TrackingFetch (nullable), status (`pendente`\|`executado`\|`pulado_cache`) | UNIQUE(tracking_target_id, janela_prevista) — **ponto 3:** agendado por target, não por contêiner; quando um target alimenta vários contêineres (inclusive de organizações diferentes), uma janela cobre todos de uma vez. A cadência (Cap. 16) usa o estado mais urgente entre os contêineres vinculados ao target (via `ContainerTrackingTarget`) para decidir a próxima janela. |

### Encerramento, responsabilidade, evidências e auditoria — Fase 8/11, não construído na Fase 1

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **Minuta** | id, container_id → Contêiner, data_informada (DATE), numero_contêiner_validado, data_validada (DATE, nullable — vira `effective_return_date`), diverge_do_tracking (BOOLEAN), usuario_id → Usuario, criado_em, estado_conferencia | — |
| **DecisaoResponsabilidade** | id, container_id → Contêiner, data_apta_liberacao (DATE), data_liberacao_efetiva (DATE), intervalo_sugerido_inicio (DATE), intervalo_sugerido_fim (DATE), dias_confirmados_rocket (INTEGER), dias_confirmados_cliente (INTEGER), justificativa, evidencias (JSON), gestor_id → Usuario, decidido_em, estado (`em_analise`\|`confirmada_rocket`\|`confirmada_cliente`\|`dividida`) | — (uma revisão cria novo registro; "vigente" = mais recente por contêiner) |
| **DocumentoEvidencia** *(append-only)* | id, entidade_tipo, entidade_id, tipo, origem, data_inclusao, usuario_id → Usuario, arquivo_ref | — |
| **Auditoria** *(append-only)* | id, entidade_tipo, entidade_id, campo, valor_anterior, valor_novo, usuario_id → Usuario, timestamp, motivo, evidencia_ref (nullable) | — |

### Operação da migração (backfill) — Fase 1, construído nesta etapa

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **BackfillRun** *(operacional — mutável in-place, não append-only; ver nota)* | id, **organization_id** → Organization, executado_em, status (`em_andamento`\|`concluido`), processos_processados (INTEGER), campos_marcados_pendentes (INTEGER), erros (JSONB) | — |
| **BackfillItem** *(append-only, protegido por trigger)* | id, backfill_run_id → BackfillRun, entidade_tipo, entidade_id, resultado (`criado`\|`atualizado`\|`pendencia_marcada`\|`ignorado`\|`erro`), detalhe (JSONB), criado_em | — |

*Nota de refinamento sobre `BackfillRun` (decisão puramente técnica, não altera nenhuma regra aprovada): a revisão 3 marcava `BackfillRun` como append-only, mas seus contadores agregados só existem completos ao final da execução — mantê-lo estritamente append-only forçaria ou (a) uma linha por execução escrita só no fim, perdendo visibilidade de "em andamento", ou (b) um novo registro a cada incremento, o que não é o padrão de uso pretendido. `BackfillRun` passa para a classe **operacional** (como `FalhaTracking`), atualizado in-place; `BackfillItem` continua estritamente append-only — é ele quem carrega a rastreabilidade por item exigida (ponto 12).*

### Operação da migração (shadow) — Fase 9, não construído na Fase 1

| Entidade | Campos principais | Constraints / unique keys |
|---|---|---|
| **ShadowRun** *(append-only)* | id, iniciado_em, finalizado_em (nullable), **engine_version**, processos_comparados (INTEGER), diferencas_encontradas (INTEGER), diferencas_nao_explicadas (INTEGER), status (`em_andamento`\|`concluido`) | — |
| **ShadowDiff** *(append-only)* | id, shadow_run_id → ShadowRun, processo_id → Processo, container_id → Contêiner (nullable), campo, valor_v1, valor_v2, explicada (BOOLEAN), explicacao (nullable), comparado_em | — |

## Relacionamentos (Mermaid)

```mermaid
erDiagram
    Organization ||--o{ OrganizationMembership : concede
    Organization ||--o{ Cliente : contem
    Organization ||--o{ Processo : contem
    Organization ||--o{ CondicaoComercial : contem
    Organization }o--o{ TabelaTarifaria : "privada de (nullable)"
    Usuario ||--o{ OrganizationMembership : participa
    OrganizationMembership }o--o| Cliente : "vinculado (papel CLIENT)"
    OrganizationMembership |o--o{ Processo : "responsável operacional (mesma org, FK composta)"

    Cliente ||--o{ Processo : possui
    Processo ||--o{ Contêiner : agrupa
    Processo }o--o| CondicaoComercial : aplica
    Armador ||--o{ Processo : atende
    Armador ||--o{ TabelaTarifaria : define
    Armador ||--o{ TrackingTarget : identifica
    Armador ||--o{ AlertaTecnico : agrupa

    Contêiner }o--o| ContainerType : classificado_como
    Contêiner ||--o{ Snapshot : versiona
    Contêiner ||--o{ Relogio : cacheia
    Contêiner ||--o{ ValorApurado : apura
    Contêiner ||--o| DecisaoResponsabilidade : "analisa (Fase 11)"
    Contêiner ||--o{ ContainerTrackingTarget : "rastreado por"
    TrackingTarget ||--o{ ContainerTrackingTarget : "alimenta (N:N, global)"

    TrackingTarget ||--o{ TrackingFetch : origina
    TrackingTarget ||--o| FalhaTracking : monitora
    TrackingTarget ||--o{ AgendamentoConsulta : agenda
    TrackingFetch ||--o{ TrackingEvent : retorna

    TabelaTarifaria ||--o{ FaixaTarifaria : contem
    ValorApurado }o--o| ValorApurado : supersedes
    ContainerTypeMapping }o--|| ContainerType : resolve_para
    FalhaTracking ||--o{ AlertaTecnico : dispara

    FieldObservation }o--|| Contêiner : "observa (polimórfico)"
    BackfillRun ||--o{ BackfillItem : detalha
    ShadowRun ||--o{ ShadowDiff : agrupa
```

*(Linhas "polimórfico" = `entidade_tipo`+`entidade_id`, podendo apontar para `Processo` ou `Contêiner`; diagrama simplificado ao caso mais comum. Entidades das Fases 2–9/11 aparecem para mostrar a forma final do modelo, mas só `Organization`, `OrganizationMembership`, `Usuario`, `Armador`, `ContainerType`, `ContainerTypeMapping`, `Cliente`, `CondicaoComercial`, `Processo`, `Contêiner`, `FieldObservation`, `Snapshot`, `BackfillRun` e `BackfillItem` existem fisicamente após a Fase 1.)*

## Classificação das entidades

| Classe | Entidades | Regra |
|---|---|---|
| **Fonte de verdade — global/referência (sem organization_id)** | Usuario, Armador, ContainerType, ContainerTypeMapping, **TrackingTarget** (revisão 5) | Compartilhadas por todas as organizações. `Usuario` é a identidade da pessoa; o vínculo a uma organização e o papel vivem em `OrganizationMembership`. `TrackingTarget` é compartilhado para não duplicar consulta; o acesso de cada organização passa por `ContainerTrackingTarget` → `Contêiner`. |
| **Fonte de verdade — escopada por organização** | Organization (raiz), OrganizationMembership, Cliente, CondicaoComercial, Processo, Contêiner (colunas tipadas), ContainerTrackingTarget (via `container_id`), TabelaTarifaria (organization_id nullable), Minuta, DecisaoResponsabilidade | Mutáveis in-place; `organization_id` direto ou herdado por FK obrigatória, com consistência de organização garantida no Postgres (trigger no lado filho, ou FK composta no caso do responsável operacional). `Cliente`/`Processo` são locais ao módulo (ver nota de investigação), não um cadastro corporativo. |
| **Append-only (histórico imutável, protegido por trigger no Postgres)** | FieldObservation, Snapshot, ValorApurado (exceto a transição de `calculation_status`), TrackingFetch e TrackingEvent (globais, por target), AlertaTecnico, DocumentoEvidencia, Auditoria, BackfillItem, ShadowRun, ShadowDiff | Nunca `UPDATE`/`DELETE` de conteúdo — só `INSERT`, com essa garantia reforçada por *trigger* nas tabelas já implementadas (Fase 1). `ValorApurado` é o único caso com uma transição de status permitida. |
| **Operacional (mutável in-place, controle de execução — não é dado de negócio)** | FalhaTracking e AgendamentoConsulta (globais, por target), **BackfillRun** (aprovado como operacional na revisão 5) | Existem para coordenar scheduler/alertas/backfill, não para registrar fatos do domínio Demurrage em si. |
| **Projeção / cache (descartável)** | Relogio | Nunca é fonte de verdade; recalculável a qualquer momento sem perda de informação. |

## Relatório de entrega — Fase 1: Fundação persistente

### 0. `PRECISA DE SUA VALIDAÇÃO`

**Nenhum item.** Nenhuma regra de negócio, fluxo, estado, fonte de verdade, permissão, cálculo, prioridade, tracking ou estrutura aprovada precisou ser alterada para implementar a Fase 1. Três tensões técnicas apareceram durante a implementação e foram resolvidas com decisões que **preservam** o comportamento aprovado (não o mudam) — documentadas na Seção 8 abaixo para registro, não como bloqueio.

> **Atualização (revisão 5):** depois desta entrega foi identificada uma limitação na garantia multiempresa descrita na Seção 4 — os triggers validam só a escrita da linha filha, não a alteração de `organization_id` de uma linha pai já referenciada. Ver "Relatório de entrega — revisão 5", item `PRECISA DE SUA VALIDAÇÃO`. As decisões 1 e 3 da Seção 8 foram aprovadas pelo responsável do produto na revisão 5.

### 1. Arquivos criados

Todos novos, dentro de `src/demurrage-engine/` (25 arquivos) — nenhum arquivo existente da V1 foi modificado para criá-los:

```
src/demurrage-engine/
├── db/
│   ├── pool.ts                          — conexão PostgreSQL (DEMURRAGE_DATABASE_URL), parser de DATE como string
│   ├── migrate.ts                       — runner de migrations (aplica .sql pendentes, idempotente)
│   └── migrations/
│       ├── 0001_organizations_and_users.sql    — Organization, Usuario, OrganizationMembership
│       ├── 0002_reference_data.sql             — Armador, ContainerType, ContainerTypeMapping (globais)
│       ├── 0003_tenant_core.sql                — Cliente, CondicaoComercial, Processo + triggers de organização
│       ├── 0004_containers_and_observations.sql — Contêiner, FieldObservation, Snapshot + triggers append-only/organização
│       └── 0005_backfill.sql                   — BackfillRun, BackfillItem
├── domain/
│   └── types.ts                         — tipos de domínio (espelham as tabelas da Fase 1) + prioridade de fontes
├── sources/
│   ├── containerDataSource.ts           — porta ContainerDataSource<T> (Cap. 4 do Blueprint)
│   └── emailHeuristicSource.ts          — adaptador de CONTINGÊNCIA sobre demurrageFilters/demurrageParser da V1 (não alterados)
├── persistence/
│   ├── organizationRepository.ts
│   ├── usuarioRepository.ts
│   ├── organizationMembershipRepository.ts
│   ├── clienteRepository.ts
│   ├── processoRepository.ts
│   ├── containerRepository.ts           — inclui applyObservation() (resolução de hierarquia de fontes)
│   ├── fieldObservationRepository.ts
│   ├── snapshotRepository.ts
│   └── backfillRepository.ts
├── backfill/
│   └── runBackfill.ts                   — orquestrador do bootstrap/backfill idempotente
└── __tests__/
    ├── testDb.ts                        — helper de banco de teste (skip automático sem Postgres configurado)
    ├── migrate.test.ts
    ├── multiTenant.test.ts
    ├── fieldObservation.test.ts
    ├── emailHeuristicSource.test.ts
    └── backfill.test.ts
```

### 2. Arquivos existentes modificados (fora da V1)

| Arquivo | Mudança |
|---|---|
| `package.json` | + dependência `pg`, + devDependency `@types/pg`, + scripts `db:migrate:demurrage` e `test:demurrage-engine`. Script `test` original (V1/preAlerta) **não foi tocado**. |
| `package-lock.json` | Atualizado automaticamente pelo `npm install pg`. |
| `.env.example` | + bloco `DEMURRAGE_DATABASE_URL`/`DEMURRAGE_TEST_DATABASE_URL`, documentado como não usado por nenhuma outra parte da aplicação. Nada removido/alterado do que já existia. |
| `docs/demurrage-migration-plan-v1-to-v2.md` | Este documento (revisão 4 + este relatório). |

Nenhum arquivo de `src/demurrage/*`, `src/routes/demurrageRoutes.ts`, `public/Demurrage.dc.html`, `public/PortalCliente.dc.html`, `src/config.ts`, `src/middleware/requireAuth.ts`, `src/index.ts` ou qualquer outro módulo da V1 foi tocado.

### 3. Migrations criadas

5 arquivos `.sql`, aplicados em ordem por `src/demurrage-engine/db/migrate.ts` (transação por arquivo, registrado em `schema_migrations`). Resultado real de execução contra um banco novo (Postgres 16 local):

```
$ npm run db:migrate:demurrage
Migrations aplicadas: 5 [
  '0001_organizations_and_users.sql',
  '0002_reference_data.sql',
  '0003_tenant_core.sql',
  '0004_containers_and_observations.sql',
  '0005_backfill.sql'
]
Já estavam aplicadas: 0

$ npm run db:migrate:demurrage   # segunda execução
Migrations aplicadas: 0 []
Já estavam aplicadas: 5
```

### 4. Schema PostgreSQL final da Fase 1

14 tabelas físicas: `organizations`, `usuarios`, `organization_memberships`, `armadores`, `container_types`, `container_type_mappings`, `clientes`, `condicoes_comerciais`, `processos`, `containers`, `field_observations`, `snapshots`, `backfill_runs`, `backfill_items` (+ `schema_migrations`, controle do runner).

Guardrails implementados como **constraints e triggers reais do Postgres**, não como convenção de código:
- **Multiempresa:** trigger em `processos` (cliente e condição comercial da mesma organização), `containers` (mesma organização do processo), `field_observations` (mesma organização da entidade referenciada, resolvendo `processo`/`container` conforme `entidade_tipo`), `organization_memberships` (cliente da mesma organização quando papel=`CLIENT`). Unicidades escopadas: `UNIQUE(organization_id, numero_processo)`, `UNIQUE(organization_id, usuario_id)` em memberships.
- **Append-only:** função `forbid_mutation()` aplicada via trigger `BEFORE UPDATE OR DELETE` em `field_observations`, `snapshots` e `backfill_items` — `UPDATE`/`DELETE` retornam erro do Postgres, não é só uma convenção respeitada pelo código da aplicação.
- **Proveniência tipada:** `containers` tem os 7 campos críticos (`discharge_date`, `house_free_time_days`, `master_free_time_days`, `gate_out_date`, `tracking_return_date`, `effective_return_date`, `container_type_id`) cada um com sua coluna de ponteiro `*_observation_id` → `field_observations(id)`.
- `gen_random_uuid()` nativo do Postgres 16 (sem extensão `pgcrypto`) para todas as chaves primárias.

Schema completo consultável em `src/demurrage-engine/db/migrations/*.sql` (comentado linha a linha) e na seção "Schema — Fase 1 (revisão 4)" mais acima neste documento.

### 5. Testes executados e resultado

**Ambiente:** PostgreSQL 16.13 local (`priora_demurrage_test`), suíte rodada com `npm run test:demurrage-engine` (`node --test-concurrency=1`, arquivos sequenciais para evitar corrida no banco compartilhado entre eles).

```
$ npm run test:demurrage-engine
# tests 23
# suites 0
# pass 23
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Cobertura por arquivo:
- **`migrate.test.ts`** — aplica as 5 migrations em banco novo; reexecução é no-op; confere as 14 tabelas esperadas.
- **`multiTenant.test.ts`** (6 casos) — mesmo `numero_processo` em organizações diferentes é permitido; duplicado na mesma organização é rejeitado; `Processo` não pode referenciar `Cliente` de outra organização (trigger); `OrganizationMembership` não pode vincular `Cliente` de outra organização (trigger); papel por organização funciona; um usuário não pode ter dois memberships na mesma organização.
- **`fieldObservation.test.ts`** (5 casos) — mais de duas fontes concorrentes para o mesmo campo persistem todas; `UPDATE`/`DELETE` em `field_observations` são rejeitados pelo Postgres; `organization_id` divergente da entidade referenciada é rejeitado (trigger); `manual_fallback` não é rebaixado por uma observação `email_heuristic` posterior de valor diferente; `tracking_service` (maior prioridade) sobrescreve `manual_fallback`.
- **`emailHeuristicSource.test.ts`** (4 casos, sem Postgres) — mapeamento `dataRetirada → gateOutDate` (nunca `dischargeDate` — achado D1 do diagnóstico); campo ausente no e-mail não gera observação; thread sem sinal de demurrage não produz contêiner; thread com sinal forte extrai processo/contêiner via filtro determinístico (sem IA configurada neste ambiente).
- **`backfill.test.ts`** (4 casos) — primeira execução cria processo/cliente/contêiner com os campos observados e conta pendências corretamente; reexecução idêntica não duplica nada (mesma `observado_em` → mesma chave de `field_observations`); hierarquia respeitada durante o backfill (`manual_fallback` pré-existente sobrevive a uma nova observação `email_heuristic` de valor diferente); thread sem número de processo agrupa pelo primeiro contêiner (espelha a regra da V1) e é idempotente numa segunda execução.

**Regressão da V1 (fora do escopo desta fase, verificado por precaução):**
```
$ npm test          # suíte original (src/auditoria/preAlerta)
# tests 25 / pass 25 / fail 0

$ npm run build      # tsc completo, incluindo src/demurrage-engine/
(sem erros)

$ npx tsc --noEmit
(sem erros)
```
Smoke test manual do servidor V1 (`npm run dev` com credenciais fake): `GET /health` → `200`; `GET /` → `200`; `GET /api/demurrage` sem sessão → `401` — idêntico ao comportamento documentado na primeira revisão desta conversa.

### 6. Exemplo de backfill (execução real)

Rodado com um `ContainerDataSource` de teste controlado (para não depender de credenciais reais do Outlook/Gemini neste ambiente) — a mecânica de idempotência e hierarquia é a mesma usada por `emailHeuristicSource` em produção. Duas threads: uma com número de processo (`IM2151`) e campos observados, outra sem número de processo.

```jsonc
// Execução 1 (primeira carga)
{
  "runId": "614b3995-92bc-45a2-a516-bff6646eb957",
  "threadsProcessadas": 2,
  "processosProcessados": 2,
  "containersProcessados": 2,
  "camposMarcadosPendentes": 10,
  "erros": []
}

// Execução 2 (reexecução com as MESMAS threads) — idêntica, nada duplicado
{
  "runId": "98b0d21e-030d-45f7-9d20-ba210aecf384",
  "threadsProcessadas": 2,
  "processosProcessados": 2,
  "containersProcessados": 2,
  "camposMarcadosPendentes": 10,
  "erros": []
}
```

Estado final do contêiner `MSKU1234567` (processo `IM2151`) — note `dischargeDate`, `masterFreeTimeDays` e `trackingReturnDate` permanecendo `null` porque a fonte (e-mail) nunca os informou, exatamente como o ponto 1 da revisão exige ("nada inventado, vira pendência"):

```jsonc
{
  "numero": "MSKU1234567",
  "dischargeDate": null,               // nunca populado por e-mail — pendente até o Tracking Service (Fase 5)
  "dischargeDateObservationId": null,
  "houseFreeTimeDays": 14,
  "houseFreeTimeObservationId": "d6cbdf30-19f5-4a06-a7ad-3607510d447e",
  "masterFreeTimeDays": null,          // pendente — e-mail não é fonte aprovada
  "gateOutDate": "2026-01-10",
  "gateOutObservationId": "4650fb2a-520f-4d76-a1b9-2c98ec678318",
  "trackingReturnDate": null,
  "effectiveReturnDate": null
}
```

`BackfillItem`s da execução 1 (rastreabilidade por item, ponto 12): 2 processos (`criado` para `IM2151`, `pendencia_marcada` para o processo sem número identificado) e 2 contêineres (`criado` para ambos), cada um listando os campos observados e os campos que ficaram pendentes.

### 7. Confirmação: V1 não foi alterada

```
$ git status --short
 M .env.example
 M docs/demurrage-migration-plan-v1-to-v2.md
 M package-lock.json
 M package.json
?? src/demurrage-engine/

$ git diff --stat -- src/demurrage src/routes/demurrageRoutes.ts public/Demurrage.dc.html public/PortalCliente.dc.html
(vazio — nenhuma alteração)
```

`npm test` (suíte V1) e o smoke test manual do servidor confirmam comportamento idêntico ao documentado antes desta fase.

### 8. Decisões técnicas tomadas durante a implementação (não bloqueiam, registradas para transparência)

Nenhuma delas altera regra de negócio, fluxo, cálculo ou fonte de verdade aprovados — são ajustes de integridade/sequenciamento descobertos ao escrever o DDL real:

1. **`Processo.numero_processo` e `Processo.cliente_id` tornados `NULLABLE`.** O schema aprovado listava `cliente_id → Cliente` sem marcar nullability. Ao implementar o backfill contra o caso real (Gemini frequentemente retorna `cliente: null`, e uma thread pode não trazer o número do processo), exigir `NOT NULL` forçaria inventar um Cliente/número placeholder — violando diretamente o princípio já aprovado "nada é inventado, vira pendência" (ponto 1, revisão 2). Tornei ambos nullable, com `UNIQUE(organization_id, numero_processo)` continuando correta (Postgres trata múltiplos `NULL` como não-conflitantes). É a leitura que **preserva** o comportamento aprovado, não uma mudança dele.
2. **Parser de tipo `DATE` do driver `pg` fixado para retornar string, não `Date`.** Por padrão, `node-postgres` converte colunas `DATE` em objetos `Date` JavaScript (à meia-noite UTC) — o que reintroduziria exatamente a ambiguidade de fuso horário que o ponto 10 da revisão 4 ("datas civis, não timestamps") pede para evitar. Registrado `types.setTypeParser(1082, v => v)` em `db/pool.ts`. Sem isso, o requisito aprovado não seria cumprido de fato, apesar do tipo da coluna estar correto.
3. **`BackfillRun` reclassificado de *append-only* (revisão 3) para *operacional*/mutável in-place (revisão 4).** Seus contadores agregados só existem completos ao final da execução; mantê-lo append-only exigiria uma linha só ao final (perdendo visibilidade de "em andamento") ou um novo registro a cada incremento (fora do padrão de uso pretendido). `BackfillItem` continua estritamente append-only — é quem carrega a rastreabilidade por item exigida.
4. **`CondicaoComercial.tabela_id` e `Contêiner.estado/prioridade/motivo_prioridade` deliberadamente ausentes nesta migration** — apontam para entidades/lógica das Fases 4 e 7, que ainda não existem, e entram por `ALTER TABLE` quando essas fases começarem. O vínculo contêiner↔tracking também não existe na Fase 1 e, pelo desenho aprovado na revisão 5, **não** será uma coluna em `Contêiner`: nasce na Fase 5 como a tabela N:N `ContainerTrackingTarget`. Nenhum código da Fase 1 depende de nenhum deles.

### 9. Próximo passo

Fase 1 concluída e testada. **Não avanço para a Fase 2 sem nova autorização**, conforme solicitado.

---

## Relatório de entrega — revisão 5 (migration corretiva da Fase 1 + Fase 2)

### 1. Migration corretiva da Fase 1 e resultado dos testes

`src/demurrage-engine/db/migrations/0006_responsavel_operacional_membership.sql` — aditiva; `0001`–`0005` não foram tocadas.

- Cria a chave candidata `organization_memberships (id, organization_id)` e a coluna `processos.responsavel_operacional_membership_id`.
- A mesma organização é garantida por **FK composta** `(responsavel_operacional_membership_id, organization_id) → organization_memberships (id, organization_id)`. Escolhida em vez de trigger porque vale nos dois sentidos: rejeita um membership de outra organização e também impede mover para outra organização um membership que já é responsável. Responsável `NULL` segue permitido (MATCH SIMPLE).
- Migra registros existentes do vínculo antigo para o membership do mesmo usuário na mesma organização. Se algum vínculo antigo não tiver membership correspondente, a migration **aborta** (rollback completo) em vez de criar um membership — o que seria inventar uma concessão de acesso — ou descartar a atribuição.
- Remove `processos.responsavel_operacional_id` (e sua FK para `usuarios`). Índice parcial `(responsavel_operacional_membership_id, organization_id) WHERE ... IS NOT NULL`.
- Idempotente: além do `schema_migrations`, cada passo checa o estado atual antes de agir.
- Excluir um membership que é responsável fica bloqueado (NO ACTION): o Blueprint não define reatribuição automática, então nenhuma foi inventada.
- O runner ganhou `runMigrations(pool, { until })` para testar a passagem de dados legados entre versões do schema.

Aplicação real no banco de dev, que tinha dados do backfill de demonstração: `Migrations aplicadas: 1 ['0006_...']`, os 2 processos existentes preservados; reexecução: `Migrations aplicadas: 0`.

Testes novos (Postgres real), todos passando:

| Caso | Resultado |
|---|---|
| Membership da mesma organização (criação e atualização) | permitido |
| Membership de outra organização — pelo repositório **e** por SQL direto | rejeitado pelo PostgreSQL (`processos_responsavel_membership_same_org_fk`) |
| Processo sem responsável (criação, e remoção posterior do responsável) | permitido |
| Mover para outra organização um membership que é responsável | rejeitado |
| Excluir um membership que é responsável | bloqueado |
| Coluna antiga `responsavel_operacional_id` | removida |
| Dado legado com membership na mesma organização | migrado; processo sem responsável continua `NULL` |
| Dado legado sem membership na organização do processo | migration aborta, `0006` não consta como aplicada, vínculo antigo intacto |

Suíte da Fase 1 após a correção: **33/33** (as 23 anteriores + 10 novas).

### 2. Arquivos criados na Fase 2

```
src/demurrage-engine/
├── __fixtures__/
│   └── casosOficiais.ts         — fixtures oficiais (criado antes do motor; seções das Fases 3 e 4 reservadas)
├── temporal/
│   ├── civilDate.ts             — data civil 'AAAA-MM-DD': validação e ordinal do dia, só inteiros, sem Date
│   └── freeTimeClock.ts         — o motor temporal
└── __tests__/
    ├── civilDate.test.ts
    └── freeTimeClock.test.ts
```

Nenhum arquivo existente foi alterado pela Fase 2. Nenhuma migration nova (o motor não lê o banco).

### 3. Fixtures oficiais

`casosOficiais.ts` é especificação: não importa nada da implementação, e cada caso cita a regra de origem (capítulo do Blueprint ou decisão aprovada). As datas esperadas foram conferidas, antes de gravadas, contra a aritmética de `DATE` do PostgreSQL como oráculo independente. 19 casos do motor temporal:

- **off-by-one** (T01–T04): a tabela literal do Cap. 23.1.
- **FT 0** (T05–T06).
- **FT ausente** (T07).
- **descarga ausente** (T08–T09) — *adicionado além da lista mínima*: é o caso mais comum hoje (o backfill por e-mail nunca preenche a descarga) e a regra já está no Blueprint (Cap. 31.1: sem descarga, os relógios não são iniciados). Não é regra nova.
- **virada de mês** (T10–T11) e **virada de ano** (T12–T13): um caso em que o free time atravessa a virada e outro em que a contagem de demurrage atravessa.
- **fevereiro** (T14–T15): as mesmas datas de entrada em ano bissexto (2028) e comum (2026), com resultados diferentes.
- **data final anterior à descarga** (T16), mais o limite (T17: data final no dia da descarga é válida).
- **devolução no último dia livre** (T18) e **no primeiro dia de demurrage** (T19), num cenário diferente do T01/T02.

Seções vazias já existentes no arquivo para as fases seguintes: `CASOS_DOIS_RELOGIOS`, `CASOS_MULTIPLOS_CONTEINERES` (Fase 3), `CASOS_FAIXA_TARIFARIA`, `CASOS_TABELAS_PROVISORIAS` (Fase 4), `CASOS_EMPTY_RETURN`, `CASOS_MINUTA`.

### 4. API do `freeTimeClock`

```ts
// src/demurrage-engine/temporal/freeTimeClock.ts
function freeTimeClock(input: FreeTimeClockInput): FreeTimeClockResult

interface FreeTimeClockInput {
  dischargeDate: CivilDate | null; // 'AAAA-MM-DD'; null = sem descarga (relógio não iniciado)
  freeTimeDays: number | null;     // inteiro >= 0; null = ausente (0 é válido e diferente de null)
  finalDate: CivilDate;            // 'AAAA-MM-DD': hoje, ou a data de devolução
}

type FreeTimeClockResult =
  | { status: 'OK'; ultimoDiaLivre: CivilDate; primeiroDiaDemurrage: CivilDate; diasDemurrage: number }
  | { status: 'PENDING'; pendencias: ('DESCARGA_AUSENTE' | 'FREE_TIME_AUSENTE')[] }
  | { status: 'INVALID'; motivo: 'DATA_FINAL_ANTERIOR_A_DESCARGA'; pendencias: ('DESCARGA_AUSENTE' | 'FREE_TIME_AUSENTE')[] };

// src/demurrage-engine/temporal/civilDate.ts
type CivilDate = string;                        // 'AAAA-MM-DD'
function toOrdinal(date: CivilDate): number     // 1 = 0001-01-01; valida formato e existência da data
function fromOrdinal(ordinal: number): CivilDate
```

Situações de negócio (FT ausente, descarga ausente, data final antes da descarga) **retornam** um resultado explícito. Entrada malformada é violação de contrato e **lança erro**: `Date` do JavaScript ou timestamp no lugar de data civil, data inexistente (ex.: 29/02 em ano comum), FT negativo ou não inteiro, campo omitido em vez de `null`, e qualquer campo extra — em especial `gateOutDate`: o motor recusa a entrada, o que torna "nada é inferido do Gate Out" uma garantia da API, não só uma convenção.

### 5. Casos testados — entrada → esperado → real

A coluna "Real" foi gerada executando o motor sobre cada fixture, não copiada do esperado.

| # | Categoria | Entrada (descarga · FT · data final) | Esperado | Real | ✓ |
|---|---|---|---|---|---|
| T01 | off-by-one | 2026-09-01 · 14 · 2026-09-14 | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **0 d** | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **0 d** | ✅ |
| T02 | off-by-one | 2026-09-01 · 14 · 2026-09-15 | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **1 d** | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **1 d** | ✅ |
| T03 | off-by-one | 2026-09-01 · 14 · 2026-09-16 | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **2 d** | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **2 d** | ✅ |
| T04 | off-by-one | 2026-09-01 · 14 · 2026-09-20 | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **6 d** | OK · último livre 2026-09-14 · 1º demurrage 2026-09-15 · **6 d** | ✅ |
| T05 | ft-zero | 2026-09-01 · 0 · 2026-09-01 | OK · último livre 2026-08-31 · 1º demurrage 2026-09-01 · **1 d** | OK · último livre 2026-08-31 · 1º demurrage 2026-09-01 · **1 d** | ✅ |
| T06 | ft-zero | 2026-09-01 · 0 · 2026-09-03 | OK · último livre 2026-08-31 · 1º demurrage 2026-09-01 · **3 d** | OK · último livre 2026-08-31 · 1º demurrage 2026-09-01 · **3 d** | ✅ |
| T07 | ft-ausente | 2026-09-01 · null · 2026-09-20 | PENDING [FREE_TIME_AUSENTE] | PENDING [FREE_TIME_AUSENTE] | ✅ |
| T08 | descarga-ausente | null · 14 · 2026-09-20 | PENDING [DESCARGA_AUSENTE] | PENDING [DESCARGA_AUSENTE] | ✅ |
| T09 | descarga-ausente | null · null · 2026-09-20 | PENDING [DESCARGA_AUSENTE, FREE_TIME_AUSENTE] | PENDING [DESCARGA_AUSENTE, FREE_TIME_AUSENTE] | ✅ |
| T10 | virada-de-mes | 2026-09-25 · 10 · 2026-10-07 | OK · último livre 2026-10-04 · 1º demurrage 2026-10-05 · **3 d** | OK · último livre 2026-10-04 · 1º demurrage 2026-10-05 · **3 d** | ✅ |
| T11 | virada-de-mes | 2026-09-20 · 7 · 2026-10-03 | OK · último livre 2026-09-26 · 1º demurrage 2026-09-27 · **7 d** | OK · último livre 2026-09-26 · 1º demurrage 2026-09-27 · **7 d** | ✅ |
| T12 | virada-de-ano | 2026-12-28 · 10 · 2027-01-10 | OK · último livre 2027-01-06 · 1º demurrage 2027-01-07 · **4 d** | OK · último livre 2027-01-06 · 1º demurrage 2027-01-07 · **4 d** | ✅ |
| T13 | virada-de-ano | 2026-12-20 · 7 · 2027-01-02 | OK · último livre 2026-12-26 · 1º demurrage 2026-12-27 · **7 d** | OK · último livre 2026-12-26 · 1º demurrage 2026-12-27 · **7 d** | ✅ |
| T14 | fevereiro | 2028-02-10 · 20 · 2028-03-05 | OK · último livre 2028-02-29 · 1º demurrage 2028-03-01 · **5 d** | OK · último livre 2028-02-29 · 1º demurrage 2028-03-01 · **5 d** | ✅ |
| T15 | fevereiro | 2026-02-10 · 20 · 2026-03-05 | OK · último livre 2026-03-01 · 1º demurrage 2026-03-02 · **4 d** | OK · último livre 2026-03-01 · 1º demurrage 2026-03-02 · **4 d** | ✅ |
| T16 | data-final-anterior-a-descarga | 2026-09-10 · 14 · 2026-09-05 | INVALID DATA_FINAL_ANTERIOR_A_DESCARGA | INVALID DATA_FINAL_ANTERIOR_A_DESCARGA | ✅ |
| T17 | data-final-anterior-a-descarga | 2026-09-10 · 14 · 2026-09-10 | OK · último livre 2026-09-23 · 1º demurrage 2026-09-24 · **0 d** | OK · último livre 2026-09-23 · 1º demurrage 2026-09-24 · **0 d** | ✅ |
| T18 | devolucao-ultimo-dia-livre | 2026-10-10 · 7 · 2026-10-16 | OK · último livre 2026-10-16 · 1º demurrage 2026-10-17 · **0 d** | OK · último livre 2026-10-16 · 1º demurrage 2026-10-17 · **0 d** | ✅ |
| T19 | devolucao-primeiro-dia-demurrage | 2026-10-10 · 7 · 2026-10-17 | OK · último livre 2026-10-16 · 1º demurrage 2026-10-17 · **1 d** | OK · último livre 2026-10-16 · 1º demurrage 2026-10-17 · **1 d** | ✅ |

19/19 iguais. Sobre o T05/T06: com FT 0, a fórmula do Blueprint (último dia livre = descarga + N − 1) dá a véspera da descarga — ou seja, não existe dia livre. O motor aplica a fórmula literalmente; como a tela e o Portal exibem "último dia livre" quando FT é 0 é decisão de apresentação das Fases 9/12.

### 6. Quantidade de testes e resultado

| Suíte | Resultado |
|---|---|
| `npm run test:demurrage-engine` com Postgres | **69/69** — Fase 1: 33 (23 anteriores + 10 da migration 0006); Fase 2: 36 (5 de `civilDate`, 31 de `freeTimeClock`) |
| `npm run test:demurrage-engine` sem banco configurado | 40 passam, 6 suítes de integração puladas, 0 falhas — o motor da Fase 2 não precisa de banco |
| `npm test` (V1) | 25/25 |
| `tsc --noEmit` e `npm run build` | sem erros |

Os 31 testes de `freeTimeClock` são: um por fixture (19); cobertura das categorias exigidas e integridade da tabela literal do Cap. 23.1; FT 0 ≠ FT ausente; propriedade "nunca negativo, +1 por dia corrido" varrendo 91 datas finais para 5 valores de FT atravessando uma virada de ano; determinismo; contrato de entrada (sem `Date`, sem timestamp, sem Gate Out, ausência declarada com `null`, FT inteiro ≥ 0); pureza (o código do motor só importa arquivos do próprio diretório e não usa `Date` nem relógio do sistema); e o comportamento provisório do item 8(b). Os de `civilDate` conferem o calendário dia a dia de 1900 a 2100 (73.414 dias) contra um calendário de referência independente, incluindo as regras de século (1900 e 2100 não bissextos, 2000 bissexto).

**Os testes realmente pegam erro:** três bugs injetados de propósito numa cópia do motor — o off-by-one da V1 (sem o dia inclusivo), FT ausente tratado como zero, e sem a checagem de data final antes da descarga — foram pegos por 13, 2 e 3 testes, respectivamente. O arquivo original foi restaurado byte a byte depois.

### 7. V1 intacta

`git diff --stat` de `src/demurrage/`, `src/routes/demurrageRoutes.ts`, `public/Demurrage.dc.html` e `public/PortalCliente.dc.html` está vazio tanto contra o último commit quanto contra `48ba7c1`, o estado anterior a todo o trabalho da V2. `src/config.ts`, `src/index.ts` e `src/middleware/` também não foram tocados. `npm test` 25/25.

### 8. `PRECISA DE SUA VALIDAÇÃO`

**(a) Limitação na garantia multiempresa da Fase 1 — encontrada nesta revisão.**
1. *O que foi encontrado:* os triggers de consistência de organização das migrations 0003/0004 validam só a escrita da linha **filha**. Alterar o `organization_id` de uma linha **pai** que já é referenciada não é verificado. Reproduzido no banco de teste, em transações desfeitas, por dois caminhos: um `Processo` da organização A passou a referenciar um `Cliente` movido para a organização B; e um `Processo` movido para B deixou seu `Contêiner` registrado em A — ambos sem nenhum erro. Isso vale para `clientes` (referenciado por `processos` e `organization_memberships`), `condicoes_comerciais` (por `processos`), `processos` (por `containers` e `field_observations`) e `containers` (por `field_observations` e `snapshots`). Declarei na entrega da Fase 1 que os triggers impediam a associação entre organizações; a afirmação estava incompleta.
2. *Por que é um problema:* contraria diretamente a decisão final #1 ("não permita que dados de uma organização sejam associados acidentalmente a registros pertencentes a outra"). Não há exposição hoje: nenhum código da aplicação altera `organization_id`, e não há dados reais. A migration 0006 não tem esse problema (a FK composta cobre os dois sentidos).
3. *Alternativas:*
   - **A — `organization_id` imutável** em toda tabela de tenant: um trigger genérico `BEFORE UPDATE` que rejeita a alteração, numa migration aditiva `0007`. Fecha todos os caminhos de uma vez, inclusive o polimórfico de `field_observations`.
   - **B — FKs compostas** (como a da 0006) para as referências não polimórficas, mais A só nas tabelas com referência polimórfica. Mais declarativo, mais migração.
   - **C — triggers também no lado pai**, verificando os filhos quando o `organization_id` muda. Permite mover um pai sem filhos; é o que mais código exige.
4. *Impactos:* A torna impossível mover um registro de uma organização para outra (a correção passa a ser recriá-lo) — o Blueprint nunca prevê essa operação. B tem o mesmo efeito prático para os registros referenciados e toca mais tabelas. C preserva a possibilidade de mover registros sem filhos, ao custo de mais lógica em trigger.
5. *Recomendação:* **A**, antes da Fase 5 (a primeira a escrever dados reais em volume). Não bloqueia a Fase 3, que é um motor puro como a Fase 2.

**(b) Precedência quando FT está ausente e a data final é anterior à descarga.**
O Blueprint e a revisão 5 definem cada condição isoladamente (FT ausente → `PENDING`; data final antes da descarga → inválido), mas não a combinação. Hoje o motor devolve `INVALID` com `pendencias: ['FREE_TIME_AUSENTE']` — nenhuma informação se perde e uma inconsistência de datas não fica escondida atrás de um "pendente". A alternativa é devolver `PENDING`. Recomendo manter como está. O caso está num teste marcado como PROVISÓRIO, fora das fixtures oficiais, até a decisão. Não bloqueia.

**(c) Papel do responsável operacional.**
Hoje o banco aceita como responsável qualquer membership da mesma organização, inclusive de papel `CLIENT`. O Blueprint não restringe explicitamente, mas trata o responsável operacional como alguém da operação da Rocket (Cap. 28.7, 29.1, 30.1). Restringir a `ANALYST`/`MANAGER`/`ADMIN` seria regra nova, então não foi implementado. Se aprovado, exige um trigger (o papel vive no membership) cobrindo também a troca de papel de um membership que já é responsável. Não bloqueia.

### 9. Próximo passo

Fase 2 concluída. **Não avanço para a Fase 3 sem autorização.**

---

## Relatório de entrega — revisão 6 (migrations 0007/0008 + Fase 3: dois relógios)

**Escopo autorizado:** DECISÕES 1–3 (migration `0007`) e a Fase 3 — Dois relógios House × Master, com o cache `relogios` (migration `0008`). Nada de tarifa, valor financeiro, Tracking Service, scheduler, estados/prioridade operacional, Empty Return, minuta ou frontend foi tocado. V1 intacta.

### 1. Migration `0007_org_imutavel_e_responsavel_interno.sql` (DECISÕES 1 e 3)

Aditiva; 0001–0006 não foram reescritas.

- **DECISÃO 1 — `organization_id` imutável.** Uma única função `forbid_organization_change()` é reutilizada por um trigger `organization_id_immutable` em cada uma das 8 tabelas de tenant (`organization_memberships`, `clientes`, `condicoes_comerciais`, `processos`, `containers`, `field_observations`, `snapshots`, `backfill_runs`). O trigger é `BEFORE UPDATE ... WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)` — dispara só quando a organização muda, então UPDATEs comuns na mesma organização não pagam nada. Fecha o buraco da linha pai relatado na revisão 5 (alternativa **A**, recomendada e aprovada). **Convenção padrão:** toda tabela de tenant futura com `organization_id` recebe o mesmo trigger, salvo decisão funcional explícita; um teste de catálogo verifica isso.
- **DECISÃO 3 — responsável operacional só com papel interno.** Garantido nos dois sentidos: (1) `check_processo_responsavel_interno()` (`BEFORE INSERT OR UPDATE OF responsavel_operacional_membership_id`) rejeita atribuir um membership `CLIENT`; (2) `check_membership_responsavel_nao_vira_client()` (`BEFORE UPDATE OF papel`, `WHEN NEW.papel = 'CLIENT'`) rejeita rebaixar a `CLIENT` um membership que é responsável por algum processo enquanto estiver atribuído. Responsável `NULL` continua válido; não há reatribuição automática. A leitura do papel no trigger do processo usa `FOR SHARE`, serializando com o UPDATE do membership (a segunda operação sempre enxerga a primeira). A migration **aborta** se já existir processo com responsável `CLIENT` (não reclassifica em silêncio).

### 2. Migration `0008_relogios.sql` (cache dos dois relógios)

Aditiva. Cria `relogios` como **projeção/cache puro**, nunca fonte de verdade:

- Colunas: `id`, `container_id` (FK `ON DELETE CASCADE`), `tipo` (`cliente`\|`rocket`), `estado` (`OK`\|`PENDING`\|`INVALID`), `ultimo_dia_livre`, `primeiro_dia_demurrage`, `data_final_apuracao` (NOT NULL — é entrada, não resultado), `dias_demurrage` (`>= 0`), `pendencias` (TEXT[]), `motivo`, `calculated_at`, `engine_version`, `input_hash`. `UNIQUE(container_id, tipo)`.
- `CONSTRAINT relogios_forma_por_estado`: a forma da linha tem que ser coerente com o estado (OK exige as três datas/o número e nenhuma pendência/motivo; PENDING exige pendência e nenhuma data; INVALID exige motivo e nenhuma data). O cache não consegue guardar um "OK sem dias" nem um "PENDING com data de demurrage".
- **Regenerável por definição:** cada linha sai de (descarga do contêiner, free time do relógio, data final, versão do motor). O `input_hash` (SHA-256 de `[engineVersion, tipo, dischargeDate, freeTimeDays, finalDate]`, em `domain/clock.ts`) resume todas essas entradas; hash gravado ≠ hash recalculado das entradas atuais ⇒ cache obsoleto.
- **Sem edição manual:** trigger `relogios_somente_recalculador` (`BEFORE INSERT OR UPDATE`) exige `current_setting('demurrage.relogio_writer', true) = 'dualClockCalculator'`. Só o `RelogioRepository.recalcular` liga esse `SET LOCAL` (dentro de transação). `DELETE` é livre — apagar só força a regeneração.

### 3. Resultado dos testes

Suíte da engine (Postgres real): **117/117 verde** (era 87 antes da Fase 3; +3 do `migration0007`, +~17 do `dualClockCalculator`, +7 do `relogios`, +1 fixture T20). `tsc --noEmit` limpo; `npm run build` limpo. Suíte original da V1 (`npm test`): **25/25 verde**. Comando: `DEMURRAGE_TEST_DATABASE_URL=... npm run test:demurrage-engine`.

- `migration0007.test.ts`: imutabilidade de organização nas 8 tabelas (rejeição na configuração real **e** provada isoladamente pelo próprio trigger, com os demais desligados numa transação desfeita); catálogo garantindo que toda tabela com `organization_id` tem o trigger; updates comuns na mesma organização continuam permitidos; responsável interno nos dois sentidos; abort se já houver responsável `CLIENT`.
- `dualClockCalculator.test.ts`: um teste por caso das fixtures A–K e do processo misto; equivalência relógio-a-relógio com `freeTimeClock` (nenhuma fórmula duplicada); independência entre relógios e entre contêineres; contrato de entrada.
- `relogios.test.ts`: projeção bate com a fixture; `input_hash` muda com o FT (e com a data final) ⇒ `OBSOLETO` até recalcular; escrita manual barrada; `DELETE`+regeneração; `UNIQUE(container_id,tipo)`; independência no cache.

### 4. Fixtures oficiais da Fase 3

Preenchidas **antes** do motor, em `src/demurrage-engine/__fixtures__/casosOficiais.ts`, conferidas contra a aritmética de `DATE` do PostgreSQL:

- `CASOS_DOIS_RELOGIOS` — grupos **A** (House < Master), **B** (House > Master), **C** (iguais), **D** (House FT ausente), **E** (Master FT ausente), **F** (os dois ausentes), **G** (House FT 0), **H** (Master FT 0), **J** (data final antes da descarga → os dois `INVALID`, DECISÃO 2), **K** (descarga ausente → os dois `PENDING` por descarga).
- `CASOS_MULTIPLOS_CONTEINERES` — um processo com 4 contêineres em estados distintos, apurados na mesma data (`2026-09-22`).
- Fixture **T20** (motor temporal): DECISÃO 2 promovida de teste provisório a fixture oficial (categoria `data-final-anterior-a-descarga`): `descarga 2026-09-10, FT null, final 2026-09-05` → `INVALID` com `pendencias: ['FREE_TIME_AUSENTE']`. O teste "PROVISÓRIO" foi removido.

### 5. Tabela House × Master (esperado × real)

Descarga `2026-09-01` salvo indicado. "Real" = saída do `dualClockCalculator` verificada pelos testes; bate com "esperado" em 100% dos casos.

| Caso | House FT | Master FT | Data final | Cliente (House) esperado=real | Rocket (Master) esperado=real |
|---|---|---|---|---|---|
| R-A1 | 14 | 21 | 15/09 | OK, 1 dia (últ. livre 14/09) | OK, 0 dia (últ. livre 21/09) |
| R-A2 | 14 | 21 | 21/09 | OK, 7 dias | OK, 0 dia |
| R-A3 | 14 | 21 | 22/09 | OK, 8 dias | OK, 1 dia |
| R-B1 | 21 | 14 | 15/09 | OK, 0 dia | OK, 1 dia |
| R-B3 | 21 | 14 | 22/09 | OK, 1 dia | OK, 8 dias |
| R-C1 | 14 | 14 | 15/09 | OK, 1 dia | OK, 1 dia |
| R-D1 | ausente | 21 | 25/09 | **PENDING** [FREE_TIME_AUSENTE] | OK, 4 dias |
| R-E1 | 14 | ausente | 25/09 | OK, 11 dias | **PENDING** [FREE_TIME_AUSENTE] |
| R-F1 | ausente | ausente | 20/09 | PENDING [FREE_TIME_AUSENTE] | PENDING [FREE_TIME_AUSENTE] |
| R-G1 | 0 | 14 | 10/09 | OK, 10 dias (1º dem. 01/09) | OK, 0 dia |
| R-H1 | 14 | 0 | 10/09 | OK, 0 dia | OK, 10 dias (1º dem. 01/09) |
| R-J1 | ausente | 14 | 05/09 (desc. 10/09) | **INVALID** [FREE_TIME_AUSENTE] | **INVALID** [] |
| R-K1 | 14 | 21 | 20/09 (desc. ausente) | PENDING [DESCARGA_AUSENTE] | PENDING [DESCARGA_AUSENTE] |

### 6. `input_hash` antes/depois de uma mudança de free time

Relógio do Cliente, descarga `2026-09-01`, data final `2026-09-22`, `engine_version = temporal-1.0.0`:

```
FT House = 14  →  69fa32521a7c649867263ec568040e59b4143af3f7374dd94bd96c94b13aec63
FT House =  7  →  36b6e764d5375f43a519568602cc62e0cb691564948b201d7e0393d74332c6ec   (FT mudou → hash muda → cache OBSOLETO)
final 23/09    →  9a1ba6963d68f9fc5dfc928639dad0660eaf369833363c8265890bc25efefbdd   (data final mudou → hash muda)
tipo = rocket  →  a331df2fba4a4bfd1115b6e3499890a324f0dce8e90f5ff02b30fc76dd9feddb   (mesmo FT/datas, outro relógio → hash distinto)
```

O `relogios.test.ts` prova o efeito ponta a ponta: gravado o cache com FT 14, uma observação nova baixa o FT House para 7; `buscarValido(...,'cliente',...)` passa a devolver `OBSOLETO` (o relógio Rocket, cujo Master não mudou, segue `VALIDO` — os hashes são por relógio); `recalcular` reconcilia com um `input_hash` novo, na **mesma** linha `(container, tipo)` (upsert).

### 7. Prova de que um relógio pendente/inválido não bloqueia o outro

- **R-D1 / R-E1:** com um dos free times ausente, aquele relógio é `PENDING` e o outro calcula normalmente (4 e 11 dias, respectivamente). Sem "status geral" — o resultado é sempre o par `{cliente, rocket}`, cada um com seu status.
- **R-J1:** data final antes da descarga com House ausente → os dois `INVALID`, mas cada um preserva a **sua** pendência (cliente lista `FREE_TIME_AUSENTE`, rocket lista `[]`). O `dualClockCalculator` chama o `freeTimeClock` duas vezes de forma independente; um lado nunca contamina o outro. Teste dedicado: `dualClockCalculator.test.ts` → "um relógio INVALID não bloqueia o outro, e não há 'status geral'".

### 8. Prova de independência entre contêineres

Fixture `I-processo-misto` (4 contêineres, data final `2026-09-22`), esperado = real:

| Contêiner | Descarga | House | Master | Cliente | Rocket |
|---|---|---|---|---|---|
| MSKU0000001 | 01/09 | 14 | 21 | OK, 8 dias | OK, 1 dia |
| MSKU0000002 | 05/09 | 14 | 21 | OK, 4 dias | OK, 0 dia |
| MSKU0000003 | 10/09 | ausente | 7 | PENDING [FREE_TIME_AUSENTE] | OK, 6 dias |
| MSKU0000004 | ausente | 14 | 21 | PENDING [DESCARGA_AUSENTE] | PENDING [DESCARGA_AUSENTE] |

Um contêiner devolvido/pendente não altera os demais. Dois testes fixam isso: no motor puro, permutar a ordem de cálculo não muda nenhum resultado; no cache, recalcular um contêiner não toca a linha de outro (contêiner com descarga ausente fica `PENDING` enquanto o vizinho segue `OK, 8 dias`).

### 9. V1 intacta

`git diff` de `src/demurrage/`, `src/routes/demurrageRoutes.ts`, `public/Demurrage.dc.html` e `public/PortalCliente.dc.html` contra o commit-base `48ba7c1`: **vazio**. Rota `GET /api/demurrage` e portais não tocados. Toda a Fase 3 vive em `src/demurrage-engine/` (mais o cache 0008), fora do caminho da V1.

### 10. PRECISA DE SUA VALIDAÇÃO

**Valores de `estado` do `Relogio`: `OK`\|`PENDING`\|`INVALID` (implementado) × `aberto`\|`fechado`\|`pendente` (revisão 3).**
1. *O que foi encontrado:* a revisão 3 registrou o enum de `Relogio.estado` como `aberto`\|`fechado`\|`pendente`. Mas o `Relogio` é cache puro do `FreeTimeClockResult`, cujo status é `OK`\|`PENDING`\|`INVALID`. Em particular, `INVALID` (data final anterior à descarga, DECISÃO 2) não cabe em nenhum dos três antigos, e `aberto`/`fechado` (relógio em curso × encerrado) é uma noção **operacional de ciclo de vida**, não uma noção do motor temporal — e o ciclo de vida do contêiner é a Fase 7/8, fora deste escopo.
2. *Por que decidi assim:* como o cache tem que espelhar 1-para-1 o resultado do motor (para ser regenerável e comparável por hash), usei os três status do motor. `aberto`/`fechado` seriam derivados depois, na camada de estados (Fase 7), a partir de `effective_return_date` — não do relógio.
3. *Alternativas:* (A) manter `OK`\|`PENDING`\|`INVALID` no cache, como está, e deixar `aberto`/`fechado` para a máquina de estados da Fase 7; (B) renomear para um terceiro vocabulário; (C) voltar a `aberto`\|`fechado`\|`pendente` — mas então `INVALID` não teria representação e o cache deixaria de espelhar o motor.
4. *Impacto:* recomendo **(A)**. É a única que preserva a DECISÃO 2 e a regenerabilidade por hash sem misturar ciclo de vida operacional no cache do motor. Se preferir outro vocabulário, é uma migration aditiva simples (novo `CHECK`), sem perda de dado (o cache é descartável). Não bloqueia a Fase 4.

Nenhum outro ponto exigiu decisão nova: DECISÕES 1–3 e a Fase 3 couberam no que já estava aprovado. As regras não definidas pelo Blueprint viraram pendência/`INVALID` explícito, nunca um valor inventado.

### 11. Próximo passo

Fase 3 concluída. **Não avanço para a Fase 4 sem nova autorização.**

---

## Relatório de entrega — revisão 7 (migration 0009 + Fase 4: motor tarifário)

**Escopo autorizado:** Fase 4 — motor tarifário e versionamento. Entregue a INFRAESTRUTURA completa dos três motores comerciais + o Termo por Embarque com os valores reais do Blueprint. Termo Único e as 12 tabelas de armador aguardam os números literais (ver item 11). Nada de Tracking real, scheduler, prioridade, Empty Return, minuta, frontend, responsabilidade Rocket×cliente ou faturamento foi tocado. V1 intacta.

### 1. Migration criada — `0009_tariffs.sql` (aditiva; 0001–0008 preservadas)

- `tariff_tables` (TabelaTarifaria): versionada e histórica; `organization_id` nullable (NULL = pública de armador, preenchido = privada Rocket×cliente); `tipo`, `armador_id`, `termo_comercial`, `versao`, `vigencia_inicio/fim`, `qualidade_fonte`, **`day_count_basis` explícito** (`since_discharge_absolute` | `excess_over_free_time`), `fonte`. `CHECK` de coerência tipo×instrumento; `UNIQUE(organization_id, tipo, armador_id, termo_comercial, versao)` + índice único parcial para as públicas de armador; **trigger `organization_id_immutable`** (convenção da DECISÃO 1).
- `tariff_brackets` (FaixaTarifaria): `tipo_equipamento`, `dia_inicial`, `dia_final` (NULL = aberta), `valor_dia`, `moeda`; `UNIQUE(tariff_table_id, tipo_equipamento, dia_inicial)`.
- `valores_apurados` (ValorApurado): a memória de cálculo completa (container, relógio, motor, tabela+versão, `day_count_basis_aplicada`, período, dias, `faixas_aplicadas` JSONB, total, moeda, `confirmation_status`, `calculation_status`, `engine_version`, `input_hash`, `supersedes_id`). Índice parcial único garante **no máximo um ativo** (OPEN/FINAL) por (container, relógio, motor). Trigger `valores_apurados_append_only`: sem DELETE; no UPDATE só a transição de `calculation_status` (para frente) e a confirmação de custo real; `CHECK` de que CONFIRMED exige `custo_real_confirmado_ref`.
- `condicoes_comerciais.tabela_id` (vínculo condição→tabela Rocket) com trigger de mesma organização + mesmo termo.

### 2. Tabelas/versões seedadas

- **Global (na migration):** 12 classes de equipamento em `container_types` (`20DV/40DV/20HC/40HC/20OT/40OT/20FR/40FR/20NOR/40NOR/20RE/40RE`) — o vocabulário que as tarifas usam, não uma tabela de equivalências ISO (essa o Blueprint deixa como pendência dele mesmo).
- **Por organização (módulo de seed `tariffs/seed/rocketTermoPorEmbarque.ts`):** tabela Rocket×cliente do Termo por Embarque, valores LITERAIS do Blueprint Cap. 24.1 (`20DV/HC=150`, `40DV/HC=250`, `20OT=230`, `40OT=300`, `20FR=230`, `40FR=300`, `20NOR=275`, `40NOR=400`, `20RE=450`, `40RE=600` USD/dia), `day_count_basis=since_discharge_absolute`, `qualidade_fonte=OFICIAL_VALIDADA`. Uma faixa aberta [1,∞) por equipamento (tarifa fixa por dia).

### 3. Fixtures oficiais da Fase 4

`CASOS_TERMO_POR_EMBARQUE` (valores reais): E01–E06. `CASOS_FAIXA_TARIFARIA` e `CASOS_TABELAS_PROVISORIAS` seguem vazias por **pendência de dados** (números do Termo Único e das tabelas de armador — item 11). O mecanismo é coberto por testes com tabelas **sintéticas rotuladas** (não são valores do Blueprint), incluindo o exemplo conceitual que você deu (faixas 7–9/10+, FT até o dia 21).

### 4. Implementação dos três motores (separados, infra comum)

- `tariffs/bracketEngine.ts` — infra comum (posiciona o dia na faixa por `day_count_basis`; buraco → UNAVAILABLE). Usada por Termo Único e Exposição Rocket, **nunca** pelo Termo por Embarque.
- `tariffs/engines/termoPorEmbarqueEngine.ts` — tarifa fixa: `dias × diária Rocket`, sem faixa, `day_count_basis_aplicada=null`.
- `tariffs/engines/termoUnicoEngine.ts` — faixas da tabela Rocket do Termo Único; versão selecionada pelo 1º dia de demurrage do cliente (no repositório).
- `tariffs/engines/exposicaoRocketEngine.ts` — Master FT + tabela do armador, independente do cliente; nunca CONFIRMED.
- `domain/containerType.ts` (normalização sem fuzzy), `domain/valorApurado.ts` (input_hash), `persistence/tariffTableRepository.ts` (seleção por vigência), `persistence/valorApuradoRepository.ts` (supersede + idempotência por hash).

### 5. Tabela esperado × real (Termo por Embarque, valores reais)

| Fixture | Equipamento | Dias cliente | Esperado | Real |
|---|---|---|---|---|
| E01 | 20DV | 8 | OK 1200 USD (150/dia) | OK 1200 USD |
| E02 | 40HC | 8 | OK 2000 USD (250/dia) | OK 2000 USD |
| E03 | 20RE | 3 | OK 1350 USD (450/dia) | OK 1350 USD |
| E04 | 40NOR | 10 | OK 4000 USD (400/dia) | OK 4000 USD |
| E05 | 20DV | 0 | OK 0 USD | OK 0 USD |
| E06 | não reconhecido | 8 | UNAVAILABLE | UNAVAILABLE |

Mecanismo de faixa (tabela sintética 1–6@100 / 7–14@200 / 15+@300, base `since_discharge_absolute`, FT 5, 12 dias): esperado 2600 = 1×100 + 8×200 + 3×300; real 2600, `faixas_aplicadas` `[{1–6,100,1},{7–14,200,8},{15+,300,3}]`. Exemplo conceitual (7–9/10+, FT 21, 1 dia): a 1ª diária cai em 10+ (300), não volta para 7–9. Sob base `excess_over_free_time`, o mesmo caso dá UNAVAILABLE (1º dia excedente = dia 1, fora das faixas) — provando que a semântica vem da tabela, nunca é inferida.

### 6. Exemplo completo de `ValorApurado`

Termo por Embarque, 20DV, 8 dias:
```json
{
  "motorComercial": "termo_embarque", "relogioTipo": "cliente",
  "tabelaId": "<uuid-rocket>", "versaoTabela": 1, "dayCountBasisAplicada": null,
  "confirmationStatus": "ESTIMATED", "calculationStatus": "OPEN",
  "total": 1200, "moeda": "USD", "diasCobrados": 8,
  "faixasAplicadas": [{ "diaInicial": 1, "diaFinal": null, "valorDia": 150, "dias": 8 }],
  "engineVersion": "tariff-1.0.0", "supersedesId": null
}
```
`input_hash` (muda quando um input muda): 8 dias → `9e8a7206…`; 10 dias / final 24/09 → `479e40b6…`.

### 7. Prova de versionamento histórico

Seed v1 (Blueprint, vigência até 30/06) e v2 (sintética, a partir de 01/07): `selecionarVigente` na data de referência devolve v1 (150) para 10/05 e v2 (160) para 10/08. Ao recalcular com input diferente, o `ValorApurado` anterior vira `SUPERSEDED` (preservado, com seu próprio `total`/`versao_tabela`) e nasce um novo OPEN com `supersedes_id` apontando para ele; o índice parcial garante um único ativo. Idempotência: registrar os mesmos inputs de novo não cria linha (`efeito: inalterado`).

### 8. Prova de `UNAVAILABLE` sem aproximação

Tabela sintética com buraco (1–6 e 15+, sem 7–14): o dia 7 não tem faixa → o cálculo inteiro é `UNAVAILABLE` (nunca cai na faixa vizinha). Equipamento não reconhecido → `UNAVAILABLE` (bloqueia só a tarifa; o relógio segue vivo). Uma tabela `OFICIAL_VALIDADA`/`OFICIAL_NAO_VALIDADA` **não** vira `CONFIRMED` sozinha; `CONFIRMED` só com `custo_real_confirmado_ref` (barrado por `CHECK` no banco).

### 9. Prova de independência cobrança do cliente × exposição Rocket

No mesmo contêiner coexistem dois `ValorApurado`: `termo_embarque`/`cliente` (1200 USD, tabela Rocket) e `exposicao_armador`/`rocket` (270 USD, tabela de armador sintética) — motores, tabelas e relógios distintos, nenhum lê o outro. Dois contêineres do mesmo processo com equipamentos diferentes (20DV → 1200, 40HC → 2000) apurados independentemente.

### 10. Testes totais e regressão da V1

Suíte da engine: **137/137 verde** (era 117; +20 da Fase 4). `tsc --noEmit` limpo; `npm run build` limpo. Suíte original da V1: **25/25 verde**. V1 intacta: `git diff` de `src/demurrage/*`, `demurrageRoutes.ts` e os portais contra `48ba7c1` = vazio.

### 11. PENDÊNCIA DE DADOS / PRECISA DE SUA VALIDAÇÃO

**Faltam os números literais do Blueprint para completar a Fase 4** (a regra proíbe inventá-los):
1. **Tabela Rocket do Termo Único** (Cap. 24.2): por equipamento — faixas (`dia_inicial`/`dia_final`|aberto), `valor/dia`, moeda, vigência, `day_count_basis`; e ao menos duas versões para as fixtures de mudança de versão.
2. **As 12 tabelas de armador** (Cap. 24.3.1): por tabela — faixas por equipamento, moeda, `day_count_basis`, `qualidade_fonte`, vigência; quais estão incompletas e onde (Yang Ming/COSCO/ZIM → `UNAVAILABLE`); e os parâmetros da **PIL** (ponto médio → `ESTIMATED_PROVISIONAL`).

Com esses números, seedo as tabelas e preencho `CASOS_FAIXA_TARIFARIA`/`CASOS_TABELAS_PROVISORIAS` com a reprodução dos exemplos do próprio documento — a infraestrutura já está pronta e testada para recebê-los. Formato sugerido por tabela: `armador | equipamento | dia_inicial | dia_final(ou "aberto") | valor | moeda | day_count_basis | qualidade_fonte | vigencia_inicio`.

### 12. Próximo passo

Fase 4 concluída na parte que os dados permitem. **Não avanço para a Fase 5 sem nova autorização**; e aguardo os números do Blueprint para fechar Termo Único + tabelas de armador dentro da própria Fase 4.

---

## Relatório de entrega — revisão 8 (migration 0010 + Fase 4 completa: tabelas de armador + Termo Único + vigência desconhecida)

**Escopo autorizado:** completar a Fase 4 com os números literais do Blueprint (Termo Único, 12 tabelas de armador) e a governança de vigência desconhecida. V1 intacta. Fase 5 segue aguardando autorização.

### 1. Seeds realmente cadastrados

- **Termo por Embarque** (Cap. 24.1) e **Termo Único** (Cap. 24.2): tabela Rocket×cliente, faixa aberta única por equipamento, valores reais (`20DV/HC=150`, `40DV/HC=250`, `20OT=230`, `40OT=300`, `20FR=230`, `40FR=300`, `20NOR=275`, `40NOR=400`, `20RE=450`, `40RE=600` USD). Motores e tabelas separados apesar de coincidirem numericamente. Módulo `tariffs/seed/rocketTermoPorEmbarque.ts`.
- **12 tabelas de armador** (Cap. 24.3.1): MSC, Hapag-Lloyd, CMA CGM, Maersk, ONE, PIL, Yang Ming, HMM, Evergreen, COSCO, OOCL, ZIM — valores literais, agrupamento de equipamento preservado exatamente (ex.: CMA `40/45 Dry` uma chave só; Maersk `20/40 Reefer` idem). Públicas (`organization_id = NULL`). Módulo `tariffs/seed/armadorTables.ts`. Verificado em teste: 14 tabelas no total, **Hapag** é a única `excess_over_free_time`, **PIL** a única `PROVISORIA_INCOMPLETA`.
- **Vigência:** todas com `vigencia_inicio = NULL` (início desconhecido) e `verificada_em = 2026-09-24`. Nenhuma data histórica inventada.
- **Especial incompleto** (Yang Ming/COSCO/ZIM): a "faixa inicial" sem limites cronológicos **não é cadastrada** — nenhuma linha de bracket para Especial desses armadores, então o cálculo cai em `UNAVAILABLE`.
- **FT padrão** das fontes: informativo, **não cadastrado** — o cálculo usa o Master FT do processo.

### 2. Fixtures

`CASOS_TERMO_POR_EMBARQUE` (E01–E06), `CASOS_TERMO_UNICO` (TU01–TU02) e `CASOS_EXPOSICAO_ARMADOR` (AR-MSC … AR-ZIM, incl. os Especiais → UNAVAILABLE) em `__fixtures__/casosOficiais.ts` — todos com valores reais, conferidos contra o mesmo oráculo aritmético do bracketEngine. As tabelas sintéticas restantes cobrem **só propriedades abstratas** (excess × absoluto, buraco → UNAVAILABLE, agregação por faixa), não valores comerciais.

### 3. Esperado × real

| Fixture | Tabela | Equip. | day_count_basis | Master FT | Dias | Esperado | Real |
|---|---|---|---|---|---|---|---|
| AR-MSC | MSC | 20DRY | absoluto | 6 | 6 | 495 USD (3×55+3×110) | 495 |
| AR-HAPAG | Hapag | 20DRY | **excedente** | 10 | 20 | 2448 USD (16×113+4×160) | 2448 |
| AR-CMA | CMA | 20DRY | absoluto | 12 | 5 | 450 USD (2×60+3×110) | 450 |
| AR-MAERSK | Maersk | 20DRY | absoluto | 5 | 20 | 1925 USD (4 faixas) | 1925 |
| AR-ONE | ONE | 20REEFER | absoluto | 3 | 15 | 3535 USD (3 faixas) | 3535 |
| AR-PIL | PIL | 20DRY | absoluto | 7 | 16 | 1037,50 USD · ESTIMATED_PROVISIONAL | 1037,50 |
| AR-YANGMING-ESP | Yang Ming | 20ESPECIAL | absoluto | 7 | 10 | UNAVAILABLE | UNAVAILABLE |
| AR-HMM | HMM | 20DRY | absoluto | 7 | 16 | 1185 USD | 1185 |
| AR-EVERGREEN | Evergreen | 40DRYHC | absoluto | 7 | 16 | 2155 USD | 2155 |
| AR-COSCO | COSCO | 40DRYHC | absoluto | 7 | 16 | 2065 USD | 2065 |
| AR-COSCO-ESP | COSCO | 20ESPECIAL | absoluto | 7 | 10 | UNAVAILABLE | UNAVAILABLE |
| AR-OOCL | OOCL | 20DRY | absoluto | 10 | 10 | 690 USD | 690 |
| AR-ZIM | ZIM | 20DRY | absoluto | 7 | 16 | 1140 USD | 1140 |
| AR-ZIM-ESP | ZIM | 20ESPECIAL | absoluto | 7 | 10 | UNAVAILABLE | UNAVAILABLE |
| TU01 | Termo Único | 20DV | absoluto | 14 | 8 | 1200 USD | 1200 |
| TU02 | Termo Único | 40HC | absoluto | 14 | 10 | 2500 USD | 2500 |

AR-CMA prova o ponto do enunciado: Master FT (12) > FT padrão (7) e a faixa **não reinicia** — o dia 13 cai em `8–14` e o dia 15 em `15+`, pela contagem absoluta desde a descarga. AR-HAPAG prova o `excess_over_free_time` (o dia excedente 1 é o 1º de demurrage), sem converter para dias desde a descarga.

### 4. Testes totais e regressão

Suíte da engine: **152/152 verde** (era 137; +35 no arquivo de tarifas). `tsc`/`build` limpos. V1: **25/25 verde**. V1 intacta: `git diff` vs `48ba7c1` = vazio.

### 5. Prova de versionamento

- Seleção por vigência conhecida × início desconhecido: versão datada que cobre a data de referência tem prioridade sobre a de início desconhecido (teste `vigência desconhecida — ... datada vence`).
- `recálculo faz supersede; inclusão posterior de vigência não apaga o ValorApurado anterior`: o valor antigo vira `SUPERSEDED` com seu próprio `total`/`versao_tabela` preservados; o novo nasce com `supersedes_id` apontando para ele.

### 6. Prova das lacunas UNAVAILABLE

Especial de Yang Ming, COSCO e ZIM (faixa inicial sem limites) não têm bracket cadastrado → `UNAVAILABLE` (`sem faixa`), nunca aproximação. Equipamento não reconhecido → `UNAVAILABLE`. Sem versão de tabela comprovada → `UNAVAILABLE`/`TARIFF_VERSION_NOT_PROVEN`, com prova explícita de que o total é `null`, **não zero**.

### 7. Comportamento PIL

PIL é `PROVISORIA_INCOMPLETA`; todo cálculo com ela sai `ESTIMATED_PROVISIONAL` (AR-PIL: 1037,50 USD). Nunca `CONFIRMED` — e `CONFIRMED` em geral só com `custo_real_confirmado_ref` (barrado por `CHECK`). Os valores usados são os do ponto médio informados no Blueprint (ex.: 20 Dry `8–14=50`, `15–21=67,50`, `22+=107,50`; Reefer com o mínimo estimado nas faixas abertas `220`/`380`).

### 8. V1 intacta

`git diff` de `src/demurrage/*`, `src/routes/demurrageRoutes.ts`, `public/Demurrage.dc.html` e `public/PortalCliente.dc.html` contra `48ba7c1`: vazio. Toda a Fase 4 vive em `src/demurrage-engine/`.

### 9. PRECISA DE SUA VALIDAÇÃO

Nenhum bloqueio novo. Um limite conhecido, não urgente, registrado para transparência: a **normalização do tipo de contêiner do processo para a classe de equipamento do armador** (ex.: `20DV` do contêiner → `20DRY` da tabela MSC; `OT`/`FR` → `Especial`; onde entra `NOR`) depende da tabela de equivalências que o **próprio Blueprint deixa como pendência dele mesmo**. As fixtures e o motor operam sobre a classe de equipamento já resolvida; o mapeamento fino contêiner→classe fica para quando a equivalência for fornecida, sem inventar correspondências. Não bloqueia a Fase 4 nem a Fase 5.

### 10. Próximo passo

Fase 4 concluída. **Não avanço para a Fase 5 sem nova autorização.**

---

## Relatório de entrega — revisão 9 (Fase 5: integração com a API central de Tracking)

**Escopo autorizado:** integrar a Demurrage Engine V2 à **API central de Tracking da própria Priora** (Playwright/Scrapfly atrás dela), sem criar outro serviço/scraper/cliente Scrapfly, sem loop HTTP, sem tocar a V1, sem o scheduler da Fase 6.

### 1. Como integrei os arquivos do branch de Tracking sem trazer alterações alheias

O branch `claude/demurrage-api-playwright-5q2lqq` diverge do merge-base `1f5165c` em 136 arquivos, misturando trabalho de PreAlerta/OCR/Auditoria/mistral/supabase que **não** pertence a esta integração. Tracei o **closure de imports** de `enrichOne`/`trackShipment` e trouxe só ele:
- `src/browser/**` (45 arquivos: fachada de carriers, detecção, registry, scrapers dos 12 armadores, Playwright/Scrapfly em `browser.ts`/`scrapingBrowser.ts`, anti-captcha) — importam apenas `playwright`/`undici`/`proxy-chain` + `src/config`.
- `src/demurrage/demurrageBotStore.ts` (cache/TTL/merge), `trackingMapper.ts`, `trackingOrganizer.ts`.
- `src/config.ts`: adicionei **só** os blocos de tracking (`browser`, `unblocker`, `brightData`, `carrierApis`, `antiCaptcha`, `bot`) + helpers (`hasProxy`, `isUnblockerConfigured`, `isBrightDataConfigured`, `isAntiCaptchaConfigured`) — **não** trouxe mistral/supabase/rocket/billing.
- `package.json`: só `playwright@1.56.1`, `undici`, `proxy-chain`.
- `geminiClient`/`demurrageParser` já existiam na branch da Demurrage (não sobrescritos).

Nenhum arquivo de PreAlerta/OCR/Auditoria foi trazido. Modificados (existentes): `config.ts`, `package.json`, lockfile e 3 arquivos de teste. Tudo o mais é novo.

### 2. Fluxo real: Tracking API → adapter → TrackingFetch → TrackingEvent → FieldObservation → campo

```
sincronizarReferencia(ref)
  → armadorTrackingSource (porta ArmadorTrackingPort)  [ÚNICO ponto de contato]
      → trackingService.enrichReference(ref)  [IN-PROCESS, sem HTTP]
          → demurrageBotStore (cache/TTL adaptativo/merge)  [reuso do cache existente]
              → trackShipment → Playwright → Scrapfly → armador   (só em miss/stale)
  → TrackingTargetRepository.upsert (target global por referência)
  → ingestTrackingResult:
       TrackingFetch (auditoria de consumo: cached/resolved/status/erro)
       TrackingEvent[] (dedupe por hash no banco)
       matriz por campo → FieldObservation(fonte=tracking_service) → campo tipado do Contêiner
```
`armadorTrackingSource` é o único arquivo de `src/demurrage-engine/*` que fala com a camada de tracking; a ligação real usa `import()` dinâmico para não carregar Playwright nos testes do motor.

### 3. Migrations

`0011_tracking.sql` (aditiva): `tracking_targets` (global, `UNIQUE(reference_value)`), `container_tracking_targets` (N:N, `UNIQUE(container_id, tracking_target_id)`), `tracking_fetches` (append-only), `tracking_events` (append-only, **`UNIQUE(dedupe_hash)` = idempotência no Postgres**). Fecha também a FK reservada `snapshots.evento_origem_id → tracking_events`.

### 4. Matriz de promoção por campo (implementada e testada)

| Campo | Regra | Efeito na ingestão |
|---|---|---|
| `dischargeDate` | Tracking = fonte de verdade | promove `Contêiner.discharge_date` |
| `gateOut` | evento inequívoco (já ≥ descarga) | promove `gate_out_date` |
| `emptyReturn` | tracking | promove `tracking_return_date` (effective/minuta/fechamento = Fase 8) |
| `availableDate` | preservar sem equivalência nova | **só** vira `tracking_event(available)`; não promove nada |
| tipo | evidência | `FieldObservation`, **nunca** sobrescreve o Master/MBL |
| House FT / Master FT | tracking nunca promove | ignorado (a API real nem fornece) |

### 5. Testes

9 testes novos em `tracking.test.ts` (engine total: **161/161 verde**; V1 **25/25**; tsc/build limpos): dedupe estável (mesmo evento em duas consultas = mesma chave; nunca posição/timestamp); reuso do cache central (mergeEvents dedup, TTL adaptativo, resolvido = cache eterno); matriz de promoção; idempotência (reingestão não duplica); **concorrência** (duas ingestões simultâneas → 1 evento); fetch falho / **carrier bloqueado** (não inventa evento, não apaga dado); tipo divergente (Master prevalece); target compartilhado por vários contêineres (promoção independente); `cached` registrado; ponta-a-ponta pela porta (fake).

### 6. Exemplo sanitizado (resposta real do contrato)

`GET /health/track?refs=274319835` (Maersk), do `docs/tracking-api-contract.md`:
```json
{ "ref": "274319835", "carrier": "Maersk", "ok": true, "eventsCount": 16,
  "containers": [{ "numero": "TRHU1477661", "tipo": null,
    "dischargeDate": "2026-08-26", "gateOut": "2026-08-27",
    "emptyReturn": "2026-09-09", "lastFreeDay": null }] }
```
Ingerido: `discharge_date=2026-08-26`, `gate_out_date=2026-08-27`, `tracking_return_date=2026-09-09`; `lastFreeDay` nunca vem do portal (login comercial).

### 7. Prova de dedupe concorrente

`Promise.all([ingest, ingest])` do mesmo resultado → `SELECT count(*) FROM tracking_events` = número de eventos distintos (não o dobro). Garantido pela `UNIQUE(dedupe_hash)` + `ON CONFLICT DO NOTHING` (banco, não só TypeScript).

### 8. Prova de reutilização do cache existente

Não criei segundo cache. `enrichReference` (serviço extraído) usa o `demurrageBotStore` existente: TTL adaptativo (`scrapeIntervalMs`: resolvido→`Infinity`, trânsito→dias, ativo→12h) e `mergeEvents` (histórico não “desacontece”). `TrackingFetch.cached` registra quando a resposta veio do cache central (sem gastar Scrapfly). Testado.

### 9. Carriers funcionais × bloqueados (estado real do código trazido)

Raspando: **Hapag, Maersk, ONE, COSCO, PIL, HMM, Evergreen, MSC, Yang Ming** (COSCO **está** operacional — corrige o planejamento antigo). Bloqueados (`scrapeBlocked`, não resolvidos nesta fase): **CMA CGM** (DataDome), **OOCL** (Cloudflare+slider; parser existe), **ZIM** (hCaptcha). Para bloqueado/falha: `TrackingFetch` `falha`/`parcial`, sem evento fictício, sem apagar último dado, sem inferir Empty Return.

### 10. Nenhuma chamada Scrapfly/Playwright dentro de `demurrage-engine`

nenhum `import`/`require` de `playwright`, `scrapfly` ou `src/browser` em `src/demurrage-engine/*` (as palavras só aparecem em comentários/testes). O único acoplamento com a camada de tracking é `armadorTrackingSource`, que consome a porta e faz `import()` dinâmico de `src/demurrage/trackingService` (fora do `demurrage-engine`). Scrapfly/Playwright ficam atrás da API central.

### 11. V1 intacta

`git diff` de `src/demurrage/{demurrageParser,demurrageFilters}.ts`, `demurrageRoutes.ts` e os dois portais contra `48ba7c1`: vazio.

### 12. PRECISA DE SUA VALIDAÇÃO

Três pontos de transparência (nenhum bloqueia a Fase 5; não alterei estrutura aprovada sem reportar):
- **Identidade do TrackingTarget = `reference_value`** (não a tripla `armador+reference_type+reference_value`). Motivo: a API central aceita ref genérica e não distingue MBL/HBL, e o cache central é por ref; `reference_type`/`armador` ficam como metadados. Se preferir a tripla como identidade, é uma migration aditiva simples.
- **Rota Express não trazida.** Extraí o serviço reutilizável `src/demurrage/trackingService.ts`; a rota `demurrageBotRoutes` vive no branch de tracking e deve passar a **delegar** a esse serviço quando os branches forem unificados (rota → serviço; `armadorTrackingSource` → serviço). Não a tornei ativa aqui para não arrastar o `calculator`/`tariffs` antigos, que a Fase 4 já substitui. A rota continua funcionando como hoje no branch dela.
- **Payload bruto não persistido**: a API real não guarda payload bruto por consulta; `tracking_events.raw_ref` e `external_event_id` nascem `NULL` (não inventei entidade/coluna). Se a auditoria aprovada exigir o payload bruto, é mudança estrutural nova — reporto antes de implementar.

### 13. Próximo passo

Fase 5 concluída. **Não avanço para a Fase 6 sem nova autorização.**

---

## Relatório de entrega — revisão 10 (Fase 5: identidade canônica do TrackingTarget + normalizadores)

**Escopo autorizado:** validações da Fase 5 aprovadas com ajuste no TrackingTarget (identidade `armador + referência canônica`), normalização determinística/conservadora por armador, migration aditiva 0012, e verificação de auditoria de `TrackingEvent`/`TrackingFetch`.

### 1. Resultado da migration 0012

`0012_tracking_target_identidade.sql` (aditiva; 0011 não reescrita): em `tracking_targets` troca a identidade de `UNIQUE(reference_value)` para **`UNIQUE(armador, reference_value_canonical)`** (adiciona `reference_value_canonical`, backfill conservador, `armador` NOT NULL, remove `reference_type` e o `reference_value` bruto do target). Em `container_tracking_targets` adiciona o **contexto de origem** (`reference_type` + `reference_raw` = grafia bruta preservada; **na revisão 11 o `reference_type` executável foi restrito a MBL/CONTAINER — HBL removido, pois a API marítima não consulta HBL**). Preserva `vessel`/`voyage` em `tracking_events` (auditoria — ver §5). Aplica limpa e idempotente no runner (`migrate.test` verde).

### 2. Normalizadores implementados (`tracking/referenceCanonical.ts`)

Determinístico, conservador, por armador. Limpeza geral: `trim` + `uppercase` + remoção de espaços/hífens. **Nunca** fuzzy, nunca completa/troca caractere, nunca corrige por similaridade.
- **Evergreen** (`evergreen-corpo-12`): `EGLV`/`EVGL`/`EGVL` + corpo de 12 dígitos, ou o corpo puro → o corpo de 12 dígitos.
- **HMM** (`hmm-strip-hdmu`): remove só o prefixo `HDMU`; sem `HDMU`, preserva.
- **COSCO** (`cosco-strip-cosu`): remove `COSU`; a forma numérica preserva.
- **Maersk** (`maersk-numerico`): 9 dígitos preservados.
- **MSC / OOCL / ONE / Hapag / CMA CGM / Yang Ming / PIL** (`preserva-integral`): referência íntegra (uppercase limpo), sem remover prefixo.
- Fora do padrão conhecido → forma **conservadora** + `precisaMapping = true` (registra necessidade de mapping; não inventa canônico).
- **Detector de mismatch**: se a referência tem prefixo forte de outro armador (`HLCU`→hapag, `OOLU`→oocl, `ONEY`→one, `MEDU`→msc, `HDMU`→hmm, `COSU`→cosco, `EGLV/EVGL/EGVL`→evergreen) diferente do declarado, sinaliza `CARRIER_REFERENCE_MISMATCH` — **sem trocar o armador** (proteção de qualidade, não correção automática).

### 3. Exemplos raw → canonical (amostra real da Rocket, conferidos em teste)

| Armador | raw | canonical |
|---|---|---|
| Evergreen | `EGLV149604044674` | `149604044674` |
| Evergreen | `EVGL140658060933` | `140658060933` |
| Evergreen | `EGVL140655114952` | `140655114952` |
| Evergreen | `149604025416` | `149604025416` |
| HMM | `HDMUHKGM01285200` | `HKGM01285200` |
| HMM | `HDMUNBOZGV178200` | `NBOZGV178200` |
| HMM | `HKGM39554800` | `HKGM39554800` |
| COSCO | `COSU6508496810` | `6508496810` |
| COSCO | `6505127410` | `6505127410` |
| Maersk | `272923983` | `272923983` |
| MSC | `MEDUYJ422987` | `MEDUYJ422987` (não remove MEDU) |
| OOCL/ONE/Hapag/CMA/YM/PIL | `OOLU…`/`ONEY…`/`HLCU…`/`QGD3…`/`YMLU…`/`NGPN…` | idênticos (íntegros) |

### 4. Caso HMM compartilhado (confirmado)

`SZPM51914400` (HMM), usada por **IM2734** e **IM3087**: `upsert` duas vezes com o mesmo `(armador, canônica)` → **1 TrackingTarget**, **2 vínculos** `ContainerTrackingTarget`, **1 consulta reutilizável** — nunca duas puxadas por haver dois processos. Também: `HDMUSZPM51914400` (com prefixo) e `SZPM51914400` convergem para o mesmo target, e a grafia bruta de cada origem fica preservada em `container_tracking_targets.reference_raw`. Testado.

### 5. Auditoria TrackingEvent + TrackingFetch (confirmada)

Reconstruo o evento normalizado recebido e sei quando foi obtido, sem nada relevante descartado:
- **evento recebido:** `tracking_events.tipo_evento` + `status_desc` + `location` + `vessel`/`voyage` (preservados na 0012);
- **data civil do evento:** `data_evento` (DATE);
- **instante de coleta:** `tracking_events.coletado_em` e `tracking_fetches.iniciado_em`/`finalizado_em`;
- **fonte/armador:** `tracking_fetches.carrier` + `tracking_targets.armador`;
- **target:** `tracking_target_id`; **contêiner:** `container_numero`.
`external_event_id = NULL` (a API não fornece ID estável — a identidade técnica é o `dedupe_hash`) e `raw_ref = NULL` (a API não persiste payload bruto) seguem aprovados. **Não** armazeno HTML/payload bruto do armador (não existe hoje; não inventado).

### 6. Testes

Novos: 6 puros de canonicalização + mismatch/anti-fuzzy, e 4 de identidade no banco (convergência de grafias → 1 target; mesma canônica em armadores diferentes → targets diferentes; mesma ref como MBL e HBL → 1 target com contexto no vínculo; caso HMM 2 processos → 1 target/N vínculos). Suíte da engine: **171/171 verde**; V1 **25/25**; `tsc`/`build` limpos; V1 intacta.

### 7. PRECISA DE SUA VALIDAÇÃO

Nenhum ponto aberto. Os três da revisão 9 foram resolvidos: identidade do target ajustada para `armador + canônica` (0012); rota Express permanece não-ativa aqui (delega ao serviço na unificação); `external_event_id`/`raw_ref` `NULL` aprovados, e a auditoria de evento foi verificada e reforçada com `vessel`/`voyage` para não descartar informação.

### 8. Próximo passo

Fase 5 concluída (com a 0012). **Não avanço para a Fase 6 sem nova autorização.**

---

## Relatório de entrega — revisão 11 (Fase 6: scheduler, cadência e alerta multiempresa)

**Escopo autorizado:** cadência oficial, seleção MBL→CONTAINER (HBL excluído do tracking), reuso do cache central, alerta de falha multiempresa, atualização manual. Migration aditiva 0013. Não avançar para a Fase 7.

### 1. Migration 0013 (aditiva; 0001–0012 não reescritas)

- `container_tracking_targets.reference_type` restrito a **`mbl`/`container`** (exclui HBL): vínculo de tracking executável representa só MBL ou CONTAINER.
- `tracking_targets.ultima_consulta_manual_em` (cooldown manual).
- `tracking_incidents` (incidente único por target; índice parcial "aberto único"; `seq` numera incidentes sucessivos).
- `tracking_alert_deliveries` (escopo `tecnico_global` = 1 por incidente; `operacional_org` = 1 por incidente+organização; constraints garantem a unicidade). `organization_id` imutável (convenção DECISÃO 1). Aplica limpa (`migrate.test` verde).

### 2. Cadência (`scheduler/cadencePolicy.ts`, pura)

`avaliarCadencia`/`proximaConsulta`/`deveConsultarAgora` sobre datas civis. Fases: `aguardando_descarga` → `inicial` (1ª janela D+5) → `a_cada_4_dias` (D+9, D+13, D+17…) → `diario` (a partir de menor LFD − 4) → `a_cada_2_dias` (algum relógio em demurrage) → `encerrado` (Empty Return). **Exemplo obrigatório conferido:** House LFD 20/09, Master 25/09 → menor 20/09 → **início diário 16/09** (antes de D+17). Janelas pré-diário ancoradas em D0; diário/2-dias ancorados na última consulta.

### 3. Seleção de target e reuso (`scheduler/trackingScheduler.ts`)

`sincronizarContainer`/`sincronizarCiclo`: tenta o MBL primeiro; se o MBL fornece o tracking do contêiner (o BL retorna aquele contêiner), **não consulta o número do contêiner**; se o MBL não resolve (bloqueado/sem o contêiner), cai para o CONTAINER. A consulta é pela **referência canônica** (uma entrada de cache central por target); o contexto de ciclo garante **uma consulta e um `TrackingFetch` por target por ciclo** — um MBL que alimenta N contêineres/processos é puxado uma vez. HBL nunca entra (não é `reference_type` válido).

### 4. Alerta multiempresa (`persistence/trackingIncidentRepository.ts` + `avaliarFalhaTarget`)

Incidente **global por target**: a 3ª falha consecutiva (`tracking_fetches` status `falha`) abre o incidente + registra o **alerta técnico global** (único) + uma **entrega operacional por organização afetada**. 4ª/5ª falhas não criam novas entregas (incidente já aberto; `ON CONFLICT`). Um sucesso fecha o incidente e reseta; nova sequência de 3 falhas → novo incidente (`seq+1`). Segregação: `containersForTargetAndOrg` entrega a cada organização só os próprios contêineres — nenhum dado de A na entrega de B.

### 5. Atualização manual (`solicitarAtualizacaoManual` + `failurePolicy`)

Só MANAGER/ADMIN; cooldown ~2h por target (`podeAtualizarManual`); reutiliza o cache central; marca `ultima_consulta_manual_em`. Execução em background é responsabilidade da aplicação (a interface nunca bloqueia). Sem a regra antiga de "duas atualizações por dia".

### 6. Testes (todos os obrigatórios)

Suíte da engine: **180/180 verde**; V1 **25/25**; `tsc`/`build` limpos; V1 intacta. Novos (`scheduler.test.ts`, 9): cadência (exemplo obrigatório + fases + Empty Return encerra); falha/manual puros; **HBL rejeitado** pelo banco; **MBL disponível → não consulta container**; **MBL indisponível → container fallback**; **MBL compartilhado por 2 processos → 1 consulta**; **múltiplos contêineres de um MBL reaproveitados**; **2 organizações no mesmo target → 1 consulta global + entregas segregadas + sem vazamento A→B**; **supressão** (4ª/5ª sem novo alerta; sucesso reseta; nova sequência = novo incidente). Plano atualizado: removida toda menção a HBL como identificador aceito pela Tracking API.

### 7. Falhas — invariantes garantidas

Falha registra `TrackingFetch` `falha`/`parcial`, **não** apaga o último resultado (append-only), **não** interrompe relógios (o motor é independente), **não** presume Empty Return (só o evento real de devolução promove `tracking_return_date`). Supressão até um sucesso.

### 8. PRECISA DE SUA VALIDAÇÃO

Nenhum ponto aberto. Um item de transparência (não bloqueia; nada foi alterado sem reportar): a **execução concreta do cron/worker** (quando o processo Node dispara o ciclo) e o **transporte do alerta** (e-mail/webhook ao responsável técnico e aos Gestores) são da camada de aplicação/infra e não foram implementados aqui — a Fase 6 entrega a decisão de cadência, a seleção/reuso, e a máquina de incidente/entregas (registros segregados). Se quiser o worker/transporte dentro deste módulo, é uma adição a combinar.

### 9. Próximo passo

Fase 6 concluída. **Não avanço para a Fase 7 sem nova autorização.**

---

## Relatório de entrega — revisão 12 (revisão da Fase 6: 30 dias, worker real e outbox de alerta)

Esta revisão corrige uma regressão e fecha as duas lacunas de execução que a revisão 11 havia deixado como "camada de aplicação". **Nada da estrutura aprovada foi alterado** (MBL→CONTAINER, HBL fora do tracking, target global compartilhado, cache central, uma consulta por MBL compartilhado, D0→D+5→a cada 4 dias→diário→a cada 2 dias, Empty Return para as consultas automáticas daquele contêiner, cooldown manual ~2h, incidente técnico global, entregas operacionais segregadas, supressão da 4ª/5ª falha, reset no sucesso). Migration **0014** aditiva; 0001–0013 não reescritas.

### 1. Suspensão automática aos 30 dias — RESTAURADA (era uma regressão minha)

A revisão 11 dizia, erradamente, "Sem suspensão aos 30 dias". Restaurado em `scheduler/cadencePolicy.ts` (pura):

- Ao atingir **30 dias em demurrage sem Empty Return** (`diasEmDemurrage(input) >= LIMITE_DIAS_DEMURRAGE`, com `LIMITE_DIAS_DEMURRAGE = 30`), a cadência retorna `fase = 'suspenso_30_dias'`, `automaticTracking = 'SUSPENDED'`, `motivoSuspensao = 'MAX_AUTOMATIC_TRACKING_WINDOW_REACHED'`, `intervaloDias = null`.
- **Não é encerramento:** o processo continua aberto e sinalizado, os relógios seguem avançando (`diasEmDemurrage` continua crescendo; `inicioDiario` continua definido), nada é zerado, nenhuma devolução é presumida.
- `proximaConsulta`/`deveConsultarAgora` retornam `null`/`false` quando suspenso → o worker **não** consulta automaticamente.
- A **atualização manual** (MANAGER/ADMIN) independe da suspensão e continua disponível; um Empty Return obtido por consulta manual/válida é processado normalmente e encerra o tracking daquele contêiner.
- O Empty Return é checado **antes** da regra dos 30 dias, então uma devolução tardia sempre resulta em `encerrado`, não em `suspenso`.

Testes puros: dia 29 ainda consulta; dia 30 suspende; após a suspensão os relógios seguem; `inicioDiario` presente; sem devolução presumida; manual continua possível; Empty Return posterior encerra.

### 2. Worker REAL (in-process, sem novo serviço) — com claim/idempotência em PostgreSQL

**Investigação primeiro:** não há mecanismo de job/fila pré-existente no repositório (nem `node-cron`, nem BullMQ, nem worker dedicado). Optei pelo **menor custo compatível com a infra atual**: um tick puro e testável (`scheduler/schedulerWorker.ts::runSchedulerOnce`) que **não cria um serviço separado** — roda no mesmo processo Node, disparado pela camada de aplicação (um `setInterval`/cron simples, ou um endpoint acionado por um cron externo). O tick:

1. Carrega os contêineres rastreáveis (`persistence/schedulerRepository.ts::carregarContainersRastreaveis`) com os fatos de cadência e a **última consulta automática** (ancorada na maior **janela concluída**, não no timestamp do armador).
2. Aplica a cadência pura por contêiner; **respeita a suspensão de 30 dias** (contêiner suspenso não entra na janela).
3. Reivindica um **claim por `(tracking_target_id, janela=data civil do tick)`** em `tracking_schedule_claims` (`UNIQUE`, `INSERT … ON CONFLICT DO UPDATE … WHERE stale/failed`): só **um** worker vence; um claim de worker morto (`claimed` mais velho que a janela stale, default 30 min) ou `failed` é reaproveitável.
4. Executa `sincronizarCiclo` com a barreira de claim injetada → o `puxar` do orquestrador só consulta o armador se o claim foi vencido; **MBL→CONTAINER, reuso do cache central e uma consulta por MBL compartilhado** seguem intactos.
5. Ao concluir, marca as janelas vencidas como `done` (a cadência avança); exceção marca `failed` (reprocessável).

**Resultado:** dois workers no mesmo tick, ou um reinício no meio da janela, produzem **uma única** consulta ao armador e **um único** `TrackingFetch` (comprovado por teste concorrente com `Promise.all`). O worker roda sem ninguém abrir tela.

### 3. Transporte de alerta — outbox com estado (sem inventar canal)

`scheduler/alertOutbox.ts`: uma **porta** `AlertTransport` (o canal concreto — e-mail/webhook/Slack — é injetado, como a porta do armador) + persistência de estado por entrega (migration 0014 adiciona `status` PENDING/SENT/FAILED, `tentativas`, `enviado_em`, `erro` a `tracking_alert_deliveries`). Regras:

- Toda entrega **nasce PENDING**. Uma linha criada **≠ enviada**.
- `processarEntregasPendentes({ pool, transport })` processa a fila: sucesso → `SENT` (com `enviado_em`); erro → `FAILED` (com `erro`), **reprocessável**. Nada é descartado em silêncio.
- **Enquanto nenhum transporte real for injetado/aprovado, as entregas permanecem PENDING** — estado honesto, alertas não se perdem.
- Segregação multiempresa preservada no conteúdo montado: a entrega técnica global carrega todos os contêineres do target; cada entrega operacional carrega **apenas os contêineres da sua organização** (sem vazamento A→B).

### 4. Migration 0014 (aditiva)

- `tracking_schedule_claims` (`UNIQUE(tracking_target_id, janela)`, sem `organization_id` — o target/consulta é global; fora da DECISÃO 1).
- `tracking_alert_deliveries` ganha `status`/`tentativas`/`enviado_em`/`erro` + índice parcial de fila (`status <> 'SENT'`).

### 5. Testes (condição de aceite da revisão)

`__tests__/scheduler.test.ts` — 16/16 verdes. Além dos 10 anteriores:

- **Suspensão 30 dias (pura):** dia 29 consulta, dia 30 suspende, relógios seguem, manual possível, Empty Return posterior encerra.
- **Aceitação (integração):** processo aberto → worker acha a janela (diário, sem tela) → cache miss → Tracking Service (porta fake) → `TrackingFetch` (cache miss) → eventos ingeridos + descarga promovida → **próxima janela** reabre só no dia seguinte.
- **Concorrência:** dois workers no mesmo tick → **uma** execução real; reinício no mesmo dia não duplica.
- **30 dias sem Empty Return (integração):** worker **não** consulta; processo/relógios ativos, descarga preservada, sem devolução presumida; **manual** funciona e um Empty Return manual encerra normalmente.
- **Outbox:** entregas nascem PENDING e permanecem PENDING sem transporte; transporte bom → SENT (segregação por organização preservada); transporte que falha → FAILED com erro, reprocessável para SENT.

Suíte completa do motor: **187/187**. V1: **25/25**. `tsc --noEmit` limpo. `npm run build` limpo. Arquivos da V1 (`demurrageParser.ts`, `demurrageFilters.ts`, `demurrageRoutes.ts`, `Demurrage.dc.html`, `PortalCliente.dc.html`) **intactos** (git status confirma).

### 6. PRECISA DE SUA VALIDAÇÃO (dois pontos — nada externo foi ligado sem autorização)

Não escolhi deploy nem canal externo por conta própria — ambos ficam prontos atrás de uma decisão sua:

1. **Acionamento do worker em produção.** O tick (`runSchedulerOnce`) é in-process e não cria serviço novo. Falta decidir **quem o dispara periodicamente** na infra atual (Render): (a) um `setInterval` no processo web já existente — grátis, porém o plano free do Render **hiberna por inatividade** e pode não acordar sozinho para rodar o ciclo; (b) um **Cron Job do Render** (ou GitHub Actions agendado) batendo num endpoint que chama `runSchedulerOnce` — confiável, custo baixo/nulo; (c) um **Background Worker** dedicado do Render — mais robusto, porém é um serviço pago adicional. O claim em PostgreSQL já torna qualquer uma delas segura contra duplicação. **Recomendo (b)** por confiabilidade sem custo de serviço novo, mas é sua decisão de infra.
2. **Canal de transporte do alerta.** A porta `AlertTransport` está pronta; **não escolhi** e-mail/webhook/Slack. Enquanto não houver transporte aprovado, as entregas ficam PENDING (nada se perde). Ao aprovar um canal, implemento um adaptador da porta e ligo `processarEntregasPendentes` no mesmo tick do worker.

### 7. Próximo passo

Revisão da Fase 6 concluída. **Não avanço para a Fase 7 sem nova autorização.**

---

## Relatório de entrega — revisão 13 (acionamento in-process aprovado + transporte Graph/e-mail)

Fecha os dois `PRECISA DE SUA VALIDAÇÃO` da revisão 12 com as decisões aprovadas. **Nenhuma mudança estrutural** (cadência, suspensão 30d, MBL→CONTAINER, cache central, claim, incidente/entregas segregadas permanecem exatamente como aprovados). Sem migration nova. **Arquivos V1 intactos** (`demurrageParser.ts`, `demurrageFilters.ts`, `demurrageRoutes.ts`, `Demurrage.dc.html`, `PortalCliente.dc.html` — git status confirma).

### 1. Onde o scheduler é inicializado

`src/index.ts`, dentro do callback de `app.listen(...)` (após o servidor subir), chamando `iniciarSchedulerDemurrage()` de `src/demurrage/schedulerBootstrap.ts`. **Roda no Web Service Render Starter existente (pago, sempre ativo)** — não há Render Cron Job, GitHub Actions nem Background Worker pago. O bootstrap só liga se `DEMURRAGE_DATABASE_URL`/`DATABASE_URL` existir; sem banco, o app sobe normal e o scheduler apenas não roda (não quebra o boot).

O laço em si é puro e testável em `src/demurrage-engine/scheduler/schedulerLoop.ts` (não importa Express nem Graph — a aplicação injeta o `tick`).

### 2. Intervalo utilizado

`INTERVALO_PADRAO_MS = 60 * 60 * 1000` (~1 hora). **Rodar de hora em hora não é consultar armador de hora em hora:** a `cadencePolicy` decide, por target, se a janela venceu; na maioria dos ticks os targets sem janela vencida não geram nenhuma consulta (comprovado: "tick sem janela devida = zero consulta").

### 3. Comportamento no startup

`runOnStart: true` → um tick dispara logo após o boot, **em background** (`void executor.run()`), sem bloquear o boot nem as requisições HTTP. Motivo aprovado: se um deploy/restart ocorreu durante uma janela prevista, a janela vencida é recuperada na hora, sem esperar mais uma hora inteira. O claim garante que essa recuperação não duplica trabalho.

### 4. Proteção contra overlap

Duas camadas: (a) **guarda local** barata (`criarExecutorSemOverlap`): se um tick ainda roda, o disparo sobreposto é descartado; (b) **claim PostgreSQL** (`tracking_schedule_claims`, `UNIQUE(target, janela)`) como proteção **definitiva** — dois ticks coincidentes, duas instâncias durante um deploy, ou um reinício no meio da janela nunca produzem duas consultas reais para a mesma janela.

### 5. Comportamento em deploy/restart

- SIGTERM/SIGINT (Render envia SIGTERM no deploy) → `scheduler.stop()` (clearInterval) + `server.close()`; um tick em andamento termina sozinho e, se for interrompido, o claim o cobre (janela `claimed` stale é reaproveitável; nada fica preso).
- `process.on('unhandledRejection')` registrado: uma rejeição solta **não derruba** o Web Service. Cada tick também captura o próprio erro (`onError`) e libera a guarda de overlap mesmo após falha.

### 6. Integração Graph (transporte de alerta)

`src/demurrage/alertTransportGraph.ts` implementa a porta `AlertTransport` reutilizando a infra Graph existente (`graphService.sendMail`) e o token da conta Microsoft ativa (`src/auth/backgroundToken.ts` → `acquireTokenSilent`, a mesma renovação do `requireAuth`, mas em background). O mesmo tick in-process processa as entregas pendentes após o ciclo de tracking.

**Desacoplamento tracking × transporte (obrigatório e garantido por construção):** `processarEntregasPendentes`/o adaptador Graph **nunca** tocam em TrackingFetch/FalhaTracking nem chamam a porta do armador. Uma falha de e-mail retorna `{ ok:false }` → a **entrega** vira `FAILED` (reprocessável); **não** vira falha de tracking, **não** incrementa `FalhaTracking`, **não** dispara nova consulta ao armador. `SENT` só quando o `sendMail` do Graph retorna sem erro (nunca antes da confirmação). Estados: `PENDING` (nasce) → `SENT` | `FAILED` (reprocessável). Segregação multiempresa preservada no corpo do e-mail (cada entrega operacional cita só os contêineres da sua organização; sem vazamento A→B).

### 7. Testes

- `schedulerLoop.test.ts` (5/5): dispara um tick no start sem bloquear; agenda o periódico em ~1h e dispara a cada intervalo; guarda de overlap (dois disparos sobrepostos = um tick); erro no tick vai para `onError` sem derrubar; `stop()` limpa o timer certo.
- `scheduler.test.ts` (20/20): inclui os itens da revisão (suspensão 30d, aceitação janela→cache miss→fetch→eventos→próxima janela, dois workers = uma execução, 30 dias = zero fetch + manual, outbox PENDING/SENT/FAILED) **e** o transporte Graph: sucesso→SENT (token + destinatários + segregação no corpo); falha→FAILED reprocessável **sem** afetar FalhaTracking nem gerar consulta; sem destinatário/sem token→FAILED (nunca SENT sem confirmação); resolver por env (técnico global × por organização).
- Suíte completa do motor: **196/196**. V1: **25/25**. `tsc --noEmit` limpo. `npm run build` limpo.

Mapa dos 18 itens de teste pedidos: 1 startup (loop 1) ✓; 2 periódico ~1h (loop 2) ✓; 3 dois ticks sobrepostos (loop 3) ✓; 4 duas instâncias/claim (scheduler "concorrência") ✓; 5 restart recupera janela (runOnStart + aceitação) ✓; 6 tick sem janela = zero consulta (aceitação r2) ✓; 7 cache hit = zero consulta nova (Fase 5 + claim; a `enrich` da porta usa o cache central) ✓; 8 MBL compartilhado = uma consulta (scheduler) ✓; 9 suspensão 30d = zero fetch (scheduler) ✓; 10 Graph SENT ✓; 11 Graph FAILED ✓; 12 retry FAILED ✓; 13 falha Graph não altera FalhaTracking ✓; 14 segregação multiempresa ✓; 15 V1 intacta ✓; 16 engine ✓; 17 tsc ✓; 18 build ✓.

### 8. PRECISA DE SUA VALIDAÇÃO (um item de dado, não de estrutura)

**Destinatários dos alertas.** O canal (Graph/e-mail) está pronto; falta o **mapeamento de destinatários**, que é dado operacional que não existe no repositório: (a) e-mail(s) do responsável técnico (alerta técnico global) e (b) e-mail(s) por organização (entrega operacional). O resolver padrão lê de ambiente: `DEMURRAGE_ALERT_TECH_EMAILS` (lista) e `DEMURRAGE_ALERT_ORG_EMAILS` (JSON `{ "<organization_id>": ["email"] }`). Enquanto não forem preenchidos, essas entregas ficam `FAILED`/reprocessáveis (nada se perde; o tracking não é afetado) — assim que você fornecer os endereços (via env ou uma tabela, se preferir persistir), elas passam a enviar. Diga se prefere env ou uma tabela de destinatários no banco, e quais endereços usar.

### 9. Próximo passo

Acionamento e canal implementados conforme aprovado; tudo verde; nenhuma mudança estrutural nova. **Fase 6 pode ser considerada CONCLUÍDA.** **Não avanço para a Fase 7 sem autorização.**
