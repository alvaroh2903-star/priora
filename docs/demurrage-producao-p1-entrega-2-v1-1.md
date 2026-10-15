# Produção P1 — Entrega 2 v1.1: corretiva (regressão vermelha + idempotência atômica de minuta + verificação de tipo persistido)

**Baseline:** branch `claude/practical-cerf-mnz7oj`, Entrega 2 original no commit `c16d6f6`, Entrega 1 congelada em `c8d49b2`. Esta corretiva acrescenta a migration 0043 (aditiva) e três arquivos novos em `src/demurrage-engine/acoes/`, sem alterar nenhuma migration 0001–0042 e **nenhum arquivo de frontend**.

A Entrega 2 original foi recusada pela auditoria por três motivos: (1) a regressão completa estava vermelha; (2) a idempotência do registro de minuta tinha uma janela real de dual-write e nenhuma amarração ao contêiner/conteúdo do pedido; (3) a rota de pendência verificava o tipo pedido contra um catálogo, mas nunca contra o tipo REALMENTE persistido na linha. Esta corretiva resolve os três, mais uma auditoria de concorrência das outras 6 ações.

---

## 1. Achado #1 — regressão vermelha

`handoffVinculoTransacaoV12.test.ts` (suíte própria da corretiva v1.2 da Entrega 1) tinha uma asserção escrita para provar que **aquela corretiva específica** não introduziu nenhuma migration nova:

```ts
assert.ok(!r.applied.some((nome) => nome.startsWith('0042')), '...');
```

Essa asserção, por construção, proíbe QUALQUER migration futura de QUALQUER entrega posterior — a Entrega 2 introduziu a 0042 (legitimamente, autorizada pelo usuário), e esta corretiva introduz a 0043. A correção é mecânica: o teste agora prova exatamente o invariante histórico pedido —

1. delimitando a aplicação em `0041_handoff_vinculo_processo.sql` (`runMigrations(pool, { until: '0041...' })`) e confirmando que a lista aplicada termina EXATAMENTE ali (a corretiva v1.2 não introduziu nada em 0001..0041);
2. confirmando que uma segunda passada SEM limite aplica só arquivos ESTRITAMENTE posteriores a 0041 (migrations de entregas futuras são esperadas e permitidas);
3. confirmando que a cadeia atual completa aplica e reaplica (idempotente) sem erro.

Nenhuma linha de comportamento da Entrega 1 foi tocada — só a asserção do teste, mecanicamente, para parar de proibir o que o próprio usuário autorizou.

Seis outros arquivos de teste de infraestrutura (não exclusivos de nenhuma entrega — Fases 1, D10, D11, D16) hardcodeiam a lista completa de migrations para provar instalação limpa/idempotência: `migrate.test.ts`, `migration0007.test.ts`, `registroDemurrageV12.test.ts`, `responsabilidadeAuditoria.test.ts`, `responsabilidadeV12.test.ts`, `responsavelOperacional.test.ts`, `schedulerClaimFencing.test.ts`. Todos foram atualizados para incluir `0043_acoes_minuta_idempotencia_atomica.sql` — a mesma manutenção de rotina já documentada na Entrega 2 original §9.1, sem alterar nenhuma asserção de comportamento.

---

## 2. Achado #2 — idempotência atômica do registro de minuta

### 2.1 Causa raiz do dual-write

