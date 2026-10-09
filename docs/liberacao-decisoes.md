# Liberação — Decisões congeladas (H, N e derivações)

> **Status:** decisões funcionais aprovadas e congeladas pelo responsável pelo produto entre 2026-10-08 e 2026-10-09.
>
> **Hierarquia de autoridade da Liberação:** Blueprint congelado → decisões H/N aprovadas (este documento) → implementação.
> Quando código herdado conflitar com essa autoridade, o código se adapta. O Blueprint nunca é alterado em silêncio.
>
> **Fonte funcional:** `docs/liberacao-blueprint-v1.fonte.md`, a transcrição verificada do `.docx` congelado.
> Os capítulos citados como "cap. N" são os do Blueprint.

## 1. Governança

### 1.1 Blueprint soberano

O Blueprint de Liberação V1 é a fonte de verdade funcional do módulo. Suas regras estão congeladas. Não é permitido:

- simplificar regras;
- substituir fluxos;
- reinterpretar estados;
- criar atalhos operacionais;
- modificar prioridades;
- alterar fontes de verdade;
- fundir conceitos;
- transformar dado indisponível em negativo;
- criar confirmação manual onde o Blueprint exige integração futura.

O que fazer em cada situação:

- **Regra difícil ou incompatível com a arquitetura atual:** a regra não muda; marca-se **PRECISA DE SUA VALIDAÇÃO**, com o problema exato.
- **Integração ainda inexistente** (HeadCargo, SISCARGA, CE Mercante, portais): marca-se **DEPENDÊNCIA TÉCNICA PENDENTE**. A ausência de integração não autoriza alterar o Blueprint.
- **Checkbox manual permanente como substituto funcional:** proibido.
- **Mocks:** só em desenvolvimento e teste, e sempre identificados como mocks.
- **Mudanças funcionais:** mudar etapa, gate, fonte de verdade, prioridade, responsabilidade, evidência, override, regra de observabilidade ou conclusão exige validação explícita do responsável pelo produto (critério de congelamento, cap. 43).
- **Novos pontos de decisão (N-x):** só se abrem diante de uma contradição funcional real que impossibilite a implementação.

### 1.2 Substrato técnico (autorizado em 2026-10-09)

`a4b07b38a2ce520f4be3ed3c363f3a688b6a05d4` está autorizado como **substrato técnico** da Priora para construir a Liberação. Essa autorização é somente técnica. Ela **não**:

- aprova nem congela funcionalmente as fases D1–D11 da Demurrage;
- torna regras da Demurrage autoritativas para a Liberação;
- se sobrepõe ao Blueprint congelado da Liberação;
- autoriza S6 nem qualquer fase de implementação posterior à L0-B.

A qualificação técnica está em `docs/liberacao-fase-l0.md`.

---

## 2. Decisões H (fechamento do diagnóstico)

### H-1 — Base de implementação
- **Decisão:**
  - não usar o SHA antigo `48ba7c1` como base funcional;
  - a Liberação nasce sobre a arquitetura moderna da linha `claude/practical-cerf-mnz7oj`, mas não sobre o HEAD dela, que contém fases da Demurrage (D12–D15) não aprovadas nem congeladas;
  - o baseline técnico candidato foi `a4b07b3`, último commit da linha moderna antes do início da D12.
- **Restrições:**
  - não alterar a Demurrage;
  - não importar para a Liberação regras funcionais de D12–D15;
  - reutilizar apenas a infraestrutura compartilhada: PostgreSQL, organizações, usuários/memberships, processos, tracking/VesselCall, persistência e padrões de auditoria.
- **Situação:** `a4b07b3` foi qualificado na L0-A e na L0-A.1 e autorizado como substrato técnico (§1.2).

### H-2 — Courier: Master e HBL físico
- **Master físico:** o que resolve o Master não é o envelope ou o tracking ter chegado, e sim **o MBL daquele processo estar confirmado como recebido no módulo Courier**.
- **HBL físico, dois caminhos:**
  - **A. HBL enviado ao cliente:** o cliente envia a foto pelo Portal e o Analista confirma visualmente, conforme o Blueprint.
  - **B. HBL original recebido diretamente pela Rocket via Courier:** se o original daquele processo foi recebido e conferido pela Rocket, o House está resolvido diretamente, **sem exigir foto do cliente**.
- **Mudanças permitidas no Courier:** alterações aditivas de persistência, autoria/histórico ou contrato de saída, quando necessárias para cumprir o Blueprint. As regras funcionais do Courier não mudam sem validação.
- **Blueprint:** cap. 5, 15, 22.

### H-3 — Auditoria e CE House
- A Auditoria pode evoluir de forma aditiva para produzir fatos consumíveis pela Liberação.
- A Auditoria continua responsável por identificar e auditar a desconsolidação e o CE House.
- A Liberação **não duplica OCR** nem cria fonte paralela.
- **Contrato de saída persistente**, com os campos que forem conhecidos:
  - processo;
  - desconsolidação identificada;
  - número do CE House;
  - fonte/evidência;
  - data/hora da observação.
