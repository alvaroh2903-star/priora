# Produção P1 — Diagnóstico e plano de implementação (só diagnóstico, sem código)

**Baseline do backend congelado:** `d5b4fbc` (D16 v1.1). Este documento não altera nenhum arquivo de código — é o diagnóstico e o plano exigidos antes de qualquer implementação.

> **Status da Produção P1 (atualizado após decisão final do usuário):**
> **Entrega 1 — APROVADA E CONGELADA** (após a corretiva v1.3).
> **Entrega 2 — APROVADA E CONGELADA** (após a corretiva v1.2).
> **Entrega 3 — APROVADA E CONGELADA** (decisão final do usuário, após a
> corretiva v1.1; código `d86132e`, relatório `7ef692f`).
> **Backend da Produção P1 — FORMALMENTE CONCLUÍDO.** O frontend e os demais
> itens listados no §7 **não fazem parte** deste encerramento: são trabalho
> futuro separado, cada um dependente de autorização explícita do usuário.
> Ver §6 para o detalhe do congelamento e os relatórios de entrega.

## 0. Status executivo

O motor Demurrage V2 (D10–D16 v1.1) está completo e testado (1.068 testes), mas **não tem nenhuma rota de produção que crie um processo**. Isso já era conhecido desde o D16. O que esta auditoria confirma, e que muda a urgência do diagnóstico, é mais grave do que "a integração ainda não foi construída":

**A captura automática de Shipping Instructions já está ligada em produção hoje** (`src/demurrage/capturaBootstrap.ts`, iniciada em `src/index.ts:139`, laço de 10 min) e **já está processando e-mails reais** — mas toda SI capturada automaticamente cai em `si_pendencias` com `tipo: 'processo_nao_identificado'` (`src/demurrage-engine/shippingInstructions/ingestaoShippingInstructions.ts:211-227`), porque a busca por um `processos` correspondente nunca encontra nada: **nada no sistema cria essa linha**. Não é uma lacuna futura — é uma capacidade real, rodando agora, cujo resultado é descartado sistematicamente porque falta exatamente a peça que este P1 entrega. Isso também significa que, no dia em que a entrada existir, um backlog de SI já capturadas poderá ser reconciliado reprocessando (rota manual já existente, §1.2) — não é preciso recapturar nada.

A segunda confirmação crítica: **não existe, em lugar nenhum do repositório, nenhum mecanismo de autenticação serviço-a-serviço** (API key, HMAC próprio, shared secret, mTLS, service account). Toda autenticação hoje é sessão humana MSAL (`requireAuth`). O contrato de handoff de entrada, se exposto por HTTP, não tem nenhum padrão existente para reaproveitar — tem de ser desenhado do zero, deliberadamente pequeno, e nunca confundido com o login humano.

Boa notícia: o contrato técnico de registro já existente (`demurrage.registro.v1`, D10) já resolve a maior parte dos requisitos funcionais do handoff (idempotência, hierarquia de fontes, pendências nomeadas, nunca inventar valor, atualização de processo OPEN pelo mecanismo de observação oficial, bloqueio de processo FINAL). O trabalho do P1 não é reinventar esse contrato — é (a) dar a ele um chamador real e confiável, (b) fechar as lacunas pontuais que impedem isso (identificador imontável a montante, autenticação de quem chama), e (c) abrir rotas operacionais para os serviços congelados que hoje só existem em teste.

---

## 1. Entry points de produção — mapa completo

### 1.1 Captura do pré-alerta (e-mail → sistema)

- **Laço automático — rota de produção alcançável, ligado por padrão.** `iniciarCapturaPreAlerta()` (`src/demurrage/capturaBootstrap.ts`), chamado em `src/index.ts:139`, roda a cada 10 min (`INTERVALO_CAPTURA_MS`, `src/demurrage-engine/shippingInstructions/capturaPreAlerta.ts:29`), separado do scheduler principal da Demurrage. Kill switch: `PRIORA_CAPTURA_PRE_ALERTA=off`.
- **Rotas HTTP — alcançáveis**, todas sob `requireAuth`, montadas em `/api/captura` (`src/routes/capturaRoutes.ts`, mount em `src/index.ts:79`):
  - `POST /api/captura/caixas` — vincula a caixa MSAL ativa a uma `organizationId`; exige ADMIN da organização.
  - `GET /api/captura/status` — leitura, exige apenas membership.
  - `POST /api/captura/caixas/:caixaId/pausar|retomar`, `DELETE /api/captura/caixas/:caixaId` — ADMIN + conta da sessão == caixa.
  - `POST /api/captura/caixas/:caixaId/backfill` — ADMIN, limitado (30 dias / 20 conversas).
- O motor (`src/demurrage-engine/shippingInstructions/capturaPreAlerta.ts`) identifica candidatas por marcador textual + código de processo íntegro, grava em `si_conversas_descobertas`, e chama a MESMA função de ingestão usada pela rota manual (ver 1.2), em modo `'automatico'`.

### 1.2 Shipping Instructions — ingestão

`ingerirShippingInstructions()` (`src/demurrage-engine/shippingInstructions/ingestaoShippingInstructions.ts:469`) é chamada em dois lugares de produção:
1. **Automático**, dentro do laço de 1.1 (`ingerirDescobertas`) — sem rota HTTP.
2. **Manual** — `POST /api/processes/:conversationId/shipping-instructions/reprocessar` (`src/routes/processRoutes.ts:186`, prefixo de `src/index.ts:67`), `requireAuth` + membership não-CLIENT.

