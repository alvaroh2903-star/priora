# Fase L0 — Preparação e substrato técnico da Liberação

> **Status:** a L0-A (qualificação isolada) e a L0-A.1 (Node 20 e segurança de dependências) foram executadas e aceitas. A L0-B (materialização) é realizada por este commit documental e pelo push da branch, e aguarda aceite.
>
> **Substrato técnico:** `a4b07b38a2ce520f4be3ed3c363f3a688b6a05d4`, autorizado em 2026-10-09. A autorização é **somente técnica** (§1).
>
> **Próximo passo:** nenhum autorizado. O diagnóstico de S6 e qualquer fase seguinte exigem autorização explícita.

## 1. Semântica do substrato técnico

`a4b07b3` está autorizado como substrato técnico da Priora para construir a Liberação. A autorização **não**:

- aprova nem congela funcionalmente D1–D11;
- torna as regras da Demurrage autoritativas para a Liberação;
- se sobrepõe ao Blueprint congelado da Liberação;
- autoriza S6 nem qualquer fase de implementação posterior à L0-B.

Para a Liberação, a ordem de autoridade continua: **Blueprint congelado → decisões H/N aprovadas → implementação**. Se código herdado conflitar com essa autoridade, o código se adapta. O Blueprint nunca é alterado em silêncio.

A conclusão da qualificação foi: "`a4b07b3` está tecnicamente qualificado como substrato técnico candidato da Priora para a Liberação". Isso cobre só saúde técnica e compatibilidade.

## 2. Identificação

| Item | Valor |
|---|---|
| Branch de trabalho | `claude/busy-cori-8o1czj` (local, sem upstream; não existia no remoto antes da L0-B) |
| SHA ATUAL (antes da L0-B) | `48ba7c155f286adb79f32a8629c09334c769c6c8` |
| Substrato | `a4b07b38a2ce520f4be3ed3c363f3a688b6a05d4`, de 2026-09-29 23:58:41 UTC. Mensagem: "D11 v1.2 (rodada final, NÃO congelada): precedência VERSAO_DESATUALIZADA > RELOGIO_OBSOLETO + script de auditoria read-only" |
| Linha de origem | `claude/practical-cerf-mnz7oj`, com head remoto `91b32018ed90899ae4936ee7a968191b2db704b9`; o substrato é ancestral dele, 25 commits antes |
| Fast-forward | `48ba7c1` → `a4b07b3`, com 52 commits e 238 arquivos (228 adicionados, 10 modificados, 0 removidos), +42.411 / −10 linhas |

**Os 52 commits por fase:**

| Fase | Commits | Marcações nas mensagens |
|---|---|---|
| Diagnóstico e plano da Demurrage V2 (docs) | 4 | — |
| Fases 1–4: fundação PostgreSQL multiempresa, relógios, tarifas | 6 | — |
| Fase 5: tracking e identidade do TrackingTarget | 3 | — |
| Fase 6: scheduler, cadência, alerta | 4 | — |
| Fase 7: estado/prioridade | 2 | — |
| Fase 8: minuta, recálculo, fechamento/reabertura, apuração | 10 | — |
| Fase 9: VesselCall e tracking compartilhado | 8 | — |
| Master Free Time/SI e captura do pré-alerta | 5 | um "WIP" |
| D10: vertical da Demurrage | 4 | v1.1 e v1.2 "pendente de aprovação" |
| D11: Responsabilidade Rocket × Cliente | 6 | "NÃO aprovada" / "NÃO congelada" |

## 3. Impacto ATUAL → substrato

| Área | Arquivos | Linhas | O que muda |
|---|---|---|---|
| Banco e migrations | 36 | +3.867 | Tudo novo: runner único com `schema_migrations`; o pool lê `DEMURRAGE_DATABASE_URL` ou `DATABASE_URL`. |
| `processos` e identidade de tenant | 5 | +883 | Repositórios de `organizations`, `usuarios`, `organization_memberships` e `processos`, mais `registrarProcessoDemurrage` (sem chamador em produção). |
| Auth e membership | 8 | +737 / −4 | Conta ativa e cache MSAL duráveis no PostgreSQL. `requireAuth.ts` não muda. |
| Tracking, VesselCall e scheduler | 61 | +7.913 | Tudo novo, incluindo `src/browser/` com 42 arquivos de scraping via Playwright. |
| Courier | 0 | 0 | Inalterado. |
| Auditoria (módulo) | 0 | 0 | Inalterado. |
| Graph e captura de e-mail | 11 | +2.182 / −2 | `graphService` muda de forma aditiva (delta/período e `lastModifiedDateTime` nos anexos); captura do pré-alerta e Shipping Instructions são novas. |
| Bootstrap e rotas | 3 | +328 / −3 | `main()` assíncrono com dois laços em background; `/api/captura` com 6 endpoints; `POST …/shipping-instructions/reprocessar`. |
| Deploy e configuração | 4 | +400 / −2 | `pg`, `playwright` 1.56.1, `undici` ^8.10.0, `proxy-chain`, `@types/pg`; scripts `db:migrate:demurrage` e `test:demurrage-engine`. `render.yaml` não muda (Node 20, `plan: free`, sem banco). |
| `public/` | 0 | 0 | Inalterado. |

