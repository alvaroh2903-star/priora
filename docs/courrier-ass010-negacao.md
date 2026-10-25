# Courrier — ASS-010: negação explícita, Telex Release Confirmado × Pendente, IA sem autoridade documental e associação documento → processo (entregas PARCIAIS)

**Requisito (Blueprint do Courrier, Revisão 3.0):**

- **ASS-010:** "Não esperar OHBL físico quando informação confiável indicar telex ou
  envio ao shipper/cliente. 'HBL to cnee' isoladamente não prova telex."
- Verificação correspondente: CT-R026.
- Na matriz de diagnóstico, a classe era **P/C**: a regex de telex aceitava negação,
  e qualquer menção de telex encerrava o OHBL.

**O ASS-010 NÃO está concluído.** As lacunas estão no fim deste documento.

## Contrato de `docResolutionFromText` (`src/couriers/docResolution.ts`)

| Campo | Significado |
|---|---|
| `telex` | **Telex Release Confirmado:** alguma menção com conclusão explícita e **nenhuma** menção pendente no texto (envelope). É o único que encerra a expectativa do OHBL físico. |
| `telexPendente` (novo) | **Telex Release Pendente:** alguma menção de telex não negada que não é conclusão explícita. **Não** encerra o OHBL. |
| `wave`, `destino`, `importador` | Como antes. |

- `telex` e `telexPendente` nunca são verdadeiros juntos.
- O formato dos quatro campos de antes não mudou, mas `telex` passou a significar
  "confirmado", e não "mencionado". Por isso um consumidor antigo que só lê `telex`
  nunca trata um telex pendente como confirmado.

## Como cada menção de telex é lida

1. **Negada ou cancelada → nenhum dos dois.**
   - Negação explícita na própria oração: "No telex release", "Telex release not
     approved", "Sem telex", "O telex não foi liberado", "Não haverá telex", "HBL
     not released via telex".
   - Cancelamento: "Telex release cancelled", "Please cancel the telex release".
   - O cancelamento só conta para telex: o envio ao importador não muda.
2. **Pendente** quando houver qualquer um destes sinais:
   - a frase é pergunta ("Can you do telex release?");
   - pendência ou condição em qualquer parte da **frase** ("pending", "awaiting",
     "subject to", "upon", "after", "until", "if", "aguardando", "pendente",
     "sujeito a", "mediante", "após", "quando"…);
   - futuro, plano, pedido ou possibilidade na **oração** da menção ("will",
     "tomorrow", "requested", "arrange", "can", "será", "vai", "providenciando",
     "solicitado", "pode"…, e as expressões "to be" e "assim que");
   - nenhuma conclusão explícita: só a palavra "telex" ("HBL via telex release",
     "B/L type: TELEX RELEASE"), por decisão de 25/10;
   - "approved/aprovado" sozinho: aprovação não é realização (decisão de 25/10).
3. **Confirmada** só com conclusão explícita e não negada:
   - palavras de conclusão: "released", "completed", "confirmed", "done",
     "effected", "executed", "performed", "surrendered", "liberado", "realizado",
     "efetuado", "concluído", "confirmado", "feito";
   - elas valem na oração da menção, ou numa oração da mesma frase que fale do
     documento ("Conforme informado no telex release, o HBL foi liberado");
   - "Telex release, cargo released" fica pendente: a conclusão ali é da carga.

**Envelope:** sem atribuição por IM, uma menção pendente impede a confirmação do
texto inteiro. Não se usa a confirmação de um documento como prova para outro.

**Negação:** as regras das entregas anteriores continuam valendo.

- A negação vale só na mesma oração. São fronteiras: `. ! ? ; ,`, quebra de linha,
  travessão, "but", "mas", "porém"…
- Até 3 palavras neutras podem separar o negador da menção.
- "not only" e "não só" não negam.
- O "no" português ("em + o") só nega com posição inglesa (início de oração,
  depois de is/there/with/please, ou depois de rótulo em inglês da lista + dois-pontos)
  **e** sem continuação portuguesa ("consta", "foi", "o"…).
- Os dois-pontos não são fronteira.

## Tela do Courier (`public/Courier Module.dc.html`)

- **Confirmado (determinístico):** a célula do OHBL fica resolvida como **"Telex
  Release Confirmado"**.
- **Pendente:**
  - o OHBL continua esperado: aguardando o envelope, conferível
    (Recebido/Não recebido) e com cobrança se marcado como não recebido;
  - aparece o aviso **"Telex Release Pendente — aguardando confirmação"** na célula
    e na lista "Documentos esperados";
  - o aviso não diz que o agente enviará o OHBL físico.
