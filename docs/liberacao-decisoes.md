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

---

## 10. Decisões de produto da L1b (motor de decisão puro completo)

> **Status:** P1–P9 aprovadas pelo responsável pelo produto na autorização da L1b (2026-10-14), depois do diagnóstico da L1b; P10–P13 aprovadas nas correções finais da L1b, antes do commit.
> Registro aditivo: nada acima foi alterado. A L1a continua congelada; a L1b é aditiva, ao lado dela, com contrato próprio.

### P1 — Master Apresentado × Acompanhando Desbloqueio
- **MASTER_APRESENTADO** é etapa própria. O processo fica nela enquanto a condição financeira do armador não está resolvida, e essa condição é o bloqueador.
- Apresentação + condição financeira resolvida → **ACOMPANHANDO_DESBLOQUEIO**. A janela de 48h começa nesse momento, pelo **instante válido mais recente** das duas.
- **Maersk:** a apresentação basta.

### P2 — Etapas do procedimento por agência
- **Unimar / Maersk:**
  - etapa 3 (Apto para Procedimento) → agendamento iniciado = 4;
  - agendamento confirmado, pronto para a apresentação física = 5;
  - status **Finalizado** no portal = 6 (o Finalizado é a evidência).
- **MSC / Rochamar:**
  - a etapa 3 exige Master resolvido + portão do cliente; preparar o memorando não é apresentação;
  - depois de "Enviar para apresentação" → 4;
  - memorando carimbado + "Confirmar apresentação" do Analista → 6;
  - não existe etapa 5 artificial.
- **Grieg / Evergreen:**
  - preparação / memorando / aviso por e-mail = 4;
  - etapa 5 só com atracação real confirmada + pagamento ao armador finalizado + portão do cliente;
  - depois do envio, segue no fluxo de apresentação até protocolo carimbado + Analista → 6.
- **Armador conhecido fora da matriz:** etapa `PREPARACAO_OPERACIONAL`, bloqueador `PROCEDIMENTO_DE_APRESENTACAO_NAO_MAPEADO`, nenhuma recomendação. Armador **desconhecido** é outro caso (informação que falta).

### P3 — Conflito no S2
- CONFLITO do S2 não é "Master não localizado" e não escolhe Master.
- Etapa `PREPARACAO_PARA_LIBERACAO`; bloqueador = conflito de identidade/vínculo; responsável Rocket/Analista; próxima ação = resolver o conflito; classe C. Nada se propaga a partir dos candidatos.
- **Processo ativo vinculado (N-13)** = vínculo publicado e válido + não LIBERADO. Processo em CONFLITO não bloqueia um Master candidato. Nenhuma semântica de cancelamento é inventada.

### P4 — Várias modalidades
- Várias modalidades válidas não criam, sozinhas, divergência; todas são preservadas.
- Modalidade corrente = a de **instante factual mais recente**; um fato mais novo a troca.
- Empate exato não é resolvido por ordem de array, lexical ou técnica: o Master continua resolvido, a modalidade corrente pode aparecer como ambígua, e o empate não inventa procedimento de agência.
- A modalidade nunca escolhe a agência (a matriz escolhe).

### P5 — Override
- **Escopo:** processo + pendência/episódio específico + ação específica. `INICIAR_PROCEDIMENTO` não autoriza `APRESENTAR`.
- Não resolve a pendência.
- Pode cobrir condição desconhecida/indisponível só quando a solicitação a identifica explicitamente **e** o aprovador a aceita expressamente.
- **Fim:** mudança material o invalida; não há prazo; deixa de valer depois da execução, da resolução da pendência ou de mudança material.
- Solicitante ≠ aprovador; ANALYST solicita; MANAGER/ADMIN decide.
- Não existe override global de Master, nem override de impossibilidade externa (Evergreen antes da atracação, Master não resolvido, evidência de apresentação ausente).

### P6 — Pedido de modalidade
- Depois da confirmação do pré-alerta, faltando modalidade → **uma** ação Rocket combinada pedindo ao agente a modalidade do HBL (físico/Telex) e do MBL (físico/Wave/destino). Pede-se só o que falta; nunca se repete depois de obtida a informação.
- A L1b não envia e-mail.
- Modalidade do House desconhecida → nunca se adivinha; a próxima ação é identificá-la. Físico segue o caminho A/B; Telex aguarda e-mail válido do agente.

### P7 — Pagamento ao armador
- Pendente do lado da Rocket → `ROCKET_FINANCEIRO`, classe C.
- Rocket já pagou e falta só confirmação/baixa externa → espera externa.
- Fonte de verdade: HeadCargo. A exceção Maersk continua.

### P8 — Cobrança do desbloqueio
- O relógio de 48h começa pelo P1, mas a cobrança só é devida depois da **atracação real** confirmada. ATA sozinha nunca a dispara.
- Janela vencida antes da atracação → a cobrança aparece imediatamente na atracação.

### P9 — Fonte fora do ar
- Integrada mas indisponível, sem fato anterior → NÃO DETERMINÁVEL / INFORMAÇÃO INDISPONÍVEL, sem classe A–D.
- Com fato anterior → mantém o fato e o seu efeito de gate (N-17).

### P10 — Grieg / Evergreen depois do envio
- Depois que a Evergreen/Grieg fica apta para apresentação e o Analista executa "Enviar para apresentação":
  - a etapa principal continua **APTO_PARA_APRESENTACAO**;
  - expõe-se o subestado operacional **APRESENTACAO_EM_ANDAMENTO**, com a mensagem "Apresentação em andamento — aguardando protocolo carimbado";
  - a etapa principal **não regride** para PROCEDIMENTO_EM_ANDAMENTO;
  - **não** se marca MASTER_APRESENTADO.
- Só protocolo/memorando carimbado + confirmação do Analista estabelece MASTER_APRESENTADO.
- Decisão explícita de produto: preservar a progressão da etapa e, ainda assim, representar o fato da apresentação em andamento.

### P11 — Armador fora da matriz continua acionável
- Armador conhecido, mas fora da matriz congelada:
  - etapa continua `PREPARACAO_OPERACIONAL`;
  - bloqueador `PROCEDIMENTO_DE_APRESENTACAO_NAO_MAPEADO`;
  - responsável Rocket; próxima ação `VALIDAR_MAPEAR_PROCEDIMENTO_DE_APRESENTACAO`; classe C.
- Nunca se infere agência; nunca se recomenda agendamento, memorando ou apresentação até o mapeamento ser validado.
- O processo não some da atenção operacional só porque o procedimento não está mapeado.

### P12 — Master resolvido sem armador
- Operacionalmente, um Master conhecido normalmente tem armador conhecido; isto é um **estado defensivo de inconsistência**, não um fluxo normal.
- Master resolvido sem o fato confiável de armador:
  - responsável Rocket/Analista; próxima ação `IDENTIFICAR_ARMADOR_DO_MASTER`; classe C;
  - expõe-se atenção de inconsistência de dados/identidade;
  - nada se infere de prefixo do MBL, padrão de texto, tracking ou aproximação.