- **Blueprint:** cap. 5, 8, 42.

### H-4 — Unidade de controle
- Cada processo/IM da Rocket corresponde a **exatamente um House**. Não existe "Processo IM → House A + House B".
- A unidade operacional da Fila Principal e da Liberação é **Processo/IM = House**.
- O compartilhamento ocorre no sentido oposto: **um mesmo Master pode estar vinculado a vários processos/IMs** (Master 1 → IM100/House A, IM101/House B, IM102/House C).
- Uma ação real de Master pode propagar seus efeitos aos processos vinculados, mas cada processo mantém CE House, cliente, obrigações e conclusão próprios.
- Não se cria entidade redundante para "múltiplos Houses por processo".
- **Blueprint:** cap. 3, 34.

### H-5 — Telex informado pelo cliente
- **O cliente não confirma Telex.** Nenhum botão do Portal do tipo "Marcar Telex" produz efeito de gate.
- **Fonte válida:** e-mail do agente, vinculado ao processo, confirmando que o House está apto para liberação.
- A declaração do cliente é, no máximo, informação sem efeito operacional.
- **Blueprint:** cap. 5, 16.

### H-6 — Troca de conta Microsoft
- Histórico e fatos da Liberação **não podem desaparecer** na troca da conta Microsoft.
- Usar a infraestrutura persistente moderna; a Liberação não é implementada sobre o reset de JSON antigo.
- **Blueprint:** cap. 6, 7.

### H-7 — Vínculo House × Master
- O vínculo relevante é **Processo/House ↔ Master**.
- Ele vem de fatos documentais do Pré-Alerta/Auditoria, preservando fonte e evidência.
- **Nunca** se infere vínculo porque números ou textos "parecem próximos".
- **Blueprint:** cap. 5, 21, 34.

### H-8 — ETA, ATA e atracação
- Reutilizar a infraestrutura compartilhada de VesselCall/tracking. **Não** criar um segundo modelo de ETA/ATA/atracação exclusivo da Liberação.
- **Regra:**
  - ATA existente → a chegada já ocorreu;
  - sem ATA → usa-se a ETA;
  - Evergreen usa a **atracação real** como gate.
- **Blueprint:** cap. 29, 36, 42.

### H-9 — Limites numéricos
- **Nenhum limiar novo.** Os valores congelados são:
  - **T-10**, para Master não localizado ganhar atenção forte;
  - **T-48h**, para ausência de CE House/desconsolidação;
  - **janela de 48h**, para acompanhamento do desbloqueio.
- Classes A–D e ETA/ATA resolvem o resto da ordenação. Não se cria "ETA crítico = X dias".
- **Blueprint:** cap. 10, 25, 32, 36.

### H-10 — Janela de 48h do armador
- **Início do relógio:** quando existem **Master apresentado + condição financeira resolvida**, contando a partir da condição que ocorreu por último.
- **Sem urgência artificial:** a Priora não gera cobrança nem alerta prematuro enquanto o navio não estiver em condição de chegada/liberação.
- **Quando a ATA/atracação ocorre:**
  - janela ainda dentro das 48h → acompanhar normalmente;
  - 48h já transcorridas → a cobrança ao armador pode surgir imediatamente.
- **Maersk:** mantém a exceção comercial do Blueprint.
- **Blueprint:** cap. 31, 32.

### H-11 — Periodicidades
- A revalidação do perfil do consignatário no HeadCargo e a frequência de consulta ao SISCARGA são **parâmetros técnicos**, não regras funcionais novas.
- Não se inventam números agora. Esses parâmetros serão configuráveis quando contrato, disponibilidade e custo dos endpoints forem conhecidos.
- **Blueprint:** cap. 11, 17, 19.

### H-12 — Armador fora da matriz
- Não se infere agência nem procedimento.
- **Estado:** "Procedimento de apresentação não mapeado". A Priora não recomenda agendamento, memorando nem apresentação até existir configuração validada.
- **Blueprint:** cap. 26.

### H-13 — Unimar e Maersk sem integração
- O status **Finalizado** continua sendo a evidência automática exigida.
- Sem integração, a situação é **DEPENDÊNCIA TÉCNICA PENDENTE**. Não se cria checkbox manual permanente.
- Em desenvolvimento e teste pode existir adapter mock, explicitamente identificado.
- **Blueprint:** cap. 27, 30, 42.

### H-14 — Termo Único e condição comercial
- `condicoes_comerciais.termo_tipo` pode servir como projeção/cache operacional.
- A fonte de verdade continua sendo o **HeadCargo**.
- Registra-se a fonte e a data da última confirmação, e permite-se revalidação.
- **Blueprint:** cap. 5, 17, 19.