**Comportamento sem banco** (o `render.yaml` atual):
- a auth continua em arquivo;
- o scheduler e a captura não sobem;
- as rotas novas só falham se forem chamadas.

**Comportamento com banco:**
- o scheduler da Demurrage sobe automaticamente, sem kill switch (§8.1);
- a captura sobe, salvo `PRIORA_CAPTURA_PRE_ALERTA=off`;
- sem `PRIORA_TOKEN_CACHE_KEY`, o cache MSAL fica só em memória.

**Depois do substrato, na linha de origem:** só 4 arquivos de infraestrutura compartilhada mudam, todos específicos da Demurrage:
- `0035` (D15-A);
- `tracking/eventIngestion.ts` (D15-A);
- `src/index.ts` (rotas V2 da D12);
- `package.json` (harness de UI da D13).

## 4. Qualificação PostgreSQL (L0-A, 2026-10-08 22:41–22:50 UTC)

| Item | Resultado |
|---|---|
| Cluster | PostgreSQL 16.14, dedicado e temporário, só em 127.0.0.1:55432, autenticação `trust` local, `system_identifier` 7694431484921959201. O cluster do sistema não foi usado. |
| Bancos e role | `priora_l0a_dev` e `priora_l0a_test`, com dona `priora_l0a` (sem superusuário). Nenhuma migration exige superusuário ou extensão. |
| Servidor | fuso `Etc/UTC`, encoding UTF8, collation `C.UTF-8` |
| Migrations | 34, de `0001_organizations_and_users.sql` a `0034_responsabilidade_v1_2_agregado.sql`, contíguas e sem `0035`. Aplicadas em dev e teste. A 2ª execução em dev aplicou 0 e encontrou 34 já aplicadas (idempotente). |
| `schema_migrations` | dev e teste idênticos à lista de arquivos do substrato |
| Schema dev = teste | idênticos. SHA-256 do dump determinístico (`--restrict-key=L0AQUALIFICACAO`): `47edc5bcc758501be35fd36c4031936719dc89430cd597ea1052626a4352bc46`. |
| Impressão digital do schema (sem as linhas `\restrict`/`\unrestrict`) | `e3aad13ad97440ed210d59cfb8b2be5b5721588e45451e37e6e857ecbfd91d5a` |
| Objetos em `public` | 66 tabelas (contando `schema_migrations`), 0 views, 25 funções, 80 triggers, 187 índices, 8 enums |

**Nota sobre a comparação dos dumps.** O `pg_dump` 16.14 grava um token aleatório (`\restrict`/`\unrestrict`) a cada execução. A primeira comparação byte a byte diferia só nessas linhas. Com token fixo, os dumps ficaram idênticos.

## 5. Qualificação de runtime: Node 22 e Node 20

| Passo | Node 22.22.0 / npm 10.9.4 (L0-A) | Node 20.20.0 / npm 10.8.2 (L0-A.1) |
|---|---|---|
| `npm ci` com o lockfile | exit 0, 186 pacotes | exit 0, 186 pacotes; lock inalterado (SHA-256 `2cef7f1285f16d8206161793bdad227ad41f73f1cd9c44ea33977ef56532a9a1`); aviso EBADENGINE do `undici@8.11.2` |
| `npm run typecheck` | exit 0, 0 erros | exit 0, 0 erros |
| `npm run build` | exit 0, 194 `.js` | exit 0, 194 `.js` |
| `npm test` | 25/25 aprovados, 0 falhas/pulados (3,2 s) | 25/25 aprovados, 0 falhas/pulados (2,9 s) |
| `npm run test:demurrage-engine` | 569/569 aprovados, 0 falhas/cancelados/pulados/todo (154,8 s) | 569/569 aprovados, 0 falhas/cancelados/pulados/todo (153,6 s) |
| Arquivos da suíte executados | 38/38 | 38/38 |
| Títulos aprovados | 569 | os mesmos 569 de Node 22 |

