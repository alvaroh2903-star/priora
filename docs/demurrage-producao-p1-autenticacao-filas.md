# Produção P1 — Autenticação, identidade operacional, atribuição e filas pessoais (entrega corretiva)

> Entrega **corretiva**, só backend. Não congela nada e **não declara a Production P1 concluída**.
> Frontend, HTML, CSS, JavaScript de apresentação e design: **intocados** (§17).
> Fora desta entrega (não iniciados): administração tarifária, armazenamento definitivo dos arquivos de minuta, frontend/design.
> O handoff HMAC (contrato assinado, idempotência e controle de capacidade) **não foi modificado** (§12).

## Sumário

1. Baseline
2. Diagnóstico do modelo global antigo (Etapa 1 — os 10 itens)
3. Arquitetura de sessão escolhida
4. Modelo de ameaça
5. Migration 0049 (aditiva)
6. Contrato `/api/me`
7. Seleção de organização
8. Provisionamento
9. Atribuição
10. Matriz de filas e ações por papel
11. Autorização real das ações (Etapa 7)
12. Compatibilidade
13. Implantação (ordem obrigatória)
14. Testes e totais
15. Revisões adversariais
16. Riscos remanescentes
17. Confirmação: frontend e design intocados

---

## 1. Baseline

| Item | Valor |
|---|---|
| Branch | `claude/practical-cerf-mnz7oj` |
| Commit de partida | `ddc43db` (correção de minuta/encerramento), limpo e igual ao remoto |
| Última migration no baseline | `0048_minuta_aceite_tecnico_encerramento_automatico.sql` |
| Versões instaladas | Express 4.22.2, express-session 1.19.0, @azure/msal-node 2.16.3 (msal-common 14.16.1), node-pg, PostgreSQL 16 |

## 2. Diagnóstico do modelo global antigo (Etapa 1)

Feito somente leitura sobre `ddc43db`, com seis leitores independentes e uma crítica de completude que reconferiu cada citação contra `HEAD`.

**Quatro conceitos que o código antigo misturava** (e que agora ficam separados — §3):
sessão humana da aplicação · credencial de integração com a Microsoft · credencial HMAC do handoff · organização ativa do usuário.

### 2.1 Como o login Microsoft funcionava
- `GET /auth/login`: `state` = `nonce.timestamp.HMAC(SESSION_SECRET)` **sem vínculo com o navegador**, sem PKCE, sem `nonce` OIDC, reutilizável por 15 min (sem armazenamento de uso único) → **login CSRF possível**.
- `GET /auth/callback`: `acquireTokenByCode` no cliente MSAL **compartilhado** (os tokens da pessoa entravam no cache global) → `connectMicrosoftAccount(homeAccountId)` (a pessoa virava **a conta ativa global**) → `req.session.homeAccountId/username`. Sem `session.regenerate()` (fixação de sessão), sem checagem de usuário provisionado/membership.
- Tenant `common` sem allowlist: qualquer conta Microsoft que concluísse o login virava a conta global.

### 2.2 Onde ficavam a conta ativa e os tokens
- **Conta ativa**: variável de módulo em `activeAccount.ts` (cópia em memória lida UMA vez no boot) + linha única `msal_conta_ativa (id='default')` (0027) ou `.data/active-account.json` (sem banco, texto claro).
- **Tokens MSAL**: um único blob para TODAS as contas — `msal_cache_criptografado (id='default')` cifrado AES-256-GCM (com `PRIORA_TOKEN_CACHE_KEY`), ou `.data/msal-cache.json` em texto claro, ou só memória (chave ausente/inválida).
- **Sessões**: `FileSessionStore` — um JSON em texto claro por sessão em `.data/sessions`, local à instância (não compartilhado; perdido em cada reinício do plano free do Render), cookie padrão `connect.sid`, 30 dias deslizantes.

### 2.3 Como `requireAuth` identificava o usuário
Comparava `req.session.homeAccountId` com a **conta ativa global em memória**; diferente → 401 "A conta Microsoft foi trocada"; igual → `acquireTokenSilent` da conta global → `req.accessToken`. Não havia usuário Priora, organização nem papel nesse caminho; a V2 (`autorizarInterno`) resolvia depois `home_account_id → usuarios → memberships`, escolhendo a única organização (ou 409).

### 2.4 Por que um novo login substituía a conta anterior
`connectMicrosoftAccount` tratava qualquer conta diferente da em memória como **troca**: avançava a geração do cache durável, **removia todas as outras contas do cache MSAL**, apagava stores de courier/demurrage e gravava a nova como conta ativa global. A sessão da pessoa anterior continuava existindo, mas o `requireAuth` passava a recusá-la (401) e `/api/me` respondia `authenticated:false` — um único "usuário atual" por processo. Em várias instâncias, a cópia em memória desatualizada ainda podia pular a limpeza e deixar tokens da conta substituída no cache.

### 2.5 O que o logout fazia
`POST /auth/logout` — **igual com ou sem sessão**, sem checagem de autenticação nem de origem: `disconnectMicrosoftAccount()` (geração +1, remoção de TODAS as contas MSAL, stores apagados, conta ativa limpa) e `session.destroy()` sem `clearCookie`. Efeito: **um POST anônimo (inclusive de outro site — logout CSRF) desconectava todo mundo**. Os links "Sair" do frontend apontavam para a página estática `Login.dc.html` e não encerravam a sessão.

### 2.6 Modelo de usuários, organizações e memberships
`organizations (id, nome, slug)`, `usuarios (id, nome, email UNIQUE, home_account_id UNIQUE NULL)`, enum `organization_role` = `ANALYST | MANAGER | ADMIN | CLIENT`, `organization_memberships (id, organization_id, usuario_id, papel, cliente_id)` com `UNIQUE(organization_id, usuario_id)` e FKs compostas `(id, organization_id)` usadas por responsável, autores de decisão, minutas etc. Responsável operacional = `processos.responsavel_operacional_membership_id` (0006; trigger 0007 barra CLIENT). **Nenhuma** coluna de ativação/desativação; **nenhum** código de produção criava usuário ou membership (só os testes).

