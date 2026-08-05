# Blueprint — Sistema de Tracking + Cálculo de Demurrage

> Documento de especificação para implementação assistida (Claude Code).
> Objetivo: construir a **API de scraping/tracking** e o **módulo de cálculo de
> demurrage** que se integram ao SaaS (Priora + Clara IA) e ao ecossistema Microsoft.

---

## 1. Objetivo do sistema

Automatizar o pipeline: **email com número de BL → identificação do armador →
scraping do site do armador → dados de container/atracação → cálculo de demurrage
→ organização por IA**.

Este repositório cobre principalmente **a API de tracking/scraping** e o
**módulo de demurrage**. As camadas de IA (Clara) e a ingestão de email vivem
no SaaS; aqui expomos os contratos de integração.

---

## 2. Escopo deste repositório

| Componente | Neste repo? |
|---|---|
| API HTTP (recebe BL + armador, devolve tracking) | ✅ Sim |
| Worker de scraping Playwright (por armador) | ✅ Sim |
| Fila de jobs (assíncrono) | ✅ Sim |
| Integração proxy + anti-captcha | ✅ Sim |
| Módulo de cálculo de demurrage | ✅ Sim |
| Integração Microsoft Graph (contexto do cliente) | ✅ Sim (client) |
| Parser de email / extração de BL | ⬜ Opcional (endpoint auxiliar) |
| Classificação BL→armador por IA (Clara) | ⬜ Não (fica no SaaS) |

---

## 3. Stack fixada

- **Runtime:** Node.js 20 LTS + TypeScript
- **Framework HTTP:** Express (ou Fastify — escolher Fastify por performance)
- **Automação:** Playwright (Chromium) + `playwright-extra` + plugin stealth
- **Fila:** BullMQ + Redis
- **Proxy:** pool de proxies residenciais rotativos (config por env)
- **Anti-captcha:** CapSolver / 2Captcha / Anti-Captcha (adapter plugável)
- **Microsoft:** `@microsoft/microsoft-graph-client` + `@azure/identity`
- **Validação:** Zod
- **Deploy:** Render (Web Service + Background Worker + Redis)
- **Testes:** Vitest
- **Logs:** Pino

---

## 4. Estrutura de pastas proposta

```
demurrage-api/
├── src/
│   ├── api/
│   │   ├── server.ts              # bootstrap HTTP
│   │   ├── routes/
│   │   │   ├── tracking.route.ts
│   │   │   ├── health.route.ts
│   │   │   └── webhook.route.ts
│   │   └── middleware/
│   │       ├── auth.ts            # API key / bearer entre SaaS e API
│   │       └── validate.ts       # Zod
│   ├── queue/
│   │   ├── connection.ts          # Redis
│   │   ├── tracking.queue.ts
│   │   └── tracking.worker.ts
│   ├── scrapers/
│   │   ├── base.scraper.ts        # contrato comum
│   │   ├── registry.ts            # armador → scraper
│   │   ├── maersk.scraper.ts
│   │   ├── msc.scraper.ts
│   │   ├── hapag.scraper.ts
│   │   └── ...                    # um por armador
│   ├── infra/
│   │   ├── browser.ts             # factory Playwright + proxy + stealth
│   │   ├── proxy.pool.ts          # rotação
│   │   └── captcha/
│   │       ├── captcha.adapter.ts # interface
│   │       └── capsolver.ts
│   ├── demurrage/
│   │   ├── calculator.ts          # lógica de faixas
│   │   ├── tariffs.ts             # tabelas por armador
│   │   └── types.ts
│   ├── microsoft/
│   │   ├── graph.client.ts        # auth + client
│   │   └── client-context.ts      # busca free time / tarifas do cliente
│   ├── shared/
│   │   ├── types.ts               # contratos normalizados
│   │   ├── bl.ts                  # validação/máscara de BL
│   │   └── logger.ts
│   └── index.ts
├── tests/
├── .env.example
├── render.yaml                    # infra as code do Render
├── Dockerfile                     # (opcional, Playwright)
├── package.json
├── tsconfig.json
└── CLAUDE.md                      # este blueprint resumido p/ contexto
```

---

## 5. Fluxo de dados (end-to-end)