**Achado crítico:** `ingerirShippingInstructions` só precisa de `organizationId`+`conversationId` — não precisa de um processo para extrair e persistir as intenções (`si_intencoes`). Só a etapa de **promoção** dessas intenções em observações reais (`aplicarIntencoes`, linha ~291) exige resolver um `processos` existente por número/MBL (`resolverProcesso`, linha 207) — e hoje essa resolução falha sempre (ver §0), gerando `si_pendencias.tipo = 'processo_nao_identificado'` em vez de aplicar qualquer fato.

### 1.3 Criação de processo / contêiner / registro Demurrage

- `registrarProcessoDemurrage()` (`src/demurrage-engine/registro/registrarProcessoDemurrage.ts:266`) — **zero chamadores de produção** confirmados por busca exaustiva em toda `src/` (todas as ~90 ocorrências são `__tests__`/`.test.ts`).
- `ContainerRepository` instanciado fora de teste só em 3 lugares, nenhum deles rota: `eventIngestion.ts:111` (ingestão de tracking, sobre contêiner já existente), `backfill/runBackfill.ts:75` (script sem caller de produção localizado), `trackingScheduler.ts:134` (só leitura). **Nenhuma rota cria contêiner.**
- **Módulo Demurrage legado (pré-D10) ainda está montado e vivo**: `src/routes/demurrageRoutes.ts` → `/api/demurrage` (`src/index.ts:77`). Mecanismo totalmente diferente — deriva tudo em tempo real do Outlook (`demurrageParser.ts`/`demurrageFilters.ts`) e persiste só "minuta solicitada" num arquivo JSON local (`demurrageStore.ts`), nunca em `processos`/`containers`. **Não compartilha nenhuma tabela com o motor V2** — convivem sem colisão porque o V1 só responde em `/` e `/solicitar-minuta` (comentário em `src/index.ts:70-74` confirma que a ordem de montagem foi deliberada).

### 1.4 Criação de tracking target

`TrackingTargetRepository.upsert()`/`.linkContainer()` (`src/demurrage-engine/persistence/trackingTargetRepository.ts:44,66`) — chamados por `registrarProcessoDemurrage.ts:774-776` (sem caller de produção, ver 1.3) e por `eventIngestion.ts:306` (`sincronizarReferencia`, cujo único chamador também é só teste). O scheduler de tracking ativo em produção (`trackingScheduler.ts:124`) **só lê** vínculos já existentes — nunca cria. **Conexão ausente, com efeito em cascata**: mesmo que um contêiner existisse, o scheduler não o rastrearia até um target ser criado e vinculado — o que hoje não acontece em lugar nenhum da produção.

### 1.5 Resolução de organização — três padrões distintos coexistem

1. **Só sessão, nunca corpo** (`leitura/autorizacao.ts`): resolve por membership do usuário autenticado; rejeita explicitamente `organizationId` em query/corpo/cabeçalho (`400 parametro_nao_aceito`). Usado por `/api/demurrage/v2*`.
2. **Corpo + cross-check de membership** (`processRoutes.ts`, `capturaRoutes.ts`): `organizationId` vem no corpo/query, mas toda escrita exige confirmar que o usuário autenticado tem membership real (não-CLIENT, ou ADMIN conforme a rota) naquela organização antes de agir.
3. **Nenhum conceito de organização** (módulos V1/legados: `demurrageRoutes.ts`, `auditoriaRoutes.ts`, `courierRoutes.ts`, `emailRoutes.ts`, `analysisRoutes.ts`, `parseRoutes.ts`, `trackingRoutes.ts`) — single-tenant, operam direto sobre a caixa Microsoft conectada.

### 1.6 Autenticação de usuário/sessão

`requireAuth` (`src/middleware/requireAuth.ts`): sessão de cookie (`express-session`, arquivo, sobrevive a reinício) + MSAL (login Microsoft/Azure AD). `req.session` carrega só `homeAccountId`/`username`. Regra de MVP: **uma única conta Microsoft conectada por vez** no backend inteiro (`getActiveAccount()`) — login em `GET /auth/login`/`GET /auth/callback` (`src/auth/authRoutes.ts`, state HMAC-assinado anti-CSRF com `config.sessionSecret`).

### 1.7 Autenticação serviço-a-serviço (M2M)

**Achado negativo, confirmado por busca exaustiva: não existe.** Nenhuma API key própria, HMAC de entrada, shared secret, mTLS ou service account em todo o repositório. Todo uso de "API key" encontrado é SAÍDA (Priora como cliente de DHL/FedEx/Maersk/Gemini/brightData) — nunca entrada. O único header de organização (`x-organization-id`) existe só para ser **rejeitado**. Este é o achado mais determinante para o §2: o contrato de handoff, se exposto por HTTP, não adapta nada existente — desenha um mecanismo novo, mínimo, deliberadamente separado do login humano.

### 1.8 Montagem de rotas (`src/index.ts`, leitura integral)

Ordem de `app.use`, cada router aplicando seu próprio middleware (nenhum `requireAuth` global):

