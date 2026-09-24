# Diagnóstico — Blueprint Demurrage Priora V1 (Revisado V2) × Implementação Atual

**Data:** 23/09/2026
**Fonte:** `Blueprint_Demurrage_Priora_V1_Revisado_V2_Estilo_Priora.docx` (anexado pelo usuário)
**Escopo desta etapa:** diagnóstico e planejamento apenas. Nenhum código foi alterado.

**Código revisado:**
- `src/demurrage/demurrageFilters.ts` (filtro determinístico de e-mails)
- `src/demurrage/demurrageParser.ts` (extração via Clara/Gemini)
- `src/demurrage/demurrageStore.ts` (persistência de minuta solicitada + atividades)
- `src/routes/demurrageRoutes.ts` (montagem de cards, cálculo, KPIs)
- `public/Demurrage.dc.html` (tela operacional)
- `public/PortalCliente.dc.html` (aba Demurrage do portal do cliente)
- `src/middleware/requireAuth.ts`, `src/config.ts`, `src/tracking/types.ts`, `src/couriers/*` (infraestrutura correlata)
- Busca por `HeadCargo`, `Liberação`/`Liberacao` no repositório inteiro

---

## A. Diagnóstico do estado atual

O módulo Demurrage **existente é um MVP construído sobre uma arquitetura fundamentalmente diferente da descrita no Blueprint**. Isso não é um problema de "faltam features" isoladas — é uma diferença de desenho:

1. **Fonte de dados única e não estruturada.** Hoje, 100% do dado de demurrage vem da leitura de e-mails do Outlook por um filtro determinístico (`demurrageFilters.ts`) + extração livre por IA generativa (`demurrageParser.ts`, Gemini). Não existe nenhuma integração com tracking de armador (MSC, Maersk, etc.), nem com MBL/House estruturado, nem com HeadCargo. O Blueprint pressupõe uma **hierarquia de fontes documentais/estruturadas** (Cap. 4) com tracking do armador como fonte prioritária — isso simplesmente não existe.
2. **Sem persistência de estado por contêiner.** O endpoint `GET /api/demurrage` **recalcula tudo do zero a cada chamada**, varrendo a caixa de entrada do Outlook e rodando a IA de novo. Não há um registro individual do contêiner ("fotografia", Cap. 14), não há versionamento de fotografia, não há histórico de eventos. Isso inviabiliza, por construção, cadência de tracking (Cap. 16), atualização em segundo plano (Cap. 17), contagem de falhas consecutivas (Cap. 18) e boa parte da Parte 2 do Blueprint.
3. **Um relógio, não dois.** O modelo atual (`DemurrageContainer`) tem **um único** `freeTimeDias`/`diaria`/`moeda` por contêiner. Não existe a distinção House Free Time (cliente) × Master Free Time (Rocket) que é o núcleo do Blueprint (Cap. 5). Consequentemente, não existe exposição da Rocket, nem diferença potencial, nem os dois relógios independentes exigidos em quase todos os capítulos.
4. **Sem tabelas tarifárias.** `diaria` é um número que a IA tenta adivinhar do texto do e-mail. Não há tabela Rocket×cliente, não há as 12 tabelas de armadores do Cap. 24.3.1, não há versionamento, não há faixas progressivas. Isso é puramente um valor "encontrado no texto", quando encontrado.
5. **Marco temporal diferente do Blueprint.** O campo que ancora o cálculo hoje é `dataRetirada` ("retirada do contêiner do porto/terminal"), não a **data de descarga** do navio que o Blueprint define como Dia 1 dos dois relógios (Cap. 1, 5, 6). Retirada normalmente é posterior à descarga — ver divergência detalhada abaixo.
6. **Sem permissões/papéis.** A autenticação é só "logado com a Microsoft ou não" (`requireAuth.ts`). Não existem os perfis Analista / Gestor / Responsável técnico do Cap. 10, nem trilha de auditoria por campo (valor anterior, novo, usuário, motivo, evidência).
7. **Estados e prioridade simplificados.** `ContainerStatus` tem 5 valores (`custo_ativo`, `risco`, `pendencia`, `encerrado`, `indefinido`) contra os ~10 estados por contêiner do Cap. 21 e a fila de prioridade de 5 níveis com desempate de 5 critérios do Cap. 22.
8. **Portal do Cliente é mock.** A aba "Demurrage" de `PortalCliente.dc.html` é **inteiramente dado estático hard-coded** no componente (`statusGeral:'Em demurrage', pendencias:[...]` etc.) — não chama `/api/demurrage` nem nenhum outro endpoint real. O Cap. 32 (o que pode/não pode aparecer ao cliente) ainda não se aplica porque não há integração real para vazar dado nenhum — mas também significa que a funcionalidade do capítulo simplesmente não existe.
9. **Sem HeadCargo, sem Liberação.** Confirmado por busca no repositório: não há nenhuma referência a HeadCargo em código, e o módulo Liberação (citado no Cap. 26 como fonte da pré-análise de responsabilidade) não tem nenhuma implementação de backend nesta base de código — só existe uma página estática (`Liberacao.dc.html`) sem endpoint. A pré-análise de responsabilidade do Cap. 26 depende disso e está bloqueada até essa investigação ser resolvida (ver Seção H).

**O que já existe e está alinhado com o Blueprint (fundação aproveitável):**
- Separação processo (unidade de apresentação) × contêiner (unidade de cálculo) — Cap. 3. Isso já é assim no código (`acc.containers: Map`, `calcContainer` por contêiner, soma no card). É a peça mais bem alinhada de todo o módulo.
- Filosofia de "nunca inventar valor" — campos ausentes viram `null`, a UI mostra "a confirmar" em vez de fabricar dado. Isso é coerente com o espírito do Cap. 12, mesmo sem a taxonomia formal de exceções do Blueprint.
- Um fluxo operacional de "solicitar minuta" (cria rascunho de resposta no Outlook) e log de atividades — embrião do Cap. 20, bem mais simples.
- UI de fila com cards, KPIs e "maior risco" — embrião funcional do Cap. 28, precisa de bastante trabalho para chegar à especificação completa.

