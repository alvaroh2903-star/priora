# Runbook operacional — Backend Demurrage (D16)

Guia conciso para operar o backend do módulo Demurrage (motor V2, D10–D15-C v1.2) em produção. Não substitui os relatórios de fase (`docs/demurrage-fase-*.md`); é o ponto de partida para quem está de guarda.

> **Produção P1 — limitação aceita para o MVP:** **uma única organização em produção**, dona exclusiva da integração Microsoft. Captura, reprocessamento de Shipping Instructions, avisos por e-mail e V1 pertencem só a ela. **Não ative uma segunda organização** enquanto não existir um canal de integração por organização. **Checklist obrigatório de deploy: §12.**

## 1. Variáveis de ambiente obrigatórias/opcionais

| Variável | Obrigatória | Papel |
|---|---|---|
| `DATABASE_URL` ou `DEMURRAGE_DATABASE_URL` | Sim (uma das duas) | Conexão PostgreSQL de produção. Sem nenhuma das duas, `iniciarSchedulerDemurrage()` não inicia (loga aviso e retorna `null` — nunca derruba o processo). |
| `DEMURRAGE_TEST_DATABASE_URL` | Só em CI/dev | Banco descartável usado pela suíte de testes (`{ skip: !url }` em todo arquivo `*.test.ts`). Nunca aponte para produção. |
| `DEMURRAGE_TZ_OPERACIONAL` | Não (default `America/Sao_Paulo`) | Fuso da "data civil operacional" (D10 v1.3-4) usada por `passagemDoCalendario`, cadência de tracking e prioridade da fila. Alterar em produção desloca o "dia de corte" de todos os cálculos — mudança rara e deliberada, nunca um ajuste de rotina. |
| `PRIORA_CAPTURA_PRE_ALERTA` | Não (default `on`) | Kill switch da captura de e-mail (Graph delta) que alimenta o pré-alerta/Shipping Instructions. `off` desliga só esse laço; a Demurrage (scheduler principal) continua normalmente. |
| `SESSION_SECRET` | Sim em produção | Assina o cookie da sessão humana (`__Host-priora.sid`) e os cursores. O padrão de desenvolvimento é recusado em produção. Mesmo valor em todas as instâncias. |
| `PRIORA_TOKEN_CACHE_KEY` | Sim (Produção P1) | Cifra o cache MSAL durável e faz a conta da integração ficar gravada no banco. Sem ela, V1, captura e avisos enxergam a integração como desconectada (falha fechada). |
| `SESSION_IDLE_HOURS`, `SESSION_MAX_AGE_DAYS`, `PRIORA_ORIGENS_PERMITIDAS` | Não (padrões: 12 h, 7 dias, só a própria origem) | Ociosidade e vida absoluta da sessão; origens extras aceitas nas escritas. Mesmos valores em todas as instâncias. |
| Credenciais Microsoft Graph (config MSAL/token cache existente da Priora) | Sim, para notificações | Usadas por `criarGraphAlertTransport`/`criarAvisoDivergenciaTransportGraph`/`criarAvisoFallbackManualTransportGraph`/`criarAvisoPendenciaTransportGraph`. Sem token válido, as filas de aviso ficam `PENDING`/retentáveis — nunca perdem o item, nunca travam o tick. |

Nenhuma string de conexão real ou segredo é listado aqui — configure-os pelo mecanismo de segredos do ambiente de destino.

## 2. Como aplicar as migrations

```
node -r ts-node/register src/demurrage-engine/db/migrate.ts
```

ou, programaticamente, `runMigrations(pool)` (mesma função usada pela suíte de testes). O runner:
- aplica `migrations/*.sql` em ordem lexical, cada arquivo em sua própria transação;
- é idempotente — re-executar não reaplica o que já está em `schema_migrations`;
- é **estritamente aditivo**: 0001–0039 nunca são reescritas; uma correção posterior sempre chega como um arquivo novo (`00NN_...sql`), nunca como edição de um já entregue.