- **A Clara não encerra o OHBL por telex** (regra aprovada, entrega de 25/10):
  - só `docResolution.telex` (o motor documental) encerra o OHBL por telex;
  - a menção de telex no `hblResolution` da Clara não tem nenhum efeito sobre a
    célula, a lista "Documentos esperados", a conferência, o status do processo ou
    a cobrança, haja ou não pendência no motor;
  - o rótulo antigo "Via Telex Release" (vindo da Clara) deixou de existir.
- **A IA não encerra nenhum original físico** (entrega de 25/10, extensão da regra
  acima). Só o motor documental (`courier.docResolution`, calculado na lista a
  partir dos e-mails do courier) encerra a expectativa do OHBL/OMBL:
  - **envio ao importador, emissão no destino e Wave BL** deixaram de ler o
    `hblResolution` da Clara. Exemplo: "Telex release to consignee", vindo só da
    Clara, não encerra mais o OHBL como "Enviado ao importador";
  - as regras do motor continuam as mesmas: mesma detecção, mesma precedência
    (no OHBL: telex > importador > destino > Wave; no OMBL: Wave > destino) e
    mesmos documentos (o envio ao importador não encerra o OMBL);
  - **detecção determinística não prova que a fonte é confiável nem que o
    documento é deste processo**: o sinal vale para o envelope inteiro (lacunas 1
    e 3).
- **Expandir ou recarregar a análise não muda a resolução documental:**
  - o mapa por processo que chega com a análise (`processosDetalhe`, Regra 4 lida
    linha a linha) deixou de alterar o que é esperado. Antes, depois de expandir, ele
    podia tornar um documento "Não esperado" num processo, ou passar a esperar um
    documento que o e-mail do courier não citava;
  - a expectativa por processo vem só da lista (`docsEnvelope`, abaixo), igual com
    o card aberto ou fechado, com ou sem análise, e depois de recarregar a página;
  - os `processNumbers` da análise (inclusive os IMs que só a Clara citou) não
    viram mais linha do envelope: aparecem como **"Sugestões da análise — não
    confirmadas"**, com a origem ("citado na conversa" ou "só a Clara"). Um IM
    escrito na conversa também é só sugestão: não prova que o processo está neste
    courier.

## Associação documento → processo (entrega de 25/10)

Corrige a atribuição cruzada: antes, um envelope que citava OMBL para um IM e OHBL
para outro fazia os dois documentos serem esperados nos dois processos.

**Três camadas separadas** (`src/couriers/docAssociation.ts`, calculado na lista,
sem IA e sem chamada nova):

| Camada | O que diz | Onde |
|---|---|---|
| Conteúdo físico | A menção a OMBL/OHBL afirma que o documento vem **neste** envelope (`afirmado`) ou não comprova (`nao-comprovado`: negado, a seguir/pendente, liberação eletrônica, emissão no destino, cópia/anexo) | `docsEnvelope.mencoes[].conteudo` |
| Associação | A qual processo a menção pertence: `confirmada` (IM único na mesma linha; referência de BL que aponta para um único processo em **outro** e-mail; ou processo único do envelope sem referência em conflito), `ambigua` (com `candidatos` e `externos`) ou `sem-processo` | `docsEnvelope.mencoes[].associacao` |
| Conferência física | Marcações e follow-ups do operador | `conferencia` / `followups` (não mudam) |

- **Origem estável:** cada menção tem `id` = `mensagem#Llinha:tipo:ordem` e
  `fonte` = { `messageId`, `linha`, `ref` (código do BL, se houver) }. Nenhum
  trecho do e-mail sai na resposta. O id muda se a mensagem for movida no Outlook
  (o Graph troca o id).
- **A proximidade de linha dentro do próprio e-mail do courier não associa por
  referência** (o índice global de referências faz isso; aqui só valem ligações de
  outros e-mails).
- **Vários IMs na mesma linha, IM/BL fora do envelope ou referência 1:N** ficam
  ambíguos. Um processo único não vence IM ou BL em conflito.
- **Referência ligada a processos demais** (mais de `MAX_SHARED_PROCESSES`, hoje
  8) não aponta processo nenhum, mas também não vale como "sem evidência": vai em
  `associacao.referenciasCompartilhadas` e deixa a menção ambígua — nem o
  processo único nem um IM explícito na linha a confirmam (correção de 25/10).
- A detecção continua determinística: **não prova que a fonte é confiável nem que
  a atribuição está certa** — só o que o texto diz.

**Na tabela do envelope, por processo × documento:**

