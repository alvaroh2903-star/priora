> **Transcrição fonte — Blueprint Liberação Priora V1 (congelado). Não editar o conteúdo abaixo do separador.**
>
> - **Documento original:** `Blueprint_Liberacao_Priora_V1_Congelado.docx`, com 56.741 bytes e SHA-256
>   `a531d22bf0d9778757d85e00d72a0a03eada114add8be226e22f1f3e6f9a0739`.
> - **Versão:** congelada para implementação, 4 de outubro de 2026.
> - **Autoridade:** o `.docx` original continua sendo a fonte humana autoritativa. Se houver diferença
>   entre esta transcrição e o `.docx`, vale o `.docx`.
> - **Hierarquia na Liberação:** Blueprint congelado → decisões aprovadas (`docs/liberacao-decisoes.md`)
>   → implementação. Quando o código herdado conflitar com essa autoridade, quem se adapta é o código,
>   nunca o Blueprint.
> - **Convenções de transcrição:**
>   - o texto é integral, sem edição de conteúdo;
>   - Título → `#`; Partes → `##`; capítulos e seções → `###`;
>   - regras destacadas e a caixa "Status desta versão" → citação (`>`);
>   - marcadores "•" → itens `-`; tabelas → tabelas Markdown;
>   - quebras de página e formatação tipográfica (negrito, cores, sombreamento) não são reproduzidas.
> - **Verificação:** o texto de todos os parágrafos e células do `.docx` foi comparado, em ordem, com o
>   conteúdo abaixo do separador, e é idêntico.

---

PRIORA

# Blueprint Liberação Priora V1

Especificação funcional do módulo

Versão congelada para implementação

4 de outubro de 2026

### Apresentação

Este documento consolida as regras funcionais do módulo de Liberação da Priora. O objetivo é transformar o processo de liberação marítima em um motor de decisão operacional: identificar o que já está resolvido, o que bloqueia o avanço, quem precisa agir e qual é a próxima ação que efetivamente aproxima o processo do desbloqueio.

O Blueprint descreve o fluxo desde o pré-alerta e a formação do CE House até a resolução do House e do Master, os procedimentos por agência, a apresentação, o acompanhamento no SISCARGA e a conclusão. O módulo não deve se comportar como um checklist linear nem como um regulador genérico de CE Mercante; ele organiza as ações de liberação e mantém filtros específicos para riscos regulatórios e acompanhamento.

> Status desta versão
>
> Blueprint funcional CONGELADO após revisão capítulo a capítulo. As regras abaixo constituem a fonte de verdade funcional do módulo de Liberação. Qualquer alteração futura em etapa, gate, fonte de verdade, prioridade, responsabilidade, evidência, override ou condição de conclusão exige validação explícita antes de ser incorporada. Integrações automáticas com HeadCargo e SISCARGA fazem parte do MVP final, embora seus endpoints ainda não estejam disponíveis nesta etapa.

### Sumário

PARTE 1  FUNDAMENTOS E REGRAS ESTRUTURAIS

1. Visão e objetivo do módulo

2. Escopo e limites funcionais

3. Entidades e unidade de controle

4. Modelo operacional: etapa, bloqueador e próxima ação

5. Fontes de verdade, evidências e divergências

6. Papéis, permissões, governança e auditoria

7. Integridade de dados e princípios de decisão

PARTE 2  PRÉ-ALERTA, CE MERCANTE E SISCARGA

8. Conferência do pré-alerta e envio à desconsolidação

9. Ciclo do CE Master e do CE House

10. Prazos operacionais de 72h e 48h

11. Consulta do CE House no SISCARGA

12. Pendência fiscal, e-CAC e tratamento de exceção

13. Mudança de rota e retificação dos CEs

PARTE 3  HOUSE, CLIENTE E PORTAL

14. Obrigações do cliente e condição de aptidão

15. HBL físico e confirmação humana

16. Telex Release

17. Termo Único

18. Termo por Embarque, procuração e assinatura digital

19. Pagamento ou prazo do cliente via HeadCargo

20. Portal do Cliente e retorno imediato

PARTE 4  MASTER, AGÊNCIAS E APRESENTAÇÃO

21. Identificação e resolução do Master

22. Master físico via Courier

23. Wave BL

24. Emissão no destino

25. Master não localizado

26. Matriz armador × agência

27. Unimar e Maersk: agendamento e apresentação

28. MSC e Rochamar: memorando e apresentação

29. Evergreen / Grieg e a exceção de apresentação antecipada

30. Evidências de apresentação e estado do Master

31. Pagamento ao armador via HeadCargo

32. Janela de 48h e cobrança do desbloqueio

PARTE 5  MOTOR DE LIBERAÇÃO, FILAS E CONCLUSÃO

33. Máquina de estados operacional

34. Master compartilhado e múltiplos Houses

35. Regra de entrada na Fila Principal

36. Prioridade e critérios de desempate

37. Filtros e visões operacionais

38. Override e exceções autorizadas

39. Condição final de Liberação e terminalidade

40. Interface, cards e detalhamento do processo

41. Dados indisponíveis, falhas de integração e estados desconhecidos

42. Integrações do MVP final e dependências técnicas

43. Cenários de aceitação e critérios de congelamento

