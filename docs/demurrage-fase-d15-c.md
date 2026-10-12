# Fase D15-C — Integridade Tarifária e Recuperação de Filas

Baselines congeladas (nenhuma reaberta ou alterada nesta fase; nenhuma
regressão exigiu reabertura):

- D15-A produção: `91b3201`
- D15-A documentação: `43123fe`
- D15-B: `76c7031`
- D15-B v1.1: `5101f1f`

Escopo: os seis casos aprovados em `docs/demurrage-fase-d15-diagnostico.md`
— **R28** (overlap de faixas tarifárias), **R29** (moeda mista aborta toda a
transação de apuração), **R30** (tabela/faixa tarifária mutável após uso —
imutabilidade/versionamento/hash), **R57** (linhas presas em `PROCESSING` na
última tentativa), **R58** (outbox pós-commit sem teto de tentativas) e
**R59** (entrega de alerta de tracking sem claim/double-send). **Esta
entrega não é declarada aprovada nem congelada — fica para auditoria. D16
não foi iniciado.**

## 1. Mapeamento dos seis casos

| Caso | O que muda | Mecanismo | Arquivo principal | Teste de aceitação |
|---|---|---|---|---|
| **R28** | Faixas sobrepostas no mesmo (tabela, equipamento) — antes só checado em memória pelo motor, nunca pelo banco | `EXCLUDE USING GIST` sobre `tariff_brackets (tariff_table_id, tipo_equipamento, int4range(dia_inicial, dia_final+1))`, com `btree_gist` | migration `0037` | `d15c.test.ts` #11–#14 |
| **R29** | Moeda mista entre faixas do mesmo equipamento/tabela lançava `throw`, abortando a transação inteira (relógios, lifecycle e o cálculo do lado OPOSTO/de outros contêineres do mesmo processo) | `posicionarFaixas` devolve `{status:'UNAVAILABLE', motivo}` em vez de lançar — mesmo caminho já usado para "buraco na tabela" | `tariffs/bracketEngine.ts` | `d15c.test.ts` #16–#17 |
| **R30** | Versão ativada/usada podia ser editada por UPDATE/DELETE direto; faixas podiam ser inseridas/editadas/removidas depois do uso; unicidade de versão inefetiva para `rocket_cliente` (armador_id sempre NULL); hash do `ValorApurado` não cobria o conteúdo tarifário (só a identidade opaca tabela+versão) | Triggers de imutabilidade + `UNIQUE NULLS NOT DISTINCT` + `tariffTableService.ts` (camada de aplicação) + hash estendido em `domain/valorApurado.ts` | migration `0037`, `tariffs/tariffTableService.ts`, `domain/valorApurado.ts`, `apuracao/recalcularApuracao.ts` | `d15c.test.ts` #1–#10 |
| **R57** | Item reivindicado na ÚLTIMA tentativa permitida cujo worker morre antes de finalizar ficava preso em `PROCESSING`/`processando` para sempre (a recuperação exigia `tentativas < máximo`, já falso) | Recuperação de `PROCESSING` vencido desacoplada do teto de tentativas; `LEAST(tentativas+1, máximo)` nunca incrementa além do teto | `freeTime/recalculoOutbox.ts`, `registro/avisosFallbackManual.ts`, `freeTime/divergenciaAvisos.ts`, `registro/notificacaoPendencia.ts`, `registro/registrarProcessoDemurrage.ts` (pós-commit), `scheduler/alertOutbox.ts` (nova fila) | `d15c.test.ts` #18, #19, #21 |
| **R58** | `demurrage_pos_commit_outbox` não tinha teto de tentativas — uma linha permanentemente quebrada era reivindicada para sempre, sem nunca virar estado terminal visível | Teto de tentativas (parâmetro, default 5) + contadores `restantes`/`esgotados` auditáveis | `registro/registrarProcessoDemurrage.ts`, `demurrage/schedulerBootstrap.ts` | `d15c.test.ts` #19 |
| **R59** | `tracking_alert_deliveries` não tinha claim nenhum — dois workers concorrentes carregavam a MESMA lista de pendentes e enviavam a MESMA entrega duas vezes (double-send real) | Protocolo de claim/posse (`FOR UPDATE SKIP LOCKED` + `claim_token`/`worker_id`/`expira_em`), envio fora de transação, finalização condicionada ao token vigente — mesmo protocolo já aprovado nas outras filas | migration `0037`, `scheduler/alertOutbox.ts` (reescrito) | `d15c.test.ts` #20–#23 |

