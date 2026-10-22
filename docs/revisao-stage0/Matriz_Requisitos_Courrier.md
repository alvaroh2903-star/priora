# Matriz de rastreabilidade de requisitos — Módulo Courrier (Priora)

> **Nota de publicação (22/10/2026).**
>
> **Revisão de código avaliada pela matriz:**
>
> - **Linha B:** `claude/busy-cori-8o1czj` @ **`0827452`** (20/10/2026). É a referência principal: `:NNN` sem arquivo é `src/routes/courierRoutes.ts` nessa revisão, e os outros arquivos estão indicados.
> - **Linha A:** `claude/demurrage-api-playwright-5q2lqq` @ **`ec52362`** (18/10/2026), só onde a linha diz "Linha A".
> - **Especificação:** Blueprint funcional do módulo Courrier, Revisão 3.0 (20/10/2026).
> - **Método:** inspeção de código (Cód). O único teste executado foi `linhas.test.ts` (Linha B, 7/7).
>
> **O que mudou depois** (verificado por `git` em 22/10/2026; as classes **não** foram reavaliadas):
>
> - **Stage 0 v2** (`8e055b0` → `9e1fcaa`): é só instrumentação e **não muda nenhuma classe**. Desligado, o comportamento é idêntico. Ligado, ele só **conta** as falhas de anexo, que continuam silenciosas para o usuário (ENT-003).
> - **Linha A → `8e055b0`:** mudou o caminho de anexos (listagem com `$select`, um `GET` por `itemAttachment`, 5 mensagens por vez). ENT-003 e DEP-01 continuam válidas; ver a ressalva de data abaixo.
> - **Linha B → `0ae78a9`** (6 commits):
>   - `courierRoutes.ts` ganhou 5 linhas: um import no topo e uma guarda antes do `requireAuth`. As referências podem estar deslocadas de 1 a 5 linhas.
>   - O `POST /reply-draft` passou a poder ser desligado por `PRIORA_ESCRITA_LEGADA_OUTLOOK`. Ausente ou `on` mantém o comportamento anterior. GOV-005 e CLA-001 continuam válidas, com essa ressalva.
>   - Os outros commits tocam Auditoria e Liberação (código não ligado), o provisionamento do piloto e a validação do `SESSION_SECRET`.
>   - Sem mudanças nos demais arquivos conferidos: telas Courier, Exigem Atenção, Relatórios e Fila de Decisões; `src/couriers`; rastreio (FedEx, DHL, `trackingRoutes`); `emailParser`/`geminiClient`; `graphService`; `operacional`; `identidade`; migrations do Courrier.

Extraída sem alterações da seção 2 de `Priora_Diagnostico_Courrier_Rev3.md` (diagnóstico Revisão 3, 21/10/2026). Uma linha por identificador do Blueprint (Revisão 3.0). Esta matriz descreve o estado funcional e **não** foi alterada pelo Stage 0, que é só instrumentação de medição.

Ressalva de data: as afirmações sobre o caminho de anexos foram feitas sobre `ec52362`. Depois dele, a Linha A recebeu `8e055b0` (listagem com `$select`, um `GET` por e-mail encaminhado e lotes de 5 mensagens). As linhas que citam o caminho de anexos (ENT-003, DEP-01) continuam válidas em `8e055b0`: mesmo teto de 25 mensagens, só e-mail encaminhado (`itemAttachment`), falhas silenciadas. As referências de linha (`:NNN`) seguem as da revisão 3.

## 2. Rastreabilidade de requisitos (matriz completa por identificador)

**Legenda.**

- **Classe:** **I** implementado; **P** parcial; **A** ausente; **C** conflitante; **D** dependente de esclarecimento (LAC, VAL ou DEP); **N/V** governança, não verificável em código.
- **Tipo de evidência:** **Cód** = inspeção de código; **Teste** = verificado por teste executado.

Salvo indicação, os caminhos são da Linha B (`courierRoutes.ts`, salvo outro arquivo indicado). A Linha A tem o mesmo núcleo, sem fatos duráveis.

**Cobertura por teste.** Nenhum CA-R ou CT-R tem teste automatizado. A única verificação por teste executado é parcial e cobre ENT-006 (`linhas.test.ts`).