## PARTE 1  FUNDAMENTOS E REGRAS ESTRUTURAIS

### 1. Visão e objetivo do módulo

O módulo de Liberação deve organizar a operação para responder, a qualquer momento: qual processo pode avançar, o que ainda impede o desbloqueio, quem precisa agir e qual é a próxima ação relevante. O valor do módulo está em reduzir procura, retrabalho e dependência de memória operacional.

> Regra central: a Priora não deve premiar uma ação apenas porque ela é tecnicamente possível; deve priorizar ações que produzem avanço operacional real e respeitam as condições de negócio da Rocket.

A liberação é composta por frentes que evoluem em paralelo: House/cliente, Master, procedimento de agência, pagamento ao armador, CE Mercante/SISCARGA e exceções. O motor consolida essas frentes sem confundi-las em um único checklist.

### 2. Escopo e limites funcionais

- Inclui: preparação documental, resolução do House e do Master, procedimento por agência, apresentação, acompanhamento do desbloqueio, leitura das pendências do SISCARGA, fila operacional e conclusão.
- Não substitui: HeadCargo como fonte de pagamento/prazo, SISCARGA como fonte final de pendência, portal da agência quando a ação precisa ser executada pelo analista, nem e-CAC no tratamento fiscal.
- Não é: um módulo geral de fiscalização de CE. Prazos e exceções de CE são monitorados porque impactam a liberação, mas possuem filtro próprio e não devem sequestrar a Fila Principal.
- Conclusão: o processo somente é considerado Liberado quando o CE House consultado no SISCARGA retorna “Não Há Pendência”.

### 3. Entidades e unidade de controle

A unidade visual principal é o processo/House. O Master é uma entidade compartilhável: um único Master pode atender várias Houses e sua apresentação deve repercutir em todas as Houses vinculadas, sem fundir seus estados individuais.

| Entidade | Função no módulo |
| --- | --- |
| Processo / House | Unidade de apresentação, fila, responsabilidade e conclusão individual. |
| Master | Documento e condição compartilhável entre Houses vinculadas ao mesmo embarque. |
| CE Master | Registro lançado pelo armador; condiciona a disponibilidade do House para desconsolidação. |
| CE House | Identificador usado para consultar pendências e a liberação final no SISCARGA. |
| Cliente | Origem de HBL físico, Termo por Embarque, procuração e condição comercial. |
| Armador / Agência | Executam ou recebem apresentação e efetivam o desbloqueio conforme o fluxo aplicável. |
| Evidência | E-mail, foto, memorando carimbado, status de portal, retorno de HeadCargo ou SISCARGA que sustenta uma decisão. |

### 4. Modelo operacional: etapa, bloqueador e próxima ação

O sistema não deve concentrar tudo em um único status. Cada processo é representado por três dimensões independentes:

- Etapa principal: onde o processo está no ciclo de liberação.
- Bloqueador / responsável atual: quem ou o que impede o próximo avanço naquele momento.
- Próxima ação: o ato concreto que deve ocorrer para aproximar o processo da apresentação ou do desbloqueio.

> Exemplo: Etapa = Master apresentado; Responsável = Armador; Próxima ação = acompanhar desbloqueio no SISCARGA. O status não deve ser substituído por “Aguardando Armador”.

### 5. Fontes de verdade, evidências e divergências

| Dado | Fonte de verdade | Confirmação, evidência e divergência |
| --- | --- | --- |
| Pagamento / prazo do cliente | HeadCargo | Consulta automática. Pago OU prazo válido permite seguir. Indisponibilidade = desconhecido. A Priora pode reutilizar o perfil do consignatário com fonte e data da última confirmação, revalidando periodicamente. |
| Termo Único | HeadCargo | HeadCargo é a fonte de verdade. E-mail pode ser evidência complementar. Informação aprendida fica no perfil do consignatário com fonte/data e revalidação periódica. |
| Pagamento ao armador | HeadCargo | Finalizado é requisito para desbloqueio em todos os armadores, exceto Maersk. Indisponibilidade nunca significa não pago. |
| Master físico recebido | Módulo Courier | Processo marcado como Recebido é suficiente. Evidência externa válida conflitante abre divergência sem apagar o Recebido; e-mail aleatório não conta. |
| Wave BL | E-mail válido do agente/armador | O e-mail confirmando disponibilização resolve o Master. Plataforma Wave e HeadCargo podem servir como consulta complementar, mas não são gates adicionais. |
| Emissão no destino | Armador, após informação inicial do agente | O agente identifica a modalidade; o Master só fica resolvido quando o armador confirma que recebeu a autorização da origem. |
| HBL físico | Portal do Cliente + Analista | Cliente anexa foto. OCR apenas auxilia/alerta; o Analista confirma o original, vínculo com o processo, assinatura correta, imagem colorida e ausência de Copy/Non Negotiable. Foto ruim para OCR ainda segue para análise humana. |
| Telex Release | E-mail válido do agente | E-mail informando que o House está apto resolve o House. PDF do HBL encaminhado pelo agente pode reforçar o vínculo com o processo. |
| CE House / desconsolidação | Auditoria Priora | A Auditoria identifica a desconsolidação e o número do CE House a partir das evidências recebidas da desconsolidadora. Ausência a T-48h é risco/atenção, não culpa automática da Rocket. |
| CE Master | CE Mercante | Não há integração viável na V1. Existência do CE House permite inferir que o CE Master existiu, mas não comprovar se cumpriu a janela de 72h. |
| Apresentação - Unimar / Maersk | Portal de agendamento | Status Finalizado é suficiente para marcar Master apresentado; não depende de confirmação humana adicional. |
| Apresentação - MSC / Rochamar / Grieg | Protocolo/memorando carimbado + Analista | A Priora gera o documento; o envio inicia a apresentação, mas só a confirmação do Analista após retorno carimbado marca Master apresentado. |
| Liberação final | SISCARGA, pelo CE House | Liberado somente quando não houver pendência de frete nem fiscal. Resultado, CE House, fonte e data/hora são preservados; o estado final é terminal. |