| Mount | Router | Auth interna | Natureza |
|---|---|---|---|
| `/auth` | `authRouter` | — (é o login) | MSAL |
| `/api/emails`, `/api/analysis`, `/api/parse` | legados | `requireAuth` | V1 (Outlook/IA) |
| `/api/processes` | `processRouter` | `requireAuth` + membership não-CLIENT no reprocessar SI | V1 + ponte ao engine (SI) |
| `/api/couriers`, `/api/tracking` | — | `requireAuth` | módulos não-demurrage |
| `/api/demurrage/v2/gestao`, `/api/demurrage/v2` | V2 | `requireAuth` + `autorizarInterno` (membership, papel interno) | só GET |
| `/api/demurrage` | legado | `requireAuth` | V1 (ver 1.3) — montado DEPOIS do V2 deliberadamente (comentário no código) |
| `/api/auditoria` | — | `requireAuth` | módulo Auditoria (documental, sem conceito de org) |
| `/api/captura` | V2 | `requireAuth` + ADMIN interno | captura pré-alerta |

Depois do boot: `app.listen` → `iniciarSchedulerDemurrage()` (scheduler principal) → `iniciarCapturaPreAlerta()` (§1.1) — dois laços de produção independentes, cada um com captura de erro própria que nunca derruba o servidor.

**Nota sobre o fluxo do produto:** os módulos `Auditoria` (`/api/auditoria`) e `Courier` (`/api/couriers`) **já existem e já têm rotas reais** neste mesmo repositório — não são hipotéticos. Só `Liberação` está ausente (ver 1.9). Isso é relevante para a decisão do §2: o futuro chamador do handoff pode acabar vivendo no MESMO monólito Express, seguindo o padrão já estabelecido por Auditoria/Courier, em vez de ser necessariamente um serviço externo.

### 1.9 Frontend mock vs. real

| Arquivo | Natureza |
|---|---|
| `public/PortalCliente.dc.html` | Mock estático puro — zero `fetch`/`/api/` |
| `public/Liberacao.dc.html` | Mock estático explícito ("Em construção") |
| `public/Demurrage.dc.html` | Real, mas para o legado V1 (`fetch('/api/demurrage'...)`) |
| `public/DemurrageOperacional.dc.html` + `demurrage-v2-apresentacao.js` | Real, V2, comprovadamente só-leitura (teste dedicado `demurrageV2UiZeroWrite.test.ts`) |

### 1.10 Conexões ausentes — lista consolidada

Além dos itens 1.3/1.4: `ClosingService` (toda a classe), `decidirResponsabilidade`, `resolverPendenciaManual`/`resolverPendenciaManualComClient`, `VesselCallRepository.resolverPendenciaManual` (análogo, outra classe, tracking), `tariffTableService.ativar`/`criarVersaoCorrigida`, `solicitarAtualizacaoManual` — **nenhum tem caller de produção**. Até os scripts de seed de tabela tarifária (`tariffs/seed/*.ts`, chamados só por `tariffTableService.ativar`) são órfãos duplos: nenhum script `npm` nem código de produção os referencia. O padrão é sistêmico: **todo o ciclo de escrita do motor V2 está isolado em teste** — as únicas gravações reais de produção hoje acontecem via SI (capturada, mas estéril sem processo — §0/1.2) e via scheduler de tracking (só re-sincroniza vínculos já existentes).

---

## 2. Contrato de handoff de entrada

### 2.1 Ponto de partida: o contrato já existe e já resolve quase tudo

`demurrage.registro.v1` (`src/demurrage-engine/registro/contrato.ts` + `registrarProcessoDemurrage.ts`) já entrega, sem precisar de nenhuma mudança de desenho:

| Requisito do P1 | Já resolvido por |
|---|---|
| Número de processo íntegro (preserva sufixo `-26`) | `normalizarNumeroProcesso` — remove só espaço/caixa |
| House/Master, armador, contêineres, equipamento original | Campos nativos do contrato |
| Free Time com fonte + evidência + `observadoEm` | `Observado<T>` em todo campo |
| Condição comercial ou pendência explícita | Campo opcional; ausência gera `condicao_comercial_ausente` (D15-B R26) |
| Responsável operacional | `responsavelOperacionalMembershipId` (`Observado<string>`, UUID de membership real) |
| Idempotência / replay seguro | `chaveIdempotencia` (default: hash do payload) + unicidade `(organization_id, chave_idempotencia)` em `demurrage_registros` — replay idêntico é NO-OP (`ja_registrado`), replay com payload diferente sob a MESMA chave é rejeitado (`CHAVE_IDEMPOTENCIA_REUTILIZADA`) |
| Atualização de processo OPEN pelos mecanismos oficiais | Reenviar com fatos novos (chave nova ou omitida) localiza o processo existente por `(organization_id, numero_processo)` e aplica cada campo via a MESMA hierarquia de fontes usada em qualquer outra via (`aplicarCampoProcesso`/`applyObservationComClient`) — nunca um caminho de escrita paralelo |
| Mudança em processo FINAL via contrato de reabertura congelado (D15-A) | Reenviar sobre um processo FINAL é rejeitado com `PROCESSO_FINAL` — nunca reabre por trás; reabertura só por `solicitarReabertura`/`autorizarReabertura` |
| Isolamento organizacional | `organizationId` obrigatório, FKs + triggers de imutabilidade em toda a cadeia |
| Pendência nomeada para dado parcial | Mecanismo de pendências já cobre ausência de condição comercial, tipo de equipamento não reconhecido, etc. |
| Nunca inventar default/zero | Princípio de desenho em toda a base — reafirmado aqui, não um requisito novo |
| Nenhuma chamada ao armador durante o registro | O contrato REJEITA explicitamente qualquer data operacional (descarga, ETA, Gate Out) — `CAMPO_NAO_ACEITO` — exatamente para impedir esse acoplamento |

