# Produção P1 — Entrega 1: handoff automático e idempotente da Demurrage

**Baseline:** branch `claude/practical-cerf-mnz7oj`, diagnóstico `ea28c48`, backend congelado `d5b4fbc` (D10–D16 v1.1, migrations 0001–0039). Esta entrega acrescenta a migration 0040 (aditiva) e um módulo novo (`src/demurrage-engine/handoff/`), sem alterar nenhum arquivo congelado do backend D10–D16, nenhuma migration existente e **nenhum arquivo de frontend**.

---

## 1. Arquitetura

### 1.1 Um serviço de aplicação, dois chamadores

`processarEventoHandoff()` (`src/demurrage-engine/handoff/handoffService.ts`) é o único ponto de entrada. Ele:
1. valida o envelope do handoff (`validarEntradaHandoff`, `handoff/contrato.ts`);
2. resolve a identidade do evento (camada A, abaixo);
3. invoca o contrato oficial congelado `demurrage.registro.v1` (`registrarProcessoDemurrage`, D10) — nenhuma regra de negócio nova, nenhuma duplicação;
4. reconcilia o backlog de Shipping Instructions, melhor esforço;
5. devolve uma resposta tipada e discriminada por `resultado`.

Dois chamadores, zero duplicação de lógica:
- **In-process (confiável):** qualquer código do monólito chama `processarEventoHandoff(entrada, { organizationId, credencialIdentidade: CREDENCIAL_IDENTIDADE_INTERNA })` diretamente — contexto de organização já resolvido, **nunca** passa pela autenticação HTTP.
- **HTTP (adaptador fino):** `src/routes/demurrageHandoffRoutes.ts` — autentica (HMAC), faz o parse do corpo já verificado, e delega inteiramente ao mesmo serviço. A rota não contém nenhuma decisão de negócio: só tradução de protocolo (corpo cru → JSON; resposta tipada → status HTTP).

### 1.2 Duas camadas de idempotência, deliberadamente independentes

**Camada A — `demurrage_handoff_eventos` (nova).** Identidade do EVENTO a montante, por `(organization_id, origem_sistema, origem_evento_id)`. Resolve só uma coisa antes de tocar a camada B: o mesmo `origemEventoId` com um **payload_hash diferente** é conflito explícito — e nesse caso a camada B nunca é chamada (zero risco de escrita parcial). Com o mesmo hash (replay verdadeiro ou corrida concorrente), a chamada segue para a camada B.

**Camada B — `demurrage_registros` (D10, já existente e congelada, intocada).** Identidade do PAYLOAD normalizado, por `chaveIdempotencia`. O handoff deriva essa chave deterministicamente: `handoff:<origemSistema>:<origemEventoId>`. Isso faz o handoff **herdar de graça** todas as garantias de concorrência já comprovadas do D10: lock consultivo por processo/contêiner (ordem fixa, sem deadlock), `INSERT ... ON CONFLICT DO NOTHING`, e `CHAVE_IDEMPOTENCIA_REUTILIZADA` como segunda linha de defesa. Nenhum lock novo foi inventado — "entregas concorrentes idênticas aplicam uma vez" e "entregas concorrentes conflitantes têm desfecho determinístico" vêm diretamente dessa herança (comprovado nos cenários 5 e 6, §8).

A camada A nunca tenta decidir concorrência por si mesma: o perdedor da corrida de `INSERT ... ON CONFLICT DO NOTHING` da camada A, ao encontrar a linha ainda em aberto (sem resultado terminal), também chama a camada B — que então serializa de verdade. A conclusão da linha da camada A (`UPDATE ... WHERE concluido_em IS NULL`) é idempotente por natureza: a segunda escrita (do perdedor, se chegar depois) é um no-op silencioso.

### 1.3 Arquivos

