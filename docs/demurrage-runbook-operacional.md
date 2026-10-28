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
| `DEMURRAGE_ARQUIVOS_PROVEDOR`, `DEMURRAGE_ARQUIVOS_S3_ENDPOINT`, `_S3_REGIAO`, `_S3_BUCKET`, `_S3_ACCESS_KEY_ID`, `_S3_SECRET_ACCESS_KEY` | Sim em produção (Produção P1, arquivos de minuta) | Armazenamento de objetos PRIVADO (S3 compatível, HTTPS) onde ficam os arquivos reais das minutas. Ausente ou inválido em produção → o boot recusa subir (mensagem cita só o NOME da variável). Demais ajustes (`_TAMANHO_MAXIMO_BYTES`, `_UPLOAD_EXPIRA_MIN`, `_ENVIO_POSSE_MIN`, `_NAO_VINCULADO_EXPIRA_DIAS`, `_REMOCAO_CARENCIA_DIAS`, `_LIMPEZA_AUTOMATICA`, `_TIMEOUT_MS`, `_S3_PATH_STYLE`) em `docs/demurrage-producao-p1-arquivos-minuta.md` §4. `filesystem-dev` só fora de produção. |
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

**Produção P1:** aplique as migrations até a `0053_documentos_armazenados.sql` **antes** de publicar o código. O boot de produção recusa subir sem o schema da 0049 a 0053 (`docs/demurrage-producao-p1-autenticacao-filas.md` §13 e §19.5; a 0052, administração tarifária — aprovada e congelada em `39fe34b` —, em `docs/demurrage-producao-p1-administracao-tarifas.md` §10 e §16.5; a 0053, arquivos das minutas, em `docs/demurrage-producao-p1-arquivos-minuta.md` §12 e §14).

**Pré-requisito manual conhecido:** a migration `0037_d15c_integridade_tarifaria_e_filas.sql` aborta explicitamente (`RAISE EXCEPTION`) se `tariff_tables` já tiver versões duplicadas sob a nova unicidade (`NULLS NOT DISTINCT`). Isso só ocorreria num ambiente que já tivesse dado tarifário legado anômalo — a própria migration deixa claro que a resolução (qual versão é a verdadeira) é manual, nunca automática. Não há nenhum outro pré-requisito manual conhecido nas 39 migrations (a `0039`, D16 v1.1, só faz backfill automático — ver seção 7.1).

## 3. Como o scheduler inicia

`src/index.ts` chama `iniciarSchedulerDemurrage()` no boot assíncrono do processo. Esse laço (`startSchedulerLoop`, `~1h`, `runOnStart: true` — recupera a janela vencida imediatamente após um deploy/restart, sem esperar a próxima hora cheia) executa `executarTickDemurrage`, que por sua vez roda, em sequência e com fronteira de erro própria por etapa: calendário → tracking → alert outbox → Shipping Instructions reaplicadas → recálculo pendente → avisos de divergência → pós-commit outbox → avisos de fallback manual → avisos de pendência → recálculo tarifário → encerramento automático → limpeza de documentos (Produção P1, arquivos de minuta: expira uploads abandonados e remove objetos nunca vinculados, com orçamento de tempo, por último). Uma etapa com erro não derruba o processo nem impede as etapas seguintes de serem tentadas no próximo tick.

A captura de pré-alerta (`iniciarCapturaPreAlerta()`, também chamada no boot) é um laço **separado** (~10 min), isolado do scheduler principal — uma falha ali nunca afeta tracking/apuração.

## 4. Kill switches

