# Checklist de implantação do piloto isolado da Liberação

**Para o ambiente do PILOTO, nunca para a produção.** Derivado do ensaio geral local (O2.7) e da revisão de segurança (O2.8), ambos com dados sintéticos. Ainda não foi executado num ambiente real.

Marque cada item com a evidência pedida. Item sem evidência = item **não cumprido**. Informação indisponível nunca equivale a condição atendida.

Restrições do piloto, que nenhum passo deste checklist altera:
- a produção não é tocada;
- o HeadCargo não é integrado;
- o produtor do armador não é ligado;
- não há handoff Liberação → Demurrage;
- as regras operacionais congeladas não mudam.

Nenhum segredo, URL com senha ou dado real entra neste arquivo, no repositório ou em conversa.

---

## 0. Decisão de go/no-go

O piloto só abre quando **todos** os itens abaixo estiverem com evidência e as decisões pendentes estiverem tomadas e registradas.

| # | Risco | Situação após a O2.8 | Bloqueia? |
|---|---|---|---|
| R1 | Scheduler da Demurrage sem interruptor | Isolado por **ausência de dados**. Nenhuma rota, script ou migração do app cria contêiner ou alvo de rastreamento. Num banco novo, o tick lê e não faz nada (ensaio: 0 tabelas alteradas, 0 conexões). Com um contêiner rastreável, o mesmo tick chamaria a porta do armador. Conferência: C4 e G6 | Não, se C4 e G6 tiverem evidência |
| R2 | `SESSION_SECRET` padrão aceito em silêncio | Sem validação no código. Com o padrão, um cookie assinado com o valor público é aceito como sessão válida, e o `state` do OAuth é forjável. Mitigação manual: B1 + I7 | Sim, até B1 e I7 terem evidência |
| R3 | Captura automática ligada por padrão | `PRIORA_CAPTURA_PRE_ALERTA=off` impede o laço. Ensaio: sem a variável, o boot percorre as caixas ativas e grava em `email_caixas`; com `off`, nada. Restam caminhos **manuais** fora da flag (G8) | Não, se G2 tiver evidência e G8 estiver decidido |
| R4 | Escritas no Outlook **fora de qualquer flag** (achado da O2.8) | Qualquer ANALYST, MANAGER ou ADMIN pode, pelo token da caixa (que tem `Mail.Send`): enviar e-mail (`POST /api/emails/send`, também pela página `api-test.html`), criar rascunho de resposta (`POST /api/couriers/reply-draft`) e pedir minuta por rascunho (`POST /api/demurrage/solicitar-minuta`). `PRIORA_LIBERACAO_OUTLOOK_ESCRITA=off` **não** cobre essas rotas | **Sim**, até a decisão G7 |
| R5 | Rota documentada errada | Corrigida: `POST /api/captura/caixas` | Não |

## A. Infraestrutura

| # | Item | Evidência |
|---|---|---|
| A1 | Serviço web **novo** para o piloto, criado pelo painel. **Não** sincronizar o `render.yaml`: ele descreve o serviço `priora` | nome do serviço ≠ `priora` / `priora-1` |
| A2 | **Deploy automático desligado.** Deploy manual de um commit exato | hash do commit implantado |
| A3 | Runtime Node **22** (`NODE_VERSION=22`). O `render.yaml` diz 20, e o `undici` falha no 20.20 | log de build mostrando Node 22 |
| A4 | Build `npm install --include=dev && npm run build`; start `npm start` | log de build sem erro |
| A5 | Postgres **novo e exclusivo** (16), sem nada compartilhado com outro serviço | nome do banco; nenhum outro serviço o usa |
| A6 | Disco: as sessões ficam em `DATA_DIR/sessions` (arquivo). Sem disco persistente, todos saem do login a cada reinício. Aceitar ou montar disco. Quem lê esse disco vê os identificadores de sessão (ver B1) | decisão registrada |
| A7 | URL do piloto e identidade visual distintas da produção | URL anotada |

## B. Variáveis e segredos

Todos ficam no painel do serviço, **nunca** no repositório, em arquivo versionado ou no chat.