**Conclusão prática:** a maior parte do Blueprint (Partes 2 e 3 quase inteiras, e boa parte da Parte 1) exige uma **reconstrução do modelo de dados e da fonte de verdade**, não um ajuste incremental do código atual. O trabalho de maior risco/esforço é: (a) obter uma fonte de tracking do armador estruturada, (b) migrar de "stateless recomputado a cada request" para um registro persistente por contêiner, e (c) introduzir os dois relógios. Sem essas três peças, quase nenhum capítulo da Parte 2 e Parte 3 pode ser implementado com fidelidade.

---

## B. Classificação por capítulo

| # | Capítulo | Classificação | Nota curta |
|---|---|---|---|
| 1 | Visão e objetivo | PARCIALMENTE IMPLEMENTADO | Acompanha contêiner até devolução/minuta, mas sem "dois relógios" e com marco temporal diferente. |
| 2 | Escopo e responsabilidades | PARCIALMENTE IMPLEMENTADO | Há noção operacional/comercial, mas sem registro formal de fonte+timestamp por dado. |
| 3 | Entidades e unidade de controle | IMPLEMENTADO | Processo (card) × contêiner (cálculo) já é a arquitetura do código. |
| 4 | Fontes de dados e hierarquia | NÃO IMPLEMENTADO | Fonte única (e-mail + IA); sem hierarquia, sem MANUAL_FALLBACK, sem registro de fonte por campo. |
| 5 | Motor dos dois relógios | NÃO IMPLEMENTADO | Um único free time/diária por contêiner; não existe relógio Rocket. |
| 6 | Regras temporais e datas derivadas | IMPLEMENTADO DE FORMA DIFERENTE | Ver divergência detalhada — âncora errada + off-by-one aparente. |
| 7 | Modelos comerciais (Termo Único × Embarque) | NÃO IMPLEMENTADO | Não existe o conceito de termo comercial no modelo de dados. |
| 8 | Tarifas e versionamento | NÃO IMPLEMENTADO | Sem tabelas, sem versão, sem faixas; `diaria` é texto livre interpretado pela IA. |
| 9 | Tipos de contêiner e normalização | NÃO IMPLEMENTADO | Não há campo de tipo de equipamento (20'DV, 40'HC...) em lugar nenhum do schema. |
| 10 | Permissões, governança, auditoria | NÃO IMPLEMENTADO | Só existe "autenticado"/"não autenticado"; sem papéis; sem trilha de auditoria por campo. |
| 11 | Estados financeiros e valores internos | PARCIALMENTE IMPLEMENTADO | Só valor do cliente existe; sem exposição Rocket nem diferença potencial. |
| 12 | Integridade de dados e exceções estruturais | PARCIALMENTE IMPLEMENTADO | Filosofia "não inventar" presente; taxonomia formal de exceções ausente. |
| 13 | Entrada no monitoramento | NÃO IMPLEMENTADO | Não há registro persistente de "contêiner entrou em monitoramento". |
| 14 | Fotografia inicial | NÃO IMPLEMENTADO | Tudo é recalculado a cada GET; não existe fotografia nem versionamento. |
| 15 | Serviço central de tracking | NÃO IMPLEMENTADO | Não existe tracking de armador; nem cache/reuso entre módulos para esse domínio. |
| 16 | Cadência automática de tracking | NÃO IMPLEMENTADO | Sem scheduler, sem D0/D+5/D+9/D+13/D+17, sem suspensão em 30 dias. |
| 17 | Atualização em segundo plano | NÃO IMPLEMENTADO | Sem job em background; sem botão exclusivo do Gestor; sem cooldown de 2h. |
| 18 | Falhas de tracking e alertas | NÃO IMPLEMENTADO | Sem conector para falhar; sem contagem de 3 falhas consecutivas; sem alerta ao dev. |
| 19 | Detecção da devolução | IMPLEMENTADO DE FORMA DIFERENTE | `dataDevolucao` vem da IA lendo o e-mail, não de evento estruturado Empty Return; sem `effective_return_date`. |
| 20 | Minuta e conclusão do processo | PARCIALMENTE IMPLEMENTADO | Flag booleana + ação de solicitar existem; sem os 3 estados separados do Cap. 20.3. |
| 21 | Estados do ciclo operacional | IMPLEMENTADO DE FORMA DIFERENTE | 5 estados simples vs. ~10 estados por contêiner com faixas de dias (1–6/7–14/15+). |
| 22 | Prioridade da fila operacional | IMPLEMENTADO DE FORMA DIFERENTE | Ordenação simples por valor/dias; sem os 5 níveis nem os 5 critérios de desempate. |
| 23 | Apuração dos dias por contêiner | IMPLEMENTADO DE FORMA DIFERENTE | Ver divergência detalhada (mesma raiz do Cap. 6). |
| 24 | Cálculo do valor do cliente e exposição Rocket | PARCIALMENTE / NÃO IMPLEMENTADO | Valor do cliente existe (flat rate); exposição Rocket, faixas e tabelas de armador: nada. |
| 25 | Consolidação dos valores do processo | PARCIALMENTE IMPLEMENTADO | Soma do lado cliente existe; falta soma de exposição Rocket, diferença potencial, sinalização de mistura de estados. |
| 26 | Pré-análise de responsabilidade | IMPLEMENTADO DE FORMA DIFERENTE | Campo `responsavel` é um "chute" da IA a partir do e-mail, não da linha do tempo da Liberação. Sem fluxo de confirmação do Gestor. |
| 27 | Integração financeira (HeadCargo) | NÃO IMPLEMENTADO | Nenhuma referência a HeadCargo no repositório. |
| 28 | Tela operacional e cards | PARCIALMENTE IMPLEMENTADO | Estrutura de card/fila existe; faltam MBL, armador, filtros (28.7), ações (histórico, correção, tratativa). |
| 29 | Detalhamento do processo | NÃO IMPLEMENTADO | Existe expand/collapse simples; não há linha do tempo, documentos/evidências, ações de Gestor. |
| 30 | Gestão, indicadores, visão financeira | NÃO IMPLEMENTADO | Não existe uma visão de Gestão separada com os indicadores do Cap. 30. |
| 31 | Exceções operacionais e casos de borda | NÃO IMPLEMENTADO / PRECISA DE INVESTIGAÇÃO | Dependem de features ainda inexistentes (tracking, tabelas, fallback manual). |
| 32 | Portal do Cliente | NÃO IMPLEMENTADO | Aba Demurrage do portal é 100% mock estático; sem integração real, sem guarda de campos internos. |