### 2.1 GOV — Governança

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| GOV-001 | N/V | — | Regra de processo. Nenhuma decisão não aprovada foi adotada neste diagnóstico. |
| GOV-002 | C | Cód | Há regras no código sem aprovação: 5 estados (`courierStore.ts:23`; CHECK em `0101_courier_fatos.sql:57`); ETA ≤ 5 d e "parado ≥ 7 d" (`Exigem Atencao.dc.html:246`, `:249`); teto de 8 (`referenceResolver.ts:277`); rótulo "Não informado"; deduplicação por base (Linha A). Ver 6.3. |
| GOV-003 | C | Cód | `processosLiberados` (`:865-867`) e o texto "liberação bloqueada" (`Exigem Atencao:257`) invadem o escopo da Liberação. |
| GOV-004 | N/V | Cód | Coerente: não há simulação de HeadCargo nem de armador no Courrier. |
| GOV-005 | I | Cód | `reply-draft` só cria rascunho (`:1300-1322`); nenhum envio no Courrier. |

### 2.2 REL — Relações

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| REL-001 | P | Cód | Um card por tracking normalizado (`:526-571`). Não é persistido, não preserva a origem de cada informação e some fora do top 60. |
| REL-002 | A | Cód | Não há relação entre envelopes. |
| REL-003 | A | Cód | Não há correção de tracking. |
| REL-004 | P/C | Cód | Vários IMs por envelope: sim. MBL ligado a vários IMs: só como candidato (`referenceResolver.ts:287-320`). A conferência é por IM com coluna MBL (`Courier Module:953`): um MBL compartilhado vira duas marcações físicas. |
| REL-005 | C | Cód | "Agente" é o remetente do e-mail mais recente do envelope (`:288-294`, `:541-545`), não o agente por IM. |

### 2.3 ENT — Descoberta e criação

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| ENT-001 | P | Cód | "Processos sem courier" (`:497-511`, `:577-582`; tela `:369`) não cria Courrier. Mas é centrado no IM, não mostra referências além do assunto e não sugere e-mail. |
| ENT-002 | P | Cód | O card só existe com tracking, mas o marco de início não é registrado. |
| ENT-003 | P | Cód | `$search` top 60 (`:361-368`), threads e e-mail anexo em até 25 mensagens (`:384-395`). Não lê PDF/imagem; sem HeadCargo e sem Auditoria. Falhas de anexo são silenciadas. |
| ENT-004 | P | Cód | Resolve por referência e marca `precisaRevisao` (`:618-627`, `:723`), mas não há ação para confirmar o IM. |
| ENT-005 | P | Cód | Agrega por tracking (`:532-552`), sem cronologia. |
| ENT-006 | P | Cód + Teste | A proveniência da linha IM é assinada (`linha.ts`; `:637-646`) e testada (`linhas.test.ts`, 7/7). Os demais derivados (documentos esperados, ETA, resolução documental) não apontam evidência. |

### 2.4 ASS — Associação, expectativa e contradições

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| ASS-001 | P | Cód | Relações 1:N nunca são resolvidas automaticamente (`referenceResolver.ts:307`), mas os vínculos válidos não são preservados. O teto de 8 pode descartar vínculos válidos. |
| ASS-002 | P | Cód | `extractEnvelopeDocs` (`:241-278`) mantém os não identificados, mas só aparece quando o envelope não tem nenhum IM e não é persistido. |
| ASS-003 | A | Cód | Não sinaliza inconsistência. |
| ASS-004 | A / D | — | Não há HeadCargo (DEP-03). |
| ASS-005 | A | Cód | — |
| ASS-006 | A | Cód | Não há correção de associação. |
| ASS-007 | A | Cód | Expectativa sem histórico. |
| ASS-008 | P/C | Cód | A regex de emissão no destino (`:143-146`) vale para o envelope inteiro e a tela mostra "Emitido no destino" (`Courier Module:932`), sem histórico. |
| ASS-009 | A | Cód | — |
| ASS-010 | P/C | Cód | A regex de telex aceita negação (`:141`); "sent … consignee" (`:147-148`) vale para o envelope inteiro; "shipper" não é coberto. Em produção, Telex continuou exibido depois do fix (A2). |
| ASS-011 | P | Cód | Quando detectado, o telex aparece como motivo e não oferece marcação (`Courier Module:953`, `cell()`). |