| # | Variável | Regra | Evidência |
|---|---|---|---|
| B1 | `SESSION_SECRET` | **Obrigatória e aleatória**, gerada na hora (ex.: `openssl rand -hex 32`, 64 caracteres). **Nunca** o padrão do código (`dev-insecure-secret-change-me`) nem o valor do `.env.example`. O código **não recusa** esses valores: com eles, cookies de sessão e o `state` do OAuth podem ser forjados. Sem a variável, a conferência do Courier também fica `NAO_VERIFICADA`. Ver I7 | definida, com o comprimento conferido, sem expor o valor |
| B2 | `NODE_ENV=production` | liga o cookie `secure` e o `trust proxy` (HTTPS do host) | definida |
| B3 | `DEMURRAGE_DATABASE_URL` | o banco **do piloto**; **sem** `DATABASE_URL` no serviço | `current_database()` conferido |
| B4 | `PRIORA_TOKEN_CACHE_KEY` | 32 bytes em base64, **exclusiva do piloto**. Sem ela, o cache MSAL fica só em memória, e a caixa precisa ser reconectada a cada reinício | definida |
| B5 | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `AZURE_REDIRECT_URI` | registro de aplicativo do piloto (seção E). Recomendado: `AZURE_TENANT_ID` = o tenant da empresa (não `common`) e "atribuição obrigatória" no aplicativo corporativo, se todas as contas do piloto forem desse tenant | `/auth/entrar` deixa de responder 503 |
| B6 | `GEMINI_API_KEY` | chave **própria** do piloto, com limite de gasto. A Auditoria usa IA na extração. A mesma chave liga a IA das telas legadas (Demurrage, Processos, Courier), quando alguém as abre | limite configurado; decisão registrada |
| B7 | Chaves de rastreamento (FedEx, DHL, armadores, scraping, CAPTCHA) | **vazias**. FedEx e DHL respondem 503 sem chave. O rastreio por scraping do armador **não depende de chave**: quem o impede é a ausência de dados (C4) | ausentes |
| B8 | `DATA_DIR` | pasta do serviço (A6) | definida |
| B9 | `DEMURRAGE_ALERT_TECH_EMAILS`, `DEMURRAGE_ALERT_ORG_EMAILS` | **ausentes**: sem destinatário, nenhum alerta de rastreio da Demurrage é enviado | ausentes |

## C. Banco e migrações

| # | Item | Evidência |
|---|---|---|
| C1 | Rodar de uma máquina confiável, apontando **só** para o banco do piloto, com a senha em `PGPASSWORD`: `DEMURRAGE_DATABASE_URL=… npm run db:migrate:demurrage` | saída: todas as migrações aplicadas |
| C2 | Conferir `SELECT count(*) FROM schema_migrations` = número de arquivos em `src/demurrage-engine/db/migrations` | número igual |
| C3 | **Nunca** rodar migração com a URL da produção | URL conferida antes de executar |
| C4 | **Nenhum dado da Demurrage** antes do primeiro boot e a cada semana do piloto. A consulta abaixo deve devolver só zeros | saída da consulta |

```sql
SELECT (SELECT count(*) FROM containers)                       AS conteineres,
       (SELECT count(*) FROM container_tracking_targets)       AS alvos_por_conteiner,
       (SELECT count(*) FROM tracking_targets)                 AS alvos,
       (SELECT count(*) FROM tracking_alert_deliveries)        AS alertas,
       (SELECT count(*) FROM ft_divergencia_entregas)          AS avisos_divergencia,
       (SELECT count(*) FROM demurrage_fallback_manual_avisos) AS avisos_fallback,
       (SELECT count(*) FROM demurrage_pos_commit_outbox)      AS pos_commit;
```

## D. Provisionamento (I4)

| # | Item | Evidência |
|---|---|---|
| D1 | Manifesto real **fora do repositório**: organização, conta da caixa (**ADMIN declarado**), pessoas e papéis. Nenhum papel padrão; CLIENT fora | arquivo com permissão 600 |
| D2 | Simular: `PRIORA_PILOTO_DATABASE_URL=… npm run -s piloto:provisionar -- --manifesto …` | saída `SIMULAÇÃO`, nenhum conflito |
| D3 | Aplicar com `--aplicar --alvo <banco do piloto> --relatorio …` | saída `APLICADO`; relatório 600 |
| D4 | Reexecutar o mesmo manifesto: nada é gravado | `gravado: 0 …` |
| D5 | Conferir que só existem os ADMIN declarados | contagem de ADMIN = manifesto |

Passo a passo completo: [`piloto-provisionamento.md`](piloto-provisionamento.md).

## E. Autenticação Microsoft