**O trabalho do P1 não é reinventar isto — é dar a esse contrato um chamador real.**

### 2.2 O que falta de fato (lacunas reais, não cobertas hoje)

1. **Identificador imutável a montante.** O contrato tem `origem: { sistema, referencia? }` — `referencia` é texto livre, opcional, não indexado, não único. Não serve como identificador estável para a Liberação casar "este envio corresponde a este processo" ao longo do tempo (ex.: reenvios, correções). **Recomendação:** promover isso a um campo estruturado e indexado — `origemEventoId` (obrigatório quando a origem não é teste), único por `(organization_id, origem.sistema, origemEventoId)` — sem substituir `chaveIdempotencia` (que continua sendo "este PAYLOAD específico já foi processado?"); `origemEventoId` responde "este é o MESMO processo visto de novo, mesmo com fatos diferentes?". Hoje a chave idempotência sozinha não cobre isso: ela dedupe pelo hash do payload, não por identidade lógica do processo a montante.
2. **Dado de descarga "quando já confirmado".** O contrato PROÍBE explicitamente qualquer data operacional — decisão de desenho deliberada do D10 para impedir que o registro vire uma segunda porta de entrada para fatos que só o tracking do armador deve afirmar. O pedido do P1 ("discharge data when already confirmed") colide DIRETAMENTE com essa regra congelada. **Esta tensão não deve ser resolvida nesta fase de diagnóstico.** Três caminhos possíveis, nenhum escolhido aqui: (a) nunca aceitar descarga no handoff — se a Liberação já sabe a descarga, ela aciona a ingestão de tracking normal (`eventIngestion`) depois do registro, pelo canal já existente; (b) aceitar como MAIS UMA fonte estruturada dentro da matriz de fontes já existente (ex.: `fonte: 'liberacao_confirmada'`), mas isso efetivamente abre uma segunda porta para o fato que start a os relógios — mudança de regra congelada, não cabe num "handoff de registro"; (c) tratar como uma Observação armazenada mas NÃO aplicada aos relógios até o tracking confirmar de forma independente (double-check, nunca substituindo). **Recomendação para a entrega 1 (§6): adotar (a).** Não abrir essa porta agora; registrar a decisão aqui para uma fase de regra de negócio futura, fora do escopo "não reabrir relógios/cálculos" desta P1.
3. **Nenhuma autenticação confiável para quem chama.** Hoje `organizationId` é só validado como UUID bem formado — nada o liga à identidade de quem está fazendo a chamada, porque não existe caller de produção. Expor isto por HTTP sem resolver isso violaria a regra "organization identity from trusted authentication, never an arbitrary body override". Ver §5.

### 2.3 Decisão: HTTP interno E serviço in-process, através de UM serviço compartilhado

A base da decisão, apoiada no §1:
- Não existe hoje nenhum padrão de auth M2M (§1.7) — então expor HTTP exige construir essa peça do zero de qualquer forma.
- Auditoria e Courier (os dois elos anteriores do fluxo do produto) **já vivem neste mesmo monólito Express** (§1.8) — é plausível, talvez até provável, que a Liberação futura também viva aqui, não em outro deployment.
- O pedido explícito do enunciado é permitir "teste de integração controlado agora" — isso por si só já pede uma rota HTTP alcançável, mesmo que o chamador real de produção ainda não exista.

**Decisão recomendada: os dois, através de um único serviço de aplicação.**
- Uma função de serviço nova, versionada (`handoffRegistroDemurrage` ou nome equivalente), que envolve `registrarProcessoDemurrage` sem duplicar nenhuma regra — só adapta o formato de entrada/saída e aplica as validações do §2.2 (identificador a montante obrigatório, nenhuma data operacional aceita).
- Essa função é chamada tanto por uma rota HTTP interna nova (`POST /api/integracoes/liberacao/processos`, ou caminho equivalente — nome final decidido na entrega 1) protegida pelo mecanismo do §5.2, QUANTO por qualquer código futuro no mesmo processo (se a Liberação acabar sendo construída como mais um router deste monólito, como Auditoria/Courier) — sem precisar de HTTP para se chamar a si mesma.
- Isso evita duplicar a regra de negócio em dois lugares e mantém a porta HTTP fina (tradução + auth), exatamente como o restante da base já faz com `autorizarInterno`.

---

## 3. Inventário de APIs de mutação operacional

Para cada serviço: método/caminho proposto, papéis, resolução de organização, idempotência, respostas/erros, evidência de auditoria, serviço chamado, e se é obrigatório para a primeira operação.

