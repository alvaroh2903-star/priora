# Plano de Migração — Demurrage V1 → Demurrage Engine V2

**Data:** 23/09/2026
**Base:** `docs/demurrage-blueprint-gap-analysis.md` (diagnóstico aprovado, com as 3 correções de premissa abaixo)
**Status:** planejamento apenas. Nenhum código será escrito ou alterado nesta etapa.

## Correções de premissa incorporadas (vs. o diagnóstico anterior)

1. **Tracking de armador já existe na Priora** fora deste repositório/módulo. Não será construído um novo scraper/integração. Ver "Busca realizada" e "Contrato assumido" na Fase 5.
2. **Liberação é desacoplada.** A pré-análise de responsabilidade Rocket × cliente (Cap. 26 do Blueprint) não bloqueia o Demurrage Core. Ela entra como módulo plugável na Fase 11, consumindo eventos estruturados da Liberação quando existirem — sem gate no fechamento operacional (Fase 8).
3. **RBAC inicial:** `ANALYST`, `MANAGER`, `ADMIN`, `CLIENT`. "Responsável técnico/desenvolvedor" deixa de ser um papel de sistema e passa a ser um **destinatário configurável de alertas técnicos** (lista de e-mail/webhook em configuração, sem login nem permissões no app).

## Princípio geral: sem reescrita destrutiva

A V1 (`src/demurrage/*`, `src/routes/demurrageRoutes.ts`, `public/Demurrage.dc.html`, `public/PortalCliente.dc.html`) **permanece intocada e funcional** até o momento explícito de corte descrito na seção "Estratégia de coexistência e corte" mais abaixo. A V2 nasce em um namespace novo (`src/demurrage-engine/*` — nome proposto, ajustável), com sua própria rota (`/api/demurrage/v2` ou equivalente), sua própria persistência e seus próprios testes, sem tocar nos arquivos da V1 até que uma fase específica diga explicitamente "agora sim, isto afeta a V1".

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

**Arquivos/modelos novos:**
- `src/demurrage-engine/domain/container.ts` (entidade Contêiner: processo, número, tipo original+normalizado, armador, House/Master BL, estado, prioridade+motivo, timestamps).
- `src/demurrage-engine/domain/snapshot.ts` (fotografia versionada — Cap. 14 do Blueprint).
- `src/demurrage-engine/domain/sourcedField.ts` (`DadoComFonte<T>`: valor, fonte, timestamp, fonte alternativa, divergência).
- `src/demurrage-engine/sources/containerDataSource.ts` (porta/interface).
- `src/demurrage-engine/sources/emailHeuristicSource.ts` (adaptador que **reaproveita** `demurrageFilters.ts` + `demurrageParser.ts` da V1 como fonte de contingência — ver nota abaixo).
- `src/demurrage-engine/persistence/containerRepository.ts` (camada de acesso a dados, interface + implementação inicial).

**Arquivos existentes afetados:** nenhum é modificado. `demurrageFilters.ts` e `demurrageParser.ts` são **importados/reaproveitados** por `emailHeuristicSource.ts`, não alterados — eles continuam servindo a V1 exatamente como hoje.

**Migrations:**
- Decisão de motor de persistência a ser tomada no início da fase (não é uma "migration" em si, é pré-requisito dela): hoje a Priora não tem banco algum, só arquivos JSON planos (`.data/*.json`). Duas opções compatíveis com a infra atual (Render free, sem serviço de banco externo hoje): (a) SQLite em arquivo (ex.: `better-sqlite3`) — mesma filosofia "disco local" já usada por sessão/minutas; (b) Postgres, se/quando a Priora provisionar um serviço de banco. Esta escolha é bloqueante para o início do código da fase, mas não para o desenho — o plano assume uma interface `ContainerRepository` que funciona com qualquer um dos dois.
- Schema inicial: tabelas/coleções de `container`, `snapshot`, `sourced_field` (genérica ou embutida no `container`).
- **Backfill (não é migração de schema, é carga inicial):** rodar `emailHeuristicSource` uma vez sobre as threads atualmente identificadas pela V1 para popular a base V2 com um estado inicial equivalente ao que a V1 mostra hoje; e importar os registros existentes de `demurrage-minutas.json`/`demurrage-atividades.json` (via `procKey`) para os novos registros de contêiner/processo, preservando o que já foi feito operacionalmente (ex.: "minuta já solicitada" não pode ser perdido na virada).

