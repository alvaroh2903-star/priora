# Produção P1 — Autenticação, identidade operacional, atribuição e filas pessoais (entrega corretiva)

> **APROVADA E CONGELADA** em `8266fba` por decisão formal do responsável pelo produto (§19). Entrega corretiva, só backend. **Não declara a Production P1 concluída** (§19.7).
> **Limitação aceita para o MVP:** uma única organização em produção, dona exclusiva da integração Microsoft. Captura, reprocessamento, avisos e V1 pertencem só a ela. Nenhuma segunda organização é ativada até existir um canal de integração por organização (§19.4; checklist obrigatório no §19.5).
> Frontend, HTML, CSS, JavaScript de apresentação e design: **intocados** (§17).
> Fora desta entrega (não iniciados): administração tarifária, armazenamento definitivo dos arquivos de minuta, frontend/design.
> O handoff HMAC (contrato assinado, idempotência e controle de capacidade) **não foi modificado** (§12). Ressalva: depois de uma atribuição interna, o responsável enviado pelo handoff é registrado no ledger, mas não promovido (§9, R12). A requisição e a resposta do handoff não mudam; o efeito dessa observação sobre o responsável, sim.
> **Auditoria corretiva final (§18)**: explica a contagem D12 (75 → 65, erro do executor, nenhum teste perdido), corrige os avisos após reatribuição (0050), isola a integração Microsoft por organização dona (0051) e separa a permissão da V1. Traz ainda o inventário dos 92 arquivos, a revisão de segurança das sessões e a validação final.

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
18. Auditoria corretiva final (D12, avisos, integração Microsoft, V1, inventário, sessões, validação)
19. Congelamento formal (baseline, superfície, regra de alteração, limitação do MVP, checklist de deploy)

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
| **Integração Microsoft** | conta `msal_conta_ativa` + cache MSAL durável, relidos do banco a cada uso; **organização dona** explícita (`integracao_microsoft_vinculos`, 0051 — §18.3) | V1 (membros ativos da dona), avisos e captura (só da dona) |
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
- `requireAuth` (V1, mesmo nome — auditoria final, §18.4): sessão humana + ≥1 membership interno ativo + integração conectada + organização dona vinculada + membership interno ATIVO **na organização dona** + token → `req.accessToken` e `req.integracao`. A pessoa não precisa ser a conta da integração; ser essa conta, ou administrador de plataforma, não dá acesso. Problemas → `403` com `codigo` (`usuario_sem_papel_interno`, `integracao_desconectada`, `integracao_sem_organizacao`, `integracao_de_outra_organizacao`, `integracao_sem_token`). **Nunca 401**, que prenderia a pessoa num laço de login. O antigo `conexao_microsoft_de_outra_conta` deixou de existir.
- `/api/tracking/:numero` (auditoria final, C1): `requireSessao` + ≥1 membership interno ativo, relido a cada requisição (`403 usuario_sem_papel_interno`). `/api/tracking/health` continua público.
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
  "conexaoMicrosoft": { "integracaoConectada": true, "contaDestaSessao": false, "podeUsarCaixaDaIntegracao": true } }
```

- Sem sessão: `{contrato, authenticated:false}`; sessão sem acesso interno: `{…, authenticated:false, motivo:'sem_acesso_interno'}`.
- **Nunca** devolve: token de acesso/atualização, segredo, `nonce`/`state`, identificador de sessão, `home_account_id`, credencial HMAC, nem organização em que a pessoa não tem membership interno ativo (teste 11 varre valores e chaves).
- As capacidades são informativas; o backend revalida tudo em cada ação.
- `conexaoMicrosoft.podeUsarCaixaDaIntegracao` (auditoria final): a mesma regra do guard V1 (membership interno ativo na organização dona), mais o indicador de token em cache da mesma conta. `contaDestaSessao` é mantido por compatibilidade e não decide mais nada.

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
- **V1 (caixa da integração)** — revisto na auditoria final (§18.4): usa a V1 todo membro interno ATIVO da organização DONA da integração, cada um com a própria sessão. Antes (`cc98c9a`), só a pessoa que ERA a conta da integração; antes ainda (`ddc43db`), cada login sequestrava a caixa global. Membros de outras organizações recebem `403 integracao_de_outra_organizacao`, e o frontend congelado mostra listas vazias. É o bloqueio multiorganização do §18.3.
- **Cursores** (B1): sete versões novas (`d12.fila.v1.3`, `p1e3.minutas.v4`, `p1e3.reaberturas.v3`, `p1e3.pendencias.v3`, `d14.gestao.responsabilidade.decisoes.v2`, `d14.gestao.composicao.v3`, novo `p1.pendencias.lista.v1`). Cursor emitido antes do deploy → `400 cursor_invalido`; o frontend reinicia a lista.
- **Gestão** (B2): `cliente`, `armador`, `tipoEquipamento` e `responsavel` malformados passam de `500` para `400 valor_invalido`.
- **Captura** (B5): CLIENT passa a receber `403` em `GET /api/captura/status` (CLIENT nunca é interno). As respostas de vincular, pausar, retomar e remover não trazem mais `home_account_id` nem o estado do token.
- **`/filtros.responsaveis`** (B6): passa a ser a lista de quem pode ser atribuído (membros internos ativos com `papel`) e não mais "responsáveis de processos na apuração pedida".
- **Revalidação na Microsoft** (B4): a V2 não chama mais `acquireTokenSilent` a cada requisição. Desativar a conta no Entra não corta mais o acesso em cerca de 1 h; o corte é `desativar-membro` ou `revogar-sessoes` (R13).
- **Handoff** (B8): a precedência da atribuição interna está descrita no cabeçalho, no §9 e no R12.
- **Compatibilidade de teste temporária**: `autorizarInterno` ainda aceita a sessão simulada `{homeAccountId}` dos harnesses de teste, mas recusa (`401`) qualquer sessão real sem `req.identidade` — não enfraquece o isolamento.
- **Singleton de integração**: mantido e isolado como "conexão de integração" (todos os consumidores mapeados no diagnóstico §2.8/2.10); nenhum fallback silencioso para "primeiro usuário/organização/membership".

## 13. Implantação (ordem obrigatória)

> **Checklist obrigatório do congelamento: §19.5.** Uma única organização em produção (§19.4).

1. **Migrar o banco antes do código**: `npm run db:migrate:demurrage` (0049, 0050 e 0051 são aditivas; o código antigo as ignora, e a confirmação de envio da 0050 é um gatilho seguro para rollback, §18.2). O boot de produção recusa subir sem o schema delas. Aplicar fora do pico: a 0050 toma lock exclusivo nas tabelas de entregas e eventos de divergência. Em caso de erro de deadlock com o worker no ar, basta repetir; o runner é transacional.
2. **Ambiente**: `SESSION_SECRET` (o mesmo de hoje; também assina cursores), `DEMURRAGE_DATABASE_URL` e **`PRIORA_TOKEN_CACHE_KEY` (obrigatória)**. Sem ela, a conta da integração não é gravada no banco: a V1, a captura e os avisos enxergam a integração como desconectada, numa falha fechada, e o boot registra o erro. Opcionais: `SESSION_MAX_AGE_DAYS`, `SESSION_IDLE_HOURS`, `PRIORA_ORIGENS_PERMITIDAS`. Os mesmos valores em todas as instâncias.
3. **Confirmar a integração atual e definir a organização DONA** (auditoria final, §18.3). A integração atual era "a última conta que fez login".
   - Conferir com `demurrage:provisionar -- conta-integracao`. Se não for a conta certa, o administrador de plataforma desconecta (`POST /auth/integracao/desconectar`) e reconecta a correta.
   - Antes de publicar o código: `demurrage:provisionar -- vincular-integracao-organizacao --org <organização> --operador … --motivo …`. Depois, conferir `organizacaoDona` e `vinculosAtivosDeOutrasContas` com `conta-integracao`.
   - Sem esse vínculo, depois do deploy: a V1 responde `403 integracao_sem_organizacao` para todos, a captura para, o reprocessamento da SI é recusado e todo aviso falha com `integracao_sem_organizacao`.
   - Vincular encerra vínculos de captura legados dessa conta em outras organizações.
   - `vincular-conta-integracao` passou a ser opcional (legado) e não é recomendado: a conta técnica não precisa ser usuária.
   - **Uma única organização em produção** até existir um canal por organização (bloqueio do §18.3).
4. **Provisionar as pessoas**: `vincular-usuario` (oid/tid do Entra — a página "Conta não provisionada" mostra o `oid.tid` da própria pessoa) + `adicionar-membro` (o primeiro ADMIN de cada organização via CLI).
5. **Atribuir os processos abertos** antes de liberar os analistas: `processos-sem-responsavel --org …` e `atribuir-sem-responsavel --org … --para <membership> …` / `atribuir-responsavel …` (sem isso, a fila padrão do ANALYST fica vazia e ele não executa ações pessoais).
6. Publicar o código. Smoke test:
   - `/api/me`, com `podeUsarCaixaDaIntegracao` para um membro da dona;
   - uma rota V2;
   - uma rota V1 com um ANALYST da organização dona (não a conta técnica);
   - `/api/tracking`;
   - login de duas pessoas em navegadores diferentes.
7. Ao TROCAR a organização dona no futuro: limpar os stores locais da V1 (`.data/courier-*.json`, `.data/demurrage-*.json`) e reiniciar as instâncias (R19).

## 14. Testes e totais

### 14.1 Testes novos

| Arquivo | Testes | O que prova |
|---|---|---|
| `__tests__/autenticacaoFilasP1.test.ts` | 42 | **Os 28 obrigatórios** + fixação, callback OAuth, CSRF, cookies, logs, multi-instância/reinício, integração Microsoft, V1, "Sair", precedência do handoff e 4 regressões da revisão final. Tudo pelo app REAL (`criarApp`, store PostgreSQL, cookies num "navegador" por pessoa, fluxo `/auth/login` → `/auth/callback`); só a Microsoft é simulada. Nenhum mock de `req.session`/`req.auth`. |
| `__tests__/filasPessoaisLeituraP1.test.ts` | 14 | escopos por papel em toda lista (fila, filtros, minutas, reaberturas, pendências, Gestão), 404 fora do escopo, SEM_RESPONSAVEL com desativado, cursores presos ao escopo/membership/organização, sem `OFFSET`. |
| `__tests__/acoesPessoaisP1.test.ts` | 11 | matriz de ações por papel, `ator_nao_responsavel`, MANAGER/ADMIN em processo não atribuído (auditados como eles mesmos), desativado rejeitado em todo serviço, replay não vaza, corrida de reatribuição sob o lock (determinística), `/validar` 410. |
| `__tests__/membershipDesativadoP1.test.ts` | 10 (12 após a auditoria final) | fan-out e claim de avisos sem desativados (pendência, fallback, divergência, Master Free Time), devolução da posse sem consumir tentativa, captura e reprocessamento de SI negam desativado. |
| `__tests__/avisosReatribuicaoP1.test.ts` (auditoria final) | 18 | §18.2 |
| `__tests__/integracaoMicrosoftIsolamentoP1.test.ts` (auditoria final) | 15 | §18.3 |
| `__tests__/sessaoSegurancaP1.test.ts` (auditoria final) | 16 | §18.6 |

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

> **Registro histórico da validação de `cc98c9a`.** A etapa 06 (D12) mostra 65 porque o executor tinha movido `leituraAutorizacao.test.ts` (10 testes) para a etapa 02. Nenhum teste se perdeu (§18.1). A validação final, com a D12 provadamente completa (75), está no §18.8.

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

(Dois achados de sessão/organização eram o mesmo defeito visto por lentes diferentes; idem logout.) Refutados: e-mail ambíguo já tratado na versão revisada; aviso de divergência enfileirado ao responsável da época da ocorrência (desenho congelado dos avisos — ver risco R7). **Revisto na auditoria final:** esse aviso era um defeito real e foi corrigido (§18.2).

## 16. Riscos remanescentes

- **R1 — V1 só para a organização dona** (revisto na auditoria final, §18.4). Usam a V1 os membros internos ATIVOS da organização dona da integração. As demais organizações recebem `403 integracao_de_outra_organizacao`, e o frontend congelado mostra listas vazias. Caixa ou canal por organização é trabalho futuro.
- **R2 — Frontend congelado**: sem seletor de organização (pessoa com mais de uma organização interna vê a tela "seleção indisponível" até a UI existir ou usar o `POST`); sem tela de atribuição (API/CLI); capacidades do `/api/me` ainda não lidas pela UI; nome no topo vem do `localStorage`; filtros por aba no `sessionStorage` (um `responsavel` alheio volta ao padrão com 400).
- **R3 — Implantação**: sem provisionamento ninguém entra; sem atribuição inicial a fila padrão do ANALYST fica vazia e ele não executa ações pessoais (§13).
- **R4 — Integração de uma organização só** (revisto na auditoria final, §18.3). O modelo "uma caixa serve todas" foi refutado: houve gravação de dados de B em A. A caixa serve só a organização dona. Avisos de outras organizações falham com `canal_de_outra_organizacao`, sem chamar o Graph. **Bloqueio objetivo de deploy multiorganização.**
- **R5 — Caches em memória da auditoria/pré-alerta** não são limpos numa troca da conta da integração (pré-existente; a troca agora é explícita e rara).
- **R6 — Ordem de validação em duas ações** (mesma organização, sem escrita, sem dado do processo): a rota de resolver pendência responde `409 tipo_divergente_do_persistido` antes da checagem do responsável; o registro de minuta responde `409 idempotency_key_legado_sem_hash` antes da autorização.
- **R7 — CORRIGIDO na auditoria final (§18.2).** O aviso de divergência ainda não enviado segue o responsável atual (0050). Fica a janela inerente ao envio externo sem lock: um envio já confirmado sob o lock sai para quem era o responsável naquele instante.
- **R8 — Desvínculo de identidade** pelo CLI não desativa memberships: os processos da pessoa não caem em SEM_RESPONSAVEL; quando alguém sai, o operador deve `desativar-membro`.
- **R9 — Logs do provedor de hospedagem** podem registrar a URL do callback (`code`, `state`); o código é inútil sem o verifier PKCE (cookie HttpOnly), de uso único e curto.
- **R10 — "Sair" em navegador sem Fetch Metadata e sem `Referer`**: não encerra a sessão (falha segura; a sessão expira por ociosidade).
- **R11 — Caminho de compatibilidade de teste** em `autorizarInterno` (sessão simulada só com `homeAccountId`): inalcançável por sessão real (falha fechada), a remover quando os harnesses migrarem.
- **R12 — Precedência da atribuição interna sobre o handoff** (§9): mudanças posteriores de responsável vindas do sistema de origem ficam no ledger, não aplicadas.
- **R13 — Desativação no Entra não corta a sessão** (B4). Use `desativar-membro` ou `revogar-sessoes`. A sessão vale no máximo 12 h ociosa ou 7 dias.
- **R14 — Ação × leitura** (B15): para um processo não atribuído, o ANALYST recebe 404 na leitura e `403 ator_nao_responsavel` na ação. O id é UUID, dentro da própria organização; aceito.
- **R15 — Avisos da própria dona voltam pela captura**: os Itens Enviados são lidos, e o corpo do aviso de divergência contém "Shipping Instructions:", então o aviso vira conversa pendente na própria organização dona. Não cruza organizações.
- **R16 — Remetente externo**: a captura não verifica o remetente. Qualquer e-mail com o marcador e o código do processo grava Free Time na organização dona (pré-existente).
- **R17 — Ids do cliente interpolados em caminhos do Graph** na V1 (`/me/messages/{id}`, `folder`, `$filter`). Limitados à caixa pela permissão delegada (sem `.Shared`); pré-existente.
- **R18 — `err.message` em 4xx** do Graph e da transportadora chega ao cliente na V1 (pré-existente; o 5xx é genérico).
- **R19 — Stores e caches locais da V1 sem organização** (`.data/courier-*.json`, `demurrage-*.json`, caches de auditoria). Ao trocar a organização dona: limpar e reiniciar (§13, passo 7).
- **R20 — Membership na dona dá a caixa inteira**: leitura e envio como a caixa (`POST /api/emails`), como em `ddc43db` para todos.
- Entrega **aprovada e congelada** em `8266fba` (§19); a Production P1 **não** está concluída (§19.7).

## 17. Confirmação: frontend e design intocados

`git diff --stat ddc43db -- public/` vazio: nenhum HTML, CSS ou JavaScript de apresentação alterado. As únicas páginas novas são as respostas HTML do próprio servidor no fluxo de autenticação (erro do login/integração e a confirmação da troca da integração), geradas em `src/auth/authRoutes.ts` no mesmo padrão da página de erro de login que já existia. Os fixtures de teste do D13 mudaram só o literal `escopo`. Não iniciados: frontend, design, administração tarifária, armazenamento definitivo de arquivos de minuta. Auditoria final: `git diff --stat 29a3830 -- public/` também vazio.

## 18. Auditoria corretiva final

Auditoria de `cc98c9a` e `29a3830` pedida antes de congelar a entrega. À época da auditoria a entrega não estava congelada; depois ela foi **aprovada e congelada** em `8266fba` (§19). **A Production P1 não está concluída.** Não foram iniciados frontend, design, administração tarifária nem armazenamento definitivo de minutas. O handoff HMAC (contrato, idempotência e capacidade) não foi tocado.

| § | Tema | Resultado |
|---|---|---|
| 18.1 | D12 75 → 65 | erro do executor; nenhum teste perdido; executor corrigido para provar 75 |
| 18.2 | Avisos após reatribuição | defeito real (R7) corrigido: migration 0050 + worker + 18 testes |
| 18.3 | Integração Microsoft compartilhada | isolamento refutado em `29a3830`; organização dona (0051) + 15 testes; bloqueio multiorganização registrado |
| 18.4 | Rotas V1 | permissão = membro ativo da dona (não "ser a conta"); conceitos separados |
| 18.5 | Inventário dos 92 arquivos | classificados; relaxamento C1 e 6 defeitos menores corrigidos; contratos documentados |
| 18.6 | Segurança das sessões | 12 itens com evidência; D1 corrigido (e ampliado); 16 testes |
| 18.7 | Testes existentes alterados | todos justificados |
| 18.8 | Revisão adversarial final | 2 rodadas: 13 + 4 confirmados, todos corrigidos; 6 refutados |
| 18.9 | Validação final | `b03b463`, worktree limpo + banco novo: todas as etapas verdes (suíte completa 1345; D12 75 provado arquivo a arquivo) |

### 18.1 A divergência D12 75 → 65: erro do executor, nenhum teste perdido

**Causa.** O executor da validação de `cc98c9a` (script de rascunho fora do repositório) moveu `leituraAutorizacao.test.ts` da etapa D12 para a etapa 02 ("autenticação/sessão/autorização existentes"), e o relatório (§14.3) listou a etapa D12 sem ele, sem dizer que o arquivo mudara de etapa. A única diferença entre os comandos das duas validações:

```
< passo 06 "D12 read-model" … $T/demurrageV2Routes.test.ts $T/leituraAutorizacao.test.ts $T/leituraContrato.test.ts …
> passo 06 "D12 read-model" … $T/demurrageV2Routes.test.ts $T/leituraContrato.test.ts …
```

`leituraAutorizacao.test.ts` = 1 teste-pai (`D12 G6 — RBAC e isolamento`) + 9 subtestes `t.test` = **10**; o TAP do Node conta subtestes em `# tests`. 75 − 10 = 65.