- Existindo o fato confiável de armador, vale a matriz normal.

### P13 — BL encaminhado para apresentação
- Fato operacional puro **`BL_ENCAMINHADO_PARA_APRESENTACAO`**: o Analista registrou que o BL/pacote documental foi de fato encaminhado para apresentação.
- Preserva: identidade do Master; agência/fluxo quando conhecido; autor; instante; evidência/referência quando houver.
- **Não é prova de apresentação.**
  - **MSC / Rochamar / Grieg:** o registro do envio estabelece APRESENTACAO_EM_ANDAMENTO; não estabelece MASTER_APRESENTADO; continua exigido o protocolo/memorando carimbado + confirmação do Analista.
  - **Unimar / Maersk:** o Analista pode registrar o encaminhamento, para rastreabilidade; isso **não** vira gate adicional; o status **Finalizado** no portal continua suficiente, sozinho, para MASTER_APRESENTADO; a ausência da marca manual nunca impede um Finalizado válido de provar a apresentação.
- Em todo fluxo: **encaminhado ≠ apresentado**.

## 11. Regras fechadas para a L1b

- **Identificado mas não resolvido ≠ não localizado:**
  - envelope em trânsito → espera externa;
  - envelope entregue sem conferência do MBL → a Rocket confere (C);
  - MBL ausente na conferência → acompanhamento com o agente (externo);
  - Wave identificado e não confirmado → espera do agente;
  - emissão no destino anunciada → a Rocket consulta o armador, se ainda não consultou; depois, espera do armador.
- **MASTER_NAO_LOCALIZADO** exige as três fontes (Courier, Wave, emissão no destino) integradas e observáveis, nenhuma evidência, nenhuma modalidade identificada e nenhum conflito. Fonte fora impede a conclusão.
- **Armador:** só conta fato confiável fornecido — nunca prefixo do MBL, padrão, palpite de tracking ou aproximação.
- **Classe C para ações da Rocket:** consultar o armador sobre a emissão no destino, conferir o MBL entregue, revisão do Termo ambíguo pelo Analista, pedir a modalidade ao agente. "Verificar desconsolidação" continua regulatório.
- **T-48h:** fonte do CE House indisponível sem fato anterior → nenhuma condição "CE House ausente".
- **Falha da Rocket:** só com evidência positiva contra uma obrigação explícita; nunca com prazo inventado.
- **`CE_MASTER_RETIFICADO`:** fato confiável consumido. Antes dele, o responsável é o armador; depois, Rocket/desconsolidação podem retificar o CE House.
- **Etapa não determinável na prioridade:** empata na proximidade e segue para o próximo critério.
- **Fontes semânticas separadas:** Wave, emissão no destino, Telex, pré-alerta/modalidade, financeiro do cliente no HeadCargo, Termo Único, pagamento ao armador, frete no SISCARGA, fiscal no SISCARGA, Courier, procedimento da agência, VesselCall, Auditoria do CE House.
- **Terminalidade:**
  - `concluirPeloSiscarga` só cria a prova a partir de uma verificação final fresca e bem-sucedida, do CE House atual, com frete e fiscal sem pendência;
  - depois de LIBERADO, contradições posteriores não o invalidam;
  - dado velho ou parcial nunca cria LIBERADO.
- **Tempo:**
  - só existem T-10, T-48h e a janela de 48h;
  - **T-10:** exato → ETA − 10 dias; só data → 00:00 de D−10 no fuso confiável (fallback do N-19); ETA desconhecida → C + referência indisponível; ETA mais nova move C↔B; fonte fora mantém a ETA;
  - **T-48h:** primeiro a atracação prevista no porto final, a ETA como reserva; só data → 00:00 de D−2; fuso da fonte, depois do porto, depois o fallback brasileiro só-data (`America/Sao_Paulo`, OPERATIONAL_FALLBACK); sem segurança → nenhum limiar; precisão melhor recalcula o mesmo episódio; uma única condição ativa;
  - **janela de 48h (D-8 estrito):** nunca inventar hora; precisão insuficiente → nenhuma cobrança, incerteza exposta; reversão PAGO→NÃO PAGO deixa o gate não resolvido; um novo PAGO dá um novo instante;
  - **ordenação por ETA com precisão de DATA:** nenhum 00:00 fictício; valores da mesma data que não podem ser ordenados empatam.
- **Resolução do Master** cobre todos os casos: físico, Wave, emissão no destino, identificado-não-resolvido, não localizado, indisponível, não integrado, conflito e histórico.
- **Portão do cliente:** Termo × Financeiro × House × Override, com todos os estados; tecnicamente possível ≠ operacionalmente permitido.
- **Master compartilhado:** segundo passo puro.
  - A etapa continua individual; uma ação por Master; um processo bloqueado a bloqueia; os bloqueadores são listados.
  - O override de um processo libera só o que cobre.
  - A L8 registra a execução; a propagação segue o vínculo; vale o N-15; LIBERADO não reabre.
- **Matriz:** Unimar — ONE, PIL, HMM, CMA CGM, COSCO, OOCL, Yang Ming; Maersk — Maersk; MSC — MSC; Rochamar — Hapag-Lloyd, ZIM; Grieg — Evergreen. Nada mais.
- **Prioridade:**
  - ordem: classe → grupo temporal → ETA onde comparável → proximidade da etapa onde conhecida → tempo aguardando; sem pontuação;
  - N-10 = A; não localizado antes de T-10 = C; em/depois de T-10 = B; ATA = B; ETA desconhecida = C + REFERENCIA_TEMPORAL_INDISPONIVEL;
  - C continua C depois da chegada; T-48h e fiscal nunca são classe; a cobrança de 48h é A só com a janela vencida e a atracação confirmada;
  - identificador estável só como último desempate.
- **Regulatório:** condições puras para CE House, T-48h, CE Master inferido (sem afirmação sobre as 72h), pendência fiscal, e-CAC, mudança de rota, sequência de retificação e N-10 — separadas da classe da fila.
- **Arquitetura:** L1a congelada; a L1b é aditiva, com contrato próprio, e não alarga `FatoDoMaster`. Propriedade de compatibilidade: com toda fonte posterior à L1a NAO_INTEGRADA, a L1b projetada pela fachada é igual ao resultado congelado da L1a.

## 12. Correções técnicas aprovadas antes do commit da L1b

Aplicam regras já congeladas; não criam regra nova.