### 2.5 TRN e TMP — Transporte e complementos temporais

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| TRN-001 | I (ressalva) | Cód | O estado só muda por ação humana (`:1231-1263`), mas Delivered aparece em verde (`Courier Module:797`, `:898`, `:905`). |
| TRN-002 | A | Cód | — |
| TRN-003 | A / D | Cód | Depende de LAC-01 a LAC-05. |
| TRN-004 | A | Cód | Delivery Exception não é classificada. |
| TRN-005 | A | Cód | — |
| TRN-006 | A | Cód | Não há "etiqueta criada" nem relógio. |
| TRN-007 | C | Cód | "Parado ≥ 7 d" calculado pela data do e-mail (`Exigem Atencao:249`). |
| TRN-008 | A | Cód | — |
| TMP-001 | A | Cód | Sem horário de Brasília: datas no fuso do navegador (`Courier Module:509-510`). |
| TMP-002 | A / D | Cód | — |
| TMP-003 | A / D | Cód | — |
| TMP-004 | I (por omissão) | Cód | Nada escala nem confirma automaticamente. A regra precisa ser preservada quando houver escalonamento. |

### 2.6 CNF — Conferência física

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| CNF-001 | I (limitado) | Cód | Recebido / Não recebido / sem marca, apenas para MBL e HBL Original por IM (`:1357-1406`). |
| CNF-002 | P | Cód | O recebimento é separado, mas a trava de conferência existe só no front (`Courier Module:293-295`, `:1056`): a API aceita conferência em envelope "Identificado". |
| CNF-003 | I | Cód | Cada marca é gravada isoladamente; itens não tocados ficam sem marca. |
| CNF-004 | A / D | Cód | Não há responsável; só o papel CLIENT é bloqueado (`operacional/contexto.ts:73`). Depende de LAC-11. |
| CNF-005 | P/C | Cód | "Finalizar courier" está disponível a partir de "Recebido", sem conferência (`Courier Module:824`). |
| CNF-006 | C | Cód | "Divergência resolvida — finalizar" (`:826`) leva a Concluído, que sai da lista (`:731-734`). |
| CNF-007 | P | Cód | Desmarcar ou trocar é possível; o durável guarda `valor_anterior` (B). Sem justificativa, reabertura nem recálculo. |
| CNF-008 | P | Cód | É possível remarcar como Recebido e os follow-ups são mantidos, sem semântica de "encontrado depois". |

### 2.7 RES — Ressalvas, danos e inesperados

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| RES-001 | A | Cód | Não há ressalva na conclusão. |
| RES-002 | A | Cód | — |
| RES-003 | A / D | Cód | Não há fotos (LAC-08) nem HeadCargo (DEP-03). |
| RES-004 | A | Cód | — |
| RES-005 | A | Cód | — |
| RES-006 | A | Cód | — |
| RES-007 | A | Cód | A classe CLARA existe para linhas de IM, não para documentos inesperados. |
| RES-008 | A | Cód | — |

### 2.8 ETA — ETA marítima e prioridade

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| Tabela de limiares | C / D | Cód | Exigem Atenção usa ≤ 5 d (`:246`). Depende de LAC-06. |
| ETA-001 | A / D | Cód | ETA vem de regex no e-mail (`:162-202`). Depende de DEP-02. |
| ETA-002 | P | Cód | Recalcula a cada carga, sem persistência nem alerta de agravamento. |
| ETA-003 | C | Cód | Não marca incerteza; captura qualquer data até 25 caracteres após o rótulo; infere o ano quando falta (`:162`, `:178-188`). |
| ETA-004 | A | Cód | — |

### 2.9 CLA — Clara, cobranças e promessas

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| CLA-001 | I | Cód | Modal editável, cópia e rascunho (`:1300-1322`; `Courier Module:658-690`). |
| CLA-002 | P | Cód | O rascunho responde na conversa mais recente do envelope (`:1018-1031`), não necessariamente na thread original. |
| CLA-003 | A/C | Cód | Um rascunho por processo + documento (`Courier Module:691`, `:1006`); não consolida por thread. |
| CLA-004 | P/C | Cód | Traz IM e MBL/HBL. Não traz ETA nem evidência, e afirma "today" (`Courier Module:665`, `:678`). |
| CLA-005 | A | Cód | — |
| CLA-006 | P | Cód | A pendência surge ao marcar "Não recebido" (`Courier Module:1010`), sem depender da conclusão. |
| CLA-007 | A / D | Cód | Depende de DEP-06 e LAC-09. |
| CLA-008 | A / D | Cód | Depende de LAC-14. |
| CLA-009 | A | Cód | — |
| CLA-010 | P | Cód | Um item por courier, com um único motivo; precedência ad hoc (LAC-07). |
| CLA-011 | I (frágil) | Cód | Não resolve a pendência (`:1330-1344`), mas fica só no JSON legado. |
| CLA-012 | A / D | Cód | Depende de LAC-09. |