Cada informação relevante possui sua própria fonte de verdade. Não existe uma precedência universal entre sistemas ou documentos. Quando evidências válidas sobre o mesmo fato forem incompatíveis, a Priora deve preservar ambas, registrar a divergência e encaminhá-la para tratamento; nunca sobrescrever silenciosamente uma delas. Ausência de resposta de integração deve produzir estado indisponível/desconhecido, e não uma conclusão negativa.

E-mails só podem sustentar decisões quando forem operacionalmente válidos e vinculáveis ao processo: remetente/agente compatível, referência ao BL/processo/documento e conteúdo inequívoco. Mensagens genéricas ou de remetente sem relação operacional não criam divergência nem substituem uma fonte de verdade.

### 6. Papéis, permissões, governança e auditoria

| Papel | Ações funcionais |
| --- | --- |
| Sistema | Consolidar fontes, calcular estados, ordenar fila, gerar termos, detectar pendências e sugerir próximas ações. |
| Analista | Executar ações operacionais, confirmar HBL físico, solicitar override, consultar evidências e tratar exceções. |
| Gestor | Aprovar ou rejeitar override e revisar exceções que rompem a regra operacional padrão. |
| Cliente | Enviar documentos e evidências pelo Portal, assinar Termo por Embarque e acompanhar retorno. |
| Terceiros | Armador/agência/agente respondem por confirmações externas e desbloqueio conforme o fluxo. |

Toda ação relevante deve preservar autor, data/hora, estado anterior, estado posterior, evidência e justificativa quando houver intervenção humana ou exceção.

### 7. Integridade de dados e princípios de decisão

- Não inferir por ausência: não ter Courier e não ter Wave não significa emissão no destino; significa Master não localizado.
- Possível ≠ permitido: a apresentação pode ser tecnicamente possível com obrigação do cliente pendente, mas a Rocket não deve prosseguir sem override.
- Apresentado ≠ desbloqueado: entrega do Master à agência nunca é prova automática de liberação.
- Indisponível ≠ negativo: falha de HeadCargo/SISCARGA deve produzir estado desconhecido, não uma conclusão falsa.
- Histórico imutável: correções posteriores não apagam o fato operacional registrado anteriormente.

## PARTE 2  PRÉ-ALERTA, CE MERCANTE E SISCARGA

### 8. Conferência do pré-alerta e envio à desconsolidação

Após o pré-alerta, a conferência documental é executada pelo módulo de Auditoria da Priora, cruzando HBL × MBL, MBL × sistema e HBL × sistema. O módulo Liberação não deve repetir essa auditoria; ele consome os fatos já validados/identificados pela Auditoria para decidir o próximo passo operacional.

Concluída a conferência, os documentos seguem à equipe terceirizada de desconsolidação. Essa equipe comunica por e-mail a conclusão, e a Auditoria da Priora identifica a evidência, a desconsolidação e o número do CE House. Liberação utiliza esses fatos como entrada, sem criar uma segunda fonte paralela.

### 9. Ciclo do CE Master e do CE House

O CE Master e o CE House cumprem papéis diferentes. O CE Master é lançado pelo armador no CE Mercante; o CE House nasce após a desconsolidação e é o identificador operacional usado pela Liberação para acompanhar pendências no SISCARGA. A Priora não possui, na V1, integração direta viável com o CE Mercante para observar o CE Master.

> Regra de observabilidade: se existe CE House, a Priora pode concluir que um CE Master existiu, porém não pode afirmar quando ele foi lançado nem se cumpriu o prazo de 72h. Sem CE House, o estado correto é “aguardando CE House / desconsolidação”, não “SISCARGA pendente”.

### 10. Prazos operacionais de 72h e 48h

| Regra | Marco | Observabilidade na V1 |
| --- | --- | --- |
| CE Master | Até 72h antes da chegada ao primeiro porto brasileiro. | Fonte real: CE Mercante. Sem API/integração viável. Não gerar alerta automático de atraso sem evidência observável. |
| CE House | Até 48h antes da atracação no porto final. | Observável pela Auditoria Priora. A T-48h sem evidência de desconsolidação/CE House, gerar risco/atenção no filtro regulatório. |

Os prazos de 72h e 48h são regras operacionais críticas, mas possuem observabilidade diferente. A regra do CE Master permanece documentada sem gerar automação falsa; a regra do CE House é observável pela Auditoria e pode gerar atenção real. CE/Prazos Regulatórios possui filtro próprio e não deve deslocar automaticamente processos aptos para liberação da Fila Principal.

