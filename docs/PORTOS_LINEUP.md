# Line-up dos portos — estado e como funciona

Módulo `src/ports/`. Cada porto vira uma lista de **escalas** (`PortCall`) no mesmo
formato: navio, viagem, IMO, armador, agência, terminal, berço, status normalizado
(`esperado | ao_largo | programado | atracado | desatracado | omitido`) e as datas
previstas/reais de chegada (ETA/ATA), atracação (ETB/ATB), saída (ETD/ATD), abertura
de gate e deadline — em ISO no horário de Brasília (`-03:00`). Campo que o porto não
informa = `null`.

## Portos ligados

| id | Porto | Fonte | Observação |
|---|---|---|---|
| `itapoa` | Porto Itapoá (SC) | API JSON que o próprio site usa | Token "Bearer" fixo embutido no JS público do site — **lido em tempo de execução, não guardado no código** (traz dados pessoais de um funcionário). Renova sozinho em 401/403. |
| `riobrasil` | Rio Brasil Terminal (RJ) | API JSON (Azure API Management) do site | Chave `Ocp-Apim-Subscription-Key` do bundle público — mesma regra (lida em execução). Status vem da lista (esperados/atracados/desatracados/omitidos). |
| `paranagua` | Porto de Paranaguá (APPA) | Relatório HTML público "Line Up" | Uma tabela por situação. Cobre **todos os terminais, inclusive a TCP** (coluna Operador). Substitui praticoszp21.com.br (domínio tomado — abre loja falsa). |

## Uso

- `GET /api/ports` · `GET /api/ports/:id/lineup?status=atracado,esperado&conteiner=1&refresh=1`
  · `GET /api/ports/navio?nome=&viagem=` (exige login da Priora).
- Diagnóstico: `/health/port-lineup?token=<DIAG_TOKEN>&port=all` (ou `&navio=`).
- Cache em memória: `PORTS_CACHE_MIN` (padrão 30). Falha com cache antigo → devolve o
  antigo com `error`.
- Self-test com respostas reais: `npm run ports:selftest`.

## Próximos (diagnóstico de 13/10/2026)

| Porto | Bloqueio | Caminho |
|---|---|---|
| BTP (Santos) | reCAPTCHA v3 invisível | navegador remoto |
| Santos Brasil, Tecon Salvador | Akamai | API de Scrape da Scrapfly (como a ZIM) |
| Portonave | WAF XLabs com impressão digital | navegador remoto (difícil) |
| JBS Terminais | página 404 do lado deles | aguardar / portal do cliente |
