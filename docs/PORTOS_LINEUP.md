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
| `santosbrasil-santos` · `santosbrasil-imbituba` · `santosbrasil-vila-do-conde` | Santos Brasil (Tecon Santos/SP, Imbituba/SC, Vila do Conde/PA) | JSON `/v2021/lista-de-atracacao/pesquisa` do site | A página fica atrás da Akamai para navegador automatizado, mas o JSON responde a requisição simples. O reCAPTCHA só esconde a tabela na tela (o token não vai ao servidor). Resposta limitada a 100 linhas → janelas de 15 dias. Datas `/Date(ms)/` em UTC. |
| `btp` | BTP (Santos/SP) | `POST /ConsultasLivres/ListaAtracacao` (jTable) | Exige a sessão da página + o token antifalsificação do formulário (sem eles: 302). O reCAPTCHA v3 não é exigido. Datas-coringa (31/12/2030…) viram null. |
| `tecon-riogrande` | Tecon Rio Grande (Wilson Sons, RS) | `api.teconline.com.br/API/ProgNavio` (Navis N4) | Página e API atrás da **Akamai** → API de Scrape da Scrapfly com ASP, **sem navegador** (`render_js=false`): 1 crédito por consulta. `teconline.com.br` (com ou sem www) é o app de **Rio Grande** ("RIG"), não de Salvador. |
| `salvador` | Porto de Salvador (CODEBA, BA) — inclui o **Tecon Salvador** | Página pública da CODEBA (`site.php?secao=tportos_salvador`) | Tabelas ESPERADOS/ATRACADOS. Colunas IMO e Viagem estão comentadas no HTML (tirar comentários antes de ler). ISO-8859-1 sem charset. Só previsões (ETA/ETB/ETD) — ATA/ATB/ATD null. Aratu/Ilhéus têm o mesmo formato (`fetchCodeba`), mas são granéis. |

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
| Portonave | WAF XLabs com impressão digital | navegador remoto (difícil) |
| JBS Terminais | página 404 do lado deles | aguardar / portal do cliente |