O desenho anterior (`acoes/idempotencia.ts`'s `comIdempotencia()`, sobre a tabela genérica `demurrage_acoes_idempotencia`, migration 0042) separava DUAS transações:

1. a escrita de NEGÓCIO (`INSERT` em `minutas`, dentro de `ClosingService.registrarMinuta`, pelo pool compartilhado);
2. a escrita da IDENTIDADE de idempotência (`INSERT` na tabela genérica, por uma conexão dedicada, só DEPOIS de o serviço já ter retornado).

Entre o `COMMIT` de uma e o `COMMIT` da outra havia uma janela real: um crash do processo, ou uma falha pontual nesse segundo `INSERT`, deixava a minuta persistida SEM nenhuma chave de idempotência associada — um retry com a MESMA chave não encontrava nada e criava uma SEGUNDA minuta. Além disso, a chave `(organization_id, rota, chave)` sozinha não amarrava a NENHUM contêiner nem ao conteúdo do pedido: a mesma chave reaproveitada com outro contêiner, outro número informado, outra data ou outra evidência devolvia o resultado antigo sem nenhuma verificação.

### 2.2 Modelo atômico final

A identidade de idempotência passa a viver nas MESMAS colunas da própria linha de negócio que ela protege. Migration 0043 (aditiva) acrescenta quatro colunas NULÁVEIS a `minutas`:

```sql
ALTER TABLE minutas
  ADD COLUMN idempotencia_organizacao_id UUID REFERENCES organizations(id),
  ADD COLUMN idempotencia_rota TEXT,
  ADD COLUMN idempotencia_chave TEXT,
  ADD COLUMN idempotencia_hash TEXT;
```

`container_id` já existe na própria linha de `minutas` — a amarração ao contêiner-alvo é automática, pela própria linha, sem precisar repeti-la em nenhuma tabela auxiliar.

Um índice único PARCIAL garante a unicidade só para quem usa idempotência:

```sql
CREATE UNIQUE INDEX minutas_idempotencia_unica
  ON minutas (idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave)
  WHERE idempotencia_chave IS NOT NULL;
```

`acoes/minutaIdempotencia.ts`'s `registrarMinutaIdempotente()` executa:

```sql
INSERT INTO minutas (container_id, estado_minuta, numero_informado, data_informada, evidencia_ref, recebida_por,
                      idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave, idempotencia_hash)
VALUES (..., 'RECEBIDA', ...)
ON CONFLICT (idempotencia_organizacao_id, idempotencia_rota, idempotencia_chave) WHERE idempotencia_chave IS NOT NULL
DO NOTHING
RETURNING *;
```

**Este é o ponto central da correção: um ÚNICO statement SQL faz a escrita de negócio E a reivindicação da identidade de idempotência.** Não há duas transações, portanto não há NENHUMA janela entre elas — isto é uma prova ESTRUTURAL (a janela não existe, por construção), não uma prova estatística de que um teste de corrida não a alcançou.

Fluxo completo (dentro de UMA transação, `BEGIN`/`COMMIT`):
1. verifica se existe uma chave LEGADA na tabela genérica 0042 para esta `(organização, rota, chave)` — se existir, rejeita explicitamente (§2.4), sem tocar `minutas`;
2. executa o `INSERT ... ON CONFLICT ... DO NOTHING RETURNING *`;
3. se **1 linha retornada** (nova minuta): registra o evento `MINUTA_RECEBIDA` em `closing_events` (mesma transação) e comita — `{ok:true, novo:true}`;
4. se **0 linhas retornadas** (conflito): relê a linha existente pela MESMA chave (dentro da mesma transação) e compara `idempotencia_hash` com o hash do pedido atual:
   - hash igual → comita (leitura pura, nenhuma escrita nova) e devolve a minuta original, `{ok:true, novo:false}`;
   - hash diferente → comita (nada foi escrito) e devolve `{ok:false, motivo:'idempotency_key_reutilizada'}`.

A concorrência é resolvida pelo próprio índice único do Postgres: duas transações concorrentes com a MESMA chave disputam o mesmo slot do índice — a segunda bloqueia até a primeira comitar/abortar, e só então decide (conflito ou repetição). Não foi necessário nenhum lock consultivo de aplicação para este caminho — a atomicidade vem do próprio `INSERT ... ON CONFLICT`, não de uma coordenação adicional.

### 2.3 Hash canônico do pedido

`calcularHashRegistroMinuta()` usa `hashEstavel()` (SHA-256 sobre JSON com chaves ordenadas, já exportado e usado em todo o D10 — `registro/contrato.ts`) sobre:

| Campo | Entra no hash? | Normalização |
|---|---|---|
| `versao` (marcador fixo `acoes.registrar_minuta.v1`) | Sim | — (permite invalidar hashes antigos se o contrato mudar de forma) |
| `organizationId` | Sim | — |
| `containerId` | Sim | — |
| `numeroInformado` | Sim | maiúsculas, sem espaços/hifens — mesma regra de equivalência que `closing/minutaValidation.ts` já usa para comparar números (reimplementada aqui, não importada, para não acoplar este adaptador a um símbolo interno do serviço congelado) |
| `dataInformada` | Sim | já é uma data civil canônica (`AAAA-MM-DD`) — sem normalização adicional |
| `evidenciaRef` | Sim | só `trim()` (espaço de transporte); o valor em si é sensível a caixa (pode ser URL/ID) |
| **ator (`recebidaPor`)** | **Não** | — ver justificativa abaixo |

**Por que o ator NÃO entra no hash:** o autor real da sessão sempre grava `minutas.recebida_por` fresco, a cada ESCRITA (nunca aceito do corpo da requisição). Mas duas chamadas com o MESMO conteúdo de negócio, vindas de atores internos DIFERENTES (ex.: um colega reexecuta a mesma automação com a mesma `Idempotency-Key` depois de uma resposta perdida pela rede), ainda são a MESMA operação lógica. Incluir o ator no hash faria esse retry legítimo colidir como se fosse um pedido diferente. A auditoria de "quem criou" permanece preservada em `minutas.recebida_por`, que nunca é reescrita por um replay (um replay nunca grava de novo — é leitura pura).

### 2.4 Compatibilidade com a tabela legada 0042

A tabela genérica `demurrage_acoes_idempotencia` (migration 0042) **permanece intacta e no lugar** — continua disponível para qualquer ação futura desta mesma família que não precise amarrar a identidade a uma linha de negócio específica. O registro de minuta simplesmente deixa de ser cliente dela.

Uma chave `(organização, rota='registrar_minuta', chave)` gravada ali por uma chamada ANTERIOR a esta corretiva não tem hash de pedido nem amarração a contêiner — não há como provar identidade de forma segura. `registrarMinutaIdempotente()` verifica essa condição ANTES de qualquer escrita e, se encontrar uma chave legada correspondente, rejeita explicitamente com o código fechado `idempotency_key_legado_sem_hash` — **nunca** "adivinha" o contêiner ou o conteúdo do pedido original a partir da linha antiga. O chamador precisa usar uma chave NOVA.

### 2.5 Semântica garantida (e testada — §5)

| Cenário | Resultado |
|---|---|
| Mesma organização/rota/chave/alvo/hash | Devolve a minuta original, zero escrita nova |
| Mesma chave, contêiner diferente | `idempotency_key_reutilizada`, zero escrita |
| Mesma chave, `numeroInformado` diferente | `idempotency_key_reutilizada`, zero escrita |
| Mesma chave, `dataInformada` diferente | `idempotency_key_reutilizada`, zero escrita |
| Mesma chave, `evidenciaRef` diferente | `idempotency_key_reutilizada`, zero escrita |
| Mesma chave, organização diferente | Independente — cada organização cria a sua própria minuta |
| Concorrência idêntica | Exatamente uma minuta |
| Concorrência conflitante | Um vencedor determinístico, um conflito |
| Falha antes do commit | Nenhuma minuta, nenhuma chave bem-sucedida persiste |
| Falha depois do commit (retry) | Devolve a minuta original |
| Chave legada (0042, sem hash) | Rejeitada explicitamente, zero escrita, zero "adivinhação" |

---

## 3. Achado #3 — verificação do tipo PERSISTIDO da pendência

### 3.1 A lacuna

A rota de resolução de pendência validava que `familia`/`acao`/`tipo` PEDIDOS NO CORPO pertenciam ao catálogo suportado (`validarComandoPendencia`), mas nunca comparava contra o tipo REALMENTE persistido na linha de `demurrage_pendencias`. `resolverPendenciaManual` resolve pelo `id`, sem olhar `tipo` — um chamador podia pedir um tipo suportado qualquer (ex.: `armador_ausente`) enquanto o `pendenciaId` apontava para uma linha persistida de OUTRO tipo (ex.: `mbl_ausente`), e a resolução acontecia do mesmo jeito.

### 3.2 Correção

`acoes/pendenciaVerificacao.ts` adiciona uma leitura organization-scoped (`buscarPendenciaPersistida`) que traz `organizationId`/`tipo`/`estado` da linha, e `verificarTipoPendenciaPersistido()` exige, nesta ordem:

1. **o tipo PERSISTIDO** pertence ao catálogo suportado (defesa em profundidade: mesmo que uma migration futura amplie o `CHECK` de `demurrage_pendencias.tipo` antes deste catálogo acompanhar, uma linha do tipo novo nunca é resolvível por aqui);
2. **o tipo PEDIDO no corpo é EXATAMENTE igual ao tipo PERSISTIDO**.

Divergência devolve 409 (`tipo_divergente_do_persistido` ou `tipo_persistido_nao_suportado`) ANTES de qualquer chamada a `resolverPendenciaManual` — zero escrita no caminho de rejeição. O campo `tipo` no corpo foi mantido (não removido) porque a Entrega 2 original já testava explicitamente a rejeição de um tipo não suportado no corpo (`validarComandoPendencia`) — manter o campo e VERIFICÁ-LO contra o persistido preserva esse contrato sem quebrar nenhum teste existente, satisfazendo a orientação da auditoria ("se o campo do corpo permanecer, ele precisa ser verificado").

VesselCall, tracking e tarifa nunca entram: `buscarPendenciaPersistida` só lê `demurrage_pendencias` — um `pendenciaId` de outra tabela/família é simplesmente não encontrado, e a rota já trata isso como 404 (idêntico a inexistente) — provado pelo teste #16 (§5), inserindo uma pendência real em `vessel_call_pendencias` e confirmando que ela nunca é resolvível "disfarçada" de um tipo demurrage suportado.

A função antiga `organizacaoDaPendencia` (que só lia `organization_id`) foi removida de `acoes/organizacaoRecurso.ts` — ficou redundante, já que `buscarPendenciaPersistida` traz a mesma informação de organização junto com `tipo`/`estado` na mesma leitura.

---

## 4. Auditoria de concorrência das outras 6 ações

| Ação | Mecanismo natural reivindicado | Resultado da auditoria |
|---|---|---|
| Fallback manual | Dedup na camada de `field_observations`/hash do contrato D10 | **Confirmado seguro** — teste de replay concorrente idêntico (§5, item 19): exatamente uma justificativa, nenhuma duplicação |
| Decisão de responsabilidade | Versionamento otimista (D11) | **Confirmado seguro** — teste de retry concorrente idêntico (§5, item 20): um vencedor (versão 1), um conflito (`VERSAO_DESATUALIZADA`), exatamente uma decisão persistida |
| **Validação de minuta** | Pré-leitura na rota (`estado !== 'RECEBIDA'`) | **Falha real encontrada e corrigida** — ver §4.1 |
| Finalização | `ja_final` (D15-A) | **Confirmado seguro** — teste de retry concorrente (§5, item 22): exatamente um fechamento |
| Reabertura (solicitação) | Índice único parcial + `reabertura_ja_aberta` (D15-A) | **Confirmado seguro** — já provado na Entrega 2 original (#22/#27), reconfirmado no fluxo ponta a ponta (§5, item 23) |
| Reabertura (autorização) | `reabertura_ja_autorizada` (D15-A) | **Confirmado seguro** — mesma reconfirmação (§5, item 23) |
| Resolução de pendência | No-op silencioso `{resolvida:false}` quando já resolvida (D15-B) | **Confirmado seguro** — a verificação de tipo (achado #3) é só uma leitura adicional antes da escrita; a escrita em si continua inteiramente gatilhada pelo `FOR UPDATE` + checagem de `estado` já existente no serviço congelado |

### 4.1 Falha real: validação de minuta — corrigida dentro do escopo desta v1.1

A rota de validação de minuta fazia uma PRÉ-LEITURA (`MinutaRepository.findById` → `estado !== 'RECEBIDA'`?) ANTES de decidir chamar `ClosingService.validarMinuta`. Essa pré-leitura existia precisamente porque o serviço congelado NÃO tem nenhum guard interno contra processar a MESMA minuta duas vezes (achado já confirmado na Entrega 2 original). O problema: duas chamadas CONCORRENTES para a MESMA minuta podiam ambas passar pela pré-leitura (ambas veem `RECEBIDA`, antes de qualquer uma comitar) e ambas chamar o serviço — a SEGUNDA, mesmo serializada pelo lock consultivo INTERNO do serviço, não tinha nenhum motivo para abortar, e duplicaria `closing_events`/recálculo.

**Correção:** `acoes/serializacaoPorChave.ts`'s `comLockPorChave()` — a MESMA técnica já comprovada em `comIdempotencia()` (conexão DEDICADA `pg.Client`, nunca `pool.connect()`, elimina por construção a classe de risco de saturação do pool já documentada e corrigida na v1.3 da Entrega 1) — serializa a sequência INTEIRA "ler o estado atual → decidir se chama o serviço" por `minutaId`, com um `pg_advisory_lock` de sessão. A rota agora executa a pré-leitura e a chamada condicional ao serviço DENTRO desse lock: só uma chamada por vez executa a sequência; a segunda, depois de esperar a primeira soltar o lock, relê o estado JÁ ATUALIZADO (`VALIDADA`/`REJEITADA`) e corretamente toma o caminho idempotente, sem chamar o serviço de novo. O serviço congelado `ClosingService.validarMinuta` não foi alterado.

---

## 5. Testes obrigatórios

Novo arquivo `demurrageAcoesEntrega2V11.test.ts` — **24 testes físicos** (PostgreSQL real), cobrindo os 26 cenários obrigatórios (os itens 1 e 2 — asserção histórica corrigida e suíte completa verde — são provados por `handoffVinculoTransacaoV12.test.ts` §1 e pela validação sequencial completa §6, não duplicados aqui):

| # | Cenário |
|---|---|
| 3 | retry idêntico devolve a minuta original, zero escrita |
| 4 | mesma chave, contêiner diferente → conflito, zero escrita |
| 5 | mesma chave, número diferente → conflito, zero escrita |
| 6 | mesma chave, data diferente → conflito, zero escrita |
| 7 | mesma chave, evidência diferente → conflito, zero escrita |
| 8 | concorrência idêntica → exatamente uma minuta |
| 9 | concorrência conflitante → um vencedor, um conflito |
| 10 | falha injetada antes do commit → nenhuma minuta, nenhuma chave bem-sucedida; retry seguinte aplica do zero |
| 11 | retry depois do commit (crash simulado) → devolve a minuta original |
| 12 | sem janela de dual-write — identidade imutável após criada (trigger rejeita `UPDATE`) |
| 13 | chave legada (0042, sem hash) → rejeitada explicitamente, zero escrita |
| 14 | mesma chave, organizações diferentes → independente |
| 15 | tipo pedido divergente do persistido → 409, zero escrita |
| 16 | pendência de família não suportada (VesselCall) → nunca resolvível disfarçada |
| 17 | fingerprint de zero escrita na rejeição por divergência de tipo |
| 18 | pendência de outra organização → indistinguível de inexistente |
| 19 | fallback manual — replay concorrente idêntico não duplica |
| 20 | responsabilidade — retry concorrente não cria versão não intencional |
| 21 | validação de minuta — concorrência não duplica evento |
| 22 | finalização — concorrência permanece idempotente |
| 23 | reabertura — concorrência ponta a ponta permanece idempotente |
| 24 | nenhum arquivo de frontend alterado |
| 25 | migração limpa 0001→0043 |
| 26 | upgrade 0042→0043 preserva linhas legadas intactas |

**Resultado: 24/24 passando.**

---

## 6. Validação sequencial completa

Executada nesta ordem, sem suítes pesadas de PostgreSQL sobrepostas:

| Etapa | Resultado |
|---|---|
| `demurrageAcoesEntrega2V11.test.ts` (novo) | 24/24 |
| `demurrageAcoesEntrega2.test.ts` (Entrega 2 original) | 29/29 |
| `acoesSemLogicaDeNegocio.test.ts` (estático) | 3/3 |
| Suítes de handoff da Entrega 1 (`handoffProducaoP1`, `handoffProducaoP1V11`, `handoffVinculoTransacaoV12`, `handoffVinculoConcorrenciaV13`) | 60/60 |
| Suítes focadas D10–D16 (`closingD15A*`, `d15b*`, `d15c*`, `d16Vertical`, `registroDemurrage*`, `responsabilidade*`) | 63/63 |
| **`npm run test:demurrage-engine` (suíte completa — 79 arquivos)** | **1090/1090 — 0 falhas, 0 pulados, 0 cancelados** |
| `npm test` (V1) | 25/25 |
| `npm run test:demurrage-ui` (D13, proteção de UI) | 64/66 (2 pulados — gated por banco, fora da suíte do motor, conforme explicitamente permitido) |
| `npx tsc --noEmit` | limpo, zero erro |
| `npm run build` | sucesso |

**Nenhum teste falhou em nenhuma etapa. A suíte completa do motor está com ZERO falhas, ZERO pulados e ZERO cancelados**, como exigido.

---

## 7. Migrations

Uma única migration aditiva: `0043_acoes_minuta_idempotencia_atomica.sql` — acrescenta as quatro colunas de identidade de idempotência a `minutas` (nulas por padrão, sem afetar nenhum chamador existente), o índice único parcial, e o gatilho de imutabilidade da identidade. A migration 0042 (`demurrage_acoes_idempotencia`) permanece intacta e sem alteração — nenhuma linha dela é tocada ou reinterpretada por esta migration. As migrations 0001–0042 não foram tocadas. Instalação limpa (0001→0043) e upgrade a partir de 0042 com linhas legadas pré-existentes confirmados (testes #25/#26, §5).

---

## 8. Prova de nenhuma mudança de frontend

```
$ git status --porcelain
 M src/demurrage-engine/__tests__/handoffVinculoTransacaoV12.test.ts
 M src/demurrage-engine/__tests__/migrate.test.ts
 M src/demurrage-engine/__tests__/registroDemurrageV12.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeAuditoria.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeV12.test.ts
 M src/demurrage-engine/__tests__/responsavelOperacional.test.ts
 M src/demurrage-engine/__tests__/schedulerClaimFencing.test.ts
 M src/demurrage-engine/acoes/organizacaoRecurso.ts
 M src/routes/demurrageAcoesRoutes.ts
?? src/demurrage-engine/__tests__/demurrageAcoesEntrega2V11.test.ts
?? src/demurrage-engine/acoes/minutaIdempotencia.ts
?? src/demurrage-engine/acoes/pendenciaVerificacao.ts
?? src/demurrage-engine/acoes/serializacaoPorChave.ts
?? src/demurrage-engine/db/migrations/0043_acoes_minuta_idempotencia_atomica.sql
```

Nenhum caminho sob `public/`, nenhum `.html`, nenhum `.css`, nenhum JavaScript de apresentação, Sidebar, Portal ou D13. O teste #24 (§5) prova isso automaticamente a cada execução da suíte.

---

## 9. Status

**Entrega 2 v1.1 implementada e validada.** Os três achados bloqueantes da auditoria foram corrigidos (regressão vermelha, dual-write de idempotência da minuta, verificação de tipo persistido da pendência), mais uma falha real de concorrência na validação de minuta, encontrada e corrigida dentro do escopo desta corretiva. A suíte completa do motor está 100% verde. Produção P1 **não** está completa — a Entrega 3 permanece não iniciada. Esta corretiva aguarda nova auditoria da Entrega 2 antes de qualquer trabalho adicional.