- **Captura de e-mail (pré-alerta/SI):** `PRIORA_CAPTURA_PRE_ALERTA=off`. Desliga só a sincronização de pastas Graph; o resto da Demurrage continua.
- **Scheduler principal:** não tem um kill switch dedicado — desliga removendo `DATABASE_URL`/`DEMURRAGE_DATABASE_URL` (não recomendado em produção real; útil para um worker de leitura dedicado, sem laço de manutenção).
- **Limpeza de arquivos de minuta:** `DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA=false` desliga só a etapa do tick que expira uploads abandonados e remove objetos nunca vinculados (use ao restaurar o banco de um backup; ver §10). Upload, download e registro de minuta continuam.
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
- **Nunca** fazer `UPDATE` direto em `tariff_tables`/`tariff_brackets`/`valores_apurados` para "destravar" algo — os triggers de imutabilidade (D15-C) vão rejeitar qualquer tentativa sobre uma versão ativada ou usada; a correção correta é sempre uma nova versão: em produção, pela administração tarifária (`POST /api/demurrage/v2/tarifas/versoes/:id/nova-versao` → editar o rascunho → `/ativar`, MANAGER/ADMIN, auditado — `docs/demurrage-producao-p1-administracao-tarifas.md` §4); `tariffTableService.criarVersaoCorrigida` continua só para seeds/testes.

## 9. Como inspecionar um processo sem escrever dados

Toda a família de rotas `GET /api/demurrage/v2/*` (montada em `src/routes/demurrageV2Routes.ts` e `demurrageGestaoRoutes.ts`) é comprovadamente zero-escrita (fingerprint de todas as tabelas antes/depois, D12 Gate G7 — `demurrageV2Routes.test.ts`). Para inspecionar sem nenhum risco:
- `GET /api/demurrage/v2/processos` — fila operacional (prioridade, filtros, paginação por cursor assinado).
- `GET /api/demurrage/v2/processos/:id` e `/containers/:id` — detalhe do processo/contêiner, os dois relógios separados.
- `GET /api/demurrage/v2/processos/:id/timeline` — linha do tempo sanitizada (nunca payload bruto, token, stack ou mensagem técnica interna).
- `GET /api/demurrage/v2/gestao/*` — indicadores de gestão (operacional, financeiro, responsabilidade, eficiência, qualidade, drill-down).

Todas exigem papel interno (`ANALYST`/`MANAGER`/`ADMIN`) resolvido pelo membership da própria sessão — `organizationId` nunca é aceito via query/corpo/cabeçalho (rejeição explícita `400 parametro_nao_aceito`).

## 10. Backup e rollback

- **Backup:** backup/restore de PostgreSQL padrão (`pg_dump`/snapshot do provedor). **Exceção (Produção P1, arquivos de minuta):** o BINÁRIO dos arquivos das minutas vive no armazenamento de objetos (bucket S3 compatível) — proteja-o com o mecanismo do provedor (versionamento do bucket recomendado). O banco guarda só metadados e vínculos.
- **Restauração do banco a partir de backup:** antes de subir, `DEMURRAGE_ARQUIVOS_LIMPEZA_AUTOMATICA=false`; rode `npm run demurrage:arquivos -- diagnosticar` (objetos que o banco restaurado não conhece aparecem como órfãos e nunca são apagados automaticamente); só então religue a limpeza.
- **Rollback de deploy de código:** seguro — o schema é estritamente aditivo (nunca remove coluna/tabela usada por uma versão anterior do código dentro das migrations já entregues), então reverter para um binário/imagem anterior contra o MESMO banco já migrado funciona sem passo extra, desde que a versão anterior não dependesse de uma migration ainda não aplicada.
- **Rollback de migration:** **não existe mecanismo de "down migration"** neste runner (decisão de projeto — ver `db/migrate.ts`). Reverter uma migration já aplicada em produção exige restaurar de um backup anterior ao deploy, nunca uma migration reversa. Planeje a janela de deploy de acordo.

## 11. Dependências externas conhecidas e integrações adiadas