### 11. Consulta do CE House no SISCARGA

Depois de gerado o CE House, a Priora deve utilizá-lo para acompanhar o SISCARGA. Pendência de frete/pagamento e pendência fiscal são consultas distintas e devem permanecer separadas no modelo. Qualquer uma delas pendente impede a conclusão como Liberado.

A pendência de frete é acompanhada de forma recorrente durante o desbloqueio. A pendência fiscal não precisa ser consultada com a mesma frequência: deve ser verificada por gatilhos de risco/evento (atraso de CE House, retificação, mudança de rota, indicação de bloqueio) e obrigatoriamente antes da conclusão final. A Priora só registra “Liberado” quando a verificação final confirmar ausência de pendência nas duas dimensões.

| Retorno | Interpretação |
| --- | --- |
| Sem pendência de frete e sem pendência fiscal | Condição suficiente para marcar o processo como Liberado; preservar CE House, data/hora, resultado e fonte. |
| Pendência de frete / pagamento | Bloqueio recorrente ligado ao armador/desbloqueio. Após apresentação + condição financeira e janela relevante de 48h, a próxima ação é cobrar o armador. |
| Pendência fiscal | Exceção menos frequente. Exige diagnóstico da causa, tratamento específico e reconsulta até desaparecer. |

### 12. Pendência fiscal, e-CAC e tratamento de exceção

A pendência fiscal é uma exceção operacional, não o fluxo normal da Liberação. Quando o CE House é lançado fora da janela de 48h, o SISCARGA pode bloquear a carga fiscalmente; nesse caso, a Rocket solicita o desbloqueio via e-CAC e depois volta a consultar o SISCARGA até o bloqueio desaparecer.

A ausência de CE House a T-48h deve aparecer primeiro como risco/atenção: “CE House não identificado — verificar desconsolidação”. Só pode ser registrada como falha da Rocket quando houver evidência de que a própria Rocket não encaminhou o pré-alerta/documentação a tempo. A existência de bloqueio fiscal não deve ser resumida a um badge genérico; causa, responsável, ação tomada e estado de reconsulta precisam permanecer visíveis.

### 13. Mudança de rota e retificação dos CEs

Mudanças de rota, como omissão de porto, podem exigir retificação. A dependência é sequencial: primeiro o armador retifica o CE Master; somente depois a Rocket pode seguir com a retificação do CE House. Enquanto isso, pode existir bloqueio fiscal temporário.

> A Priora deve mostrar quem precisa agir agora: antes da retificação do Master, Armador; depois que o Master estiver corrigido, Rocket/desconsolidação para ajuste do House. A alteração de rota pode ser identificada pelo tracking do armador e, eventualmente, por comunicado do armador. Integração direta com dados do porto é uma evolução futura e ainda não existe.

## PARTE 3  HOUSE, CLIENTE E PORTAL

### 14. Obrigações do cliente e condição de aptidão

O lado cliente é considerado concluído quando três grupos de obrigação estão resolvidos simultaneamente: Termo, condição financeira e House. A condição padrão é:

- Termo: Termo Único válido ou Termo por Embarque aprovado.
- Financeiro: pagamento realizado ou cliente com prazo aprovado no HeadCargo.
- House: HBL físico confirmado ou Telex Release confirmado pelo agente.

Essas obrigações não tornam a apresentação tecnicamente impossível, mas a Rocket não deve prosseguir sem que estejam concluídas. Qualquer avanço nessas condições exige override formal.

### 15. HBL físico e confirmação humana

Quando o HBL físico foi encaminhado ao cliente, a evidência necessária é a foto do documento original em mãos. A decisão final é sempre do Analista no card do processo; OCR/IA pode extrair dados e alertar inconsistências, mas não aprova nem reprova definitivamente o HBL físico.

- O número do HBL deve corresponder ao processo; se a IA detectar divergência, deve alertar e deixar a decisão final para o Analista.
- Deve existir assinatura válida/correta do agente.
- A imagem deve ser colorida e permitir ao Analista reconhecer o documento original.
- O documento deve apresentar condição de original.
- Não pode constar “Copy”, “Non Negotiable”, “Cópia não negociável” ou equivalente que descaracterize o original.
- A imagem permanece disponível no card do processo para conferência operacional e auditoria.

Fotos pouco legíveis para OCR não devem ser rejeitadas automaticamente nem gerar pedido de novo upload por regra. Elas seguem para aprovação humana; somente o Analista decide se a evidência visual é suficiente.

### 16. Telex Release

No fluxo Telex, não se exige evidência física do HBL. O House é resolvido quando um e-mail operacionalmente válido do agente vinculado ao processo confirma que o House está apto para liberação. Na maioria dos casos o próprio agente também encaminha o PDF do HBL para emissão; esse PDF pode reforçar o vínculo entre agente, House e processo, sem se tornar um segundo gate obrigatório.

> Telex Release pertence ao House. A Priora não deve usar Telex como modalidade do Master.

### 17. Termo Único

Se o cliente possui Termo Único válido, a obrigação de termo do processo está atendida e não se gera Termo por Embarque. HeadCargo é a fonte de verdade. A Priora pode registrar no perfil operacional do consignatário que ele possui Termo Único, guardando fonte e data da última confirmação, reutilizando a informação nos processos seguintes e revalidando-a periodicamente ou diante de sinal de mudança.