### 2.7 Como os papéis se ligavam aos memberships
Um papel por membership (por organização). `autorizarInterno` aceitava ANALYST/MANAGER/ADMIN e recusava CLIENT (403); MANAGER/ADMIN eram exigidos dentro dos serviços (responsabilidade, autorizar reabertura, finalizar). ANALYST podia ler TODA a organização e executar minuta, pendência, fallback e solicitar reabertura em QUALQUER processo — não havia "minha fila" (a constante de contrato era `escopo: 'fila_da_equipe'`).

### 2.8 Microsoft como identidade × Microsoft como integração
- **Identidade humana**: só `session.homeAccountId`/`username` (o login).
- **Integração** (Graph, caixa postal): rotas V1 (`/api/emails`, `/api/analysis`, `/api/parse`, `/api/processes`, `/api/couriers`, `/api/demurrage` V1, `/api/auditoria`, `/api/captura`), os quatro transportes de aviso por e-mail (`alertTransportGraph`, `avisoPendencia…`, `avisoDivergencia…`, `avisoFallbackManual…`) e a captura de pré-alerta — todos usando a conta ativa global. A V2 (leituras/ações/gestão) passava pelo mesmo `requireAuth` (e, portanto, por `acquireTokenSilent`) sem usar Graph.

### 2.9 Infraestrutura de sessão reutilizável
`express-session` (já presente) reaproveitado; o `FileSessionStore` não (texto claro, local, corrida de `touch`/`destroy` que ressuscitava sessão encerrada). Reaproveitados: `usuarios.home_account_id`, memberships, `autorizarInterno` (organização nunca vem da requisição), o ledger de observações (`field_observations` + `processo_campos_selecionados`) para o responsável e o lock consultivo por processo (`lockProcesso`).

### 2.10 Rotas fora da Demurrage dependentes do comportamento global
Todas as rotas V1 acima (+ `/api/tracking`, que não usa Graph) e os jobs de fundo (avisos e captura). Testes congelados que codificavam o modelo de conta única: `capturaPreAlerta.test.ts` (`conta_da_sessao_nao_corresponde_a_caixa`), `tokenCacheDuravel.test.ts` (geração), harnesses que simulam `req.session = { homeAccountId }`.

## 3. Arquitetura de sessão escolhida

| Conceito | Onde vive agora | Quem usa |
|---|---|---|
| **Sessão humana** | `express-session` + store PostgreSQL `sessoes_humanas` (0049); cookie `__Host-priora.sid` (produção) / `priora.sid` (HTTP local) | toda rota humana |
| **Identidade** | `usuarios` (vínculo Microsoft = `home_account_id`), resolvida **a cada requisição** a partir de `session.usuarioId` + conferência do `home_account_id` | `requireSessao` → `req.identidade` |
| **Organização ativa** | `session.organizacaoAtivaId` **somente quando escolhida explicitamente**; senão a única organização interna ativa, resolvida na requisição; revalidada sempre contra membership interno ATIVO | `autorizarInterno` → `req.autorizacao` |
| **Integração Microsoft** | singleton existente `msal_conta_ativa` + cache MSAL durável (inalterados), relido do banco a cada requisição V1 | V1, avisos, captura |
| **Handoff M2M** | HMAC próprio (inalterado), montado antes da sessão e da checagem de origem | `/api/integracoes/demurrage/handoff/processos` |

Nenhuma variável de módulo representa "o usuário atual" (`requireSessao`, `autorizarInterno`, `/api/me` e o guard V1 leem só `req.session` + banco).

### 3.1 Login de pessoa (`GET /auth/login` → `GET /auth/callback`)
- Cliente MSAL **descartável por login**, escopo `User.Read`, `prompt=select_account`; os tokens da pessoa são descartados com o objeto (nunca entram no cache compartilhado nem vão ao frontend). Falha da Microsoft na troca do código → página de erro (`502`), nunca `500` cru; só o código do erro vai a log.
- PKCE S256 + `state` aleatório + `nonce` OIDC (conferido contra as claims do id_token — a msal-node só confere quando o nonce é passado).
- Transação OAuth em cookie próprio **assinado** (HMAC com chave derivada do `SESSION_SECRET`), HttpOnly, SameSite=Lax, `__Host-priora.oauth` em produção, Path=/, validade de 10 min **dentro do valor assinado**, **uso único** (apagado em todo desfecho). Mesmo `redirect_uri` já registrado no Azure (o propósito `login|integracao` vai na transação).
- O callback valida a transação **antes** de qualquer coisa; o texto de erro da Microsoft (`error_description`) **nunca** é exibido (texto fixo por código).
- Conta sem vínculo → página "Conta não provisionada" (mostra à própria pessoa o identificador `oid.tid` para o provisionamento; nada vai a log); sem membership interno ativo → "Acesso não autorizado". Nenhuma sessão é criada nesses casos.
- `req.session.regenerate()` (anti-fixação: o identificador anterior deste navegador, inclusive um plantado, é revogado) → grava só `{versao:2, usuarioId, homeAccountId, username, nome, autenticadoEm, organizacaoAtivaId:null}`.
- **Nunca** chama `connectMicrosoftAccount`: login de pessoa não troca, renova nem desconecta a integração.
- Administrador de plataforma com integração ausente (ou a própria, sem renovar token) → encadeia `/auth/integracao/conectar?automatico=1`.

### 3.2 Integração Microsoft (`/auth/integracao/*`)
- Só sessão válida de `usuarios.administrador_plataforma` **com membership interno ativo**, revalidada também no callback (que pode chegar 10 min depois) e vinculada ao `usuarioId` que iniciou.
- `GET /auth/integracao/conectar` (re)conecta a MESMA conta e não tem efeito colateral até o callback. **Trocar a conta conectada por outra exige confirmação explícita por `POST` da própria origem**: `GET ?substituir=1` só mostra uma página de confirmação (nenhuma transação é criada — um link ou navegação de outro site nunca inicia a troca); o formulário faz `POST /auth/integracao/conectar` (`substituir=1`), coberto pela checagem de origem.
- Sem substituição, a conta que a integração TEM de continuar sendo é relida do banco **no momento do callback** (erro de leitura → 500, nunca "livre para trocar"); a conta escolhida na Microsoft precisa ser essa (senão 409 "Conta diferente da integração", tokens recém-emitidos removidos, nada muda).
- Erros da conexão de integração mostram uma página com "Voltar ao painel" (a sessão humana continua válida) — nunca um laço de volta ao login.
- `POST /auth/integracao/desconectar` (só POST, com checagem de origem).

