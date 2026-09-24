# Contrato REAL da API de Tracking — Priora

> Documento de **diagnóstico**. Descreve **exclusivamente como o código existente
> funciona hoje** (não o desejado). Onde algo não existe: **NÃO IMPLEMENTADO** ou
> **NÃO IDENTIFICADO**. Serve para integrar o Tracking com a Demurrage Engine V2
> (em outro branch). **Nada do Tracking foi alterado para gerar este documento.**

## 0. Identificação

| Item | Valor |
|---|---|
| **Repositório** | `github.com/alvaroh2903-star/priora` |
| **Branch atual** | `claude/demurrage-api-playwright-5q2lqq` |
| **Último commit com Tracking funcional** | `ed3f055` (`fix(diag): detecta "referência inválida/sem resultado/manutenção" no portal`) |
| **Código não commitado** | **NÃO** — `git status` limpo; todo o Tracking está commitado |
| **Runtime** | Node.js + TypeScript (Express), deploy Docker no Render |

### Arquivos responsáveis pela API (fachada + rotas)
- `src/browser/carriers/index.ts` — fachada: `trackShipment()`, `detect()`, `listCarriers()`.
- `src/browser/carriers/detect.ts` — detecção de armador + tipo (`detectCarrier`, `classifyReference`, `isValidContainer`, `normalizeRef`).
- `src/browser/carriers/registry.ts` — registro dos 12 armadores (`CARRIERS`, `resolveTrackingUrl`, `resolveSearchRef`).
- `src/browser/carriers/types.ts` — tipos (`TrackingResult`, `TrackingEvent`, `ContainerInfo`, `CarrierMeta`, `ReferenceType`, `NormalizedEventType`).
- `src/browser/carriers/scraper.ts` — orquestração de scraping (`scrapeCarrier`, `genericScrape`), retry, `scrapeBlocked`.
- `src/browser/carriers/apiSources.ts` + `src/browser/carriers/api/maersk.ts` — API oficial (fallback/apiFirst).
- `src/routes/demurrageBotRoutes.ts` — rotas HTTP de produção (`/api/demurrage/bot/*`).
- `src/index.ts` — rotas de **diagnóstico** (`/health/track`, `/health/scrape-sb`).
- `src/demurrage/demurrageBotStore.ts` — cache/TTL/merge de eventos.
- `src/demurrage/trackingMapper.ts` — ponte Tracking → módulo Demurrage.

### Arquivos responsáveis por Playwright / Scrapfly
- `src/browser/browser.ts` — `withPage` (Chromium local) e `withRemotePage` (navegador remoto via CDP).
- `src/browser/scrapingBrowser.ts` — `connectSB` (CDP `connectOverCDP`), `buildWSEndpoint` (lê `SCRAPE_BROWSER_WSS`), `driveTrackingPage`, `waitOutChallenge`, `isChallengePage`, `blockHeavyResources`, `scrapeViaSB`.
- `src/browser/antiCaptcha.ts` — resolução de captcha de TOKEN (anti-captcha.com).
- `src/browser/carriers/pageUtils.ts` — drivers de formulário (`tryFillSearch`, `driveShipmentLinkForm`, `driveMscForm`, `driveZimForm`, `acceptCookies`).
- `src/browser/carriers/drivers.ts` — registro de drivers por host (`findCarrierDriver`).
- `src/browser/carriers/scrapers/*.ts` — parsers dedicados por armador + `dispatch.ts` (roteamento por assinatura de DOM).

---

## 1–3. Endpoints, método HTTP e autenticação

### 3.1 Produção — `/api/demurrage/bot/*` (auth por **sessão**)
Todas passam por `requireAuth` (`demurrageBotRouter.use(requireAuth)`), ou seja,
**cookie de sessão do login Priora**. Sem sessão válida → 401/redirecionamento do
middleware. **Não há API key** nessas rotas (é o mesmo app do SaaS).