### H-15 — Procuração
- A procuração vem do PDF anexado pelo cliente no Portal. Dela se extraem **outorgados, validade e poderes relevantes**.
- Esses dados são cruzados com a identidade da assinatura digital do Termo por Embarque.
- Se a validação não puder ser feita com segurança, **não se infere aprovação**.
- **Blueprint:** cap. 18.

### H-16 — RBAC do override
- **ANALYST** solicita; **MANAGER** ou **ADMIN** aprova ou rejeita.
- O override fica restrito à pendência, à ação e ao processo indicados, e **não elimina a pendência original**.
- **Blueprint:** cap. 6, 38.

### H-17 — Prova de envio do pré-alerta
- Para avaliar eventual falha da Rocket, a evidência é o **e-mail enviado pela Rocket à equipe terceirizada de desconsolidação**. Ele deve preservar:
  - processo;
  - destinatário;
  - timestamp;
  - thread/evidência;
  - anexos ou referência documental, quando houver.
- **T-48h sem CE House, sozinho, significa risco, não culpa da Rocket.**
- **Blueprint:** cap. 10, 12.

---

## 3. Decisões N (fechamento dos pontos de implementação)

### N-1 — Banco de desenvolvimento
- O banco de desenvolvimento é dedicado, separado de produção e de bancos com migrations posteriores não autorizadas.
- O banco usado pela Liberação reflete exatamente o substrato técnico autorizado (`0001`–`0034`) no início da implementação.

### N-2 — Migrations
- Reutilizar o **runner único** existente.
- Reservar a faixa **`0100_liberacao_*`** para as migrations introduzidas pelo esforço da Liberação.
- Os componentes compartilhados S6/S7/S8 ficam no mesmo sistema de migrations. Não se criam runners paralelos.
- A convenção de nomes está em `docs/liberacao-plano.md` §7.

### N-3 — Identidade do Processo
- O Processo tem **identidade canônica** e **aliases comprovados**.
- **Não** se considera automaticamente `IM2151 == IM2151-26`. O casamento exato é o preferencial.
- Uma referência alternativa só vira alias mediante **evidência inequívoca dentro da mesma organização**. Havendo ambiguidade, gera-se **pendência de identidade**.
- Nunca se normaliza removendo ano ou sufixo para assumir igualdade.
- Um alias validado é persistido e reutilizado, sem ser resolvido de novo a cada ingestão.

### N-4 — Arquitetura: identidade compartilhada, domínios separados, fatos reutilizados
- Há uma **única identidade central de Processo/IM**, compartilhada pelos módulos, **sem** um domínio central monolítico.
- **Cada módulo mantém sua responsabilidade:**
  - Auditoria → fatos e regras documentais;
  - Courier → recebimento/conferência física;
  - Liberação → motor de liberação, bloqueadores, ações e conclusão;
  - Demurrage → fatos e regras de demurrage.
- Os módulos se comunicam por **fatos e contratos explícitos** sobre o mesmo `processo_id`. Um módulo não recalcula um fato que outro já produziu de forma confiável. Exemplos:
  - Auditoria identifica o CE House → Liberação consome;
  - Courier confirma o MBL recebido → Liberação consome;
  - VesselCall confirma a atracação → Liberação consome.
- Isso substitui a ideia de a Auditoria ser dona do find-or-create do Processo. Existe um **serviço central mínimo de identidade**, sem regras de Liberação nem de Demurrage.
- A fila da Demurrage seleciona apenas processos **com contexto de Demurrage**. A existência de um Processo central não o inclui na Demurrage.

### N-5 — Tracking e VesselCall como infraestrutura compartilhada
- Tracking/VesselCall evolui para infraestrutura compartilhada da Priora. **Não** existe tracking separado para a Liberação.
- Um processo pode ser acompanhado pelo tracking antes de ter qualquer contexto de Demurrage. As referências vêm de fatos documentais confiáveis, principalmente da Auditoria (S2).
- **Princípio:** um alvo físico/documental → uma consulta → fatos persistidos uma vez → múltiplos consumidores.
- A camada de scheduling consolida as demandas dos módulos numa **única agenda efetiva por alvo**.
- **Precisão temporal:**
  - a evolução de S3 deve suportar ETA, chegada/ATA, atracação e `observado_em` com data, hora e timezone suficientes para regras em horas, em especial T-48h;
  - **não se inventa horário** quando a fonte fornece só data;
  - o nível de precisão do dado (data × timestamp) é preservado;
  - a evolução é aditiva e não quebra consumidores da Demurrage.
- **Eficiência do tracking:** se Liberação e Demurrage pedirem o mesmo alvo, faz-se uma única consulta física e o resultado é compartilhado. Não se duplicam scraping, créditos, parsing, eventos nem persistência. Reingestão idêntica segue N-16.

### N-6 — Autenticação multiusuário
- É uma **frente compartilhada**. Separa-se a **identidade da pessoa** da **caixa operacional Microsoft monitorada**.
- ANALYST, MANAGER, ADMIN e CLIENT precisam coexistir.
- Antes de implementar S4, apresenta-se um **diagnóstico específico**. Não se cria autenticação paralela dentro da Liberação ou do Portal.