| # | Serviço | Rota proposta | Papéis | Idempotência | Erros nomeados (amostra) | Auditoria existente | Obrigatório na 1ª operação? |
|---|---|---|---|---|---|---|---|
| 1 | Fallback manual de Free Time | Não é uma rota isolada — é o MESMO handoff/atualização do §2 com `fonte:'manual_fallback'` | RBAC já resolvido dentro do serviço (ANALYST/MANAGER/ADMIN via `autorMembershipId`) | Mesma do registro (chave de payload) | `MANUAL_FALLBACK_INCOMPLETO`, `MANUAL_FALLBACK_NAO_ACEITO`, `MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO` | 3 camadas: ledger `field_observations`, `demurrage_fallback_manual_justificativas`, outbox de aviso aos gestores | **Sim** — é parte do mesmo contrato de entrada/atualização |
| 2 | Atualização manual de tracking | `POST /api/demurrage/v2/tracking-targets/:id/atualizar` | MANAGER/ADMIN (já checado dentro de `solicitarAtualizacaoManual`) | Natural — cooldown de 2h por target é a própria idempotência | `apenas_manager_admin`→403, `cooldown`→429 | **Lacuna real**: só grava timestamp, não quem pediu — acrescentar `membershipId` ao registro antes de expor por rota | Não — útil, não bloqueante |
| 3 | Decisão de responsabilidade | `POST /api/demurrage/v2/containers/:id/responsabilidade` | MANAGER/ADMIN (checado dentro do serviço) | `substituiDecisaoId` + `VERSAO_DESATUALIZADA` (controle otimista) cobre correção concorrente | `JUSTIFICATIVA_AUSENTE`, `EVIDENCIA_AUSENTE`, `PERIODO_INVALIDO`, `SOBREPOSICAO`, `EXIGE_REABERTURA`, `AUTOR_NAO_AUTORIZADO` (~16 códigos) | `responsabilidade_decisoes` (append-only, versionada) + `ClosingEventRepository` | **Sim** — sem isto, nenhum processo com demurrage chega a FINAL |
| 4a | Registrar/validar minuta | `POST /api/demurrage/v2/containers/:id/minuta`, `POST /api/demurrage/v2/minutas/:id/validar` | Registrar: qualquer papel interno/cliente (upload). Validar: MANAGER/ADMIN | Minuta tem `id` próprio; validação em processo já-FINAL com divergência retorna `exige_reabertura` em vez de aplicar | `NUMERO_DIVERGENTE`, `DATA_ANTERIOR_A_DESCARGA`, `minuta_nao_encontrada`, `apenas_manager_admin`, `divergencia_pendente` (exige 2ª chamada com `aceitarDivergencia`) | `ClosingEventRepository` (`MINUTA_RECEBIDA/REJEITADA/VALIDADA`, `FATO_MATERIAL_POS_FINAL`) | **Sim** — gate de fechamento depende disto |
| 4b | Reconhecer/resolver divergência Free Time | `POST /api/demurrage/v2/divergencias/:id/reconhecer|resolver` | ANALYST/MANAGER/ADMIN | Idempotente — estado já avançado devolve `false`, não erro | `PENDENCIA_NAO_ENCONTRADA`, `MOTIVO_OBRIGATORIO`, `AUTOR_NAO_AUTORIZADO` | `ft_divergencia_eventos` (append-only) | Não — só se D15-B gerar divergências neste release |
| 5 | Fechamento do processo | `POST /api/demurrage/v2/processos/:id/finalizar` | MANAGER/ADMIN | `ja_final` é NO-OP idempotente, não erro | `sem_conteineres`, `conteiner_nao_devolvido`, `apuracao_indeterminada`, `responsabilidade_em_analise`, `comprovacao_pendente`, `valor_cliente_nao_confirmado`, `valor_rocket_nao_confirmado` (~12 códigos) | Tabela `fechamentos` + `ClosingEventRepository` | **Sim** — é o objetivo final do fluxo operacional |
| 6 | Solicitar/autorizar reabertura | `POST /api/demurrage/v2/processos/:id/reabertura/solicitar`, `POST /api/demurrage/v2/reaberturas/:id/autorizar` | Solicitar: qualquer papel interno. Autorizar: só MANAGER/ADMIN (mais restrito) | Índice único parcial impede 2ª solicitação aberta simultânea; 2ª autorização concorrente perde a corrida com `reabertura_ja_autorizada` | `processo_nao_final`, `reabertura_ja_aberta`, `ator_nao_autorizado`, `reabertura_ja_autorizada` | Tabela `reaberturas` (com snapshot) + `ClosingEventRepository` | **Sim** — é o único caminho congelado para corrigir um FINAL |
| 7 | Resolução manual de pendência | `POST /api/demurrage/v2/pendencias/:id/resolver` | ANALYST/MANAGER/ADMIN | NO-OP idempotente se já resolvida | `PENDENCIA_NAO_ENCONTRADA`, `MOTIVO_OBRIGATORIO`, `AUTOR_NAO_AUTORIZADO` | Parcial — só a própria linha (`resolvido_por/motivo/em`), sem histórico de tentativas | **Sim** — é a forma do analista "completar dado faltante" que o enunciado do P1 exige (nunca criar processo, mas resolver pendência) |
| 8 | Administração de versão tarifária | `POST /api/admin/tarifas/*` (superfície separada, não `/v2`) | **Nenhum RBAC interno hoje** — teria que ser construído do zero na rota (ou adicionado ao serviço antes de expor) | `ativar` idempotente por natureza (trigger de imutabilidade); correção sempre cria versão nova | `TariffTableImutavelError`, `TariffTableNaoEncontradaError`, mais exceções de trigger Postgres não tipadas para contornos | **Lacuna real**: nenhuma autoria, nenhum evento — teria que ser acrescentada antes de expor por HTTP | **Não** — candidato a superfície administrativa separada numa fase posterior, não a 1ª operação |

Nota: existe um análogo de pendência de tracking (`VesselCallRepository.resolverPendenciaManual`) com a mesma régua do item 7, hoje igualmente sem rota — pode reusar a mesma rota genérica de pendências se o `tipo` identificar a tabela de origem, ou ganhar uma rota irmã; decisão de implementação, não de diagnóstico.