**O que foi conferido e descartado:**

| Hipótese | Resultado |
|---|---|
| Arquivo removido ou renomeado | nenhum: os 10 arquivos D12 existem em `ddc43db` e `29a3830`; os únicos arquivos novos em `__tests__` no intervalo são `acoesPessoaisP1`, `autenticacaoFilasP1`, `filasPessoaisLeituraP1`, `membershipDesativadoP1` |
| Teste renomeado ou excluído | nenhum: os títulos (`test(` e `t.test(`) de cada arquivo são idênticos nos dois commits, nome a nome |
| `.skip`, `.only`, `todo`, filtro, padrão | nenhum `skip`/`only`/`todo`/`--test-name-pattern` em arquivo D12 nem no executor |
| Suíte que deixou de ser importada | nenhuma: a suíte completa (`npm run test:demurrage-engine`, glob `__tests__/*.test.ts`) roda os 10 arquivos |
| Arquivo D12 alterado | só `demurrageV2Routes.test.ts` (+36/−2): cobertura acrescentada, mesmos 7 testes |
| Relatório × executor real | o relatório reproduziu o executor; o defeito era a lista de arquivos do executor |

**Comparação por arquivo** (títulos estáticos; aprovados por etapa, em cada validação):

| Arquivo | Títulos `ddc43db` | Títulos `29a3830` | Etapa D12 antes | Etapa D12 em `cc98c9a` | Etapa 02 em `cc98c9a` | Suíte completa |
|---|---|---|---|---|---|---|
| `demurrageV2Routes` | 7 | 7 | 7 | 7 | — | 7 |
| `leituraAutorizacao` | 10 | 10 | 10 | **0** | **10** | 10 |
| `leituraContrato` | 8 | 8 | 8 | 8 | — | 8 |
| `leituraD12V12` | 18 | 18 | 18 | 18 | — | 18 |
| `leituraDetalhe` | 6 | 6 | 6 | 6 | — | 6 |
| `leituraFila` | 6 | 6 | 6 | 6 | — | 6 |
| `leituraFilaV11` | 8 | 8 | 8 | 8 | — | 8 |
| `leituraFiltros` | 4 | 4 | 4 | 4 | — | 4 |
| `leituraTimeline` | 5 | 5 | 5 | 5 | — | 5 |
| `leituraTimelineV11` | 3 | 3 | 3 | 3 | — | 3 |
| **Total** | **75** | **75** | **75** | **65** | **10** | **75** |

**Correção.** O executor desta auditoria (§18.9) volta a rodar os 10 arquivos na etapa D12 e PROVA a contagem: o total da etapa precisa ser 75 e cada arquivo, rodado isolado, precisa ter exatamente a contagem congelada acima, com todos aprovados (`07b … por_arquivo_ok=1`). A etapa de autenticação não repete mais `leituraAutorizacao`. A tabela do §14.3 fica como registro histórico, com nota.

### 18.2 Avisos após reatribuição (corrige o R7)

**Defeito.** A entrega `ft_divergencia_entregas` do tipo `responsavel_operacional` era fixada no responsável do instante da ocorrência. Depois de uma reatribuição, um aviso ainda não enviado saía para o responsável ANTERIOR, que continuava membro ativo da organização. Provado: com o código de `29a3830`, 8 dos 10 testes novos falham.

**Regra implementada** (migration aditiva **0050** + `freeTime/divergenciaAvisos.ts` + `responsavel/atribuirResponsavel.ts`):

- **Reatribuição vale imediatamente.** `atribuirResponsavel`, na própria transação, sob `lockProcesso` e o `FOR UPDATE` do processo, chama `redirecionarAvisosDoResponsavelComClient`. Quando a reatribuição comita, as entregas não enviadas do anterior já são `SUPERADA` (motivo `responsavel_reatribuido` ou `sem_responsavel`, instante, `substituida_por_id`) e a do atual existe. Escritas diretas em `processos` (handoff, operador) são alcançadas pelo worker no passo seguinte.
- **Revalidação no envio.** Depois do claim, o worker abre uma transação curta sob `lockProcesso` com a linha do processo em `FOR SHARE`, que serializa com a atribuição. Nela re-confirma:
  - a posse (`claim_token`);
  - a mesma organização da entrega, do processo e do membership;
  - o membership ativo e com o papel do tipo da entrega;
  - para o responsável, que ele ainda é o responsável.

  Só então grava `envio_confirmado_em` e comita. O envio externo continua fora de qualquer transação ou lock (desenho dos avisos preservado).