---

## Divergências detalhadas (pontos de maior risco/atenção)

### D1 — Marco temporal: "data de descarga" vs. `dataRetirada`
1. **Regra do Blueprint:** os dois relógios (cliente e Rocket) começam na **data de descarga** confirmada pelo tracking do armador (Cap. 1, 5, 6). Dia 1 do free time = data de descarga.
2. **Comportamento atual:** `demurrageParser.ts` define `dataRetirada` como "data de retirada do contêiner do porto/terminal" — semanticamente mais próxima do **Gate Out** (Cap. 16.2) do que da descarga do navio. É esse campo que `calcContainer` usa como âncora do prazo.
3. **Arquivos envolvidos:** `src/demurrage/demurrageParser.ts` (schema/prompt), `src/routes/demurrageRoutes.ts` (`calcContainer`).
4. **Risco:** **Alto.** Descarga normalmente antecede a retirada em alguns dias. Se o free time real conta a partir da descarga e o sistema conta a partir da retirada, o prazo calculado fica sistematicamente maior do que o real — subestimando demurrage já devida ou atrasando o alerta ao operador.
5. **Mudança técnica necessária:** introduzir campo `dataDescarga` (fonte: tracking do armador) como âncora oficial dos dois relógios; `dataRetirada`/Gate Out passa a ser um evento informativo (Cap. 16.2/16.3), não o marco de cálculo.
6. **Dependências:** depende da fonte de tracking do armador (D5) existir — sem ela, não há como obter "data de descarga" de forma confiável; hoje o único dado disponível é o que a IA encontra no texto do e-mail, que às vezes menciona retirada, às vezes descarga, sem garantia.
7. **Testes necessários:** casos com descarga e retirada em datas diferentes (a diferença deve mudar o resultado); caso "só temos retirada, não temos descarga" → deve virar pendência, não fallback silencioso para retirada.

### D2 — Contagem de dias: possível off-by-one
1. **Regra do Blueprint (Cap. 6, 23):** para free time de N dias — dia 1 do prazo = data de descarga; último dia livre = descarga + (N−1); primeiro dia de demurrage = descarga + N.
2. **Comportamento atual:** `calcContainer` calcula `deadlineMs = retiradaMs + freeTimeDias * MS_DIA` e considera **ainda dentro do prazo** (`status: 'risco'`, sem custo) no dia exatamente igual a `retirada + N`. Custo só começa em `retirada + N + 1`. Ou seja, o sistema concede efetivamente **N+1 dias livres** contando a partir de `dataRetirada`, não N dias a partir de uma data de "dia 1".
3. **Arquivos envolvidos:** `src/routes/demurrageRoutes.ts` (`calcContainer`, função `diffDias`).
4. **Risco:** **Alto** (impacto financeiro direto — under-billing de 1 dia por contêiner, sistemático). Combinado com D1 (âncora errada), o efeito pode ser maior que 1 dia.
5. **Mudança técnica necessária:** redefinir a fórmula para bater exatamente com a tabela do Cap. 23.1 (a própria tabela do Blueprint é o gabarito de teste: descarga 01/09, FT 14 dias → 14/09 = 0 dias, 15/09 = 1 dia, 20/09 = 6 dias).
6. **Dependências:** nenhuma além de D1 (a fórmula precisa ser corrigida junto com a troca de âncora).
7. **Testes necessários:** reproduzir literalmente a tabela do Cap. 23.1 como casos de teste unitário (5 linhas dadas no Blueprint) — deve ser o primeiro teste automatizado do motor de cálculo.
   - Nota adicional: hoje `hojeMs = Date.now()` (com hora do dia) é comparado a `deadlineMs` derivado de uma data (meia-noite). Isso faz o card virar "custo_ativo" no mesmo dia-calendário do deadline, a qualquer hora depois da meia-noite — mais uma fonte de imprecisão a resolver junto da correção acima. Marcar como **PRECISA DE INVESTIGAÇÃO** quanto ao comportamento exato desejado em fuso horário (o Blueprint não fala de fuso horário — ver Seção H). **Resolvido (plano de migração, revisão 5):** o motor temporal da V2 trabalha só com datas civis `YYYY-MM-DD`, sem hora e sem conversão UTC — o problema descrito aqui é da V1 e não existe na V2.