### 18. Termo por Embarque, procuração e assinatura digital

Quando o cliente trabalha com Termo por Embarque, a Priora gera o PDF com os dados internos que conhece. O cliente baixa o documento no Portal, confere/completa os campos que são de sua responsabilidade, assina digitalmente e anexa o termo assinado junto com a procuração.

A Priora não deve assumir a veracidade dos dados que o próprio cliente declarou; deve verificar se os campos obrigatórios foram preenchidos. A validação automática concentra-se na assinatura digital e na procuração: identidade do signatário, correspondência com outorgado válido, vigência e poderes suficientes para assinar o termo.

- Aprovação automática: quando signatário, validade e poderes forem verificáveis e coerentes.
- Revisão: quando a assinatura digital não permitir identificar de forma confiável o signatário ou a procuração tiver conteúdo ambíguo.
- Reprovação explícita: signatário não outorgado, procuração vencida ou poderes insuficientes.

### 19. Pagamento ou prazo do cliente via HeadCargo

A fonte de verdade para pagamento e prazo do cliente é o HeadCargo. Pago OU cliente com prazo permite seguir; sem pagamento e sem prazo bloqueia o avanço normal. A Priora pode aprender/reutilizar que determinado consignatário possui prazo, registrando fonte e data da última confirmação e revalidando periodicamente. Não deve manter uma lista manual paralela desvinculada do HeadCargo.

| Condição | Resultado |
| --- | --- |
| Pagamento realizado | Pode seguir. |
| Cliente com prazo | Pode seguir sem pagamento imediato. |
| Sem pagamento e sem prazo | Bloqueia a regra operacional padrão. |
| HeadCargo indisponível | Estado desconhecido; nunca assumir “não pago”. |

### 20. Portal do Cliente e retorno imediato

O Portal do Cliente deve transformar a documentação em fluxo resolutivo. O cliente recebe o Termo por Embarque gerado, completa o que lhe cabe, assina, envia termo + procuração e recebe retorno imediato quando a validação automática for conclusiva. O Portal também recebe a imagem do HBL físico, que fica no card do processo com o estado “Documento recebido — aguardando validação do Analista”.

Mensagens automáticas devem explicar a causa concreta quando ela for verificável: signatário não outorgado, procuração vencida, poderes insuficientes ou campos obrigatórios não preenchidos. No HBL físico, a Priora não deve reprovar por baixa legibilidade do OCR; a decisão pertence ao Analista.

## PARTE 4  MASTER, AGÊNCIAS E APRESENTAÇÃO

### 21. Identificação e resolução do Master

O Master é considerado resolvido somente em uma das três modalidades válidas: físico recebido, Wave confirmado ou emissão no destino confirmada. A Priora deve distinguir “modalidade identificada” de “condição resolvida”.

> Agendamento não é gate principal. A Priora só deve tratar o agendamento como ação válida quando o Master já estiver resolvido e puder produzir avanço real rumo à apresentação.

### 22. Master físico via Courier

O Master físico é resolvido quando o número do processo está confirmado como Recebido no módulo Courier. “Em trânsito” ou apenas possuir rastreio não equivale a Master em posse da Rocket. Se surgir evidência operacional válida e vinculada ao processo contrariando o recebimento, a Priora preserva o evento original e abre divergência; não rebaixa o status por e-mail genérico ou comentário sem origem confiável.

### 23. Wave BL

O Wave é resolvido quando o agente envia e-mail válido confirmando sua disponibilização/recebimento. Esse e-mail é suficiente para o motor. Plataforma Wave e HeadCargo podem servir como consulta complementar, mas não constituem gates adicionais nem anulam automaticamente uma confirmação válida.

### 24. Emissão no destino

A emissão no destino é uma modalidade rara e não pode ser presumida. Primeiro o agente informa que o Master será disponibilizado por emissão no destino. Depois a Rocket consulta o armador. O Master somente fica resolvido quando o armador confirma que recebeu a autorização da origem para emissão no destino.

### 25. Master não localizado

Quando a Priora não encontra Master físico recebido, Wave confirmado nem emissão no destino identificada/resolvida, o resultado não é uma modalidade automática; é “Master não localizado”. O sistema deve solicitar ao Analista que verifique a situação do Master.

Esse caso possui filtro próprio. A condição existe enquanto não houver modalidade/evidência válida, mas sua criticidade cresce com o ETA. A partir de T-10 dias, Master não localizado deve chamar atenção de forma forte; o marco T-10 altera prioridade/visibilidade, não cria a condição.

### 26. Matriz armador × agência

| Agência | Armadores / linhas | Procedimento-base |
| --- | --- | --- |
| Unimar | ONE, PIL, HMM, CMA CGM, COSCO, OOCL, Yang Ming | Agendamento em portal + memorando + apresentação. |
| Maersk | Maersk | Agência própria; agendamento + apresentação. |
| MSC | MSC | Agência própria; memorando padrão + apresentação. |
| Rochamar | Hapag-Lloyd e ZIM | Memorando padrão + apresentação. |
| Grieg | Evergreen | Memorando próprio + aviso por e-mail + apresentação condicionada. |

### 27. Unimar e Maersk: agendamento e apresentação