### N-7 — Durabilidade dos fatos do Courier
- Fatos confirmados do Courier tornam-se **duráveis**.
- Troca, desconexão ou indisponibilidade da conta Microsoft **não apaga** conferências de MBL/HBL já realizadas.
- A evolução é aditiva, sem refatoração funcional ampla do Courier.

### N-8 — Evidência de envio do pré-alerta
- A Auditoria (S2) é responsável pela evidência de envio do pré-alerta pela Rocket, consumindo os Itens Enviados.
- O fato é persistido uma vez e compartilhado. A Liberação não faz uma segunda busca independente.

### N-9 — Pagamento ao armador é fato do Master
- O pagamento ao armador é **fato do Master**, não do Processo/House. Quando vários processos compartilham o mesmo MBL, existe **um único estado financeiro do armador** para aquele MBL.
- Quando o HeadCargo confirma o pagamento:
  - o fato é registrado **uma única vez no Master**;
  - todos os processos vinculados passam a ver a condição financeira como resolvida;
  - não há pagamentos duplicados por processo;
  - não há divergência silenciosa entre processos que compartilham o Master.
- **Fonte de verdade: HeadCargo.**
  - Indisponível → "informação indisponível", **nunca "não pago"**.
  - Exceção Maersk: o prazo comercial da Rocket faz com que a condição financeira imediata não bloqueie o desbloqueio.
- **Ajuste aprovado com o N-13:** e-mail, Analista ou outra fonte **não podem** marcar o Master como pago, substituir o estado do HeadCargo nem resolver o gate financeiro. Evidência operacional incompatível é **preservada como evidência divergente**, sem alterar em silêncio o fato oficial: o conflito é preservado, mas o estado oficial só muda com nova confirmação da fonte de verdade.
- Os escopos de propagação estão em §4.
- **Blueprint:** cap. 5, 31, 34, 41.

### N-10 — Rolagem
- Um mesmo Processo/IM não permanece com contêineres seguindo viagens finais diferentes.
- Se um contêiner é rolado:
  - abre-se um **novo Processo/IM**;
  - a documentação é ajustada;
  - surgem novo House e novo Master;
  - o contêiner rolado passa a pertencer ao novo processo.
- **Não** se modela "um Processo → duas ETAs finais".
- Se, antes da regularização, a Priora detectar contêineres do mesmo processo em viagens incompatíveis, ela **não escolhe uma ETA**. Gera a condição: **"Divergência de viagem detectada — verificar possível rolagem e necessidade de abertura de novo processo."**
- Depois da regularização, cada processo segue seu próprio VesselCall/ETA/ATA. Não se cria algoritmo permanente de "ETA ambígua".

### N-11 — Prioridade (com a correção de 2026-10-08)
- **Ordem lexicográfica:** classe → condição temporal → proximidade da liberação → tempo aguardando.
- **Classes:**
  - **A** — ação da Rocket já necessária/agora.
  - **B** — condição essencial não resolvida com risco operacional crescente.
  - **C** — ação Rocket disponível antecipadamente, mas ainda não vencida.
  - **D** — bloqueio externo.
- **Dentro da mesma classe:**
  1. ATA/chegada ocorrida;
  2. ETA conhecida, a mais próxima primeiro;
  3. ETA desconhecida;
  4. mais próximo da liberação efetiva;
  5. há mais tempo aguardando a ação.
- **ETA desconhecida:** aparece como **"Referência temporal indisponível"** e nunca rebaixa um processo para classe inferior.
- **Condição do N-10:** é **Classe A**, porque exige ação operacional da Rocket.
- **Nenhum limiar temporal novo.**
- **Correção aprovada em 2026-10-08, sem abrir N-20:**
  - Foi **rejeitada** a derivação "Master não localizado = Classe B qualquer que seja o ETA", porque contradiz o significado congelado da Classe B (risco iminente) e esvazia o papel do T-10. A consequência que dela decorria também foi removida.
  - Master não localizado com **ETA conhecida, ainda antes de T-10** → **Classe C**, com a ação "verificar/identificar a situação do Master".
  - Master não localizado **em T-10 ou depois** → **Classe B**, risco iminente.
  - Master não localizado com **ATA já ocorrida** → **Classe B**, no grupo temporal de chegada já ocorrida.
  - Master não localizado com **ETA desconhecida** → **Classe C**, mostrando "Referência temporal indisponível". Não se presume iminência pela ausência de ETA.
  - **T-10 continua sendo um marco funcional real de escalada.**
- **Coerência:** ETA/ATA não define a classe, a não ser em duas situações:
  - a escalada de Master não localizado por T-10/ATA;
  - as regras congeladas que tornam uma ação devida (N-10; cobrança da H-10).

  Fora delas, ETA/ATA só ordena dentro da classe. A aplicação detalhada está em §8 (D-1 a D-4).