| Situação | Exibição | Controles | Cobrança |
|---|---|---|---|
| Afirmado e associado a este processo | Aguardando courier / Recebido / Não recebido | Sim | Sim, se marcado "Não recebido" |
| Afirmado, associação ambígua com este processo como candidato | "A revisar — processo não confirmado" | **Não** (decisão 1: a marcação não pode criar a associação) | Não |
| Só menções que não comprovam (negado, "to follow", telex…) | "A revisar — presença não comprovada" | Não | Não |
| Nenhuma menção ao documento para este processo | "Não informado" (expectativa desconhecida; nada é fabricado) | Não | Não |
| Marcação já gravada sem expectativa confirmada | "Registro: Recebido/Não recebido" + "Conflito de associação — revisar" (ou "Sem menção no e-mail — revisar") | Não | **Suspensa** (decisão 2); o follow-up já feito aparece |
| Documento resolvido pelo e-mail (telex, importador, destino, Wave) **com** marcação gravada neste processo | A resolução **e**, separado, "Registro: …" + "Resolução do e-mail vale para o envelope inteiro — revisar" | Não | **Suspensa**; o follow-up já feito aparece (correção de 25/10) |

- "Não comprovado" não vira "não esperado" e não cancela expectativa sustentada
  por outra menção afirmada.
- Um documento associado a outro processo não vira "não esperado" aqui: pode haver
  dois documentos do mesmo tipo.
- O status da linha conta os documentos esperados **e os registros gravados** —
  inclusive os de documento resolvido pelo e-mail: uma divergência registrada
  continua visível até a revisão; nada é dado como resolvido.
- O rodapé do courier recebido só diz "Documentos disponíveis para conferência"
  quando há algum documento conferível; sem nenhum, diz que não há documento com
  expectativa confirmada (e aponta os itens a revisar, se houver). "Finalizar
  courier" continua disponível como antes (achado da validação no navegador).
- Documento afirmado sem processo confirmado aparece uma vez, no bloco
  **"Documentos sem processo confirmado — revisar"**, sem virar expectativa em
  nenhum IM.
- Resolução (telex, importador, destino, Wave) continua valendo para o envelope
  inteiro, antes da expectativa (lacuna 1). Ela **não esconde** a marcação humana
  do processo: o registro e o follow-up aparecem ao lado, para revisão. O ciclo
  completo de revisão (aceitar, contestar, encerrar) não foi implementado.

**Dependência identificada (não implementada):** registrar e atribuir documentos
encontrados sem associação confirmada — ou conferir um documento cuja expectativa
é desconhecida — é o tratamento de documentos inesperados/sem processo (**RES-006 a
RES-008**). Até ele existir, essas células mostram o estado e os registros, sem
controles. **Consequência:** num envelope cujo e-mail não cita OMBL/OHBL, não há
conferência por documento na tela (o estado do courier — Recebido, Concluído —
continua funcionando).
- **Painel da Clara:** todas as observações viraram informativas, com o mesmo
  gatilho de antes:
  - telex: "Clara identificou menção a Telex Release. Isso, sozinho, não encerra a
    expectativa do OHBL físico: vale a confirmação documental exibida na tabela."
    (antes: "não esperar OHBL físico");
  - Wave BL: "Clara identificou menção a Wave BL. Isso, sozinho, não encerra a
    expectativa do OMBL/OHBL físico: …" (antes: "expectativa de OMBL físico
    cancelada");
  - destino: "Clara identificou menção a emissão no destino. Isso, sozinho, não
    encerra a expectativa do OMBL/OHBL físico: …" (antes: "expectativa documental
    física cancelada");
  - cliente: "Clara identificou menção a envio do OHBL ao cliente. Isso, sozinho,
    não encerra a expectativa do OHBL físico: …" (antes: "OHBL enviado ao
    cliente.");
  - resumo, evidências, documentos, referências e confiança continuam exibidos
    como antes.
- **Resolução da expectativa física não é liberação da carga.** Esta tela só diz
  se um original físico ainda é esperado no envelope.

## O que NÃO mudou

- Persistência (estados, conferência, follow-ups em JSON) e migrations. As
  marcações de conferência e os follow-ups gravados são lidos como antes e nada é
  reescrito.
- Chamadas externas: 1 busca no Graph e 0 de IA por lista; 1 leitura de conversa
  no Graph e 1 chamada de IA por análise (ao expandir), como antes.
- IA e prompts. A rota de análise continua devolvendo `hblResolution` e
  `processosDetalhe`, e passa a devolver `processosNaConversa` (regex sobre as
  mesmas mensagens) só para qualificar as sugestões.