- **Matriz — CMA CGM:** a busca usa a forma canônica determinística de um fato de armador **já confiável** (maiúsculas; espaços, hífens e sublinhados viram um `_`), de modo que "CMA CGM" é `CMA_CGM` → Unimar. Nada de aproximação, prefixo de MBL ou padrão: outra grafia é outro código.
- **Atracação não substitui ATA:** na ordenação normal do N-11, ATA existente → grupo de chegada ocorrida; sem ATA, usa-se a ETA. A atracação real só tem os papéis aprovados: gate da Evergreen e cobrança da P8.
- **Nenhum dia fabricado por UTC:** ETA/hora sem fuso confiável não é convertida para UTC para achar o dia. Preserva-se o valor bruto e a precisão; o dia é o local num fuso confiável (fonte ou porto) ou, sem ele, o dia escrito pela fonte. Hora sem confiança degrada para a data conhecida. O fallback operacional do N-19 não dá dia factual (só materializa T-10/T-48h).
- **Prioridade preserva toda ordem comprovada:** classe → grupo temporal → ETA formam uma ordem parcial estrita (na ETA: dias diferentes ordenam; no mesmo dia, só dois instantes exatos se ordenam). A fila é uma extensão linear determinística dessa ordem; etapa e tempo aguardando só decidem onde ela não ordena. Uma ETA imprecisa nunca apaga a ordem comprovada entre outras (A 08:00 antes de C 20:00, com ou sem um B só com data). Resultado independente da ordem de entrada; comparação transitiva por conjunto.
- **Pagamento ao armador:** nenhum status HeadCargo é inventado antes do contrato (o oficial é só pendente/finalizado). "A Rocket já executou e aguarda baixa externa" é **fato operacional separado** do financeiro da Rocket; sem ele → `ROCKET_FINANCEIRO`, C; com ele → espera externa, D. O oficial do HeadCargo continua independente.
- **Termo incompleto ≠ reprovação:** campos obrigatórios faltando → `PENDENTE_DE_CORRECAO`, responsável cliente, com os campos concretos. Reprovação só para invalidade conclusiva (signatário não outorgado, procuração vencida, poderes insuficientes). Assinatura/procuração ambígua ou não verificável continua em revisão.
- **Apresentação só com data continua só data:** o instante técnico de registro nunca é o momento factual; o marco mostra a data; a janela de 48h não usa hora inventada. Quando a própria confirmação do Analista é o evento factual, o seu instante vale como esse fato — os dois casos ficam distintos.
- **SISCARGA terminal:** antes de LIBERADO, a verificação final tem de ser fresca e válida para o CE House atual, com frete e fiscal sem pendência (contradição posterior à verificação a torna velha). Depois de LIBERADO, contradições posteriores não invalidam a prova nem reabrem o processo.

## 13. Decisões finais da L1b (aprovadas antes do commit)

> **Status:** aprovadas pelo responsável pelo produto nas correções finais da L1b, antes do commit. Registro aditivo: nada acima foi alterado.

### 13.1 P12 — etapa aprovada
- Master resolvido sem fato confiável identificando o armador:
  - etapa `PREPARACAO_OPERACIONAL`;
  - responsável Rocket/Analista; próxima ação `IDENTIFICAR_ARMADOR_DO_MASTER`; classe C;
  - atenção `INCONSISTENCIA_DE_DADOS_DO_MASTER`.
- Estado defensivo excepcional: na operação normal, o Master identificado permite identificar seu armador.
- Nunca se infere o armador por prefixo, semelhança ou heurística.

### 13.2 Grieg / Evergreen — envio antecipado
- Registrar `BL_ENCAMINHADO_PARA_APRESENTACAO` **não concede** uma aptidão que ainda não existe.
- BL encaminhado antes de cumpridas as condições obrigatórias da Evergreen (atracação efetiva, pagamento ao armador finalizado, portão do cliente):
  - preservam-se o fato do envio, o autor, o horário e a evidência;
  - **não** se promove automaticamente para APTO_PARA_APRESENTACAO;
  - mantêm-se os bloqueadores reais, inclusive atracação efetiva e pagamento ao armador;
  - sinaliza-se que houve encaminhamento antes da aptidão;
  - **não** se infere MASTER_APRESENTADO.
- Cumpridos os requisitos, aplica-se a P10 normalmente, respeitando a evidência real de apresentação.

### 13.3 Unimar / Maersk — BL encaminhado
- O Analista registrou o encaminhamento e o portal ainda não retornou Finalizado:
  - não se recomenda novamente o mesmo envio;
  - próxima ação/situação: aguardar a confirmação Finalizado.
- O registro manual continua sendo apenas rastreabilidade.
- Finalizado continua suficiente para comprovar a apresentação, independentemente do registro manual.

### 13.4 Agência do encaminhamento incompatível com a matriz
- O encaminhamento registrado indica agência diferente da determinada pela matriz oficial:
  - preservam-se o registro original e sua evidência;
  - sinaliza-se a inconsistência para análise do Analista;
  - esse encaminhamento incompatível **não** é usado para avançar a etapa;
  - **não** se infere que o Master foi apresentado;
  - **não** se corrige silenciosamente o registro histórico.

### 13.5 Grieg / Evergreen — reversão financeira após encaminhamento válido
- Se o BL foi encaminhado com atracação efetiva e pagamento ao armador **validamente confirmados** no instante do envio, preserva-se **APTO_PARA_APRESENTACAO** (etapa 5), mesmo que surja depois uma nova pendência financeira.
- Preservam-se `BL_ENCAMINHADO_PARA_APRESENTACAO`, o autor, o instante e as evidências.
- A nova pendência financeira é exibida explicitamente, com responsável e próxima ação.
- Ficam bloqueadas as ações posteriores que dependem da regularização financeira.
- **Não** se infere MASTER_APRESENTADO nem LIBERADO.
- Se a confirmação original do pagamento for **invalidada retroativamente**, a aptidão é reavaliada com base nas evidências válidas, sem apagar o histórico.
- **Distinção:** nova pendência posterior = nova observação oficial depois de uma confirmação válida (N-16b), que preserva a etapa 5. Invalidação retroativa = fato explícito que retira a validade da confirmação original como prova; nesse caso a aptidão no envio é reavaliada.

### 13.6 Grieg / Evergreen — apresentação × pagamento (Opção B)
- **Aprovada expressamente pelo responsável pelo produto.**
- No fluxo Evergreen/Grieg, quando:
  1. o BL foi encaminhado validamente para apresentação;
  2. surgiu depois uma nova pendência financeira;
  3. o protocolo/memorando carimbado retornou;
  4. o Analista confirmou a apresentação;

  a Priora **reconhece a apresentação efetivamente comprovada**.
- **Resultado obrigatório:**
  - etapa 6, **MASTER_APRESENTADO**;
  - preservam-se o encaminhamento, o protocolo e a confirmação do Analista;
  - exibe-se a pendência financeira atual, com responsável e próxima ação financeira;
  - **não** se avança para a etapa 7 (ACOMPANHANDO_DESBLOQUEIO) enquanto o pagamento exigido estiver pendente;
  - **não** se infere LIBERADO.
- **Princípio congelado:** uma pendência posterior não apaga um marco operacional anteriormente comprovado. Apresentação e pagamento são dimensões independentes.
- **Alcance:** esta regra **não** permite validar um envio originalmente irregular nem desconsiderar evidência invalidada retroativamente; valem as regras de 13.2 e 13.5 para esses casos.
- **Consequência em 13.5:** a nova pendência financeira posterior a um envio válido não bloqueia a confirmação da apresentação. A exigência de protocolo carimbado + confirmação do Analista continua.