- **594/594 testes em cada runtime**, sem nenhum teste pulado por falta de banco.
- O Node 20 usado é a única versão 20 disponível no ambiente da qualificação (`/opt/node20`). Não foi verificado se existe patch 20.x posterior.
- **Diferença de runtime fora das suítes:** `undici@8.11.2` falha ao carregar em Node 20 (`TypeError: webidl.util.markAsUncloneable is not a function`) e carrega em Node 22. O app não o alcança (§8.2).

## 6. Salvaguardas de isolamento de banco

**Preflight**, obrigatório antes de cada passo de banco:
1. `DEMURRAGE_DATABASE_URL` definida;
2. `DEMURRAGE_TEST_DATABASE_URL` definida;
3. as duas URLs diferentes;
4. `DATABASE_URL` ausente;
5. conexão real devolvendo exatamente `priora_l0a_dev|127.0.0.1|55432` e `priora_l0a_test|127.0.0.1|55432`;
6. chaves de serviços externos (`GEMINI_API_KEY`, `AZURE_CLIENT_SECRET`, `FEDEX_API_KEY`, `DHL_API_KEY`) ausentes.

Saída 1 = não executar o passo. Saída 2 = não foi possível provar bancos distintos, e toda atividade de banco é abortada.

**Testes negativos do preflight.** Todos foram bloqueados:

| Cenário | Saída |
|---|---|
| Sem URL de teste | 1 |
| URLs iguais | 2 |
| `DATABASE_URL` definida | 1 |
| URLs trocadas | 2 |
| Texto diferente apontando para o mesmo banco (`localhost` × `127.0.0.1`) | 2 |
| `GEMINI_API_KEY` definida | 1 |

**Provas de isolamento:**
- **Sentinela** no dev (`organizations`, slug `l0a-sentinela`, id `97db11b4-739b-48fc-be7f-6d6473c6e922`): intacta depois de todas as suítes, em Node 22 e Node 20.
- **Banco de dev** depois das suítes:
  - só `armador_codigos_tracking`=12 (seed da `0028`), `container_types`=12 (seed da `0009`), `organizations`=1 (sentinela) e `schema_migrations`=34;
  - as outras 62 tabelas vazias;
  - impressão digital do schema inalterada;
  - nenhuma linha inserida durante a L0-A.1.
- **Banco de teste efetivamente usado** (`pg_stat_database` após a L0-A): 15.727 commits e 123.885 linhas inseridas, contra 132 commits no dev.
- **Operações destrutivas das suítes:** executam `TRUNCATE … RESTART IDENTITY CASCADE` e `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (por exemplo `migrate.test.ts`, `migration0007.test.ts`, `registroDemurrageV12.test.ts`, `responsabilidadeAuditoria.test.ts`). Depois delas, os objetos da aplicação no banco de teste continuaram idênticos; só a metadata do schema `public` mudou.
- **Nenhuma chamada externa:** Gemini, Graph, armadores e FedEx/DHL não foram acionados. As suítes usam portas falsas (leitura de código). A rede foi usada só para `git ls-remote`, `npm ci` e uma chamada `npm audit --json`.
- **Checkout de trabalho intocado durante a L0-A e a L0-A.1:** HEAD `48ba7c1`, working tree limpo, sem worktree extra, sem commit nem push. A qualificação rodou numa worktree isolada criada a partir de um espelho.

## 7. Procedimentos reproduzíveis

### 7.1 Cluster dedicado temporário

O Postgres não roda como root, por isso os comandos usam o usuário de sistema `postgres`.

```bash
PGBASE=/var/lib/postgresql/priora-l0a   PGBIN=/usr/lib/postgresql/16/bin
if pg_isready -h 127.0.0.1 -p 55432; then echo "porta ocupada"; exit 1; fi
install -d -o postgres -g postgres -m 700 "$PGBASE"
runuser -u postgres -- $PGBIN/initdb -D "$PGBASE/data" -U postgres -A trust -E UTF8 --locale=C.UTF-8
runuser -u postgres -- $PGBIN/pg_ctl -D "$PGBASE/data" -l "$PGBASE/server.log" -w \
  -o "-c listen_addresses=127.0.0.1 -c port=55432 -c unix_socket_directories=$PGBASE" start