- Liberação, Gestão, Demurrage, a tela Processos e a tela "Exigem Atenção".
- A detecção de Wave BL, emissão no destino e envio ao importador no motor.
- `docExpect` continua na resposta da lista (a tela não o usa mais).

## Lacunas que continuam em ASS-010

Os testes que exercitam estes casos estão rotulados como **caracterização de
limitação conhecida**, e não como conformidade.

1. **Atribuição da resolução por documento ou IM.** Telex, envio ao importador,
   emissão no destino e Wave valem para o envelope inteiro. Uma confirmação de
   outro IM, sem nenhuma pendência no texto, ainda encerra o OHBL de todos os
   processos do envelope. (A **expectativa** já é por processo; a **resolução**
   ainda não.)
2. **Cronologia (ASS-009).** Um cancelamento posterior não restaura a expectativa, e
   uma confirmação posterior não encerra uma pendência anterior: fica pendente, que
   é o lado seguro.
3. **Avaliação da fonte confiável** (autor, origem, confirmação escrita): não é feita.
4. **Coerência com a Clara: resolvida no Courier** (telex, importador, destino,
   Wave e o mapa por processo). Fora do Courier, a tela **Processos** (outro
   módulo) continua exibindo o `hblResolution` da Clara como status.
5. **Evidência não persistida.** A decisão é recalculada a cada lista a partir dos
   próprios e-mails do courier. Guardar a evidência exige persistência, que não foi
   autorizada.
