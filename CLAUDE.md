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
- **Loop de enriquecimento** (`/api/demurrage/bot/enrich`, `/enrich-batch`):
  track → organiza por IA (texto cru) → **cache** (`demurrageBotStore`) →
  formato do módulo Demurrage (`trackingMapper`). Concorrência via `mapLimit`.
- **Calculadora de demurrage** por faixas (`src/demurrage/calculator.ts` +
  `tariffs.ts`) — reproduz o exemplo do blueprint §6. Endpoint `POST /calc`.
- **Deploy Docker** (`Dockerfile` base Node + `playwright install --with-deps`)
  + `render.yaml` (runtime docker). Diagnóstico: `/health/browser`, `/bot/ip`.
- Testes de fumaça: `npm run browser:smoke | carriers:detect | carriers:selftest | demurrage:calc`.

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
- **TODO de modelo:** reconciliar o cálculo por `dataRetirada` (calcContainer em
  demurrageRoutes) com a calculadora por faixas (`calculator.ts`) — decidir com
  dados reais qual evento inicia a contagem por cliente.

## Convenções
- TS `strict`. Comentários e mensagens em **pt-BR**.
- **Nunca inventar dados**: campo ausente = `null` (regra da Clara), inclusive nos scrapers.
- Cada armador = um scraper isolado; seletores mudam, cobrir com self-test offline (`setContent`).

## Decisões confirmadas pelo usuário (§14)
1. Contexto do cliente (free time/tarifas): vem do **e-mail via Graph/Clara**
   (não Excel/SharePoint/Dynamics).
2. Início da contagem: **configurável por cliente/contrato**.
3. Arquitetura/infra: **tudo num único serviço no Render da Priora** (integrado, in-process).

## Ainda em aberto
- Próximos armadores prioritários (Hapag em andamento).
- Provedores de proxy e anti-captcha.
- Extração de BL do e-mail: hoje 100% no SaaS (Clara).