**Produção P1:** aplique as migrations até a `0051_integracao_microsoft_organizacao.sql` **antes** de publicar o código. O boot de produção recusa subir sem o schema da 0049 a 0051 (`docs/demurrage-producao-p1-autenticacao-filas.md` §13 e §19.5).

**Pré-requisito manual conhecido:** a migration `0037_d15c_integridade_tarifaria_e_filas.sql` aborta explicitamente (`RAISE EXCEPTION`) se `tariff_tables` já tiver versões duplicadas sob a nova unicidade (`NULLS NOT DISTINCT`). Isso só ocorreria num ambiente que já tivesse dado tarifário legado anômalo — a própria migration deixa claro que a resolução (qual versão é a verdadeira) é manual, nunca automática. Não há nenhum outro pré-requisito manual conhecido nas 39 migrations (a `0039`, D16 v1.1, só faz backfill automático — ver seção 7.1).

## 3. Como o scheduler inicia

`src/index.ts` chama `iniciarSchedulerDemurrage()` no boot assíncrono do processo. Esse laço (`startSchedulerLoop`, `~1h`, `runOnStart: true` — recupera a janela vencida imediatamente após um deploy/restart, sem esperar a próxima hora cheia) executa `executarTickDemurrage`, que por sua vez roda, em sequência e com fronteira de erro própria por etapa: calendário → tracking → alert outbox → Shipping Instructions reaplicadas → recálculo pendente → avisos de divergência → pós-commit outbox → avisos de fallback manual → avisos de pendência. Uma etapa com erro não derruba o processo nem impede as etapas seguintes de serem tentadas no próximo tick.

A captura de pré-alerta (`iniciarCapturaPreAlerta()`, também chamada no boot) é um laço **separado** (~10 min), isolado do scheduler principal — uma falha ali nunca afeta tracking/apuração.

## 4. Kill switches

- **Captura de e-mail (pré-alerta/SI):** `PRIORA_CAPTURA_PRE_ALERTA=off`. Desliga só a sincronização de pastas Graph; o resto da Demurrage continua.
- **Scheduler principal:** não tem um kill switch dedicado — desliga removendo `DATABASE_URL`/`DEMURRAGE_DATABASE_URL` (não recomendado em produção real; útil para um worker de leitura dedicado, sem laço de manutenção).
- **Transporte de notificação ausente/sem token:** nunca é tratado como erro fatal — cada fila de aviso (`alertOutbox`, `divergenciaAvisos`, `avisosFallbackManual`, `notificacaoPendencia`) deixa a entrega em `PENDING`/retentável em vez de falhar o tick.

## 5. Fuso operacional

`DEMURRAGE_TZ_OPERACIONAL` (default `America/Sao_Paulo`). Usado para a "data civil operacional" (dia de corte sem componente de hora) que decide cadência de tracking, prioridade da fila e passagem do calendário. Todo cálculo de dias/relógio em si opera sobre datas civis absolutas (`CivilDate`), não sobre timestamps — o fuso só decide ONDE cai a virada do dia.

## 6. Dependência do transporte de notificação

Todas as notificações de produção (alerta de falha de tracking, divergência de Free Time, fallback manual, pendência) saem via **Microsoft Graph** (envio de e-mail pela conta corporativa já integrada à Priora — mesma infraestrutura MSAL usada pelo restante do sistema). Não há transporte alternativo (SMTP direto, SMS, push) configurado nesta fase. Perda de credencial/token Graph não perde avisos — eles acumulam como `PENDING` e são reenviados quando o transporte voltar a responder.

**Produção P1 (organização dona):** a caixa da integração pertence a UMA organização, a dona. Só saem avisos cujo conteúdo é dessa organização. Um aviso de qualquer outra organização falha explicitamente com `canal_de_outra_organizacao`, sem chamar o Graph; sem organização dona vinculada, a falha é `integracao_sem_organizacao`. Os dois casos ficam como `FAILED` auditável até esgotar as tentativas. Por isso vale a limitação do MVP (§12).