| # | Item | Evidência |
|---|---|---|
| E0 | **Ordem:** conectar e vincular a caixa (F1 e F2) **antes** de divulgar a URL do piloto. Enquanto nenhuma caixa está vinculada, a primeira conta que concluir `/auth/login` vira a conta ativa do servidor. Isso não expõe dados, mas bloqueia o uso até um ADMIN reconectar a caixa certa | F2 concluído antes de E3 |
| E1 | Registro de aplicativo **do piloto** no Azure (ou, no mínimo, a URI de retorno do piloto), com os escopos delegados de `config.loginScopes` | ID do app anotado |
| E2 | `AZURE_REDIRECT_URI` = `https://<url do piloto>/auth/callback` | login conclui |
| E3 | Cada pessoa tenta entrar. A tela "Conta Microsoft não vinculada" mostra o identificador. O operador o confirma com a pessoa por canal confiável, acrescenta ao manifesto e reaplica (D3) | pessoa entra e vê a Liberação |

## F. Vínculo da caixa monitorada

| # | Item | Evidência |
|---|---|---|
| F1 | Conectar a conta Microsoft da caixa no servidor do piloto (`/auth/login`, consentimento) | conta ativa no servidor |
| F2 | Na **mesma sessão** em que a caixa foi conectada (a conta da caixa é a ADMIN declarada): `POST /api/captura/caixas` com corpo `{ "organizationId": "<id da organização>" }`. A rota exige que a sessão seja a própria caixa | 201; a simulação D2 mostra `caixa monitorada: VINCULADA` |
| F3 | A Liberação **exige o token da caixa a cada requisição**: se ele cair, tudo responde 503 `TOKEN_DA_CAIXA_INDISPONIVEL`. Procedimento: ADMIN reconecta a caixa | procedimento testado uma vez |
| F4 | Sem a captura ligada (G2), o token da caixa nunca é marcado como verificado. A tela mostra "Fonte indisponível: Courier" para processos ainda sem conferência física. Isso é esperado no piloto | ciência registrada |

## G. Flags e caminhos fora das flags

| # | Variável ou caminho | Valor ou decisão no piloto | Por quê |
|---|---|---|---|
| G1 | `PRIORA_FATOS_DURAVEIS` | `on` | liga a Liberação (sem ela, as rotas respondem 404) |
| G2 | `PRIORA_CAPTURA_PRE_ALERTA` | **`off` explícito** | o padrão é **ligado** (só `off` desliga). Sem a variável, o boot já roda a captura: percorre as caixas ativas, lê o Graph e grava em `email_caixas` |
| G3 | `PRIORA_LIBERACAO_RECONSTRUCAO` | `off` | nada a reconstruir num banco novo |
| G4 | `PRIORA_LIBERACAO_OUTLOOK_ESCRITA` | `off` | nenhuma escrita no Outlook **pela Liberação documental**. Não cobre as rotas de G7 |
| G5 | Armador automático | nada a ligar | o produtor não tem nenhum importador no código nem no `dist`. O armador fica `NAO_INTEGRADA` |
| G6 | Scheduler da Demurrage | ⚠️ **sem interruptor**: sobe com o banco e roda um tick no boot e depois a cada ~1 h | isolamento = C4 (sem dados) + B7 + B9. Conferir no log de cada boot a linha `[demurrage-scheduler] tick …` com `avaliados=0`, `enviadas=0` e `avisos=0/0`. A aba Demurrage do painel não grava nessas tabelas: ela lê a caixa, usa IA (B6) e grava no store legado em arquivo |
| G7 | Escritas no Outlook **fora de flag**: `POST /api/emails/send` (e a página `/api-test.html`), `POST /api/couriers/reply-draft`, `POST /api/demurrage/solicitar-minuta` | **decisão pendente**: (a) instrução operacional de não usar e conferência diária de Itens Enviados e Rascunhos da caixa; ou (b) a alteração mínima proposta no relatório da O2.8 (flag nova, padrão ligado, piloto `off`), que **precisa de validação** | qualquer membro do piloto envia e-mail ou cria rascunho em nome da caixa. Os botões "Criar rascunho" (Courier) e "Solicitar minuta" (Demurrage) estão na interface |
| G8 | Caminhos **manuais** da captura fora da flag: backfill (`POST /api/captura/caixas/:id/backfill`, só ADMIN na sessão da caixa) e reprocessamento da Shipping Instructions (`POST /api/processes/:conversationId/shipping-instructions/reprocessar`, qualquer membro não CLIENT) | **decisão pendente**: não usar no piloto, ou aceitar | ambos leem a caixa pelo Graph, podem usar IA (B6) e gravam nas tabelas da SI, mesmo com G2 `off` |

**Conferência após o boot:**
- o log mostra `captura-pre-alerta desligada` e `liberacao-reconstrucao desligada`;
- o tick da Demurrage sai com tudo zero;
- a consulta C4 continua só com zeros.

## H. Cadastro institucional