## 2. Migrations e arquivos alterados

### Migration (uma, aditiva — `0001`–`0036` não foram reescritas)

`src/demurrage-engine/db/migrations/0037_d15c_integridade_tarifaria_e_filas.sql`:

1. `tariff_tables.ativada_em` (`TIMESTAMPTZ`, **sem** `DEFAULT`) — ver §3 para
   a semântica exata e por que não tem valor padrão. Linhas pré-existentes
   recebem `ativada_em = criado_em` como backfill de COMPATIBILIDADE — um
   marcador de publicação legada INFERIDO (nenhuma data é inventada no
   sentido de "fabricada do nada"), não a observação direta de que a
   ativação ocorreu historicamente no momento da criação. **Correção D16
   v1.1:** evite descrever isto como "a ativação aconteceu na criação" —
   o fato real e verificável é só que a linha existe desde `criado_em`; o
   valor é reaproveitado como marcador de compatibilidade porque não há
   nenhum registro histórico de uma ativação explícita anterior a esta
   migration, não porque haja evidência de que a ativação em si ocorreu
   naquele instante. Todo o histórico anterior a esta fase é declarado
   congelado a partir de agora, de qualquer forma — a distinção importa só
   para quem lê esta coluna como prova de QUANDO algo foi ativado.
2. `tariff_tables_versao_unica`: estagiada — um bloco `DO $$ ... RAISE
   EXCEPTION $$` varre `tariff_tables` agrupando por
   `(organization_id, tipo, armador_id, termo_comercial, versao)`; se algum
   grupo já tem mais de uma linha sob a regra NOVA, a migration inteira
   aborta citando os IDs em conflito — nunca resolve sozinha qual versão é a
   verdadeira. Só então `DROP CONSTRAINT` + `ADD CONSTRAINT ... UNIQUE NULLS
   NOT DISTINCT (organization_id, tipo, armador_id, termo_comercial,
   versao)`.
3. `tariff_table_esta_congelada(uuid) RETURNS BOOLEAN` (função SQL, única
   fonte de verdade de "congelada") + triggers `tariff_tables_imutavel`
   (`BEFORE UPDATE OR DELETE`) e `tariff_brackets_imutavel` (`BEFORE INSERT
   OR UPDATE OR DELETE`), ambos reusando a mesma função.
4. `tariff_brackets_sem_sobreposicao`: estagiada — um bloco `DO $$` faz um
   self-join de `tariff_brackets` procurando overlap real já existente sob a
   regra nova (`int4range(dia_inicial, dia_final+1) && ...`); se encontrar,
   aborta citando os IDs das faixas em conflito. Só então `CREATE EXTENSION
   IF NOT EXISTS btree_gist` + `ADD CONSTRAINT ... EXCLUDE USING GIST
   (tariff_table_id WITH =, tipo_equipamento WITH =, int4range(dia_inicial,
   dia_final+1) WITH &&)`.
5. `tracking_alert_deliveries`: `status` ganha `'PROCESSING'`; novas colunas
   `claim_token`, `worker_id`, `expira_em`, `atualizado_em` + `CHECK
   ((status='PROCESSING') = (claim_token IS NOT NULL AND worker_id IS NOT
   NULL AND expira_em IS NOT NULL))` + índice parcial para o claim.

R29 e R57/R58 (fora da linha 5 de `tracking_alert_deliveries`, que é nova
estrutura) **não precisaram de migration** — `tentativas` já existia em
todas as filas afetadas; o teto é um parâmetro de chamada, nunca uma
constraint; e a correção de R29 é inteiramente de código de aplicação
(trocar `throw` por um retorno tipado já tratado genericamente pelos
chamadores).

### Arquivos novos (produção)

- `src/demurrage-engine/tariffs/tariffTableService.ts` — camada de
  APLICAÇÃO para criar rascunho, substituir faixas de um rascunho, ativar
  explicitamente e criar versão corretiva. Espelha as triggers de banco
  (checagem ANTES de tentar escrever, com erro tipado
  `TariffTableImutavelError`), mas nunca é a única linha de defesa — o
  banco segue barrando SQL direto, mesmo sem passar por este serviço.