Com o Master resolvido, a Rocket executa o agendamento no portal aplicável, anexa o Master e preenche os dados operacionais exigidos. A confirmação do agendamento permite seguir com a apresentação. A Priora não deve sugerir o agendamento antes de o Master estar resolvido.

Para fins de comprovação operacional na Priora, o status do agendamento como Finalizado é suficiente para marcar Master apresentado em Unimar e Maersk. O sistema não depende de leitura do memorando carimbado nesses fluxos e não exige confirmação humana adicional.

No caso da Maersk, a Rocket possui prazo comercial; por isso o pagamento imediato ao armador não é requisito para o desbloqueio na atracação.

### 28. MSC e Rochamar: memorando e apresentação

MSC e Rochamar não usam o fluxo de agendamento da Unimar. A Priora gera/preenche o memorando padrão com os dados do BL. Após o Analista baixar o PDF, o card oferece a ação “Enviar para apresentação”. Esse clique registra “Apresentação em andamento”, mas não “Master apresentado”. Quando o memorando carimbado retorna, o Analista usa “Confirmar apresentação”; só então o marco Master apresentado é gravado.

### 29. Evergreen / Grieg e a exceção de apresentação antecipada

A Evergreen é atendida pela Grieg e utiliza memorando próprio/protocolo. A Priora gera o documento, a Rocket avisa por e-mail o dia da apresentação e só pode prosseguir quando o navio estiver atracado e o pagamento ao armador estiver finalizado. Após o envio, o estado é “Apresentação em andamento”; o Master só é marcado como apresentado quando o protocolo carimbado retorna e o Analista confirma.

> Mesmo quando a Evergreen costuma liberar rapidamente após cumprir essas condições, entregar o Master não autoriza a Priora a inferir “desbloqueado”. Apresentação e desbloqueio continuam sendo eventos distintos.

Todos os demais armadores descritos neste Blueprint aceitam apresentação antecipada, sem garantia de desbloqueio imediato.

### 30. Evidências de apresentação e estado do Master

A apresentação é um marco próprio, separado do envio para a agência e separado do desbloqueio. A Priora registra quando e como o procedimento foi iniciado, quando a apresentação foi confirmada e qual evidência sustentou a confirmação. Enviar documento, gerar memorando ou acionar motoboy nunca é suficiente para inferir Master apresentado.

| Fluxo | Evidência suficiente de apresentação |
| --- | --- |
| Unimar | Status de agendamento Finalizado. Não exige confirmação humana adicional. |
| Maersk | Status de agendamento Finalizado. Não exige confirmação humana adicional. |
| MSC | Memorando carimbado + confirmação do Analista. |
| Rochamar | Memorando carimbado + confirmação do Analista. |
| Evergreen / Grieg | Protocolo/memorando carimbado + confirmação do Analista. Entrega/envio não equivale a desbloqueio. |

### 31. Pagamento ao armador via HeadCargo

Para todos os armadores exceto Maersk, o pagamento ao armador precisa aparecer como Finalizado no HeadCargo para o desbloqueio efetivo. Essa informação deve ser obtida por integração; a Priora não deve criar uma confirmação manual permanente como substituto.

Maersk é exceção porque a Rocket possui prazo comercial. A ausência de pagamento imediato não deve bloquear o desbloqueio no fluxo Maersk.

### 32. Janela de 48h e cobrança do desbloqueio

Depois que o Master foi apresentado e o pagamento ao armador está finalizado, inicia-se a janela operacional esperada para o desbloqueio no SISCARGA. O relógio começa quando as duas condições existem; portanto, usa a mais recente entre a data de apresentação e a data de pagamento. Na Maersk, a exigência de pagamento imediato não se aplica.

Passadas 48 horas sem desbloqueio, o processo merece atenção somente quando o ETA/ATA torna a cobrança operacionalmente relevante. A Priora não deve gerar urgência artificial para um navio ainda distante apenas porque a apresentação foi antecipada.

Quando a janela está vencida e a chegada é relevante, a próxima ação é cobrar o armador por telefone/e-mail, informando que o memorando foi apresentado, o pagamento está finalizado e o CE House ainda não foi desbloqueado.

## PARTE 5  MOTOR DE LIBERAÇÃO, FILAS E CONCLUSÃO

### 33. Máquina de estados operacional

| Etapa | Significado |
| --- | --- |
| Preparação para Liberação | Ainda existem condições documentais/externas a resolver. |
| Preparação Operacional | Master resolvido; ainda podem existir obrigações do cliente ou preparação interna antes do procedimento da agência. |
| Apto para Procedimento | Já é válido iniciar o procedimento específico da agência/armador. |
| Procedimento em Andamento | Agendamento ou tratamento externo iniciado e ainda aguardando retorno. |
| Apto para Apresentação | Condições do procedimento concluídas; Master pode seguir para a agência. |
| Master Apresentado | Apresentação comprovada por evidência válida. |
| Acompanhando Desbloqueio | Rocket já executou a apresentação e acompanha condições/retorno do armador e SISCARGA. |
| Liberado | CE House no SISCARGA retornou “Não Há Pendência”. |

“Master não localizado”, “Aguardando Cliente”, “Aguardando Armador” e equivalentes não são etapas principais. São motivos, bloqueadores ou responsáveis que coexistem com a etapa.