6. **O que falta na pendência** aparece de forma genérica ("aguardando
   confirmação"). A condição específica (pagamento, aprovação) não é extraída.
7. **Envio ao shipper** e **"cnee"** não são reconhecidos.
8. **Negação separada por vírgula ou travessão** ("Telex release, not approved") não
   é lida e aparece como Pendente.
9. **"no" depois de rótulo fora da lista em inglês** ("HBL: no telex release") não é
   lido como negação e aparece como Pendente.
10. **Leitura conservadora:**
    - pendência em outra oração da mesma frase também deixa pendente ("Telex released
      after payment", "… pending your freight payment");
    - pode haver pendência falsa, nunca confirmação falsa por esse motivo.
11. **Atribuição documento → processo é só por linha e por referência.** IM numa
    linha e o documento na linha seguinte, ou tabela com o IM num cabeçalho, ficam
    "sem processo" (a revisar). OMBL compartilhado por vários IMs na mesma linha
    fica ambíguo, mesmo quando é um master legítimo de consolidação.
12. **Documentos sem processo ou com expectativa desconhecida não têm conferência
    na tela** até existir o tratamento de RES-006 a RES-008 (registrar e atribuir
    documento encontrado).
13. **Leitura de conteúdo conservadora:** "after", "if", "pending" e afins na mesma
    frase, "copy/attached/pdf" e menções a telex/Wave no mesmo trecho deixam a
    menção "não comprovada". Pode haver "a revisar" a mais; nunca expectativa a mais
    por esse motivo.

## Testes

`npm run courier-docs:selftest` (90 casos, isolado):

- **`docResolution.test.ts` (31):**
  - confirmação, pendência, "approved", menção sem marcador, condição na frase e
    envelope com menções mistas;
  - negação e cancelamento, e a regressão do português;
  - envio ao importador e "HBL to cnee";
  - interface com os quatro campos mais o novo;
  - Wave e destino inalterados;
  - equivalência e monotonia em 5.000 + 5.000 textos gerados: a menção é detectada
    como antes, nada é criado, e confirmado e pendente nunca saem juntos;
  - as caracterizações acima.
- **`docAssociation.test.ts` (17):** o módulo puro de associação.
  - conteúdo: lista simples e "seguem/enclosed" afirmam; negação, "to follow",
    futuro, pendência, pergunta, telex/surrender/sea waybill, emissão no destino e
    cópia/anexo não comprovam; a leitura é por oração;
  - associação: IM único na linha confirma (IM2204 OMBL × IM2205 OHBL sem
    cruzamento); vários IMs ficam ambíguos; sem IM com vários processos fica sem
    processo; BL ligado a um processo em outro e-mail confirma; proximidade de
    linha no próprio e-mail não confirma; 1:N e booking ficam ambíguos; processo
    único confirma, mas não vence IM ou BL em conflito; base "IM2204-26";
  - referência acima do limite: com processo único ou com IM explícito, fica
    ambígua e registrada; associações inequívocas não mudam;
  - origem estável (mensagem, linha, ref, id), mesma saída para a mesma entrada,
    nenhum trecho do e-mail; o motor documental não muda.
- **`docResolution.rota.test.ts` (3):** `GET /api/couriers` pela rota real, com Graph,
  MSAL e Gemini falsos e rede bloqueada. Confere:
  - confirmado, pendente, sem marcador, negado e português afirmativo;
  - o formato do `docsEnvelope` (sem trecho do e-mail) e "original HBL will
    follow" como não comprovado;
  - os registros de estado, conferência e follow-up semeados não mudam;
  - 1 busca no Graph e 0 chamadas de IA por lista;
  - o texto do painel da Clara (`derivarExpectativa`): as observações de telex,
    Wave, destino e cliente são informativas.
- **`docResolution.front.test.ts` (34):** o script real do Courier Module num `vm`
  (`buildRow`), com o `docsEnvelope` gerado pelo módulo real a partir do texto,
  verificando que `buildRow` não altera estado, conferência nem faz chamada.
  Confere:
  - associação: IM2204 OMBL × IM2205 OHBL sem cruzamento e sem controles onde não
    há expectativa; documento de outro processo não vira "não esperado"; dois
    documentos do mesmo tipo; IM desconhecido listado uma vez sem associação;
    negado/"to follow"/telex/cópia a revisar sem cancelar expectativa afirmada;
    sem menção = desconhecido; processo único não vence IM em conflito;
  - decisão 1: "A revisar" sem Recebido/Não recebido; decisão 2: registro e
    follow-up visíveis como conflito, divergência mantida, cobrança suspensa;
  - resolução do envelope (telex e Wave) com dois IMs e "Não recebido" + follow-up
    num deles: registro, follow-up e revisão visíveis, divergência mantida, sem
    cobrança nova; referência acima do limite fica "A revisar";
  - IM só da IA ou só da conversa vira sugestão, sem linha nem chip;
  - a matriz motor × Clara: confirmado com e sem Clara; pendente com "Telex
    Release" e "confirmed"; sem confirmação com "pending", "Via Telex Release" e
    "confirmed"; sem análise; importador, destino e Wave reconhecidos pelo motor;
  - o critério essencial: 13 strings de telex da Clara × 2 estados do motor ×
    4 estados do envelope, e nenhuma põe `hbl.resolved = true`;
  - "Telex release to consignee" só da Clara não encerra o OHBL;
  - 12 afirmações só da IA (destinatário, destino, Wave) × 2 estados do motor ×
    4 estados do envelope: nenhuma encerra o OHBL ou o OMBL;
  - regras do motor preservadas: as 24 combinações de sinais × 14 variações da
    Clara dão o mesmo texto e a mesma precedência de antes;
  - envelope em trânsito, recebido, OHBL recebido (Conferido) e não recebido
    (pendência e cobrança), confirmado pelo motor fora da conferência, e as
    marcações valendo com a Clara citando destinatário/destino/Wave;
  - expandir ou recarregar: 336 combinações (7 textos × motor × estado ×
    processos) × 5 análises × aberto/fechado dão a mesma projeção documental que o
    card sem análise; o mapa por processo não cria nem remove expectativa;
  - vários processos: a afirmação só da IA não encerra nenhum;
  - caracterização: a resolução do motor vale para todos os processos do envelope
    (lacuna 1).
- **`docResolution.analise.test.ts` (5):** caminho real de expandir. Lista
  (`GET /api/couriers`) → clique em "ver envelope" no script real (`toggle`) →
  `GET /api/couriers/:cid/analysis` (rota real, Graph e Gemini falsos, rede
  bloqueada) → `buildRow`. Confere:
  - processos, chips, documentos sem processo e células iguais fechado, aberto,
    fechado com a análise em memória e depois de recarregar com a Clara afirmando
    outra coisa (inclusive com IM só da Clara e IM só da conversa);
  - IM2204 OMBL × IM2205 OHBL sem cruzamento; marcação antiga do OHBL do IM2208
    visível como conflito, com follow-up, divergência mantida e sem cobrança;
    documento sem IM listado uma vez; "OHBL to follow" a revisar; sugestões
    "só a Clara" e "citado na conversa"; origem estável das menções; telex
    confirmado com dois IMs mantendo visível o "Não recebido" + follow-up do
    IM2301; BL ligado a 9 processos não confirmado pelo processo único;
  - destino e "Telex release to consignee" só da Clara não encerram; Wave só da
    Clara não apaga a divergência nem as pendências de cobrança gravadas; o
    `processosDetalhe` chega, mas não muda o esperado; importador e Wave do motor
    seguem valendo;
  - as observações do painel são informativas;
  - 1 busca no Graph por lista, 1 leitura de conversa e 1 chamada de IA por
    análise, nenhuma chamada extra do front, nenhuma rede e nenhuma escrita.
