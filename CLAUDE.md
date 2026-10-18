# CLAUDE.md — Priora (contexto para o assistente)

SaaS de logística/comércio exterior em **Node.js + TypeScript (Express)**.
Módulos: e-mail Outlook (Microsoft Graph), IA **Clara** (Gemini), auditoria,
couriers, e o **módulo Demurrage** com um **bot de tracking (Playwright)**.

O norte do bot de tracking + cálculo de demurrage é o
**[blueprint completo em `docs/BLUEPRINT_DEMURRAGE_API.md`](docs/BLUEPRINT_DEMURRAGE_API.md)** —
leia-o para o desenho pretendido. Este arquivo resume o **estado atual** e as
**decisões** onde a implementação difere (de propósito) do blueprint.

## Pipeline-alvo (blueprint §5)
`e-mail (BL) → Clara classifica → bot raspa o portal do armador → eventos → cálculo de demurrage → Clara organiza`

## Estado atual (o que já existe no repo)
- **Playwright** (`playwright@1.56.1`, casa com Chromium 1194) + camada de
  navegador `src/browser/browser.ts` (proxy, stealth básico, `withPage`).
- **Registro de 12 armadores** + detecção BL/contêiner → armador
  (`src/browser/carriers/`), com **scraper da Hapag-Lloyd** (eventos → gate-out/
  devolução). Base plugável (`scraper.ts` despacha p/ scraper específico ou genérico).
  Mapa vivo de cobertura por armador (DOM/comportamento/status): **[docs/ARMADORES_SCRAPING.md](docs/ARMADORES_SCRAPING.md)**.
- **Scraping Browser (Bright Data, CDP)** — navegador remoto que fura Cloudflare
  interativo + renderiza SPA (`src/browser/scrapingBrowser.ts`). Hoje ligado no
  diagnóstico `/health/scrape-sb`; falta plugar no pipeline de produção (ver doc §6).
- **Loop de enriquecimento** (`/api/demurrage/bot/enrich`, `/enrich-batch`):
  track → organiza por IA (texto cru) → **cache** (`demurrageBotStore`) →
  formato do módulo Demurrage (`trackingMapper`). Concorrência via `mapLimit`.
- **Calculadora de demurrage** por faixas (`src/demurrage/calculator.ts` +
  `tariffs.ts`) — reproduz o exemplo do blueprint §6. Endpoint `POST /calc`.
- **Deploy Docker** (`Dockerfile` base Node + `playwright install --with-deps`)
  + `render.yaml` (runtime docker). Diagnóstico: `/health/browser`, `/bot/ip`.
  **Produção = serviço `priora-1`** (Starter pago, 0,5 CPU/512 MB → `REMOTE_BROWSER_MAX=1`),
  criado no painel; o serviço `priora` do `render.yaml` (free) está suspenso.
- Testes de fumaça: `npm run browser:smoke | carriers:detect | carriers:selftest | demurrage:calc`.
- **CI** (`.github/workflows/ci.yml`): typecheck + build + `npm run selftest:all` (descobre
  sozinho todo script `:selftest`) a cada push. Self-test novo = só nomear `xxx:selftest`.
- **Watchdog automático** (`watchdogScheduler.ts`): 1 volta/dia (06:00 UTC), avisa quando
  armador quebra/volta (`WATCHDOG_ALERT_TO`, padrão prioracontato@gmail.com — enviado pelo Gmail da
  Priora com senha de app `WATCHDOG_SMTP_PASS`, reserva = conta Microsoft vinculada; `WATCHDOG_ALERT_WEBHOOK`).
  Status: `/health/watchdog-auto` (diag) e `/api/demurrage/bot/watchdog` (painel).
- **Travas do diagnóstico**: `/health/*` com limite por IP e bloqueio por token errado;
  `?url=` só portais de armador (`diagUrlPolicy.ts`, extra via `DIAG_URL_ALLOW`);
  `/health/fix-login` só com `DIAG_FIX_LOGIN_ENABLED=true`. Login: 10 tentativas/15 min.
- **Line-up dos portos** (`src/ports/`, doc [docs/PORTOS_LINEUP.md](docs/PORTOS_LINEUP.md)): Itapoá e Rio
  Brasil (APIs JSON dos próprios sites; token/chave lidos do JS público em execução, nunca no código)
  e Paranaguá/APPA (HTML; cobre a TCP), Santos Brasil (Tecon Santos/Imbituba/Vila do Conde), BTP, Tecon Rio Grande (Akamai → Scrapfly sem navegador, 1 crédito), Salvador (CODEBA; inclui o Tecon Salvador) e Portonave (JSON `/lineup/list/*` com `x-crypt: false`; o WAF da XLabs só barra a página). `GET /api/ports/*` (login Priora), diag `/health/port-lineup`.