### Arquivos modificados (produção)

- `src/demurrage-engine/domain/valorApurado.ts` — `calcularInputHashValor`
  ganha `vigenciaInicio`/`vigenciaFim`/`faixasTabela` opcionais; faixas
  canonicalizadas (ordenadas) antes de entrar no hash.
- `src/demurrage-engine/apuracao/recalcularApuracao.ts` — `persistir()`
  passa a resolver e filtrar as faixas efetivas (por equipamento) da tabela
  usada em cada lado (cliente/Rocket) e alimentá-las no hash; nenhuma lógica
  de seleção/posicionamento de faixa é duplicada (reaproveita
  `TabelaResolvida.faixas`, já resolvido pelo repositório).
- `src/demurrage-engine/tariffs/bracketEngine.ts` — moeda mista:
  `UNAVAILABLE` tipado em vez de `throw` (R29).
- `src/demurrage-engine/freeTime/recalculoOutbox.ts`,
  `src/demurrage-engine/registro/avisosFallbackManual.ts`,
  `src/demurrage-engine/freeTime/divergenciaAvisos.ts`,
  `src/demurrage-engine/registro/notificacaoPendencia.ts` — claim WHERE
  corrigido (R57): a recuperação de um `PROCESSING`/`processando` vencido
  deixa de exigir `tentativas < máximo`; incremento sempre via
  `LEAST(tentativas+1, máximo)`.
- `src/demurrage-engine/registro/registrarProcessoDemurrage.ts` —
  `repararPosCommitOutbox` ganha `maxTentativas` (default 5, R58) com o
  mesmo desacoplamento de R57; `processarPosCommitOutboxPendentes` passa a
  devolver `restantes`/`esgotados`.
- `src/demurrage-engine/scheduler/alertOutbox.ts` — reescrito por completo
  (R59): claim/posse real em vez de carregar tudo em memória sem proteção.
- `src/demurrage/schedulerBootstrap.ts` — `EtapaPosCommitResultado` ganha
  `esgotados`; `processarEntregasPendentes` chamado com `workerId`.

### Arquivos de teste — manutenção mecânica (golden lists), sem mudança de comportamento

`registroDemurrageV12.test.ts`, `migrate.test.ts`,
`responsabilidadeAuditoria.test.ts`, `responsabilidadeV12.test.ts`,
`responsavelOperacional.test.ts` tinham listas fixas do nome da última
migration aplicada — todas precisaram incluir
`0037_d15c_integridade_tarifaria_e_filas.sql`. `demurrageTickFilas.test.ts`
tinha uma asserção `Object.keys(...).sort()` sobre os campos de
`posCommit`, que precisou incluir `esgotados` (R58).

## 3. Ciclo de vida tarifário e imutabilidade (R30)

### "Ativada" vs. "usada" — as duas únicas formas de ficar imutável

Uma versão de `tariff_tables` fica **imutável** (nunca mais aceita
UPDATE/DELETE na linha, nem INSERT/UPDATE/DELETE em suas faixas) no
primeiro dos dois eventos que ocorrer:

- **ativada** — alguém chama `tariffTableService.ativar()` explicitamente,
  um travamento antecipado e opcional, útil para publicar uma versão
  revisada e impedir qualquer edição futura mesmo antes do primeiro uso; ou
- **usada** — um `ValorApurado` passa a referenciá-la (`valores_apurados.
  tabela_id`) — o caso comum e estruturalmente seguro: nenhum cálculo roda
  no meio da sequência "insere a tabela, insere as faixas" de um
  seed/correção, então nunca há uma janela em que o travamento por uso
  aconteça antes da última faixa ser gravada.

A checagem (`tariff_table_esta_congelada`) é **uma única função SQL**,
reusada pelos dois triggers de banco e pelo serviço de aplicação — nunca
duplicada.

### Por que `ativada_em` não tem `DEFAULT now()`

