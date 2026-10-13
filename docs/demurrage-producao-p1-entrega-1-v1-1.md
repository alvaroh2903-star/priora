# Produção P1 — Entrega 1, corretiva v1.1

**Baseline:** branch `claude/practical-cerf-mnz7oj`, Entrega 1 `3bb37eb`. Esta corretiva **não edita a migration 0040** — acrescenta a migration 0041 (aditiva) e corrige três defeitos bloqueantes encontrados na auditoria da Entrega 1, sem redesenhar nada do que já estava aprovado (HMAC, nonce, tolerância de timestamp, cifra de credencial, derivação de organização pela credencial, adaptador HTTP fino, chamada oficial ao D10, reconciliação de backlog de SI, exigência de reabertura em processo FINAL, campos operacionais proibidos, proibição de `manual_fallback`). Nenhum arquivo de frontend foi tocado.

---

## 1. Causa raiz de cada achado

### Achado #1 — `origemProcessoId` não vinculava o processo interno

**Causa raiz:** o contrato descrevia `origemProcessoId` como a identidade estável do processo a montante, mas nada persistia esse vínculo. `demurrage_handoff_eventos` indexava `origem_processo_id` só para rastreabilidade (`demurrage_handoff_eventos_processo_origem_idx`, não uma `UNIQUE`), e o serviço resolvia o processo interno **a cada chamada** por `numeroProcesso` — um dado mutável da própria requisição, não uma identidade gravada. Dois eventos com a mesma `(organização, origemSistema, origemProcessoId)` mas `numeroProcesso` diferentes criavam ou atualizavam processos internos **diferentes**, sem nenhuma detecção.

**Correção:** migration 0041 cria `demurrage_handoff_processo_links` — um vínculo autoritativo e **totalmente imutável** `(organization_id, origem_sistema, origem_processo_id) -> processo_id`, com `UNIQUE` e FK composta isolada por organização. `resolverVinculoProcesso()` (`handoffService.ts`) resolve e afirma esse vínculo **antes** de chamar o D10 — nunca depois, nunca em paralelo. Ver §2 e §3.

### Achado #2 — divergência de identidade do evento passava como replay

**Causa raiz:** `payloadHash` exclui deliberadamente `origemProcessoId` (ele é metadado de rastreabilidade, não um fato de negócio) — mas o caminho de replay comparava **só** o hash. Um `origemEventoId` já registrado, reenviado com um `origemProcessoId` diferente e o mesmo payload de negócio, passava como replay idempotente.

**Correção:** `processarEventoHandoff()` agora compara explicitamente `linha.origemProcessoId !== norm.origemProcessoId` **antes** de qualquer decisão de replay/aplicação — divergência aqui é `CONFLITO_EVENTO` imediato, sem chamar o D10, sem reconciliar SI, sem tocar a linha existente. A proteção de banco já existia desde a migration 0040 (`forbid_handoff_evento_identidade_change` já cobria `origem_processo_id`) — o que faltava era a aplicação usar essa comparação. Ver §3 e a evidência do cenário v1.1 #10.

**Tratamento de `origemOcorridoEm` (exigido explicitamente pela instrução):** é metadado de **transporte** (versão/ordem da entrega da fonte), **não** parte da identidade imutável do evento — uma retransmissão do mesmo evento com um `origemOcorridoEm` ligeiramente diferente nunca é tratada como conflito. Nunca é silenciosamente substituído: o `INSERT ... ON CONFLICT DO NOTHING` da camada A já preserva o valor da **primeira** entrega para sempre — uma redelivery nunca sobrescreve essa coluna, exatamente porque a linha já existe e o `INSERT` conflitante não executa. Esta decisão está documentada em código (`handoffService.ts`, `registrarOuRecuperarEvento`) e comprovada pelo comportamento idêntico nos cenários de replay.

### Achado #3 — erros podiam expor dado recebido ou segredo