### 13.7 Envio irregular seguido de apresentação factual
- **Aprovada pelo responsável pelo produto.**
- Uma tentativa de apresentação irregular/não autorizada **não invalida** uma apresentação factual posterior quando a evidência exigida existe.
- Retornado o protocolo/memorando carimbado e confirmado pelo Analista, registra-se **MASTER_APRESENTADO / etapa 6**, mesmo que o envio original tenha sido irregular.
- **Porém:**
  - preserva-se o evento do envio irregular;
  - preserva-se o motivo da irregularidade;
  - a exceção/atenção continua visível;
  - **não** se trata retroativamente a ação original como recomendada ou autorizada;
  - **não** se apaga nenhum override ou pré-condição faltante;
  - **não** se avança para a etapa 7 enquanto a condição de pagamento estiver pendente;
  - a janela de 48h só começa quando apresentação e pagamento são ambos válidos, pelo instante mais recente.
- **Distinção:** ESTADO FACTUAL = apresentado; CONFORMIDADE DO PROCESSO = a apresentação foi irregular.

## 14. Preparação documental, evidências e envio (aprovadas)

> **Status:** aprovadas pelo responsável pelo produto (V1–V7 da revisão da camada documental, 2026-10-15). Registro aditivo: nada acima foi alterado. Etapas, gates, matriz, portão do cliente, overrides, prova de apresentação, pagamento, janela de 48h, terminalidade, prioridade e Master compartilhado continuam como estão.

### 14.1 Termo Evergreen (Grieg)
- A Priora prepara automaticamente o termo Evergreen: identifica o Master Evergreen, usa o modelo Evergreen, preenche os campos variáveis só com dados de fontes confiáveis, preserva texto jurídico e estrutura, gera o PDF vinculado ao Master e aos processos, com versão, origem dos dados e evidência da geração.
- Os PDFs recebidos são **exemplos preenchidos**: nunca se copiam deles BL, contêiner, navio, data, responsável ou assinatura, e nenhum dado ausente é inventado. Tabela tarifária e cláusulas não são alteradas automaticamente.

### 14.2 Preparado × assinado × enviado × apresentado
- O documento está **preparado** quando a Priora gera o PDF corretamente preenchido; a assinatura não é condição da preparação.
- Fatos distintos: documento preparado; documento assinado pelo Analista; e-mail efetivamente enviado; apresentação efetivamente comprovada.
- Assinatura humana: nada de assinatura automática, simulada ou reaproveitada; a assinatura de uma versão nunca vale para outra.
- Nenhum fato documental comprova a apresentação (cap. 30).

### 14.3 E-mail da Grieg = solicitação de agendamento de apresentação (V1)
- O e-mail com o termo Evergreen preenchido e assinado e a cópia do MBL em PDF é uma **solicitação de agendamento de apresentação**. Não é BL encaminhado, nem apresentação, nem protocolo, nem desbloqueio, nem Master liberado.
- Assunto: "Solicitação de agendamento de apresentação de BL – [MBL]". Corpo: "Prezados, boa tarde. / Segue em anexo o termo Evergreen preenchido e assinado, juntamente com a cópia do MBL, para agendamento de apresentação do BL para desbloqueio. / Atenciosamente,". Anexos: termo preenchido e assinado; cópia do MBL em PDF do próprio Master (nunca anexo achado pelo nome; nunca documento de outro Master).
- **L1b:** não se mapeia para `BL_ENCAMINHADO_PARA_APRESENTACAO`; não se reutiliza `PREPARACAO_REGISTRADA` da Grieg ("memorando próprio + aviso por e-mail") sem correspondência funcional demonstrada. Não há fato L1b compatível: termo preparado, termo assinado e solicitação enviada ficam no domínio documental, rastreáveis. Contrato futuro (exige aprovação): fato próprio `SOLICITACAO_DE_AGENDAMENTO_ENVIADA` e a regra do seu efeito.

### 14.4 Outlook do Analista (V2/V3)
- A Priora prepara o e-mail (assunto, corpo, destinatário validado, anexos corretos) como **rascunho na conta Outlook do próprio Analista responsável** e o deixa para conferência. Quem envia é o Analista, por ação explícita (no Outlook ou pedindo pela Priora). A Priora não envia sozinha.
- Nunca caixa compartilhada automaticamente, nunca token de outra pessoa, nunca a caixa monitorada pela Clara.
- Envio exige o documento assinado e o MBL em PDF disponível.

### 14.5 Reenvio legítimo (V4)
- Depois de um envio confirmado, novo envio só como **reenvio explícito**: do último envio confirmado, com motivo e quem autorizou, associado à versão correta do documento. O envio original e a versão anterior são preservados.
- Duplicação acidental continua impedida: uma tentativa aberta por Master e fluxo; um reenvio por envio confirmado; resultado incerto exige conciliação antes de nova tentativa; nada é reenviado automaticamente.

### 14.6 Seleção dos serviços — MSC, Hapag-Lloyd, ZIM (V5)
- Regra operacional explícita (com fundamento escrito) + evidência suficiente (modalidade do Master provada e única) → a Priora seleciona e registra a origem.
- Ambiguidade (regras em conflito, modalidade ambígua) → escolha do Analista. Falta de evidência → nada é selecionado automaticamente.
- Não se inventa matriz de serviços; opções de modelos diferentes não são equivalentes por nome; opção incompatível com a modalidade documental nunca é marcada.

### 14.7 Atualização reativa dos modelos (V6)
- Gera-se com a última versão **cadastrada e validada**. Sem polling, sem consulta a sites, sem IA sem evento.
- Resposta da agência inequívoca e de origem confiável (resposta a um envio confirmado daquela versão, vinda de um destinatário dele ou de outro remetente confiável da agência — 14.10/14.13) → rejeição registrada, evidência vinculada, versão rejeitada, novos envios com ela bloqueados, histórico preservado. Ambígua → validação humana, sem rejeição confirmada.
- Substituto enviado pela agência → nova versão vinculada à anterior, pendente; leitura dos campos (IA pode auxiliar, nunca alterar cláusulas); validação do Analista antes do uso. O mesmo arquivo nunca é reprocessado.

### 14.8 Evidência de envio
- Estados distintos: rascunho criado; rascunho alterado; envio solicitado; envio confirmado; resultado incerto; envio não realizado.
- Envio **confirmado** só por evidência lida do Graph na caixa do Analista: a mensagem não é mais rascunho e tem data de envio. Criar rascunho ou ter o pedido de envio aceito não confirma. Nenhum identificador é inventado.