| # | Item | Evidência |
|---|---|---|
| H1 | Uma pessoa **ADMIN** grava o cadastro pela API existente (`/api/liberacao/documentos/cadastro-institucional`): razão social, CNPJ e signatário legal com poderes | `GET` com `vigente` preenchido |
| H2 | ANALYST não lê nem grava o cadastro | 403 `EXIGE_ADMIN` |
| H3 | ⚠️ Mesmo com o cadastro, **nenhum documento DOC-31 é preparado** enquanto o armador não for identificado: a seleção do modelo depende dele (`ARMADOR_NAO_IDENTIFICADO`; preparar responde 422) | ciência registrada |

## I. Validação de isolamento (antes de liberar o uso)

| # | Teste | Esperado |
|---|---|---|
| I1 | Sem sessão: `GET /api/liberacao/processos` | 401 |
| I2 | Pessoa sem membership na organização da caixa | 403 `SEM_MEMBERSHIP` |
| I3 | Processo de outra organização (se houver uma de teste no banco) | 404 |
| I4 | Cookie adulterado | 401 |
| I5 | Conta não vinculada tenta entrar | tela "Conta Microsoft não vinculada"; nenhum acesso |
| I6 | ANALYST tenta vincular ou trocar a caixa | 403 |
| I7 | **O servidor não usa o segredo padrão.** Gerar um `state` assinado com o valor **público** do código e chamar o retorno do login. Nenhum segredo real é usado | 400 "Sessão de login expirada". Qualquer outra resposta = `SESSION_SECRET` é o padrão: **não abrir o piloto** |

Comando de I7 (só usa o valor público do código; troque a URL pela do piloto):

```bash
ESTADO=$(node -e "const c=require('crypto');const p=c.randomBytes(16).toString('hex')+'.'+Date.now()+'.pessoa';process.stdout.write(p+'.'+c.createHmac('sha256','dev-insecure-secret-change-me').update(p).digest('hex'))")
curl -s -o /dev/null -w '%{http_code}\n' "https://<url do piloto>/auth/callback?code=sonda&state=$ESTADO"   # esperado: 400
```

## J. Reversão

1. Desligar o serviço do piloto.
2. Apagar o banco do piloto (ou, se a auditoria exigir, exportá-lo cifrado e apagá-lo depois).
3. Revogar o registro de aplicativo do piloto no Azure e o consentimento da caixa.
4. Descartar `SESSION_SECRET` e `PRIORA_TOKEN_CACHE_KEY`.
5. Apagar o manifesto e os relatórios do provisionamento.
6. Conferir que a produção não teve nenhuma alteração (ela nunca foi tocada).

## K. Critérios objetivos de aprovação ou reprovação do piloto

**Reprovação imediata** (qualquer ocorrência):
- uma pessoa vê processo, documento ou cadastro de outra organização;
- a Liberação afirma uma condição atendida a partir de informação ausente (ex.: "pago", "liberado", "apresentado" sem o fato);
- um vínculo Processo–Master–House errado é mostrado como fato. Divergência e conflito devem aparecer como exceção;
- uma escrita externa sem autorização: e-mail enviado ou rascunho criado na caixa a partir da Priora fora do que G7 permitir, ou a captura automática rodando sem ter sido ligada;
- qualquer linha nas tabelas da consulta C4, ou um tick da Demurrage com `avaliados`, `enviadas` ou `avisos` diferente de zero;
- um documento oficial gerado sem cadastro institucional e armador confiáveis;
- perda de fato já registrado (Courier, Auditoria, vínculo).

**Aprovação** (todos os itens), numa amostra de pelo menos 20 processos reais do piloto, conferida pelo Analista contra a operação:

| # | Critério | Meta |
|---|---|---|
| K1 | Processo e Master corretos (incluindo Master compartilhado e conflito como exceção) | 100% |
| K2 | Etapa, bloqueio, responsável e próxima ação **coerentes com os fatos existentes**. "Não determinável" sempre nomeia a fonte que falta | 100% |
| K3 | Nenhuma informação inventada (lista de termos proibidos dos testes) | 0 ocorrências |
| K4 | Disponibilidade da Liberação no horário comercial (sem 503 por token da caixa por mais de 1 h seguida) | ≥ 95% dos dias |
| K5 | Recálculo manual de um processo inalterado | "sem mudança material", sempre |
| K6 | Pessoas do piloto conseguem entrar | 100% das declaradas |

**Limitação conhecida, que não reprova:** a maioria dos processos aparece como "não determinável". As fontes de armador, viagem, HeadCargo e e-mails de Wave e emissão não estão integradas. O piloto mede a **correção** do que é mostrado, não a cobertura.