### 3.3 Logout
- `POST /auth/logout`: sem sessão → `200 {status:'sem_sessao'}` e nada mais; com sessão → revoga **só esta** linha de `sessoes_humanas` e apaga o cookie (`{status:'logged_out'}`). Se o store falhar, responde erro e mantém o cookie (nunca um "logged_out" falso com a sessão viva no servidor). Nunca desconecta a integração.
- "Sair" do frontend congelado (link para `Login.dc.html`): o servidor encerra a sessão deste navegador quando a página é pedida por uma navegação da **própria origem** (`Sec-Fetch-Site: same-origin`/`none`, ou `Referer` da própria origem em navegador sem Fetch Metadata) e então a serve; navegação vinda de outro site só serve a página (sem logout por CSRF). Nada em `public/` foi tocado.

### 3.4 Store de sessão (`src/auth/sessaoStore.ts`)
- Chave = **SHA-256** do identificador (o identificador em claro só existe no cookie assinado; nunca no banco nem em log). `dados` nunca contém token.
- `expira_em` = `min(agora + ociosidade, autenticadoEm + vida absoluta)` calculado **no servidor** (nunca de `cookie.expires`); padrões **12 h de ociosidade** (`SESSION_IDLE_HOURS`) e **7 dias absolutos** (`SESSION_MAX_AGE_DAYS`).
- `get` só devolve linha viva; `set`/`touch` só alcançam linha **viva** (`revogada_em IS NULL AND expira_em > now()`): uma requisição que começou antes de um logout/regenerate nunca ressuscita a sessão. `touch` no máximo 1×/min por sessão.
- `destroy` = revogação (linha mantida 30 dias como trilha, sem dados), purga horária segura em várias instâncias. Desativar o último acesso interno de alguém, desvincular a identidade ou o comando `revogar-sessoes` revogam todas as sessões da pessoa.
- `saveUninitialized:false` + `rolling:false`; arquivos estáticos são servidos **antes** da sessão. Leituras nunca modificam a sessão (nenhum `Set-Cookie` em requisições comuns).
- Sem banco: produção não sobe (erro no boot); desenvolvimento local usa o store em arquivo legado com aviso. Boot de produção verifica `sessoes_humanas` (migration 0049 aplicada) e falha cedo se ausente.

### 3.5 Middlewares
- `requireSessao` (V2, gestão, ações, admin, tracking): sessão válida (vida absoluta), usuário existente com o MESMO `home_account_id` → `req.identidade`; senão encerra a sessão e responde `401`.
- `autorizarInterno`: organização ativa (explícita ou única) com membership interno ATIVO → `req.autorizacao`; várias sem seleção → `409 organizacao_ambigua`; desativado → `403 membership_inativo`; nenhum → `403 usuario_sem_papel_interno`; `organizationId` na requisição → `400 parametro_nao_aceito` (inalterado). Sem `req.identidade` e com sessão real (`usuarioId`) → `401` (falha fechada; só o harness de teste, que simula `homeAccountId`, usa o caminho de compatibilidade).
- `requireAuth` (V1, mesmo nome): `requireSessao` + ≥1 membership interno ativo + integração conectada + a pessoa da sessão **é** a conta da integração → `req.accessToken`. Problemas da integração → `403` com `codigo` (`integracao_desconectada`, `conexao_microsoft_de_outra_conta`, `integracao_sem_token`) — **nunca 401**, que prenderia a pessoa num laço de login.
- CSRF (`origemConfiavel.ts`) em `/api` e `/auth`: escrita só com `Origin` (ou `Referer`) = a própria origem (`protocolo://Host`) ou `PRIORA_ORIGENS_PERMITIDAS`; `Origin: null` recusado; escrita **com cookie de sessão e sem Origin/Referer** recusada; sem cookie e sem cabeçalhos (cliente não-navegador) passa. Somado ao `SameSite=Lax`.
- Caminho `/api/demurrage/v2/*` sem rota → `404` JSON (nunca cai no guard V1).
- Tratador de erro central: `≥500` devolve só "Erro interno do servidor."; o log leva método, caminho (sem query), código e ≤200 caracteres da mensagem — nunca cabeçalhos, cookies, corpo ou query.

## 4. Modelo de ameaça