- **Blueprint:** cap. 25, 35, 36.

### N-12 — Uma entrada por ação de Master
- Uma ação de Master compartilhado gera **uma única entrada na Fila Principal**, posicionada pela maior prioridade/urgência entre os processos vinculados.
- Os cards individuais podem referenciar essa ação, mas não criam entradas operacionais duplicadas.
- **Blueprint:** cap. 34, 35, 37.

### N-13 — Gate da ação de Master
- **Execução normal só com todos aptos:** a ação compartilhada de procedimento/apresentação do Master só aparece como execução normal quando **todos os processos ativos vinculados** estão aptos. Para cada processo é preciso:
  - obrigações do cliente concluídas; **ou**
  - override aprovado especificamente para a pendência que impediria o avanço.
- **Um bloqueado bloqueia a ação:** se pelo menos um processo vinculado continua bloqueado sem override, a ação de Master continua bloqueada.
  - Exemplo: MBL ABC com IM100 apto, IM101 com Termo pendente e IM102 com pagamento do cliente pendente.
  - A Priora **não** recomenda "Apresentar MBL ABC". Indica **"Master tecnicamente apto, mas bloqueado por processos vinculados"** e identifica os processos e as pendências.
- **Quando todos estão aptos** (ou cobertos por seus overrides), "Apresentar MBL ABC — impacta 3 processos" continua sendo **uma única ação operacional de Master**.
- **Override:** é por processo + pendência + ação. **Não existe "override global do Master".** A execução é registrada uma única vez no Master e repercute em todos os vinculados.
- **Correção aprovada: a etapa é individual.** Não se sincroniza artificialmente a etapa dos processos vinculados.
  - Exemplo: IM100 pode estar em "Apto para Procedimento", com bloqueador "processo vinculado ao Master — IM101 com Termo pendente", enquanto o IM101 continua em "Preparação Operacional".
  - O que é compartilhado é a execução da ação de Master. Isso preserva a regra **etapa ≠ bloqueador/responsável ≠ próxima ação**.
- **Blueprint:** cap. 4, 14, 33, 34, 38.

### N-14 — Divergência factual
- O Analista **não pode simplesmente encerrar** uma divergência factual válida por decisão humana.
- **Estados, pelo menos semânticos:** `ABERTA`, `EM_ANÁLISE`, `ENCERRADA_POR_EVIDÊNCIA_INVÁLIDA` (com justificativa/evidência) e `RESOLVIDA_PELA_FONTE_DE_VERDADE`.
- Se as duas evidências continuam válidas e incompatíveis, a divergência **continua aberta**, mesmo após análise humana.
- Só uma nova observação da fonte de verdade altera o fato oficial.
- **Blueprint:** cap. 5, 22.

### N-15 — Vínculo depois de ação física do Master
- Se um processo é vinculado ao Master depois de uma ação física já executada, o fato do Master **propaga** para ele. **Não existe override retroativo.**
- **O que se preserva:**
  - timestamp da ação do Master;
  - snapshot dos processos vinculados naquele momento;
  - timestamp da nova vinculação;
  - fato/evidência que causou a vinculação.
- **Mensagem exibida:** "Master apresentado antes deste processo ser vinculado."
- Obrigação do cliente pendente continua como bloqueador. **Não** se atribui falha à Rocket automaticamente.
- **Blueprint:** cap. 30, 34.

### N-16 — Reconfirmação, mudança oficial e idempotência
- **N-16(a), reconfirmação sem mudança:** havendo divergência válida e a fonte de verdade só reconfirmando o mesmo estado (HeadCargo PAGO, evidência divergente NÃO PAGO, nova consulta PAGO):
  - o fato oficial continua PAGO;
  - a divergência continua ABERTA;
  - a reconfirmação é registrada quando relevante;
  - a divergência não é considerada resolvida só porque a fonte foi consultada de novo.

  Ela só vira `RESOLVIDA_PELA_FONTE_DE_VERDADE` quando uma nova observação elimina a incompatibilidade.
- **Idempotência** (regra transversal da Priora):
  - reconsultas idênticas não criam fatos/eventos materiais sucessivos; PAGO → PAGO → PAGO é um único estado oficial;
  - pode-se atualizar a última confirmação/`observado_em`, mas sem duplicar mudanças de estado, abrir novas divergências, recalcular projeções sem mudança material ou gerar alertas iguais;
  - reprocessa-se só quando há mudança material ou necessidade explícita de frescor.