### 14.9 Assinatura dos memorandos (V7)
- MSC, Hapag-Lloyd e ZIM seguem o mesmo princípio: a Priora preenche; o Analista assina antes do encaminhamento; preparado não é assinado; nada de assinatura automática ou reaproveitada; a assinatura de uma versão não é herdada por outra.
- ⚠️ **Restringida pela DOC-31 (14.17):** o Analista assina e encaminha os memorandos **fora da Priora**; a Priora não recebe, não confere nem guarda o arquivo assinado deles.

### 14.10 Decisões aprovadas na conclusão da camada documental (2026-10-15)
- **4.1 Preparação:** a Priora preenche automaticamente; **PDF corretamente preenchido = documento preparado**, para os quatro documentos. A assinatura é etapa posterior e não altera retroativamente a preparação.
- **4.2 Assinatura:** feita pelo Analista; nenhum dos quatro documentos é encaminhado sem ela; nada de assinatura gerada ou reaproveitada. ⚠️ Restringida pela DOC-31 (14.17): só o termo Evergreen tem o arquivo assinado devolvido, conferido e encaminhado pela Priora; nos memorandos a assinatura acontece fora dela.
- **4.3 Outlook do Analista:** aprovada a ampliação da S4 para autenticação Microsoft **delegada** do Analista, com permissões mínimas, armazenamento seguro de tokens e isolamento por organização e pessoa. A conta monitorada pela Clara continua separada. Envio confirmado só com evidência do Graph.
- **4.4 Reenvios:** o Analista responsável autoriza o reenvio justificado; preservam-se envio original, motivo, autor, versões dos anexos, histórico e evidências. Resultado incerto exige conciliação confiável antes de nova tentativa; **uma busca negativa isolada no Graph não prova que a mensagem não saiu**.
- **4.5 Modelos rejeitados:** sem monitoramento de sites. A resposta da agência pode vir de **outro funcionário confiável da agência**, não só do destinatário original; mensagem ambígua → validação humana; substituto → validação humana antes do uso.
- **4.6 Seleção dos serviços:** automática só com regra operacional explícita e evidência suficiente; senão, escolha do Analista; nenhuma correspondência entre opções é inventada.
- **5 Grieg/Evergreen:** reafirmado o 14.3 (solicitação de agendamento ≠ apresentação ≠ `BL_ENCAMINHADO_PARA_APRESENTACAO`; nenhum evento L1b fabricado; nenhuma nona etapa).

### 14.11 Os quatro modelos oficiais recebidos — leitura e geração
- Os quatro arquivos (Termo Evergreen — 3 páginas; memorandos MSC, Hapag-Lloyd/Rochamar e ZIM/Rochamar — 1 página) são **exportações do Word, já preenchidas**, sem campos de formulário (só campos de assinatura digital, nos exemplos MSC e Hapag). Preenchimento por **sobreposição** sobre o arquivo oficial.
- Antes de preencher, os dados do exemplo são **removidos** (não cobertos) nas áreas declaradas no layout de cada versão: cada trecho de texto ali vira um avanço equivalente sem glifo, então o texto fixo da mesma linha não se desloca; imagens do exemplo nessas áreas (ex.: marcação de opção feita por imagem no Hapag) e, só onde declarado, traços inteiramente dentro da área (sublinhado dos links do exemplo) também saem. Anotações (assinatura digital, links), formulário, estrutura e metadados do exemplo nunca passam para o documento gerado.
- Achados nos exemplos (por isso eles nunca servem de fonte para as opções): no MSC o "X" da opção está **escondido** sob o preenchimento branco da caixa; no Hapag a camada de texto marca uma opção (☒ em "Apresentação…") e a imagem sobreposta mostra outra (☒ em "Retirada e Desbloqueio").
- Fidelidade conferida de forma independente (renderização do poppler): fora das áreas preenchidas e do lugar da assinatura o documento gerado é **igual pixel a pixel** ao oficial; os blocos de texto jurídico, as tabelas tarifária e de indenizações e a estrutura estão presentes, iguais.
- As definições (campos, fontes aceitas, layout, opções, lugar da assinatura, texto fixo) são **propostas** e só entram em uso depois de cadastradas com o arquivo oficial exato (hash) e **validadas por uma pessoa**.

### 14.12 PREPARACAO_REGISTRADA × autorização de encaminhamento (correção do mapeamento L1b)
- Semântica congelada na L1b (cap. 28 e `agencia.ts`): para MSC/Rochamar, `PREPARACAO_REGISTRADA` é "**memorando gerado**", e com ele a L1b oferece "Enviar para apresentação". É o mesmo fato que a decisão 4.1 chama de documento preparado.
- Mapeamento corrigido: o evento é entregue à L1b no instante da **primeira preparação** do memorando do armador do Master (antes: só depois da assinatura, o que fazia a L1b pedir "Preparar memorando" de um memorando já preparado).
- A **autorização do encaminhamento** é um fato documental distinto (documento vigente + assinatura humana registrada sobre ele) e é **composta por fora da L1b** (`acaoComCondicaoDocumental`): enquanto não autorizado, "Enviar para apresentação" aguarda o passo documental que falta (ex.: assinar). A L1b não foi alterada.
  - ⚠️ **Revogado pela DOC-31 (14.17):** a composição saiu; "Enviar para apresentação" é mostrada exatamente como a L1b decide, ao lado da situação documental. O mapeamento de `PREPARACAO_REGISTRADA` (primeira preparação) continua.
- Grieg: inalterado (14.3) — termo preparado, termo assinado e solicitação enviada continuam documentais.

### 14.13 Escolhas de implementação que aplicam as decisões acima (a confirmar)
- **Permissão da ação:** a solicitação de agendamento só é preparada com a permissão da ação de Master na L1b (portão do cliente / N-13 / override, cap. 7 e 38). Sem ação L1b correspondente aprovada (14.3), a permissão fica "não determinada" e nenhum rascunho é preparado.
- **Conciliação de resultado incerto:** a pessoa só pode concluir "não enviado" depois que a conciliação pelo Graph não achou a mensagem **nem pelo id nem pela busca independente pelo Internet Message ID**, declarando como verificou (a agência confirmou o não recebimento, ou o Analista conferiu Itens Enviados/Excluídos) e com justificativa. Sem Internet Message ID do rascunho, só a confirmação da agência basta. Uma pessoa nunca confirma envio.
- **Remetente confiável da agência:** destinatário exato do envio respondido, ou endereço/domínio **validado por pessoa** na configuração da organização com a autenticação do e-mail **aprovada** (DMARC); em ambos os casos a mensagem tem de responder ao envio (In-Reply-To ou mesma conversa).
- **Valores informados pelo Analista:** só onde a definição validada aceita a fonte ANALISTA (agendamento — data e hora — e local de retirada/entrega no ZIM), com autor e instante; nunca substituem dado de sistema.
- **Arquivo assinado:** a Priora registra o que os bytes mostram — assinatura digital aplicada sobre o PDF preparado, assinatura sem vínculo verificável, ou nenhuma (ex.: assinatura à mão digitalizada) — sem validar o certificado e sem bloquear.
- **Outlook do Analista:** consentimento separado do login de identidade; `Mail.ReadWrite` + `offline_access`; `Mail.Send` só se a pessoa optar pelo envio pela Priora. Conexão mantida até a pessoa desconectar (o encerramento da sessão não a revoga).
- Data do documento no fuso America/Sao_Paulo; ordem de exibição das pendências documentais.

