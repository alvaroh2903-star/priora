# Courrier — ASS-010: negação explícita e Telex Release Confirmado × Pendente (entregas PARCIAIS)

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
- **Pendente prevalece sobre a Clara** (decisão de 25/10): com `telexPendente`, a
  menção de telex no `hblResolution` da Clara não encerra o OHBL.
- **Sem regra determinística de telex:** a string da Clara continua podendo
  encerrar o OHBL como "Via Telex Release" (rótulo de antes, não "Confirmado").
- **Envio ao importador, emissão no destino e Wave BL** continuam encerrando como
  antes.

## O que NÃO mudou

- Persistência (estados, conferência, follow-ups em JSON) e migrations.
- Chamadas externas: 1 busca no Graph e 0 de IA por lista.
- IA e prompts.
- Liberação, Gestão, Demurrage, a tela Processos e a observação textual da análise
  da Clara (`derivarExpectativa`).
- A detecção de Wave BL, emissão no destino e envio ao importador.

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
4. **Coerência com o `hblResolution` da Clara:**
   - sem regra determinística de telex, a string da Clara ainda encerra o OHBL,
     mesmo que ela própria diga "pending";
   - a observação textual da análise ("Telex Release detectado — não esperar OHBL
     físico") e a tela Processos continuam como antes.
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

## Testes

`npm run courier-docs:selftest` (40 casos, isolado):

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
- **`docResolution.rota.test.ts` (2):** `GET /api/couriers` pela rota real, com Graph,
  MSAL e Gemini falsos e rede bloqueada. Confere:
  - confirmado, pendente, sem marcador, negado e português afirmativo;
  - os registros de estado, conferência e follow-up semeados não mudam;
  - 1 busca no Graph e 0 chamadas de IA por lista.
- **`docResolution.front.test.ts` (7):** o script real do Courier Module num `vm`
  (`buildRow`). Confere:
  - pendente não encerra e mostra o aviso;
  - pendente prevalece sobre a Clara;
  - confirmado encerra;
  - envelope recebido segue conferível e gera cobrança;
  - importador continua encerrando;
  - mais a caracterização da Clara sem regra determinística.
