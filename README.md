# Priora — Integração de e-mail do Outlook (Microsoft Graph)

SaaS em **Node.js + TypeScript (Express)** que integra o e-mail do Outlook /
Microsoft 365 usando a **Microsoft Graph API** com login "Entrar com a
Microsoft" (OAuth2 / MSAL). Permite **listar/ler** e **enviar** e-mails em
nome do usuário autenticado.

## Funcionalidades

- 🔐 Login com a Microsoft (OAuth2 Authorization Code + refresh token silencioso)
- 📥 Listar e ler e-mails da caixa de entrada (`GET /api/emails`, `GET /api/emails/:id`)
- 📤 Enviar e-mails (`POST /api/emails/send`)
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
│   └── graphService.ts      # Chamadas ao Microsoft Graph (listar/ler/enviar)
└── routes/
    └── emailRoutes.ts       # API REST /api/emails
public/
└── index.html               # UI de demonstração
```

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

## Notas de produção

- Use HTTPS (o cookie de sessão já usa `secure` quando `NODE_ENV=production`).
- Troque o armazenamento de sessão padrão (memória) por um store persistente.
- Plugue um `cachePlugin` no MSAL para persistir tokens entre instâncias.
- Para receber novos e-mails em tempo real, adicione **subscriptions/webhooks**
  do Graph (`/subscriptions`) — não incluído neste escopo inicial.