```
EMAIL ──▶ [SaaS: parser + Clara IA classifica BL→armador]
              │
              ▼  POST /tracking  { bl, carrier, clientId, callbackUrl }
        ┌───────────────┐
        │  NOSSA API    │  202 + jobId
        └──────┬────────┘
               ▼ enfileira
        ┌───────────────┐
        │  WORKER       │  Playwright + proxy + captcha
        │  scraper[carrier]
        └──────┬────────┘
               ▼ eventos normalizados
        ┌───────────────┐
        │  DEMURRAGE    │◀── Microsoft Graph (free time, tarifas, contexto cliente)
        │  calculator   │
        └──────┬────────┘
               ▼ resultado
        webhook callbackUrl  +  GET /tracking/:jobId
               │
               ▼
        [SaaS: Clara IA — organização/priorização final]
```

---

## 6. Contratos da API

### `POST /tracking`
Cria um job de rastreio. Assíncrono.

**Request**
```json
{
  "bl": "MAEU123456789",
  "carrier": "MAERSK",
  "clientId": "cli_001",
  "callbackUrl": "https://saas.priora/webhooks/tracking"
}
```

**Response `202`**
```json
{ "jobId": "uuid", "status": "queued" }
```

### `GET /tracking/:jobId`
```json
{
  "jobId": "uuid",
  "status": "done",            // queued | running | done | failed
  "bl": "MAEU123456789",
  "carrier": "MAERSK",
  "containers": ["MRKU1112223"],
  "events": [
    { "type": "berth",     "location": "Santos", "date": "2026-07-18T06:00:00Z" },
    { "type": "discharge", "location": "Santos", "date": "2026-07-20T14:00:00Z" },
    { "type": "gate_out",  "location": "Santos", "date": "2026-07-28T09:00:00Z" }
  ],
  "demurrage": {
    "startDate": "2026-07-20T14:00:00Z",
    "freeTimeDays": 7,
    "returnDate": "2026-07-28T09:00:00Z",
    "daysOverdue": 1,
    "currency": "USD",
    "total": 120.00,
    "breakdown": [ { "day": 1, "tier": "1-5", "rate": 120.00 } ]
  }
}
```

### `POST /webhook/result` (saída para o SaaS)
A API faz `POST` no `callbackUrl` com o mesmo payload do `GET` acima quando o job termina.

### `GET /health`
Render precisa disso. Retorna `200 { "status": "ok" }`.

**Autenticação entre SaaS e API:** header `Authorization: Bearer <API_KEY>`.

---

## 7. Contrato do scraper (base)

Todo scraper de armador implementa:

```typescript
interface ScraperResult {
  containers: string[];
  events: TrackingEvent[];   // type, location, date (ISO)
  raw?: unknown;             // payload bruto p/ debug
}

interface CarrierScraper {
  carrier: string;
  supports(bl: string): boolean;          // valida máscara/prefixo
  scrape(bl: string, ctx: BrowserContext): Promise<ScraperResult>;
}
```

`registry.ts` mapeia `carrier → CarrierScraper`. Se `carrier` não existe →
job falha com erro claro (`UNSUPPORTED_CARRIER`).

**Eventos normalizados (enum `type`):** `berth` (atracação), `discharge`
(descarga), `available` (disponibilidade), `gate_out`, `empty_return`.

---

## 8. Módulo Demurrage

### Entradas
- `startDate` — início da contagem (descarga ou disponibilidade, conforme regra do cliente).
- `returnDate` — devolução do container (gate_out / empty_return).
- `freeTimeDays` — **vem do contexto do cliente na Microsoft** (não do site).
- `tariffTable` — faixas por armador (ex.: dias 1–5, 6–10, 11+).

### Lógica
```
diasCorridos   = ceil(returnDate - startDate) em dias
diasExcedentes = max(0, diasCorridos - freeTimeDays)
total = soma, para cada dia excedente, da tarifa da faixa correspondente
```

### Tabela de tarifas (exemplo de shape)
```typescript
type Tier = { fromDay: number; toDay: number | null; rate: number };
type TariffTable = { carrier: string; currency: string; tiers: Tier[] };
```

As tarifas e o free time podem ser **por cliente + armador** — buscar via Graph.

---

## 9. Integração Microsoft Graph

- **Auth:** OAuth2 client credentials (app registrada no Entra ID).
  Env: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.
- **Uso:** buscar contexto do cliente (free time contratado, tarifas negociadas).
- **Onde estão os dados:** DEFINIR — SharePoint list, Excel no OneDrive, ou Dynamics.
  O `client-context.ts` deve abstrair a fonte atrás de:
  ```typescript
  getClientContext(clientId: string): Promise<{
    freeTimeDays: number;
    tariffTable: TariffTable;
  }>;
  ```