**Causa raiz:** `sanitizarFalha()` tinha um branch `if (erro instanceof Error) return \`${erro.name}:${erro.message}\`` — para um erro genérico do driver `pg` (ex.: violação de FK), a mensagem do Postgres inclui o **valor** que violou a restrição; a reconciliação de SI logava essa mesma string; e a rota HTTP logava **o objeto de erro inteiro** (`console.error(..., erro)`), que pode incluir `.stack`.

**Correção:** `handoff/erros.ts` — mapeamento FECHADO (`CodigoFalhaHandoff`, 11 valores) que nunca lê `.message`, `.stack`, `.detalhe` ou qualquer valor recebido; só a identidade de tipo do erro (`instanceof`) e o SQLSTATE do driver `pg` (5 caracteres fixos, documentado pelo próprio Postgres, nunca embute um valor). `falha_sanitizada` (persistido), o log de reconciliação de SI e o log da rota agora usam **só** esse código. Ver §5 e a evidência dos cenários v1.1 #13/#14/#15.

---

## 2. Modelo final de identidade a montante

Duas identidades distintas, cada uma com sua própria garantia:

| Identidade | Tabela | Chave | Garantia |
|---|---|---|---|
| Evento a montante (imutável) | `demurrage_handoff_eventos` | `(organization_id, origem_sistema, origem_evento_id)`, com `origem_processo_id` e `payload_hash` como parte da identidade comparada | Mesmo evento + mesma identidade completa = replay estrito; qualquer divergência (em `origem_processo_id` OU no hash do payload) = `CONFLITO_EVENTO`, zero escrita |
| Processo a montante (estável) | `demurrage_handoff_processo_links` | `(organization_id, origem_sistema, origem_processo_id)` → `processo_id` | O PRIMEIRO evento aplicado com sucesso estabelece o vínculo; todo evento seguinte resolve o processo por este vínculo — nunca por `numeroProcesso` lido de novo, nunca por MBL/HBL/contêiner/cliente |

`numeroProcesso` continua sendo a identidade do processo **dentro** do D10 (congelada, inalterada) — o vínculo da v1.1 só garante que o **mesmo** `origemProcessoId` sempre resolve para o **mesmo** `processo_id`, e que uma tentativa de o associar a um `numeroProcesso` diferente é um conflito explícito, nunca uma migração silenciosa de identidade.

---

## 3. Comportamento de concorrência

`resolverVinculoProcesso()` serializa toda a decisão sob um lock consultivo de **transação** (`pg_advisory_xact_lock`), namespaced por `demurrage:handoff:vinculo:<org>:<sistema>:<origemProcessoId>` — um namespace próprio, que nenhum outro código do sistema usa (mesma convenção dos locks do D10, `demurrage:processo:...`/`demurrage:container:...`, em namespaces diferentes — sem risco de deadlock entre os dois).