### 14.14 Decisões aprovadas no fechamento documental (DOC-16 a DOC-21, 2026-10-15)
- **DOC-16 — Assinatura do Analista:** ⚠️ **REVOGADA** pela DOC-22/DOC-23 (14.16): a premissa "preparador = signatário" estava incorreta. Texto original mantido só como histórico:
  - quem prepara é quem assina, com os **próprios** dados (nome civil e CPF) do cadastro confiável dele (fonte `CADASTRO_DA_PESSOA`, escopo PESSOA); dado de outra pessoa é recusado; sem cadastro, o campo falta;
  - só o signatário registra o arquivo assinado (serviço e banco);
  - outra pessoa só assume um documento vigente por pedido explícito, e isso gera nova versão com os dados dela;
  - onde o texto do modelo põe quem assina como representante da empresa (Evergreen, Hapag-Lloyd, ZIM), a definição declara a exigência de poderes; sem comprovação registrada, o encaminhamento fica **pendente**. O cargo de Analista não é comprovação.
- **DOC-17 — Exportador/Importador (Hapag-Lloyd e ZIM):** é o consignatário do MBL do Master, por regra **específica** desses dois modelos (o fundamento fica no campo); não há equivalência global. Sem consignatário confiável (S2), o campo falta e indica a fonte.
- **DOC-18 — Opções e placeholders:**
  - MSC: exatamente uma opção ("Preencher com X apenas a opção desejada");
  - Hapag-Lloyd e ZIM: uma ou mais ("solicito os serviços listados abaixo"), sem incompatibilidade presumida;
  - seleção automática só com regra explícita; hoje o Analista escolhe;
  - o placeholder do Word do Hapag sai; o quadro do representante e o protocolo da Rochamar ficam.
- **DOC-19 — Prioridade das fontes (agendamento, hora, local):**
  - dado confirmado do sistema primeiro; sem ele, o Analista informa, com autor, instante e proveniência declarada;
  - informado igual ao sistema = concordante; diferente = divergência `INFORMADO_DIVERGE_DO_SISTEMA` para resolução, nunca sobrescrita;
  - hoje nenhuma fonte do sistema produz esses dados.
- **DOC-20 — Conferência humana da assinatura:**
  - obrigatória antes de qualquer encaminhamento: quem, quando e qual arquivo (hash), CONFORME ou NÃO CONFORME com motivo;
  - vale só para aquele registro e aquele arquivo: arquivo novo exige nova conferência; hash diferente ou documento não vigente é recusado;
  - a leitura dos bytes é só **indício** (`INDICIO_*`, `CERTIFICADO_NAO_VERIFICADO`). Substitui, neste ponto, o "sem bloquear" do 14.13.
- **DOC-21 — Conexão Outlook delegada:**
  - sobrevive ao logout e termina por desconexão da pessoa, revogação pela administração (ADMIN da organização) ou invalidação pela Microsoft (token revogado → cache apagado na hora);
  - usá-la exige sessão autenticada da própria pessoa (reautenticação depois do logout);
  - o motivo e quem desconectou ficam registrados;
  - o envio pela Priora vale só se pedido NA conexão (escopos pedidos ∩ concedidos).

### 14.15 Portão documental do encaminhamento

> ⚠️ **Revogado pela DOC-31 (14.17)** para MSC/Hapag/ZIM — o único caso que restava depois da DOC-28. Não há mais portão documental sobre ações da L1b; as condições abaixo valem só para a **solicitação de agendamento** da Grieg (`condicaoDaSolicitacaoDeAgendamento`). Texto original mantido como histórico.
- **Composição fora da L1b** (`acaoComCondicaoDocumental`): só RESTRINGE a execução de uma ação que encaminha documento; a ação, a etapa, o bloqueador, o responsável, a classe e a prioridade continuam os da L1b, sem nenhum fato novo.
  - ENVIAR_PARA_APRESENTACAO → memorando MSC/Hapag/ZIM;
  - APRESENTAR_EVERGREEN → termo Evergreen (**PRECISA DE SUA VALIDAÇÃO**). ⚠️ Substituído pela DOC-28 (14.16): o termo condiciona a solicitação de agendamento, não a apresentação.
- **Condições:** documento vigente e preparado + arquivo assinado pelo signatário + conferência CONFORME desse arquivo + poderes comprovados quando exigidos.
- **Fora do portão:** permissões operacionais (portão do cliente, N-13, override) e condições externas continuam da L1b, que só recomenda a ação quando elas permitem.

### 14.16 Correção do fluxo de assinatura digital (DOC-22 a DOC-30, 2026-10-15)

> Registro aditivo. **Revoga a DOC-16** (preparador = signatário) e ajusta o portão de 14.15 para a Grieg. Nada da L1b, da Demurrage ou do Blueprint foi alterado.