### D3 — Dois relógios independentes (House × Master)
1. **Regra do Blueprint:** todo o Cap. 5 — cada contêiner tem relógio do cliente (House FT) e relógio da Rocket (Master FT), calculados separadamente, podendo vencer em datas diferentes.
2. **Comportamento atual:** `DemurrageContainer` tem um único conjunto de campos (`freeTimeDias`, `diaria`, `moeda`). Não há qualquer campo para Master Free Time nem exposição da Rocket.
3. **Arquivos envolvidos:** `src/demurrage/demurrageParser.ts` (schema de extração e prompt), `src/routes/demurrageRoutes.ts` (`ContainerCalc`, `calcContainer`, `DemurrageCard`), `public/Demurrage.dc.html` (toda a apresentação assume um único valor por contêiner).
4. **Risco:** **Crítico.** É o requisito central do Blueprint; sem isso, a exposição da Rocket e a diferença potencial (indicador de gestão citado repetidamente) não podem existir.
5. **Mudança técnica necessária:** duplicar o modelo de free time/tarifa/valor em `cliente` e `rocket` no `DemurrageContainer`/`ContainerCalc`; duplicar toda a lógica de `calcContainer` para os dois relógios; refazer a UI para mostrar os dois relógios separadamente (Cap. 28.4).
6. **Dependências:** depende de D5 (tabelas) para a exposição da Rocket ter um valor calculável, e da fonte de Master Free Time (Master BL) existir (D6).
7. **Testes necessários:** casos onde só um relógio vence, casos onde os dois vencem em datas diferentes, caso onde cliente está em demurrage e Rocket não (e vice-versa).

### D4 — Fonte de dados e hierarquia
1. **Regra do Blueprint:** Cap. 4 define uma matriz fonte-prioritária/contingência por dado (ex.: House Free Time vem do House/Shipping Instructions/Auditoria, com HeadCargo como contingência e MANUAL_FALLBACK como último recurso auditado).
2. **Comportamento atual:** todo dado vem de uma única fonte — texto de e-mail interpretado por IA generativa, sem hierarquia, sem registro de "de onde veio este número", sem MANUAL_FALLBACK formal (o campo simplesmente é `null` quando a IA não encontra).
3. **Arquivos envolvidos:** `src/demurrage/demurrageParser.ts`, `src/demurrage/demurrageFilters.ts`.
4. **Risco:** **Crítico** — é pré-requisito estrutural de quase toda a Parte 1 e 2 do Blueprint (auditoria, confiabilidade, MANUAL_FALLBACK, resolução de divergência entre fontes).
5. **Mudança técnica necessária:** modelar `DadoComFonte<T>` (valor, fonte, timestamp, fonte alternativa quando aplicável) para cada campo crítico (descarga, House FT, Master FT, tipo de contêiner, devolução); implementar conectores estruturados para tracking do armador, MBL e House antes de a IA sobre e-mail poder ser apenas uma contingência, não a fonte primária.
6. **Dependências:** depende de decisão sobre como obter tracking de armador estruturado (ver Seção H) — sem isso, a fonte primária definida pelo Blueprint continua indisponível.
7. **Testes necessários:** conflito entre duas fontes para o mesmo campo (deve manter ambas e sinalizar divergência, não escolher silenciosamente); MANUAL_FALLBACK só deve ser aceito quando não houver nenhuma fonte aprovada preenchida.

### D5 — Tabelas tarifárias (Rocket×cliente e armadores) e versionamento
1. **Regra do Blueprint:** Cap. 8 e 24 — tabela Rocket por tipo de equipamento (Termo por Embarque), tabela do Termo Único com faixas paralelas ao free time, e 12 tabelas de armadores (MSC, Hapag-Lloyd, CMA CGM, Maersk, ONE, PIL, Yang Ming, HMM, Evergreen, COSCO, OOCL, ZIM) com faixas, estados `CONFIRMED`/`ESTIMATED`/`ESTIMATED_PROVISIONAL`/`UNAVAILABLE`.
2. **Comportamento atual:** nenhuma tabela existe em código, configuração ou banco. `diaria` é um número solto que a IA tenta extrair do texto do e-mail.
3. **Arquivos envolvidos:** nenhum — é uma lacuna completa, exige novos módulos (`src/demurrage/tarifas/` sugerido).
4. **Risco:** **Alto** — sem tabelas, a exposição da Rocket (D3) não pode ser calculada, e o valor do cliente no Termo Único (faixas) também não pode ser fiel ao Blueprint.
5. **Mudança técnica necessária:** modelar tabela versionada (armador/Rocket, tipo de equipamento, faixas de dia, valor/dia, vigência, status de confiabilidade); carregar as tabelas já fornecidas no Blueprint (Cap. 24.1 e 24.3.1) como seed inicial; implementar motor de posicionamento em faixa "em paralelo ao free time, desde a descarga" (não reinicia na primeira faixa ao fim do FT).
6. **Dependências:** depende de D1/D2 (data de descarga correta) para posicionar corretamente a faixa tarifária.
7. **Testes necessários:** reproduzir os exemplos do Cap. 24 (posição em faixa que não é a primeira, mesmo com FT diferente do padrão da tabela); teste específico da PIL (estimativa por ponto médio, nunca `CONFIRMED`); teste de tabela incompleta (Yang Ming/COSCO/ZIM) retornando `UNAVAILABLE` em vez de aproximação por semelhança.

### D6 — Serviço central de tracking + cadência + falhas
1. **Regra do Blueprint:** Cap. 15–18 — serviço único de consulta a armadores, com cache/reuso entre módulos, cadência D0/D+5/D+9/D+13/D+17 → diário → a cada 2 dias em demurrage → suspensão em 30 dias, contagem de falhas consecutivas e alerta duplo (Gestor + dev) na 3ª falha.
2. **Comportamento atual:** não existe nenhuma integração com tracking de armador. `src/tracking/types.ts` e `src/couriers/*` são infraestrutura de rastreio de **courier de parcela** (FedEx/DHL), domínio totalmente diferente (encomendas, não contêineres marítimos) e não compartilham cache entre módulos hoje (`courierStore.ts` tem cache próprio em memória/arquivo, isolado).
3. **Arquivos envolvidos:** nenhum arquivo hoje cobre isso; exige serviço novo, ex. `src/tracking/armadorTrackingService.ts`, mais um scheduler (cron/job) para a cadência.
4. **Risco:** **Crítico** — sem isso, não há Empty Return estruturado, não há Gate Out estruturado, e o sistema continua 100% dependente de e-mail chegar e a IA interpretar corretamente, o que não bate com a confiabilidade que o Blueprint pressupõe.
5. **Mudança técnica necessária:** (a) decidir a fonte técnica de tracking por armador — ver Seção H; (b) construir serviço central com cache/TTL e reuso cross-módulo; (c) construir scheduler de cadência; (d) construir contador de falhas consecutivas por BL/armador com agregação de incidentes e alertas.
6. **Dependências:** bloqueado até decisão de integração de tracking (Seção H). É provavelmente o maior bloco de esforço de todo o Blueprint.
7. **Testes necessários:** simulação de cadência (mock de relógio); teste de reuso de cache entre duas "chamadas" de módulos diferentes; teste de contagem de falhas consecutivas zerando após sucesso; teste de suspensão automática aos 30 dias.