Nenhuma destas rotas deve conter regra de negócio — cada uma só resolve papel/organização, traduz o corpo da requisição para o input do serviço já existente, e traduz o resultado/erro para HTTP.

---

## 4. APIs de leitura

### 4.1 Rotas GET já existentes e prontas para o frontend redesenhado

`/api/demurrage/v2`: `GET /processos` (fila), `GET /filtros`, `GET /processos/:id`, `GET /processos/:id/timeline`, `GET /containers/:id`.
`/api/demurrage/v2/gestao`: `GET /operacional`, `/financeiro`, `/responsabilidade`, `/responsabilidade/decisoes`, `/eficiencia`, `/qualidade`, `/indicadores/:id/composicao`.

Todas comprovadamente zero-escrita (fingerprint de schema, D12 Gate G7), com paginação assinada e isolamento organizacional (D12/D16). Nenhuma mudança necessária nestas para o P1.

### 4.2 Lacunas de leitura estritamente necessárias para as ações do §3

1. **Lista de pendências com `id`.** `GET /processos/:id` já agrega pendências abertas por TIPO e CONTAGEM (`detalhe.ts:472-484`) — suficiente para mostrar "há 2 pendências" na tela, mas **não expõe o `id` de cada pendência**, que a rota de resolução (§3 item 7) exige. Falta: `GET /api/demurrage/v2/processos/:id/pendencias` devolvendo cada pendência com `id`, `tipo`, `contexto`, `aberta_em`.
2. **Reaberturas pendentes de autorização.** Não há leitura dedicada para "quais reaberturas estão em `SOLICITADA`, esperando um Gestor autorizar". Falta um `GET` (lista por organização, ou incluído no detalhe do processo) para a tela de Gestão localizar o `reaberturaId` a autorizar.
3. **Minutas pendentes de validação.** Mesma lacuna: nenhuma leitura hoje lista minutas em estado pendente de validação por `id`, fora do detalhe de um processo específico já conhecido.

Os itens 2 e 3 podem, a princípio, ser cobertos reaproveitando/estendendo `GET /processos/:id` (incluir `reaberturaId`/`minutaId` quando existirem) em vez de rotas novas — decisão de implementação da entrega 3, não deste diagnóstico.

---

## 5. Modelo de segurança

1. **Rotas de sessão de usuário** (tudo em `/api/demurrage/v2*`, `/api/captura`, e as novas rotas operacionais do §3): inalterado — `requireAuth` (MSAL) + `autorizarInterno`/checagem de membership equivalente. Nenhuma rota nova de ação operacional deve aceitar `organizationId` fora da sessão resolvida — mesma régua do Gate G6 (D12): presença do campo no corpo/query é erro explícito, nunca ignorado.
2. **Handoff futuro serviço-a-serviço** (§2.3): mecanismo NOVO, pequeno, deliberadamente separado do MSAL. Recomendação consistente com "não inventar uma nova plataforma de auth": um cabeçalho com um segredo compartilhado estático por integração (ex.: `x-liberacao-service-token`), validado contra uma variável de ambiente dedicada (`LIBERACAO_SERVICE_TOKEN` ou similar — NUNCA reaproveitar `SESSION_SECRET`, que protege um domínio de confiança diferente, o cookie de sessão humana). Isto não é uma "nova plataforma" — é o mesmo tipo de verificação de cabeçalho que a base já faz em outros lugares (ex.: rejeição de `x-organization-id`), só que validando em vez de rejeitando.
3. **Derivação de organização** no handoff: a organização NUNCA vem só do corpo da requisição de forma confiável por si só — ela precisa ser resolvida a partir de uma identidade que o segredo de serviço autoriza. Opção mais simples para a primeira operação: o segredo de serviço É por organização (um segredo por organização integrada, não um único segredo global) — então apresentar o segredo certo já prova o direito de agir naquela organização, sem precisar de um corpo "confiar nele mesmo". Isso espelha o espírito do padrão 2 do §1.5 (corpo + cross-check), adaptado para quem não tem membership humana.
4. **Checagem de membership**: para as rotas operacionais do §3 (todas de sessão humana), inalterado — cada serviço já resolve o papel pelo `membershipId` real, nunca por um papel informado pelo chamador.
5. **Proteção contra IDs de outra organização**: todo FK/trigger de imutabilidade já existente (D12/D16 §7) continua valendo sem mudança — a nova rota de handoff herda a mesma garantia só por passar `organizationId` resolvido (nunca confiado) para o MESMO `registrarProcessoDemurrage`.
6. **Proteção contra replay**: já resolvida pela chave de idempotência do contrato (§2.1) para o handoff. Para o segredo de serviço em si, recomenda-se um nonce/timestamp assinado por chamada (janela curta) SE e quando o handoff for exposto por HTTP além do ambiente de teste controlado — detalhe de implementação da entrega 1, não deste diagnóstico.
7. **Atribuição de auditoria**: toda escrita via handoff grava `origem.sistema`/`origemEventoId` (§2.2) no ledger `demurrage_registros`, já append-only — a atribuição "isto veio da Liberação, evento X" já fica registrada sem trabalho extra. Para as rotas operacionais (§3), a atribuição já é por `membershipId` real em cada serviço.
8. **Expectativa de rate limiting**: nenhum rate limiting existe hoje em NENHUMA rota deste repositório (confirmado por ausência total do termo em `src/`). Para a rota de handoff exposta por HTTP, recomenda-se um limite simples por organização (ex.: N requisições/minuto) na própria rota nova — não uma mudança de infraestrutura; não bloqueia a entrega 1, mas deve ser considerado antes de abrir a rota para tráfego não controlado.
9. **Manuseio de segredos**: seguir o padrão já estabelecido em `config.ts` (variável de ambiente lida uma vez, nunca logada, nunca com default não-vazio em produção) — o mesmo tratamento já dado a `SESSION_SECRET`/`GEMINI_API_KEY`/etc.