| Método | Rota | Função |
|---|---|---|
| GET | `/api/demurrage/bot/status` | estado do bot (proxy/captcha/cache/concorrência) |
| GET | `/api/demurrage/bot/carriers` | lista de armadores (`listCarriers`) |
| GET | `/api/demurrage/bot/ip` | IP de saída do navegador (diagnóstico de proxy) |
| GET | `/api/demurrage/bot/detect?ref=` | detecção sem browser (armador + tipo) |
| GET | `/api/demurrage/bot/track?ref=&carrier=&type=` | `trackShipment` (sobe navegador), resultado bruto |
| GET | `/api/demurrage/bot/enrich?ref=&carrier=&refresh=` | track + cache + shape p/ Demurrage |
| POST | `/api/demurrage/bot/enrich-batch` | vários refs (corpo `{refs:[], refresh}`) |
| GET | `/api/demurrage/bot/results` | dump do cache (sem raspar) |
| POST | `/api/demurrage/bot/calc` | cálculo de demurrage por faixas (não raspa) |

### 3.2 Diagnóstico — `/health/*` (auth por **DIAG_TOKEN**, NÃO sessão)
Gated por `?token=<DIAG_TOKEN>` (variável de ambiente). Se `DIAG_TOKEN` não estiver
setada → **404**. Token errado → **401**. **Não usam sessão** (servem para teste sem login).

| Método | Rota | Função |
|---|---|---|
| GET | `/health/track?token=&ref=` **ou** `&refs=a,b,c&c=N` | `trackShipment` REAL (produção), 1 ou lote |
| GET | `/health/scrape-sb?token=&ref=` (ou `&url=`) `&probe=&find=&htmlwin=&via=` | pilota a página e devolve HTML/inventário cru (ferramenta de dev p/ escrever parser) |

> Observação: `/health/track` e `/health/scrape-sb` **forçam raspagem fresca (ignoram o cache)**. O cache só é usado no `enrich`/`enrich-batch`.

---

## 4. Request completo

### `GET /api/demurrage/bot/enrich`
- Query: `ref` (obrigatório), `carrier` (opcional, força o armador), `refresh` (`1`/`true` ignora cache).
- Sem corpo.

### `POST /api/demurrage/bot/enrich-batch`
- Corpo JSON: `{ "refs": ["MEDUY8275040", "274319835"], "refresh": false }`.
- `refs` deduplicado (Set) e cortado em `config.bot.maxBatch` (padrão **10**).

### `GET /api/demurrage/bot/track`
- Query: `ref` (obrigatório), `carrier` (opcional), `type` (`container|bl|booking`, opcional).

### `GET /health/track` (diagnóstico)
- Query: `token` (obrigatório), e **um** de: `ref=<X>` (resultado completo) **ou**
  `refs=a,b,c` (lote, resumo enxuto). Opcionais: `carrier`, `c` (concorrência do lote, 1–4, padrão 2; teto 12 refs).

---

## 5. Identificadores aceitos

Tipos em `ReferenceType` (`types.ts`): **`container` | `bl` | `booking` | `unknown`**.
Classificação em `classifyReference` (`detect.ts`):
- **container**: ISO 6346 (`^[A-Z]{4}\d{7}$`), com **validação de dígito verificador** (`isValidContainer`).
- **bl**: `^[A-Z]{4}[A-Z0-9]{4,}$` (4 letras + alfanumérico).
- **booking**: `^[A-Z0-9]{6,}$`.
- senão **unknown**.

- **MBL vs HBL:** **NÃO IMPLEMENTADO.** O código não distingue Master BL de House BL — ambos caem em `bl`. Não há campo/flag `mbl`/`hbl`.
- A referência é sempre normalizada (`normalizeRef`: maiúsculas, sem espaços/hífens).

---

## 6. Como o armador é informado

Duas formas (`trackShipment` em `index.ts`):
1. **Forçado:** parâmetro `carrier=<id>` (rotas) → `opts.carrierId` → `getCarrier(id)`.
2. **Autodetecção** (`detectCarrier`, `detect.ts`), nesta ordem (`matchedBy`):
   1. `container-prefix` — prefixo owner-code ISO 6346 (`containerPrefixes`).
   2. `scac` — 4 letras iniciais batem com `scac[]` do armador.
   3. `bl-prefix` — mapa `BL_PREFIX_MAP` de prefixos de porto/escritório que **não** são o SCAC (ex.: HMM `SGNM/NBOZ/…`, PIL `NNPL/…`, CMA `QGD3/…`, Evergreen `EVGL`).
   4. `numeric-pattern` — BLs puramente numéricos: COSCO (`^\d{10}$` iniciando em `6`), Evergreen (`^\d{12}$` iniciando em `14`), Maersk (`^\d{9}$`).
   - Sem match → `carrier: null`, `matchedBy: 'none'` → `trackShipment` **lança erro** pedindo `carrierId`.