### 34. Master compartilhado e múltiplos Houses

Quando um Master atende várias Houses, a apresentação e os marcos do Master devem ser propagados às Houses vinculadas. Isso evita duplicar artificialmente uma única ação física.

Cada House continua independente em suas obrigações do cliente, CE House, pendências do SISCARGA e conclusão. Uma House pode estar liberada enquanto outra, vinculada ao mesmo Master, ainda permanece bloqueada.

### 35. Regra de entrada na Fila Principal

A Fila Principal existe para responder “o que eu consigo fazer agora para liberar?”. Entra nela o processo com pendência ou ação pré-desbloqueio que merece atenção e pode aproximar a apresentação/liberação.

- Master não localizado, principalmente com ETA próximo.
- Master resolvido e procedimento da agência ainda não executado.
- Agendamento possível e ainda não realizado, desde que o Master esteja resolvido.
- Agendamento confirmado e apresentação física ainda pendente.
- Pendência interna da Rocket que pode ser executada agora.
- Bloqueio do cliente ou terceiro que precisa permanecer visível, sem parecer atraso da Rocket.

Processos já apresentados e apenas aguardando desbloqueio migram para Acompanhamento de Liberação. CE/Prazos Regulatórios têm visão própria e não devem automaticamente ultrapassar processos que estão prontos para uma ação de liberação.

### 36. Prioridade e critérios de desempate

A prioridade é lexicográfica, não uma soma opaca de pontos. A classe operacional é decidida primeiro; os desempates vêm depois.

Para ordenação temporal, ATA conhecido significa chegada já ocorrida. Processos com ATA entram no grupo de já chegados; se não houver ATA, utiliza-se ETA. Dentro do grupo aplicam-se normalmente classe operacional e critérios de desempate.

| Classe | Regra |
| --- | --- |
| A — ação Rocket imediata / já devida | Processo já pronto, ETA/ATA crítico e a Rocket ainda não executou a ação disponível. |
| B — risco iminente essencial | Condição fundamental ainda não resolvida com ETA muito próximo; exemplo: Master não localizado. |
| C — ação interna disponível | Agendar, preparar apresentação ou enviar motoboy antes da chegada. |
| D — bloqueio externo | Cliente, agente ou terceiro precisa agir; visível, mas não deve roubar o topo de uma ação executável da Rocket. |

Desempates dentro da mesma classe:

1. ETA/ATA mais próximo.

2. Processo mais próximo da liberação efetiva.

3. Processo há mais tempo aguardando aquela ação.

> A fila prioriza urgência + capacidade de ação. Um processo crítico, porém totalmente dependente do cliente, não deve ocultar outro em que a Rocket pode efetivamente liberar agora.

### 37. Filtros e visões operacionais

| Visão | Pergunta respondida |
| --- | --- |
| Fila Principal | O que pode ser feito agora para aproximar a liberação? |
| Acompanhamento de Liberação | O que já foi executado e precisa ser monitorado ou cobrado? |
| Master não localizado | Quais processos ainda não têm modalidade/paradeiro de Master resolvido? |
| CE / Prazos Regulatórios | Quais CEs estão próximos/fora do prazo ou em retificação/bloqueio fiscal? |
| Pendências do Cliente | Quais processos dependem exclusivamente de documentação/condição do cliente? |
| Aguardando Terceiros | Quais casos estão corretamente nas mãos de agente/armador dentro do prazo esperado? |

Um processo pode aparecer em mais de um filtro. A Fila Principal, porém, deve exibir apenas a ação mais relevante naquele momento.

### 38. Override e exceções autorizadas

As obrigações do cliente não tornam a apresentação tecnicamente impossível, mas a política operacional da Rocket proíbe prosseguir sem que estejam concluídas. A exceção é formalizada por override.

- Solicitação: Analista.
- Aprovação: Gestor.
- Escopo: somente a pendência e o processo indicados; não cria autorização geral.
- Registro: justificativa, evidência, solicitante, aprovador, data/hora e efeito da exceção.
- Fila: antes da aprovação, a ação não deve ser apresentada como execução normal recomendada da Rocket.

### 39. Condição final de Liberação e terminalidade

O único gatilho para o estado Liberado é a consulta do CE House no SISCARGA confirmar ausência de pendência de frete e ausência de pendência fiscal. Nem apresentação, pagamento, protocolo carimbado nem ausência aparente de bloqueios substituem essa evidência final.

Liberado é um estado terminal para o módulo. Correções ou retificações posteriores não reabrem automaticamente a liberação. A Priora preserva a prova de conclusão: CE House consultado, retorno obtido, data/hora e fonte.

### 40. Interface, cards e detalhamento do processo

O frontend deve favorecer decisão rápida, não exibir todos os dados com o mesmo peso. O card principal deve priorizar: processo/House, ETA/ATA, etapa, bloqueador/responsável, próxima ação, situação do Master e motivo de atenção.

No detalhamento, o usuário deve conseguir abrir as evidências relevantes: foto do HBL, e-mails de Telex/Wave/emissão no destino, procuração, Termo por Embarque, status de Courier, status de agendamento ou protocolo carimbado conforme a agência, informações do HeadCargo, CE House e histórico de SISCARGA. Filtros preservam o contexto sem criar filas concorrentes desconectadas.