## 7. Como identificar filas esgotadas

Toda fila de manutenção (outbox) expõe um contador `esgotados`/`esgotadas` no resultado do tick (visível no log estruturado, `formatarLogTick`) quando um item atinge o teto de tentativas (`tentativas >= max`, default 5 em todas) e fica em estado terminal (`FAILED`/`falha`). Consulta direta por fila:

```sql
-- pós-commit (novos processos)
SELECT id, tentativas, status, atualizado_em FROM demurrage_pos_commit_outbox WHERE status = 'falha';
-- fallback manual
SELECT id, tentativas, status FROM demurrage_fallback_manual_avisos WHERE status = 'FAILED';
-- avisos de pendência
SELECT id, tentativas, status FROM demurrage_pendencia_avisos WHERE status = 'FAILED';
-- divergência de Free Time
SELECT id, tentativas, status FROM ft_divergencia_entregas WHERE status = 'FAILED';
-- alert outbox (falha de tracking)
SELECT id, tentativas, status FROM tracking_alert_deliveries WHERE status = 'FAILED';
-- claim individual do tracking scheduler (ver protocolo de posse abaixo)
SELECT t.reference_value_canonical, c.janela, c.status, c.tentativas, c.claim_token
  FROM tracking_schedule_claims c JOIN tracking_targets t ON t.id = c.tracking_target_id
 WHERE c.status = 'failed';
```

Um item `FAILED`/`falha` nunca é reivindicado automaticamente de novo — fica visível para intervenção manual.

### 7.1 Protocolo de posse do claim individual (`tracking_schedule_claims`, D16 v1.1)

Diferente das filas acima (fila de trabalho/outbox), `tracking_schedule_claims` é uma barreira de **uma reivindicação por `(tracking_target_id, janela)` por dia** — não existe "reprocessar", só reivindicar de novo quando elegível. Desde a migration `0039`:

- `claim_token` (UUID) só existe enquanto `status = 'claimed'` — é a prova de posse ATUAL, renovada (um valor novo) a cada reivindicação OU retomada de claim expirado.
- Uma linha `status = 'claimed'` com `claimed_em` mais velho que o `staleInterval` (default 30 min) é retomável por outro worker — a retomada emite um `claim_token` novo; o antigo, mesmo que um worker lento ainda o apresente depois, não finaliza mais nada (rejeição explícita, nada é alterado).
- Uma linha `status = 'failed'` é retomável no próximo tick, sem limite de tentativas dedicado nesta tabela (diferente das filas de outbox, que têm teto de 5).
- **Nunca** editar `claim_token`/`status` manualmente nesta tabela — ao contrário das filas de outbox (seção 8), não há aqui um fluxo de "reenviar manualmente": a única forma segura de uma janela ser retomada é o próprio mecanismo de obsolescência (`staleInterval`) ou ela virar `failed` e ser retentada no próximo tick.

## 8. Como reprocessar/resolver pendências com segurança

- **Reenviar um item esgotado:** resetar `tentativas` e voltar o `status` para `pendente`/`PENDING` manualmente só deve ser feito após entender a causa raiz (ex.: token Graph expirado, destinatário inválido) — o próprio mecanismo de claim/lease/fencing garante que isso é seguro mesmo sob concorrência (nenhum outro worker reivindica um item que não está em `pendente`/`PENDING`).
- **Resolver uma pendência de dados ausentes/divergência manualmente:** usar `resolverPendenciaManual`/`resolverPendenciaManualComClient` (`src/demurrage-engine/registro/pendencias.ts`) — exige evidência e autor, nunca aceita resolução silenciosa. Nenhuma rota pública expõe isso ainda (ver limitação na seção 11); a chamada é feita hoje por quem opera o processo diretamente (console/script administrativo autenticado), nunca editando a tabela à mão.
- **Nunca** fazer `UPDATE` direto em `tariff_tables`/`tariff_brackets`/`valores_apurados` para "destravar" algo — os triggers de imutabilidade (D15-C) vão rejeitar qualquer tentativa sobre uma versão ativada ou usada; a correção correta é sempre uma nova versão via `tariffTableService.criarVersaoCorrigida`.