---

## 7. Response completo

### 7.1 Objeto canônico `TrackingResult` (`types.ts`)
```ts
interface TrackingResult {
  carrierId: string;
  carrierName: string;
  reference: string;          // referência normalizada
  referenceType: ReferenceType;
  sourceUrl: string;          // URL efetivamente consultada (deep link ou form)
  ok: boolean;                // extração encontrou dados úteis?
  needsLogin: boolean;        // flag (ver §25/§26)
  needsCaptcha: boolean;      // flag
  containers: ContainerInfo[];
  events: TrackingEvent[];
  raw?: string;               // trecho de texto bruto (só em falha/fallback, ≤4000 chars)
  message?: string;           // mensagem legível
  fetchedAt: string;          // timestamp ISO da consulta
}
```

### 7.2 `GET /api/demurrage/bot/track` e `/health/track?ref=`
- `track` (produção) devolve **o `TrackingResult` cru**.
- `/health/track?ref=` devolve `{ ok, ms, result: TrackingResult }`.

### 7.3 `GET /api/demurrage/bot/enrich` → `shapeEnrich` (formato para a Demurrage)
```ts
{
  carrier: { id, name },
  reference, referenceType,
  ok, needsLogin, needsCaptcha, message, sourceUrl,
  events: TrackingEvent[],
  demurrageContainers: DemurrageContainer[],  // via trackingMapper
  cached: boolean,        // veio do cache?
  resolved: boolean,      // BL encerrado (todos devolvidos)?
  at: string,             // timestamp do registro no cache
  organizedByAI: boolean  // a Clara reorganizou texto cru?
}
```
`DemurrageContainer` (do `trackingMapper.trackingToDemurrageContainers`):
```ts
{ numero, dataRetirada: c.gateOut, freeTimeDias: null, diaria: null,
  moeda: null, dataDevolucao: c.emptyReturn, minutaRecebida: null }
```
> `freeTimeDias`/`diaria`/`moeda` são **contratuais** e vêm do **e-mail (Clara)**, não do portal — por isso `null` aqui.

### 7.4 `/health/track?refs=` (lote) — resumo enxuto por ref
```ts
{ mode:"batch", count, ok, ms, results:[
  { ref, carrier, ok, ms, eventsCount, needsCaptcha,
    containers:[{numero,tipo,dischargeDate,gateOut,emptyReturn,lastFreeDay}],
    message } | { ref, ok:false, ms, error } ] }
```

---

## 8. Exemplo REAL (sanitizado) de response

`GET /health/track?token=***&refs=274319835,MEDUY8275040&c=2` (lote, executado em produção):
```json
{
  "mode": "batch", "count": 2, "ok": 2, "ms": 74000,
  "results": [
    {
      "ref": "274319835", "carrier": "Maersk", "ok": true, "ms": 32436,
      "eventsCount": 16, "needsCaptcha": false,
      "containers": [
        { "numero": "TRHU1477661", "tipo": null,
          "dischargeDate": "2026-08-26", "gateOut": "2026-08-27",
          "emptyReturn": "2026-09-09", "lastFreeDay": null }
      ],
      "message": "16 evento(s) extraído(s) do portal."
    },
    {
      "ref": "MEDUY8275040", "carrier": "MSC", "ok": true, "ms": 83000,
      "eventsCount": 6, "needsCaptcha": false,
      "containers": [
        { "numero": "MSMU7811290", "tipo": "40' HIGH CUBE",
          "dischargeDate": "2026-09-11", "gateOut": null,
          "emptyReturn": null, "lastFreeDay": null }
      ],
      "message": "6 evento(s) extraído(s) do portal."
    }
  ]
}
```
Exemplo de `TrackingEvent` real (Maersk), como aparece em `result.events[]`:
```json
{ "date": "2026-08-26", "status": "Discharge", "location": "Santos",
  "vessel": "MAERSK ... ", "voyage": "...", "type": "discharge",
  "container": "TRHU1477661", "tipo": null }
```

---

## 9. Estrutura dos eventos (`TrackingEvent`, `types.ts`)
```ts
interface TrackingEvent {
  date: string | null;       // data DO EVENTO em ISO (AAAA-MM-DD), ou null se não parseável
  status: string;            // descrição do evento como veio do portal
  location: string | null;
  vessel: string | null;
  voyage: string | null;
  type?: NormalizedEventType; // classificação normalizada (ver §10)
  container?: string | null;  // nº do contêiner (quando o portal expõe por contêiner)
  tipo?: string | null;       // tipo/tamanho (40HC…), quando exposto
}
```