| # | Ameaça | Mitigação | Teste |
|---|---|---|---|
| T1 | Vazamento de sessão entre pessoas / "usuário atual" global | identidade resolvida por requisição a partir da sessão do navegador; nenhuma variável de módulo de usuário; store compartilhado | 01, 02, 05, multi-instância |
| T2 | Login de B derruba A; logout (ou POST anônimo/CSRF) derruba todos | login nunca toca a integração nem outras sessões; logout revoga só a própria linha; anônimo = no-op | 02, 03, 04, CSRF |
| T3 | Fixação de sessão | `regenerate()` no login (único ponto em que o nível de autenticação muda); identificador desconhecido nunca é adotado; a troca de organização grava na PRÓPRIA linha (nunca cria linha nova — ver T5) | fixação |
| T4 | Login CSRF / replay de `state` / troca de código | transação vinculada ao navegador, uso único, PKCE S256, `nonce` | callback OAuth |
| T5 | Sessão revogada/expirada volta a valer (requisições em voo) | `set`/`touch` só em linha viva; nenhuma rota além do login cria linha nova; a troca de organização confere que a gravação alcançou a linha viva (senão 401); expiração no servidor; vida absoluta | 06, revisão "revogação em voo" |
| T6 | Cookie roubado/plantado | HttpOnly, SameSite=Lax, `__Host-` + Secure em produção; sid só como hash no banco | cookies |
| T7 | CSRF em escrita | checagem de origem + Lax; desconectar integração só por POST | CSRF, integração |
| T8 | Token/cookie/state/nonce/código/sid em log | nenhum log no fluxo de auth; tratador central sem cabeçalhos/query | logs |
| T9 | Troca de organização para uma não vinculada / cursor de outra organização | seleção só entre memberships internos ativos; cursores carregam organização + escopo | 08, 09, 25 |
| T10 | Escolha silenciosa de "primeira" organização/membership | nunca: única → resolvida na requisição (não gravada); várias → 409 | 08 |
| T11 | Escalada de papel / autoconcessão / CLIENT interno | ator ADMIN ativo da mesma organização; nunca sobre si mesmo (CHECK + serviço); CLIENT nunca vira interno; HTTP não adiciona memberships | 22, 23 |
| T12 | Organização sem ADMIN (write skew) | lock consultivo por organização no serviço **e** no trigger adiável | provisionamento |
| T13 | Atribuição entre organizações / a CLIENT / a desativado | alvo = membership interno ATIVO da mesma organização (+ FKs compostas + trigger 0007) | 18 |
| T14 | Corrida de reatribuição; atribuição perdida em silêncio | compare-and-set obrigatório (`responsavelAtual`) sob `lockProcesso` + `FOR UPDATE`; idempotência atômica (org, chave) com o AUTOR no hash | 19 |
| T15 | Ação pessoal de analista não responsável (inclusive na janela de uma reatribuição) | checagem DENTRO da transação do serviço, depois do lock do processo, antes do replay | 20, `acoesPessoaisP1` #11 |
| T16 | Identificador vindo do cliente como prova de identidade | autor/ator sempre `req.autorizacao` (sessão); `organizationId` recusado; ids do corpo só como ALVO validado | 18, 25 |
| T17 | Membro desativado continua agindo ou recebendo e-mail com dados | `desativado_em IS NULL` em autorização, serviços, trigger 0033, fan-out e claims de entrega | 07, `membershipDesativadoP1` |
| T18 | Integração trocada por acidente ou por link/navegação de outro site | troca só por `POST` da própria origem após página de confirmação; sem ela, a conta conectada é relida no callback e precisa ser a devolvida | integração, revisão "troca da integração" |
| T19 | Handoff afetado pela sessão/origem | handoff montado antes; não cria sessão; HMAC intocado | 24 |

## 5. Migration 0049 (aditiva) — `0049_sessoes_identidade_atribuicao.sql`

0001–0048 não foram reescritas; nenhuma linha existente é alterada.

1. `sessoes_humanas` (sid_hash SHA-256 PK, usuario_id, dados JSONB, criada/atualizada/expira, revogada_em/motivo coerentes) + índices.
2. `usuarios.administrador_plataforma BOOLEAN NOT NULL DEFAULT false`.
3. `organization_memberships.desativado_em / desativado_motivo` (coerentes) + índice parcial de ativos.
4. `membership_eventos` (append-only, organização imutável; CRIADA/PAPEL_ALTERADO/DESATIVADA/REATIVADA; ator membership ou operador de plataforma; CHECK "ninguém altera o próprio membership").
5. `usuario_eventos` (append-only; vínculo/desvínculo Microsoft, admin de plataforma, revogação de sessões).
6. Constraint trigger adiável `organization_memberships_admin_ativo` ("organização que tem ADMIN ativo nunca fica sem nenhum"), **serializada com o mesmo lock consultivo** do serviço (sem write skew).
7. Deliberadamente **sem** trigger de "responsável ativo" em `processos` (derrubaria todo retry de um handoff que trouxesse um responsável desativado); a leitura trata desativado como sem responsável.
8. `field_observations.fonte` aceita `atribuicao_interna` (prioridade 1000, acima de todas).
9. `processo_atribuicoes` (append-only, organização imutável; ATRIBUIDO/INALTERADO; anterior, novo, autor — membership ou operador —, motivo, observação; `UNIQUE(organization_id, idempotencia_chave)`; FKs compostas).
10. `responsabilidade_decisao_valida_insercao()` (trigger da 0033) recriada com autor **ativo** (mesmo corpo, só `AND desativado_em IS NULL`).

## 6. Contrato `/api/me` (`priora.me.v2`, compatível)

`GET /api/me` sempre `200` (o shell congelado lê só `authenticated`/`username`):

```json
{ "contrato": "priora.me.v2", "authenticated": true, "username": "ana@empresa.com",
  "usuario": { "id": "…", "nome": "Ana" },
  "organizacaoAtiva": { "id": "…", "nome": "Org X" }, "organizacaoAtivaOrigem": "unica | selecionada",
  "organizacoes": [{ "id": "…", "nome": "Org X", "papel": "ANALYST" }],
  "selecaoOrganizacaoNecessaria": false, "organizacaoAtivaInvalida": false,
  "membershipId": "…", "papel": "ANALYST",
  "capacidades": { "verMinhaFila": true, "verFilaDaEquipe": false, "verSemResponsavel": false, "filtrarPorResponsavel": false,
    "abrirProcessosNaoAtribuidos": false, "atribuirResponsavel": false, "registrarMinuta": true, "resolverPendencia": true,
    "aplicarFallbackManual": true, "solicitarReabertura": true, "acoesPessoaisSomenteEmProcessoAtribuido": true,
    "decidirResponsabilidade": false, "autorizarReabertura": false, "finalizarAdministrativo": false,
    "verDiferencaPotencialFinanceira": false, "gerenciarMembros": false, "trocarOrganizacao": false, "conectarIntegracaoMicrosoft": false },
  "filas": { "padrao": "MINHA_FILA", "permitidas": ["MINHA_FILA"] },
  "conexaoMicrosoft": { "integracaoConectada": true, "contaDestaSessao": false } }
```

- Sem sessão: `{contrato, authenticated:false}`; sessão sem acesso interno: `{…, authenticated:false, motivo:'sem_acesso_interno'}`.
- **Nunca** devolve: token de acesso/atualização, segredo, `nonce`/`state`, identificador de sessão, `home_account_id`, credencial HMAC, nem organização em que a pessoa não tem membership interno ativo (teste 11 varre valores e chaves).
- As capacidades são informativas; o backend revalida tudo em cada ação.

## 7. Seleção de organização