- **Rastreio DHL** (`src/dhl/dhlClient.ts`, API oficial Unified Tracking, `DHL_API_KEY`): fila espaçada
  (`DHL_MIN_INTERVAL_MS`, 5 s da chave grátis), pausa no 429, cache por número (`DHL_CACHE_MIN`; entregue 24 h)
  e última consulta boa como `stale`. Diag `/health/dhl?number=`; uso em `/api/tracking/health`. `npm run dhl:selftest`.
- **Lotes em duas pistas** (`enrichMany`/`mapLanes`): CMA/ZIM (API da Scrapfly) em paralelo
  (`BOT_API_CONCURRENCY`, 3) junto da pista de navegador (`BOT_CONCURRENCY`, 1).

## Decisões / deltas em relação ao blueprint
- **Express (não Fastify):** o blueprint permite Express (§3); o app já é Express
  com login/e-mail/auditoria — migrar seria reescrever tudo. **Mantido Express.**
- **Integrado no Priora (não repo separado):** este repo É o SaaS; o bot vive
  em `/api/demurrage/bot/*`. Auth por **sessão** (não API key), pois é o mesmo app.
- **Fila in-process (confirmado):** TUDO roda num único serviço no Render da
  Priora — sem Redis nem Background Worker. `enrich` síncrono/cacheado.
  (BullMQ+Redis fica como upgrade futuro se o volume exigir.)
- **Stealth manual (não playwright-extra ainda):** args + máscara de webdriver.
- **Eventos:** normalizados no enum do blueprint (`carriers/eventTypes.ts`:
  `berth|discharge|available|gate_out|empty_return|other`).
- **Free time/tarifas (confirmado):** vêm do **e-mail** (Microsoft Graph + Clara),
  NÃO de Excel/SharePoint/Dynamics. A extração de `freeTimeDias`/`diaria`/`moeda`
  já existe no módulo Demurrage. O portal dá as DATAS; o e-mail dá free time/tarifa.
- **Início da contagem (confirmado):** configurável por cliente/contrato
  (descarga x disponibilidade). A calculadora aceita `startDate` arbitrário.
- **Reconciliação (FEITO):** `calcContainer` (demurrageRoutes) inicia a contagem
  pela **descarga do portal** (fallback: disponibilidade → retirada) e expõe
  `inicioContagem`. As datas do portal (descarga/disponib./retirada/devolução)
  entram via `mergePortalDates` — nenhuma é descartada. Free time/diária vêm do
  e-mail (Clara). Cobertura: `npm run reconciliation:selftest`. (Pendente: tornar o
  início configurável POR CLIENTE quando o multi-tenant entrar — hoje é global.)

## Convenções
- TS `strict`. Comentários e mensagens em **pt-BR**.
- **Nunca inventar dados**: campo ausente = `null` (regra da Clara), inclusive nos scrapers.
- Cada armador = um scraper isolado; seletores mudam, cobrir com self-test offline (`setContent`).

## Multi-empresa (workspaces) — norte oficial
Modelo de contas/organizações: **[docs/ARQUITETURA_MULTIEMPRESA.md](docs/ARQUITETURA_MULTIEMPRESA.md)**.
Resumo: a conta operacional pertence ao **workspace da empresa que convidou** o
usuário; **quem determina pertencimento é o admin** (não o Graph). Admin compra/
gerencia plano e convida analistas (convite por e-mail, o analista define a
senha); cada analista conecta o **próprio** Microsoft como fonte de dados. A
Priora agrega por `company_id`; RLS: analista vê `user_id`, gestor vê
`company_id`. Isto **substitui** o MVP de conta Microsoft única quando o
multi-tenant entrar (etapas no doc).

## Decisões confirmadas pelo usuário (§14)
1. Contexto do cliente (free time/tarifas): vem do **e-mail via Graph/Clara**
   (não Excel/SharePoint/Dynamics).
2. Início da contagem: **configurável por cliente/contrato**.
3. Arquitetura/infra: **tudo num único serviço no Render da Priora** (integrado, in-process).

## Ainda em aberto
- Próximos armadores prioritários (Hapag em andamento).
- Provedores de proxy e anti-captcha.
- Extração de BL do e-mail: hoje 100% no SaaS (Clara).