## 10. Representação de descarga / Gate Out / Empty Return / demais

### Enum normalizado `NormalizedEventType` (`types.ts`)
`berth | discharge | available | gate_out | empty_return | other`

Classificação feita por **`classifyEvent(status)`** (`carriers/eventTypes.ts`), por
regex sobre o texto do evento, com guardas importantes:
- **Movimentos de vazio na ORIGEM** (`empty container release`, `gate out empty`) → `other` (não poluem demurrage).
- **Descarga em porto de TRANSBORDO (T/S)** (`discharg`+`transship|t/s|feeder`) → `other` (não é a descarga no destino).
- Ordem: `empty_return` antes de `gate_out`; `berth` antes de `discharge`.

### Datas por contêiner — `buildContainerInfo` (`scrapers/hapag.ts`)
```
dischargeDate = latestByType(events, 'discharge')          // descarga
availableDate = latestByType(events, 'available')          // disponibilidade
gateOut       = latestByTypeAfter(events, 'gate_out', dischargeDate)     // retirada (só ≥ descarga)
emptyReturn   = latestByTypeAfter(events, 'empty_return', dischargeDate) // devolução (só ≥ descarga)
status        = último evento (latestEvent)
tipo          = primeiro evento com `tipo`
lastFreeDay   = null  (exige login no portal comercial → NÃO IMPLEMENTADO)
```
- **Descarga:** `type='discharge'` → `ContainerInfo.dischargeDate`.
- **Gate Out (retirada do cheio):** `type='gate_out'` → `ContainerInfo.gateOut` — **filtrado para ≥ dischargeDate** (evita gate-out de vazio/origem).
- **Empty Return (devolução):** `type='empty_return'` → `ContainerInfo.emptyReturn` — também ≥ dischargeDate.
- **Demais eventos:** ficam em `events[]` com `type` classificado (inclusive `berth`, `available`, `other`); no nível de contêiner só as 5 datas acima + `status`/`tipo`.

---

## 11. Data do evento × timestamp da consulta
- **Data do evento:** `TrackingEvent.date` (data real do movimento no portal, ISO `AAAA-MM-DD`; sem hora na maioria).
- **Timestamp da consulta:** `TrackingResult.fetchedAt` (ISO, gerado no `scrapeCarrier`) e, no cache, `StoredBotResult.at` (ISO da gravação). No lote de diagnóstico há também `ms` (duração da chamada). São campos distintos e coexistem.

## 12. ID estável de evento
**NÃO IMPLEMENTADO.** `TrackingEvent` não tem `id`. A identidade usada internamente
(no merge do cache) é a **chave composta** `container|date|type|status` (`eventKey` em
`demurrageBotStore.ts`) — serve para dedupe, **não** é um ID estável exposto.

## 13. Payload bruto / referência ao payload
- **Parcial.** `TrackingResult.raw` guarda **um trecho de texto** (`textContent`, ≤ **4000** chars) — e **só em falha/fallback** (quando 0 eventos), para a Clara/depuração. Em sucesso, `raw` não é preenchido.
- **JSON interno da MSC:** é **capturado** da rede e usado para o parser (`driveMscForm`/`extractMscEvents`), mas **NÃO é persistido** no `TrackingResult` (o diagnóstico `/health/scrape-sb` expõe `apiJson`, mas a produção não guarda).
- **HTML completo:** exposto só no `/health/scrape-sb` (`htmlSlice`), **não** no `TrackingResult`.
- Não há armazenamento do payload bruto completo por consulta. → **referência a payload persistido: NÃO IMPLEMENTADO.**

---

## 14–15. Carriers implementados × não implementados

Registro (`registry.ts`) tem **12 armadores**: maersk, one, yangming, msc, pil,
evergreen, hmm, cmacgm, zim, hapag, cosco, oocl. Todos têm **detecção + URL**. O que
varia é ter **parser dedicado** e não estar **`scrapeBlocked`**.

