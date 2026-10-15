# Produção P1 — Entrega 2 v1.2 (corretiva final de integridade)

> **ATUALIZAÇÃO — decisão final do usuário:** a corretiva descrita abaixo foi
> **APROVADA**. **A Entrega 2, como um todo, está APROVADA E CONGELADA.** Ver
> `docs/demurrage-producao-p1-diagnostico.md` §6 para o status consolidado
> da Produção P1.

**Base:** branch `claude/practical-cerf-mnz7oj`, Entrega 2 v1.1 commit `86ad7fa`
(aprovada, suíte completa 1090/1090). Migrations 0001–0043 **não foram
tocadas**. Nenhum arquivo de frontend foi alterado. A Entrega 3 **não foi
iniciada**.

Esta corretiva fecha três fronteiras de integridade que a auditoria da v1.1
deixou abertas — cada uma amarrada a um achado específico, nenhuma delas uma
regra de negócio nova.

---

## Achado #1 — invariante de tenant no banco (idempotência de minuta × organização do contêiner)

### O problema

A migration 0043 guarda a identidade de idempotência da minuta
(`idempotencia_organizacao_id`/`idempotencia_rota`/`idempotencia_chave`/
`idempotencia_hash`) nas mesmas colunas da linha de `minutas`, amarrada ao
`container_id` dessa mesma linha. Isso resolve o dual-write entre a escrita
de negócio e a reivindicação da chave (achado #2 da v1.1) — mas **nada no
banco** provava que a organização dentro da identidade de idempotência era a
MESMA organização real do contêiner-alvo. A rota HTTP confere isso
(`organizacaoDoContainer`, em `demurrageAcoesRoutes.ts`) antes de chamar
`registrarMinutaIdempotente` — mas essa função é exportada de
`acoes/minutaIdempotencia.ts`, e qualquer chamador direto (outro serviço, um
job futuro, outra rota, um script, um teste) podia gravar
`idempotencia_organizacao_id = A` numa minuta cujo `container_id` pertence à
organização B, e o banco aceitava.

### A correção (migration 0044)

```sql
ALTER TABLE minutas
  ADD CONSTRAINT minutas_idempotencia_organizacao_do_container
  FOREIGN KEY (container_id, idempotencia_organizacao_id)
  REFERENCES containers (id, organization_id);
```

Mesma técnica já estabelecida no próprio módulo (`demurrage_pendencias_container_org_fk`,
`container_equip_container_org_fk`, `cvc_container_org_fk`, todas em
0020/0028) — uma FK **composta**. A âncora já existia: `containers_id_org_unique
UNIQUE (id, organization_id)`, criada na migration 0020. **Nenhuma unique key
nova foi necessária** — exatamente como a instrução pedia ("reusar uma
`(id, organization_id)` já existente em `containers`, se houver").

### Semântica MATCH SIMPLE (por que linhas legadas continuam válidas)

O PostgreSQL só avalia uma FK composta quando **nenhuma** coluna
referenciadora é NULL (`MATCH SIMPLE`, o padrão). Uma minuta sem
idempotência (`idempotencia_organizacao_id IS NULL` — todo chamador
pré-existente: D15-A, D16, testes, upload direto) satisfaz a FK
trivialmente, sem nunca precisar casar com `containers.id`/`organization_id`.
Isso preserva intactas:

- todas as linhas gravadas antes desta migration (idempotentes ou não);
- todo caminho de código que nunca usa idempotência de minuta.

Só a minoria de linhas que de fato carrega uma identidade completa de
idempotência (o que a CHECK `minutas_idempotencia_coerente` da 0043 já
obriga a ser "tudo ou nada") fica sujeita à nova FK — exatamente o universo
onde o achado se aplica.

### Prova

| Prova exigida | Teste |
|---|---|
| organização correta é aceita (rota e adaptador direto) | `v1.2 #1` |
| SQL direto cross-org é rejeitado pelo banco | `v1.2 #2` |
| chamada direta ao adaptador cross-org é rejeitada | `v1.2 #3` |
| linhas legadas (NULL) e idempotentes pré-0044 sobrevivem intactas | `v1.2 #4` |
| banco novo 0001→0044 cria a FK (e a CHECK, achado #3) | `v1.2 #5` |
| upgrade 0043→0044 aplica sobre dados existentes e já vale para escritas novas | `v1.2 #6` |

A garantia é do banco, não da rota: `v1.2 #3` prova isso chamando
`registrarMinutaIdempotente` **sem** o `organizacaoDoContainer` da rota na
frente — o INSERT ainda é recusado.

---

## Achado #2 — guarda definitiva de "minuta já processada" dentro de `ClosingService.validarMinuta`

### O problema

A v1.1 serializava a sequência "ler o estado atual → decidir se chama o
serviço" na ROTA (`comLockPorChave`, por `minutaId`), porque o próprio
`ClosingService.validarMinuta` — mesmo depois do lock consultivo
(`lockProcesso`) e da releitura travada da minuta (passo 4b) — não tinha
nenhum guard contra reprocessar uma minuta já `VALIDADA`/`REJEITADA`. Isso
protegia duas requisições concorrentes pela MESMA rota, mas não protegia:
uma chamada direta de outro código em processo, um job futuro, outra rota,
ou um teste que chamasse o serviço diretamente.

### A correção

O guard definitivo agora vive **dentro do serviço**, logo depois do passo 2
(`lockProcesso`) e do passo 4b (releitura travada da minuta/contêiner) — e
**antes** de qualquer outro gate (inclusive antes da resolução do ator/RBAC,
que não é mais relevante para uma decisão já tomada):

```ts
// closingService.ts, dentro de validarMinuta(), logo após construir `m`:
if (m.estado === 'VALIDADA') {
  await client.query('ROLLBACK');
  return { ok: true, resultado: 'ja_validada', dataValidada: mRow.data_validada, divergente: mRow.divergente_do_tracking };
}
if (m.estado === 'REJEITADA') {
  await client.query('ROLLBACK');
  return { ok: true, resultado: 'ja_rejeitada', motivo: mRow.motivo_rejeicao };
}
if (m.estado !== 'RECEBIDA') {
  await client.query('ROLLBACK');
  return { ok: false, motivo: 'minuta_estado_nao_suportado' };
}
```

### Máquina de estados final de `validarMinuta`

```
RECEBIDA  --[coerência inválida]--------------------------------> REJEITADA  (evento MINUTA_REJEITADA, 1x)
RECEBIDA  --[coerência válida, FINAL e diverge]-------------------> (sem transição; FATO_MATERIAL_POS_FINAL, exige_reabertura)
RECEBIDA  --[coerência válida, divergente, sem aceitarDivergencia]-> (sem transição; divergencia_pendente)
RECEBIDA  --[coerência válida, aceita ou sem divergência]---------> VALIDADA   (evento MINUTA_VALIDADA + RECALCULO, 1x)
VALIDADA  --[qualquer nova chamada]-------------------------------> ja_validada  (idempotente — SEM evento, SEM recálculo, SEM escrita)
REJEITADA --[qualquer nova chamada]-------------------------------> ja_rejeitada (idempotente — SEM evento, SEM escrita)
(estado fora de RECEBIDA/VALIDADA/REJEITADA) ----------------------> falha típada minuta_estado_nao_suportado (inalcançável — CHECK da 0016 já fecha o domínio; defesa em profundidade)
```

A união de retorno de `validarMinuta` ganhou exatamente dois novos membros
(`ja_validada`, `ja_rejeitada`) e a falha típada `minuta_estado_nao_suportado`
— nenhum membro existente mudou de forma. Todo chamador conhecido
(`demurrageAcoesRoutes.ts` e os arquivos de teste que chamam o serviço
diretamente) foi auditado; nenhum precisou de alteração de lógica além do
único ponto onde o contrato observável mudou de propósito (abaixo).

### A rota ficou mais simples, não mais complexa

A pré-leitura (`minutaRepo.findById` + checagem de estado) que a v1.1 fazia
NA ROTA, antes de chamar o serviço, foi removida — é redundante agora que o
serviço é autoguardião. `comLockPorChave` continua envolvendo a chamada ao
serviço, mas só como serialização de REQUISIÇÃO (reduz contenção/trabalho
duplicado); a corretude não depende mais dele — `v1.2 #7`/`#8`/`#9` provam
isso chamando o serviço diretamente, SEM esse lock de rota.

### Prova de concorrência direta no serviço

| Prova exigida | Teste | Resultado observado |
|---|---|---|
| duas chamadas concorrentes → uma validação efetiva | `v1.2 #7` | uma `'validada'`, uma `'ja_validada'`, mesmo `dataValidada`/`divergente` |
| repetição direta após VALIDADA → no-op estrito | `v1.2 #8` | `ja_validada` mesmo com `aceitarDivergencia: true` — a guarda vem ANTES de qualquer gate |
| repetição direta após REJEITADA → no-op estrito | `v1.2 #9` | `ja_rejeitada`, mesmo `motivo` |
| exatamente um evento `MINUTA_VALIDADA`/`MINUTA_REJEITADA` | `v1.2 #7`/`#9` | `count = 1` em `closing_events` |
| nenhuma recálculo/evidência duplicada | `v1.2 #7`/`#8` | `count('RECALCULO') = 1` |
| rota permanece compatível (duas requisições HTTP concorrentes) | `v1.2 #12` | ambas 200; uma `'validada'`, uma `'ja_validada'`; 1 evento |

O mecanismo que torna isso determinístico sem exigir nenhum lock de
aplicação adicional: `lockProcesso` já usa `pg_advisory_xact_lock`
(escopo de transação — liberado só no COMMIT/ROLLBACK). A segunda chamada
concorrente bloqueia nesse lock até a primeira COMITAR, então relê a minuta
(já `VALIDADA`) sob o passo 4b e cai direto na guarda — nunca reprocessa.

**Nota de autorização:** esta é uma correção explicitamente autorizada sobre
código congelado (D15-A) — a auditoria da v1.1 comprovou um defeito real de
concorrência (o serviço, chamado diretamente, duplicava efeitos). A correção
é estritamente aditiva ao comportamento observável: toda chamada que antes
produzia `'validada'`/`'rejeitada'`/`'divergencia_pendente'`/`Falha` continua
produzindo exatamente isso na PRIMEIRA chamada; só uma SEGUNDA chamada sobre
uma minuta já decidida muda de "reprocessa" para "réplica idempotente
típada".

---

## Achado #3 — contrato de transporte do `Idempotency-Key`

### O problema

A rota de registro de minuta só exigia "não vazio" e persistia o valor bruto
direto num índice único B-tree (`minutas_idempotencia_unica`, 0043). Um
cabeçalho grande o bastante excede o limite físico de entrada de um índice
B-tree do PostgreSQL — produziria um erro INTERNO (500), nunca uma resposta
de contrato fechada.

### A correção — `acoes/idempotencyKey.ts`

```ts
export function normalizarIdempotencyKey(bruta: string): string {
  const semBordas = bruta.trim();
  if (semBordas.length < 1 || semBordas.length > 200) throw new IdempotencyKeyInvalida();
  if (!/^[A-Za-z0-9\-_.:+=/]+$/.test(semBordas)) throw new IdempotencyKeyInvalida();
  return semBordas;
}
```

Regras, documentadas no próprio arquivo:

- **trim** nas bordas antes de qualquer outra checagem;
- **comprimento** (depois do trim): 1 a 200 caracteres;
- **conjunto de caracteres** — deliberadamente mais estrito que "ASCII
  imprimível" genérico: letras ASCII, dígitos, e os separadores `- _ . : + = /`
  — cobre UUID/ULID, timestamps ISO-8601, chaves compostas com separador e
  Base64 URL-safe, sem abrir espaço interno, aspas, barra invertida, ou
  controle algum;
- **nunca trunca silenciosamente** — fora do limite ou com caractere
  inválido é 400 `idempotency_key_invalida`, nunca um corte silencioso que
  mudaria a identidade sem avisar;
- a chave **normalizada** (nunca a bruta) é a única usada depois — para
  lookup, para o hash de identidade do pedido (`calcularHashRegistroMinuta`,
  via `idempotenciaChave` já normalizada) e para o valor efetivamente
  persistido.

A rota (`demurrageAcoesRoutes.ts`) passou a normalizar o cabeçalho ANTES de
chamar `registrarMinutaIdempotente`; um cabeçalho ausente continua
`idempotency_key_obrigatoria` (código já existente da v1.1); qualquer
cabeçalho presente mas inválido (vazio, só espaço, grande demais, caractere
fora do conjunto) é `idempotency_key_invalida`.

### Defesa em profundidade no banco (migration 0044)

```sql
ALTER TABLE minutas ADD CONSTRAINT minutas_idempotencia_chave_tamanho CHECK (
  idempotencia_chave IS NULL OR char_length(idempotencia_chave) <= 200
);
```

Preserva linhas legadas (`NULL`) e recusa, independente de qual caminho de
código escreveu, qualquer linha cuja chave exceda o limite — prova de que a
garantia não depende só da validação de aplicação (`v1.2 #18`).

### Nota sobre transporte HTTP e espaço em branco

Um detalhe de implementação que o teste `v1.2 #14` deixa explícito: o parser
HTTP (RFC 7230, OWS) já remove espaço em branco nas BORDAS de um cabeçalho em
trânsito — um valor "só espaço" chega ao Express como `''` (idêntico a
ausente), nunca como espaço preservado. Por isso a validação de CONTEÚDO
"só espaço → inválido" é provada diretamente na função pura
(`normalizarIdempotencyKey('   ')` lança `IdempotencyKeyInvalida`), e a rota
é testada com o valor `''` que o transporte realmente entrega — ambos
resultam em 400, nunca em uma chave aceita.

Nenhuma outra rota/helper desta família usa `demurrage_acoes_idempotencia`
(0042) para novas escritas — a tabela permanece intacta, só para uso futuro;
nenhuma linha histórica foi reescrita.

### Prova

| Prova exigida | Teste |
|---|---|
| chave vazia rejeitada | `v1.2 #13` |
| chave só com espaço rejeitada (função pura + rota) | `v1.2 #14` |
| chave acima do limite (201 caracteres) rejeitada, nada persistido | `v1.2 #15` |
| chave com caractere fora do conjunto permitido rejeitada | `v1.2 #16` |
| chaves equivalentes (espaço nas bordas) tratadas como a mesma identidade | `v1.2 #17` |
| banco recusa, por si só, uma chave persistida acima do limite | `v1.2 #18` |

---

## Migrations

Uma única migration aditiva nesta corretiva:

- **`0044_acoes_minuta_idempotencia_tenant_e_chave.sql`** — FK composta
  `minutas_idempotencia_organizacao_do_container` (achado #1) + CHECK
  `minutas_idempotencia_chave_tamanho` (achado #3). 0001–0043 não foram
  reescritas.

---

## Totais de teste — validação sequencial completa

Executada na ordem pedida, com PostgreSQL real
(`priora_demurrage_test`), `--test-concurrency=1` (suítes que compartilham o
mesmo banco de teste não podem rodar em paralelo entre arquivos — isso é
isolamento de infraestrutura, não uma regra de negócio):

| Etapa | Resultado |
|---|---|
| 1. Novos testes v1.2 (`demurrageAcoesEntrega2V12.test.ts`) | **17/17** |
| 2. v1.1 + Entrega 2 original (`demurrageAcoesEntrega2V11.test.ts` + `demurrageAcoesEntrega2.test.ts`) | **50/50** |
| 3. Entrega 1 handoff (`handoffVinculoTransacaoV12.test.ts`) + AST scanner (`acoesSemLogicaDeNegocio.test.ts`) + arquivos de lista de migrations (`migrate.test.ts`, `responsavelOperacional.test.ts`, `responsabilidadeV12.test.ts`, `responsabilidadeAuditoria.test.ts`, `registroDemurrageV12.test.ts`, `schedulerClaimFencing.test.ts`) | **81/81** |
| 4. Suítes focadas de fechamento/minuta (`closing.test.ts`, `closingD15A.test.ts`, `closingD15AV11.test.ts`) | **51/51** |
| 5. Chamadores adicionais de `validarMinuta` (`d16Vertical.test.ts`, `demurrageVertical.test.ts`, `gestaoEficiencia.test.ts`, `apuracaoV13.test.ts`) | **44/44** |
| 6. Suíte COMPLETA do Demurrage Engine (`npm run test:demurrage-engine`) | **1107/1107** — 0 falhas, 0 cancelamentos, 0 skips |
| 7. V1 (`npm run test`, auditoria pré-alerta) | **25/25** |
| 8. D13 UI (`npm run test:demurrage-ui`) | **66/66** |
| 9. `tsc --noEmit` | limpo, zero erros |
| 10. `npm run build` | limpo |

A etapa 6 (suíte completa) já contém integralmente as etapas 1–5 (mesmos
arquivos, mesma suíte `src/demurrage-engine/__tests__/*.test.ts`) — são
reportadas separadamente aqui porque a instrução pediu a ordem sequencial
explícita; o número que importa para "zero falhas/skips/cancelamentos" é o
da etapa 6.

Durante a validação, o cluster PostgreSQL local precisou ser reiniciado uma
vez antes do início (estava `down` por reinício de processo de worker,
infraestrutura da sessão — não um sintoma de código) e uma colisão
transitória de concorrência entre dois processos de teste INDEPENDENTES
(suíte completa em background + D13 UI simultâneos, ambos disputando
`seedArmadorTables` no mesmo banco) produziu 2 falhas de `deadlock detected`
na primeira tentativa de D13 UI — re-executada isoladamente, depois do fim
da suíte completa, resultou em 66/66 limpos. Nenhuma das duas situações é um
defeito de código desta corretiva.

---

## Prova de que nenhum arquivo de frontend foi alterado

Coberto estruturalmente por `v1.2 #21` (mesma disciplina de `v1.1 #24`):
varre `git status --porcelain` e falha se qualquer caminho sob `public/`,
`.html` ou `.css` estiver entre as mudanças não commitadas. `git status
--porcelain` nesta sessão, ao final da implementação, lista exclusivamente:

```
 M src/demurrage-engine/__tests__/demurrageAcoesEntrega2.test.ts
 M src/demurrage-engine/__tests__/demurrageAcoesEntrega2V11.test.ts
 M src/demurrage-engine/__tests__/migrate.test.ts
 M src/demurrage-engine/__tests__/registroDemurrageV12.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeAuditoria.test.ts
 M src/demurrage-engine/__tests__/responsabilidadeV12.test.ts
 M src/demurrage-engine/__tests__/responsavelOperacional.test.ts
 M src/demurrage-engine/__tests__/schedulerClaimFencing.test.ts
 M src/demurrage-engine/closing/closingService.ts
 M src/routes/demurrageAcoesRoutes.ts
?? src/demurrage-engine/__tests__/demurrageAcoesEntrega2V12.test.ts
?? src/demurrage-engine/acoes/idempotencyKey.ts
?? src/demurrage-engine/db/migrations/0044_acoes_minuta_idempotencia_tenant_e_chave.sql
```

Todos os caminhos são backend (migrations, serviço de fechamento, rota,
módulo de ações, testes). Nenhum arquivo em `public/`, `.html` ou `.css`.

---

## Status

- Migrations 0001–0043: intocadas.
- Entrega 2 v1.1: regressão completa aprovada (50/50 nesta corretiva, mais
  os 1107/1107 da suíte completa que a contém).
- Entrega 2 v1.2: três achados corrigidos, prova de banco e de concorrência
  direta no serviço, contrato de transporte do `Idempotency-Key` fechado.
- Entrega 3: **não iniciada**.
- Frontend: **nenhum arquivo alterado**.

**Decisão final do usuário (pós-entrega):** corretiva v1.2 aprovada; Entrega 2
como um todo **APROVADA E CONGELADA**. Não alterar mais a superfície
congelada da Entrega 2, salvo bug comprovado, falha de segurança/integridade,
ou mudança explicitamente aprovada. A Entrega 3 permanece não iniciada,
aguardando autorização explícita do usuário para começar.