- `POST /api/me/organizacao {organizationId}` (com checagem de origem): só organização com membership interno ATIVO da pessoa (senão `403 organizacao_nao_vinculada`, mesma resposta para inexistente); grava a escolha **na própria linha da sessão** (mesmo identificador — a troca não eleva o nível de autenticação; o login é que regenera). Se a sessão foi revogada durante a requisição (logout, `revogar-sessoes`), a gravação não alcança a linha e a resposta é `401` — nenhuma sessão nova nasce. A vida absoluta não reinicia.
- Sem escolha explícita: única organização interna ativa → usada naquela requisição (`organizacaoAtivaOrigem:'unica'`), **nunca gravada** — se a pessoa ganhar uma segunda organização, a próxima requisição responde `409 organizacao_ambigua`. Várias sem escolha → `409` em toda leitura/ação, `selecaoOrganizacaoNecessaria:true` no `/api/me`.
- Revalidação a cada requisição (membership desativado → `403 membership_inativo`; nunca troca sozinho para outra organização).
- Cursores carregam a organização e o escopo calculado pelo servidor: cursor da organização anterior → `400 cursor_invalido` (teste 09).
- Limitação conhecida: o frontend congelado não tem seletor; pessoas com mais de uma organização interna precisam da tela futura (ou do `POST` direto).

## 8. Provisionamento (só backend)

Um serviço (`identidade/provisionamento.ts`) com todas as regras; duas superfícies:

- **CLI do operador de plataforma** — `npm run demurrage:provisionar -- <comando>`; todo comando exige `--operador` e `--motivo` (trilha): `vincular-usuario` (oid+tid → `home_account_id`; nunca sobrescreve vínculo), `adicionar-membro`, `definir-papel`, `desativar-membro`, `reativar-membro`, `admin-plataforma --ativar|--desativar`, `desvincular-usuario` (revoga sessões), `revogar-sessoes`, `listar-membros`, e para a implantação: `conta-integracao`, `vincular-conta-integracao`, `processos-sem-responsavel`, `atribuir-responsavel`, `atribuir-sem-responsavel` (lote, idempotente). Não precisa de configuração Azure.
- **HTTP do ADMIN da organização ativa** — `/api/demurrage/v2/admin/membros`: `GET` (lista), `POST /:membershipId/papel`, `POST /:membershipId/desativar|reativar`. Só membros que **já existem** na organização: adicionar membership por HTTP permitiria puxar alguém de outra organização (tornando-o multi-organização, travado no 409) e descobrir e-mails da plataforma.
- Regras: papéis concedidos só ANALYST/MANAGER/ADMIN; CLIENT nunca vira interno (nem interno vira CLIENT); ninguém altera o próprio membership; ator ADMIN **ativo** da mesma organização (relido sob lock); organização nunca fica sem ADMIN ativo; toda mudança grava `membership_eventos`/`usuario_eventos` na mesma transação; desativar o último acesso interno revoga as sessões.

## 9. Atribuição

`POST /api/demurrage/v2/acoes/processos/:processoId/responsavel` + `Idempotency-Key`, corpo `{membershipId: uuid|null, responsavelAtual: uuid|null, motivo}`.

- Autor: membership MANAGER/ADMIN **ativo** da sessão (ANALYST nunca atribui, nem a si); no CLI, o operador de plataforma (registrado como tal).
- Alvo: membership interno ATIVO da MESMA organização, ou `null` (retirar). Outra organização, CLIENT, desativado ou inexistente → `400 responsavel_invalido`; processo de outra organização → `404`.
- **Compare-and-set** obrigatório: `responsavelAtual` diferente do atual → `409 responsavel_alterado {responsavelAtual}` (nenhuma atribuição se perde em silêncio). Tudo sob `lockProcesso` + `processos FOR UPDATE`.
- FINAL → `409 processo_final_exige_reabertura` (reaberto = OPEN, pode).
- Idempotência atômica: `(organização, chave)` única na trilha; mesma chave + mesmo pedido + **mesmo autor** = replay (`200`, `replay:true`); outro pedido ou outro autor = `409 idempotency_key_reutilizada`; o papel do autor é conferido antes do replay.
- Escrita pelo ledger existente (observação `atribuicao_interna` com `observado_em` estritamente crescente + ponteiro selecionado + coluna) e trilha `processo_atribuicoes` (autor, anterior, novo, data, motivo; também `INALTERADO`). Resposta `201` (ATRIBUIDO novo) / `200`.
- Precedência: depois de uma atribuição interna, um responsável enviado pelo handoff (fonte `outro`) é registrado no ledger mas **não promovido** (a decisão interna prevalece); vale também após uma retirada (`null`).
- O processo aparece **imediatamente** na fila correta (testes 16, 17).

## 10. Matriz de filas e ações por papel

### 10.1 Escopos de leitura (`escopo=`)

| | ANALYST | MANAGER | ADMIN |
|---|---|---|---|
| padrão | `MINHA_FILA` | `EQUIPE` | `EQUIPE` |
| `MINHA_FILA` | ✔ (só a própria) | ✔ | ✔ |
| `EQUIPE` | `403 escopo_nao_permitido` | ✔ (+ `responsavel=<membership ativo da organização>`) | ✔ |
| `SEM_RESPONSAVEL` (nulo **ou** desativado) | `403` | ✔ | ✔ |
| `responsavel=` outro membership | `400 valor_invalido` | ✔ se interno ativo da organização, senão `400` | idem |
| detalhe/timeline/contêiner/pendências/documento de processo não atribuído | `404` (igual a inexistente) | ✔ | ✔ |

Aplicado em: `/processos`, `/filtros` (contagens, clientes, armadores e apuração no escopo; `responsaveis`: gestor vê todos os memberships internos ativos, analista só a si), `/minutas`, `/reaberturas`, `/processos/:id/pendencias`, **novo `GET /pendencias`** (lista de pendências entre processos, keyset), e Gestão (resumos operacional/financeiro/responsabilidade/eficiência/qualidade, decisões e composição — o mesmo predicado SQL em cada indicador, então resumo e composição reconciliam dentro do escopo). Resposta de lista: `escopo`, `membershipResolvido`, `cursor` (seguinte), `temProxima`, `filtros` (ativos, como aplicados pelo servidor). Paginação: keyset onde já existia; a fila principal continua com a posição dentro do cursor amarrada ao `ordemHash` (não há `OFFSET` SQL). FINAL fora da fila padrão em todos os escopos.

### 10.2 Ações