- **N-16(b), mudança da própria fonte de verdade:** HeadCargo PAGO → NÃO PAGO é **mudança oficial**, não divergência com o próprio histórico. O estado anterior é preservado no histórico, a nova observação vira o fato oficial, registram-se data/hora/fonte, e gera-se atenção quando houver consequência operacional. O histórico não é evidência concorrente atual. Se existir **outra** evidência válida incompatível com o novo estado oficial, a divergência continua ou é aberta normalmente (exemplo: oficial NÃO PAGO e evidência operacional PAGO → ABERTA).
- **Terminalidade:** mudança posterior de um fato de Master **não reabre** um Processo/House já LIBERADO. A nova informação pode afetar os demais processos vinculados ainda ativos.
- **Blueprint:** cap. 5, 7, 39.

### N-17 — Indisponibilidade da fonte: três dimensões
- A indisponibilidade de uma fonte **não** transforma automaticamente em desconhecido um fato oficial já confirmado. São três dimensões obrigatórias:
  1. **estado oficial** do fato;
  2. **frescor/última confirmação**;
  3. **disponibilidade atual da fonte**.
- **Exemplo:** pagamento do Master = PAGO às 10:00; às 11:00 o HeadCargo fica indisponível. O resultado:
  - estado oficial PAGO;
  - última confirmação às 10:00;
  - fonte indisponível desde as 11:00;
  - o gate continua resolvido.
- **O que não se faz:** transformar PAGO em desconhecido, bloquear a Evergreen por simples indisponibilidade, interromper ou reiniciar a janela de 48h, ou recalcular como se o pagamento tivesse desaparecido.
- **Sem fato anterior:** nunca houve observação válida e a fonte está indisponível → **DESCONHECIDO / INFORMAÇÃO INDISPONÍVEL**, e o gate não é resolvido.
- **Fatos com validade** (Termo Único, prazo comercial):
  - a indisponibilidade sozinha não invalida o dado;
  - o gate só exige reconfirmação quando a validade explícita termina ou quando a política de revalidação aplicável exige (sem periodicidade inventada);
  - revalidação vencida com HeadCargo indisponível → **"RECONFIRMAÇÃO NECESSÁRIA — FONTE INDISPONÍVEL"**.
- **Pagamentos:** pagamentos do cliente e do armador já confirmados continuam oficiais durante indisponibilidade posterior. Só uma nova observação da fonte de verdade os altera.
- **SISCARGA:** declarar LIBERADO exige **consulta fresca obrigatória**. Se ela não puder ser feita, **não se declara LIBERADO**. O último estado conhecido não é apagado; só a decisão terminal fica impedida.
- **Princípio:** **indisponibilidade da fonte não é mudança do mundo real.**
- **Blueprint:** cap. 5, 7, 11, 19, 39, 41.

### N-18 — Identidade do Master
- O Master também tem identidade central compartilhada em S6. **Não** existe `liberacao_masters`. S6 guarda só identidade, sem regras funcionais.
- O Master tem **UUID próprio**. O MBL normalizado é a principal referência documental, mas organização + MBL **não** é uma identidade universal infalível.
- Armador e evidência documental participam da resolução de identidade quando disponíveis.
- Referências incompatíveis que possam representar Masters distintos **não** são fundidas em silêncio: geram pendência/divergência de identidade.
- O vínculo Processo ↔ Master continua sendo fato produzido pela Auditoria (S2), com fonte e evidência.
- **Blueprint:** cap. 21, 34.

### N-19 — T-48h quando a fonte fornece só a data
- Com só a data `D` da atracação/ETA, o limiar T-48h é considerado atingido às **00:00 de D−2**, no fuso operacional aplicável ao porto/evento quando ele é conhecido de forma confiável.
- **Correção matemática:** o T-48h verdadeiro está entre 00:00 e 23:59:59 de D−2. A escolha de 00:00 de D−2 pode antecipar o alerta em cerca de 24h, mas **nunca atrasá-lo**. **Não** se usa 00:00 de D−1.
- O alerta informa **"Precisão temporal: somente data"** e é risco/atenção regulatória, nunca atribuição automática de responsabilidade à Rocket.
- **Base do T-48h:** a atracação prevista no porto final (cap. 10). Na falta dela, usa-se a ETA, porque a chegada é igual ou anterior à atracação e isso nunca atrasa o alerta.
- **Hora sem fuso:** não se interpreta horário sem fuso quando o contrato da fonte não garante o timezone, e não se inventa timezone. A hora só é usada com referência confiável do porto **e** regra explícita da fonte de que o horário é local do porto. Caso contrário, a precisão cai para `DATA`.
- **Timestamp mais preciso depois:** o limiar é recalculado sem alerta duplicado. Se o alerta conservador já foi aberto e o timestamp mostra que o T-48h real ainda não chegou:
  - a condição ativa é retirada;
  - o histórico preserva o alerta preventivo baseado em precisão `DATA`;
  - a condição é reativada no limiar real, se o CE House continuar ausente.
- **Eficiência:** existe **uma única condição regulatória ativa** por processo, cuja evidência e precisão podem ser atualizadas. Melhorar a precisão não gera vários alertas.
- **Blueprint:** cap. 10, 12.