Testado empiricamente: dar a `ativada_em` um `DEFAULT now()` quebra o padrão
universal de todo seed/teste existente ("INSERT na tabela, DEPOIS um loop de
INSERT nas faixas" — nunca atômico) — a tabela nasceria imutável antes da
primeira faixa ser inserida, e toda chamada a
`seedArmadorTables`/`seedRocketTermoPorEmbarque`/`seedRocketTermoUnico`
passaria a falhar. Por isso `ativada_em` fica **sem default** (`NULL` por
omissão, igual a qualquer outra coluna nova): nenhuma tabela nasce
automaticamente "ativada" só por existir. `ativada_em` **nunca** é filtrado
por `selecionarVigente`/`buscarPorId` — não é um controle de
**visibilidade**, só de **mutabilidade**; a seleção de versão vigente
permanece exatamente a mesma regra de data/dimensão de sempre (vigência
conhecida cobrindo a data de referência, com prioridade à mais recente;
vigência desconhecida só a partir de `verificada_em`).

### Fluxo de criação/correção de versão

- `criarRascunho(pool, dados)` — insere tabela + faixas na MESMA transação,
  `ativada_em = NULL` (editável por `substituirFaixas` até ser usada ou
  ativada explicitamente).
- `substituirFaixas(pool, tabelaId, faixas)` — checa `estaImutavel` ANTES de
  tentar escrever (erro tipado `TariffTableImutavelError`); se a versão já
  estiver congelada, rejeita sem tocar o banco. A janela de corrida residual
  entre essa checagem e o COMMIT é coberta pelo trigger de banco.
- `ativar(pool, tabelaId)` — trava explicitamente; idempotente (ativar de
  novo é NO-OP silencioso).
- `criarVersaoCorrigida(pool, tabelaBaseId, correcao, opts)` — cria a
  **próxima versão da mesma identidade** (organização/tipo/armador/termo),
  `MAX(versao)+1` entre todas as versões já existentes dessa identidade
  (cobre correção-de-correção); conteúdo inteiramente informado pelo
  chamador (nunca copiado da versão antiga — evita herdar silenciosamente
  um erro não corrigido); `ativarImediatamente` (default `true`) trava a
  versão nova **depois** de todas as faixas já inseridas, na mesma
  transação. Nunca toca a versão-base: ela permanece intacta e, se já
  travada, referenciada por qualquer `ValorApurado` que já a usou (histórico
  nunca reescrito).

### Vinculação histórica

- Um cálculo **FINAL** nunca é recalculado automaticamente — mesmo que uma
  versão nova exista, `recalcularApuracaoContainerComClient` é NO-OP sobre
  processo FINAL (guard pré-existente de D15-A, intacto). A versão/tabela
  original permanece referenciada para sempre, a menos que o processo passe
  pelo fluxo de reabertura.
- Um processo **OPEN** usa a versão nova na PRÓXIMA apuração autorizada
  (qualquer chamada legítima a `recalcularApuracaoContainer`), seguindo a
  MESMA regra de seleção por data/vigência de sempre — nunca um "sempre usa
  a mais nova" incondicional.
- Um FINAL só pode voltar a usar uma versão nova através do fluxo CONGELADO
  de reabertura de D15-A (`ClosingService.solicitarReabertura` +
  `autorizarReabertura`, que reabre para OPEN e recalcula explicitamente, na
  mesma transação) — nunca por um caminho novo criado nesta fase.

## 4. Composição do hash de cálculo (R30)

`calcularInputHashValor` (em `domain/valorApurado.ts`) agora inclui, além
das entradas já existentes (motor, relógio, equipamento, `tabelaId`,
`versaoTabela`, `dayCountBasis`, free time, dias de demurrage, data final de
apuração): `vigenciaInicio`/`vigenciaFim` da versão resolvida e
`faixasTabela` — toda faixa/diária aplicável ao equipamento, já resolvida e
filtrada pelo CHAMADOR (`persistir()`, em `recalcularApuracao.ts`), nunca
reimplementando a seleção/posicionamento de faixa dentro do código de hash.
As faixas são canonicalizadas (ordenadas por `tipoEquipamento`/`diaInicial`)
antes de entrar no payload — reordenar linhas persistidas equivalentes nunca
produz um hash diferente (`d15c.test.ts` #10); mudar o valor de uma diária
ou o limite de uma faixa sempre produz um hash diferente (#9), mesmo que
`tabelaId`/`versaoTabela` permaneçam os mesmos — defesa em profundidade: a
imutabilidade de versão já torna "mesmo tabelaId+versão com conteúdo
diferente" impossível para qualquer versão ativada/usada a partir desta
fase, mas o hash não depende só dessa garantia de banco para detectar uma
mudança de conteúdo.

## 5. Proteção contra overlap e prova de concorrência (R28)

A rejeição de faixas sobrepostas no mesmo `(tariff_table_id,
tipo_equipamento)` é uma `EXCLUDE USING GIST` sobre
`int4range(dia_inicial, dia_final+1)` — **um índice**, não uma checagem em
memória de aplicação, portanto funciona identicamente:

- **pelo serviço** — `substituirFaixas`/`criarRascunho` inserem faixa por
  faixa dentro de uma transação; a segunda faixa sobreposta falha contra a
  primeira (já inserida, ainda não comitada) e a transação inteira reverte
  (`d15c.test.ts` #11);
- **por SQL direto** — um `INSERT` cru na mesma tabela é igualmente
  rejeitado (`exclusion_violation`, SQLSTATE `23P01`) (#12);
- **sob concorrência real** — dois `INSERT`s concorrentes com ranges
  sobrepostos, emitidos ao mesmo tempo contra uma tabela vazia (duas
  conexões distintas), resultam em exatamente um sucesso e uma rejeição —
  provado com `Promise.allSettled` (#13); o índice GiST serializa a
  concorrência via lock, nunca deixando as duas gravadas.

Faixas adjacentes (sem overlap — ex. `[1,10]` e `[11,20]`) permanecem
válidas (#14); um buraco na tabela (ex. `[1,6]` e `[15,∞)`, sem cobrir
`7`–`14`) continua produzindo `UNAVAILABLE` no motor — comportamento
pré-existente, preservado e re-confirmado (#15).

## 6. Comportamento de falha de moeda mista (R29)

Antes da correção, `posicionarFaixas` lançava uma exceção quando as faixas
do mesmo equipamento numa tabela tinham moedas diferentes. Como este motor
roda DENTRO da mesma transação que o relógio e o lado comercial OPOSTO
(cliente × Rocket) — e, quando chamado por
`recalcularApuracaoProcessoComClient` (reabertura), dentro da MESMA
transação de TODOS os contêineres de um processo — esse `throw` desfaria a
transação inteira, perdendo os dias já apurados e o cálculo do outro lado, e
apagando o cálculo bem-sucedido de outros contêineres do mesmo processo.

A correção devolve `{status:'UNAVAILABLE', motivo:'MOEDA_MISTA_NA_TABELA:
...'}` — o MESMO caminho já usado para "buraco na tabela"; os chamadores
(`calcularTermoUnico`/`calcularTermoPorEmbarque`/`calcularExposicaoRocket`)
já tratam `UNAVAILABLE` genericamente, sem nenhuma mudança neles.
Confirmado em `d15c.test.ts` #16/#17, com dois contêineres do MESMO
processo recalculados numa ÚNICA transação compartilhada
(`recalcularApuracaoProcessoComClient`):

- o contêiner com moeda mista fica `UNAVAILABLE` no lado cliente
  (`total`/`dias_cobrados` nulos; `tabela_id` preenchido — a tabela FOI
  encontrada, o problema é o conteúdo das faixas, não a ausência de tabela);
- os dias calculados pelo RELÓGIO (independente do motor tarifário)
  permanecem preservados;
- o cálculo bem-sucedido do OUTRO contêiner do mesmo processo não é apagado
  nem revertido pelo `COMMIT` compartilhado;
- a exposição Rocket do MESMO contêiner (tabela do armador, inteiramente
  separada) calcula normalmente — lado cliente e Rocket permanecem
  independentes.

**Nota de transparência**: `valores_apurados` não tem (e esta fase não
criou) uma coluna para o texto do `motivo`; a razão sanitizada (string de
diagnóstico, nunca um dado sensível) vive só no retorno em memória da
chamada de cálculo, nunca persistida linha a linha. A migration-0037 não
adiciona essa coluna por ser estritamente fora do escopo aprovado (R29/R30
não pedem uma nova coluna de auditoria textual); `d15c.test.ts` #16
confirma a causa exata (moeda mista, nunca outra) reexecutando o motor
puro sobre as MESMAS faixas persistidas, em vez de ler um `motivo` que o
schema não guarda.

## 7. Filas — máquina de estados, teto de tentativas, estado terminal (R57/R58)

Todas as filas afetadas (`recalculo_outbox`, `demurrage_pos_commit_outbox`,
`demurrage_fallback_manual_avisos`, `ft_divergencia_entregas`,
`demurrage_pendencia_avisos`) compartilham a MESMA máquina de estados desde
D15-B/D15-B v1.1 — `PENDING/pendente → PROCESSING/processando →
DONE/concluido | FAILED/falha`, com retentativa de `FAILED`/`falha` — mas
até esta fase o claim de recuperação de um `PROCESSING` vencido exigia
`tentativas < máximo`, condição que já era FALSA para um item que tivesse
sido reivindicado exatamente na sua última tentativa permitida. Esse item
nunca mais aparecia como recuperável (a condição de recuperação falhava) e
nunca tinha chegado a ser finalizado (o worker morreu antes) — preso para
sempre, de forma silenciosa.

**Correção (uniforme nas seis filas)**: a condição do claim passa a ser
`((PENDING/FAILED E tentativas < máximo) OU (PROCESSING vencido))` — a
recuperação de um `PROCESSING` vencido NUNCA é condicionada ao teto (a
tentativa que crashou já foi contada no claim original); o incremento é
sempre `LEAST(tentativas+1, máximo)`, garantindo que uma recuperação nunca
ultrapassa o teto. Um item que, depois de recuperado, falha de novo e
atinge o teto fica em `FAILED`/`falha` com `tentativas = máximo` — **estado
terminal explícito e visível**, nunca mais reivindicado automaticamente
(`d15c.test.ts` #18, #19). `demurrage_pos_commit_outbox` (R58) não tinha
teto nenhum até esta fase — ganhou o parâmetro `maxTentativas` (default 5) e
os contadores `restantes`/`esgotados`, auditáveis em
`processarPosCommitOutboxPendentes`/no log do tick
(`formatarLogTick`/`schedulerBootstrap.ts`).

Nenhum fato de negócio ou observação do ledger é perdido quando uma linha se
esgota: o registro principal (processo/contêineres/ledger) já está comitado
antes de qualquer claim do pós-commit — só o recálculo/fotografia pós-commit
para de ser retentado automaticamente.

## 8. Claim/lease/fencing — outbox de alerta de tracking (R59)

`scheduler/alertOutbox.ts` foi reescrito por completo. A versão anterior
(`carregarPendentes` + `marcarEnviada`/`marcarFalha`, sem claim nenhum)
carregava TODAS as entregas pendentes de uma vez e as processava em
memória — dois workers concorrentes carregavam a MESMA lista e enviavam a
MESMA entrega duas vezes, sem nenhuma proteção (double-send real). O
protocolo novo — idêntico em espírito ao já aprovado para
`demurrage_fallback_manual_avisos`/`ft_divergencia_entregas`/
`demurrage_pendencia_avisos` — é:

1. **claim** de UMA entrega por vez (`UPDATE ... SET status='PROCESSING',
   claim_token=gen_random_uuid(), worker_id=$1, expira_em=now()+ttl,
   tentativas=LEAST(tentativas+1,max) WHERE id=(SELECT ... FOR UPDATE SKIP
   LOCKED LIMIT 1)`), autocommit — nunca dentro de uma transação aberta pelo
   chamador;
2. **envio** fora de qualquer transação — montagem do conteúdo (leitura
   pura) + chamada ao transporte real;
3. **finalização** condicionada ao `claim_token` vigente
   (`WHERE id=$1 AND status='PROCESSING' AND claim_token=$2`) — `SENT` ou
   `FAILED` conforme o retorno do transporte.

Confirmado em `d15c.test.ts`:

- **#20** — dois workers concorrentes chamando `processarEntregasPendentes`
  ao mesmo tempo sobre a MESMA entrega: o transporte real é chamado
  exatamente UMA vez; a entrega termina `SENT` uma única vez;
- **#21** — uma lease vencida (worker morto, `expira_em` no passado) é
  recuperável por outro worker;
- **#22** — **fencing**: o worker que perdeu a posse (lease expirada,
  reivindicada por outro) não consegue mais finalizar com o `claim_token`
  antigo — a tentativa tardia de `UPDATE ... WHERE claim_token=$tokenVelho`
  afeta zero linhas; o estado definido pelo dono real nunca é sobrescrito;
- **#23** — o envio ocorre **fora** da transação do claim: uma conexão
  SEPARADA já vê o claim `PROCESSING` committed enquanto o transporte ainda
  está em andamento (prova direta de visibilidade sob READ COMMITTED, não
  inferência de código);
- **#24** — a falha de UMA entrega de alerta não muda a cadência, os
  `fetches`, os claims nem os créditos de consulta ao armador da etapa de
  tracking do mesmo tick — isolamento confirmado comparando os contadores
  de duas rodadas idênticas, uma com transporte que sempre falha.

**Janela de "ao menos uma vez" (documentada, inevitável)**: se o transporte
externo aceitar a mensagem e o worker morrer ANTES de confirmar `SENT`, a
entrega permanece `PROCESSING`, a posse expira e outro worker a reenvia — o
destinatário pode, nessa janela de crash específica, receber o alerta duas
vezes. Nenhum provedor de e-mail dá uma primitiva de "exactly once" sem
idempotência do LADO do destinatário, que este sistema não controla. Essa
é a MESMA garantia (e a mesma janela) já aceita nas outras cinco filas.

## 9. Caminhos de migração

A migration `0037` é inteiramente aditiva (`0001`–`0036` intocadas) e segue
o padrão estagiado já estabelecido desde a migration `0006`: (1) preservar
dados; (2) identificar violações legadas com uma varredura `DO $$ ...
RAISE EXCEPTION $$`; (3) só então aplicar a constraint nova; nunca inventa
qual versão/valor é o verdadeiro — aborta e deixa a decisão para quem
conhece o dado real. Comprovado em `d15c.test.ts` #25 (três sub-casos, bancos
`CREATE DATABASE` temporários e isolados, nunca o `demurrage_test`
compartilhado pelo resto da suíte):

1. banco **novo**: todas as 37 migrations aplicam de uma vez; reexecutar não
   reaplica nada;
2. banco já em **0036** (sem violação legada): o upgrade para `0037`
   aplica limpo;
3. banco em 0036 **com** uma violação legada real (duas linhas
   `rocket_cliente` idênticas em dimensão — `armador_id` sempre `NULL`
   nesse tipo, exatamente o defeito que a `NULLS NOT DISTINCT` corrige): a
   migration aborta citando os IDs em conflito, e a linha de
   `schema_migrations` não é marcada — retentável depois de resolver
   manualmente (no teste, uma das duas duplicatas recebe `versao=2`, nunca
   apagada) e a MESMA migration aplica normalmente na sequência.

## 10. Totais de regressão (ordem exigida)

| Suíte | Resultado |
|---|---|
| D15-A v1.0–v1.3 (`closingD15A*.test.ts`, 4 arquivos) | 45/45 |
| D15-B + D15-B v1.1 (`d15b.test.ts`, `d15bV11.test.ts`) | 18 + 14 = 32/32 |
| D15-C (`d15c.test.ts`, 25 cenários numerados) | 28/28 subtestes (25 testes de topo, 3 deles com 3 subtestes cada no caso #25) |
| Demurrage Engine completo (67 arquivos) | 917/917 |
| V1 (`npm test` — `src/auditoria/preAlerta/*.test.ts`) | 25/25 |
| D13 UI (`npm run test:demurrage-ui`) | 66/66 |
| `tsc --noEmit` | limpo |
| `npm run build` (produção) | limpo |

Nenhuma regressão encontrada em D15-A, D15-B ou em qualquer suíte
pré-existente.

## 11. Limitações e defeitos encontrados

- **`valores_apurados` não persiste o `motivo` de um resultado
  `UNAVAILABLE`** (nenhuma coluna existe para isso desde antes desta fase —
  nem a ausência de tabela, nem buraco na tabela, nem agora moeda mista
  gravam o texto da razão linha a linha). Fora do escopo aprovado para esta
  fase (nenhum dos seis casos pede essa coluna); registrado aqui como
  limitação conhecida, não como defeito introduzido — a razão sanitizada
  segue disponível no retorno em memória de cada chamada de cálculo.
- **Janela de "ao menos uma vez" em todas as seis filas de claim/posse**
  (documentada em detalhe no §8) é uma limitação estrutural aceita, não um
  defeito: nenhuma garantia de "exactly once" é possível sem idempotência
  do lado do destinatário externo.
- Nenhum defeito novo foi encontrado em D15-A ou D15-B durante esta fase —
  nenhuma correção de comportamento congelado foi necessária.

---

**Esta entrega não é declarada aprovada nem congelada.** Fica para
auditoria. D16 não foi iniciado.