## 9. Como inspecionar um processo sem escrever dados

Toda a família de rotas `GET /api/demurrage/v2/*` (montada em `src/routes/demurrageV2Routes.ts` e `demurrageGestaoRoutes.ts`) é comprovadamente zero-escrita (fingerprint de todas as tabelas antes/depois, D12 Gate G7 — `demurrageV2Routes.test.ts`). Para inspecionar sem nenhum risco:
- `GET /api/demurrage/v2/processos` — fila operacional (prioridade, filtros, paginação por cursor assinado).
- `GET /api/demurrage/v2/processos/:id` e `/containers/:id` — detalhe do processo/contêiner, os dois relógios separados.
- `GET /api/demurrage/v2/processos/:id/timeline` — linha do tempo sanitizada (nunca payload bruto, token, stack ou mensagem técnica interna).
- `GET /api/demurrage/v2/gestao/*` — indicadores de gestão (operacional, financeiro, responsabilidade, eficiência, qualidade, drill-down).

Todas exigem papel interno (`ANALYST`/`MANAGER`/`ADMIN`) resolvido pelo membership da própria sessão — `organizationId` nunca é aceito via query/corpo/cabeçalho (rejeição explícita `400 parametro_nao_aceito`).

## 10. Backup e rollback

- **Backup:** backup/restore de PostgreSQL padrão (`pg_dump`/snapshot do provedor). Nenhum estado de negócio vive fora do Postgres (sem cache externo que precise de backup próprio).
- **Rollback de deploy de código:** seguro — o schema é estritamente aditivo (nunca remove coluna/tabela usada por uma versão anterior do código dentro das migrations já entregues), então reverter para um binário/imagem anterior contra o MESMO banco já migrado funciona sem passo extra, desde que a versão anterior não dependesse de uma migration ainda não aplicada.
- **Rollback de migration:** **não existe mecanismo de "down migration"** neste runner (decisão de projeto — ver `db/migrate.ts`). Reverter uma migration já aplicada em produção exige restaurar de um backup anterior ao deploy, nunca uma migration reversa. Planeje a janela de deploy de acordo.

## 11. Dependências externas conhecidas e integrações adiadas

- **HeadCargo:** nenhuma integração existe nesta base. Status financeiro externo não é consultável — fora do escopo do D16 (e de toda a V1).
- **Liberação:** nenhum backend existe (`public/Liberacao.dc.html` é estático). A porta `LiberacaoTimelinePort` está pronta no código (`responsabilidade/liberacaoPort.ts`) mas `sugerirResponsabilidade()` nunca é chamada automaticamente — a decisão de responsabilidade é sempre manual via serviço.
- **Portal do Cliente:** aba Demurrage permanece 100% mock estático — nenhuma rota real a alimenta.
- **Courier/Auditoria:** sem integração de produção nesta fase.
- **Entrada de dados em produção:** o contrato `registrarProcessoDemurrage()` (ponto de entrada de todo o motor V2) não tem, hoje, nenhuma rota HTTP nem job de scheduler que o chame em produção — só é exercitado pela suíte de testes. O motor está completo e testado, mas aguarda a integração controlada (ex.: com o pré-alerta/Auditoria) para receber dados reais. Da mesma forma, as ações de Gestor de fechamento/reabertura (`ClosingService`) e a escrita de decisão de responsabilidade (`decidirResponsabilidade`) existem como serviços testados, sem rota pública ainda.
- **Transporte de notificação:** só Microsoft Graph (seção 6) — sem fallback para outro canal nesta fase.

## 12. Implantação da Produção P1 — organização única (MVP)

Entrega de autenticação, identidade, atribuição e filas pessoais: **aprovada e congelada** em `8266fba`. A decisão formal está em `docs/demurrage-producao-p1-autenticacao-filas.md` §19.