| Ação | Natureza | ANALYST responsável | ANALYST não responsável / sem responsável | MANAGER | ADMIN | CLIENT |
|---|---|---|---|---|---|---|
| registrar minuta técnica | pessoal | 201/200 | 403 `ator_nao_responsavel` | ✔ | ✔ | 403 |
| fallback manual | pessoal | 200 | 403 `ator_nao_responsavel` | ✔ | ✔ | 403 |
| resolver pendência | pessoal | 200 | 403 `ator_nao_responsavel` | ✔ | ✔ | 403 |
| solicitar reabertura | pessoal | 201/200 | 403 `ator_nao_responsavel` | ✔ | ✔ | 403 |
| decidir responsabilidade | organizacional | 403 | 403 | ✔ | ✔ | 403 |
| autorizar reabertura | organizacional | 403 | 403 | ✔ | ✔ | 403 |
| finalizar (legado) | organizacional | 403 | 403 | ✔ | ✔ | 403 |
| atribuir responsável | organizacional | 403 | 403 | ✔ | ✔ | 403 |
| membros | organizacional | 403 | 403 | 403 | ✔ | 403 |
| validar minuta (removida em ddc43db) | — | 410 | 410 | 410 | 410 | 403 |

**Organizacionais por natureza** (atribuição não concede nada): decidir responsabilidade (decisão financeira Rocket × Cliente), autorizar reabertura, finalização administrativa legada, atribuir responsável, administrar membros. MANAGER/ADMIN preservam todas as autoridades e podem executar ações pessoais em qualquer processo da organização (auditados como eles mesmos).

## 11. Autorização real das ações (Etapa 7)

Cada ação verifica no backend: sessão válida (`requireSessao`) → membership ativo + organização (`autorizarInterno`) → papel → item da organização (404 entre organizações) → **dentro do serviço, na mesma transação, depois do lock do processo**: ator ativo (`desativado_em IS NULL … FOR SHARE`) e, para ação pessoal de ANALYST, `processos.responsavel_operacional_membership_id = ator` — antes de qualquer replay idempotente (nada vaza para quem não é o responsável). Pendência: ordem de lock corrigida (`lockProcesso` → `processos FOR SHARE` → pendência `FOR UPDATE`, revalidada) para não inverter a ordem universal. Fallback manual (D10): checado logo após `lockProcesso` + `processos FOR UPDATE`, contra o responsável persistido (nunca um que a própria entrada tente gravar); o caminho do handoff (que recusa `manual_fallback`) é byte a byte o mesmo.

Mudanças observáveis de resposta (deliberadas): autor de fallback recusado `400 → 403`; erros do serviço de pendência que caíam em `500` agora são `403/400/404`; em solicitar reabertura e no D10 a autorização vem antes da validação de campos/estado.

## 12. Compatibilidade

- **Handoff HMAC**: credenciais, assinatura, idempotência, capacidade, dados e memberships preservados; montado antes da sessão e da checagem de origem; suítes da Entrega 1 + capacidade verdes (§14).
- **Sessões**: login/logout nunca invalidam sessões de outras pessoas. As sessões antigas (`connect.sid`, em arquivo) deixam de valer no deploy — já se perdiam a cada reinício do plano atual.
- **Regras financeiras, de minuta e de encerramento** de `ddc43db`: inalteradas (nenhuma aprovação de minuta por gestor; `/validar` continua 410; `diferencaPotencial` continua só MANAGER/ADMIN).
- **Frontend congelado**: `escopo` de lista não é lido pelo frontend (verificado); erros de leitura fora do escopo são `404` ("Não encontrado ou sem acesso") em vez de `403` (que trocaria o módulo inteiro por tela de bloqueio); `responsavel` inválido é `400` (o frontend volta ao filtro padrão); `/api/me` mantém `authenticated`/`username`.
- **V1 (caixa da integração)**: só a pessoa que É a conta da integração usa as rotas V1 (antes, cada login sequestrava a caixa global para si). Outras pessoas recebem `403` com código. **Mudança deliberada**, ver risco R1.
- **Compatibilidade de teste temporária**: `autorizarInterno` ainda aceita a sessão simulada `{homeAccountId}` dos harnesses de teste, mas recusa (`401`) qualquer sessão real sem `req.identidade` — não enfraquece o isolamento.
- **Singleton de integração**: mantido e isolado como "conexão de integração" (todos os consumidores mapeados no diagnóstico §2.8/2.10); nenhum fallback silencioso para "primeiro usuário/organização/membership".

## 13. Implantação (ordem obrigatória)

1. **Migrar o banco antes do código**: `npm run db:migrate:demurrage` (0049 é aditiva; o código antigo a ignora). O boot de produção recusa subir sem `sessoes_humanas`.
2. **Ambiente**: `SESSION_SECRET` (o mesmo de hoje — também assina cursores), `DEMURRAGE_DATABASE_URL`, `PRIORA_TOKEN_CACHE_KEY` (sem ela a integração fica só em memória e se perde a cada reinício); opcionais `SESSION_MAX_AGE_DAYS`, `SESSION_IDLE_HOURS`, `PRIORA_ORIGENS_PERMITIDAS`.
3. **Confirmar a integração atual** (era "a última conta que fez login"): `demurrage:provisionar -- conta-integracao`; se for a conta certa, `vincular-conta-integracao --nome … --email … --operador … --motivo …` (vincula e a torna administradora de plataforma); se não, desconectar depois pelo administrador de plataforma (`POST /auth/integracao/desconectar`) e reconectar a correta.
4. **Provisionar as pessoas**: `vincular-usuario` (oid/tid do Entra — a página "Conta não provisionada" mostra o `oid.tid` da própria pessoa) + `adicionar-membro` (o primeiro ADMIN de cada organização via CLI).
5. **Atribuir os processos abertos** antes de liberar os analistas: `processos-sem-responsavel --org …` e `atribuir-sem-responsavel --org … --para <membership> …` / `atribuir-responsavel …` (sem isso, a fila padrão do ANALYST fica vazia e ele não executa ações pessoais).
6. Publicar o código; smoke test: `/api/me`, uma rota V2, uma rota V1 com a conta da integração, login de duas pessoas em navegadores diferentes.

## 14. Testes e totais

### 14.1 Testes novos