| id | Parser dedicado | `scrapeBlocked` | Status no código |
|---|---|---|---|
| hapag | `scrapers/hapag.ts` (fallback do dispatch) | não | Raspa (caminho genérico + waitOutChallenge) |
| maersk | `scrapers/maersk.ts` | não | Raspa (+ API oficial fallback) |
| one | `scrapers/one.ts` | não | Raspa |
| **cosco** | `scrapers/cosco.ts` | **não** | **Raspa (IMPLEMENTADO)** |
| pil | `scrapers/pil.ts` | não | Raspa |
| hmm | `scrapers/hmm.ts` | não | Raspa |
| evergreen | `scrapers/evergreen.ts` + driver | não | Raspa |
| msc | `scrapers/msc.ts` (JSON interno) + driver | não | Raspa |
| yangming | `scrapers/yangming.ts` | não | Raspa |
| cmacgm | `scrapers/cma.ts` (pronto) | **sim** | **Bloqueado** (DataDome) → produção não abre sessão |
| oocl | `scrapers/oocl.ts` (pronto) | **sim** | **Bloqueado** (Cloudflare + slider CargoSmart) |
| zim | — (genérico) | **sim** | **Bloqueado** (hCaptcha em React) |

**Confirmação do ponto 15 (planejamento diz "OOCL e COSCO faltam"):**
- **COSCO — INCORRETO no planejamento.** No código **está IMPLEMENTADO e não bloqueado** (`scrapers/cosco.ts`, deep-link `scct/public/ct/base`, sem `scrapeBlocked`). Raspa.
- **OOCL — parcialmente correto.** O **parser existe** (`scrapers/oocl.ts`), mas o armador está **`scrapeBlocked: true`** (Cloudflare + captcha de slider do CargoSmart) → **a produção não raspa OOCL hoje**. Ou seja: parser pronto, execução bloqueada por anti-bot (sem solver implementado).

**Fonte de API oficial (`apiSources.ts`):** só **Maersk** (`api/maersk.ts`), e só ativa se houver credencial (`config.carrierApis.maersk.apiKey`). Demais armadores: **sem API** no código.

---

## 16–17. Onde entram Scrapfly e Playwright

- **Playwright** é a camada de automação:
  - `withPage` (browser.ts) = Chromium **local** (usa proxy `PROXY_SERVER` se houver — o local NÃO é usado pelos armadores hoje, pois todos vão pelo remoto).
  - `withRemotePage` (browser.ts) = navegador **remoto** via `chromium.connectOverCDP(...)`.
  - `driveTrackingPage` (scrapingBrowser.ts) = o "piloto" único (navega, cookies, captcha, drivers, espera resultado, coleta HTML).
- **Scrapfly** entra como o **navegador remoto CDP**:
  - `buildWSEndpoint()` lê `SCRAPE_BROWSER_WSS` (URL `wss://browser.scrapfly.io/?api_key=...&proxy_pool=...&solve_captcha=true&timeout=120000`).
  - `connectSB()` faz `connectOverCDP` nessa URL; `withRemotePage` usa isso.
  - `scrapeBrowserProvider()` retorna `custom-wss` quando `SCRAPE_BROWSER_WSS` está setado (tem prioridade sobre `BRIGHTDATA_SB_AUTH`, que é fallback e hoje **não** é usado).
- **Decisão local × remoto:** `scrapeCarrier` → `shouldUseScrapingBrowser(carrier) = isSBConfigured() && carrier.needsScrapingBrowser !== false`. Todos os 12 usam o **remoto** (Scrapfly).

## 18. Créditos Scrapfly representados no código
**NÃO IMPLEMENTADO.** O código **não conta, orça nem lê** créditos:
- Não há leitura de `X-Scrapfly-Api-Cost` (o Cloud Browser é via CDP/WebSocket, não retorna esse header) nem de `context.cost`.
- Não há `cost_budget`. O único parâmetro de custo é o `timeout=120000` **dentro da string** `SCRAPE_BROWSER_WSS` (env), não no código.
- Medição real de crédito: só no **dashboard do Scrapfly** (externo). → **NÃO IDENTIFICADO no código.**

---

## 19–23. Cache, TTL, dedupe, retry, timeout

### 19. Cache — `src/demurrage/demurrageBotStore.ts`
- Persistência em **disco**: `<config.dataDir>/demurrage-bot-results.json` (sobrevive a reinício).
- Chave: `refKey(ref)` = referência **maiúscula, sem espaços/hífens**.
- API: `getBotResult`, `saveBotResult`, `getAllBotResults`, `clearAll`.
- Usado **só** por `enrich`/`enrich-batch` (as rotas `track` e `/health/*` **não** usam cache).