- **Destinatário mudou → invalida e recria de forma auditável.**
  - SUPERADA mais o evento append-only `aviso_redirecionado` (`de`, `para`, `entregasSuperadas`, `convertidasParaGestor`, `orfasAtendidas`, `entregaDestino`, `destino`).
  - Cria a entrega do atual, ou reativa a que ele já tinha e que fora superada (ida e volta A→B→A), preservando as tentativas dela.
  - Pelo UNIQUE `(divergencia, ocorrencia, membership)` há no máximo uma entrega por pessoa por ocorrência: reatribuições em sequência nunca multiplicam linhas nem entram em laço.
- **O tipo segue o papel** (revisão adversarial):
  - o responsável anterior que continua MANAGER/ADMIN ativo NÃO perde o aviso: a entrega dele vira a de gestor;
  - o novo responsável que só tinha a entrega de gestor, ainda não enviada (por exemplo, rebaixado a ANALYST), passa a tê-la como entrega de responsável.
- **Retirada seguida de atribuição** (A → sem responsável → A ou C): a LACUNA é atendida pela entrega do novo responsável. Lacuna é a ocorrência vigente que passou por "sem responsável" (evento `aviso_redirecionado` com destino `sem_responsavel`) e não tem entrega de responsável não superada, inclusive quando a do anterior virou a de gestor dele (2ª rodada da revisão). Uma lacuna que o novo responsável já recebeu, como gestor, não é reprocessada.
- **Divergência resolvida ou ocorrência anterior:** a entrega do anterior é encerrada (SUPERADA, `ocorrencia_encerrada`) e nenhuma nova é criada. Uma reatribuição nunca cria aviso de divergência encerrada, nem deixa linha que o claim reivindique a cada execução.
- **Nunca para desativado, removido ou de outra organização.**
  - O claim exige destinatário elegível agora.
  - A revalidação devolve a posse (`devolvidas`) sem consumir a tentativa: `tentativas` volta exatamente ao valor de antes do claim.
  - O FK composto `(destinatario_membership_id, organization_id)` recusa o cruzamento no banco.
- **Idempotência e limite.**
  - A **tentativa é contada na confirmação**, quando o envio é decidido, e não no claim (revisão adversarial). Reivindicar e depois superar, devolver ou redirecionar nunca grava uma tentativa que não aconteceu. Antes, cada redirecionamento pelo worker somava +1 na entrega superada, e uma ida e volta podia deixar o responsável atual esgotado sem ter recebido.
  - A entrega no limite de tentativas ainda é redirecionada: o claim inclui "precisa redirecionar" sem olhar as tentativas.
  - Ela nunca é enviada de novo, nem quando o destinatário voltou a ser o responsável, nem quando a posse venceu antes da confirmação.
  - Só passa do limite a recuperação de uma posse vencida cujo envio JÁ tinha sido confirmado ("ao menos uma vez", comportamento anterior).
  - A entrega reativada continua contada no limite (`FAILED` se já houve tentativa).
  - Falha do redirecionamento faz ROLLBACK e devolve a posse: nunca consome a última tentativa. A próxima execução refaz.
- **Ponto de linearização** = a confirmação sob o lock.
  - Reatribuição que comita **antes** dela: o anterior nunca recebe e o atual recebe.
  - Reatribuição que comita **depois**: o envio já foi decidido enquanto a pessoa era a responsável. A entrega dela é o aviso de responsável da ocorrência, como uma já `SENT`, e nenhuma nova é criada; o novo responsável vê a divergência aberta na própria fila (`free_time_divergencia`). Se esse envio falhar, a entrega volta `FAILED` endereçada ao anterior e a próxima execução a redireciona ao atual.
  - Em qualquer ordem: no máximo um aviso de responsável entregue por ocorrência, e ninguém recebe a mesma ocorrência duas vezes.
- **Constraints da 0050.**
  - Coerência de SUPERADA: motivo, instante e a substituta diferente de si mesma.
  - Só a entrega do tipo responsável pode ser superada; a de gestor segue o papel.
  - `envio_confirmado_em` só existe na posse em que foi feito. É um **gatilho**, e não CHECK, para o deploy poder ser revertido: o código anterior à 0050 não conhece a coluna, e o gatilho apaga a confirmação herdada em vez de abortar o claim, a finalização ou a devolução dele (revisão adversarial).

**Testes** (`__tests__/avisosReatribuicaoP1.test.ts`, banco real, transporte falso que registra cada envio):

| # | Caso | Prova |
|---|---|---|
| — | imediata e auditável | sem worker: A `SUPERADA` → B `PENDING`; evento com autor |
| 1 | reatribuição ANTES do claim (serviço e escrita direta) | A nunca recebe; B e G uma vez cada |
| 2 | DEPOIS do claim e ANTES do envio (gancho entre o claim e a revalidação) | A nunca recebe; pelo serviço → `possePerdida`; direta → `redirecionadas` |
| 2b | DEPOIS da confirmação, durante o envio externo | envio decidido sai uma vez; falhou → próxima execução vai a B |
| 3 | desativação DEPOIS do claim | não envia; tentativa devolvida; reativado/reatribuído recebe |
| 4 | A→B→C e A→B→A | só o atual recebe, uma vez; ida e volta reativa (sem linha nova); 2ª execução não reenvia |
| 5 | 2 workers concorrentes + reatribuição, 6 rodadas | nenhuma entrega 2×; ninguém 2×; G 1×; exatamente um aviso de responsável; A só recebe se confirmado antes |
| 6 | no limite de tentativas | esgotada é redirecionada; reativada mantém 4 → `FAILED` 5 → não tentada mais |
| 7 | outra organização | serviço recusa; FK composto recusa processo e entrega cruzados; pessoa em 2 organizações só recebe pela do processo |
| 8 | falha do redirecionamento | tentativas intactas, `PENDING`, sem linha de B; próxima execução redireciona e B recebe |
| 9 | tentativa contada só na confirmação | redirecionar pelo worker mantém 4 reais (antes 5); de volta para A, A recebe a 5ª; PENDING 0 continua 0, sem erro inventado |
| 10 | A → sem responsável → A, e → C | a órfã é reativada ou atendida; o atual e G recebem; idempotente |
| 11 | esgotada reivindicada para redirecionar, e A volta antes da revalidação | nenhuma 6ª tentativa; continua FAILED 5 |
| 12 | o tipo segue o papel | G rebaixado e feito responsável recebe; A promovido a MANAGER e reatribuído recebe como gestor; ninguém 2× |
| 13 | divergência resolvida | A SUPERADA `ocorrencia_encerrada`, sem entrega para B, nada enviado nem reivindicado de novo |
| 14 | rollback do código | claim e finalização no estilo do código anterior nunca violam nada; a confirmação herdada é apagada |
| 15 | retirada de responsável que é GESTOR | A (MANAGER) → sem responsável → B: B recebe como responsável, A como gestor; → A e rebaixado: A recebe |
| 16 | posse vencida no limite | nunca confirmada → FAILED 5, sem 6ª tentativa; já confirmada → retomada uma vez (SENT) |

Sem a correção (`29a3830` nos dois arquivos de serviço, migration e teste novos), 8 dos 10 primeiros falham. Os casos 9 a 16 vieram das duas rodadas da revisão adversarial: cada defeito foi reproduzido pelo verificador independente no código anterior à correção, e os testes foram rodados contra essa mesma cópia (§18.8). O 5 e o 7 passam também no código antigo: o 5 prova ausência de duplicidade e linearização, que o código antigo já não violava por duplicar, e a regra "nunca ao anterior" é provada de forma determinística por 1, 2 e 2b; o 7 é regressão das FKs compostas, que já existiam. As suítes de avisos existentes (`membershipDesativadoP1`, `d15b*`, `d15c*`, `demurrageTickFilas`, `prazoFreeTimeV12`, `registroDemurrageV12`, `shippingInstructions`) passam contra o worker novo. Só duas coisas mudaram nelas: as listas de migrations incluem a 0050, e o teste "envio fora de transação" passou a medir as conexões do worker que envia (§18.8, achado 13).

### 18.3 Integração Microsoft compartilhada: veredito de isolamento

**Veredito: em `29a3830` o isolamento NÃO estava provado; ele foi refutado com dados reais.** Por isso a integração global não foi aceita como segura. Foi implementado o menor isolamento necessário: a caixa passa a ter uma organização DONA. Fica registrado um **bloqueio objetivo de deploy multiorganização** para o que esse isolamento não resolve.

**Prova da falha** (banco real, duas organizações sobre a MESMA conta de integração, teste de rascunho fora do repositório):

| Caso | O que aconteceu em `29a3830` |
|---|---|
| S1 | Uma Shipping Instruction da Org B para `IM7777-01` gravou `master_free_time_days = 21` no contêiner da **Org A**: a captura atribui todo pré-alerta da caixa à organização vinculada, e números de processo só são únicos por organização |
| S2 / S2b | SI de B sem processo em A virou `si_pendencias` e `si_intencoes` em A, com o trecho do documento de B. Quando A criou depois `IM8888-01`, a reaplicação promoveu os 30 dias de B para A |
| S3 | Um aviso de divergência de B, guardado nos Itens Enviados da caixa, passou na triagem da captura e foi registrado em A |
| S4 | O reprocessamento manual aceitou `organizationId = B` vindo do corpo: a mesma conversa ficou `DONE` em A e em B |
| V1 | Quem era a conta de integração lia a caixa inteira (todas as organizações), qualquer que fosse a organização ativa da sessão |

**O que a conta lê e envia.**

- **Escopos delegados:** `User.Read Mail.Read Mail.ReadWrite Mail.Send`, sem `*.Shared` e sem permissão de aplicação.
- **Leitura:** a caixa inteira (todas as pastas, corpo e anexos), via V1, captura e reprocessamento.
- **Envio:** os 4 avisos (tracking, pendência, divergência, fallback) e o `POST /api/emails` da V1 saem como a conta e ficam nos Itens Enviados.
- **Estado global:**
  - um único blob de tokens (`msal_cache_criptografado`) e uma conta (`msal_conta_ativa`);
  - cursores por caixa e pasta;
  - sem webhooks nem assinaturas: só polling;
  - caches em memória e arquivos `.data/*.json` da V1, sem organização.

**Como cada dado passa a ser vinculado à organização** (migration aditiva **0051** e `identidade/integracaoOrganizacao.ts`):

- **`integracao_microsoft_vinculos`:**
  - conta → organização dona, vínculo explícito do operador de plataforma (CLI `vincular-integracao-organizacao` / `desvincular-integracao-organizacao [--conta]`);
  - UNIQUE parcial: uma dona ativa por conta;
  - histórico append-only: DELETE proibido, só o desvínculo é gravado, uma vez; organização imutável.
- **Dona = vínculo ATIVO da conta ATUAL,** relido do banco a cada uso, nunca da memória do processo. Trocar a conta deixa a nova SEM dona até um vínculo novo (a chave é o `home_account_id`, então nada é herdado). Uma conta anterior com vínculo remanescente aparece no `conta-integracao` e é desvinculada com `--conta`.
- **V1** (`requireAuth`):
  - checagens, em ordem: sessão humana → membership interno ativo → integração conectada → dona vinculada → membership interno ATIVO NA DONA → token;
  - recusas: 403 `integracao_desconectada`, `integracao_sem_organizacao`, `integracao_de_outra_organizacao`, `integracao_sem_token`; nunca 401;
  - `req.integracao = {organizationId da dona, membershipId}`.