### D7 — Permissões, papéis e auditoria
1. **Regra do Blueprint:** Cap. 10 — três papéis (Analista, Gestor, Responsável técnico) com capacidades distintas; toda alteração de dado crítico gera histórico (valor anterior, novo, usuário, data, motivo, evidência).
2. **Comportamento atual:** `requireAuth.ts` só verifica se há uma conta Microsoft ativa logada — não existe conceito de papel/perfil em lugar nenhum do sistema (nem para Demurrage nem para os outros módulos, pelo que foi observado).
3. **Arquivos envolvidos:** `src/middleware/requireAuth.ts`, `src/auth/*`; não há modelo de usuário/papel persistido.
4. **Risco:** **Alto** — bloqueia diretamente Cap. 17 (botão exclusivo do Gestor), Cap. 26.3 (confirmação exclusiva do Gestor), MANUAL_FALLBACK (exclusivo do Analista com notificação ao Gestor), e toda a trilha de auditoria.
5. **Mudança técnica necessária:** introduzir modelo de usuário com papel (ou reaproveitar grupos do Azure AD, se existir), gate de autorização por papel nas rotas sensíveis, e uma tabela de auditoria genérica (entidade, campo, valor anterior, valor novo, usuário, timestamp, motivo, evidência).
6. **Dependências:** decisão de produto sobre como papéis são atribuídos (ver Seção H) — o Blueprint não define isso, é uma decisão de implementação da Priora.
7. **Testes necessários:** Analista tentando alterar campo já preenchido por fonte aprovada (deve ser bloqueado); Gestor corrigindo dado crítico (deve gerar entrada de auditoria completa); MANUAL_FALLBACK gerando notificação ao Gestor.

### D8 — Minuta, Empty Return e `effective_return_date`
1. **Regra do Blueprint:** Cap. 19.1 — minuta validada define `effective_return_date`, que prevalece sobre a data do tracking; divergência entre as duas datas preserva ambas as evidências e é registrada; se alterar processo já concluído, exige reabertura pelo Gestor.
2. **Comportamento atual:** existe só um campo `dataDevolucao` (vindo da IA lendo e-mail) e um booleano `minutaRecebida`; não há dois eventos separados (tracking vs. minuta), não há `effective_return_date`, não há lógica de "qual prevalece", não há fluxo de reabertura.
3. **Arquivos envolvidos:** `src/demurrage/demurrageParser.ts`, `src/routes/demurrageRoutes.ts`.
4. **Risco:** Médio-Alto — afeta diretamente o fechamento financeiro final e a confiabilidade da data usada no cálculo de dias cobrados.
5. **Mudança técnica necessária:** separar `trackingReturnDate` (evento operacional) de `minutaReturnDate` (comprovação documental); campo derivado `effectiveReturnDate` = minuta quando validada, senão tracking; fluxo de reabertura restrito a Gestor quando a minuta alterar um processo já fechado.
6. **Dependências:** depende de D6 (tracking estruturado) para o evento Empty Return deixar de vir só da leitura de e-mail.
7. **Testes necessários:** minuta com data diferente do Empty Return (preserva as duas, usa a da minuta); minuta chegando depois do processo já "concluído sem custo" e criando custo (deve ir para reabertura do Gestor, não recalcular silenciosamente).

### D9 — Pré-análise de responsabilidade Rocket × cliente
1. **Regra do Blueprint:** Cap. 26 — sugestão automática baseada na linha do tempo do módulo Liberação (interseção entre dias em demurrage e período em que a liberação dependia só da Rocket), com confirmação obrigatória do Gestor e registro completo da decisão.
2. **Comportamento atual:** campo `responsavel` (`cliente`/`armador`/`despachante`/`terminal`/`desconhecido`) é **inferido livremente pela IA a partir do texto do e-mail** — não há cálculo de interseção de datas, não há consulta ao módulo Liberação (que, por sua vez, não tem backend nesta base de código), não há fluxo de confirmação do Gestor nem registro de decisão.
3. **Arquivos envolvidos:** `src/demurrage/demurrageParser.ts` (prompt/schema), `src/routes/demurrageRoutes.ts`.
4. **Risco:** Médio — hoje é só um rótulo informativo na Clara note; não é usado para nenhum cálculo financeiro, então o risco imediato é baixo, mas a lacuna é grande frente ao Blueprint.
5. **Mudança técnica necessária:** depende inteiramente de um módulo Liberação com linha do tempo estruturada e consultável (hoje inexistente). Até lá, este capítulo não pode ser implementado com fidelidade.
6. **Dependências:** **bloqueado por módulo externo** (Liberação) — ver Seção H.
7. **Testes necessários:** reprodução do exemplo do Cap. 26.2 (demurrage 15/09, Rocket libera 17/09, Empty Return 20/09 → sugestão 15–17 Rocket, 18–20 cliente) assim que a fonte de dados existir.