- **Operação real:** o signatário dos documentos é o **representante legal** da organização (signatário legal). Os Analistas preparam, aplicam no leitor de PDF (Adobe Acrobat) a assinatura digital com o certificado do representante, conforme o procedimento corporativo, e devolvem o PDF assinado à Priora para conferência, guarda e encaminhamento pelo Outlook do próprio Analista. **A Priora nunca acessa, importa, guarda ou usa o certificado, a chave privada ou a senha** — recebe só o arquivo já assinado. Quem opera o leitor de PDF não é confundido com a identidade do certificado.
- **DOC-22 — Analistas autorizados:** qualquer pessoa interna autorizada da organização (Analista, gestor ou administrador; cliente nunca) prepara, anexa o PDF assinado, confere e encaminha pelo próprio Outlook — sem restrição ao preparador original. Cada ato guarda autor, ação, instante, documento (versão) e organização, separadamente; isolamento por organização mantido.
- **DOC-23 — Signatário legal:** os campos de quem assina vêm só do **cadastro confiável e validado do signatário legal** (fonte `CADASTRO_DO_SIGNATARIO_LEGAL`, escopo SIGNATARIO) — nunca da conta Microsoft, do nome de exibição ou do cadastro do Analista. Papéis distintos e registrados: preparador, operador que anexa, identidade do signatário (documento e certificado), conferente e encaminhador. O signatário não precisa ser usuário da Priora nem ter Outlook. Sem cadastro válido (ou com mais de um vigente), os campos ficam faltando e a pendência é `DEFINIR_SIGNATARIO_LEGAL` (configuração) — nada é preenchido por aproximação. Poderes de representação vêm do cadastro do signatário, com evidência e validade; nunca presumidos.
- **DOC-24 — Conferência humana:** registra conferente, instante, identidade esperada do signatário, registro e hash do arquivo conferido, resultado, constatação e motivo quando recusado, e a versão do documento. É o que a pessoa viu no leitor de PDF: a Priora não valida certificado, cadeia de confiança nem validade jurídica (`CERTIFICADO_NAO_VERIFICADO`).
- **DOC-25 — Alteração depois da assinatura:** fatos distintos — nova versão documental (nova preparação), novo arquivo anexado (substituição), divergência de hash (recusada na conferência; anexo enviado diferente do conferido fica visível), conferência do arquivo efetivamente enviado, justificativa. Outro arquivo para a mesma versão só como **substituição justificada** (cadeia linear; os anteriores nunca mudam); se os bytes mostram alteração sobre um arquivo assinado, ela tem de ser declarada como tal. Nenhuma conferência é reaproveitada: arquivo final novo = conferência nova. Assinatura inválida, modificação que a comprometa, integridade não confirmada ou arquivo sem estrutura de assinatura digital **nunca** são conformes. A justificativa não valida nada. Não há caminho para encaminhar com conferência NÃO CONFORME (**PRECISA DE SUA VALIDAÇÃO — envio de documento cuja assinatura foi considerada inválida**: não implementado).
- **DOC-26 — Seleção de serviços:** MSC exatamente uma; Hapag-Lloyd e ZIM uma ou mais, nunca zero; seleção automática só com regra e evidência (hoje nenhuma regra: o Analista escolhe); nenhuma equivalência entre agências.
- **DOC-27 — Contêineres Evergreen:** sem limite de 6. A lista do MBL (um por linha, sem repetição — repetição é dado inconsistente e deixa o campo faltando) vai no quadro até 6; acima disso o quadro recebe a remissão ("VIDE RELAÇÃO ANEXA", total, páginas) e **todos** os contêineres, numerados e na ordem, vão em páginas adicionais ao final do mesmo PDF, cada uma identificando o termo (título, BL do Master, data) e a paginação. Páginas oficiais, cláusulas e tarifas intactas. **Extensão proposta pela Priora, pendente de aceite operacional da Grieg** — nunca considerada aceita sem confirmação registrada (atenção visível na situação documental).
- **DOC-28 — Termo Evergreen e agendamento:** fatos distintos — termo preparado, assinado, conferido, solicitação de agendamento encaminhada, agendamento confirmado (sem fonte ainda) e apresentação efetiva do Master (L1b). A solicitação exige o termo assinado e conferido (composição própria `condicaoDaSolicitacaoDeAgendamento`, fora da L1b). `APRESENTAR_EVERGREEN` deixou o portão documental: na L1b ela é a apresentação do Master apto, não o agendamento; associar o termo a ela seria reinterpretar a L1b. **PRECISA DE SUA VALIDAÇÃO:** se a apresentação Evergreen também deve exigir o termo conferido.
- **DOC-29 — Fidelidade:** pequenas diferenças de fonte aceitas (legível, sem sobreposição, corte ou deslocamento; conteúdo jurídico preservado); nenhuma dependência de fonte nova; testes visuais e textuais dos quatro modelos mantidos.
- **DOC-30 — Armazenamento e rastreabilidade** (⚠️ restringida pela DOC-31: arquivo assinado, conferência e envio só no termo Evergreen)**:** arquivo assinado ligado ao processo/Master e à versão; preservados arquivo, hash, versão, preparador, operador, signatário, conferente, justificativas, evidências de envio e histórico de reenvios e substituições; nada é sobrescrito (append-only no banco); acesso por organização e pessoa autorizada.
- **Banco:** a 0104 (ainda não aplicada em ambiente real) foi revista no próprio arquivo — `assinado_por_membership_id` → `registrado_por_membership_id` (operador); identidade do signatário em documento, arquivo e conferência; cadeia de substituições; constatação da conferência; o gatilho "só quem preparou registra" saiu. Depois de aplicada em ambiente real, só por nova migration.

### 14.17 Correção de escopo documental: MSC, Hapag-Lloyd e ZIM × Evergreen/Grieg (DOC-31, 2026-10-15)

> Registro aditivo. **Restringe** 14.9, 14.10 (4.2), 14.16 (DOC-22 a DOC-25 e DOC-30) ao termo Evergreen e **revoga** o portão de 14.12/14.15. Preserva todo o resto (preparação 4.1, dados confiáveis, opções DOC-18/DOC-26, signatário legal DOC-23 nos campos, Exportador/Importador DOC-17, contêineres DOC-27, agendamento DOC-28, fidelidade DOC-29, reenvio, conciliação, rejeição de modelos). Nada da L1b, da Demurrage ou do Blueprint foi alterado.

- **Princípio:** a Priora reduz o trabalho do Analista; não cria uma segunda operação paralela. O que a Priora faz com o documento vem do **procedimento aprovado de cada modelo** (catálogo: `procedimento`), não de uma regra global de assinatura.
- **Fluxo A — MSC, Hapag-Lloyd e ZIM (`GERAR_E_DISPONIBILIZAR`):** a Priora obtém os dados confiáveis que já tem, preenche o modelo, gera o PDF e o deixa para **visualizar e baixar**, e **para aí**. O Analista assina (Adobe) e encaminha fora da Priora.
  - A preparação documental termina quando o PDF válido é gerado e disponibilizado (passo final `DOCUMENTO_DISPONIVEL`, que não é pendência). **Isso não é apresentação do Master nem conclusão da Liberação.**
  - A Priora **não exige**: upload do PDF assinado, conferência, guarda do assinado, rascunho no Outlook, envio pela Priora, conciliação de envio, comprovação de poderes ou evidência de assinatura. Upload e conferência são recusados (`FLUXO_NAO_APLICAVEL`) e o banco não aceita arquivo assinado desses modelos.
  - Continuam: campos obrigatórios, fontes confiáveis, opções de serviço, divergências, versões do documento e os campos de quem assina preenchidos pelo cadastro do signatário legal (DOC-23) onde o modelo os tem.
- **Fluxo B — Evergreen/Grieg (`CICLO_COMPLETO`):** inalterado — prepara o termo para baixar; recebe o PDF assinado; exige a conferência humana do arquivo final; guarda o PDF assinado e as evidências; prepara o rascunho no Outlook do Analista com o termo e o MBL; permite o encaminhamento com os controles existentes; preserva histórico, versões, tentativas e evidências. A solicitação de agendamento exige o termo assinado e conferido e **não comprova a apresentação**.
- **L1b:** `PREPARACAO_REGISTRADA` continua entregue na primeira preparação do memorando (MSC/Rochamar). "Enviar para apresentação" continua sendo a ação da L1b, sem renomear, remover ou dar por executada: a Priora não sabe se o Analista já encaminhou, e **baixar o PDF não é encaminhar nem apresentar**. Situação documental, próxima ação da L1b e evidência de apresentação ficam separadas. O portão `acaoComCondicaoDocumental` (assinatura + conferência + poderes antes de "Enviar para apresentação") **saiu**; nenhum bloqueio, prioridade ou etapa foi criado.
- **DOC-31 restringe DOC-30:** armazenamento de PDF assinado somente em Evergreen/Grieg.
- **Banco:** a 0104 (ainda não aplicada em ambiente real) foi revista no próprio arquivo — o gatilho do arquivo assinado aceita só documento do termo Evergreen (conferência e envio dependem dele por FK). Nenhuma tabela nova; nenhum documento preparado precisa de assinatura, conferência, tentativa ou Outlook.
- **Dados pessoais:** os marcadores de vazamento do exemplo deixaram de conter nome, CPF ou e-mail de pessoas; o teste obtém esses dados do próprio arquivo oficial (o que a limpeza remove) na hora de conferir. (Revisto em DOC-31.C/§5 abaixo: a sanitização tem teste unitário com fixture sintética; a checagem com os oficiais virou só validação estrutural, sem reproduzir dado nem hash em mensagens.)