**Dependências:** decisão de motor de persistência (acima); nenhuma dependência de Fase 5 (Tracking Service) — a fonte inicial é a heurística de e-mail, tratada desde já como fonte de **contingência**, não prioritária (alinhado ao Cap. 4 do Blueprint: quando a Fase 5 acoplar o Tracking Service real, ele entra como fonte prioritária sem precisar redesenhar o modelo).

**Testes obrigatórios:**
- CRUD do repositório de contêiner com versionamento de snapshot (nova versão preserva a anterior, não sobrescreve).
- `emailHeuristicSource` produzindo o mesmo resultado que a V1 produz hoje para o mesmo conjunto de e-mails de teste (teste de caracterização, para garantir que a base V2 nasce equivalente à V1 e não diverge por acidente nesta fase).
- Backfill idempotente (rodar duas vezes não duplica registros).

**Condição de aceite:** para um conjunto de threads de teste, a base V2 populada via backfill contém um contêiner por número de contêiner extraído, com o `DadoComFonte` de cada campo preenchido com fonte `email_heuristic` e o mesmo valor que a V1 mostraria hoje.

**Risco de regressão:** **nulo para a V1** (nenhum arquivo da V1 é alterado). Risco interno: erro no backfill pode gerar uma base V2 inconsistente — mitigado por rodar o backfill em ambiente de teste antes de qualquer uso real, e por ele ser reexecutável (idempotente) sem side effect na V1.

---

## Fase 2 — Motor temporal e testes de off-by-one

**Objetivo:** implementar (e testar exaustivamente) a fórmula de contagem de dias do Cap. 6/23 do Blueprint, corrigindo os dois problemas identificados no diagnóstico: âncora temporal (`dataDescarga`, não `dataRetirada`) e o aparente off-by-one da V1. Este motor é **puro** — funções de data determinísticas, sem dependência de fonte de dados real, testável isoladamente por fixtures.

**Arquivos/modelos novos:**
- `src/demurrage-engine/temporal/freeTimeClock.ts` (cálculo de último dia livre, primeiro dia de demurrage, dias cobrados, dada uma data-âncora + N dias de free time + data final de apuração).
- `src/demurrage-engine/temporal/freeTimeClock.test.ts`.

**Arquivos existentes afetados:** nenhum.

**Migrations:** nenhuma além de, no modelo do Cap. 1, acrescentar o campo `dataDescarga` (como `DadoComFonte<Date>`) à entidade Contêiner da Fase 1 — `dataRetirada`/Gate Out passa a ser um campo informativo separado, não a âncora de cálculo.

**Dependências:** Fase 1 (entidade Contêiner existir para o campo `dataDescarga` ter onde morar). Não depende de Fase 3/4/5.

**Testes obrigatórios:**
- Reprodução literal da tabela do Cap. 23.1 do Blueprint (descarga 01/09, FT 14 dias → 14/09:0, 15/09:1, 16/09:2, 20/09:6) — são os 4 primeiros casos de teste do motor, não negociáveis.
- Free time = 0 confirmado por fonte → cobrança começa no dia da descarga (Cap. 31.3).
- Free time ausente → motor retorna "pendente", nunca trata ausência como zero.
- Caso de borda de fuso horário/hora do dia — **marcado como decisão pendente** (ver diagnóstico, Seção H, item 5); o teste deve fixar explicitamente o comportamento escolhido (ex.: corte à meia-noite UTC) assim que a decisão for tomada, e falhar de propósito até lá como lembrete.

**Condição de aceite:** suíte de testes do motor temporal passando 100%, incluindo a tabela literal do Blueprint. Nenhum outro código consome este motor ainda nesta fase — é aceito isoladamente.

**Risco de regressão:** nulo (código novo, não conectado a nada em produção ainda).

---

## Fase 3 — Dois relógios House × Master

**Objetivo:** aplicar o motor temporal da Fase 2 duas vezes por contêiner — uma para o relógio do cliente (House Free Time) e uma para o relógio da Rocket (Master Free Time) — mantendo os dois resultados sempre separados, nunca fundidos em um único "status genérico".

**Arquivos/modelos novos:**
- `src/demurrage-engine/domain/clock.ts` (`ClienteClock`/`RocketClock`: free time, fonte, último dia livre, primeiro dia de demurrage, dias de demurrage, estado).
- `src/demurrage-engine/temporal/dualClockCalculator.ts` (orquestra os dois `freeTimeClock` por contêiner).
- Extensão de `container.ts` (Fase 1) para carregar `clienteClock` e `rocketClock`.