### 20. TTL / freshness — **adaptativo ao estado do BL** (`scrapeIntervalMs`)
- **RESOLVIDO** (todos os contêineres com `emptyReturn`) → `Infinity` (**nunca** re-raspa; cache eterno).
- **EM TRÂNSITO** (tem contêiner mas sem descarga/retirada/devolução) → `BOT_TRANSIT_TTL_HOURS` (padrão **72h**).
- **ATIVO** (já tem descarga) ou **sem dados** → `BOT_RESULT_TTL_HOURS` (padrão **12h**).
- `enrichOne`: serve do cache se `idade < intervalo`; `refresh=1` ignora o cache.

### 21. Dedupe
- **Refs (lote):** `enrich-batch` deduplica com `Set` e corta em `maxBatch` (10).
- **Eventos (cache):** `mergeEvents` acumula eventos entre raspagens e deduplica por `container|date|type|status` (`eventKey`), re-derivando os contêineres. Reconstrói histórico dos armadores que só mostram o último evento.

### 22. Retry
- **Produção (`scrapeCarrier`, caminho genérico):** até **2 tentativas**, cada uma em **sessão nova** (IP novo), **só** se a falha for **transitória** (`raw` vazio/curto = página não carregou). Falha de **parser** (página carregou, 0 eventos) e captcha **não** reintentam.
- **Diagnóstico (`scrapeViaSB`):** 1 retry com sessão nova **quando a página é um desafio anti-bot** (`isChallengePage`).
- **Anti-captcha:** o `scrapeCarrier` (caminho específico) roda o scraper 1x mais se o captcha for resolvido. (Hoje o mapa de scrapers específicos está **vazio** — todos usam o genérico.)

### 23. Timeout (valores no código)
- `connectSB`: **30s** para conectar ao CDP.
- `driveTrackingPage`: navegação `navTimeout` **90s**; `waitForSelector(RESULT_SELECTOR)` **25s**; `networkidle` `postWait` **8s**; `waitForResults` deadline **20s**.
- Fill/submit: `waitForSelector` **15s** pós-fill.
- Sessão remota (Scrapfly): `timeout=120000` (**120s**) na URL `SCRAPE_BROWSER_WSS`.

---

## 24. CAPTCHA / DataDome / slider

- **Captcha de TOKEN (reCAPTCHA v2 / hCaptcha / Turnstile):** `solveCaptchaIfPresent` (`antiCaptcha.ts`, serviço anti-captcha.com, `ANTICAPTCHA_KEY`). Detecta o widget (sitekey) e injeta o token. Chamado em: `driveTrackingPage` (na entrada), driver da ZIM (pós-submit), e no caminho específico do `scrapeCarrier`.
- **Cloudflare / interstitial anti-bot:** `waitOutChallenge` (espera o desafio resolver — depende do Scrapfly) + `isChallengePage` (detecta Cloudflare/DataDome markers) + retry de sessão nova.
- **DataDome (CMA):** **sem solver** → `scrapeBlocked: true` (curto-circuito em `scrapeCarrier`, **não abre sessão**). Retorna `needsCaptcha:true` + mensagem "use API".
- **Slider CargoSmart (OOCL):** **sem solver** → `scrapeBlocked: true` (mesmo tratamento).
- **hCaptcha da ZIM:** o **solve** funciona (anti-captcha), mas a injeção no React da ZIM **não** registra; `scrapeBlocked: true`.
- **CapSolver / solver de DataDome / slider:** **NÃO IMPLEMENTADO.**

---

## 25–28. Sucesso parcial, falha, múltiplos contêineres, reuso

### 25. Sucesso parcial
- `ok=true` já com `events.length > 0`, **mesmo que as datas de demurrage sejam `null`** (contêiner em trânsito → `dischargeDate/gateOut/emptyReturn = null`). Campo ausente = `null` (nunca inventa).
- Por contêiner, cada data é preenchida **só** quando o evento correspondente existe. Um BL pode ter contêineres com dados diferentes.

