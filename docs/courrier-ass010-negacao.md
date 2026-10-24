# Courrier — ASS-010: negação explícita de telex e de envio ao destinatário (entrega PARCIAL)

**Requisito (Blueprint do Courrier, Revisão 3.0):**

- **ASS-010:** "Não esperar OHBL físico quando informação confiável indicar telex ou
  envio ao shipper/cliente. 'HBL to cnee' isoladamente não prova telex."
- Verificação correspondente: CT-R026.
- Na matriz de diagnóstico, a classe era **P/C**: a regex de telex aceitava negação.

## O que mudou

A detecção determinística `docResolutionFromText` saiu de `src/routes/courierRoutes.ts`
para `src/couriers/docResolution.ts`, uma função pura com a mesma interface
(`telex`, `wave`, `destino`, `importador`).

Uma menção **explicitamente negada na própria oração** deixa de valer como
evidência afirmativa:

- **telex:** negador antes ("No telex release", "Sem telex", "Não haverá telex",
  "Please do not telex") ou logo depois ("Telex release not approved", "O telex não
  foi liberado");
- **envio ao destinatário** (`importador`): negador antes do verbo ("OHBL not sent
  to consignee", "não foi enviado ao importador") ou entre o verbo e o destinatário
  ("sent to the agent, not to the consignee").

**Regras de leitura:**

- A negação só vale dentro da mesma oração. São fronteiras: `. ! ? ; ,`, quebra de
  linha, travessão, `but`, `mas`, `porém`… Por isso "Telex released. Original HBL
  not required." continua telex.
- Até 3 palavras neutras (artigos, auxiliares) podem separar o negador da menção.
- "not only", "não só" e "apenas" não são negação.
- Em português, "no" é "em + o" ("informado no telex", "Atenção: no telex release
  consta…"). Por isso "no" só nega quando valem as duas condições:
  - **posição:** início da oração; depois de "is", "there", "with", "please" e
    afins ("Please no telex release"); ou logo depois dos dois-pontos de um
    **rótulo em inglês de uma lista fechada** ("Status:", "Confirmed:", "Note:",
    "Remarks:"…);
  - **continuação:** a palavra seguinte à menção não pode ser uma das que só cabem
    na contração ("consta", "foi", "está", "o", "que"…). Assim, "No telex release
    consta a liberação" e "Observação: no telex release consta o destinatário"
    seguem telex.
- Os dois-pontos não são fronteira de oração: "Telex release: not approved" continua
  negado.
- `no`, `without` e `sem` não negam quando aparecem depois da menção ou entre o
  verbo e o destinatário ("no later than", "sent without delay to…").

**Sem negação, o resultado é idêntico ao anterior.** Os padrões de menção são os
mesmos, e um teste com 5.000 textos gerados confirma.

## O que NÃO mudou

- O front (`Courier Module.dc.html`), a persistência (estados, conferência,
  follow-ups em JSON), as chamadas externas e a IA (Clara).
- A detecção de Wave BL e de emissão no destino.
- A agregação continua por texto (envelope): basta uma menção não negada, como antes.

## Lacunas que continuam em ASS-010 (fora desta entrega)

Estes casos seguem o comportamento anterior. Os testes que os exercitam estão
rotulados como **caracterização de limitação conhecida**, e não como conformidade.

1. **Atribuição por documento:** o sinal vale para o envelope inteiro. Uma menção
   afirmativa sobre outro processo do mesmo envelope ainda conta (E4).
2. **Cronologia:** um cancelamento posterior ("telex cancelled, original by
   courier") não restaura a expectativa (ASS-009).
3. **Telex condicional ou pendente** ("pending payment", "upon payment",
   "awaiting") continua contando como telex. Decidir isso é questão de produto.
4. **Envio ao shipper** não é reconhecido. Exigiria distinguir "sent by" de
   "sent to", e envio condicional.
5. **"cnee"** não é reconhecido como destinatário, como antes.
6. **Negação separada por vírgula ou travessão** ("Telex release, not approved")
   não é lida.
7. **"Informação confiável"** ainda não é avaliada: autor, fonte e confirmação
   escrita.
8. **A análise da IA** (`hblResolution` da Clara, ao expandir um card) continua
   podendo indicar telex pelo próprio texto.
9. **"no" depois de rótulo fora da lista em inglês** ("HBL: no telex release")
   não é lido como negação e segue afirmativo, como antes. É conservador: na
   dúvida com a contração portuguesa, preserva o afirmativo.

## Testes

`npm run courier-docs:selftest` (27 casos, isolado):

- `docResolution.test.ts`: os casos aprovados, negações em inglês e português,
  afirmativos preservados, "HBL to cnee", Wave e destino inalterados, equivalência
  e monotonia em 5.000 + 5.000 textos gerados, e as caracterizações acima;
- `docResolution.rota.test.ts`: `GET /api/couriers` pela rota real, com Graph, MSAL
  e Gemini falsos e rede bloqueada. Confere:
  - a resposta traz a resolução corrigida;
  - os registros de estado, conferência e follow-up semeados não mudam (hash e
    data de modificação);
  - 1 busca no Graph e 0 chamadas de IA por lista.