- **Captura:**
  - vincular, pausar, retomar, remover e backfill: só ADMIN ativo, e só sobre caixa da organização dona da integração ATUAL. Um vínculo remanescente de conta anterior nunca dá poder a outra organização (achado do auditor independente, corrigido; isolamento 08);
  - o ciclo pula, e marca, a caixa cuja organização não é a dona da conta;
  - a posse da dona (caixa ativa + vínculo ativo da conta para essa organização) é **relida antes de cada página e de cada gravação**, e não só no início do ciclo:
    - antes de ler o Graph;
    - travada (`FOR SHARE` no vínculo, que serializa com o desvínculo) na transação que grava a descoberta;
    - **dentro da ingestão**: depois da leitura da conversa e, travada, na transação final que grava intenções, pendências e Free Time.

    Um desvínculo durante um ciclo nunca deixa o que é lido depois dele ir para a organização anterior. Uma caixa pausada ou removida no meio da página para **sem avançar o cursor** e sem backoff, e a conversa é descoberta quando a caixa é retomada (revisão adversarial, duas rodadas);
  - na corrida de dois ADMINs da dona pela mesma caixa, só o UNIQUE parcial decide, e o perdedor recebe `409 caixa_ja_vinculada` (o código diz de quem é o vínculo vencedor);
  - vincular a dona encerra vínculos de captura legados da conta em outras organizações; desvincular encerra o da dona. Nos dois casos, `alterada_por_membership_id = NULL`: o ator é o operador;
  - respostas sem `home_account_id` nem estado de token.
- **Reprocessamento da SI:** `organizationId` do corpo precisa SER a dona (senão 403 `organizacao_nao_e_dona_da_integracao`); a autoria volta a ser a pessoa.
- **Avisos** (4 transportes): só há token quando TODO o conteúdo é da dona. Senão, a entrega falha explicitamente (`canal_de_outra_organizacao` / `integracao_sem_organizacao`, auditável) **sem chamar o Graph**. O alerta técnico global segue a mesma regra. `acquireGraphTokenForActiveAccount`, que dava token sem checagem de organização, foi removida.
- **`/api/me`:** `conexaoMicrosoft.podeUsarCaixaDaIntegracao`, com a mesma regra do guard; nunca expõe a conta nem a dona.

**Perguntas pedidas:**

- **IDs do cliente:** `organizationId`, `caixaId` e `conversationId` são sempre conferidos contra a dona (isolamento 07, 08, 10).
- **Workers:** resolvem a organização antes de persistir, e agora essa organização é a dona, nunca uma escolha do cliente.
- **Consultas sem `organizationId`:** as que restam são por id seguido de autorização, ou globais por desenho (caixa, cursor).
- **Logs:** o da captura leva só ids e códigos. O e-mail técnico global só sai com contêineres da dona.

**Testes:**

- `__tests__/integracaoMicrosoftIsolamentoP1.test.ts`: 15 testes adversariais, todos com 2 organizações sobre a MESMA integração e pelo app real (sessão, cookies e origem reais; só MSAL e Graph simulados). Contra o código de `29a3830`, 12 dos 14 originais falham; os 2 que passam cobrem só o serviço e o CLI novos.
- `capturaPreAlerta.test.ts`: mais três testes novos e um reescrito:
  - desvínculo durante o ciclo;
  - pausa durante o ciclo, sem conversa perdida;
  - desvínculo durante a ingestão, antes e dentro da transação final (o caso "dentro" falha se a checagem travada for retirada);
  - corrida real de vínculo, em 10 rodadas.

**Bloqueio objetivo de deploy multiorganização (registrado).** Com UMA caixa, só a organização dona:

- usa a V1;
- usa a captura e o reprocessamento;
- recebe avisos por e-mail.

Para as demais organizações:

- todo aviso falha com `canal_de_outra_organizacao` (FAILED, auditável, até esgotar as tentativas);
- a V1 responde 403 `integracao_de_outra_organizacao`, e o frontend congelado mostra Processos, Couriers, Demurrage V1, Auditoria, Exigem Atenção e Relatórios **vazios, sem aviso**.

Operar mais de uma organização exige uma caixa ou canal por organização, que é trabalho futuro. Até lá, **não colocar uma segunda organização em produção.**

**Riscos remanescentes** (fora do menor isolamento; ver §16):

- R15: os avisos da PRÓPRIA dona voltam pela pasta Itens Enviados como pendência de SI.
- R16: qualquer remetente externo que escreva "SHIPPING INSTRUCTIONS IMxxxx / FREE TIME MASTER: n" grava na dona (a mensagem não tem remetente verificado).
- R17: ids interpolados em caminhos do Graph na V1 (limitados à caixa pela permissão delegada).
- R18: `err.message` de 4xx do Graph ou da transportadora devolvido ao cliente (pré-existente).
- R19: stores e caches da V1 sem organização. Ao TROCAR a dona: limpar `.data/courier-*.json`, `demurrage-*.json` e reiniciar as instâncias.
- R20: membership na dona dá leitura da caixa INTEIRA e envio como ela, como em `ddc43db`.

### 18.4 Rotas V1: veredito

- **A restrição de `cc98c9a` era necessária, mas incompatível com o produto e confundia conceitos.**
  - **Necessária:** com uma caixa sem filtro por organização, liberar a V1 a todos exporia a caixa a qualquer pessoa interna de qualquer organização.
  - **Incompatível:** a regra era identidade (`sessão.homeAccountId === conta da integração`), não permissão. Analistas e gestores perderam Processos, Couriers (inclusive marcar estado, conferência e follow-up, que nem usam Graph), Demurrage V1 ("Solicitar minuta"), Auditoria, Exigem Atenção e Relatórios. Quatro dessas telas ficavam vazias em silêncio.
  - **Confusão:** operar a V1 exigia entrar na Priora COMO a conta técnica, compartilhando a credencial, e a autoria se perdia.
- **Corrigido** (sem restaurar o singleton global), com os conceitos separados:
  - identidade humana = sessão individual;
  - papel organizacional = membership interno ativo;
  - permissão operacional da caixa = membership interno ativo NA ORGANIZAÇÃO DONA;
  - administração da integração (conectar, desconectar, substituir) = administrador de plataforma.
- **A conta técnica precisa ser usuária?** Não. Ela não tem sessão nem papel; `vincular-conta-integracao` virou opcional (legado) e não é recomendado.
- **Administrador de plataforma opera dados cotidianos?** Não por esse papel: ele não lê a caixa nem dados de organização sem membership na dona (isolamento 02). O encadeamento de reconexão no login dele continua, porque é administração da integração e não acesso a dados.
- **Quem usa a V1 hoje:** todo ANALYST, MANAGER ou ADMIN ativo da organização dona, cada um com a própria sessão.
- **Demais organizações:** bloqueio do §18.3.

### 18.5 Inventário dos arquivos de `ddc43db..29a3830`

`git diff --name-status ddc43db 29a3830` lista **92** arquivos, e não 91: são 91 de código, testes e configuração mais este relatório, criado em `cc98c9a` e alterado em `29a3830`. Os 92 foram auditados por diff, um a um. A 0049 também foi aplicada num banco descartável: 0001→0048, depois 0049, depois 0049 de novo, mais o trigger de "último ADMIN".

**Por categoria:**

| Categoria | Arquivos |
|---|---|
| testes | 34 |
| filas | 19 |
| sessões | 7 |
| autenticação | 6 |
| identidade | 6 |
| ações | 6 |
| provisionamento | 4 |
| notificações | 4 |
| atribuição | 2 |
| organização | 1 |
| migrations | 1 |
| documentação | 1 |
| alteração incidental | 1 + 1 parcial |