### 2.10 SOL — Resolução de pendências

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| SOL-001 | A | Cód | Não existe o objeto pendência. |
| SOL-002 | A | Cód | — |
| SOL-003 | A | Cód | — |
| SOL-004 | P | Cód | Só a exibição por regex, sem o histórico "Resolvido por emissão no destino". |
| SOL-005 | A / D | Cód | Depende de DEP-04. |
| SOL-006 | A / D | Cód | Depende de DEP-04; a Fila de Decisões é placeholder. |
| SOL-007 | A / D | Cód | Depende de LAC-13 e VAL-03. |
| SOL-008 | C | Cód | `processosLiberados` (`:865-867`). |

### 2.11 KPI — Indicadores e Gestão

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| KPI-001 | P | Cód | Calculados automaticamente, mas a partir da janela de 60 e-mails (`:786-914`; `/stats :1108-1115`). |
| KPI-002 | A | Cód | Não há classificação de falha. |
| KPI-003 | A | Cód | — |
| KPI-004 | A | Cód | — |
| KPI-005 | A | Cód | — |
| KPI-006 | C / D | Cód | "Tempo médio" = conclusão − primeira menção (`:868-873`). Depende de LAC-10. |
| KPI-007 | I | Cód | Os indicadores aparecem em Gestão › Relatórios. |
| KPI-008 | A | Cód | — |

### 2.12 HIS — Histórico e rastreabilidade

| ID | Classe | Tipo | Evidência e explicação |
| --- | --- | --- | --- |
| HIS-001 | P | Cód | Durável só para estado e conferência (B, com a chave ligada); o resto não é persistido. |
| HIS-002 | C | Cód | O JSON sobrescreve e a lista esconde a divergência ao concluir. |
| HIS-003 | P | Cód | Concluído sai da lista (`:731-734`), mas não há pesquisa histórica. |
| HIS-004 | C | Cód | Concluído com pendência ativa fica oculto. |
| HIS-005 | C | Cód | "Liberação bloqueada" (`Exigem Atencao:257`). |

### 2.13 Critérios de aceite AC-01 a AC-24 (e CT-001 a CT-024)

Cada CT-0xx verifica o AC de mesmo número. **Nenhum foi executado:** não existem fixtures nem testes para eles. A situação abaixo vem de inspeção de código.

| AC / CT | Regras | Situação |
| --- | --- | --- |
| AC-01 / CT-001 | REL-001, ENT-005, ENT-006 | P — um card por tracking; evidências não preservadas. |
| AC-02 / CT-002 | ENT-001, ENT-002 | P — nenhum Courrier fictício; não há "Envios sem tracking". |
| AC-03 / CT-003 | REL-003, KPI-008 | A |
| AC-04 / CT-004 | REL-002, SOL-001 | A |
| AC-05 / CT-005 | REL-004, ASS-001 | C — MBL compartilhado gera marcação por IM. |
| AC-06 / CT-006 | CNF-001, CNF-003 | I (Cód) — não verificado por teste. |
| AC-07 / CT-007 | TRN-001 a TRN-003, TMP-001 a TMP-004 | A — só TRN-001 atende. |
| AC-08 / CT-008 | CNF-005, CNF-006, HIS-002, HIS-004 | C |
| AC-09 / CT-009 | RES-006 a RES-008 | A |
| AC-10 / CT-010 | RES-001, RES-004, RES-005 | A |
| AC-11 / CT-011 | ETA-001, CLA-005 | A |
| AC-12 / CT-012 | ETA-001, ETA-003 | A |
| AC-13 / CT-013 | TRN-006, CLA-009 | A |
| AC-14 / CT-014 | TRN-004, TRN-005 | A |
| AC-15 / CT-015 | CLA-002, CLA-003 | A |
| AC-16 / CT-016 | CLA-003 | A |
| AC-17 / CT-017 | CLA-008 | A / D |
| AC-18 / CT-018 | ASS-008, SOL-004, SOL-005, SOL-008 | P — só exibição; a Liberação (B) é separada. |
| AC-19 / CT-019 | SOL-006 | A / D |
| AC-20 / CT-020 | CNF-007, CNF-008, KPI-005 | P — append-only (B), sem justificativa e sem KPI. |
| AC-21 / CT-021 | KPI-002, KPI-003 | A |
| AC-22 / CT-022 | HIS-003 | P — sai da lista, mas não é pesquisável. |
| AC-23 / CT-023 | CNF-004 | A / D |
| AC-24 / CT-024 | CLA-010 | P — consolida, com um único motivo. |

### 2.14 Cenários complementares CT-025 a CT-042

