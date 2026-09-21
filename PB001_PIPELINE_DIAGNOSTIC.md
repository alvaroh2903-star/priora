# PB-001 — Diagnóstico do Pipeline Documental (somente observação)

> **Escopo:** este documento **apenas observa**. Nenhuma regra, OCR, schema ou UI foi
> alterado. Todos os caminhos abaixo citam arquivo e linha reais do código atual.

---

## 0. Descoberta que muda a pergunta: **o Mistral NÃO está no pipeline do PB-001**

A tarefa parte de "o Mistral extrai certo, mas o PB-001 diz *não encontrado*". Isso
**não pode acontecer pela ligação Mistral→PB-001**, porque **ela não existe**:

- O Mistral vive em `src/ai/mistralOcrClient.ts` + `src/ai/mistralOcrSelftest.ts` e é um
  **smoke test isolado** — chamado só pela rota diagnóstica `POST /health/mistral-selftest`
  (`src/index.ts`). Ele devolve `pages[].markdown` (texto cru) e **não é consumido por
  nenhum extractor, mapper, Rule Engine ou UI**. Grep de confirmação: `mistralOcrClient`
  só é importado por `mistralOcrSelftest.ts` e `src/index.ts` (health).
- Quem alimenta o PB-001 é o **Gemini**: `src/ai/geminiClient.ts`
  (`generateStructuredFromDocuments`) → `src/auditoria/preAlerta/extracaoPreAlerta.ts`.

**Consequência direta:** qualquer "o Mistral leu X mas a Auditoria não achou" é comparar
**dois sistemas desconectados**. O que a Auditoria "entendeu que foi lido" vem do **Gemini**,
não do Mistral. Portanto o diagnóstico real do PB-001 é feito sobre o pipeline Gemini abaixo.
O Mistral, hoje, não perde nem ganha nada no PB-001 — ele não participa.

O `diagnostics/mistral-raw.json` **não foi gerado** porque (a) o Mistral não produz input do
PB-001 e (b) exigiria um documento real + chamada paga; ver `diagnostics/README.md` para como
capturar quando isso fizer sentido.

---

## 1. Fluxo atual REAL (nomes de arquivo/função)

```
Outlook (Graph)
  └─ src/graph/graphService.ts  (getFullMessage / getForwardedFileAttachments / getAttachmentContent)
     └─ src/routes/auditoriaRoutes.ts  → coletarDocsDoProcesso()  [descobre e baixa anexos]
        └─ GET /:processo/pre-alerta
           ├─ OCR/EXTRAÇÃO (única IA do fluxo):
           │    src/auditoria/preAlerta/extracaoPreAlerta.ts → extrairDocPreAlertaMultiplo()
           │      └─ src/ai/geminiClient.ts → generateStructuredFromDocuments()  [Gemini visão]
           │      └─ ExtractionSchema (zod)  →  mapExtracaoParaDoc()  →  DocPreAlerta
           ├─ CLASSIFICAÇÃO (papel MBL×HBL):
           │    classificarPapel()  (consignee → assunto → nome → conteúdo → armador → contêiner)
           │    consolidarPorConhecimento()  (une páginas do mesmo BL por número)
           │    montarOperacao()  →  { processo, master, houses[] }
           ├─ RULE ENGINE (determinístico, sem IA):
           │    src/auditoria/preAlerta/index.ts → executarPreAlerta(op)
           │      V-003 containers · V-004 volumes · V-005 peso bruto · V-006 peso líquido
           │      V-007 cubagem · V-008 lacres · V-009 portos · V-012 NCM
           │      (NÃO executam: V-010 participantes, V-011 mercadoria)
           └─ PAYLOAD { master, houses, resultado, familias, evidencias }
              └─ UI  public/Auditoria.dc.html → consolidarRows()  [consolida evidências em conceitos]
```

**O objeto "após extração" e o "input do PB-001" são o MESMO objeto:** `DocPreAlerta`
(`src/auditoria/preAlerta/modelo.ts`). Não há mapper intermediário entre extração e Rule
Engine — `montarOperacao(op)` só agrupa os `DocPreAlerta` em `{ master, houses }`. Ou seja,
**não existe a camada de mapping/alias onde o usuário suspeitava** que os dados se perdiam.