| Arquivo | Responsabilidade |
|---|---|
| `handoff/contrato.ts` | Tipos e validação PURA do envelope do handoff (`demurrage.handoff.v1`) |
| `handoff/handoffService.ts` | Serviço de aplicação compartilhado — as duas camadas de idempotência, chamada ao D10, reconciliação de SI |
| `handoff/credencialCrypto.ts` | Cifra/decifra do segredo da credencial (AES-256-GCM, espelha `src/auth/cacheCrypto.ts`) |
| `handoff/credenciais.ts` | Ciclo de vida da credencial (provisionar/rotacionar/desabilitar/buscar) e registro de nonce |
| `handoff/assinatura.ts` | Construção da string canônica, HMAC-SHA256, comparação em tempo constante, janela de tolerância |
| `handoff/autenticacaoHttp.ts` | Middleware de autenticação HTTP (verificação da assinatura) |
| `routes/demurrageHandoffRoutes.ts` | Adaptador HTTP fino (corpo cru + autenticação + delegação) |
| `db/migrations/0040_handoff_demurrage.sql` | 3 tabelas novas (credenciais, nonces, eventos) |

---

## 2. Contrato de requisição e resposta

### 2.1 Entrada (`demurrage.handoff.v1`)

Subconjunto estrito do contrato D10 (`demurrage.registro.v1`), mais o envelope de identidade do evento:

```ts
{
  versao: 'demurrage.handoff.v1',
  origemSistema: string,          // obrigatório
  origemProcessoId: string,       // obrigatório — identificador ESTÁVEL do processo a montante
  origemEventoId: string,         // obrigatório — identificador IMUTÁVEL do evento/versão a montante
  origemOcorridoEm?: string,      // opcional — metadado de versão/ordem (ISO 8601), nunca uma data operacional
  numeroProcesso: string,         // obrigatório
  cliente?, house?, mbl?, armador?, condicaoComercial?,
  responsavelOperacionalMembershipId?, houseFreeTimeDays?, masterFreeTimeDays?: Observado<T>,
  containers: ContainerContrato[],
}
```

`organizationId` **nunca** é um campo aceito do envelope — a organização só vem do contexto autenticado (credencial HTTP ou chamador in-process confiável). Presente no corpo → `CONTRATO_INVALIDO` / `ORGANIZATION_ID_NAO_ACEITO_NA_ENTRADA`.

**Duas identidades do evento, conforme instrução do usuário:**
- `origemProcessoId` — identificador ESTÁVEL do processo a montante. Nunca derivado de MBL/HBL/número de contêiner/nome de cliente (campos comerciais mutáveis). Usado só para rastreabilidade (`demurrage_handoff_eventos.origem_processo_id`) — a identidade do processo Demurrage em si continua sendo `numeroProcesso`, exatamente como no D10.
- `origemEventoId` — identificador IMUTÁVEL do evento/versão a montante. É a chave de idempotência da camada A.