### D10 — Portal do Cliente
1. **Regra do Blueprint:** Cap. 32 — o portal mostra só dados do relógio do cliente; uma lista explícita de dados internos (Master FT, exposição Rocket, tabela do armador, diferença potencial, pré-análise de responsabilidade, falhas técnicas) **nunca** pode aparecer.
2. **Comportamento atual:** a aba Demurrage de `PortalCliente.dc.html` é inteiramente dado mockado no próprio componente (`statusGeral`, `pendencias`, `cur.dem.*` fixos no `state`) — não há chamada a `/api/demurrage` nem a nenhum endpoint real.
3. **Arquivos envolvidos:** `public/PortalCliente.dc.html`.
4. **Risco:** Hoje, **nenhum** (não há dado real, não há como vazar nada). Mas é um risco **futuro direto** assim que alguém conectar essa aba à API real: o payload atual de `GET /api/demurrage` já inclui `responsavel`, `motivo` e `clara` (nota interna da Clara) — se o mesmo endpoint for reaproveitado sem filtro para alimentar o Portal, esses três campos (e, no futuro, Master FT/exposição Rocket) vazariam informação interna ao cliente, violando diretamente o Cap. 32.2.
5. **Mudança técnica necessária:** quando o Portal for implementado de verdade, criar um **endpoint dedicado e filtrado** (nunca reaproveitar o payload do analista), retornando apenas os campos da lista 32.1.
6. **Dependências:** depende de D3 (dois relógios) para sequer existir o "Master FT" que precisa ser escondido — hoje o campo nem existe, então o risco é estrutural/de desenho, não um bug atual.
7. **Testes necessários:** teste de contrato do endpoint do portal garantindo que nenhum campo da lista 32.2 apareça no payload, independentemente de mudanças futuras no endpoint interno (teste de regressão de "vazamento de campo").

---

## C. Ordem recomendada de implementação

A ordem segue dependências técnicas reais, não a ordem dos capítulos do Blueprint:

1. **Fundamentos de dados (bloco 0, pré-requisito de tudo):**
   - Decidir e viabilizar a fonte de tracking de armador (Seção H) — sem isso, os blocos 2–5 abaixo não podem ser fiéis ao Blueprint.
   - Decidir modelo de papéis/permissões (Seção H).
   - Investigar o estado real do módulo Liberação (Seção H) — só bloqueia D9/Cap. 26, pode ficar para depois.
2. **Modelo de dados persistente por contêiner** (substitui o "recalcula tudo a cada GET"): entidade Contêiner com fotografia versionada, histórico de eventos, dois conjuntos de free time/tarifa/valor (cliente/Rocket), fonte+timestamp por campo. Este é o alicerce de tudo daqui pra frente.
3. **Motor de datas e cálculo (Cap. 6, 23, 24):** corrigir âncora temporal (D1) e fórmula de dias (D2); implementar tabelas tarifárias versionadas com seed das tabelas do Blueprint (D5); implementar cálculo separado cliente/Rocket (D3). Cobrir com os testes literais do Cap. 23.1 e 24 antes de seguir.
4. **Serviço central de tracking + cadência (Cap. 15–18)** (D6): maior bloco de esforço; pode ser feito em paralelo ao item 3 já que ambos dependem do item 2, mas não um do outro.
5. **Estados, prioridade e minuta/Empty Return (Cap. 19–22)** (D8): passa a consumir os eventos do serviço de tracking.
6. **Permissões e auditoria (Cap. 10)** (D7): pode começar em paralelo ao item 2, já que é ortogonal ao motor de cálculo, mas precisa estar pronto antes de qualquer ação "exclusiva do Gestor" (cooldown de tracking manual, correção de dado crítico, confirmação de responsabilidade).
7. **Tela operacional completa (Cap. 28–29):** depende de 2–6 estarem disponíveis via API para ter o que mostrar; pode ser incrementado em paralelo conforme cada capítulo do backend fica pronto (não precisa esperar tudo).
8. **Pré-análise de responsabilidade (Cap. 26)** (D9): só depois do módulo Liberação ter uma fonte consultável.
9. **Integração financeira HeadCargo (Cap. 27)** e **Gestão/indicadores (Cap. 30):** o próprio Blueprint trata isso como integração "quando disponível" — pode ficar por último sem prejudicar o resto.
10. **Portal do Cliente (Cap. 32)** (D10): implementar por último, como endpoint filtrado dedicado, só depois que os dados reais (itens 2–5) existirem — implementar antes disso só reforçaria a mockagem atual.

---

## D. Migrações / modelos de dados necessários

*(descrição conceitual das entidades — não é schema de código ainda; escopo é diagnóstico)*

- **Contêiner (monitoramento):** id, processo, número, tipo original + tipo normalizado + regra de mapeamento aplicada, armador, BL (House/Master), estado operacional, prioridade+motivo, timestamps de criação/última atualização.
- **Evento de tracking:** contêiner_id, tipo de evento (descarga, gate out, empty return, etc.), data do evento, fonte (armador/conector), data/hora da consulta, payload bruto, versão da fotografia gerada.
- **Fotografia (snapshot versionado):** contêiner_id, versão, todos os campos do Cap. 14.2, timestamp, evento que originou a nova versão.
- **Campo com fonte (`DadoComFonte<T>`):** usado para descarga, House FT, Master FT, tipo de contêiner, devolução — valor, fonte, timestamp, fonte alternativa consultada, divergência (se houver, mantém os dois valores).
- **Relógio (cliente e Rocket, duas instâncias por contêiner):** free time, último dia livre, primeiro dia de demurrage, dias de demurrage, data final de apuração, estado (aberto/fechado/pendente).
- **Tabela tarifária (Rocket×cliente e armador):** entidade, versão, vigência, tipo de equipamento, faixas (dia inicial, dia final ou aberto, valor/dia), status (`CONFIRMED`/`ESTIMATED`/`ESTIMATED_PROVISIONAL`/`UNAVAILABLE`), fonte.
- **Valor apurado (memória de cálculo):** contêiner_id, relógio (cliente/Rocket), dias cobrados, faixa aplicada por dia, tarifa, versão da tabela, total, estado, moeda, data de congelamento (quando fechado).
- **Responsabilidade (pré-análise):** contêiner_id, data apta para liberação, data de liberação efetiva, intervalo sugerido, dias confirmados Rocket/cliente, justificativa, evidências, gestor, timestamp da decisão.
- **Minuta:** contêiner_id, data informada, número de contêiner validado, data validada (`effective_return_date` quando aceita), divergência com tracking (se houver), usuário, timestamp, estado de conferência.
- **Usuário/Papel:** usuário, papel (Analista/Gestor/Responsável técnico), escopo (se aplicável).
- **Auditoria (genérica):** entidade, campo, valor anterior, valor novo, usuário, timestamp, motivo, evidência vinculada.
- **Falha de tracking:** armador, BL, contador de falhas consecutivas, última resposta válida, histórico de tentativas, incidente agrupado (quando aplicável).