#### DOC-31.A — Representação legal sem bloqueio documental (Hapag-Lloyd e ZIM)
- A Priora preenche nome e CPF do representante legal **pelo cadastro confiável do signatário legal** (DOC-23), nunca por dado do Analista.
- Não há pendência de comprovação de poderes, nem bloqueio de geração, visualização ou download por falta dela, nem upload de procuração/certificado/documento de representação, nem conferência de assinatura na Priora. O Analista assina e encaminha pelo procedimento externo.
- Continuam as validações normais de dados obrigatórios e de integridade do documento. A ausência de bloqueio **não** é declaração de validade jurídica dos poderes: a Priora simplesmente não participa dessa conferência neste fluxo. O texto do modelo continua declarando o quadro do representante (definição inalterada).
- Evergreen/Grieg: inalterado (poderes comprovados antes da solicitação de agendamento).

#### DOC-31.B — Atualização só por alteração de dado efetivamente usado no PDF
- Documento gerado/disponibilizado + fato do processo mudou → **pendência de atualização só se mudar o que o PDF daquela versão mostra**: o valor **escrito** de um campo (formato do lugar; espaços repetidos não contam), as alternativas marcadas de um grupo de opções ou a versão do modelo. Ex.: MBL impresso, consignatário do memorando, viagem ou contêiner impressos → exige; dado do processo que não está no documento, reprocessamento (OCR) com o mesmo valor, outra evidência, outro instante de observação, outro processo vinculado sem campo no documento → não exige.
- A pendência (`GERAR_NOVA_VERSAO`) lista os campos alterados (com o rótulo do modelo) e diz: "O PDF disponibilizado pode estar desatualizado e precisa ser regenerado." — sem afirmar que o arquivo baixado foi substituído ou recolhido.
- Nenhuma versão é criada automaticamente: a nova versão só nasce quando a pessoa gera de novo; a anterior fica no histórico (append-only). Comparação isolada por organização, Master e modelo documental. Mudança documental nunca vira envio, apresentação ou agendamento; a L1b continua recebendo só a primeira preparação.
- **Sem dados para verificar** um campo usado no PDF (sem valor confiável ou divergente agora), nada é presumido: o estado é explícito — vigência **não verificável** ("Não é possível confirmar se o PDF disponibilizado continua atual…"), com os campos não verificados, e a pendência é a do dado (obter/analisar). Se outro campo mudou comprovadamente, os dois aparecem.
- Evergreen já assinado, conferido ou encaminhado: aplica-se o versionamento existente — nova versão exige nova assinatura e nova conferência; reenvio só explícito; assinatura antiga nunca vale para bytes novos.

#### DOC-31.C — Situação documental separada da próxima ação operacional
- MSC, Hapag-Lloyd e ZIM, após geração válida: situação documental **"Documento disponível para download"** (campo `texto` da situação). É só situação documental.
- A próxima ação operacional continua sendo a da L1b, apresentada à parte e não ocultada porque a preparação terminou. Nenhuma resposta documental traz "Master apresentado", "Apresentação concluída", "Enviado" ou "Liberado", nem ação operacional.
- Onde chega hoje: a situação documental só sai pela API `GET /api/liberacao/documentos/masters/:id`; a tela de Liberação mostra a próxima ação da projeção L2. Mostrar as duas lado a lado na tela fica para a integração da decisão da L1b (L8).


### 14.18 Reutilização determinística dos fatos do MBL (Entrega 1, 2026-10-17)
- **H1 (aprovada):** a Priora pode preencher automaticamente os documentos da Liberação com dados **confiáveis** do MBL, sem confirmação campo a campo, desde que o documento correto esteja identificado, a origem seja rastreável e não existam divergências relevantes. A geração e o preenchimento são determinísticos; a Clara não reinterpreta dado já extraído. H1 **não** promove resultado de OCR a verdade operacional.
- **Confiável (só regras já aprovadas):** extração de MBL pelo conteúdo, legível, que sustenta vínculo **válido** Processo↔Master com ESTE Master (identidade S6/S2 inalterada; mesmo critério da cópia do MBL); evidência `auditoria_extracao:{id}`. Por dado:
  - **navio e viagem:** o texto que o OCR leu do MBL (nunca o do rastreamento S3 sem regra aprovada);
  - **contêineres:** todos no padrão ISO 6346 com dígito verificador (PB-001, N13) e sem repetição (DOC-27);
  - **consignatário** (razão social e qualificação): **não publicado** — o OCR devolve um texto livre e não há critério aprovado para isolar razão social nem "uma informação por linha" (fica preservado como extraído; **PRECISA DE VALIDAÇÃO** para mudar).
  - Uma leitura **não confiável** de um dado em qualquer versão do MBL retém o dado em todas (não dá para afirmar que não há divergência); extração anterior à 0106 (sem campos) não retém nada. O que não é publicado aparece no que falta, com o motivo.
- **Versões do MBL (política aprovada):** cada anexo é identificado pela **mensagem + anexo do Outlook**, nunca pelo nome; o SHA-256 dos bytes **já obtidos** para o OCR identifica conteúdo idêntico (reaproveitado sem OCR, na mesma organização e na mesma versão do extrator) ou diferente (outra versão, lida **uma única vez**). Todas as versões ficam, com a própria origem; nada é sobrescrito. Valores diferentes entre versões **divergem** e não se escolhe a mais recente nem a mais antiga. Sem OCR em massa nem reprocessamento periódico: só os anexos do processo auditado, e só com os fatos duráveis ligados. PB-001, prompts do OCR, identidade Processo↔Master e L1b inalterados; a escolha de um documento por tipo para o Playbook antigo também não mudou.
- **Migração 0106 (aprovada, aditiva):** `auditoria_extracoes.campos_documentais` (navio, consignatário e números de contêiner como o OCR devolveu) e `auditoria_extracoes.arquivo_sha256`; append-only mantido; linhas anteriores ficam NULL. Versão do contrato da extração: `EXTRATOR_VERSAO = '2'`.
- **Comparação única:** a divergência entre fontes no preenchimento passa a usar o mesmo valor **escrito** da DOC-31.B (`valorEscritoNoLugar`); leituras que só diferem em espaços concordam.