**Arquivos existentes afetados:** nenhum arquivo da V1.

**Migrations:** adicionar `masterFreeTime` (`DadoComFonte<number>`), `masterBl`, e os dois blocos de resultado de relógio à entidade Contêiner.

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

**Arquivos/modelos novos:**
- `src/demurrage-engine/tariffs/tariffTable.ts` (entidade: armador/Rocket, tipo de equipamento, faixas, vigência, versão, status).
- `src/demurrage-engine/tariffs/bracketEngine.ts` (posiciona um dia na faixa certa, contando desde a data-âncora, sem reiniciar na 1ª faixa ao fim do free time).
- `src/demurrage-engine/tariffs/seed/` (dados iniciais: as 12 tabelas de armador + tabela Rocket×cliente, literalmente copiadas do Blueprint Cap. 24.1/24.3.1).
- `src/demurrage-engine/domain/containerType.ts` (normalização de tipo de contêiner + mapeamento — Cap. 9; mapeamento inicial vazio/mínimo, já que o próprio Blueprint deixa a tabela de equivalências como pendência dele mesmo).

**Arquivos existentes afetados:** nenhum arquivo da V1.

**Migrations:** tabelas `tariff_table`, `tariff_bracket`, `container_type_mapping`; seed inicial das tabelas do Blueprint.

**Dependências:** Fase 3 (dias de demurrage por relógio já calculados) para o motor tarifário ter "quantos dias" e "em qual data" aplicar a faixa. Não depende de Fase 5.

**Testes obrigatórios:**
- Exemplo do Cap. 24: contêiner com free time maior que o padrão da tabela do armador cai numa faixa posterior à primeira.
- PIL: estimativa por ponto médio, status sempre `ESTIMATED_PROVISIONAL`, nunca `CONFIRMED`.
- Tabelas incompletas (Yang Ming/COSCO/ZIM) retornando `UNAVAILABLE` nas faixas sem dado — nunca aproximação por semelhança.
- Tipo de contêiner não reconhecido → bloqueia só a seleção de tarifa, mantém os relógios ativos (Cap. 31.9).

**Condição de aceite:** para cada armador com tabela completa no Blueprint, o motor reproduz os valores de exemplo do próprio documento; para os incompletos, retorna `UNAVAILABLE`/`ESTIMATED_PROVISIONAL` conforme o caso, nunca um número inventado.

**Risco de regressão:** nulo (motor isolado, sem consumidor em produção ainda).

---

## Fase 5 — Integração com o Tracking Service existente

**Objetivo:** conectar `ContainerDataSource` (Fase 1) a um novo adaptador que consome o **serviço de tracking de armador já existente na Priora** (fora deste repositório), promovendo-o a fonte prioritária conforme a hierarquia do Cap. 4 — sem construir nenhum scraper/integração nova. A `emailHeuristicSource` (Fase 1) passa a atuar exatamente como o Blueprint prevê: fonte de contingência, usada só quando o tracking estruturado não tiver o dado.

**Pré-condição de início (bloqueante, fora do controle de código):** obter, junto ao time responsável pelo serviço existente, (a) acesso/credenciais, e (b) o contrato real de request/resposta. Sem isso, esta fase não pode começar — ver "Busca realizada" acima.

**Contrato assumido (a validar contra o serviço real assim que houver acesso):**
- Entrada: identificador de armador + BL (House/Master) e/ou número de contêiner.
- Saída esperada, por contêiner: data de descarga, data de Gate Out (quando houver), data de Empty Return (quando houver), lista de eventos com timestamp, timestamp da última atualização da fonte, indicador de sucesso/falha da consulta.
- Assumir que o serviço já resolve cache/consulta ao armador internamente (não duplicar cache na Priora se o serviço existente já fizer isso — a decisão exata depende do contrato real).

**Arquivos/modelos novos:**
- `src/demurrage-engine/sources/armadorTrackingSource.ts` (implementa `ContainerDataSource`, chamando o serviço existente via HTTP/SDK — a definir conforme o contrato real).
- `src/demurrage-engine/sources/sourceHierarchy.ts` (orquestra prioridade: tracking do armador > House/MBL estruturado, quando existir > heurística de e-mail > `MANUAL_FALLBACK`).

**Arquivos existentes afetados:** nenhum arquivo da V1. `config.ts` ganha uma nova seção (`trackingService: { baseUrl, apiKey, ... }`, nomes a definir com o contrato real).