| CT | Regras | Situação atual | Bloqueio para homologação |
| --- | --- | --- | --- |
| CT-025 | TMP-001, TMP-002 | A | LAC-03, LAC-05 |
| CT-026 | TMP-003, TRN-003 | A | LAC-01 a LAC-05 |
| CT-027 | TMP-003, TRN-003 | A | LAC-04, LAC-05 |
| CT-028 | TMP-002, TMP-003 | A | LAC-03, LAC-05 |
| CT-029 | TMP-002, TMP-003 | A | LAC-03 a LAC-05 |
| CT-030 | TMP-002, TMP-003 | A | LAC-01 a LAC-05 |
| CT-031 | TMP-003, TRN-003 | A | LAC-01 a LAC-05 |
| CT-032 | TMP-003 | A | LAC-01, LAC-02 |
| CT-033 | TRN-001, TMP-004, CNF-002 | P — a separação existe; a condição não é calculada. | Sem bloqueio |
| CT-034 | TRN-003, TMP-004 | A | Momento: LAC-04 |
| CT-035 | TMP-001, TMP-003 | A | LAC-03 |
| CT-036 | CLA-007, DEP-06 | A | LAC-09 |
| CT-037 | CLA-007, CLA-008 | A | LAC-09, LAC-14 |
| CT-038 | SOL-001, SOL-003, HIS-002 | A | Sem bloqueio |
| CT-039 | ASS-008, ASS-009, SOL-004, SOL-008 | A (exibição parcial) | Sem bloqueio |
| CT-040 | ASS-002, ASS-003 | P — documentos por linha. | Sem bloqueio |
| CT-041 | RES-002, RES-003, RES-005 | A | Sem bloqueio |
| CT-042 | KPI-002, KPI-004, KPI-008 | A | Sem bloqueio |

### 2.15 DEP — Dependências técnicas

| ID | Classe | Situação (Cód) |
| --- | --- | --- |
| DEP-01 | P | Leitura, busca, conversa e e-mail anexo funcionam. Sem PDF/imagem (`fileAttachment`) e sem detecção de envio humano. |
| DEP-02 | P | Clientes FedEx e DHL existem; a chave DHL está em dúvida (commits da Linha A); o armador não é ligado ao Courrier. |
| DEP-03 | A | Não há HeadCargo. |
| DEP-04 | P | A Liberação (B) consome os fatos (`:1251`, `:1391`); a Fila de Decisões é placeholder. |
| DEP-05 | P | `courier_fatos` append-only só para estado e conferência; sem anexos e fotos. |
| DEP-06 | A | Sem detecção de envio humano. |

### 2.16 VAL — Pontos de validação

| ID | Situação |
| --- | --- |
| VAL-01 | Aberta. O código não distingue correção de tracking de novo envelope. |
| VAL-02 | Resolvida em parte pelo Blueprint (Brasília, 18h, 2 h). O código não implementa nada disso. |
| VAL-03 | Aberta. Não há vínculo entre threads. |
| VAL-04 | Aberta. Não há fotos. |
| VAL-05 | Aberta. "Já realizei esta ação" existe (`:1330-1344`), sem prova de envio. |

### 2.17 LAC — Lacunas (todas abertas)

| ID | Escolha implícita já presente no código |
| --- | --- |
| LAC-01 | Nenhuma: não há expediente. |
| LAC-02 | Nenhuma: não há calendário. |
| LAC-03 | O FedEx mistura entrega real e previsão (`fedexClient.ts:153-157`); não há instante de detecção. |
| LAC-04 | Nenhuma. |
| LAC-05 | Nenhuma. |
| LAC-06 | **Sim:** dias contados pela diferença desde a meia-noite local, com limite ≤ 5 (`Exigem Atencao:239-246`). |
| LAC-07 | **Sim:** severidade de 0 a 2 e ordenação própria (`Exigem Atencao:250-274`). |
| LAC-08 | Nenhuma: não há anexos nem fotos. |
| LAC-09 | "Já realizei" não comprova envio. |
| LAC-10 | **Sim:** "tempo médio" (`:868-873`). |
| LAC-11 | **Sim:** qualquer membro não-CLIENT pode alterar. |
| LAC-12 | Nenhuma. |
| LAC-13 | Nenhuma. |
| LAC-14 | **Sim:** a Clara recebe a data da mensagem mais recente como referência para datas relativas (`emailParser.ts:215-218`). |
| LAC-15 | **Sim:** catálogo de 5 estados, com CHECK em banco. |
| LAC-16 | Ver DEP. |