**Limitação aceita (MVP)** — não é suporte multiorganização concluído:
- **somente uma organização em produção**;
- captura, reprocessamento, avisos e V1 pertencem **exclusivamente** à organização dona da integração;
- a ativação de uma segunda organização fica **bloqueada operacionalmente** (item 6);
- a arquitetura multiorganização (canal de integração por organização) é trabalho separado e exige autorização específica.

**Checklist obrigatório antes do deploy.** Comandos do operador: `npm run demurrage:provisionar -- <comando> … --operador … --motivo …`.

**Pré-requisito de ambiente (§1):** `SESSION_SECRET`, `DEMURRAGE_DATABASE_URL` e `PRIORA_TOKEN_CACHE_KEY`.

**Ordem dos itens:** 1, 2 e 3 antes de publicar o código; 4 depois de publicar e antes do smoke test; 5 antes de liberar os analistas; 6 antes de liberar e a cada mudança de provisionamento.

- [ ] **1. Migrations até a 0051**, antes do código.
  - Rodar `npm run db:migrate:demurrage`.
  - `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1` deve devolver `0051_integracao_microsoft_organizacao.sql`.
- [ ] **2. Administrador da plataforma provisionado.**
  - `vincular-usuario` + `adicionar-membro --org <organização do MVP> --papel ADMIN` + `admin-plataforma --ativar`.
  - Ele precisa de membership interno ativo para conectar a integração.
- [ ] **3. Usuários, memberships e papéis provisionados**, todos na organização do MVP.
  - `vincular-usuario` e `adicionar-membro --papel ANALYST|MANAGER|ADMIN`; ajustes com `definir-papel`.
  - Conferir com `listar-membros --org <organização do MVP>`.
- [ ] **4. Integração vinculada à organização do MVP.**
  - A conta técnica está conectada; o administrador de plataforma usa `/auth/integracao/conectar`.
  - Rodar `vincular-integracao-organizacao --org <organização do MVP>`.
  - `conta-integracao` deve mostrar `organizacaoDona` = organização do MVP e `vinculosAtivosDeOutrasContas` = `[]`.
- [ ] **5. Processos abertos atribuídos.**
  - Levantar com `processos-sem-responsavel --org <organização do MVP>`.
  - Atribuir com `atribuir-sem-responsavel --org … --para <membership>` ou com `atribuir-responsavel`.
- [ ] **6. Nenhuma segunda organização ativa para esses fluxos.** Cada consulta deve devolver **somente** a organização do MVP. A consulta da dona deve devolver **exatamente uma** linha, com `conta_atual = true`:

  ```sql
  SELECT organization_id, count(*) FROM organization_memberships
   WHERE desativado_em IS NULL AND papel IN ('ANALYST', 'MANAGER', 'ADMIN') GROUP BY organization_id;
  SELECT v.organization_id, (v.home_account_id = c.home_account_id) AS conta_atual
    FROM integracao_microsoft_vinculos v LEFT JOIN msal_conta_ativa c ON c.id = 'default'
   WHERE v.desvinculado_em IS NULL;
  SELECT organization_id, estado FROM email_caixas WHERE estado <> 'removida';
  SELECT organization_id, nome FROM demurrage_handoff_credenciais WHERE status = 'ATIVA';
  SELECT organization_id, count(*) FROM processos GROUP BY organization_id;
  ```

  - Outra organização em qualquer resultado **bloqueia o deploy** até uma decisão explícita. Nenhuma correção automática.
  - **Repita as consultas a cada mudança de provisionamento.** Não execute `adicionar-membro`, não crie credencial de handoff, não vincule caixa e não vincule a integração para outra organização.

Depois de publicar: rodar o smoke test do relatório (§13, passo 6). Ao trocar a organização dona no futuro, o que só acontece com autorização, limpe os stores locais da V1 e reinicie as instâncias (§13, passo 7).