**Migrations:** nenhuma nova entidade; passa a popular os campos já existentes (`dataDescarga`, `masterFreeTime`, etc.) com `fonte = 'armador_tracking'` em vez de `'email_heuristic'` quando disponível, preservando ambos os valores em caso de divergência (Cap. 4: "a Priora mantém ambos os registros, aplica a hierarquia e sinaliza a divergência").

**Dependências:** acesso ao serviço real (pré-condição acima); Fase 1 (porta `ContainerDataSource` já definida).

**Testes obrigatórios:**
- Contrato do adaptador testado contra um mock do serviço real (respostas de sucesso, falha, timeout).
- Divergência entre `armador_tracking` e `email_heuristic` para o mesmo campo → ambos preservados, hierarquia aplicada, divergência sinalizada (não silenciosa).
- Campo presente só na heurística de e-mail (tracking não retornou) → continua usável como contingência.

**Condição de aceite:** para um contêiner de teste, o adaptador retorna os campos do contrato assumido e o `sourceHierarchy` prioriza corretamente `armador_tracking` sobre `email_heuristic` quando ambos têm valor.

**Risco de regressão:** nulo para a V1. Risco técnico principal desta fase: o contrato assumido acima pode não bater com o serviço real — o adaptador deve ser a **única** peça a mudar se o contrato real for diferente (por isso ele fica isolado atrás da porta `ContainerDataSource`, sem vazar formato específico do serviço para o resto do motor).

---

## Fase 6 — Scheduler e cadência

**Objetivo:** implementar a cadência automática do Cap. 16 (D0/D+5/D+9/D+13/D+17 → diário → a cada 2 dias em demurrage → suspensão aos 30 dias) e os alertas de falha do Cap. 18 (3 falhas consecutivas → `MANAGER` do processo + destinatários técnicos configuráveis — trilho T2).

**Arquivos/modelos novos:**
- `src/demurrage-engine/scheduler/cadencePolicy.ts` (função pura: dado o estado do contêiner + histórico, decide se/quando a próxima consulta deve ocorrer).
- `src/demurrage-engine/scheduler/schedulerWorker.ts` (job em background — mecanismo concreto, ex. `node-cron` ou execução periódica no próprio processo Node, a decidir conforme infra do Render disponível).
- `src/demurrage-engine/scheduler/failureTracker.ts` (contagem de falhas consecutivas por BL/armador, zera em sucesso, agrupa incidentes do mesmo armador).
- `src/demurrage-engine/alerts/technicalAlertRecipients.ts` (lê a lista configurável — trilho T2).

**Arquivos existentes afetados:** `src/config.ts` ganha `trackingAlertRecipients: string[]` (env var). Nenhum arquivo da V1.

**Migrations:** entidade `tracking_failure` (armador, BL, contador, última resposta válida, histórico de tentativas).

**Dependências:** Fase 5 (a cadência só faz sentido chamando o adaptador real); trilho T2 (lista de destinatários configurável) e T1 (papel `MANAGER` já existir para receber o alerta operacional).

**Testes obrigatórios:**
- Simulação de relógio (mock de tempo) percorrendo D0→D+5→D+9→D+13→D+17→diário→a cada 2 dias→suspensão aos 30 dias, verificando a data da próxima consulta em cada etapa.
- Reaproveitamento: se outro consumidor já tiver tracking válido dentro da janela, a cadência não dispara nova consulta (Cap. 16.9) — depende do serviço real informar "quando foi obtido", conforme contrato da Fase 5.
- Falha consecutiva zera após sucesso; 3ª falha consecutiva dispara os dois alertas (operacional + técnico), agrupando por armador quando múltiplos processos são afetados.

**Condição de aceite:** para um contêiner de teste avançando no tempo simulado, o scheduler gera exatamente as consultas previstas pela cadência do Cap. 16 e suspende automaticamente aos 30 dias de demurrage sem Empty Return.

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

**Dependências:** Fases 1–8 completas o suficiente para o payload ter dado real; T1 (RBAC) para os gates de ação.

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

**Fase 9 (paralelo controlado):** o novo endpoint (`GET /api/demurrage/v2`) e a nova tela ficam disponíveis **ao lado** da V1, atrás de uma flag de acesso (ex.: rota separada acessível só a quem souber o link, ou flag de config `DEMURRAGE_V2_ENABLED`). Isso permite validar a V2 com dado real em produção sem expor todos os usuários a ela.

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