### 26. Falha
- `ok=false` + `message`. Sinais: `needsCaptcha` (captcha), `needsLogin` (flag — hoje **não** vira mensagem; o rastreio é público), e detecção de "referência inválida/sem resultado/manutenção" (mensagem honesta).
- Erro de execução (ex.: quota do Scrapfly `ERR::SCRAPE::QUOTA_LIMIT_REACHED`, timeout) → capturado no `try/catch` do `scrapeCarrier` → `ok:false` + `message: "Falha ao consultar o portal: <erro>"`.
- `scrapeBlocked` → `ok:false`, `needsCaptcha:true`, mensagem "Scraping bloqueado … integração via API oficial".

### 27. Consulta por BL → múltiplos contêineres
**SIM.** `deriveContainers` agrupa os eventos por `TrackingEvent.container`; um BL com
vários contêineres devolve **um `ContainerInfo` por contêiner** (ex.: COSCO 2, Evergreen 6).
Quando o portal não expõe por contêiner, cai em 1 contêiner (via `containerHint`/`firstContainerNo`).

### 28. Reuso da mesma resposta por outros módulos
**SIM.** O `TrackingResult` é cacheado no `demurrageBotStore` (disco) e **outros
módulos leem esse cache**:
- `src/routes/demurrageRoutes.ts` (`portalDatesByContainer`) lê `getAllBotResults()` e mescla as **datas do portal por nº de contêiner** nos cards de demurrage (`mergePortalDates`), sem re-raspar.
- `demurrageBotRoutes` `/results` expõe o cache inteiro.
- O cálculo de demurrage (`calcContainer`) consome `dischargeDate`/`availableDate`/`gateOut`/`emptyReturn` que vieram desse cache.

---

## Mapa: consumidor → API de Tracking → Scrapfly/Playwright → armador

```
┌───────────────────────────────────────────────────────────────────────────┐
│ CONSUMIDORES                                                                 │
│  • UI Demurrage (botão "Sincronizar BLs")                                   │
│  • demurrageRoutes.ts (cards: mergePortalDates ← getAllBotResults)          │
│  • Demurrage Engine V2 (outro branch) — alvo desta integração               │
│  • Diagnóstico: /health/track, /health/scrape-sb                            │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │  GET /api/demurrage/bot/enrich | POST /enrich-batch  (auth sessão)
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ API DE TRACKING (fachada)                                                   │
│  demurrageBotRoutes.enrichOne → cache (demurrageBotStore, TTL adaptativo)   │
│     └─ miss/stale → trackShipment(ref)  [carriers/index.ts]                 │
│           1) detectCarrier  2) apiFirst? (Maersk API)                       │
│           3) scrapeCarrier  4) fallback API                                 │
│     └─ trackingMapper → demurrageContainers                                 │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │  scrapeCarrier → withRemotePage → driveTrackingPage
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ PLAYWRIGHT + SCRAPFLY                                                        │
│  connectSB (CDP connectOverCDP ← SCRAPE_BROWSER_WSS = Scrapfly Cloud        │
│  Browser)  →  driveTrackingPage: goto → blockHeavyResources →              │
│  waitOutChallenge → acceptCookies → solveCaptchaIfPresent (anti-captcha) → │
│  driver do host (drivers.ts: ShipmentLink/MSC/ZIM) ou tryFillSearch →      │
│  waitForResults → collectFramesHtml → extractCarrierEvents (dispatch)      │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │  navegação real (residencial + anti-bot do Scrapfly)
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ ARMADORES (portais)                                                         │
│  Raspando: Hapag, Maersk, ONE, COSCO, PIL, HMM, Evergreen, MSC, Yang Ming  │
│  Bloqueado (scrapeBlocked): CMA (DataDome), OOCL (Cloudflare+slider), ZIM  │
│  API oficial: Maersk (se credencial)                                        │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Resumo para a integração (Demurrage Engine V2)
- **Consuma `GET /api/demurrage/bot/enrich?ref=` ou `POST /enrich-batch`** (auth por sessão). Resposta = `shapeEnrich` (§7.3) com `events[]` + `demurrageContainers[]` + flags `cached/resolved`.
- **Datas-chave por contêiner** já normalizadas em `ContainerInfo`: `dischargeDate`, `availableDate`, `gateOut`, `emptyReturn` (ISO ou `null`). `lastFreeDay` sempre `null` (não implementado).
- **Free time / diária / moeda NÃO vêm do Tracking** (vêm do e-mail/Clara).
- **Sem ID de evento estável** e **sem payload bruto persistido** — se a V2 precisar, é item novo a construir (fora deste contrato).
- **Cache é compartilhável** entre módulos (disco, por `refKey`).