### Fallback de fuso
- **Quando se aplica:** evento em **porto brasileiro**, fonte com **só DATA** e nenhum timezone confiável cadastrado para o porto. Usa-se temporariamente `America/Sao_Paulo` para materializar 00:00 de D−2.
- **Como se registra:** `timezone_source = OPERATIONAL_FALLBACK`, mantendo `precisão temporal = DATA`. Esse timezone **não** é apresentado como timezone confirmado do porto.
- Se depois surgir timezone confiável do porto, o limiar é recalculado conforme N-19/N-16, sem duplicar alertas.
- Se não for possível identificar com segurança que o porto está no escopo operacional brasileiro, **não** se assume `America/Sao_Paulo` em silêncio. A precisão continua degradada e gera-se a necessidade de uma referência temporal confiável.
- **Limites do fallback:** serve só para antecipar/operacionalizar o alerta T-48h. Ele **não** prova descumprimento, **não** atribui culpa à Rocket, **não** altera o fato original da fonte e **não** converte DATA em timestamp factual. O valor bruto recebido é preservado.

---

## 4. Escopos de propagação (N-9)

| Escopo | Fatos |
|---|---|
| **Master** (registrado uma vez e propagado aos processos vinculados) | modalidade/resolução do Master; procedimento/apresentação; pagamento ao armador; retificação do CE Master |
| **Processo/House** (individual) | CE House; HBL/Telex; Termo/procuração; financeiro do cliente; SISCARGA; override; LIBERADO |

- **A etapa é sempre individual** (correção do N-13).
- A propagação de um fato de Master depende do vínculo Processo ↔ Master produzido pela Auditoria (H-7, N-18).
- O vínculo tardio segue o N-15.

## 5. Fontes de verdade, evidência e divergência

- **Fontes por dado:** cada informação tem sua própria fonte de verdade (cap. 5). **Não existe precedência universal** entre sistemas ou documentos. Por isso a Liberação não adota tabelas de precedência universal herdadas de outros módulos.
- **Evidências incompatíveis:** quando evidências válidas sobre o mesmo fato são incompatíveis, as duas são preservadas, a divergência é registrada e encaminhada (N-14). Nenhuma é sobrescrita em silêncio.
- **E-mails:** só sustentam decisões quando são operacionalmente válidos e vinculáveis ao processo, com remetente compatível, referência ao BL/processo/documento e conteúdo inequívoco. Mensagens genéricas não criam divergência nem substituem fonte de verdade (cap. 5, 41).
- **Fonte de verdade sem exclusividade:** a fonte de verdade não ignora evidências conflitantes. O conflito é preservado, mas o estado oficial só muda com nova confirmação da fonte (N-9).
- **Indisponibilidade:** produz um estado explícito de informação indisponível, nunca uma conclusão negativa (cap. 7, 41; N-17).
- **Histórico imutável:** correções posteriores não apagam o fato registrado (cap. 7). Toda ação relevante preserva autor, data/hora, estado anterior, estado posterior, evidência e justificativa (cap. 6).

## 6. Idempotência e eficiência

**Idempotência (N-16).** Uma observação idêntica não gera mudança material, divergência nova, recálculo nem alerta repetido. O frescor (`observado_em`) pode ser atualizado.

**Princípio de eficiência do projeto** (aprovado em 2026-10-08 e reafirmado como princípio de toda a Priora em 2026-10-09): **máxima precisão operacional com o mínimo de recursos necessários.** Na prática:
- observar uma vez e reutilizar;
- persistir fatos confiáveis uma única vez;
- nenhum OCR duplicado;
- nenhum scraping duplicado;
- nenhum polling duplicado;
- regras determinísticas antes de IA (não usar IA para fato determinístico);
- nenhuma cópia do mesmo fato em vários módulos;
- nenhum recálculo sem mudança material;
- nenhuma infraestrutura especulativa sem necessidade operacional atual (S7/S8 seguem YAGNI: só os contratos necessários às fases atuais, reutilizáveis, sem refatoração ampla de Demurrage, Courier ou Auditoria).

**A correção operacional sempre prevalece sobre a economia de custos.**

## 7. Terminalidade

- **LIBERADO é terminal** (cap. 39). O único gatilho é a consulta do CE House no SISCARGA confirmar ausência de pendência de frete **e** fiscal, com consulta fresca obrigatória (N-17).
- A prova de conclusão é preservada: CE House consultado, retorno, data/hora e fonte.
- Correções ou retificações posteriores não reabrem automaticamente a liberação. A mudança posterior de um fato de Master não reabre um processo já LIBERADO e pode afetar só os vinculados ainda ativos (N-16).

---

## 8. Derivações aprovadas

As derivações abaixo **aplicam decisões já fechadas a casos que elas não citam por escrito**. Elas não criam regra nova. Foram aceitas com o plano consolidado, inclusive o comportamento corrigido do N-11.

**D-1 — Mapeamento de classes (N-11 corrigido).**