---

## 6. Sequência de implementação (3 entregas)

### Entrega 1 — Handoff de entrada

**STATUS: APROVADA E CONGELADA (decisão final do usuário, após a corretiva v1.3).**
Não alterar a superfície congelada desta entrega, salvo: bug comprovado;
falha de segurança/integridade; ou mudança explicitamente aprovada pelo
usuário. Relatórios, em ordem: `docs/demurrage-producao-p1-entrega-1.md`
(implementação original); `docs/demurrage-producao-p1-entrega-1-v1-1.md`
(vínculo estável do processo a montante, identidade imutável do evento,
sanitização de erro); `docs/demurrage-producao-p1-entrega-1-v1-2.md`
(segurança transacional de `resolverVinculoProcesso` — rollback garantido,
conflito oculto no INSERT do vínculo); `docs/demurrage-producao-p1-entrega-1-v1-3.md`
(elimina pool starvation sob concorrência — conexão dedicada para o lock
consultivo). Observação não bloqueante registrada na v1.3: a conexão
dedicada do lock fica fora do pool compartilhado — monitorar o limite
total de conexões PostgreSQL sob carga futura muito alta; não é motivo
para reabrir a superfície congelada preventivamente.

**Escopo:** serviço de aplicação versionado envolvendo `registrarProcessoDemurrage` (§2.1-2.2: acrescentar `origemEventoId` estruturado; decidir e implementar a opção (a) do §2.2 item 2 — nunca aceitar descarga); rota HTTP interna fina protegida pelo segredo de serviço por organização (§5.2-5.3); nenhuma chamada ao tracking durante o registro (já garantido pelo contrato).
**Gate de aceitação:** replay do mesmo payload nunca duplica processo/contêiner/ledger; reenvio com fatos novos atualiza um processo OPEN pelos mecanismos de observação oficiais (nunca um caminho paralelo); reenvio sobre um FINAL é rejeitado; organização nunca vem confiável só do corpo; dado parcial produz pendência nomeada, nunca default inventado; backlog de `si_pendencias.processo_nao_identificado` existente é reconciliável reprocessando a SI manual (sem mudança no reprocessamento).
**Regressão:** suíte completa do Demurrage Engine (D10–D16 v1.1, incluindo `d16Vertical.test.ts` e `schedulerClaimFencing.test.ts`); V1; `tsc`/build. Nenhum teste existente deve mudar de comportamento — só testes novos para a rota/serviço do handoff.
**Regressão final no congelamento (v1.3):** Demurrage Engine 1037/1037; V1 25/25; D13 UI 66/66; `tsc --noEmit` limpo; build limpo.

### Entrega 2 — Rotas de ação operacional

**STATUS: APROVADA E CONGELADA (decisão final do usuário, após a corretiva v1.2).**
Não alterar a superfície congelada desta entrega, salvo: bug comprovado;
falha de segurança/integridade; ou mudança explicitamente aprovada pelo
usuário. Relatórios, em ordem: `docs/demurrage-producao-p1-entrega-2.md`
(implementação original — rotas finas sobre os sete serviços congelados do
§3); `docs/demurrage-producao-p1-entrega-2-v1-1.md` (corretiva: regressão
vermelha corrigida, idempotência atômica do registro de minuta — migration
0043 —, verificação do tipo PERSISTIDO da pendência, auditoria de
concorrência das outras seis ações); `docs/demurrage-producao-p1-entrega-2-v1-2.md`
(corretiva final de integridade: migration 0044 — FK composta amarrando a
organização da idempotência de minuta à organização real do contêiner,
pelo banco —; guarda definitiva de minuta já processada movida para dentro
de `ClosingService.validarMinuta`, não só na rota; contrato de transporte
fechado para `Idempotency-Key`, com CHECK de banco como defesa em
profundidade).

**Escopo:** as rotas do §3 marcadas "obrigatório" (itens 1, 3, 4a, 5, 6, 7) — cada uma um wrapper fino sobre o serviço congelado correspondente, com RBAC/organização resolvidos na camada de rota (nunca regra de negócio nova); para o item 2 (tracking manual), acrescentar `membershipId` ao registro de auditoria antes de expor por rota.
**Gate de aceitação:** cada rota produz exatamente os mesmos efeitos que o teste do serviço já prova hoje (reusar os cenários — não reescrever a regra); cada erro nomeado do serviço mapeia para um código HTTP estável e documentado; nenhuma rota duplica uma validação que o serviço já faz.
**Regressão:** mesma suíte da entrega 1 + os testes novos da rota de handoff (não podem regredir) + novos testes de aceitação por rota, reusando os fixtures já citados no §3.
**Regressão final no congelamento (v1.2):** Demurrage Engine 1107/1107; V1 25/25; D13 UI 66/66; `tsc --noEmit` limpo; build limpo; nenhum arquivo de frontend alterado.

### Entrega 3 — Leitura para o frontend redesenhado