As duas incidentais: `capturaRoutes.ts`, só comentários (#84), e a validação UUID dos filtros de Gestão (#87).

**Achados e decisão**

- **Arquivos fora de `src/demurrage-engine`:** 24, todos necessários à troca do modelo global de sessão:
  - `src/app.ts`, `src/index.ts`, `src/config.ts`, `src/types.d.ts`, `.env.example`;
  - `src/auth/*`;
  - `requireAuth`;
  - as rotas Demurrage, `trackingRoutes`, `package.json`;
  - os fixtures do D13.

  `public/` está intocado.
- **403 → 404: nenhuma.** As 404 novas são:
  - 200 → 404: ANALYST lendo processo não atribuído;
  - 401/404 HTML → 404 JSON: rota V2 inexistente;
  - 500 → 404: pendência inexistente.
- **Relaxamentos de autorização:**
  - **C1 — corrigido.** `/api/tracking` só exigia a sessão. Agora exige também membership interno ativo, relido a cada requisição (`sessaoSegurancaP1` 14).
  - **C2 — aceito e documentado (R13).** A V2 deixou de chamar a Microsoft (`acquireTokenSilent`) a cada requisição; é o objetivo da entrega. Consequência B4: desativar a conta no Entra não corta mais o acesso em cerca de 1 h. O corte é a desativação na Priora (`desativar-membro`) ou `revogar-sessoes`; a sessão vale no máximo 12 h ociosa ou 7 dias.
  - **C3 — justificado.** MANAGER/ADMIN recebem em `/filtros` todos os membros internos ativos com papel: é a lista de quem pode ser atribuído.
- **Erro que escondia falha interna:**
  - **E1/E6** (`requireAuth`: banco fora virava "integração desconectada"; falha de rede ou MSAL virava "sem token" sem log) — corrigidos no isolamento da integração (§18.3).
  - **E2** — tokens da conta recusada não removidos do cache passam a ser logados, só com o código do erro.
  - **E3** — o erro de leitura da conta conectada propaga (500), nunca uma decisão com a memória velha.
  - **E4** — a falha da purga horária de sessões é logada.
  - **E5** — o log de 5xx volta a ter os quadros da pilha, sem a linha da mensagem, que já vai truncada; corpo genérico mantido.
- **Migrations:**
  - A 0049 é aditiva, com duas ressalvas: a troca da CHECK `field_observations_fonte_check` (amplia a lista, varre o ledger sob ACCESS EXCLUSIVE) e o `CREATE OR REPLACE` da função de decisão de responsabilidade, cuja única diferença para a 0033 é `desativado_em IS NULL`.
  - Reexecução protegida pelo runner (`schema_migrations`, uma transação por arquivo).
  - Código antigo sobre a 0049: compatível. Código novo sobre banco antigo: recusa subir.
  - As 0050 e 0051 desta auditoria são aditivas.
- **Contratos públicos alterados sem compatibilidade:**
  - **B1 — documentado.** Sete cursores mudaram de versão: `d12.fila.v1.3`, `p1e3.minutas.v4`, `p1e3.reaberturas.v3`, `p1e3.pendencias.v3`, `d14.gestao.responsabilidade.decisoes.v2`, `d14.gestao.composicao.v3`, e o novo `p1.pendencias.lista.v1`. Cursor emitido antes do deploy → `400 cursor_invalido`; o frontend reinicia a lista.
  - **B2 — documentado.** Gestão com filtro UUID malformado passa de 500 para 400.
  - **B5 — documentado.** CLIENT recebe 403 em `/api/captura/status`.
  - **B6 — documentado.** `/filtros.responsaveis` passa a ser "atribuíveis" e não "responsáveis na apuração pedida".
  - **B8 — documentado no cabeçalho e no §12.** A atribuição interna tem precedência sobre o responsável enviado pelo handoff.
  - **B11/B12 — menores.** `GET /api/me` encerra sessão já inválida; `username` cai para o nome sem UPN.
  - **B15 — aceito.** ANALYST recebe 404 na leitura e `403 ator_nao_responsavel` na ação de processo não atribuído. O id é UUID não adivinhável, dentro da própria organização, e o código da ação diz exatamente o que falta.
- **Testes modificados para aceitar comportamento incorreto: nenhum.**
  - Nenhum `skip`/`only`/`todo` novo; 17 linhas de asserção removidas contra 675 adicionadas, todas conferidas.
  - Os trechos que mudam a cobertura estão justificados: H1 (schema antigo), H2 (eco do filtro) e H4 (setup).
  - Os que pediam reforço foram reforçados:
    - H3/H6/B9: teste negativo do D10 — ANALYST como autor de `manual_fallback` num processo que a entrada cria é recusado sem criar nada;
    - H5: o helper de minuta recusa responsável prévio que não seja ANALYST.
- **Defeito em código próprio (B7) — corrigido.** A devolução da posse, ao voltar a PENDING, fazia "menos uma tentativa". Numa posse vencida recuperada no limite, o `LEAST` do claim não incrementa, e a devolução dava uma tentativa a mais. Agora restaura exatamente o valor de antes do claim, e no limite deixa `FAILED` contada em `esgotadas` (nunca um PENDING que nenhum claim alcança). Vale nos três workers de aviso, com testes em `membershipDesativadoP1` e `avisosReatribuicaoP1` 6(c).
- **Comentário errado (I9) — corrigido.** `atribuirResponsavel.ts` dizia que a 0049 barra membership inativo; quem barra é o serviço.

**Tabela completa (92 arquivos):**

| # | Arquivo | St | Categoria | O que mudou | No relatório anterior | Decisão nesta auditoria |
|---|---|---|---|---|---|---|
| 1 | `.env.example` | M | sessões / documentação | Documenta `SESSION_SECRET` obrigatório em produção, `SESSION_MAX_AGE_DAYS` (7), `SESSION_IDLE_HOURS` (12) e `PRIORA_ORIGENS_PERMITIDAS` | Sim §13.2 | — |
| 2 | `docs/demurrage-producao-p1-autenticacao-filas.md` | A | documentação | Relatório da entrega, mais o registro da validação em worktree limpo | (é o relatório) | Ressalva do handoff (B8) acrescentada ao cabeçalho e ao §12. |
| 3 | `package.json` | M | provisionamento | Script `demurrage:provisionar` | Sim §8 | — |
| 4 | `src/app.ts` | A | sessões / autenticação | Montagem HTTP saiu de `index.ts`. Store PostgreSQL, cookie `__Host-`, logout por `GET /Login.dc.html` (L154-164), estáticos antes da sessão (L167), CSRF (L175), V2 com `requireSessao` (L200-207), 404 JSON em `/api/demurrage/v2/*` (L210), tratador de erro genérico para ≥500 (L220-226), purga horária (L127) | Sim §3.3-3.5 | E4 (purga silenciosa) e E5 (pilha perdida no log de 5xx) corrigidos nesta auditoria. |
| 5 | `src/auth/authRoutes.ts` | M | autenticação / identidade | Reescrito. PKCE, state e nonce; o callback regenera a sessão e nunca chama `connectMicrosoftAccount`; logout encerra só a própria sessão; novas rotas `/auth/integracao/*` restritas a administrador de plataforma; o texto de erro da Microsoft não é mais exibido | Sim §3.1-3.3 | D1 corrigido: reconferência dos memberships depois de gravar a sessão. |
| 6 | `src/auth/origemConfiavel.ts` | A | autenticação | CSRF em `/api` e `/auth`: escrita com cookie e sem `Origin`/`Referer` vira `403 origem_nao_permitida` | Sim §3.5 | 403 novo documentado (§3.5). |
| 7 | `src/auth/provedorIdentidade.ts` | A | autenticação / identidade | Separa o cliente MSAL descartável do login de pessoa (`User.Read`) da integração (cliente compartilhado, conta esperada, nonce) | Sim §3.1-3.2 | E2 (falha ao remover tokens recusados agora é logada) e E3 (erro de leitura propaga) corrigidos. |
| 8 | `src/auth/sessaoHumana.ts` | A | sessões / identidade | Resolve a identidade por requisição, `requireSessao` (401), memberships internos ativos, capacidades e escopos | Sim §3.5, §6 | Por desenho: `requireSessao` só prova a sessão; papel e membership são relidos por quem autoriza (`autorizarInterno`, V1, tracking — C1 corrigido). |
| 9 | `src/auth/sessaoStore.ts` | A | sessões | Store PostgreSQL: sid em SHA-256, expiração no servidor, `set`/`touch` só em linha viva, revogação, purga | Sim §3.4 | Por desenho (o chamador confere `sessaoViva`). |
| 10 | `src/auth/transacaoOAuth.ts` | A | autenticação | Cookie de transação OAuth assinado, 10 min, uso único | Sim §3.1 | — |
| 11 | `src/config.ts` | M | sessões | Vida da sessão passa de 30 dias deslizantes para 7 dias absolutos, mais ociosidade de 12 h; leitura robusta do ambiente | Sim §3.4 (o valor antigo está em §2.2) | — |
| 12 | `__tests__/acoesPessoaisP1.test.ts` | A | testes (ações) | 11 testes da matriz de ações | Sim §14.1 | Teste negativo do D10 acrescentado (ANALYST em processo novo → recusa). |
| 13 | `__tests__/autenticacaoFilasP1.test.ts` | A | testes (sessões) | 42 testes sobre o app real | Sim §14.1 | `/api/tracking` coberto em `sessaoSegurancaP1` 14. |
| 14 | `__tests__/closing.test.ts` | M | testes | Setup atribui o analista | Sim §14.2 | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 15 | `__tests__/closingD15A.test.ts` | M | testes | Atribuição em #6 e #7 | Sim §14.2 | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 16 | `__tests__/closingD15AV11.test.ts` | M | testes | Atribuição antes da corrida (#2) | Sim §14.2 | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 17 | `__tests__/d15b.test.ts` | M | testes | R56: responsável muda de `mResp` para `mAnalyst` | Parcial | Setup (justificado: o responsável precisa ser ativo para a regra nova). |
| 18 | `__tests__/d16Vertical.test.ts` | M | testes | Cabeçalho reescrito; helper `processoAtribuidoA` (INSERT direto) em #14 e #21; atribuição em #12 | Parcial | Setup (H3): consequência da regra B9; teste negativo dedicado acrescentado. |
| 19 | `__tests__/demurrageAcoesEntrega2.test.ts` | M | testes | Atribuições em 11 testes | Sim §14.2 | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 20 | `__tests__/demurrageAcoesEntrega2V11.test.ts` | M | testes | Atribuições; 0049 vira a última migration | Sim | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 21 | `__tests__/demurrageAcoesEntrega2V12.test.ts` | M | testes | Atribuições; `membroDireto` (L162); 0049 vira a última | Sim | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 22 | `__tests__/demurrageTickFilas.test.ts` | M | testes | `registroComFallback` cria o processo já atribuído (L83) | Parcial | Setup (H3), idem. |
| 23 | `__tests__/demurrageV2Routes.test.ts` | M | testes | Atribuições; 404 entre organizações repetido com MANAGER | Sim §14.2 | Reforço de cobertura. |
| 24 | `__tests__/filasPessoaisLeituraP1.test.ts` | A | testes (filas) | 14 testes | Sim | — |
| 25 | `__tests__/gestaoRoutes.test.ts` | M | testes | ANALYST com dados reais, comparado com o MANAGER (L173) | Sim §14.2 | Reforço de cobertura. |
| 26 | `__tests__/gestaoV13.test.ts` | M | testes | O `deepEqual` de isolamento passa a mascarar o eco `filtros.processo` (L325-334) | Não | Justificado (H2): o eco `filtros.processo` é o parâmetro do próprio chamador, conferido à parte. |
| 27 | `__tests__/leituraOperacionalEntrega3.test.ts` | M | testes | Atribuições; `escopo` MINHA_FILA; reforços com MANAGER em #5, #15 e #19 | Sim | Reforço de cobertura. |
| 28 | `__tests__/leituraOperacionalEntrega3V11.test.ts` | M | testes | Pino de versão refeito (L429); filtro de consulta de autorização (L461) | Sim §14.2 | Conferido: o filtro não é amplo demais. |
| 29 | `__tests__/membershipDesativadoP1.test.ts` | A | testes (notificações) | 10 testes | Sim | — |
| 30 | `__tests__/migrate.test.ts` | M | testes (migrations) | Lista de migrations inclui a 0049 | Sim | — |
| 31 | `__tests__/migration0007.test.ts` | M | testes (migrations) | Tabelas novas na checagem de `organization_id` imutável | Parcial | Reforço de cobertura. |
| 32 | `__tests__/minutaEncerramentoP1.test.ts` | M | testes | Atribuições; `escopo` MINHA_FILA (L411, L670); upgrade aplica 0048 e 0049 | Sim | — |
| 33 | `__tests__/minutaTestHelper.ts` | M | testes (helper) | O ator passa a ser o responsável existente; se não houver, cria um ANALYST e grava por UPDATE direto (L26-41) | Sim §14.2 | Reforçado (H5): o helper recusa responsável prévio que não seja ANALYST. |
| 34 | `__tests__/registroDemurrage.test.ts` | M | testes | A varredura estática também cobre `src/app.ts` | Sim | Reforço de cobertura. |
| 35 | `__tests__/registroDemurrageV11.test.ts` | M | testes | Processo `IM-POS-MANUAL` criado antes e atribuído (L364) | Parcial | Setup (H3), idem. |
| 36 | `__tests__/registroDemurrageV12.test.ts` | M | testes | `processoAtribuidoA` em 5 testes; §2 só atribui o ANALYST (L207); 0049 nas listas | Parcial | Setup (H3/H6), idem. |
| 37 | `__tests__/responsabilidadeAuditoria.test.ts` | M | testes (migrations) | Scaffold `desativado_em` no schema 0033 (L135) | Sim §14.2 | — |
| 38 | `__tests__/responsabilidadeV11.test.ts` | M | testes (migrations) | Scaffold `desativado_em` (L644) | Sim | — |
| 39 | `__tests__/responsabilidadeV12.test.ts` | M | testes (migrations) | Scaffold (L533) e lista | Sim | — |
| 40 | `__tests__/responsavelOperacional.test.ts` | M | testes (migrations) | Lista inclui a 0049 | Sim | — |
| 41 | `__tests__/schedulerClaimFencing.test.ts` | M | testes (migrations) | Lista inclui a 0049 | Sim | — |
| 42 | `__tests__/shippingInstructions.test.ts` | M | testes | A checagem funcional de envio vai para depois de migrar até a última (L761-766) | Sim §14.2 | Justificado (H1): o serviço passou a exigir a 0049; a checagem de boot cobre o schema antigo. |
| 43 | `__tests__/testDb.ts` | M | testes (infra) | Truncate das 4 tabelas novas; helpers de atribuição por UPDATE direto (L65) | Sim | Helpers de teste por UPDATE direto (só setup; o caminho de produção é o serviço, testado à parte). |
| 44 | `acoes/minutaIdempotencia.ts` | M | ações | O tipo de resultado ganha `ator_nao_responsavel` | Não (implícito) | Incidental mínima, necessária ao typecheck (I4). |
| 45 | `closing/closingService.ts` | M | ações / identidade | `resolverAtor` exige membership ativo; ANALYST só solicita reabertura no processo atribuído (L568) | Sim §10.2, §11 | — |
| 46 | `closing/minutaTecnica.ts` | M | ações | Ator ativo; ANALYST só registra no processo atribuído, antes do replay (L436) | Sim | — |
| 47 | `db/migrations/0049_sessoes_identidade_atribuicao.sql` | A | migrations | Ver §7 | Sim §5 | Aditiva com duas ressalvas (troca de CHECK com varredura do ledger; função de trigger recriada só com `desativado_em`) — documentadas no §18.5; reexecução protegida pelo runner. |
| 48 | `domain/types.ts` | M | atribuição | Fonte `atribuicao_interna` com prioridade 1000 (L53) | Sim §5.8, §9 | Precedência sobre o handoff (B8) documentada também no cabeçalho. |
| 49 | `freeTime/divergenciaAvisos.ts` | M | notificações / identidade | Autor ativo; claim só de destinatário ativo; ao devolver a posse, devolve a tentativa (L199-209) | Sim | Restauração da tentativa refeita EXATA (nesta auditoria); redirecionamento ao responsável atual (0050). |
| 50 | `freeTime/masterFreeTimeService.ts` | M | notificações | Fan-out só para responsável e gestores ativos | Sim (T17) | — |
| 51 | `identidade/cli.ts` | A | provisionamento | CLI do operador de plataforma | Sim §8 | — |
| 52 | `identidade/provisionamento.ts` | A | provisionamento | Serviço com as regras e as trilhas | Sim §8 | — |
| 53 | `leitura/autorizacao.ts` | M | organização / identidade | Organização ativa da sessão; `403 membership_inativo`; caminho de compatibilidade de teste (L137) | Sim §3.5, R11 | — |
| 54 | `leitura/contrato.ts` | M | filas (contrato) | Remove `ESCOPO_FILA_DA_EQUIPE`; `MetaEscopo`, `FiltrosAtivos` (L516), `responsavelOperacional.ativo`, `responsaveis[].papel`, códigos de erro novos | Parcial | Remoção de `ESCOPO_FILA_DA_EQUIPE` e campos aditivos documentados (§18.5, contratos). |
| 55 | `leitura/detalhe.ts` | M | filas | Responsável no WHERE: fora do escopo dá 404; campo `ativo` | Sim | — |
| 56 | `leitura/documentoMinuta.ts` | M | filas | Responsável no WHERE | Sim | — |
| 57 | `leitura/escopoFila.ts` | A | filas | Resolução de escopo e predicados SQL | Sim §10.1 | — |
| 58 | `leitura/filaOperacional.ts` | M | filas | Predicado de escopo; cursor `v1.2`→`v1.3` (L64); meta de escopo; `temProxima` | Parcial | Cursor `v1.2`→`v1.3` documentado (B1). |
| 59 | `leitura/filtros.ts` | M | filas | Opções no escopo; `responsaveis` por papel com todos os ativos e `papel`, sem filtro de apuração (L194-200) | Parcial | C3 justificado (é a lista de quem pode ser atribuído) e B6 documentado. |
| 60 | `leitura/gestao/drilldown.ts` | M | filas | Escopo em toda composição; cursor `v2`→`v3` (L55) | Parcial | Cursor documentado (B1). |
| 61 | `leitura/gestao/eficiencia.ts` | M | filas | Escopo em todos os indicadores | Sim | — |
| 62 | `leitura/gestao/financeiro.ts` | M | filas | Escopo na seleção e nas somas | Sim | — |
| 63 | `leitura/gestao/operacional.ts` | M | filas | Escopo como condição de processo; fatia de parâmetros refeita | Sim | — |
| 64 | `leitura/gestao/qualidade.ts` | M | filas | Escopo nas métricas | Sim | — |
| 65 | `leitura/gestao/responsabilidade.ts` | M | filas | Escopo no resumo e no detalhe; cursor de decisões `v1`→`v2` (L90); eco de filtros (L213) | Parcial | Cursor (B1) e eco de filtros (B13) documentados. |
| 66 | `leitura/gestao/selecaoFinanceira.ts` | M | filas | Opção de escopo | Sim (implícito) | — |
| 67 | `leitura/minutasOperacionais.ts` | M | filas | Escopo; cursor `v3`→`v4` (L51) | Parcial | Cursor documentado (B1). |
| 68 | `leitura/pendenciasOperacionais.ts` | M | filas | Escopo; cursor `v2`→`v3` (L59); lista nova `GET /pendencias` (L61) | Sim §10.1 | Cursor e lista nova documentados. |
| 69 | `leitura/reaberturasOperacionais.ts` | M | filas | Escopo; cursor `v2`→`v3` (L60) | Parcial | Cursor documentado (B1). |
| 70 | `leitura/timeline.ts` | M | filas | `responsavelExigido` | Sim | — |
| 71 | `persistence/vesselCallRepository.ts` | M | identidade | Autor ativo na pendência de escala | Parcial (T17) | — |
| 72 | `registro/avisosFallbackManual.ts` | M | notificações | Claim e detalhe só para gestor ativo; devolve a tentativa (L136-146) | Sim | B7 corrigido: devolução restaura a tentativa exata; no limite vira FAILED contada. |
| 73 | `registro/notificacaoPendencia.ts` | M | notificações | Fan-out e claim só para ativo; devolve a tentativa também no caminho já existente de "papel rebaixado" (L150-158) | Parcial | B7 corrigido, idem; mesma classe de defeito do caminho de papel rebaixado (I3, justificado). |
| 74 | `registro/pendencias.ts` | M | ações | Nova ordem de lock; autor ativo; `ATOR_NAO_RESPONSAVEL` (L125) | Sim §11 | — |
| 75 | `registro/registrarProcessoDemurrage.ts` | M | ações / notificações | Autor de `manual_fallback` reautorizado sob lock e no replay (L526-542, L590-606); aviso só a gestores ativos | Sim §11 | B9 coberto por teste negativo. |
| 76 | `responsabilidade/decidirResponsabilidade.ts` | M | identidade | Autor ativo | Sim | — |
| 77 | `responsavel/atribuirResponsavel.ts` | A | atribuição | Compare-and-set, idempotência e trilha | Sim §9 | Comentário corrigido (I9). |
| 78 | `scheduler/trackingScheduler.ts` | M | identidade | `solicitarAtualizacaoManual` exige membership ativo | Parcial (T17) | — |
| 79 | `shippingInstructions/capturaPreAlerta.ts` | M | identidade | `membro()` só aceita interno ativo, ou seja, exclui também CLIENT (L140-147) | Parcial (só a parte de desativado) | Exclusão de CLIENT documentada (B5/I8, justificada). |
| 80 | `frontend-tests/demurrageV2UiZeroWrite.test.ts` | M | testes | Atribui os dois processos | Parcial §17 | Só setup (atribui o ANALYST; a regra verificada não muda). |
| 81 | `frontend-tests/fixtures/demurrageV2Fixtures.ts` | M | testes | `escopo` `fila_da_equipe`→`EQUIPE` | Sim §17 | — |
| 82 | `src/index.ts` | M | sessões | Usa `criarApp()`; `verificarTabelaDeSessoes()` antes do boot | Sim §3.4, §13 | Menor: `verificarTabelaDeSessoes` funde "ausente" e "sem acesso" na mensagem — aceito. |
| 83 | `src/middleware/requireAuth.ts` | M | autenticação | Guard V1: sessão, membership, pessoa = conta da integração; problemas da integração dão 403 com `codigo` (L74-86) | Sim §3.5, R1 | E1/E6 tratados no isolamento da integração (§18.3). |
| 84 | `src/routes/capturaRoutes.ts` | M | **alteração incidental** (identidade) | Só comentários (L31-34, L60) | Não | Incidental (I1): só comentários precisos — mantido. |
| 85 | `src/routes/demurrageAcoesRoutes.ts` | M | ações / atribuição | `requireSessao`; fallback recusado 400→403 (L151-155); erros de pendência 500→4xx (L405-413); rota nova `POST /processos/:id/responsavel` (L425) | Sim §9, §11 | Mudanças de status documentadas (§11, §18.5). |
| 86 | `src/routes/demurrageAdminRoutes.ts` | A | provisionamento | `/admin/membros`, só ADMIN (L49) | Sim §8 | Privilégio novo documentado (§8). |
| 87 | `src/routes/demurrageGestaoRoutes.ts` | M | filas / **incidental** | `requireSessao`; escopo; `cliente`, `armador`, `tipoEquipamento` e `responsavel` validados como UUID (L67-91) | Parcial | Incidental (I2): validação UUID dos filtros de Gestão, 500→400 — mantido e documentado (§12). |
| 88 | `src/routes/demurrageV2Routes.ts` | M | filas | `requireSessao`; escopo; 404 fora do escopo (L120, L138, L155, L204, L288); `GET /pendencias` (L225) | Sim | — |
| 89 | `src/routes/meRoutes.ts` | A | identidade / organização | `/api/me` com contrato `priora.me.v2`; `POST /api/me/organizacao` | Sim §6, §7 | B11/B12 documentados (menores). |
| 90 | `src/routes/processRoutes.ts` | M | identidade | Reprocessar SI exige membership ativo | Sim §15.1 | — |
| 91 | `src/routes/trackingRoutes.ts` | M | autenticação | `requireAuth` trocado por `requireSessao` (L40-42) | Parcial (só listado em §3.5) | C1 corrigido: exige membership interno ativo, relido a cada requisição. |
| 92 | `src/types.d.ts` | M | sessões | `SessionData` versão 2 | Sim §3.1 | — |

### 18.6 Segurança das sessões

Uma revisão dedicada mapeou cada item a mecanismo, evidência e teste, e escreveu `__tests__/sessaoSegurancaP1.test.ts` (16 testes, banco real e app real). Antes de aceitar a suíte, 15 defeitos artificiais foram injetados numa cópia do código, e todos foram detectados por asserção:

- linha revogada ressuscitada pelo `set`;
- sid em claro em `dados`;
- login sem `regenerate`;
- CSRF aceitando escrita com cookie sem Origin;
- cookie sem HttpOnly;
- touch sem intervalo mínimo;
- touch sem limite absoluto;
- purga ignorando revogadas;
- remoção do cookie sem Secure;
- log com `originalUrl`;
- papel em cache na sessão;
- identidade sem conferir `home_account_id`;
- troca de organização com `regenerate`;
- desativação sem revogar sessões;
- servidor adotando id do cliente.

| # | Item | Mecanismo (evidência) | Teste |
|---|---|---|---|
| 1 | Proteção do identificador | sid de 192 bits, cookie assinado HMAC-SHA256; o banco guarda só o SHA-256 (`sessaoStore.ts`, `CHECK ^[0-9a-f]{64}$`); `dados` só com a identidade, `{}` ao revogar | seg 01: varre TODAS as tabelas atrás de sid, cookie, assinatura, segredo |
| 2 | Expiração e limpeza | `expira_em = LEAST(agora+12 h, autenticadoEm+7 d)` no servidor; touch ≤1×/min; purga horária idempotente, agora logada se falhar | seg 02, 03 |
| 3 | Revogação | logout estrito; `revogarSessoesDoUsuario` na desativação do último acesso, no desvínculo e em `revogar-sessoes` (com trilha) | seg 04, 11 |
| 4 | Rotação no login | `regenerate` depois de validar transação e memberships: o sid anterior fica revogado | seg 05 |
| 5 | Sem session fixation | cookie não assinado, mal assinado ou de outro segredo é ignorado; sid desconhecido nunca é adotado, mesmo assinado com o segredo real; sem sessão antes do login; `__Host-` em produção | seg 05, 07 |
| 6 | CSRF em mutação por cookie | `origemConfiavel` em `/api` e `/auth` mais `SameSite=Lax`; "Sair" só por navegação da própria origem | seg 06: 10 rotas × 9 variantes = 90 recusas, sem efeito colateral |
| 7 | Atributos do cookie | dev: HttpOnly, Lax, `Path=/`. Produção: `__Host-priora.sid`, Secure, HttpOnly, Lax, `Path=/`, sem Domain, também na remoção. Sem HTTPS em produção nenhum cookie sai | seg 07 |
| 8 | Nada em URL ou log | redirecionamentos fixos; o authorize leva só o desafio S256; logs com `errorCode` e `req.path` sem query; MSAL sem PII | seg 08 |
| 9 | Múltiplas instâncias | store PostgreSQL compartilhado, nenhum estado de usuário em memória | seg 09; seg 02 (purgas simultâneas) |
| 10 | Troca de organização segura | grava na MESMA linha com `set` só em linha viva e confere `sessaoViva` (senão 401); a organização é revalidada a cada requisição | seg 10 (concorrência real, sem injeção; reintroduzir o `regenerate` falha na 1ª rodada) |
| 11 | Revogada nunca renasce | `get` filtra; `set`/`touch` só em linha viva; linha revogada mantida 30 dias | seg 11, 04, 05 |
| 12 | Papel e desativação imediatos | papel nunca fica na sessão; relido a cada requisição e sob lock nos serviços | seg 12; seg 13–16 |

**Defeito encontrado (D1, baixo) — corrigido.**

- **Cenário:**
  1. O callback confere os memberships.
  2. Nesse instante, o último acesso interno da pessoa é desativado, e a desativação revoga "todas as sessões" depois do COMMIT, antes de esta existir.
  3. A sessão nasce viva.
- **Efeito:** a sessão era aceita onde só `requireSessao` valia (o rastreio). Numa reativação posterior, dava acesso total sem novo login.
- **Correção:** reconferir os memberships logo depois de gravar a sessão; se não houver nenhum, encerrar a sessão e responder 403.
  - Reconferência que ainda vê o acesso: a revogação da desativação, posterior ao COMMIT dela, alcança a linha já gravada.
  - Reconferência que não vê: a própria sessão é encerrada.
- **Testes:** seg 13 fixa a janela de forma determinística no `set` do store e falha sem a correção (302 em vez de 403). Seg 14 cobre o C1 e falha sem a correção (503 em vez de 403).
- **Ampliada na revisão adversarial final:**
  - a reconferência relê também o **vínculo da identidade** (`usuarios.home_account_id`), porque um desvínculo concorrente deixava nascer uma sessão que um novo vínculo reativava (seg 15);
  - a reconferência **falha fechada**: um erro de banco nela encerra a sessão, e o 500 sai sem Set-Cookie de sessão viva (seg 16).

**Observações informativas, não defeitos:**

- Em HTTP local de desenvolvimento, o cookie não tem o prefixo `__Host-`.
- Duas trocas simultâneas de organização da mesma sessão: vale a última gravação, e o `/api/me` seguinte é coerente.
- Diferença de relógio entre instâncias desloca a vida absoluta. `SESSION_SECRET`, `SESSION_IDLE_HOURS` e `SESSION_MAX_AGE_DAYS` precisam ser iguais em todas as instâncias.
- `GET /auth/integracao/conectar` vindo de outro site só (re)conecta a própria conta do administrador.

### 18.7 Testes existentes alterados nesta auditoria

Toda alteração traz no próprio código o comentário `Produção P1 (auditoria final…)` ou `Produção P1 (integração de plataforma)`. Nenhum `skip`, `only` ou `todo`, e nenhuma asserção financeira, de máquina de estados, de idempotência, de concorrência ou do handoff foi removida ou afrouxada.

| Arquivo | Mudança | Por quê |
|---|---|---|
| `capturaPreAlerta.test.ts` | `orgComAdmin` grava o vínculo de dona da conta da organização. "A conta da sessão precisa ser a caixa" foi reescrito como "a caixa é a da integração e a organização precisa ser a dona; a pessoa não precisa ser a conta". Vincular a B com dona A passa de `409 caixa_vinculada_a_outra_organizacao` a `403 organizacao_nao_e_dona_da_integracao` (o UNIQUE parcial continua no banco). Pausar, retomar e remover passam a exigir ADMIN da dona; três testes conectam a conta como integração atual (`conectarComoIntegracao`) | regra nova do §18.3 (a regra antiga é justamente a que o produto pediu para separar) |
| `shippingInstructions.test.ts` | o handler de reprocessar recebe `organizacaoDona` = a organização do teste | o `organizationId` do corpo precisa ser a dona |
| `autenticacaoFilasP1.test.ts` | só o teste "extra. V1": sem sessão → 401; desconectada → `integracao_desconectada`; sem dona → `integracao_sem_organizacao`; membro da dona → passa a regra de organização; membro de outra → `integracao_de_outra_organizacao` | regra nova do §18.4 |
| `membershipDesativadoP1.test.ts` | o setup da captura grava a dona e a conecta como integração atual; o backfill recebe `req.integracao`; o reprocessamento recebe `organizacaoDona`; **mais 2 testes** (posse vencida no limite, pendência e fallback) | §18.3 / B7 |
| `capturaPreAlerta.test.ts` (2) | **mais 3 testes** (desvínculo e pausa durante o ciclo, desvínculo durante a ingestão); a corrida antiga, que não exercitava corrida, foi reescrita como corrida real (2 ADMINs da dona × 10 rodadas) | §18.3 / §18.8 |
| `shippingInstructions.test.ts` (2) | "Avisos: envio fora de transação" mede só as conexões do worker que ENVIA (pool próprio + `application_name`), com a mesma regra estrita (transação ou lock consultivo aberto = falha) | §18.8, achado 13 |
| `acoesPessoaisP1.test.ts` | **mais 1 teste** (D10: ANALYST em processo novo é recusado, sem criar nada) | H3/H6/B9 |
| `minutaTestHelper.ts` | recusa responsável prévio que não seja ANALYST | H5 |
| `testDb.ts` | `truncateAll` inclui `integracao_microsoft_vinculos` | tabela nova |
| `migrate`, `responsavelOperacional`, `registroDemurrageV12` (×2), `responsabilidadeAuditoria`, `responsabilidadeV12`, `schedulerClaimFencing`, `demurrageAcoesEntrega2V11`, `demurrageAcoesEntrega2V12`, `minutaEncerramentoP1` | listas de migrations com 0050 e 0051 (aditivas) | migrations novas |
| `d15c.test.ts`, `schedulerClaimFencing.test.ts` (helper `comBancoTemporario`) | depois de `pool.end()`, espera (até 5 s) os backends do próprio pool saírem, e só então encerra o resto e apaga o banco temporário | corrida pré-existente desde a D15-C v1.1 (`0a0ee9c`). O `end()` do pg-pool 3.14 resolve antes de os sockets fecharem, e o `pg_terminate_backend` seguinte entregava o FATAL 57P01 a um cliente sem ouvinte de erro: uma exceção não capturada derrubou o D15-C #25 na 1ª validação limpa (§18.9). Nenhuma asserção mudou |
| `migration0007.test.ts` | `integracao_microsoft_vinculos` entra em `TABELAS_COM_ORG` (tem `organization_id` e o trigger de imutabilidade) | tabela nova |

### 18.8 Revisão adversarial final (antes do commit)

Cinco lentes revisaram todo o diff desta auditoria sobre `29a3830`: avisos, integração, sessão, integridade dos testes e migrations/implantação. Cada achado foi verificado por um cético independente que tentou refutá-lo, com reprodução num banco real e numa cópia do código. **1ª rodada: 13 confirmados — todos corrigidos e cobertos por teste; 6 refutados.**

| # | Achado confirmado | Sev. | Correção | Teste |
|---|---|---|---|---|
| 1 | O +1 de tentativas do claim ficava na entrega superada; numa ida e volta, o responsável atual ficava esgotado sem ter recebido | minor | tentativa contada na confirmação, nunca no claim | avisos 9 |
| 2 | Mesmo achado, visto pela lente de testes (caminho do worker sem cobertura) | minor | idem | avisos 9 |
| 3 | A → sem responsável → A/C: a ocorrência ficava sem aviso de responsável para sempre | minor | órfãs atendidas pela entrega do novo responsável | avisos 10 |
| 4 | Entrega esgotada reivindicada para redirecionar era enviada além do limite quando o destinatário voltava a ser o responsável | minor | recusa o envio, devolve FAILED | avisos 11 |
| 5 | `ja_coberta` por uma entrega de gestor que não podia mais ser entregue (novo responsável rebaixado) | minor | a entrega de gestor do novo responsável vira a de responsável | avisos 12(a) |
| 6 | O responsável anterior que é gestor ativo perdia também o aviso de gestor | minor | a entrega dele vira a de gestor | avisos 12(b) |
| 7 | A reatribuição criava aviso novo para divergência resolvida | minor | `ocorrencia_encerrada`, sem entrega nova | avisos 13 |
| 8 | A CHECK `confirmacao_na_posse` quebrava o código anterior num rollback do deploy (reenvio a cada tick e etapa de avisos abortada) | major | gatilho que apaga a confirmação herdada | avisos 14 |
| 9 | Captura: a posse da dona era conferida uma vez por ciclo; um desvínculo seguido de vínculo durante o ciclo gravava conteúdo na dona anterior | minor | posse relida antes de cada gravação | captura "desvínculo durante o ciclo" |
| 10 | O teste de corrida do vínculo de caixa não exercitava corrida, e o perdedor recebia código errado | minor | corrida real (2 ADMINs × 10 rodadas); código pelo vencedor | captura "corrida" |
| 11 | D1 só relia memberships: um login concorrente com o desvínculo da identidade deixava a sessão viva | major | relê também o vínculo | seg 15 |
| 12 | A reconferência do D1 falhava aberta em erro de banco (500 com Set-Cookie de sessão viva) | minor | falha fechada | seg 16 |
| 13 | "Avisos: envio fora de transação" ficou intermitente: contava a transação curta de revalidação do OUTRO worker | major (teste) | cada worker com o próprio pool e `application_name`; a regra continua estrita para quem envia, transação e lock consultivo | `shippingInstructions` (6/6 execuções) |

**Segunda rodada** (só sobre as correções acima): **4 confirmados — corrigidos e cobertos; 0 refutados.**

| # | Achado | Sev. | Correção | Teste |
|---|---|---|---|---|
| 14 | Retirada de um responsável que é gestor ativo não deixava órfã, e o próximo responsável ficava sem aviso | major | lacuna identificada pelo evento `sem_responsavel` + ausência de entrega de responsável | avisos 15 |
| 15 | Posse vencida no limite, recuperada, escapava da trava de esgotada (6ª tentativa) | minor | só reenvia se o envio já tinha sido confirmado | avisos 16 |
| 16 | Caixa pausada durante o ciclo: o cursor avançava e a conversa se perdia | major | sinal de "sem posse" para a pasta sem avançar o cursor | captura "pausa durante o ciclo" |
| 17 | A posse era conferida antes da leitura do Graph na ingestão; o conteúdo lido depois de um desvínculo ainda era gravado | minor | reconferência dentro da ingestão, travada na transação final | captura "desvínculo durante a ingestão" |

**Refutados na 1ª rodada, com motivo registrado:**

- `restantes` e `esgotadas` do worker de divergência nunca calculados: pré-existente e sem efeito.
- Caches da auditoria V1 sem organização: pré-existente; ver R19.
- Intervalo de purga de 50 ms em seg 02: sem resultado errado.
- Avisos de divergência resolvida ou esgotada recriados no 1º tick depois do deploy: semântica do outbox. As resolvidas agora nem são recriadas (achado 7).
- Publicar antes de vincular a dona esgota os avisos: passo obrigatório do §13.
- A 0050 aplicada com o código no ar pode entrar em deadlock com a aplicação: a inversão de lock existe, mas termina em erro de deadlock e a migration é refeita, sem resultado errado. Recomendação: migrar fora do pico ou repetir em caso de deadlock (§13).

### 18.9 Validação final (worktree limpo, banco novo)

**Método:**

- `git worktree add --detach` no commit a validar, `npm ci`, banco PostgreSQL 16 recém-criado e uma etapa de cada vez, na ordem pedida.
- O executor está em `validar_clean_final.sh`, um script de rascunho fora do repositório.
- A etapa D12 roda os 10 arquivos históricos e **prova** a contagem: o total precisa ser 75 e cada arquivo, rodado isolado, precisa ter a contagem congelada do §18.1, com todos aprovados.
- `git status --porcelain` saiu vazio antes e depois; só `dist/` e `node_modules/` aparecem, como ignorados.

**Validação definitiva — `b03b463`:**

| # | Etapa | Passados | Falhos | Ignorados | Cancelados | `todo` |
|---|---|---|---|---|---|---|
| 01 | Testes novos (`autenticacaoFilasP1`, `filasPessoaisLeituraP1`, `acoesPessoaisP1`, `membershipDesativadoP1`, `avisosReatribuicaoP1`, `integracaoMicrosoftIsolamentoP1`, `sessaoSegurancaP1`) | **129** | 0 | 0 | 0 | 0 |
| 02 | Autenticação/sessão/autorização existentes (`tokenCacheDuravel`, `capturaPreAlerta`, `shippingInstructions`, `multiTenant`) | **86** | 0 | 0 | 0 | 0 |
| 03 | Notificações (`avisosReatribuicaoP1`, `membershipDesativadoP1`, `d15b`, `d15bV11`, `d15c`, `d15cV11`, `d15cV12`, `demurrageTickFilas`, `prazoFreeTimeV12`, `registroDemurrage`, `registroDemurrageV12`, `apuracaoV14`, `d16Vertical`, `scheduler`) | **273** | 0 | 0 | 0 | 0 |
| 04 | Entrega 1 — handoff + capacidade | **87** | 0 | 0 | 0 | 0 |
| 05 | Entrega 2 — ações | **70** | 0 | 0 | 0 | 0 |
| 06 | Entrega 3 — leituras operacionais | **47** | 0 | 0 | 0 | 0 |
| 07 | D12 — os 10 arquivos históricos (incluindo `leituraAutorizacao`) | **75** | 0 | 0 | 0 | 0 |
| 07b | D12 arquivo a arquivo, cada um isolado: 7 · 10 · 8 · 18 · 6 · 6 · 8 · 4 · 5 · 3 | **75**, todos iguais ao congelado | 0 | 0 | — | 0 |
| 08 | Suíte completa da Demurrage Engine (`npm run test:demurrage-engine`) | **1345** | 0 | 0 | 0 | 0 |
| 09 | V1 (`npm run test`) | **25** | 0 | 0 | 0 | 0 |
| 10 | D13 UI (`npm run test:demurrage-ui`) | **66** | 0 | 0 | 0 | 0 |
| 11 | `npx tsc --noEmit` | exit 0, sem saída | | | | |
| 12 | `npm run build` | exit 0 | | | | |

A suíte completa passou de 1290 testes (em `cc98c9a`) para 1345: são os testes novos e reforçados desta auditoria. Nenhum teste anterior sumiu, e a D12 prova os 75.

**1ª validação — `4bb0efc` (registrada, não omitida).** Mesmas etapas, todas verdes, **exceto a 03: 271 passados e 2 falhos**:

- **O que falhou:** o subteste "banco novo" do D15-C #25 e o teste-pai, com `terminating connection due to administrator command` (exceção não capturada).
- **Causa raiz:** corrida pré-existente no helper de teste `comBancoTemporario`. O `end()` do pg-pool 3.14 resolve antes de os sockets fecharem, e o `pg_terminate_backend` seguinte atinge um cliente já sem ouvinte de erro.
- **Correção:** `b03b463`, só nos testes e sem mudar nenhuma asserção (§18.7). As suítes afetadas passaram 3 vezes seguidas, e a validação completa foi repetida do zero acima.
- **Demais etapas da 1ª validação:** 01 129, 02 86, 04 87, 05 70, 06 47, 07 75 (07b ok), 08 1345, 09 25, 10 66, typecheck e build limpos.

**Estado à época da validação:** entrega não congelada. Congelamento formal posterior no §19. A Production P1 **não** está concluída.

## 19. Congelamento formal

> **APROVADA E CONGELADA** por decisão formal do responsável pelo produto, encerrada no commit `8266fba3a19fd228a4901488ae1e269cb2eeb0fc`. Este registro é só documentação: nenhum código, migration, teste, frontend, HTML, CSS, JavaScript de apresentação ou design foi alterado nele. **A Production P1 NÃO está concluída** (§19.7).

### 19.1 Baseline e commits aprovados

| Item | Valor |
|---|---|
| Branch | `claude/practical-cerf-mnz7oj` |
| Baseline anterior | `29a3830` (registro da validação da entrega de autenticação e filas, `cc98c9a`) |
| Commit aprovado — correções e testes | `4bb0efc` |
| Commit aprovado — correção da corrida no helper de teste | `b03b463` |
| Commit aprovado — documentação final | `8266fba` |
| Estado congelado | `8266fba3a19fd228a4901488ae1e269cb2eeb0fc` |

A superfície abaixo entrou em `cc98c9a` e foi corrigida pelos três commits aprovados (§18). O que vale é o estado em `8266fba`.

### 19.2 Superfície congelada

- sessões humanas no PostgreSQL (`sessoes_humanas`, cookie `__Host-priora.sid`, store, expiração, revogação; §3, §18.6);
- login e logout isolados por sessão (§3.1, §3.3);
- identidade operacional (§3.5; `requireSessao`, `req.identidade`);
- `/api/me` (`priora.me.v2`, inclusive `conexaoMicrosoft.podeUsarCaixaDaIntegracao`; §6);
- seleção de organização (§7);
- provisionamento (CLI do operador e `/admin/membros`; §8);
- papéis (ANALYST, MANAGER, ADMIN; CLIENT nunca interno; administrador de plataforma; §8, §10);
- atribuição e reatribuição (§9);
- filas pessoais, da equipe e sem responsável (`MINHA_FILA`, `EQUIPE`, `SEM_RESPONSAVEL`; §10.1);
- autorização das ações por responsável (§10.2, §11);
- redirecionamento de avisos após reatribuição (§18.2);
- isolamento da organização dona da integração (§18.3);
- acesso V1 pelos membros internos ativos da organização dona (§18.4);
- migrations `0049_sessoes_identidade_atribuicao.sql`, `0050_avisos_redirecionamento_responsavel.sql` e `0051_integracao_microsoft_organizacao.sql`.

### 19.3 Regra de alteração

A superfície congelada só muda mediante:

1. defeito comprovado;
2. problema de segurança ou de integridade;
3. autorização explícita do responsável pelo produto.

### 19.4 Limitação aceita para o MVP: uma única organização

Decisão de implantação do responsável pelo produto:

- **O primeiro lançamento real atende somente UMA organização**, vinculada como **dona exclusiva** da integração Microsoft (`vincular-integracao-organizacao`).
- **Captura do pré-alerta, reprocessamento de Shipping Instructions, avisos por e-mail e V1 pertencem exclusivamente à organização dona.** Para qualquer outra organização:
  - os avisos falham com `canal_de_outra_organizacao`, sem chamar o Graph;
  - a V1 responde `403 integracao_de_outra_organizacao`;
  - captura e reprocessamento são recusados (§18.3).
- **Nenhuma segunda organização pode ser ativada em produção** enquanto não existir um canal de integração próprio por organização. O bloqueio é **operacional**: verificações obrigatórias antes do deploy e a cada mudança de provisionamento (§19.5, item 6).
- **Isso não é suporte multiorganização concluído.** O modelo de dados e a autorização são multiorganização, mas a integração Microsoft é de uma organização só. A arquitetura multiorganização (canal por organização) é **trabalho separado** e exige **autorização específica**.
- A limitação está no runbook (`docs/demurrage-runbook-operacional.md`, §12) e no checklist abaixo.

### 19.5 Checklist obrigatório antes do deploy

**Pré-requisito de ambiente** (§13, passo 2), com os mesmos valores em todas as instâncias:
- `SESSION_SECRET`, que não pode ser o padrão de desenvolvimento;
- `DEMURRAGE_DATABASE_URL`;
- **`PRIORA_TOKEN_CACHE_KEY`**.

**Ordem dos itens:** 1, 2 e 3 antes de publicar o código; 4 depois de publicar e antes do smoke test; 5 antes de liberar os analistas; 6 antes de liberar e a cada mudança de provisionamento.

1. **Aplicar as migrations até a 0051, antes do código.**
   - Rodar `npm run db:migrate:demurrage`.
   - Conferir: `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1` deve devolver `0051_integracao_microsoft_organizacao.sql`.
   - O boot de produção recusa subir sem o schema da 0049 a 0051.
2. **Provisionar o administrador da plataforma.**
   - `npm run demurrage:provisionar -- vincular-usuario --nome … --email … --oid … --tid … --operador … --motivo …`
   - `… adicionar-membro --org <organização do MVP> --email … --papel ADMIN --operador … --motivo …`
   - `… admin-plataforma --email … --ativar --operador … --motivo …`
   - Para conectar a integração, o administrador de plataforma precisa de membership interno ATIVO (§3.2).
3. **Provisionar usuários, memberships e papéis**, todos na organização do MVP.
   - `vincular-usuario` e `adicionar-membro --papel ANALYST|MANAGER|ADMIN`.
   - Ajustes com `definir-papel`.
   - Conferir com `listar-membros --org <organização do MVP>`.
4. **Vincular a integração à organização do MVP.**
   - O administrador de plataforma confirma, ou conecta, a conta técnica (`/auth/integracao/conectar`).
   - Rodar `… vincular-integracao-organizacao --org <organização do MVP> --operador … --motivo …`.
   - Conferir com `… conta-integracao`: `organizacaoDona` deve ser a organização do MVP e `vinculosAtivosDeOutrasContas` deve vir `[]`.
   - Sem esse vínculo, a V1, a captura, o reprocessamento e os avisos ficam bloqueados (falha fechada).
5. **Atribuir os processos abertos** antes de liberar os analistas.
   - Levantar com `… processos-sem-responsavel --org <organização do MVP>`.
   - Atribuir com `… atribuir-sem-responsavel --org … --para <membership> …` ou com `atribuir-responsavel`.
6. **Confirmar que nenhuma segunda organização está ativa para esses fluxos.** Cada consulta deve devolver **somente** a organização do MVP:

   ```sql
   -- memberships internos ativos
   SELECT organization_id, count(*) FROM organization_memberships
    WHERE desativado_em IS NULL AND papel IN ('ANALYST', 'MANAGER', 'ADMIN') GROUP BY organization_id;
   -- dona da integração: exatamente UMA linha, da organização do MVP, com conta_atual = true
   SELECT v.organization_id, (v.home_account_id = c.home_account_id) AS conta_atual
     FROM integracao_microsoft_vinculos v LEFT JOIN msal_conta_ativa c ON c.id = 'default'
    WHERE v.desvinculado_em IS NULL;
   -- caixas de captura não removidas
   SELECT organization_id, estado FROM email_caixas WHERE estado <> 'removida';
   -- credenciais ativas do handoff (criam processos na organização da credencial)
   SELECT organization_id, nome FROM demurrage_handoff_credenciais WHERE status = 'ATIVA';
   -- processos existentes
   SELECT organization_id, count(*) FROM processos GROUP BY organization_id;
   ```

   - Qualquer outra organização numa dessas consultas **bloqueia o deploy** até uma decisão explícita. Nenhuma correção automática.
   - Repita as consultas a cada mudança de provisionamento: membro, credencial de handoff, caixa ou vínculo.
   - Depois de publicar, rode o smoke test do §13, passo 6.

### 19.6 Resultados finais

Validação sequencial em worktree limpo com banco novo, no commit `b03b463`. O código congelado é idêntico; `8266fba` só acrescenta documentação.

| Etapa | Resultado |
|---|---|
| Testes novos | **129/129** |
| Autenticação existente | **86/86** |
| Notificações | **273/273** |
| Entrega 1 + capacidade | **87/87** |
| Entrega 2 | **70/70** |
| Entrega 3 | **47/47** |
| D12 (os 10 arquivos históricos, cada um com a contagem congelada) | **75/75** |
| Suíte completa da Demurrage Engine | **1345/1345** |
| V1 | **25/25** |
| D13 UI | **66/66** |
| `tsc --noEmit` e build | limpos |

Zero falhos, ignorados, cancelados e `todo` em todas as etapas. Detalhe e a 1ª validação (`4bb0efc`) no §18.9.

### 19.7 O que continua fora (a Production P1 não está concluída)

Restam, cada um como frente própria que depende de autorização explícita:

- administração operacional de tarifas;
- armazenamento definitivo dos arquivos de minuta;
- frontend;
- integração produtora da Liberação, quando estiver pronta.

A arquitetura multiorganização (canal de integração por organização, §19.4) é trabalho separado, com autorização específica. A correção de minuta e encerramento (`ddc43db`) mantém o status registrado no próprio relatório; este congelamento não o altera.