| Classe | Situações |
|---|---|
| **A** | condição do N-10; cobrança ao armador devida, com a janela de 48h vencida depois da ATA/atracação (H-10), exibida em Acompanhamento de Liberação |
| **B** | Master não localizado em T-10 ou depois; Master não localizado com ATA ocorrida |
| **C** | ações disponíveis da Rocket (ver abaixo); Master não localizado antes de T-10 ou com ETA desconhecida (ação "verificar/identificar a situação do Master") |
| **D** | bloqueio externo: cliente, agente ou armador; ação de Master bloqueada por processos vinculados (N-13) |

- **Por que a cobrança fica em Acompanhamento:** o cap. 35 limita a Fila Principal a ações pré-desbloqueio, e o cap. 37 atribui ao Acompanhamento o que é "monitorado ou cobrado".
- **Ações disponíveis da Rocket (C):**
  - agendar, só com o Master resolvido;
  - preparar ou enviar apresentação, memorando, motoboy;
  - validar o HBL físico;
  - executar a ação de Master liberada pelo N-13;
  - apresentar Evergreen depois da atracação e do pagamento.
- **T-48h e pendência fiscal:** ficam na visão CE/Prazos Regulatórios e **não viram classe** na Fila Principal (cap. 10, 35).

**D-2 — T-10.**
- T-10 é o marco funcional de **escalada de C para B** do Master não localizado, além de atenção forte. Não cria a condição (cap. 25).
- Com ETA só em data `D`, o marco começa às 00:00 de D−10, no fuso aplicável, com o mesmo fallback do N-19. Antecipa em até ~24h e nunca atrasa.
- Com ETA desconhecida, o processo fica em C, com "Referência temporal indisponível" (N-11 corrigido).

**D-3 — Classe e ETA vigente.**
- A classe acompanha a **ETA oficial vigente** (N-16). Se uma ETA nova afastar o processo de T-10, ele volta a C, com histórico (mesmo padrão de retirada do N-19).
- Uma ETA já confirmada continua valendo durante indisponibilidade da fonte (N-17). O processo não volta a C por indisponibilidade.

**D-4 — Ação C depois da chegada.** Uma ação C continua C depois da chegada. A urgência aparece na ordenação, porque o grupo ATA vem primeiro dentro da classe. A exceção é a escalada do Master não localizado (D-2).

**D-5 — Proximidade da liberação efetiva** (4º desempate). É medida pela **etapa do cap. 33**: a etapa mais avançada vem primeiro.

**D-6 — Determinação da etapa.**
- A etapa é calculada **só a partir de marcos confirmados**. "Fonte não integrada" nunca equivale a "não ocorreu" (cap. 7, 41).
- Em verticais parciais, enquanto marcos posteriores não têm fonte (ações da Rocket ainda não registradas na Priora, apresentação, SISCARGA), etapa, bloqueador e próxima ação aparecem como **"não determinável — marcos posteriores sem fonte"**.
- Por isso a Vertical 1 não tem Fila nem classe, e **não afirma "Master não localizado"** enquanto Courier, Wave e emissão no destino não tiverem todos fonte integrada (cap. 7, 25).

**D-7 — Mensagem do N-15.** "Master apresentado antes deste processo ser vinculado" diz respeito à **apresentação** (L8). Para outros fatos de escopo Master, como o Master físico, vale o mesmo mecanismo de vínculo tardio: o fato propaga e registram-se a data do vínculo e a evidência que o causou.

**D-8 — Precisão dos instantes da janela de 48h.** Depende dos contratos de HeadCargo e portais, que ainda não existem. Vale "nunca inventar hora" (N-5, N-19). É item técnico condicionado ao contrato, não decisão funcional.

**D-9 — Master físico e propagação.** O Master físico resolve-se pela conferência do MBL do próprio processo no Courier (H-2). A propagação a outros processos depende do vínculo documental Processo ↔ Master (H-7, N-18).

---

## 9. Regras de execução aprovadas (L0)

Estas regras foram aprovadas durante a L0 e valem para todas as fases. O detalhe está em `docs/liberacao-fase-l0.md` e `docs/liberacao-plano.md`.

- **Preflight obrigatório antes de qualquer teste de banco:**
  - `DEMURRAGE_DATABASE_URL` e `DEMURRAGE_TEST_DATABASE_URL` definidas;
  - as duas apontando para bancos diferentes;
  - `DATABASE_URL` ausente;
  - se qualquer condição falhar, os testes são abortados.
  - **Motivo:** as suítes executam `TRUNCATE … CASCADE` e `DROP SCHEMA public CASCADE`.
- **Restrição operacional do scheduler da Demurrage:** enquanto não houver um kill switch aprovado, **não se inicia a Priora com banco configurado** em ambiente onde credenciais reais de tracking ou Graph possam ser alcançadas.
- **Fases após a L0:** cada uma (começando pelo diagnóstico de S6) exige autorização explícita.