### Captura em runtime (real, sem código novo)
`GET /api/auditoria/:processo/pre-alerta?debug=1` já devolve, por documento: `legivel`,
`tipoDetectado`, `conhecimentoNumero`, `containersLidos`, `tipoFinal`, `papelConfiavel`,
`erro` — **é o "after-extraction / pb001-input"** — e `familias`/`evidencias` é o
**"pb001-output"**. Use-o no processo problemático (ver `diagnostics/README.md`).

---

## 2. Campo por campo (os 20)

Legenda de "1ª camada de perda": **EXTRAÇÃO** = o `ExtractionSchema` nem pede o campo ao Gemini
(nunca existe) · **RULE ENGINE** = é extraído mas nenhuma família o compara · **UI** = é
validado mas não aparece na tela · **—** = trafega inteiro.

| # | Campo | ExtractionSchema pede? | Campo em `DocPreAlerta` | Família que valida | Aparece na UI (`consolidarRows`)? | 1ª camada de perda |
|---|---|---|---|---|---|---|
| 1 | MBL/HBL Number | ✅ `conhecimentoNumero` (ln 28) | `conhecimentoNumero` | — (usado p/ classificar, **não** comparado, correto §8) | nº não é card (vira nome master/houses) | — |
| 2 | Container Number | ✅ `containers[].numero` (ln 16) | `containers[].numero` | **V-003** | ✅ `V-003.2` | — |
| 3 | Seal / Lacre | ✅ `containers[].lacre` (ln 20) | `containers[].lacre` | **V-008** | ✅ `V-008.1/.2` | — (ver §9) |
| 4 | Gross Weight | ✅ `pesoBrutoKg` + `pesoBrutoTotalKg` (ln 17/37) | idem | **V-005** | ✅ `V-005.1/.2` | — |
| 5 | Net Weight | ✅ `pesoLiquidoKg` + `pesoLiquidoTotalKg` (ln 18/38) | idem | **V-006** | ✅ (oculto se ausente) | — |
| 6 | Cubage / Measurement | ✅ `cubagemM3` + `cubagemTotalM3` (ln 19/39) | idem | **V-007** | ✅ `V-007.1/.2` | — |
| 7 | Package Quantity | ✅ `qtdVolumesTotal` (ln 40) | idem | **V-004.1** | ✅ | — |
| 8 | Package Type | ✅ `tipoVolume` (ln 41) | idem | **V-004.2** (normalizado) | ✅ | — |
| 9 | NCM | ✅ `ncm[]` + `containers[].ncm` (ln 43/21) | idem | **V-012** | ✅ `V-012.2` | — |
| 10 | **Shipper** | ❌ **não existe no schema** | — | — | ❌ | **EXTRAÇÃO** |
| 11 | Consignee | ✅ `consignee` (ln 30) | `consignee` | ❌ (só `classificarPapel`) | ❌ | **RULE ENGINE/UI** |
| 12 | POL | ✅ `pol` (ln 32) | `pol` | **V-009** | ✅ | — |
| 13 | POD | ✅ `pod` (ln 33) | `pod` | **V-009** | ✅ | — |
| 14 | Place of Receipt | ✅ `placeOfReceipt` (ln 34) | idem | **V-009** | ✅ | — |
| 15 | Place of Delivery | ✅ `placeOfDelivery` (ln 35) | idem | **V-009** | ✅ | — |
| 16 | **Vessel / Navio** | ❌ **não existe no schema** | — | — | ❌ | **EXTRAÇÃO** |
| 17 | **Voyage** | ❌ **não existe no schema** | — | — | ❌ | **EXTRAÇÃO** |
| 18 | **Freight / Prepaid / Collect** | ❌ **não existe no schema** | — | — | ❌ | **EXTRAÇÃO** |
| 19 | **Wooden Packaging** | ❌ **não existe no schema** | — | — | ❌ | **EXTRAÇÃO** |
| 20 | Description of Goods | ✅ `descricaoMercadoria` (ln 42) | `descricaoMercadoria` | ❌ (sem V-011) | ❌ | **RULE ENGINE** |

> As colunas "texto exato do OCR / está no OCR bruto" exigem uma captura de runtime de um
> documento real — use `?debug=1` (§1). Exemplo real já observado nesta sessão (processo
> IM3347): o Gemini leu container `TGBU8599903`/`OOCU5681253`, seals `OOLKZD1101/1110`,
> pesos `5270/5580 kg`, cubagens `67.35/67.433 m³`, NCM `950300/481910`, POL/POD
> `SHEKOU→SANTOS` — **todos presentes e comparados**; a única "divergência" foi
> `CARTONS × CARTON(S)` (já corrigida por normalização). Ou seja, quando o Gemini lê, os
> campos do schema **chegam e são validados**.