- **HeadCargo:** nenhuma integração existe nesta base. Status financeiro externo não é consultável — fora do escopo do D16 (e de toda a V1).
- **Liberação:** nenhum backend existe (`public/Liberacao.dc.html` é estático). A porta `LiberacaoTimelinePort` está pronta no código (`responsabilidade/liberacaoPort.ts`) mas `sugerirResponsabilidade()` nunca é chamada automaticamente — a decisão de responsabilidade é sempre manual via serviço.
- **Portal do Cliente:** aba Demurrage permanece 100% mock estático — nenhuma rota real a alimenta.
- **Courier/Auditoria:** sem integração de produção nesta fase.
- **Entrada de dados em produção:** o contrato `registrarProcessoDemurrage()` (ponto de entrada de todo o motor V2) não tem, hoje, nenhuma rota HTTP nem job de scheduler que o chame em produção — só é exercitado pela suíte de testes. O motor está completo e testado, mas aguarda a integração controlada (ex.: com o pré-alerta/Auditoria) para receber dados reais. Da mesma forma, as ações de Gestor de fechamento/reabertura (`ClosingService`) e a escrita de decisão de responsabilidade (`decidirResponsabilidade`) existem como serviços testados, sem rota pública ainda.
- **Transporte de notificação:** só Microsoft Graph (seção 6) — sem fallback para outro canal nesta fase.
- **Armazenamento de objetos (Produção P1, arquivos de minuta):** provedor S3 compatível (AWS S3, Cloudflare R2, Backblaze B2, MinIO), cliente SigV4 próprio. Indisponível → upload/download respondem 502 e o registro de minuta nova fica impossível (exige arquivo disponível); nada do que já está confirmado é perdido. Reconciliação: `npm run demurrage:arquivos -- diagnosticar | corrigir --operador … --motivo …`.

## 12. Implantação da Produção P1 — organização única (MVP)

Entrega de autenticação, identidade, atribuição e filas pessoais: **aprovada e congelada** em `8266fba`. A decisão formal está em `docs/demurrage-producao-p1-autenticacao-filas.md` §19.

Administração operacional de tarifas: **aprovada e congelada** em `39fe34b` (commits `408aff1` e `39fe34b`, baseline `605bde2`). A decisão formal está em `docs/demurrage-producao-p1-administracao-tarifas.md` §16; checklist obrigatório nos itens 1 e 7 abaixo (§16.5 do relatório).

**Limitação aceita (MVP)** — não é suporte multiorganização concluído:
- **somente uma organização em produção**;
- captura, reprocessamento, avisos e V1 pertencem **exclusivamente** à organização dona da integração;
- a ativação de uma segunda organização fica **bloqueada operacionalmente** (item 6);
- a arquitetura multiorganização (canal de integração por organização) é trabalho separado e exige autorização específica.

**Checklist obrigatório antes do deploy.** Comandos do operador: `npm run demurrage:provisionar -- <comando> … --operador … --motivo …`.

**Pré-requisito de ambiente (§1):** `SESSION_SECRET`, `DEMURRAGE_DATABASE_URL` e `PRIORA_TOKEN_CACHE_KEY`.

Arquivos reais das minutas (Produção P1, **não congelada**): `docs/demurrage-producao-p1-arquivos-minuta.md`; checklist próprio no §14 do relatório, resumido no item 8 abaixo.

**Ordem dos itens:** 1, 2 e 3 antes de publicar o código (a consulta de segurança do item 7 e os itens 8.1–8.5 também); a confirmação do boot (itens 1 e 8.6) ao publicar; 4 depois de publicar e antes do smoke test; 5 antes de liberar os analistas; 6 antes de liberar e a cada mudança de provisionamento; 7 (tarifas ativas) antes de liberar os encerramentos automáticos; 8.7 depois de publicar.

- [ ] **1. Migrations até a 0053**, antes do código.
  - Rodar `npm run db:migrate:demurrage`.
  - `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1` deve devolver `0053_documentos_armazenados.sql`.
  - **Ao publicar, confirmar que o boot reconhece as migrations:** em produção o boot recusa subir sem o schema da 0049 a 0053; a instância deve subir **sem** a mensagem `[boot] schema da migration 00NN ausente…`. Conferência equivalente: `SELECT 1 FROM tariff_versao_transicoes LIMIT 0` e `SELECT 1 FROM documentos_armazenados_envios LIMIT 0` sem erro.
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