---

## E. Serviços / backend necessários

- **Serviço central de tracking de armador** (novo): abstração por armador, cache com TTL, reuso cross-módulo, contagem de falhas, alertas.
- **Scheduler/worker de cadência** (novo): job em background para D0/D+5/.../diário/a cada 2 dias/suspensão em 30 dias — hoje não há nenhuma infraestrutura de jobs agendados no repositório (fora do workflow de keep-alive do GitHub Actions, que é outra coisa).
- **Motor de cálculo dual (cliente/Rocket)** (reescrita de `calcContainer`): duas passagens, uma por relógio, usando tabelas versionadas.
- **Serviço de tabelas tarifárias**: CRUD/consulta de tabelas com versionamento e vigência; seed inicial com as tabelas do Blueprint.
- **Serviço de auditoria genérico**: gravação e consulta de histórico de alterações, reutilizável por outros módulos também.
- **Camada de papéis/permissões**: middleware de autorização por papel, aplicado nas rotas sensíveis (atualização manual de tracking, correção de dado crítico, confirmação de responsabilidade, conclusão/reabertura de processo).
- **Endpoint dedicado ao Portal do Cliente**: novo, filtrado, nunca reaproveitando o payload interno de `/api/demurrage`.
- **Cliente HeadCargo (somente leitura)**: quando a integração estiver disponível — endpoint de consulta de status financeiro, sem escrita.
- **Serviço de resolução do módulo Liberação** (ou dependência de que ele exista): para alimentar a pré-análise de responsabilidade.

---

## F. Alterações de frontend necessárias

- **`Demurrage.dc.html`:** reformular cards para mostrar os dois relógios separadamente (Cap. 28.4), adicionar MBL/armador/quantidade de contêineres devolvidos ao card (Cap. 28.2), implementar os filtros do Cap. 28.7 (hoje inexistentes), adicionar ações "consultar histórico", "solicitar correção", "registrar tratativa" (Cap. 28.6), adicionar indicação de exposição estimada/confirmada/indisponível.
- **Nova tela de detalhamento do processo** (Cap. 29): lista de contêineres detalhada, linha do tempo com eventos automáticos vs. ações humanas diferenciados, upload/vínculo de documentos e evidências, ações exclusivas de Gestor visíveis só para esse papel.
- **Nova visão de Gestão** (Cap. 30): indicadores operacionais, financeiros (somente leitura), de responsabilidade Rocket e de qualidade de tracking, com segregação por moeda.
- **`PortalCliente.dc.html` (aba Demurrage):** substituir o mock por consumo real do novo endpoint filtrado (E); implementar as cores/estados do Cap. 32.3 (atenção especial ao caso "0 dias restantes ainda é dentro do prazo", que hoje nem existe pois é tudo mock).
- **Indicação de "última atualização" e "próxima consulta programada"** em qualquer tela que dependa do tracking (Cap. 17, 28.1, 29.1) — não existe hoje porque não há tracking assíncrono.
- **Botão "Atualizar tracking"** exclusivo do Gestor, com exibição do cooldown de 2h (Cap. 17.1) — não existe hoje.

---

## G. Plano de testes

**Unitários (motor de cálculo — prioridade máxima, bloco 0 antes de qualquer outra coisa):**
- Tabela do Cap. 23.1 literal (5 casos: 14/09→0, 15/09→1, 16/09→2, 20/09→6) para os dois relógios.
- Free time = 0 confirmado por fonte (cobrança começa no dia da descarga) vs. free time ausente (bloqueia cálculo, não trata como zero) — Cap. 31.3/31.4.
- Posicionamento em faixa tarifária que não é a primeira, com free time maior que o padrão da tabela do armador (Cap. 24.3, exemplo implícito).
- Exemplo do Cap. 26.2 (interseção de responsabilidade) assim que a fonte existir.
- PIL: estimativa por ponto médio, status sempre `ESTIMATED_PROVISIONAL`, nunca `CONFIRMED` (regra explícita do Blueprint).
- Tabelas incompletas (Yang Ming/COSCO/ZIM) retornando `UNAVAILABLE` em faixas sem dado, nunca aproximação por semelhança.

**Integração:**
- Ciclo completo descarga → free time → demurrage → Empty Return → minuta → fechamento, verificando os 3 estados separados do Cap. 20.3 em cada etapa.
- Divergência entre tracking e minuta preservando as duas evidências (D8).
- Reabertura de processo concluído exigindo papel Gestor + justificativa + preservação do valor anterior.
- Contrato do endpoint do Portal do Cliente: nenhum campo da lista 32.2 no payload (teste de regressão permanente).
- Cadência de tracking simulada (mock de relógio): sequência D0/D+5/D+9/D+13/D+17 → diário → a cada 2 dias em demurrage → suspensão aos 30 dias.
- Reuso de cache do serviço central entre duas chamadas de "módulos" diferentes dentro da mesma janela de validade.
- Contagem de falhas consecutivas de tracking, zerando após sucesso, disparando alerta duplo na 3ª falha.