---

## 3. Dados presentes na extração (Gemini) mas perdidos depois

- **Consignee** — extraído (`extracaoPreAlerta.ts:111`, campo `consignee`) e usado **só** em
  `classificarPapel` (decisão Master×House). Não vira evidência nem card. → perdido na
  entrada do Rule Engine (nenhuma família o lê) e na UI.
- **Description of Goods** — extraído (`descricaoMercadoria`) mas **nenhuma família** o
  compara (não há V-011; ver `index.ts` §2). → perdido no Rule Engine.
- **transbordos** — extraído (`ExtractionSchema.transbordos`) e passado ao `DocPreAlerta`,
  mas a V-009 (`v009Portos.ts`) não emite card de transbordo na UI. → perdido na UI.

## 4. Dados corretamente mapeados mas ignorados pelo validator

- **Consignee** e **Description of Goods** (acima) — mapeados 1:1 em `DocPreAlerta`, porém
  sem família correspondente em `executarPreAlerta` (só V-003..V-009, V-012).

## 5. Dados validados mas exibidos incorretamente na UI

- **Nada é exibido "errado" por conversão.** A UI (`consolidarRows`) só **re-rotula/consolida**
  evidências; ela não recomputa valores. O ponto relevante: campos **sem entrada no MAP**
  (`Auditoria.dc.html:424-435` + PORTO `:437`) simplesmente **não aparecem**, mesmo que o
  motor os tenha avaliado. Hoje o MAP cobre V-003.2, V-004.1/.2, V-005.1/.2, V-006.1/.2,
  V-007.1/.2, V-008.1/.2, V-009.2(POL/POD/PoR/PoD), V-012.2. Qualquer evidência fora disso
  (ex.: uma futura V-011) ficaria invisível.

## 6. Aliases / schema incompatíveis

- **Dentro do pipeline ativo (Gemini) NÃO há incompatibilidade de alias.** `mapExtracaoParaDoc`
  (`extracaoPreAlerta.ts:94+`) copia **1:1** os nomes do `ExtractionSchema` para o
  `DocPreAlerta` (`seal`→não existe; é `lacre` dos dois lados; `numero`, `pesoBrutoKg`,
  `cubagemM3`, `ncm` idênticos). Não existe `sealNumber`/`blNumber`/`grossWeight` concorrente.
- **O risco de alias é FUTURO e específico do Mistral:** o Mistral devolve `pages[].markdown`
  (texto), **não** campos estruturados. No dia em que ligarmos Mistral→PB-001 será preciso um
  **parser** do markdown para o `DocPreAlerta` — e é aí que nascem os aliases (`SEAL NO.`,
  `Gross Weight`, `NCM`, etc.). Hoje esse parser **não existe**.

## 7. Problemas de associação por contêiner

- Campos por contêiner (`numero`, `lacre`, `pesoBrutoKg`, `pesoLiquidoKg`, `cubagemM3`, `ncm`)
  vêm **já aninhados** no `containers[]` que o Gemini devolve — a associação é feita **pela
  própria IA na leitura**, não por código nosso. Não há "campo solto" reassociado depois.