**STATUS: APROVADA E CONGELADA (decisão final do usuário, após a corretiva v1.1).**
Baseline do congelamento: branch `claude/practical-cerf-mnz7oj`, commit de
código da corretiva `d86132e`, commit do relatório da corretiva `7ef692f`.
Não alterar a superfície congelada desta entrega, salvo: defeito
comprovado; problema de integridade de dados; ou aprovação explícita do
usuário. Relatórios, em ordem: `docs/demurrage-producao-p1-entrega-3.md`
(implementação original, `507bf67`, corrigido pela v1.1 — trechos marcados
**[v1.1]**); `docs/demurrage-producao-p1-entrega-3-v1-1.md` (corretiva:
chave exata do cursor, validação estrita de parâmetros, 500 genérico,
índice de pendências resolvidas — migration 0046 —, `autorizadaEm` real
derivado do evento de autorização, documentação corrigida).

**Superfície congelada:**
- `GET /api/demurrage/v2/processos/:processoId/pendencias`;
- `GET /api/demurrage/v2/reaberturas`;
- `GET /api/demurrage/v2/minutas`;
- a projeção de contexto seguro das pendências (allowlist fechada por tipo);
- a paginação keyset exata e os contratos do cursor v2;
- o comportamento de organização e papel reusado do D12;
- o comportamento somente leitura (zero-escrita);
- a migration `0045`;
- a migration corretiva `0046`;
- o `autorizadaEm` real, derivado do evento de autorização;
- os contratos de resposta e os filtros documentados da Entrega 3.

**Limitações aceitas no congelamento:** exatamente as registradas em
`docs/demurrage-producao-p1-entrega-3-v1-1.md` §12, preservadas sem
alteração.

**Escopo:** as lacunas do §4.2 (lista de pendências com `id`; exposição de `reaberturaId`/`minutaId` pendentes) — só leitura, zero-escrita, mesma régua de paginação/assinatura/isolamento já estabelecida.
**Gate de aceitação:** nova(s) rota(s) comprovadamente zero-escrita (mesmo padrão de fingerprint do D12 G7); isolamento organizacional idêntico ao resto de `/api/demurrage/v2`.
**Regressão:** suíte completa + D13 UI (sem alterar a tela existente — só preparar o contrato que o redesenho futuro vai consumir).
**Regressão final no congelamento (v1.1)** — validação sequencial em
worktree limpo do commit `d86132e`, PostgreSQL real
(`docs/demurrage-producao-p1-entrega-3-v1-1.md` §9): testes novos da
corretiva 24/24; Entrega 3 23/23; Entrega 2 (ações) 70/70; Entrega 1
(handoff) 60/60; D12 read-model 75/75; Demurrage Engine completo 1154/1154;
V1 25/25; D13 UI 66/66 — em todas as etapas 0 falhas, 0 skips, 0
cancelados, 0 todo; `tsc --noEmit` limpo; build limpo; nenhum arquivo de
frontend alterado. Migrations aditivas da entrega:
`0045_leitura_operacional_indices.sql` e
`0046_leitura_operacional_pendencias_por_processo.sql`.

Nenhuma das três entregas toca cálculo, relógio, tarifa, cadência de tracking ou regra de responsabilidade/fechamento — todas são fios novos sobre serviços já congelados e já testados.

### Status consolidado da Produção P1

| Entrega | Status | Corretiva final | Regressão do Demurrage Engine no congelamento |
|---|---|---|---|
| 1 — Handoff de entrada | **APROVADA E CONGELADA** | v1.3 | 1037/1037 |
| 2 — Rotas de ação operacional | **APROVADA E CONGELADA** | v1.2 | 1107/1107 |
| 3 — Leitura para o frontend redesenhado | **APROVADA E CONGELADA** | v1.1 | 1154/1154 |

**Backend da Produção P1: FORMALMENTE CONCLUÍDO** (decisão final do
usuário, com o congelamento da Entrega 3 v1.1). Cada superfície congelada só
muda mediante: defeito comprovado; problema de integridade de dados (ou
falha de segurança, nas Entregas 1 e 2); ou aprovação explícita do usuário.

---

## 7. Trabalho futuro separado (fora da Produção P1)

Os itens abaixo **não fazem parte** do backend da Produção P1 concluído e
não foram iniciados. Cada um é uma frente própria, que depende de
autorização explícita do usuário para começar e não reabre nenhuma
superfície congelada, salvo pelas regras acima:

1. Implementação do frontend (redesenho; requer aprovação explícita de
   design do usuário).
2. Chamador Liberação → handoff (o lado da Liberação que invoca a entrada
   de handoff congelada na Entrega 1 — §2.3).
3. Limitação de taxa (rate limiting) do handoff antes de qualquer exposição
   externa (§5, item 8).
4. Administração de tarifas.
5. Administração de VesselCall (§3, nota sobre a pendência de VesselCall).
6. Tracking manual (§3, item 2).
7. Administração de divergências de Free Time (§3, item 4b).
8. Aposentadoria do V1 legado.

---

## Restrições reafirmadas

Sem redesenho de frontend nesta fase. Sem deploy em Supabase. Sem HeadCargo, Portal ou Liberação implementados. Sem tela de criação manual de processo. Sem novo cálculo de Demurrage. Nenhuma mudança no backend congelado nesta entrega (este documento não alterou nenhum arquivo de código).

**Parando aqui para aprovação antes de qualquer implementação.**