### 41. Dados indisponíveis, falhas de integração e estados desconhecidos

A indisponibilidade de um sistema externo deve produzir estado explícito de informação não disponível. Não se pode transformar erro técnico em decisão de negócio.

| Falha | Comportamento esperado |
| --- | --- |
| HeadCargo indisponível | Pagamento/prazo/Termo/pagamento ao armador = desconhecido; preservar última informação válida e não assumir condição negativa. |
| SISCARGA indisponível | Estado de liberação não muda; registrar falha, preservar última evidência válida e tentar novamente. |
| Courier indisponível/sem atualização | Não concluir Master não recebido; marcar situação não confirmável e preservar último evento válido. |
| E-mail ambíguo | Não promover Wave/Telex/emissão no destino nem criar divergência sem remetente, processo e conteúdo operacionalmente válidos. |
| HBL pouco legível para OCR | Encaminhar ao Analista no card. A decisão é humana; baixa legibilidade não é reprovação automática. |

### 42. Integrações do MVP final e dependências técnicas

O Blueprint considera como destino funcional do MVP final as integrações necessárias para eliminar confirmações manuais que já possuem fonte sistêmica. Nesta etapa, alguns endpoints ainda não estão disponíveis. A implementação deve separar regra de negócio de adaptação técnica, permitindo mocks/testes temporários sem transformar workaround manual em regra permanente.

- HeadCargo: pagamento/prazo do cliente, Termo Único, pagamento ao armador e revalidação do perfil operacional aprendido do consignatário. Endpoints ainda pendentes.
- SISCARGA: consulta por CE House das pendências de frete/fiscal e prova final de “Não Há Pendência”. Mecanismo técnico de integração ainda pendente.
- Outlook/e-mail: confirmações de Telex, Wave, emissão no destino, comunicação de desconsolidação e eventuais avisos de omissão/alteração de rota, sempre com vínculo operacional ao processo.
- Courier Priora: confirmação automática de recebimento do Master físico por processo.
- Portais/agências: Unimar/Maersk dependem do status do agendamento; MSC/Rochamar/Grieg mantêm confirmação humana do protocolo carimbado. Execução permanece humana quando não houver integração confiável.
- Auditoria Priora: fornece desconsolidação e número do CE House para o módulo Liberação; Liberação não repete a auditoria documental.
- Tracking do armador: ETA/ATA e sinais de alteração de rota. Integração com dados do porto é evolução futura.
- CE Mercante / CE Master: regra de 72h é conhecida, mas não há integração direta viável na V1; a Priora não deve criar certeza nem alerta de atraso sem fonte observável.

### 43. Cenários de aceitação e critérios de congelamento

Este Blueprint está funcionalmente congelado. Os cenários abaixo formam o conjunto mínimo de aceitação para a implementação preservar as regras aprovadas:

- Master físico Recebido no Courier + cliente OK + Unimar → agendamento → status Finalizado = Master apresentado → condição financeira → SISCARGA sem pendências.
- Wave confirmado por e-mail + cliente com prazo → apresentação antecipada → acompanhamento sem falso alerta de 48h para ETA distante.
- Emissão no destino informada pelo agente, mas autorização da origem ainda não recebida → Master não resolvido.
- Master não localizado existe enquanto não houver modalidade/evidência válida; a partir de T-10 sua atenção cresce fortemente.
- HBL físico → sempre decisão final do Analista. Divergência detectada pela IA gera alerta, não bloqueio automático; baixa legibilidade para OCR ainda segue para análise humana.
- Termo por Embarque com assinatura digital de outorgado válido → aprovação automática; signatário fora da procuração → reprovação explícita.
- Cliente pendente + tentativa de prosseguir → somente via override solicitado pelo Analista e aprovado pelo Gestor.
- Evergreen antes da atracação ou sem pagamento → não apta para apresentação.
- CE House ausente a T-48h → risco/atenção regulatória, não culpa automática da Rocket. Se atraso da Rocket for comprovado e houver bloqueio fiscal → e-CAC → reconsulta até liberação.
- Alteração de rota → armador retifica CE Master antes da Rocket retificar CE House.
- Master compartilhado por várias Houses → apresentação propagada, mas CE House/liberação permanecem individuais.
- HeadCargo/SISCARGA/Courier indisponíveis → informação desconhecida/não confirmável; nunca converter indisponibilidade em não pago, não recebido ou não liberado.
- CE House retorna “Não Há Pendência” → Liberado terminal com prova preservada.
- CE Master: existência inferível pela presença do CE House, mas tempestividade de 72h não é verificável automaticamente na V1.
- Prioridade: ATA existente = chegada ocorrida; sem ATA usa-se ETA. Dentro da mesma classe: temporalidade → proximidade da liberação → tempo aguardando a ação.

> Critério de congelamento: mudanças funcionais em etapa, gate, fonte de verdade, prioridade, responsabilidade, evidência, override, regra de observabilidade ou conclusão exigem validação explícita do responsável pelo produto. Ajustes técnicos podem evoluir sem nova validação apenas quando preservarem integralmente o comportamento aprovado neste Blueprint.

> Status final: BLUEPRINT FUNCIONAL CONGELADO PARA IMPLEMENTAÇÃO POR FASES.