psql -X -h 127.0.0.1 -p 55432 -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE priora_l0a LOGIN" \
  -c "CREATE DATABASE priora_l0a_dev OWNER priora_l0a" \
  -c "CREATE DATABASE priora_l0a_test OWNER priora_l0a"
```

### 7.2 Ambiente dos passos de banco (`env.sh`)

```bash
unset DATABASE_URL GEMINI_API_KEY AZURE_CLIENT_SECRET FEDEX_API_KEY DHL_API_KEY PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
export DEMURRAGE_DATABASE_URL=postgresql://priora_l0a@127.0.0.1:55432/priora_l0a_dev
export DEMURRAGE_TEST_DATABASE_URL=postgresql://priora_l0a@127.0.0.1:55432/priora_l0a_test
```

### 7.3 Preflight (`preflight.sh`)

```bash
#!/usr/bin/env bash
# Saída 0 = OK; 1 = falha (não executar o passo); 2 = não foi possível provar
# que dev e teste são bancos distintos do cluster temporário (abortar TODA a
# atividade de banco).
set -uo pipefail
falha() { echo "PREFLIGHT FALHOU [$1]: $2" >&2; exit "$1"; }

[ -n "${DEMURRAGE_DATABASE_URL:-}" ]      || falha 1 "DEMURRAGE_DATABASE_URL não definida"
[ -n "${DEMURRAGE_TEST_DATABASE_URL:-}" ] || falha 1 "DEMURRAGE_TEST_DATABASE_URL não definida"
[ "$DEMURRAGE_DATABASE_URL" != "$DEMURRAGE_TEST_DATABASE_URL" ] || falha 2 "as duas URLs são iguais"
[ -z "${DATABASE_URL+x}" ] || falha 1 "DATABASE_URL definida (fallback proibido)"

q="select current_database()||'|'||host(inet_server_addr())||'|'||inet_server_port()"
dev=$(psql -XAt -d "$DEMURRAGE_DATABASE_URL" -c "$q" 2>&1) || falha 2 "sem conexão com a URL de dev: $dev"
tst=$(psql -XAt -d "$DEMURRAGE_TEST_DATABASE_URL" -c "$q" 2>&1) || falha 2 "sem conexão com a URL de teste: $tst"
[ "$dev" = "priora_l0a_dev|127.0.0.1|55432" ]  || falha 2 "URL de dev aponta para [$dev]"
[ "$tst" = "priora_l0a_test|127.0.0.1|55432" ] || falha 2 "URL de teste aponta para [$tst]"

for v in GEMINI_API_KEY AZURE_CLIENT_SECRET FEDEX_API_KEY DHL_API_KEY; do
  [ -z "${!v+x}" ] || falha 1 "$v definida (nenhuma chamada externa é permitida)"