**Campos explicitamente fora deste contrato** (correção #5): qualquer chave como `descarga`, `dataDescarga`, `gateOut`, `gateIn`, `emptyReturn`, `eta`, `etb`, `ets`, `chegada`, `atracacao`, `berthing`, `responsabilidade`, `minuta`, `tarifa`, `fechamento`, `reabertura` → `CAMPO_OPERACIONAL_NAO_ACEITO`. Esses campos nem existem no contrato D10 subjacente (`validarRegistro` já os rejeitaria como `CAMPO_NAO_ACEITO`); a lista é reafirmada aqui com um código de erro próprio, mais claro para quem integra.

**`manual_fallback` nunca é aceito** (correção #4): é uma ação GOVERNADA por humano (justificativa + autor interno). O contrato D10 permite `manual_fallback` em House/Master Free Time; o contrato do handoff restringe isso ainda mais, rejeitando `manual_fallback` em qualquer campo, **antes mesmo de chamar o validador D10** → `FONTE_MANUAL_FALLBACK_NAO_ACEITA_NO_HANDOFF`.

### 2.2 Resposta — 7 categorias discriminadas por `resultado`

| `resultado` | Quando | Status HTTP |
|---|---|---|
| `APLICADO` | Primeira aplicação bem-sucedida, sem pendência aberta | 200 |
| `REPLAY_IDEMPOTENTE` | Mesmo evento, mesmo payload, já concluído antes | 200 |
| `ACEITO_COM_PENDENCIA` | Aplicado, mas com dado ausente (armador/MBL/tipo/Free Time) → pendência nomeada, nunca um valor inventado | 200 |
| `EXIGE_REABERTURA` | O processo já está FINAL — retido para auditoria, projeção FINAL nunca mutada | 409 |
| `CONFLITO_EVENTO` | Mesmo `origemEventoId`, payload diferente | 409 |
| `CONTRATO_INVALIDO` | Falha de validação do envelope (campo proibido, `manual_fallback`, `organizationId` no corpo, etc.) | 400 |
| `FALHA` | Erro inesperado na aplicação (ex.: referência a um membership inexistente) — recuperável, ver §6 | 500 |

Falha de autenticação (HTTP) é tratada **antes** de chegar ao serviço — nunca aparece nesta lista; ver §4.

---

## 3. Modelo de identidade e idempotência

Migration `0040_handoff_demurrage.sql` (aditiva — 0001–0039 intocadas):

- **`demurrage_handoff_credenciais`** — `id`, `organization_id`, `nome`, `status` (`ATIVA`/`DESABILITADA`), segredo cifrado (`chave_versao`, `iv`, `auth_tag`, `segredo_cifrado`), `criado_em`, `desabilitada_em`, `rotacionada_em`. Trigger `organization_id_immutable` (mesma convenção de toda tabela de tenant do repositório).
- **`demurrage_handoff_nonces`** — PK `(credencial_id, nonce)`. Cada nonce só pode ser usado uma vez por credencial.
- **`demurrage_handoff_eventos`** — `organization_id`, `credencial_identidade` (UUID da credencial HTTP ou marcador do chamador in-process), `origem_sistema`, `origem_processo_id`, `origem_evento_id`, `origem_ocorrido_em`, `payload_hash`, `processo_id` (FK composta para `processos`, quando conhecido), `resultado`, `falha_sanitizada`, `criado_em`, `concluido_em`. `UNIQUE (organization_id, origem_sistema, origem_evento_id)`. Dois triggers: `organization_id_immutable` (convenção padrão) e `demurrage_handoff_eventos_identidade_imutavel` (a identidade do evento — sistema/processo/evento/hash — é imutável após criada; só os campos de resultado podem mudar).

Os 7 campos mínimos exigidos estão todos presentes: organização, identidade da credencial autenticada, sistema de origem, `origemProcessoId`, `origemEventoId`, versão/ocorrência, hash canônico do payload, processo associado (quando conhecido), resultado, timestamps de criação/conclusão, e falha sanitizada.

### Comportamentos obrigatórios — como cada um é garantido

| Requisito | Mecanismo |
|---|---|
| Replay exato (mesmo org/evento, mesmo payload) → no-op idempotente | Camada A: hash igual, resultado terminal com sucesso → reconstrói a resposta via a MESMA chamada à camada B (que devolve `ja_registrado` sem reaplicar nada) |
| Mesmo evento, payload diferente → conflito explícito, sem escrita parcial | Camada A: `INSERT ... ON CONFLICT DO NOTHING`; se a linha já existe com hash diferente, a camada B **nunca é chamada** |
| Eventos diferentes para o mesmo `origemProcessoId` → evolução legítima | Cada `origemEventoId` tem sua própria linha; a camada B localiza o MESMO processo por `numeroProcesso` e aplica os fatos novos pela hierarquia de observação já existente |
| Entregas concorrentes idênticas → uma aplicação efetiva | Corrida da camada A resolve o "primeiro a escrever"; ambos os caminhos convergem na camada B, cujo lock consultivo + ledger idempotente garantem exatamente uma aplicação |
| Entregas concorrentes conflitantes → desfecho determinístico, sem duplicar nada | A camada A nunca chama a camada B para o payload que perde a corrida de identidade — então nunca existe um processo/contêiner do "perdedor" |
| Evento para processo OPEN → só pela hierarquia de observação oficial | O handoff só constrói o objeto `RegistroProcessoDemurrageV1` e chama `registrarProcessoDemurrage` — nenhum caminho de escrita paralelo |
| Evento para processo FINAL → retido para auditoria, `exigeReabertura=true`, projeção nunca mutada | `registrarProcessoDemurrage` lança `PROCESSO_FINAL` **antes** de qualquer escrita de campo (checagem `FOR UPDATE` no passo 3, congelada desde D15-A); o handoff captura isso e marca a linha da camada A como `EXIGE_REABERTURA` |
| Nunca derivar identidade do processo de MBL/HBL/contêiner/cliente | A identidade do processo é sempre `numeroProcesso` (como no D10); `origemProcessoId` é só rastreabilidade, nunca usado para localizar o processo |
| Dado ausente → pendência nomeada, nunca valor inventado | Herdado integralmente do D10 — o handoff não acrescenta nenhum default |

---

## 4. Protocolo de autenticação (HTTP)

Cabeçalhos exigidos em toda requisição a `POST /api/integracoes/demurrage/handoff/processos`:

| Cabeçalho | Conteúdo |
|---|---|
| `X-Handoff-Credencial-Id` | UUID da credencial |
| `X-Handoff-Timestamp` | Segundos Unix (string) |
| `X-Handoff-Nonce` | Único por credencial |
| `X-Handoff-Assinatura` | HMAC-SHA256 hex da string canônica |

**String canônica** (`handoff/assinatura.ts`): `MÉTODO\ncaminhoNormalizado\ntimestamp\nnonce\nSHA256-hex(corpoBruto)`, unidos por `\n`. O caminho é normalizado (sem query, sem barra final, minúsculo) e o hash cobre o **corpo exato** (bytes crus, antes de qualquer parse) — a assinatura nunca é calculada sobre uma reserialização do JSON.

**Ordem de verificação** (`handoff/autenticacaoHttp.ts`):
1. `organizationId` presente em query ou em `x-organization-id`/`x-organizacao-id` → `400 parametro_nao_aceito` (verificado antes de qualquer coisa — nunca aceito nem silenciosamente ignorado);
2. os 4 cabeçalhos presentes;
3. a credencial existe e está `ATIVA` (busca única, decifra o segredo);
4. assinatura recalculada e comparada em **tempo constante** (`timingSafeEqual`, com preenchimento de tamanho igual para nunca revelar o tamanho esperado por timing);
5. timestamp dentro da tolerância (`TOLERANCIA_TIMESTAMP_SEGUNDOS = 5 × 60`, documentada e testada);
6. nonce ainda não usado por esta credencial (`INSERT ... ON CONFLICT DO NOTHING` em `demurrage_handoff_nonces` — zero linhas inseridas = replay).

**Qualquer falha em qualquer um destes passos devolve a MESMA resposta genérica** (`401 {"error":"falha_autenticacao"}`) — credencial desconhecida, desabilitada, assinatura inválida e timestamp expirado são **indistinguíveis** pela resposta. A organização nunca é lida da requisição: o contexto devolvido ao serviço carrega só a organização da credencial autenticada.

**Segredo nunca em texto claro**: `credencialCrypto.ts` cifra com AES-256-GCM, espelhando exatamente o padrão já em produção para o cache de tokens MSAL (`src/auth/cacheCrypto.ts`) — envelope por versão de chave (`PRIORA_HANDOFF_CREDENCIAL_KEY`/`_VERSION`/`_V<n>`), AAD amarrando o cifrado ao id da linha, sem fallback em texto claro se a chave faltar (a ausência da chave é um erro de configuração, nunca um caminho alternativo). Esta é a peça que resolveu o portão condicional da instrução original: a arquitetura já tinha esse padrão provado e em uso — não foi necessário inventar um mecanismo novo nem substituir HMAC por um token plano.

**Rotação de credencial**: substituição atômica, imediatamente efetiva. `rotacionarCredencial()` gera um novo segredo e sobrescreve as 4 colunas cifradas numa única `UPDATE` — o segredo anterior para de validar no instante em que a rotação é confirmada (limitação conhecida: sem janela de sobreposição nesta entrega, ver §8).

**Entrada in-process nunca passa por isto**: recebe `{ organizationId, credencialIdentidade: CREDENCIAL_IDENTIDADE_INTERNA }` diretamente do chamador confiável do monólito — nenhuma autenticação HTTP é simulada ou ignorada; simplesmente não existe nesse caminho.

---

## 5. Limites de transação

- **Camada A** (identidade do evento): uma consulta `INSERT ... ON CONFLICT DO NOTHING` autônoma (própria transação implícita do driver), seguida — depois da camada B — de um `UPDATE ... WHERE concluido_em IS NULL` igualmente autônomo e idempotente. Nunca compartilha transação com a camada B.
- **Camada B** (`registrarProcessoDemurrage`): exatamente a transação já congelada do D10 — `BEGIN`; lock consultivo de registro, depois de fechamento; processo + contêineres + observações + vínculo de tracking; `COMMIT` único. Qualquer erro reverte TUDO (processo, contêineres, observações, vínculos) — nenhuma escrita parcial.
- **Pós-commit** (recálculo/fotografia, outbox D10 v1.1): fora de qualquer transação longa, já com a garantia idempotente existente. Uma falha aqui (`PosCommitIncompletoError`) não é tratada como falha de negócio do handoff — o registro principal já está commitado; o handoff marca `ACEITO_COM_PENDENCIA` e confia no reparo idempotente já existente (mesma chamada, ou o próximo tick do scheduler).
- **Reconciliação de SI** (melhor esforço, pós-commit): chamada depois do `COMMIT` da camada B, nunca dentro da mesma transação. Uma falha aqui é só logada (sanitizada) — nunca desfaz o registro já confirmado.

---

## 6. Comportamento de falha e recuperação

`PosCommitIncompletoError` (recálculo/fotografia pendente): o registro principal já está commitado; o handoff marca a linha da camada A como `ACEITO_COM_PENDENCIA` e devolve uma pendência `pos_commit_em_reparo` — a MESMA chamada (ou o tick do scheduler) repara de forma idempotente, sem perder nenhum fato de negócio.

Qualquer outro erro inesperado na aplicação (ex.: `responsavelOperacionalMembershipId` referenciando um membership que não existe — violação de FK do Postgres) marca a linha da camada A como `FALHA`, com `falha_sanitizada` registrando só a classificação do erro (nome + código, nunca segredo/assinatura/corpo/conteúdo de documento). **Importante:** uma linha `FALHA` não é terminal — um retry do **mesmo** evento com o **mesmo** payload (depois que o pré-requisito externo for corrigido, ex.: o membership passa a existir) é permitido a tentar de novo pela camada B, que agora terá sucesso. Isto é diferente de reenviar um payload **diferente** sob o mesmo `origemEventoId` (que é sempre `CONFLITO_EVENTO`) — a recuperação correta é repetir a entrega exata depois de corrigir o estado, nunca mudar o conteúdo do evento já identificado. Comprovado no cenário 21 (§8).

---

## 7. Comportamento do backlog de Shipping Instructions

Depois de uma aplicação bem-sucedida (`APLICADO`, `ACEITO_COM_PENDENCIA` ou `REPLAY_IDEMPOTENTE` com sucesso), o handoff chama `reaplicarIntencoesShippingInstructions({ pool, organizationId })` — o MESMO mecanismo já existente e já chamado periodicamente pelo tick do scheduler de produção. Nenhuma pipeline de extração nova: nenhuma releitura do Outlook, nenhuma reextração de documento. A função reaplica `si_intencoes` já persistidas contra o estado atual do banco (processos/contêineres que agora existem), sem nunca criar um contêiner a partir de uma quantidade mencionada na SI — só associa fatos a contêineres que já existem, pela mesma lógica (`escopo: 'mbl' | 'container'`) já testada em D10 v1.1.

É melhor esforço: uma falha na reconciliação é só logada (sanitizada) — nunca desfaz o registro principal já comitado pela camada B. A recuperação é o próprio tick periódico do scheduler, que já chama esta mesma função.

---

## 8. Evidência de teste

### 8.1 Suíte nova — `handoffProducaoP1.test.ts` (24 cenários obrigatórios)

**23/23 testes — 100% verde** (o cenário 24, regressão completa D10–D16, é a suíte inteira do engine, não reimplementada aqui):

| # | Cenário | Resultado |
|---|---|---|
| 1 | Criação de processo pelo contrato oficial | ok |
| 2 | Replay exato → no-op idempotente (fingerprint inalterado) | ok |
| 3 | Mesmo evento, payload diferente → `CONFLITO_EVENTO`, zero escrita (fingerprint) | ok |
| 4 | Segundo evento atualiza processo OPEN sem duplicar | ok |
| 5 | Entregas concorrentes idênticas aplicam uma vez | ok |
| 6 | Entregas concorrentes conflitantes — desfecho determinístico, sem duplicar | ok |
| 7 | Isolamento entre organizações | ok |
| 8 | `organizationId` nunca aceito (corpo/query/cabeçalho) | ok |
| 9 | Assinatura HMAC válida aceita (round-trip HTTP completo) | ok |
| 10 | Assinatura inválida rejeitada (401 genérico) | ok |
| 11 | Timestamp fora da tolerância rejeitado | ok |
| 12 | Nonce reutilizado rejeitado | ok |
| 13 | Credencial desabilitada rejeitada | ok |
| 14 | Rotação de credencial — segredo antigo falha imediatamente, novo funciona | ok |
| 15 | Nenhum segredo/assinatura/corpo aparece em log | ok |
| 16 | Dados ausentes → `ACEITO_COM_PENDENCIA`, nada inventado | ok |
| 17 | Campos operacionais/decisórios e `manual_fallback` rejeitados | ok |
| 18 | Processo FINAL → `EXIGE_REABERTURA`, projeção nunca mutada | ok |
| 19 | Backlog de SI reaplicado sem reler Outlook/reextrair | ok |
| 20 | SI sem associação segura não fabrica contêiner | ok |
| 21 | Falha recuperável — retry do mesmo evento após corrigir o pré-requisito | ok |
| 22 | Migração limpa 0001→0040 | ok |
| 23 | Migração a partir de 0039 com dados existentes — 0040 aditiva | ok |

Fingerprints de banco (cenários 2, 3 e 10) provam, por contagem de linhas em `processos`/`containers`/`field_observations`/`demurrage_registros`/`demurrage_handoff_eventos`, que um replay idempotente e uma falha de autenticação não produzem **nenhuma** escrita de negócio.

### 8.2 Achado corretivo durante a validação

A primeira versão da migration 0040 nomeou os triggers de imutabilidade de organização como `demurrage_handoff_credenciais_org_imutavel`/`demurrage_handoff_eventos_org_imutavel`, em vez do nome convencional `organization_id_immutable` usado por **toda** outra tabela de tenant do repositório. O teste de guarda de convenção (`migration0007.test.ts`, "toda tabela com organization_id tem o trigger de imutabilidade") capturou isso corretamente. Corrigido na própria migration 0040 (ainda não commitada) e a lista de tabelas esperadas em `migration0007.test.ts` foi atualizada — seguindo o mesmo padrão de manutenção já estabelecido nas fases anteriores (D15/D16) para testes que enumeram migrations/tabelas.

Da mesma forma, `schedulerClaimFencing.test.ts` (teste #12b) tinha uma asserção exata de "migrations aplicadas a partir de 0038" que precisou ser atualizada para incluir `0040_handoff_demurrage.sql` — o mesmo padrão mecânico já documentado nas entregas anteriores (migrate.test.ts, registroDemurrageV12.test.ts, responsabilidadeAuditoria.test.ts, responsabilidadeV12.test.ts, responsavelOperacional.test.ts foram atualizados preventivamente antes de qualquer execução).

### 8.3 Regressão completa

- **Suíte completa do Demurrage Engine** (`npm run test:demurrage-engine`, D10–D16 v1.1 + handoff novo): **1000/1000 passam**, 0 falhas.
- **V1** (`npm test`, `src/auditoria/preAlerta`): 25/25 passam.
- **D13 UI** (`npm run test:demurrage-ui`, navegador real/Playwright): 64/66 passam, 2 skip (condicionais de ambiente, não falhas) — confirma que **nenhum** comportamento do frontend D13 regrediu.
- **`tsc --noEmit`**: limpo.
- **`npm run build`**: limpo.

---

## 9. Limitações conhecidas

1. **Sem janela de sobreposição na rotação de credencial.** `rotacionarCredencial()` substitui o segredo atomicamente e imediatamente — o segredo anterior para de validar no mesmo instante. Um integrador que rotacione sem coordenar a troca do lado de quem chama verá falhas de autenticação até atualizar o segredo usado. Modelo aceito para esta entrega; uma janela de sobreposição (dois segredos válidos por um período) ficaria para uma entrega futura, se necessário.
2. **Nonces nunca são expurgados.** `demurrage_handoff_nonces` só cresce. Nunca é incorreto manter um nonce antigo (a proteção contra replay nunca falha por isso), mas o expurgo operacional (ex.: nonces mais antigos que a janela de tolerância de qualquer timestamp possível) é tarefa futura, fora do escopo desta entrega.
3. **Evento marcado `EXIGE_REABERTURA` nunca é retentado automaticamente.** Uma vez que um `origemEventoId` resulta em `EXIGE_REABERTURA` (processo FINAL), redeliveries do MESMO evento continuam retornando `EXIGE_REABERTURA` para sempre — mesmo que o processo seja reaberto depois por fora. Isso é intencional (o evento, como identidade imutável, representa a tentativa que encontrou o processo FINAL) mas significa que o sistema a montante precisa emitir um **novo** `origemEventoId` para representar a tentativa pós-reabertura — não há endpoint nem mecanismo nesta entrega para "reprocessar" um evento já concluído como `EXIGE_REABERTURA`.
4. **`ACEITO_COM_PENDENCIA` por falha pós-commit tem resposta reduzida.** Quando `PosCommitIncompletoError` ocorre, a resposta não inclui a lista completa de contêineres/pendências do registro (só um placeholder `pos_commit_em_reparo`) — o chamador sabe que foi aceito mas precisa reconsultar o processo (rota de leitura D12, inalterada) para o estado completo.
5. **Verificação de credencial não é hardened contra canal de tempo na camada de banco.** A comparação de assinatura em si é de tempo constante, mas a consulta de existência da credencial (antes da comparação) tem tempo diferente para "credencial existe" vs. "não existe" — um risco de baixa severidade, consistente com o padrão já aceito em `autorizarInterno`/`requireAuth` no restante da base (nenhum destes foi desenhado contra canal de tempo em nível de banco).
6. **Sem rate limiting.** Confirmado no diagnóstico (§5.8): nenhuma rota do repositório tem rate limiting hoje. A rota de handoff segue o mesmo padrão — recomendação já registrada no diagnóstico, não resolvida nesta entrega. **[Atualização posterior]** controle de capacidade por credencial e por organização acrescentado como adição estreita autorizada — ver `docs/demurrage-producao-p1-handoff-capacidade.md` (aguardando revisão).
7. **Expurgo de `demurrage_handoff_eventos` não implementado.** Assim como o ledger `demurrage_registros` (D10), esta tabela é append-only por desenho e não tem expurgo — decisão consistente com o resto do motor, não uma lacuna nova desta entrega.

---

## 10. Nenhuma mudança de frontend

Esta entrega não altera **nenhum** arquivo HTML, CSS, JavaScript de apresentação, sidebar, Portal do Cliente ou qualquer peça do D13. Confirmado por `git status` do branch: os únicos arquivos tocados são a migration 0040, o módulo novo `src/demurrage-engine/handoff/`, a rota nova `src/routes/demurrageHandoffRoutes.ts`, o wiring mínimo em `src/index.ts` (import + `app.use` de um router próprio, montado antes do `express.json()` global pelo motivo documentado no próprio arquivo), e arquivos de teste (a suíte nova + 6 arquivos de teste existentes com a correção mecânica da lista de migrations/tabelas esperadas, já exigida pelo padrão estabelecido nas entregas anteriores). A suíte D13 UI (navegador real) confirma zero regressão visual/comportamental.

---

## Encerramento

Esta é a Entrega 1 de Produção P1. Não inclui as rotas de ação operacional (Entrega 2) nem as lacunas de leitura para o frontend redesenhado (Entrega 3) — ambas fora do escopo desta instrução. **Produção P1 não está completa.** Parando aqui para auditoria.