- [ ] **7. Tarifas da organização do MVP** (administração tarifária, **aprovada e congelada** em `39fe34b` — `docs/demurrage-producao-p1-administracao-tarifas.md` §15 e §16). Sem tabela ATIVA aplicável, processo com demurrage não encerra (`valor_cliente_nao_confirmado` / `valor_rocket_nao_confirmado`).
  - **Antes do deploy — consulta de segurança das tarifas legadas de armador com organização:** `SELECT count(*) FROM tariff_tables WHERE tipo = 'armador' AND organization_id IS NOT NULL;` **deve ser 0**. Diferente de 0 (linha privada de armador legada, que passaria a valer para a organização; relatório §3.3/§12) **bloqueia o deploy** até decisão explícita. Nenhuma correção automática.
  - **Antes de liberar os encerramentos automáticos:** um MANAGER/ADMIN cria, valida e ativa pela API `/api/demurrage/v2/tarifas` a tabela do cliente (Termo Único e/ou as de Termo por Embarque referenciadas pelas condições) e as de exposição estimada de cada armador usado. Não existe interruptor próprio do encerramento automático: o bloqueio pelos gates é a proteção.
  - Conferir que nenhum recálculo tarifário ficou esgotado: `SELECT count(*) FROM recalculo_outbox WHERE tipo = 'tarifa' AND estado = 'FAILED' AND tentativas >= 5;` deve ser 0 (senão, `GET /eventos/:id/recalculo` e `POST …/reprocessar`), e `SELECT count(*) FROM tariff_recalculo_expansoes WHERE concluida_em IS NULL;` deve cair a 0 em até um tick. Na linha do tick, o segmento `recalculo-tarifario` deve vir sem `ERRO=`/`ENCERRAMENTO-ERRO=` e com `expansao-falhas=0` (diferente de 0 por vários ticks = processo com lock retido).

- [ ] **8. Arquivos reais das minutas** (`docs/demurrage-producao-p1-arquivos-minuta.md` §14). Sem arquivo armazenado disponível, contêiner com demurrage não encerra (`minuta_sem_arquivo_disponivel`) e nenhuma minuta nova é registrada.
  - 8.1 Bucket **privado** (no R2: `r2.dev` desligado e nenhum domínio conectado; na AWS/B2: Block Public Access); versionamento recomendado.
  - 8.2 Credencial da aplicação só com `GetObject`, `PutObject`, `DeleteObject` e `ListBucket` no bucket — sem `DeleteObjectVersion`, `PutBucketPolicy`, `PutObjectAcl`, `BypassGovernanceRetention`.
  - 8.3 Smoke test manual do provedor com a credencial (PUT, HEAD, GET, LIST, DELETE de um objeto de teste fora de `doc/v1/`).
  - 8.4 Variáveis `DEMURRAGE_ARQUIVOS_*` (§1) — sem elas o boot de produção recusa subir.
  - 8.5 **Consulta de pré-deploy do legado:** `npm run demurrage:arquivos -- diagnosticar --sem-orfaos` → `legadoBloqueante` lista os contêineres com demurrage em processo OPEN cuja minuta é só referência (ou aprovação antiga) e que deixam de encerrar até o reenvio do arquivo. Combine o reenvio com os analistas. Nos itens com `devolucaoSoLegada: true`, a devolução existe só na validação antiga: registrar a nova versão limpa essa devolução e o contêiner passa a esperar o tracking — registre só quando o tracking trouxer a devolução (relatório de arquivos, §10). `arquivoIndisponivelBloqueante` (arquivo interno indisponível, ex.: objeto marcado ausente) é incidente, não legado: restaure o objeto pelo versionamento do bucket e rode `corrigir` (desmarca o que reapareceu íntegro), ou peça o reenvio como nova versão.
  - 8.6 Ao publicar: log `[boot] armazenamento de documentos acessível (s3).`
  - 8.7 Depois do primeiro documento: `diagnosticar` com `leituraAnonima` = `recusada`, sem `problemas` e sem `arquivoIndisponivelBloqueante` (código de saída 0; 3 = alerta); segmento `documentos:` da linha do tick sem `ERRO=`/`INTERROMPIDA=`.

Depois de publicar: rodar o smoke test do relatório (§13, passo 6). Ao trocar a organização dona no futuro, o que só acontece com autorização, limpe os stores locais da V1 e reinicie as instâncias (§13, passo 7).