done
echo "PREFLIGHT OK"
```

Todo passo que toca banco roda numa subshell: `( source env.sh; ./preflight.sh || exit; cd <worktree>; <comando> )`. Na L0-A.1, cada passo conferiu também a versão do Node antes de rodar.

### 7.4 Seed de identidade (procedimento previsto, não executado)

- **O que cria:** uma organização, os usuários internos com `home_account_id` e as memberships ADMIN/ANALYST, só no banco de dev dedicado e por SQL.
- **Por que não pela aplicação:** nenhum caminho de produção do substrato cria esses registros; os repositórios só são usados em testes.
- **Vínculo de caixa** (`POST /api/captura/caixas`): exige o app rodando com banco e login Microsoft, por isso está sujeito à restrição do §8.1.

## 8. Dívidas técnicas registradas na L0

### 8.1 Segurança do scheduler da Demurrage (restrição operacional obrigatória)

- Com banco configurado, o substrato sobe automaticamente o scheduler da Demurrage, com a porta real de tracking dos armadores e os transportes Graph de alerta.
- O scheduler não tem kill switch: só não sobe quando não há banco. A captura do pré-alerta tem kill switch (`PRIORA_CAPTURA_PRE_ALERTA=off`).
- **Até existir um kill switch aprovado, não iniciar a Priora com banco configurado em ambiente onde credenciais reais de tracking ou Graph sejam alcançáveis.**
- **A L0-B não iniciou o servidor da aplicação.**

### 8.2 Node 20 / undici

- O substrato usa `undici@8.11.2` (dependência direta `^8.10.0`, introduzida em `48ba7c1..a4b07b3`), que exige Node ≥22.19.0.
- O deploy atual declara Node 20 (`render.yaml`), e em Node 20.20.0 o `undici` falha ao carregar.
- O boot atual não carrega `src/browser/webUnblocker.ts`, único importador do `undici` e módulo órfão. A análise estática do grafo de `require` do `dist/` a partir de `dist/index.js` não alcança o `undici`. Portanto **não bloqueia a L0-B**.
- **Antes de S3 ativar esse caminho, a compatibilidade de runtime e dependências precisa ser resolvida.** Nada foi corrigido na L0-B.

### 8.3 Advisory do `proxy-addr`

| Item | Valor |
|---|---|
| Pacote e versão | `proxy-addr@2.0.7` |
| Caminho | transitiva e de produção: `priora` → `express@4.22.2` → `proxy-addr` (`~2.0.7`) |
| Advisory | GHSA-jqcg-44mw-7w3h ("IP spoofing via IPv4-mapped IPv6 trust subnet"), crítico, CVSS 9.1, faixa vulnerável `>=1.1.0 <2.0.8` |
| No ATUAL | **já existia em `48ba7c1`**, com as mesmas versões no lock; não foi introduzido pelo substrato |
| Uso pela Priora | a configuração atual (`app.set('trust proxy', 1)`, contagem de saltos) **não exercita** a confiança por sub-rede vulnerável |
| Correção | existe correção compatível, `2.0.8`, dentro do `~2.0.7` do Express |

- Não se roda `npm audit fix` e não se alteram dependências na L0-B.
- A atualização fica registrada como **hardening de segurança antes de produção**.

### 8.4 Testes de banco destrutivos

- Os testes de banco podem executar operações destrutivas, entre elas `TRUNCATE … CASCADE` e `DROP SCHEMA public CASCADE`.
- Se faltar `DEMURRAGE_TEST_DATABASE_URL`, o `testDb.ts` recorre a `DEMURRAGE_DATABASE_URL`/`DATABASE_URL`.
- **Banco de teste dedicado e preflight continuam obrigatórios em toda fase futura.**

O registro completo de dívidas está em `docs/liberacao-plano.md` §9.

## 9. Escopo e sequência da L0-B

**1. Pré-condições verificadas imediatamente antes de alterar o checkout:**
- branch `claude/busy-cori-8o1czj`;
- HEAD `48ba7c155f286adb79f32a8629c09334c769c6c8`;
- working tree limpo e sem worktree inesperada;
- `48ba7c1` ancestral de `a4b07b3`;
- SHA do candidato exatamente `a4b07b38a2ce520f4be3ed3c363f3a688b6a05d4`.

**2. Fast-forward:** só `git merge --ff-only a4b07b38a2ce520f4be3ed3c363f3a688b6a05d4`, sem rebase, merge commit nem force.

**3. Documentos criados (só estes quatro):**
- `docs/liberacao-blueprint-v1.fonte.md`: transcrição integral do `.docx` congelado (SHA-256 `a531d22bf0d9778757d85e00d72a0a03eada114add8be226e22f1f3e6f9a0739`), verificada item a item contra o original (421 itens idênticos, na mesma ordem);
- `docs/liberacao-decisoes.md`: H-1..H-17, N-1..N-19, fallback de fuso, escopos de propagação, fontes de verdade, idempotência, eficiência, terminalidade e derivações aprovadas (inclusive o N-11 corrigido);
- `docs/liberacao-plano.md`: L0–L11, S1–S8, dependências, caminho crítico, Vertical 1 — Fundação Real de Liberação, verticais seguintes, convenção de migrations, handoffs e dívidas;
- `docs/liberacao-fase-l0.md`: este documento.

**4. Commit:** um único commit documental com só os quatro arquivos, depois de conferir que o diff em relação a `a4b07b3` não continha nenhuma outra mudança.

**5. Push:** de `claude/busy-cori-8o1czj` logo após o commit, criando a branch remota, sem force e sem PR. Um commit não pode conter o próprio SHA, por isso o SHA do commit e o resultado do push ficam no relatório de execução da L0-B.

**6. Nenhum servidor da aplicação nem integração operacional externa é iniciado na L0-B.**

## 10. Evidências

- **Onde ficaram os logs brutos:** no scratchpad da sessão cloud em que a L0 foi executada (`l0a/` e `l0a1/`), um ambiente efêmero, sem versionamento no repositório.
- **Valores verificáveis registrados neste documento:** SHAs, contagens, impressões digitais de schema, hash do lockfile, hash do `.docx` e os resultados das suítes.