| Arquivo | Testes | O que prova |
|---|---|---|
| `__tests__/autenticacaoFilasP1.test.ts` | 42 | **Os 28 obrigatórios** + fixação, callback OAuth, CSRF, cookies, logs, multi-instância/reinício, integração Microsoft, V1, "Sair", precedência do handoff e 4 regressões da revisão final. Tudo pelo app REAL (`criarApp`, store PostgreSQL, cookies num "navegador" por pessoa, fluxo `/auth/login` → `/auth/callback`); só a Microsoft é simulada. Nenhum mock de `req.session`/`req.auth`. |
| `__tests__/filasPessoaisLeituraP1.test.ts` | 14 | escopos por papel em toda lista (fila, filtros, minutas, reaberturas, pendências, Gestão), 404 fora do escopo, SEM_RESPONSAVEL com desativado, cursores presos ao escopo/membership/organização, sem `OFFSET`. |
| `__tests__/acoesPessoaisP1.test.ts` | 11 | matriz de ações por papel, `ator_nao_responsavel`, MANAGER/ADMIN em processo não atribuído (auditados como eles mesmos), desativado rejeitado em todo serviço, replay não vaza, corrida de reatribuição sob o lock (determinística), `/validar` 410. |
| `__tests__/membershipDesativadoP1.test.ts` | 10 | fan-out e claim de avisos sem desativados (pendência, fallback, divergência, Master Free Time), devolução da posse sem consumir tentativa, captura e reprocessamento de SI negam desativado. |

Mapa dos 28 obrigatórios → `autenticacaoFilasP1.test.ts`: 1 `01.` · 2 `02.` · 3 `03.` · 4 `04.` · 5 `05.` · 6 `06.` · 7 `07.` · 8 `08.` · 9 `09.` · 10 `10.` · 11 `11.` · 12 `12.` · 13 `13.` · 14 `14.` · 15 `15.` · 16 `16.` · 17 `17.` · 18 `18.` · 19 `19.` · 20 `20.` · 21 `21.` · 22 `22.` · 23 `23.` · 24 `24.` · 25 `25.` · 26 `26.` · 27 `27.` · 28 `28.` (mesma numeração no nome do teste).

### 14.2 Testes existentes atualizados (com justificativa no próprio código)

Toda mudança traz um comentário `Produção P1 (filas pessoais):`. Categorias:
- **Setup de atribuição** (a maioria): testes que usavam um ANALYST num processo SEM responsável para exercitar OUTRA regra (minuta, encerramento, idempotência, concorrência, fallback, pendência, leituras) passam a atribuí-lo antes (`atribuirResponsavelDeTeste` em `testDb.ts`; `registrarMinutaDeTeste` atribui o analista que cria). O ator continua ANALYST — a regra verificada não muda.
- **Expectativa da regra nova**: literal `escopo: 'fila_da_equipe'` → `MINHA_FILA`/`EQUIPE`; filtro de consulta interceptada que dependia do SQL antigo de `autorizacao.ts`.
- **Lista de migrations**: 0049 passa a ser a última; scaffold `desativado_em` nos testes que congelam o schema em 0032/0033.
- **Cobertura reforçada** (achados da auditoria das migrações de teste): cursor de outra organização com cursor VÁLIDO; pino de versão de cursor provado capaz de falhar; 404 entre organizações também com MANAGER (o predicado de organização volta a ser exercitado); Gestão do ANALYST com dados reais atribuídos.
- `shippingInstructions.test.ts`: a checagem de envio sobre schema 0025 roda depois de migrar até a última (o serviço lê `desativado_em`).
- `registroDemurrage.test.ts`: o gate estático "nenhuma rota chama o D10" passa a varrer também `src/app.ts`.

Nenhum teste foi pulado/desativado; nenhuma asserção financeira, de máquina de estados da minuta/encerramento, de idempotência, de concorrência, de isolamento ou do handoff foi removida ou afrouxada (duas auditorias independentes por grupo de arquivos).

### 14.3 Validação sequencial (worktree limpo)

Worktree limpo (`git worktree add --detach … cc98c9a`), `npm ci`, banco PostgreSQL 16 novo, um passo de cada vez, na ordem pedida:

| # | Passo | Resultado |
|---|---|---|
| 01 | Testes novos (`autenticacaoFilasP1`, `filasPessoaisLeituraP1`, `acoesPessoaisP1`, `membershipDesativadoP1`) | **77/77** |
| 02 | Testes existentes de autenticação/sessão/autorização (`leituraAutorizacao`, `tokenCacheDuravel`, `capturaPreAlerta`, `shippingInstructions`, `multiTenant`) | **93/93** |
| 03 | Entrega 1 — handoff + controle de capacidade (`handoffProducaoP1`, `V11`, `VinculoConcorrenciaV13`, `VinculoTransacaoV12`, `handoffCapacidade`) | **87/87** |
| 04 | Entrega 2 — ações (`demurrageAcoesEntrega2`, `V11`, `V12`, `acoesSemLogicaDeNegocio`) | **70/70** |
| 05 | Entrega 3 — leituras operacionais (`leituraOperacionalEntrega3`, `V11`, `V11Unidade`) | **47/47** |
| 06 | D12 — read-model (`demurrageV2Routes`, `leituraContrato`, `leituraD12V12`, `leituraDetalhe`, `leituraFila`, `leituraFilaV11`, `leituraFiltros`, `leituraTimeline`, `leituraTimelineV11`) | **65/65** |
| 07 | Suíte completa da Demurrage Engine (`npm run test:demurrage-engine`) | **1290/1290** |
| 08 | V1 (`npm run test`) | **25/25** |
| 09 | D13 UI (`npm run test:demurrage-ui`) | **66/66** |
| 10 | `npx tsc --noEmit` | exit 0, nenhuma saída |
| 11 | `npm run build` | exit 0 |

`git status --porcelain` vazio antes e depois (só `dist/` e `node_modules/` ignorados). Nenhum teste pulado, cancelado ou `todo`.

## 15. Revisões adversariais