**Permissões:**
- Analista bloqueado de alterar campo já preenchido por fonte aprovada; liberado para MANUAL_FALLBACK só na ausência total de fonte.
- Botão de atualização manual de tracking só visível/funcional para Gestor, respeitando cooldown de 2h.
- Auditoria gravando valor anterior/novo/usuário/motivo em toda alteração de dado crítico.

**Regressão do que já existe:**
- Suite atual (`npm test`, 25 casos de `preAlerta`) deve continuar passando — não é afetada por este módulo, mas serve de baseline de que nada foi quebrado incidentalmente durante a reconstrução.
- Se alguma parte do código atual de Demurrage for reaproveitada (ex.: a lógica de agrupamento processo/contêiner do Cap. 3, que já está correta), criar testes de caracterização antes de mexer, para não perder o comportamento correto já validado nesta sessão (ver conversa anterior: 401 sem auth, payload correto, etc.).

---

## H. Pontos que precisam de decisão humana antes de codificar

1. **Fonte técnica de tracking de armador.** O Blueprint assume que existe (ou existirá) uma forma de consultar tracking estruturado por armador (Cap. 4, 15). Não há nada disso no repositório hoje. **Pergunta em aberto:** a Priora já tem acesso a alguma API/scraping de armador em outro lugar (outro serviço, outro repo, uma ferramenta paga tipo Cargo Flows/GoComet/similar), ou isso precisa ser construído do zero por armador (MSC, Maersk, Hapag-Lloyd, CMA CGM, ONE, PIL, Yang Ming, HMM, Evergreen, COSCO, OOCL, ZIM)? Isso muda drasticamente o esforço e a ordem de implementação. **Marcado como PRECISA DE DECISÃO / INVESTIGAÇÃO — é o maior risco de todo o plano.**
2. **Estado real do módulo Liberação.** O Cap. 26 depende da "linha do tempo do processo" desse módulo. Nesta base de código, `Liberacao.dc.html` existe só como página estática, sem backend. **Pergunta:** o módulo Liberação está implementado em outro repositório/serviço da Priora, ou também precisa ser construído? Sem essa resposta, o Cap. 26 fica bloqueado indefinidamente.
3. **Integração HeadCargo.** O Blueprint fala em "endpoint de consulta" (Cap. 4, 27) sem detalhar autenticação, URL base, payload ou disponibilidade atual. **Pergunta:** essa API já existe e está acessível, ou é um item de roadmap do time do HeadCargo? O Blueprint já trata isso como wishlist ("quando a integração estiver disponível"), então isto pode ficar como `PRECISA DE DECISÃO` de baixa urgência — não bloqueia o restante do módulo.
4. **Modelo de papéis (Analista/Gestor/Responsável técnico).** O Blueprint define o que cada papel pode fazer, mas não define **como** um usuário recebe um papel na Priora (grupo do Azure AD? tabela própria? flag manual?). Hoje a autenticação é só "há uma conta Microsoft conectada" — não há conceito de papel em nenhum módulo do sistema, não só em Demurrage. **Decisão de arquitetura necessária antes do item D7.**
5. **Fuso horário e horário de corte para contagem de dias.** O Blueprint diz "não existe cálculo por hora" (Cap. 23.1) mas não especifica em que fuso horário o "dia" vira o próximo (UTC? horário de Brasília? horário do porto de descarga?). Isso afeta diretamente a borda entre "último dia livre" e "primeiro dia de demurrage" perto da meia-noite. **Marcar como PRECISA DE DECISÃO** — não inventar (ex.: assumir UTC) sem confirmação, já que isso tem efeito financeiro direto na borda dos dias. **Decidido (plano de migração, revisão 5):** a contagem usa datas civis, sem hora e sem conversão UTC; como um evento de tracking vira data civil é parte do contrato do Tracking Service (Fase 5).
6. **Regra de equivalência de tipos de contêiner (Cap. 9).** O próprio Blueprint diz que "a tabela de equivalências será definida quando tivermos a lista real de tipos recebidos" — **isso já está marcado como pendência pelo próprio documento**, não uma lacuna nossa. Registrar como `PRECISA DE DECISÃO` (do lado do time que escreveu o Blueprint) e não deduzir um mapeamento por conta própria.
7. **Regra de override do "fato gerador" no Termo Único (Cap. 8).** O Blueprint permite que "a documentação comercial do processo defina regra diferente" do fato gerador padrão. Não há definição de como/onde essa regra alternativa fica registrada no processo. **Decisão de modelagem necessária** antes de implementar o Termo Único por completo.
8. **Reaproveitamento vs. módulo isolado.** Dado que `src/tracking/types.ts` e `src/couriers/*` já existem para courier de parcela, vale decidir se o **serviço central de tracking de armador** (D6) deve nascer como uma extensão desse tracking genérico existente ou como um módulo totalmente separado (`src/demurrage/tracking/` ou `src/shipping-tracking/`), dado que os domínios (parcela vs. contêiner marítimo) são bem diferentes. Não é uma regra do Blueprint, é uma decisão de arquitetura interna da Priora — registrar aqui para não decidir sozinho na próxima etapa.

---

## Anexo — Escopo NÃO coberto por este diagnóstico

Por instrução explícita, esta etapa não alterou banco, interface ou regras existentes, e não propôs nenhuma regra que o Blueprint não definiu explicitamente. Qualquer lacuna do próprio Blueprint (Cap. 9 equivalências, Cap. 8 fato gerador alternativo) foi listada na Seção H como pendência a resolver com o time responsável pelo documento, não deduzida por conta própria.
