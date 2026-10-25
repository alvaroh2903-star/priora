# Courrier — ASS-010: negação explícita, Telex Release Confirmado × Pendente e IA sem autoridade documental (entregas PARCIAIS)

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
  - a expectativa vem só do `docExpect` da lista, igual com o card aberto ou
    fechado, com ou sem análise, e depois de recarregar a página;
  - **consequência (decisão pendente):** quando o e-mail lista documentos por
    processo ("IM2204 - OMBL", "IM2205 - OHBL"), os dois documentos ficam
    conferíveis nos dois processos, como já acontecia com o card fechado. Para
    voltar a ter a precisão por processo sem depender da análise, seria preciso
    aplicar a Regra 4 na própria lista, sem chamada nova. Isso muda a expectativa
    exibida e precisa de validação.
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
  `processosDetalhe`.
- Liberação, Gestão, Demurrage e a tela Processos.
- A detecção de Wave BL, emissão no destino e envio ao importador no motor.
- A lista de processos do card: os `processNumbers` da análise ainda acrescentam
  linhas ao expandir (achado abaixo, lacuna 11).

## Lacunas que continuam em ASS-010

Os testes que exercitam estes casos estão rotulados como **caracterização de
limitação conhecida**, e não como conformidade.

1. **Atribuição por documento ou IM.** O sinal vale para o envelope inteiro. Uma
   confirmação de outro IM, sem nenhuma pendência no texto, ainda encerra o OHBL de
   todos os processos do envelope.
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
11. **Processos acrescentados pela análise (achado, fora desta entrega).** Ao
    expandir, o card une à lista os `processNumbers` da análise: os IMs achados por
    regex na conversa inteira **e os que só a IA citou**, sem conferir no texto.
    Cada processo novo ganha uma linha com OMBL/OHBL esperados. As linhas que já
    existiam não mudam. Corrigir mexe na atribuição de processo ao courier e
    precisa de decisão.
12. **Regra 4 (documento por processo) sem efeito.** Ela só chegava com a análise;
    hoje a expectativa é a do envelope inteiro. Ver "decisão pendente" acima.

## Testes

`npm run courier-docs:selftest` (61 casos, isolado):

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
- **`docResolution.rota.test.ts` (3):** `GET /api/couriers` pela rota real, com Graph,
  MSAL e Gemini falsos e rede bloqueada. Confere:
  - confirmado, pendente, sem marcador, negado e português afirmativo;
  - os registros de estado, conferência e follow-up semeados não mudam;
  - 1 busca no Graph e 0 chamadas de IA por lista;
  - o texto do painel da Clara (`derivarExpectativa`): as observações de telex,
    Wave, destino e cliente são informativas.
- **`docResolution.front.test.ts` (23):** o script real do Courier Module num `vm`
  (`buildRow`), verificando que `buildRow` não altera estado, conferência nem faz
  chamada. Confere:
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
  - expandir ou recarregar: 192 combinações (expectativa × motor × estado ×
    processos) × 5 análises × aberto/fechado dão a mesma projeção documental que o
    card sem análise; o mapa por processo não cria nem remove expectativa;
  - vários processos: a afirmação só da IA não encerra nenhum;
  - caracterizações: múltiplos processos no envelope (sem atribuição por IM) e
    linhas acrescentadas pelos `processNumbers` da análise (lacuna 11).
- **`docResolution.analise.test.ts` (4):** caminho real de expandir. Lista
  (`GET /api/couriers`) → clique em "ver envelope" no script real (`toggle`) →
  `GET /api/couriers/:cid/analysis` (rota real, Graph e Gemini falsos, rede
  bloqueada) → `buildRow`. Confere:
  - a projeção documental é a mesma fechado, aberto, fechado com a análise em
    memória e depois de recarregar com a Clara afirmando outra coisa;
  - destino e "Telex release to consignee" só da Clara não encerram; Wave só da
    Clara não apaga a divergência nem as pendências de cobrança gravadas; o
    `processosDetalhe` chega, mas não muda o esperado; importador e Wave do motor
    seguem valendo;
  - as observações do painel são informativas;
  - 1 busca no Graph por lista, 1 leitura de conversa e 1 chamada de IA por
    análise, nenhuma chamada extra do front, nenhuma rede e nenhuma escrita.