- **Vínculo já existe, `numeroProcesso` confere:** devolve o `processo_id` vinculado; o D10 é chamado depois, fora do lock, normalmente.
- **Vínculo já existe, `numeroProcesso` diverge:** `CONFLITO_EVENTO` — o D10 **nunca** é chamado. Zero escrita de negócio, mesmo sob concorrência (cenário v1.1 #3/#4).
- **Vínculo não existe (primeira entrega desta identidade):** chama o D10 **dentro** da janela do lock (conexão separada do pool — namespaces de lock diferentes) e grava o vínculo com o `processo_id` resultante antes de liberar.

Isso faz duas entregas **concorrentes** para a mesma identidade a montante convergirem de verdade: a segunda só prossegue depois que a primeira já comitou (ou abortou) o vínculo — nunca duas "primeiras entregas" correndo em paralelo para o mesmo `origemProcessoId`. Comprovado nos cenários v1.1 #5 (convergência) e #6 (conflito concorrente com exatamente um vencedor e **nenhum processo extra criado** — o perdedor nunca chega a chamar o D10, porque ele só vê o vínculo já estabelecido depois de esperar o lock).

`PosCommitIncompletoError` ainda estabelece o vínculo (o registro principal já comitou — só o reparo pós-commit está pendente) antes de relançar; qualquer outro erro (`PROCESSO_FINAL`, violação de FK, etc.) nunca estabelece vínculo alguma.

---

## 4. Restrições de banco (defesa em profundidade, não só validação de aplicação)

| Restrição | Mecanismo | Tabela |
|---|---|---|
| Identidade do evento imutável (`origem_sistema`, `origem_processo_id`, `origem_evento_id`, `payload_hash`) | Trigger `forbid_handoff_evento_identidade_change` (já existia desde a migration 0040 — já cobria `origem_processo_id`) | `demurrage_handoff_eventos` |
| Vínculo processo↔origemProcessoId totalmente imutável (nem o próprio `processo_id` pode mudar) | Trigger `demurrage_handoff_processo_links_append_only` (`forbid_mutation`, migration 0041) | `demurrage_handoff_processo_links` |
| Isolamento organizacional do vínculo | FK composta `(processo_id, organization_id) → processos(id, organization_id)` + `organization_id_immutable` | `demurrage_handoff_processo_links` |

Comprovado no cenário v1.1 #10: uma tentativa de `UPDATE`/`DELETE` direto em `demurrage_handoff_processo_links` é rejeitada pelo trigger, e uma tentativa de `UPDATE` em `origem_processo_id` de um evento já existente é rejeitada pelo trigger de 0040 — ambas por SQL puro, sem passar por nenhuma função TypeScript.

---

## 5. Política de erro sanitizado

`handoff/erros.ts` — `classificarFalhaHandoff(erro)`, a **única** função autorizada a decidir o que vira `falha_sanitizada` (persistido) ou aparece em log para qualquer falha do handoff:

- `ErroContratoDemurrage` → mapeado por uma tabela FECHADA e EXAUSTIVA (o TypeScript obriga cobrir todo `CodigoErroContrato` do D10) para um dos 7 códigos `CONTRATO_D10_*` — nunca repassa `erro.codigo` nem `erro.detalhe` (que carrega os valores recebidos) diretamente.
- `PosCommitIncompletoError` → `POS_COMMIT_PENDENTE`.
- Qualquer erro com `.code` de 5 caracteres (SQLSTATE do `pg`) → `BANCO_DADOS_RESTRICAO_INTEGRIDADE` (classe `23`, violação de integridade) ou `BANCO_DADOS_ERRO` (qualquer outra classe).
- Qualquer outra coisa → `FALHA_INESPERADA`.

Nunca lê `.message`, `.stack`, corpo da requisição, assinatura ou segredo. A rota HTTP (`demurrageHandoffRoutes.ts`) e a reconciliação de SI (`handoffService.ts`) foram corrigidas para usar **só** esta classificação — nunca o objeto de erro bruto.

**Evidência executável** (cenários v1.1 #13a/#13b/#14/#15): um erro sintético contendo um marcador de segredo nunca aparece na string devolvida pelo classificador; uma falha real (FK inválida com um UUID de membership inexistente) nunca persiste esse UUID nem o segredo de uma credencial real (provisionada, mas não usada nesta chamada) em `falha_sanitizada` nem em log; um erro verdadeiramente inesperado capturado só pela rota (simulado por uma falha de banco injetada exatamente no ponto fora do `try/catch` do serviço) devolve só `{resultado:'FALHA', detalhe:{motivo: <código fechado>}}` — o corpo da resposta HTTP e os logs nunca contêm o marcador do erro original nem o segredo da credencial.

---

## 6. Auditoria e prova do replay

**Antes desta correção:** um replay de um evento já concluído com sucesso chamava `registrarProcessoDemurrage` de novo para "reconstruir" a resposta. A auditoria confirmou que isso **não é garantidamente livre de escrita**: o reparo pós-commit do outbox (D10 v1.1) roda incondicional a cada chamada bem-sucedida e pode gravar em `demurrage_pos_commit_outbox`/`snapshots`/`valores_apurados` se ainda houver reparo pendente para aquele processo — mesmo que o PRÓPRIO evento do handoff já esteja concluído como `ACEITO_COM_PENDENCIA` (que é exatamente o estado "ainda há reparo pendente").

**Correção:** migration 0041 acrescenta `demurrage_handoff_eventos.resposta_aplicada` (JSONB). No momento da conclusão bem-sucedida (primeira aplicação ou reaplicação depois de um crash), o retrato completo da resposta de negócio é persistido. Um replay de um evento já concluído agora é uma **leitura pura** desse retrato — o D10 nunca é chamado de novo.

**Prova executável** (cenário "auditoria de replay"): depois de uma aplicação bem-sucedida, o teste reintroduz artificialmente um estado "ainda pendente" no outbox pós-commit daquele processo (`UPDATE demurrage_pos_commit_outbox SET estado = 'pendente'`), replaya o MESMO evento, e confirma que o outbox continua **exatamente** `pendente` depois do replay — se o código ainda chamasse o D10 de novo (comportamento da Entrega 1), o reparo pós-commit teria rodado e mudado o `estado` para `concluido`. O rótulo do próprio replay é sempre `REPLAY_IDEMPOTENTE` (nunca o rótulo da aplicação original), mas os demais campos do retrato (processo, contêineres, pendências) preservam o estado real da aplicação.

**Conclusão da auditoria:** o caminho antigo (rechamar o D10) foi **removido**, não só documentado como arriscado — nenhum replay de um evento concluído com sucesso toca mais nenhuma tabela de negócio, outbox ou auditoria além da própria leitura.

---

## 7. Migrations

`0041_handoff_vinculo_processo.sql` (aditiva; 0001–0040 intocadas, inclusive a 0040):
1. `CREATE TABLE demurrage_handoff_processo_links` — vínculo imutável `(organization_id, origem_sistema, origem_processo_id) → processo_id`, `UNIQUE`, FK composta isolada por organização, triggers `forbid_mutation` (linha inteira, nunca `UPDATE`/`DELETE`) e `organization_id_immutable` (convenção padrão do repositório).
2. `ALTER TABLE demurrage_handoff_eventos ADD COLUMN resposta_aplicada JSONB` — retrato persistido para replay sem escrita (achado da auditoria, §6).

Caminho limpo (`0001→0041`) e caminho de upgrade (`0040→0041` com eventos pré-existentes, sem retrato e sem vínculo) comprovados nos cenários v1.1 #17 e #18 — a migração nunca inventa um vínculo retroativo nem um retrato que não existia; um evento pré-0041 continua replayable (cai para a reaplicação normal, que o D10 reconhece pela `chaveIdempotencia` já existente) e, nessa primeira passagem pelo código novo, o vínculo é estabelecido retroativamente de forma correta.

---

## 8. Evidência de teste

### 8.1 Suíte nova — `handoffProducaoP1V11.test.ts` (20 cenários obrigatórios + auditoria de replay)

**19/19 testes — 100% verde** (o item 16 é reconfirmado por um smoke test HTTP nesta suíte E pela suíte original reexecutada inteira; o item 20 é a regressão completa, não reimplementada aqui):

| # | Cenário | Resultado |
|---|---|---|
| 1 | Primeiro evento estabelece o vínculo | ok |
| 2 | Evento posterior (mesmo origemProcessoId) atualiza o MESMO processo pelo vínculo | ok |
| 3/4 | Numeroprocesso diferente conflita, zero escrita de negócio | ok |
| 5 | Primeiras entregas concorrentes convergem num único vínculo/processo | ok |
| 6 | Primeiras entregas concorrentes conflitantes: um vencedor determinístico, zero escrita extra | ok |
| 7 | Isolamento organizacional de identificadores idênticos | ok |
| 8 | Mesmo origemEventoId com origemProcessoId diferente conflita; linha original nunca atualizada | ok |
| 9 | Replay estrito (identidade completa): zero escrita, zero chamada ao D10 | ok |
| 10 | Identidade imutável protegida por restrição de banco (evento E vínculo) | ok |
| 11 | Evento para FINAL (vínculo já estabelecido) permanece retido, exige reabertura | ok |
| 12 | Reconciliação de SI não é chamada em nenhum dos dois tipos de conflito | ok |
| 13a | (Unitário) classificador nunca devolve conteúdo de erro com segredo injetado | ok |
| 13b/14 | Falha real (FK) nunca persiste nem loga segredo/UUID recebido | ok |
| 15 | Erro inesperado na rota devolve só a resposta genérica | ok |
| 16 | Round-trip HTTP com HMAC válido (smoke test pós-reescrita) | ok |
| 17 | Migração limpa 0001→0041 | ok |
| 18 | Upgrade 0040→0041 com evento pré-existente | ok |
| — | Auditoria de replay: outbox pós-commit nunca tocado num replay | ok |
| 19 | Nenhum arquivo de frontend entre as mudanças | ok |

### 8.2 Suíte original da Entrega 1 (`handoffProducaoP1.test.ts`) — reexecutada sem alteração de comportamento

**23/23 testes — 100% verde**, incluindo os cenários de HMAC/nonce/timestamp/rotação de credencial (item 16 da lista desta corretiva). Duas correções mecânicas, nenhuma de comportamento: (a) o rótulo de um replay bem-sucedido tinha regredido para o rótulo da aplicação original (ex.: `ACEITO_COM_PENDENCIA`) em vez de `REPLAY_IDEMPOTENTE` — corrigido para sempre rotular o PRÓPRIO replay como `REPLAY_IDEMPOTENTE`, preservando os demais campos do retrato; (b) as asserções de "última migration aplicada" foram atualizadas para 0041, seguindo o mesmo padrão mecânico já estabelecido nas entregas anteriores.

### 8.3 Regressão completa

- **Suíte completa do Demurrage Engine** (`npm run test:demurrage-engine`): **1019/1019 testes — 100% verde, 0 falhas** (execução completa contra PostgreSQL real, schema recriado do zero antes da corrida; inclui as 19 suítes v1.1 desta corretiva, as 23 originais da Entrega 1 reexecutadas, e todas as entregas D1–D16 e v1.x anteriores sem nenhuma regressão).
- **V1** (`npm test`): 25/25 passam.
- **D13 UI** (`npm run test:demurrage-ui`, navegador real): 64/66 passam, 2 skip condicionais de ambiente (mesmo padrão da Entrega 1) — zero regressão de frontend.
- **`tsc --noEmit`**: limpo.
- **`npm run build`**: limpo.

---

## 9. Nenhuma mudança de frontend

Confirmado por `git status` do branch: os arquivos tocados por esta corretiva são a migration 0041, `handoff/erros.ts` (novo), `handoff/handoffService.ts` (reescrito), `routes/demurrageHandoffRoutes.ts` (log do catch-all corrigido), e arquivos de teste (a suíte nova `handoffProducaoP1V11.test.ts`, a suíte original com as 2 correções mecânicas de §8.2, e 6 arquivos de teste existentes com a correção mecânica da lista de migrations/tabelas esperadas para incluir 0041, já exigida pelo padrão estabelecido nas entregas anteriores). **A migration 0040 não foi editada.** Nenhum arquivo HTML, CSS, JavaScript de apresentação, sidebar, Portal ou peça do D13 foi tocado — confirmado também pelo cenário de teste v1.1 #19.

---

## Encerramento

Esta é a corretiva v1.1 da Entrega 1 de Produção P1. Não inclui as rotas de ação operacional (Entrega 2) nem as lacunas de leitura para o frontend redesenhado (Entrega 3) — ambas fora do escopo desta instrução. **Produção P1 não está completa.** Parando aqui para auditoria final da Entrega 1.
