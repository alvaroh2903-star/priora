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
- **Fila in-process (não BullMQ+Redis ainda):** o `enrich` é síncrono/cacheado.
  BullMQ+Redis (blueprint §3/§10) é upgrade — custa Redis + worker no Render.
- **Stealth manual (não playwright-extra ainda):** args + máscara de webdriver.
- **Eventos:** hoje `status` livre; alinhar ao enum do blueprint
  (`berth|discharge|available|gate_out|empty_return`) é um TODO.
- **Free time/tarifas:** o portal dá só datas; free time/diária vêm do e-mail
  (Clara) e, no futuro, do **contexto do cliente na Microsoft** (§9, fonte a definir).

## Convenções
- TS `strict`. Comentários e mensagens em **pt-BR**.
- **Nunca inventar dados**: campo ausente = `null` (regra da Clara), inclusive nos scrapers.
- Cada armador = um scraper isolado; seletores mudam, cobrir com self-test offline (`setContent`).

## Pontos abertos (blueprint §14 — confirmar com o usuário)
1. Fonte do contexto do cliente na Microsoft (Excel/SharePoint/Dynamics).
2. Início da contagem: descarga (`discharge`) ou disponibilidade (`available`).
3. Próximos armadores prioritários (Hapag já em andamento).
4. Provedores de proxy e anti-captcha.
5. Extração de BL do e-mail: aqui ou 100% no SaaS (hoje: Clara no SaaS).
6. Free time/tarifas por cliente vs default por armador.
