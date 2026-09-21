# diagnostics/ — capturas ponta a ponta (LOCAIS, não versionadas)

Tudo nesta pasta (exceto este README e o `.gitignore`) é **ignorado pelo git** porque contém
OCR bruto / documentos reais. Não commitar, não expor em endpoint público, não jogar inteiro
nos logs do Render (item 12 da tarefa).

## Por que os arquivos não vêm prontos no repo
O diagnóstico (`../PB001_PIPELINE_DIAGNOSTIC.md`) mostrou que **o Mistral não alimenta o
PB-001** — quem alimenta é o **Gemini**. Então:

- **`mistral-raw.json` / `mistral-raw.md`** — só fazem sentido se/quando o Mistral for ligado
  ao fluxo. Hoje o Mistral é um smoke test isolado; para capturar a resposta crua dele use a
  rota gated (não gera input do PB-001):
  ```bash
  curl -X POST "https://priora-1.onrender.com/health/mistral-selftest?token=$DIAG_TOKEN"
  ```
  (devolve **só** metadados seguros — o markdown fica interno; ver `src/ai/mistralOcrClient.ts`).

- **`after-extraction.json` + `pb001-input.json`** — no pipeline atual são o **mesmo objeto**
  (`DocPreAlerta`; não há mapper intermediário). Captura real, sem código novo:
  ```bash
  curl "https://priora-1.onrender.com/api/auditoria/<IM>/pre-alerta?debug=1" \
    -H "Cookie: <sessão logada>" > diagnostics/pb001-input.json
  ```
  O campo `diagnostico[]` traz, por documento: `legivel`, `tipoDetectado`, `conhecimentoNumero`,
  `containersLidos`, `tipoFinal`, `papelConfiavel`, `erro`.

- **`pb001-output.json`** — é o corpo do MESMO retorno acima: `familias[]` + `evidencias[]`
  (cada validação com `subvalidacao`, `resultado`, `valores`, `motivo`). Basta salvar o JSON.

## Como rastrear um campo (ex.: Lacre)
1. `pb001-input.json` → o documento tem `containersLidos > 0`? (o Gemini leu contêineres)
2. `pb001-output.json` → existe `V-003.2` **Consistente** para aquele contêiner? (pareou)
   - Se **não pareou**, `V-008` nem avalia o lacre → "não encontrado" é **pareamento**, não OCR.
   - Se pareou e `V-008.1` = `NaoAvaliada "Lacre ausente…"` com `valor:'—'` de um lado → o
     `lacre` veio `null` naquele documento → aí sim é **extração** (o Gemini não leu o SEAL).

Ver a tabela campo-a-campo e as "primeiras causas" no relatório principal.
