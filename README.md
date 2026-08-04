# Priora — Integração de e-mail do Outlook (Microsoft Graph)

SaaS em **Node.js + TypeScript (Express)** que integra o e-mail do Outlook /
Microsoft 365 usando a **Microsoft Graph API** com login "Entrar com a
Microsoft" (OAuth2 / MSAL). Permite **listar/ler** e **enviar** e-mails em
nome do usuário autenticado.

## Funcionalidades

- 🔐 Login com a Microsoft (OAuth2 Authorization Code + refresh token silencioso)
- 📥 Listar e ler e-mails da caixa de entrada (`GET /api/emails`, `GET /api/emails/:id`)
- 📤 Enviar e-mails (`POST /api/emails/send`)
- 🚢 **Logística + IA**: filtra e-mails por palavras-chave (embarque, contêiner, courier…)
  e usa o **Google Gemini** para **resumir** e **extrair dados estruturados** de cada conversa
- 🤖 **Clara / Parser (`ParsedEmail`)**: extrai por e-mail tracking, processo Rocket,
  referências externas (`{type,value}`), documentos, resolução do HBL, datas, evidências e confiança
- 🖥️ UI de demonstração em `/`

## Como funciona (arquitetura)

```
src/
├── index.ts                 # App Express, sessão, rotas, error handler
├── config.ts                # Configuração via variáveis de ambiente
├── types.d.ts               # Tipagem da sessão
├── auth/
│   ├── msalClient.ts        # Cliente confidencial do MSAL
│   └── authRoutes.ts        # /auth/login, /auth/callback, /auth/logout
├── middleware/
│   └── requireAuth.ts       # Renova o token e protege as rotas de e-mail
├── graph/
│   └── graphService.ts      # Chamadas ao Microsoft Graph (listar/ler/enviar/buscar)
├── ai/
│   ├── geminiClient.ts      # Cliente Google Gemini (saída estruturada)
│   ├── emailAnalyzer.ts     # Resumo + extração estruturada por conversa
│   └── emailParser.ts       # Parser "Clara" → ParsedEmail (regex + IA)
└── routes/
    ├── emailRoutes.ts       # API REST /api/emails
    ├── analysisRoutes.ts    # API REST /api/analysis (logística + IA)
    └── parseRoutes.ts       # API REST /api/parse (ParsedEmail)
public/
└── index.html               # UI de demonstração
```

### Camada de IA

A análise usa o **Google Gemini** via SDK oficial (`@google/genai`):

- Filtra e-mails de logística com o `$search` do Graph (palavras-chave configuráveis).
- Agrupa por conversa (`conversationId`) e monta a thread em texto puro.
- Envia para o modelo (`gemini-2.5-flash` por padrão) exigindo **saída JSON**
  (`responseJsonSchema` gerado do esquema Zod e validado de volta), garantindo `resumo`,
  `categoria`, `dados` (embarcação, contêiner, BL, portos, datas, valores…) e
  `acoes_pendentes`.

O login usa o fluxo **Authorization Code**. Após o callback, o `homeAccountId`
da conta fica na sessão; a cada requisição protegida, `requireAuth` chama
`acquireTokenSilent`, que renova o access token a partir do refresh token em
cache. O cache do MSAL é em memória (ok para 1 processo) — em produção, plugue
um cache persistente (ex.: Redis) via `cachePlugin`.

## Pré-requisitos: registrar o app no Azure / Entra ID