- A **comparação** por contêiner depende de **V-003** parear master↔house por
  `normalizarCodigo(numero)` (`v003Containers.ts`). As famílias V-005/006/007/008 rodam
  **sobre `relacoes`** (os pares criados pela V-003). **Se a V-003 não parear** (número de
  contêiner divergente/ilegível entre MBL e HBL, ou lido em formato diferente), então
  peso/cubagem/**lacre** daquele contêiner ficam **NaoAvaliada** — não por falta de dado, mas
  por falta de par. Este é o mecanismo mais provável por trás de "lacre/peso não encontrado"
  quando o dado visivelmente existe.
- **Part lot** (mesmo contêiner em vários Houses) é tratado no CE (PB-002); no PB-001 a V-003
  cria 1 relação por número casado.

## 8. Primeira causa de "BL não encontrado" (Faltando MBL)

- **Arquivo/linha:** `src/routes/auditoriaRoutes.ts:1036` — `if (!op.master || op.houses.length === 0)`
  → devolve `semParMBLHBL:true, faltando:['MBL (Master BL)']` (`:1047`). `op.master` vem de
  `montarOperacao` (`extracaoPreAlerta.ts:425` → `master: mbls[0] ?? null`).
- **Motivo:** `master` fica `null` quando **nenhum documento foi CLASSIFICADO como MBL** por
  `classificarPapel` — **não** quando o OCR falhou em ler o número do BL. Ordem de sinais em
  `classificarPapel` (`extracaoPreAlerta.ts`): consignee=Rocket → nº do assunto (`MBL: …`) →
  rótulo no nome (`-OMBL`) → `tipoDetectado` do conteúdo → sigla de armador → contêiner.
  Se **nenhum** disparar (ex.: consignee não lido/≠Rocket, assunto sem `MBL:`, nome genérico,
  IA não cravou o tipo, número sem SCAC), o doc não vira MBL → "Faltando MBL".
- **Conclusão:** a 1ª camada é **CLASSIFICAÇÃO**, não extração. O número do BL pode estar
  perfeitamente lido em `conhecimentoNumero` e ainda assim faltar o *papel* Master.

## 9. Primeira causa de "Lacre não encontrado"

- **Arquivo/linha:** `src/auditoria/preAlerta/v008Lacres.ts:30` (`semLacre`) e `:43`
  (`'Lacre ausente em um dos documentos.'`, resultado **NaoAvaliada**). A UI mostra isso como
  **"Campo não localizado / Atenção"** (`Auditoria.dc.html`, pós-processamento do
  `consolidarRows`).
- **Duas causas possíveis, nesta ordem de verificação:**
  1. **V-003 não pareou o contêiner** → não há `relacao` → a V-008 nem chega a comparar o
     lacre daquele contêiner. (Verificar `V-003.2`/existência no `?debug=1`/evidências.)
  2. **`containers[].lacre` veio `null`** de um dos lados (o Gemini não leu o SEAL naquele
     documento, ou leu no nível errado). (Verificar `mistral-raw`/`?debug=1` → `containersLidos`
     e o valor de `lacre`.)
- **Conclusão:** só é "OCR não leu" no caso 2 **com `lacre:null` confirmado no objeto extraído**.
  Se o lacre está no objeto extraído mas some no resultado, a causa é **V-003 (pareamento)**,
  não a leitura.

---

## 10. Recomendações (NÃO implementar agora — só observação)

1. **Fechar a lacuna de schema** (maior fonte de "não encontrado" real): adicionar ao
   `ExtractionSchema` os campos hoje ausentes que a operação precisa — **Shipper, Vessel,
   Voyage, Freight (valor/moeda/prepaid-collect), Wooden Packaging** — e as respectivas
   famílias/UI. Enquanto não existirem no schema, o "não encontrado" desses campos é
   **estrutural**, não OCR.
2. **Aproveitar o que já é extraído:** ligar **Consignee** (V-010 participantes) e
   **Description of Goods** (V-011) — os dados já chegam em `DocPreAlerta`, só faltam
   família + entrada no MAP da UI.
3. **Ao ligar o Mistral**, prever um **parser markdown→DocPreAlerta** com dicionário de
   aliases (`SEAL NO.`, `Gross Weight`, `Measurement`, `NCM`…). É a camada que hoje não existe
   e onde os aliases realmente aparecerão.
4. **Instrumentar o pareamento V-003**: quando um contêiner não parear, deixar isso explícito
   na evidência (hoje vira NaoAvaliada genérico), para separar "OCR não leu" de "não pareou".
5. **Não tratar `?debug=1` como suficiente para dado sensível**: ele é gated por sessão; para
   auditar OCR bruto de documento real, usar um dump local temporário (ver `diagnostics/`).

---

### Resumo em uma frase
O PB-001 é alimentado pelo **Gemini** (o Mistral está desligado do fluxo). Quando o Gemini lê,
os campos **do schema** chegam e são comparados corretamente; os "não encontrado" reais vêm de
**(a) campos que o schema nem pede** (Shipper/Vessel/Voyage/Freight/Wooden), **(b) campos
extraídos sem família/UI** (Consignee, Description), **(c) falha de CLASSIFICAÇÃO** (BL) ou
**de PAREAMENTO V-003** (lacre/peso por contêiner) — **nunca** por um mapper/alias intermediário,
que não existe.