> ⚠️ Ponto aberto: confirmar a fonte exata (Excel/SharePoint/Dynamics) antes de
> implementar as chamadas Graph concretas.

---

## 10. Infra Playwright + Render

### Browser factory
- `playwright-extra` + `puppeteer-extra-plugin-stealth` (compatível).
- Proxy por contexto: `browser.newContext({ proxy: { server, username, password } })`.
- User-agent e viewport randomizados; delays humanos entre ações.

### Proxy pool
- Lista de proxies via env (`PROXY_LIST` separada por vírgula) ou provedor com endpoint rotativo único.
- Rotação por job; marcar proxy como “ruim” em caso de bloqueio.

### Anti-captcha
- Interface `CaptchaAdapter.solve({ type, sitekey, url }) → token`.
- Suportar reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.
- Injetar token no campo/callback esperado pela página.

### Render
- **Web Service** = API HTTP.
- **Background Worker** = worker BullMQ (scraping). Separado, para não estourar timeout HTTP.
- **Redis** = Render Key Value ou Upstash.
- Build command instala Chromium:
  `npm ci && npx playwright install --with-deps chromium && npm run build`
- Considerar **Dockerfile** com as libs do sistema para o Chromium rodar estável.

---

## 11. Variáveis de ambiente (`.env.example`)

```
# API
PORT=3000
API_KEY=change-me                 # bearer SaaS ↔ API

# Redis / Fila
REDIS_URL=redis://localhost:6379

# Proxy
PROXY_LIST=host1:port:user:pass,host2:port:user:pass
# ou provedor rotativo:
PROXY_ROTATING_URL=

# Anti-captcha
CAPTCHA_PROVIDER=capsolver
CAPTCHA_API_KEY=

# Microsoft Graph
MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=

# Runtime
LOG_LEVEL=info
MAX_CONCURRENCY=2                 # jobs Playwright paralelos (memória!)
```

---

## 12. Confiabilidade

- **Retry:** BullMQ com backoff exponencial (3 tentativas). Troca de proxy a cada retry.
- **Timeout:** limite por job (ex.: 90s); mata o contexto do browser ao exceder.
- **Concorrência:** `MAX_CONCURRENCY` baixo — Chromium consome muita RAM no Render.
- **Selectors versionados:** sites de armador mudam layout; isolar selectors por scraper e cobrir com testes de smoke.
- **Idempotência:** mesmo BL+carrier em janela curta pode reusar resultado em cache.
- **Observabilidade:** logs estruturados (Pino) com `jobId`, `carrier`, `bl` mascarado.

---

## 13. Ordem de implementação sugerida (para o Claude Code)

1. **Scaffold:** TypeScript + estrutura de pastas + `package.json` + `tsconfig` + lint.
2. **Shared:** tipos normalizados (`shared/types.ts`), validação de BL, logger.
3. **API base:** Fastify + rotas `/health` e `/tracking` (Zod) + auth bearer.
4. **Fila:** Redis + BullMQ (`tracking.queue.ts`, `tracking.worker.ts`).
5. **Browser infra:** `browser.ts` (stealth + proxy), `proxy.pool.ts`.
6. **Captcha adapter:** interface + implementação CapSolver.
7. **Scraper base + registry** e **1 scraper piloto** (ex.: Maersk) end-to-end.
8. **Módulo demurrage:** `calculator.ts` + `tariffs.ts` + testes unitários.
9. **Microsoft Graph:** `graph.client.ts` + `client-context.ts` (mock primeiro).
10. **Integração final:** worker chama scraper → demurrage → webhook + `GET`.
11. **Render:** `render.yaml`, build command, Dockerfile (se necessário).
12. **Mais scrapers de armador**, um a um, com testes de smoke.

---

## 14. Pontos abertos a confirmar com você

1. **Fonte do contexto do cliente na Microsoft:** Excel? SharePoint list? Dynamics 365?
2. **Início da contagem de demurrage:** descarga ou disponibilidade? (varia por contrato)
3. **Lista de armadores prioritários** para os primeiros scrapers.
4. **Provedor de proxy e de anti-captcha** já contratados? Quais?
5. **Extração de BL do email** entra neste repo (endpoint) ou fica 100% no SaaS?
6. **Free time/tarifas:** sempre por cliente, ou existe default por armador?

---

*Blueprint pronto para anexar no Claude Code. Comece pela seção 13 (ordem de
implementação) e mantenha este arquivo como `CLAUDE.md` na raiz do projeto para
dar contexto contínuo ao assistente.*