### 15.1 Do desenho (antes de implementar)
Três lentes (segurança, compatibilidade, produto) sobre o desenho. Incorporados, entre outros: sem trigger de "responsável ativo" em `processos` (derrubaria o handoff); `set`/`touch` só em linha viva; lock consultivo no trigger de "último ADMIN"; adicionar membership por HTTP removido (lockout/enumeração entre organizações); desativação revoga sessões e vale no V1, na captura, no reprocessamento de SI, nos serviços e nos avisos; leituras fora do escopo = 404 (o frontend congelado trata 403 como bloqueio de módulo); checagem pessoal DENTRO da transação do serviço, com a ordem de lock corrigida na pendência; `/api/me` sempre 200; organização implícita nunca gravada; `__Host-`; nunca 401 por problema da integração (laço de login); boot falha sem a 0049; nova lista `GET /pendencias`; Gestão com o mesmo predicado em todo indicador.

### 15.2 Da implementação (antes do commit)
Seis lentes (sessões/cookies; OAuth/integração/logs; organização/`/api/me`; atribuição/provisionamento; leituras com escopo; ações/desativação), cada achado verificado por um cético independente que tentou refutá-lo (com teste de rascunho contra o app real quando decisivo). **12 confirmados — todos corrigidos e cobertos por teste; 2 refutados.**

| Achado confirmado | Severidade | Correção |
|---|---|---|
| Troca de organização com `regenerate()` recriava uma sessão revogada em voo (contornava `revogar-sessoes` e o logout) | major | a troca grava na própria linha (nunca cria linha nova) e confere que a gravação alcançou linha viva (senão 401) |
| Troca da conta da integração começava por um GET (`?substituir=1`) disparável de outro site | major | GET só mostra confirmação; a troca exige POST da própria origem |
| Conta esperada da integração decidida no início do fluxo, com erro de leitura tratado como "não conectada" | minor | relida no callback; erro de leitura propaga |
| "Sair" (GET `/Login.dc.html`) encerrava a sessão numa navegação vinda de qualquer site | minor | só com navegação da própria origem (Fetch Metadata / Referer) |
| Logout respondia sucesso com falha do store | minor | revogação estrita no logout explícito |
| Laço de login para administrador de plataforma com consentimento recusado | minor | erro da integração volta ao painel |
| Falha da Microsoft na troca do código virava 500 JSON | minor | página de erro 502; só o código do erro vai a log |
| `vincular-usuario` escolhia o primeiro de e-mails que diferem só em caixa | minor | `409 email_ambiguo` |
| Lote do CLI reaproveitava resposta de lote antigo e dizia que atribuiu | minor | chave por lote; replays contados à parte |
| Devolver a posse a PENDING (destinatário desativado na janela do envio) consumia a tentativa e podia prender a entrega | minor | a tentativa é devolvida (provado: o teste falha sem a correção) |

(Dois achados de sessão/organização eram o mesmo defeito visto por lentes diferentes; idem logout.) Refutados: e-mail ambíguo já tratado na versão revisada; aviso de divergência enfileirado ao responsável da época da ocorrência (desenho congelado dos avisos — ver risco R7).

## 16. Riscos remanescentes

- **R1 — V1 só para o dono da caixa da integração.** As rotas V1 (e-mails, couriers, auditoria, Demurrage V1, captura) usam a caixa Microsoft da integração; só a pessoa que É essa conta as usa. Os demais recebem `403` com código — o frontend V1 congelado mostra lista vazia ou o texto do erro. Antes, cada login sequestrava a caixa global para si (o defeito corrigido). Caixa por pessoa é trabalho futuro.
- **R2 — Frontend congelado**: sem seletor de organização (pessoa com mais de uma organização interna vê a tela "seleção indisponível" até a UI existir ou usar o `POST`); sem tela de atribuição (API/CLI); capacidades do `/api/me` ainda não lidas pela UI; nome no topo vem do `localStorage`; filtros por aba no `sessionStorage` (um `responsavel` alheio volta ao padrão com 400).
- **R3 — Implantação**: sem provisionamento ninguém entra; sem atribuição inicial a fila padrão do ANALYST fica vazia e ele não executa ações pessoais (§13).
- **R4 — Integração global**: uma caixa serve todas as organizações (avisos de todas saem dela e ficam nos Itens Enviados do dono) — modelo anterior, mantido.
- **R5 — Caches em memória da auditoria/pré-alerta** não são limpos numa troca da conta da integração (pré-existente; a troca agora é explícita e rara).
- **R6 — Ordem de validação em duas ações** (mesma organização, sem escrita, sem dado do processo): a rota de resolver pendência responde `409 tipo_divergente_do_persistido` antes da checagem do responsável; o registro de minuta responde `409 idempotency_key_legado_sem_hash` antes da autorização.
- **R7 — Aviso de divergência** é endereçado ao responsável do momento da ocorrência (desenho congelado); após uma reatribuição antes do envio, vai ao responsável anterior (ainda membro ativo da organização).
- **R8 — Desvínculo de identidade** pelo CLI não desativa memberships: os processos da pessoa não caem em SEM_RESPONSAVEL; quando alguém sai, o operador deve `desativar-membro`.
- **R9 — Logs do provedor de hospedagem** podem registrar a URL do callback (`code`, `state`); o código é inútil sem o verifier PKCE (cookie HttpOnly), de uso único e curto.
- **R10 — "Sair" em navegador sem Fetch Metadata e sem `Referer`**: não encerra a sessão (falha segura; a sessão expira por ociosidade).
- **R11 — Caminho de compatibilidade de teste** em `autorizarInterno` (sessão simulada só com `homeAccountId`): inalcançável por sessão real (falha fechada), a remover quando os harnesses migrarem.
- **R12 — Precedência da atribuição interna sobre o handoff** (§9): mudanças posteriores de responsável vindas do sistema de origem ficam no ledger, não aplicadas.
- Entrega **não congelada**; a Production P1 **não** está concluída.

## 17. Confirmação: frontend e design intocados

`git diff --stat ddc43db -- public/` vazio: nenhum HTML, CSS ou JavaScript de apresentação alterado. As únicas páginas novas são as respostas HTML do próprio servidor no fluxo de autenticação (erro do login/integração e a confirmação da troca da integração), geradas em `src/auth/authRoutes.ts` no mesmo padrão da página de erro de login que já existia. Os fixtures de teste do D13 mudaram só o literal `escopo`. Não iniciados: frontend, design, administração tarifária, armazenamento definitivo de arquivos de minuta.