1. Acesse [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID**
   → **App registrations** → **New registration**.
2. Em **Supported account types**, escolha conforme seu público (ex.:
   "Accounts in any organizational directory and personal Microsoft accounts"
   para usar `AZURE_TENANT_ID=common`).
3. Em **Redirect URI**, selecione **Web** e informe
   `http://localhost:3000/auth/callback`.
4. Após criar, copie o **Application (client) ID** → `AZURE_CLIENT_ID`.
5. Em **Certificates & secrets** → **New client secret**, crie um segredo e
   copie o **Value** → `AZURE_CLIENT_SECRET`.
6. Em **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**, adicione: `User.Read`, `Mail.Read`, `Mail.Send`
   (e `offline_access`). Conceda o consentimento se necessário.

## Configuração e execução

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# edite .env com AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, etc.

# 3. Rodar em desenvolvimento
npm run dev

# ou compilar e rodar
npm run build && npm start
```

Abra `http://localhost:3000`, clique em **Entrar com a Microsoft** e teste.

## API

| Método | Rota                  | Descrição                                   |
| ------ | --------------------- | ------------------------------------------- |
| GET    | `/auth/login`         | Redireciona para o login da Microsoft       |
| GET    | `/auth/callback`      | Callback do OAuth (uso interno)             |
| POST   | `/auth/logout`        | Encerra a sessão                            |
| GET    | `/api/me`             | Estado de autenticação do usuário           |
| GET    | `/api/emails`         | Lista e-mails (`?top=`, `?folder=`, `?search=`, `?filter=`) |
| GET    | `/api/emails/:id`     | Detalhe de um e-mail                        |
| POST   | `/api/emails/send`    | Envia um e-mail                             |
| GET    | `/api/analysis/emails` | E-mails de logística agrupados por conversa (`?top=`) |
| POST   | `/api/analysis/conversations/:conversationId` | Analisa uma conversa com IA (resumo + dados) |
| POST   | `/api/parse/messages/:id` | Parseia UM e-mail → `ParsedEmail` |
| POST   | `/api/parse/conversations/:conversationId` | Parseia todos os e-mails da thread → `ParsedEmail[]` |

### Parser da Clara (`ParsedEmail`)

`POST /api/parse/messages/:id` busca o e-mail completo no Graph e devolve:

```jsonc
{
  "emailId": "AAMk...",
  "internetMessageId": "<...@...>",
  "conversationId": "AAQk...",
  "subject": "...", "from": "...", "to": ["..."], "cc": ["..."],
  "sentDateTime": "...", "receivedDateTime": "...",
  "attachments": [{ "name": "OMBL.pdf", "contentType": "application/pdf" }],
  "tracking": [{ "carrier": "FedEx", "number": "871089761136" }],
  "processNumbers": ["IM1578"],
  "externalReferences": [{ "type": "container", "value": "MSKU1234567" },
                         { "type": "unknown", "value": "SHYY26041185" }],
  "documents": ["OMBL", "Invoice"],
  "hblResolution": "Telex Release",
  "carrier": "FedEx",
  "dates": [{ "text": "Posted on Apr.27", "normalized": "2026-04-27" }],
  "evidences": [{ "conclusion": "OMBL esperado", "snippet": "...we sent Original MBL via FEDEX..." }],
  "confidence": 0.86
}
```

**Como funciona:** processo Rocket (`IMxxxx`) e container (ISO 6346) saem por
**regex** (garantia). O restante — carrier/tracking, `externalReferences` sem
assumir o tipo, documentos, resolução do HBL, datas relativas, evidências e
confiança — sai do **Gemini** com saída JSON validada por esquema Zod.
Os dois resultados são mesclados e deduplicados.

Exemplo de envio:

```bash
curl -X POST http://localhost:3000/api/emails/send \
  -H "Content-Type: application/json" \
  --cookie "connect.sid=..." \
  -d '{
    "to": ["alguem@exemplo.com"],
    "subject": "Olá do Priora",
    "body": "Mensagem de teste",
    "contentType": "Text"
  }'
```

## Bot de Demurrage (Playwright) — base

O módulo Demurrage já monta a aba a partir do Outlook + IA (Clara). Para
buscar os dados **na origem** (free time, datas de retirada/devolução e
diárias nos portais de armadores/terminais), o projeto usa o **Playwright**
(Node.js) — com suporte a **proxy** e, adiante, **resolução de CAPTCHA**.

Estrutura entregue:

```
src/browser/
├── browser.ts            # getBrowser / newContext / withPage / closeBrowser (+ proxy)
├── smoke.ts              # teste de fumaça: sobe o Chromium, renderiza HTML e roda JS
└── carriers/
    ├── registry.ts       # 12 armadores (URLs, deep links, prefixos p/ detecção)
    ├── detect.ts         # detecta o armador (contêiner/BL) + valida ISO 6346
    ├── pageUtils.ts      # cookies/login/captcha/preenchimento compartilhados
    ├── scraper.ts        # despacho: scraper específico do armador ou o genérico
    ├── scrapers/
    │   ├── hapag.ts          # scraper da Hapag-Lloyd (eventos + gate-out/devolução)
    │   └── hapagSelftest.ts  # self-test offline da extração (via setContent)
    ├── index.ts          # fachada: listCarriers / detect / trackShipment
    └── detectCli.ts      # CLI/teste de detecção (sem rede)
```

**Hapag-Lloyd** é o primeiro portal com scraper específico: extrai os eventos
de movimentação do rastreio público e deriva a **retirada (gate-out)** e a
**devolução do vazio** — as datas que a aba Demurrage precisa. O `last free
day`/valor exige login no portal comercial (fica `null`, próxima etapa).

Armadores no registro: **Maersk, ONE, Yang Ming, MSC, PIL, Evergreen, HMM,
CMA CGM, ZIM, Hapag-Lloyd, COSCO, OOCL**.

```bash
# instala o Playwright + navegador (no CI/Render: npx playwright install chromium)
npm install

# valida que o navegador sobe neste ambiente
npm run browser:smoke        # -> [smoke] ✅ Playwright + Chromium OK

# valida a detecção de armador (sem rede)
npm run carriers:detect      # amostra dos 12 armadores
npm run carriers:detect -- HLCUSHA2606GIPM7

# valida a lógica de extração da Hapag (offline, via HTML de teste)
npm run carriers:selftest
```

Rodar o rastreio **ao vivo** (precisa de acesso à internet — Render, ou local
com rede/proxy; o build isolado não alcança os portais):

```bash
# no servidor, autenticado, com o Chromium instalado:
curl "http://localhost:3000/api/demurrage/bot/track?ref=HLCUSHA2606GIPM7" --cookie "connect.sid=..."
```

### Deploy no Render (Docker) e teste do proxy

Os portais bloqueiam IP de datacenter (a Hapag devolve **403** para requisições
sem navegador/IP residencial). Por isso o rastreio ao vivo roda em **Docker**
(imagem oficial do Playwright, com Chromium + libs) e, na prática, atrás de um
**proxy residencial**.

1. No Render, o Blueprint já usa o `Dockerfile` (runtime Docker) — faça o deploy da branch.
2. Cadastre o proxy no painel do Render (Environment):
   - `PROXY_SERVER` = `http://host:porta` (ou `socks5://host:porta`)
   - `PROXY_USERNAME` / `PROXY_PASSWORD` (se autenticado)
3. Confirme que o navegador sai pelo proxy:
   ```
   GET /api/demurrage/bot/ip
   -> { "proxyConfigured": true, "exitIp": "<IP do proxy>", ... }
   ```
   Se `exitIp` for o IP do proxy (não o do Render), o proxy está ativo.
4. Rode o rastreio: `GET /api/demurrage/bot/track?ref=HLCUSHA2606GIPM7`.

Observações: o plano free do Render (512 MB) é apertado para o Chromium — se
houver OOM, suba de plano para testes intensos. O self-test cobre a lógica de
extração; o run ao vivo confirma os seletores reais da Hapag.

Rotas (protegidas por login, sob `/api/demurrage/bot`):

| Método | Rota        | Descrição                                             |
| ------ | ----------- | ----------------------------------------------------- |
| GET    | `/status`   | O que está configurado (proxy, anti-captcha, nº de armadores) |
| GET    | `/carriers` | Lista dos armadores suportados                        |
| GET    | `/detect?ref=` | Detecta o armador de uma referência (sem browser)  |
| GET    | `/track?ref=[&carrier=][&type=]` | Sobe o Chromium e consulta o portal |

Uso na camada de scraping (próximas etapas — login, CAPTCHA e extração por portal):

```ts
import { trackShipment, detect } from './browser/carriers';

detect('MSKU0439695');            // { carrier: { id: 'maersk' }, referenceType: 'container', ... }
await trackShipment('MSKU0439695'); // sobe o Chromium, consulta o portal do armador
```

Configuração (ver `.env.example`): `BROWSER_HEADLESS`, `PROXY_SERVER`
/`PROXY_USERNAME`/`PROXY_PASSWORD`, `ANTICAPTCHA_PROVIDER`/`ANTICAPTCHA_KEY`.
No Render, o build baixa o Chromium (`npx playwright install chromium`); quando
os scrapers forem ligados, o runtime Docker (imagem `mcr.microsoft.com/playwright`)
passa a ser recomendado por já trazer as bibliotecas de sistema do navegador.

## Notas de produção

- Use HTTPS (o cookie de sessão já usa `secure` quando `NODE_ENV=production`).
- Troque o armazenamento de sessão padrão (memória) por um store persistente.
- Plugue um `cachePlugin` no MSAL para persistir tokens entre instâncias.
- Para receber novos e-mails em tempo real, adicione **subscriptions/webhooks**
  do Graph (`/subscriptions`) — não incluído neste escopo inicial.
