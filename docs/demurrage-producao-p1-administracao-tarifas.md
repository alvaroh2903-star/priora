# Produção P1 — Administração tarifária operacional

> **Estado: ENTREGUE PARA REVISÃO — NÃO congelada.** Este relatório não
> congela a entrega nem declara a Produção P1 concluída. Frontend, HTML, CSS,
> JavaScript de apresentação e design **não** foram alterados (§15).
> Armazenamento definitivo de minutas, integração produtora da Liberação e
> multiorganização **não** foram iniciados.

Motivo da entrega: processo com demurrage não encerra sem tabela tarifária
ativa (gate `valor_cliente_nao_confirmado` / `valor_rocket_nao_confirmado`,
`closing/closingService.ts:263-267`), e não existia nenhuma superfície de
produção para cadastrar, publicar, corrigir ou retirar tarifa (§2.9).

Caminhos relativos a `src/demurrage-engine/` salvo indicação.

---

## 1. Baseline

- Branch `claude/practical-cerf-mnz7oj`, HEAD `605bde200b8acd1d0dcad8ac063d001781f93597`
  ("congela a entrega de autenticação, identidade, atribuição e filas
  pessoais"), árvore limpa e igual ao remoto antes de qualquer edição.
- Entregas congeladas preservadas: Entregas 1/2/3, correção de minuta e
  encerramento, autenticação/identidade/atribuição/filas pessoais (§19 de
  `demurrage-producao-p1-autenticacao-filas.md`). Limitação aprovada do MVP
  mantida: uma organização em produção.
- Última migration no baseline: 0051. Esta entrega acrescenta só a **0052**
  (aditiva). 0001–0051, inclusive 0049, 0050 e 0051, não foram alteradas.

---

## 2. Diagnóstico anterior (Etapa 1, somente leitura)

Feito antes de qualquer edição, com leitores paralelos e consolidação
verificada no código (divergências entre leitores resolvidas no próprio
código). Resumo dos 10 itens pedidos:

1. **Esquema.** `tariff_tables` (`tipo` `rocket_cliente`|`armador`;
   `organization_id` NULL = pública; `armador_id`/`termo_comercial`; `versao`;
   `vigencia_inicio` nullable = início desconhecido, regra 0010;
   `vigencia_fim`; `qualidade_fonte`; `day_count_basis`; `fonte`;
   `verificada_em`; `ativada_em` NULL = rascunho, 0037). `tariff_brackets`
   (`tipo_equipamento` TEXT sem FK, `dia_inicial`, `dia_final` NULL = aberta,
   `valor_dia` NUMERIC(12,2) ≥ 0, `moeda` TEXT sem CHECK; EXCLUDE de
   sobreposição, 0037). Imutabilidade por trigger (`tariff_table_esta_congelada`:
   ativada OU usada por `valores_apurados`; 0037/0038) — **nenhuma coluna de
   versão ativa pode mudar, nem `vigencia_fim`**. Não havia autor, motivo,
   estado, evento nem trilha.
2. **Cliente × armador.** Cliente = tabela privada da organização (Termo
   Único por organização; Termo por Embarque fixado por ID em
   `condicoes_comerciais.tabela_id`). Armador = pública por `armador_id`; o
   motor **nunca** passava `organizationId`, então uma tabela privada de
   armador era invisível ao cálculo.
3. **Dimensões reais.** Termo Único: (org, `unico`), data = 1º dia de
   demurrage do cliente. Termo por Embarque: por ID, vigência ignorada.
   Exposição ao armador: (`armador_id`), data = descarga. Cliente, porto,
   moeda e Free Time **não** são dimensões.
4. **Regras.** Equipamento por igualdade com `container_types.codigo`
   (vocabulário do seed de armador não casa → UNAVAILABLE); faixas inclusivas;
   lacuna ou dia além da última faixa fechada → cálculo inteiro UNAVAILABLE;
   Termo por Embarque usa só a primeira faixa e ignora a base de contagem;
   moeda por faixa, mista no mesmo equipamento → UNAVAILABLE; nenhuma
   conversão; Free Time fora da tabela (House → cliente, Master → armador).
5. **Testes.** 47 arquivos criam tarifa (seeds `seedArmadorTables`,
   `seedRocketTermo*`, INSERT direto + `UPDATE ativada_em`, serviço
   `tariffTableService`). Nenhum cria tabela privada de armador.
6. **Seleção.** `selecionarVigente`: passo 1 vigência conhecida
   (`vigencia_inicio DESC, versao DESC, id`), passo 2 início desconhecido a
   partir da data UTC de `verificada_em`, passo 3 NOT_FOUND × NOT_PROVEN.
   Sem EXCLUDE de vigência entre ativas; substituição só "por ordenação".
7. **Estados de leitura.** ESTIMATED / ESTIMATED_PROVISIONAL (só
   `PROVISORIA_INCOMPLETA` em Termo Único/armador) / CONFIRMED (nunca
   produzido) / UNAVAILABLE; PENDENTE e NAO_APLICAVEL só na leitura. O motivo
   do UNAVAILABLE nunca era persistido nem devolvido.
8. **Bloqueios de encerramento.** Só ESTIMATED/CONFIRMED liberam; UNAVAILABLE,
   ESTIMATED_PROVISIONAL e ausência de linha bloqueiam.
9. **Superfície de administração.** Nenhuma: nenhuma rota, CLI, script ou
   migration criava, ativava ou encerrava tarifa; `tariffTableService` só era
   usado por testes.
10. **Nova versão × processos.** Não existia recálculo por mudança de tarifa;
    FINAL é NO-OP (guards 0017); reaberto recalcula na autorização com a
    tarifa vigente; Termo por Embarque continua no ID antigo.

Lacunas que viraram decisões desta entrega: ciclo de vida sem UPDATE em
versão congelada (§3), substituição e conflito de vigência (§6), recálculo
controlado (§8), motivos estáveis (§9), dono das tabelas de armador (§3.3),
auditoria (§11).

---

## 3. Modelo de estados

### 3.1 Estados (derivados; nenhuma coluna mutável nova em `tariff_tables`)

| Estado | Derivação |
|---|---|
| `DESATIVADA` | existe transição `DESATIVACAO` (precedência) |
| `RASCUNHO` | `ativada_em IS NULL` |
| `SUBSTITUIDA` | ativada, com ≥1 transição `SUBSTITUICAO` |
| `ATIVA` | ativada, sem substituição nem desativação |

As transições ficam em `tariff_versao_transicoes` (append-only, ligada ao
evento de auditoria que a causou). O fim **efetivo** de uma versão substituída
(`vigencia_efetiva_fim`) mora na transição — a versão continua imutável.

### 3.2 Transições permitidas

- `RASCUNHO → ATIVA`: ativar (validação completa na mesma transação).
- `RASCUNHO → DESATIVADA`: abandonar rascunho (terminal: trigger novo barra
  edição, ativação e DELETE).
- `ATIVA`/`SUBSTITUIDA` (ainda aplicável a alguma data) `→ DESATIVADA`.
- `ATIVA → SUBSTITUIDA`: só como efeito da ativação de outra versão da mesma
  dimensão (seleção por data).
- Desativar uma sucessora **não** restaura a antecessora (§6.4).

### 3.3 Lados e dimensões (nenhuma dimensão nova)

| Lado | `tipo` | Dimensão | Seleção |
|---|---|---|---|
| cliente — Termo Único (`cobranca_ao_cliente`) | `rocket_cliente` | (org, `unico`) | por data: 1º dia de demurrage do cliente |
| cliente — Termo por Embarque | `rocket_cliente` | (org, `embarque`) | por **ID** fixado na condição (vigência informativa) |
| armador (`exposicao_estimada_ao_armador`) | `armador` | (org, `armador_id`) privada; (NULL, `armador_id`) pública legada | por data: descarga |

- **Tabela privada de armador** (o schema já permitia; o motor não lia):
  depois que a organização ativa qualquer versão privada para um armador,
  datas a partir do menor início dessas versões (inclusive desativadas)
  usam **só** a dimensão privada — sem versão privada aplicável, o resultado
  é "sem versão vigente", **nunca** a estimativa pública em silêncio. Antes
  desse corte, ou sem versão privada ativada, vale a pública como antes
  (`tariffTableRepository.selecionarVigenteArmador` /
  `dimensaoPrivadaArmadorGoverna`). Linha privada de armador **legada**
  (criada fora da API, já ativada pelo backfill da 0037) também conta para o
  corte — nenhum caminho de produção criava essas linhas antes desta entrega,
  e o runbook confere que não existem antes da implantação (§12, §15.1).
- **Tabelas públicas**: só leitura pela API (409 `tabela_publica_somente_leitura`);
  servem de ORIGEM de uma versão privada (`nova-versao`).
- **`armadores`** é catálogo global, fora da API por organização ("armador de
  outra organização" não existe → `armador_inexistente`).

---

## 4. API — `/api/demurrage/v2/tarifas`

Sessão humana (`requireSessao`) + membership interno ativo da organização da
sessão (`autorizarInterno`, `organizationId` da requisição → 400). Montada ao
lado de `acoes`/`admin`, antes da V2 de leitura (`src/app.ts`). Mutações exigem
`Idempotency-Key` (mesmas regras de `acoes/idempotencyKey.ts`). Contratos
nomeados `demurrage.tarifas.*.v1`.

| # | Rota | Papel | Observação |
|---|---|---|---|
| 1 | `GET /versoes?lado&estado&armadorId&termoComercial&escopo&limite&cursor` | ANALYST (só ativadas) / MANAGER / ADMIN | cursor assinado preso a org + filtros + classe de visibilidade |
| 2 | `GET /versoes/:id` | idem (rascunho → 404 ao ANALYST) | gestor recebe `conteudoHash`, `revisaoDimensao`, `impactoDesativacao` |
| 3 | `POST /versoes` | MANAGER/ADMIN | cria rascunho (dimensão + metadados + faixas) |
| 4 | `PATCH /versoes/:id` | MANAGER/ADMIN | metadados do rascunho (lista fechada) |
| 5 | `PUT /versoes/:id/faixas` | MANAGER/ADMIN | define/substitui todas as faixas |
| 6 | `POST /versoes/:id/validar` | MANAGER/ADMIN | somente leitura |
| 7 | `GET /versoes/:id/validacao` | MANAGER/ADMIN | erros, avisos, efeitos, revisão, hash |
| 8 | `POST /versoes/:id/ativar` | MANAGER/ADMIN | `{revisaoDimensao, conteudoHash, motivo, confirmarInvalidacoes, aceitarQualidadeProvisoria?}` |
| 9 | `POST /versoes/:id/nova-versao` | MANAGER/ADMIN | `{motivo}`; copia metadados e faixas para rascunho da organização |
| 10 | `POST /versoes/:id/desativar` | MANAGER/ADMIN | `{motivo, estadoEsperado, revisaoDimensao, confirmarInvalidacoes, confirmarProcessosAfetados, aceitarVersoesExpostas?}` |
| 11 | `GET /versoes/:id/historico`; `GET /eventos/:id/recalculo`; `POST /eventos/:id/recalculo/reprocessar` | MANAGER/ADMIN | histórico paginado; situação e reprocessamento do recálculo |
| 12 | `POST /simulacoes` | MANAGER/ADMIN | `{lado, termoComercial, armadorId, tabelaId (só embarque), dataReferencia, equipamento}` ou `{processoId}`; transação READ ONLY |
| + | `GET /processos/:processoId/situacao` | ANALYST (só atribuído; senão 404) / MANAGER / ADMIN | leitura operacional com motivo estável |

**Erros previsíveis** (nunca 500): 400 corpo/parâmetro/chave; 403 papel
(`apenas_manager_admin`, `escopo_nao_permitido`); 404 inexistente ou de outra
organização (corpo idêntico); 409 estado/revisão/hash/impacto/chave
(`transicao_invalida`, `versao_imutavel`, `revisao_dimensao_desatualizada`,
`conteudo_alterado`, `estado_alterado`, `impacto_alterado`,
`desativacao_exporia_versao_anterior`, `idempotency_key_reutilizada`,
`recalculo_em_andamento`, `nada_a_reprocessar`, `tabela_publica_somente_leitura`,
`conflito_concorrente`); 422 `validacao_falhou` com
`erros: [{codigo, campo, faixa?, equipamento?, detalhe?}]`. Residual de banco
(23505, 23503, 23P01, P0001, 40001, 40P01) → 409 `conflito_concorrente`;
data que o banco não representa (22007, 22008 — a validação já recusa o ano
0000) → 422 `data_invalida`.

**Validação** (bloqueia ativação; por campo e por faixa): `moeda_ausente`,
`moeda_invalida` (ISO 4217 corrente, maiúscula, nunca normalizada),
`moeda_divergente_na_tabela` (uma moeda por versão), `vigencia_inicio_ausente`
(exceto Termo por Embarque, que aceita início desconhecido), `vigencia_incoerente`,
`data_invalida` (calendário e ano 0001–9999), `verificada_em_invalida` (mesma regra de
calendário na data informada — 2026-02-30 é recusado, nunca "corrigido" —, hora 00–23,
minuto/segundo 00–59, fuso até ±23:59, ano 0001–9999 em UTC), `tabela_sem_faixas`, `equipamento_invalido`
(fora de `container_types`), `valor_negativo`, `numero_fora_do_formato`
(diária ≤ 7 dígitos inteiros e 2 casas; dias inteiros 1..36500),
`faixas_sobrepostas`, `lacuna_entre_faixas`, `lacuna_inicial` (base
`excess_over_free_time` e Termo por Embarque), `progressao_invalida` (fim <
início; última faixa fechada), `dimensao_obrigatoria_ausente`,
`armador_inexistente`, `ambiguidade_selecao` (Termo por Embarque: uma faixa
`[1,∞)` por equipamento), `qualidade_incompativel` (Termo por Embarque
provisório), `qualidade_provisoria_bloqueia_encerramento` (sem aceite
explícito), `conflito_com_versao_ativa`, `campo_invalido`, `texto_invalido`,
`faixas_demais`. A edição de rascunho recusa de imediato só o que é
malformado ou que o banco não guarda (formato, negativo, sobreposição,
fim < início); o resto fica no rascunho, aparece em cada resposta de edição e
em `/validacao`, e bloqueia a ativação.

---

## 5. Permissões

- **MANAGER/ADMIN** da organização da sessão: tudo. O papel é relido a cada
  requisição (`autorizarInterno`) e de novo **sob lock** (`FOR SHARE` no
  membership) dentro de cada mutação, ANTES do replay de idempotência — um
  ator rebaixado entre o middleware e a transação nunca recebe resposta
  gravada.
- **ANALYST**: só o operacional — versões já ativadas (nunca rascunho, nem
  abandonado; `estado=RASCUNHO` → 403), sem `conteudoHash`/`revisaoDimensao`/
  impacto; situação tarifária só dos processos atribuídos a ele (404 idêntico
  fora do escopo). Toda rota de gestor responde 403 antes de qualquer
  consulta.
- **CLIENT**: nenhum acesso (sem sessão: o login recusa; sem papel interno:
  403).
- **Outra organização**: 404 idêntico a inexistente em toda rota, inclusive
  simulação por `tabelaId`/`processoId`, histórico, recálculo e reprocessar.

---

## 6. Vigência

### 6.1 Regras temporais (as do motor, mantidas)

Datas civis; início e fim **inclusivos** (`vigencia_fim >= data`); fim
ausente = aberta. A data de referência é sempre a **do processo, por
contêiner** — cliente: 1º dia de demurrage (descarga + House Free Time);
armador: descarga; Termo por Embarque: nenhuma (ID). A data do servidor
nunca a substitui: a simulação por parâmetros exige `dataReferencia` (400
sem ela); o diagnóstico usa a data final do último cálculo persistido ou a
devolução, nunca "hoje"; o fallback inalcançável `discharge_date ?? finalDate`
do recálculo foi trocado pela descarga. `verificada_em` (legado de início
desconhecido) conta pela data civil **UTC** — a mesma expressão da seleção
(uma verificação depois das 21h de Brasília conta para o dia seguinte; regra
congelada).

### 6.2 Substituição na ativação (seleção por data)

Para cada versão W da mesma dimensão, publicada e não desativada, com faixa
efetiva `[Ws, We]` não vazia, contra a nova V `[Vs, Ve]`:
- sem interseção → nada;
- `Vs <= Ws` e `Ve >= We` → W substituída integralmente (`fim = Ws − 1`);
- `Ws < Vs` e `Ve >= We` → W truncada em `Vs − 1` (datas históricas mantêm a
  versão delas);
- qualquer outro caso → `conflito_com_versao_ativa` (inclusive substituir
  integralmente uma versão que começa em 0001-01-01: o fim efetivo seria o
  ano 0000, que o banco não guarda — validação e ativação concordam).

Depois de cada ativação pela API, nenhuma data da dimensão fica coberta por
duas versões criadas pela API. Legado sobreposto continua resolvido pela
ordem existente. A seleção aplica DESATIVACAO e o fim efetivo como **filtro**
(nunca como dado do cálculo): `TabelaResolvida.vigenciaFim` continua sendo a
coluna gravada e o `input_hash` não muda — truncar W não reescreve os valores
que seguem em W (teste extra). Os passos 1 e 2 da seleção rodam num **único
comando** (`UNION ALL` com `passo`), um só instantâneo do banco.

### 6.3 Termo por Embarque

Fixado por ID: versões dessa dimensão nunca se substituem nem conflitam por
data (estados RASCUNHO/ATIVA/DESATIVADA); lock e revisão por versão. Uma
versão nova **não** é adotada pelos processos fixados na base — a resposta de
`nova-versao` diz isso (`termoEmbarque.processosAbertosFixadosNaBase`,
`adotadaPorEles:false`). Repontar = novo registro/handoff com outro
`tabelaId` (fluxo existente; operação de migração fora do escopo).

### 6.4 Desativação e "volta silenciosa"

- Desativar uma versão não restaura a que ela substituiu (restaurar = nova
  versão copiada + ativação, auditadas).
- Se a desativação **exporia** uma versão legada que ela hoje vence
  (sobreposição legada), a operação é recusada (409
  `desativacao_exporia_versao_anterior`, com a lista) até o corpo aceitar
  exatamente essas versões (`aceitarVersoesExpostas`), gravadas no evento.
- Armador privado: desativar nunca faz cair para a pública (§3.3).

---

## 7. Versionamento e concorrência

- Número = `MAX(versao)+1` da dimensão sob lock consultivo da dimensão.
- Ordem universal de locks em toda mutação: (1) lock consultivo da chave de
  idempotência `(org, chave)`; (2) membership `FOR SHARE`; (3) replay ou 409;
  (4) lock consultivo da dimensão (Termo por Embarque: da versão); (5) linha
  alvo `FOR NO KEY UPDATE` (não conflita com o KEY SHARE das FKs do
  recálculo); conferência de que a dimensão relida é a travada.
- **If-Match**: ativar exige `revisaoDimensao` (nº de versões ativadas + nº de
  desativações de versões ativadas; Termo por Embarque: transições da própria
  versão) e `conteudoHash` (SHA-256 do conteúdo canônico: dimensão, versão,
  vigências, qualidade, base, fonte, verificação, faixas ordenadas). Desativar
  exige `estadoEsperado` e `revisaoDimensao`. Duas ativações concorrentes na
  mesma dimensão: exatamente um vencedor; a outra recebe 409.
- **Uma fotografia por leitura de If-Match**: `GET …/validacao` e
  `GET /versoes/:id` rodam em `REPEATABLE READ READ ONLY` — revisão, plano de
  substituição, impacto e hash saem do mesmo instante. Uma ativação
  concorrente que comita no meio da validação deixa a revisão devolvida
  velha, e a ativação seguinte recebe 409 (nunca aplica uma substituição que
  ninguém viu; teste de revisão).
- Escritores de faixas fora da API (serviço legado, seed, SQL) são
  serializados com a ativação pelo `FOR SHARE` do trigger novo, ou abortados
  pelo banco (40P01 → 409) quando a espera formaria ciclo; uma faixa nunca
  troca de versão (`UPDATE … tariff_table_id` recusado).

---

## 8. Ativação e recálculo

### 8.1 Transação de ativação

Locks (§7) → estado RASCUNHO → revisão e hash → validação completa (inclusive
conflitos e qualidade provisória) → impacto relido sob lock e conferido com
`confirmarInvalidacoes` → `UPDATE ativada_em = now()` (exceção da 0038) →
evento de auditoria → expansão pendente → transições (ATIVACAO, SUBSTITUICAO)
→ COMMIT. Nada externo dentro da transação; nenhum item por contêiner
criado nela.

### 8.2 Recálculo pelo mecanismo existente

- Outbox `recalculo_outbox` (CHECK ampliado com `'tarifa'`), `chave` = id do
  evento (correlação), consumido pelo worker existente
  (`processarRecalculosPendentes`: claim `SKIP LOCKED`, época, retentativa até
  5, recuperação de posse vencida) → `recalcularApuracaoContainer` (NO-OP em
  FINAL, idempotente por `input_hash`). Desfecho gravado por item
  (`RECALCULADO` / `IGNORADO_FINAL`).
- **Expansão depois do COMMIT** (`tariff_recalculo_expansoes`, posse com
  prazo + cursor): processo a processo, em ordem de id, cada um numa
  transação curta que toma `lockProcesso` (o mesmo de reabertura, registro e
  recálculo), relê o status e, se OPEN, insere um item por contêiner (ordem de
  id). Quem recalculava/reabria com a tarifa anterior termina antes e recebe o
  item; quem começa depois lê a tarifa nova. Sem KEY SHARE de contêiner
  segurado sob lock tarifário: sem deadlock com o encerramento. Posse com
  **token por execução** (nunca só o pid, que se repete entre réplicas);
  cursor, contadores e renovação da posse gravados **na mesma transação** dos
  itens de cada processo e só para o dono — quem perdeu a posse desfaz e para
  (nunca dois cursores, contadores exatos mesmo depois de queda). Orçamento
  conferido **antes de cada processo**. A expansão começa logo depois da
  resposta (melhor esforço, `lock_timeout` 2 s, orçamento 5 s, lotes de 20:
  a resposta espera no máximo ~5 s + um `lock_timeout`) e a etapa isolada do
  tick conclui.
- **Escopo** (só processos OPEN da organização): Termo Único → condição
  `unico`; Termo por Embarque → condição com `tabela_id` = versão; armador →
  `processos.armador_id`. Candidatos também FINAL com reabertura em curso (o
  status é relido sob o lock).
- **FINAL nunca** é recalculado (fora do escopo + pipeline NO-OP + guards
  0017). **Reaberto**: SOLICITADA (ainda FINAL) intocado; a autorização
  recalcula com a tarifa vigente (regra formal); depois, OPEN, entra no
  escopo. A varredura automática continua pulando reabertura em andamento;
  gatilhos de ação/fato e o fechamento administrativo seguem a regra
  existente.
- **Tick**: a etapa de base passa a consumir só os tipos de Free Time; a etapa
  nova `recalculoTarifario`, isolada (fronteira de erro própria) e antes do
  encerramento, tem **um** orçamento (60 s): a expansão usa no máximo a
  metade, e o consumo dos itens `tarifa`, em lotes, o resto. No máximo **uma
  tentativa por item por etapa** sem parar a etapa: um item que falhou nela só
  volta a ser reivindicado na etapa seguinte (claim de FAILED só se a falha é
  anterior ao início da etapa). Contadores no `TickResultado` e no log,
  inclusive expansões adiadas por falha (`expansao-falhas`) e erro da
  avaliação de encerramento (`ENCERRAMENTO-ERRO`, sem zerar os contadores do
  que já foi recalculado).
- **Falha observável e reexecutável**: o item fica FAILED (erro em
  vocabulário fechado: `DEADLOCK`, `LOCK_TIMEOUT`, `SERIALIZACAO`,
  `REGRA_DE_BANCO`, `RESTRICAO_DE_INTEGRIDADE`, `ERRO_INTERNO` — nunca o
  texto do banco); `GET /eventos/:id/recalculo` mostra expansão, pendentes,
  recalculados, ignorados por FINAL, falhas retentáveis e esgotadas;
  `POST …/reprocessar` **rearma as mesmas linhas** esgotadas (PENDING,
  tentativas zeradas), auditado; recusado enquanto houver retentativa
  automática ou expansão pendente. A ativação nunca é desfeita.
- **Efeito na responsabilidade (regra congelada 0033)**: todo valor novo do
  cliente invalida a decisão RELOGIO_CLIENTE do contêiner, mesmo com diária
  idêntica. A prévia (`/validacao`, `impactoDesativacao`) mostra quantas
  decisões serão invalidadas e a operação exige `confirmarInvalidacoes` igual
  ao número relido sob lock (409 `impacto_alterado`). Na desativação conta o
  valor ativo OPEN **ou FINAL** de processo aberto (um processo reaberto
  mantém FINAL o valor que não mudou — e será recalculado) e também o valor
  sem tabela de contêiner com equipamento não reconhecido pelo motor
  (`container_types` ausente) quando a saída da versão muda a vigência da
  seleção (só ela entra no hash de um valor sem equipamento): Termo por
  Embarque, se a versão tem vigência gravada; Termo Único, por data, pela
  **própria regra de seleção** (a versão é a selecionada hoje e a seleção sem
  ela — `excluirTabelaId`, só nesta prévia, sem carregar faixas — tem outra
  vigência). O armador nunca invalida decisão.
- **Encerramento automático**: a própria etapa avalia, pelo mesmo núcleo e
  com a mesma regra da varredura (reabertura em curso respeitada), os
  processos ABERTOS que ela recalculou (até 200 por etapa); a varredura do
  tick (limitada e em ordem justa) continua como rede de segurança. O núcleo
  de encerramento não mudou.

---

## 9. Leituras operacionais e motivos estáveis

Valor, moeda, situação, lado e completude continuam saindo exatamente da
leitura congelada (envelope D12 intocado; `buscarDetalheProcesso`, mesma
regra de escopo do ANALYST, mesma agregação por moeda — lados e moedas nunca
somados). `GET /processos/:id/situacao` (uma fotografia só: a leitura congelada roda
dentro da mesma transação `REPEATABLE READ READ ONLY` do diagnóstico)
acrescenta, por contêiner e lado:
`motivo`, `motivoMotor`, `recalculoPendente`, `relogioDesatualizado`,
`dataReferencia` e sua origem, `tabelaPrevista`.

| Código | Significado |
|---|---|
| `TARIFF_TABLE_NOT_FOUND` | tarifa não cadastrada |
| `TARIFF_VERSION_NOT_ACTIVATED` | só rascunho |
| `TARIFF_VERSION_NOT_PROVEN` | sem versão vigente na data |
| `TARIFF_VERSION_DEACTIVATED` | versão (fixada ou única da faixa) desativada |
| `TARIFF_DIMENSION_MISSING` | sem armador / sem condição / condição sem tabela |
| `EQUIPMENT_NOT_RECOGNIZED` | equipamento fora do catálogo |
| `TARIFF_EQUIPMENT_WITHOUT_BRACKET` | equipamento sem faixa |
| `TARIFF_DAY_WITHOUT_BRACKET` | dia sem faixa |
| `TARIFF_MIXED_CURRENCY` | moeda mista no equipamento (legado) |
| `TARIFF_TOTAL_OUT_OF_RANGE` | total fora de NUMERIC(14,2) (legado) |
| `TARIFF_SELECTION_AMBIGUOUS` | Termo por Embarque legado com >1 faixa no equipamento |
| `TARIFF_PROVISIONAL_QUALITY` | estimado provisório (bloqueia FINAL) |
| `TARIFF_RECALCULATION_PENDING` | item `tarifa` não concluído criado depois do valor ativo, ou valor ≠ o que o motor produziria agora (relógio válido) |
| `DATA_REFERENCIA_INDISPONIVEL` | sem descarga/Free Time |

- O motivo **não** é persistido em `valores_apurados` e não entra no
  `input_hash` (evita SUPERSEDED em massa e invalidação espúria pela 0033).
  É calculado na leitura, em transação `REPEATABLE READ READ ONLY` (uma
  fotografia: corte privado, seleção e refinamento do motivo do mesmo
  instante), pelas MESMAS funções de seleção e motor do recálculo
  (`apuracao/resolucaoTarifaria.ts`, fonte única), sobre os fatos atuais do
  contêiner e a data final persistida. A divergência compara com o
  `tabelaId` do **resultado** do motor (o que seria gravado), não com a
  tabela selecionada: equipamento não reconhecido dá
  `EQUIPMENT_NOT_RECOGNIZED`, nunca pendência eterna.
- Simulação: `tabelaId` só de versão de Termo por Embarque da organização
  (outra → 404); por parâmetros, a mesma ordem de motivos do motor
  (equipamento → faixa → moeda única → ambiguidade).
- FINAL: o diagnóstico não compara com a seleção atual (sem pendência); a
  leitura mostra a versão histórica.
- Os códigos internos do motor (`MotivoIndisponivel`, textos livres) não
  mudaram — testes congelados os conferem. Novo no repositório:
  `TARIFF_VERSION_DEACTIVATED` (Termo por Embarque em versão desativada) e,
  no recálculo, `TARIFF_TOTAL_OUT_OF_RANGE` (antes: exceção que desfazia a
  transação inteira).

---

## 10. Migration 0052 (aditiva)

1. `UNIQUE (id, organization_id)` em `tariff_tables` (alvo de FK composta).
2. `tariff_admin_eventos` (auditoria + idempotência; append-only; organização
   imutável; FK composta para a versão e para o autor; `UNIQUE (org, chave)`;
   motivo obrigatório em ativar/desativar/nova-versão/reprocessar).
3. `tariff_versao_transicoes` (ATIVACAO/SUBSTITUICAO/DESATIVACAO;
   append-only; FKs compostas para versão, sucessora e evento; UNIQUE
   parciais de uma ativação e uma desativação por versão).
4. Trigger NOVO `forbid_tariff_desativada_mutation` em `tariff_tables` e
   `tariff_brackets` (rascunho desativado terminal; `FOR SHARE` na versão
   antes de checar, serializando escritores de faixas com a ativação; faixa
   nunca troca de versão — também fecha, sem editar a 0037, a saída de faixa
   de versão ativada). As funções 0037/0038 não foram tocadas.
5. `recalculo_outbox`: CHECK de `tipo` ampliado com `'tarifa'`; coluna
   `desfecho` (nullable); índice por `chave` dos itens `tarifa`.
6. `valores_apurados (tabela_id)` indexado (a checagem de congelamento da
   0037 varria a tabela inteira a cada faixa editada).
7. `tariff_recalculo_expansoes` (posse + cursor; organização imutável).

Nenhuma linha existente é alterada. Código novo sobre banco sem 0052 não
sobe em produção (boot check em `src/app.ts`).

---

## 11. Auditoria

Cada mutação grava UM evento em `tariff_admin_eventos`, na mesma transação:
organização, lado/tipo, armador, termo, versão, tabela; operação
(`CRIAR_RASCUNHO`, `CRIAR_VERSAO_DE`, `ATUALIZAR_METADADOS`, `SUBSTITUIR_FAIXAS`,
`ATIVAR`, `DESATIVAR`, `REPROCESSAR_RECALCULO`); autor (membership, usuário e
papel relidos sob lock); instante; valores anteriores e novos; motivo
informado; `conteudo_hash` (na ativação, exatamente o publicado); chave e
hash de idempotência e a resposta gravada (replay); correlação de recálculo
(o id do evento é a `chave` dos itens; reprocessamento aponta o evento de
origem). O hash do pedido inclui operação, alvo, corpo canônico e o **autor**
(a mesma chave usada por outra pessoa é 409). Nunca grava cookie, sid,
token, segredo, cabeçalho ou corpo bruto (teste 31 varre todas as linhas).

---

## 12. Compatibilidade e dados legados

- Nenhum dado tarifário é migrado ou alterado. Interpretação do legado:
  ativada = ATIVA (sem transição); não ativada = RASCUNHO; pública = só
  leitura; início desconhecido segue a regra 0010; legado sobreposto segue a
  ordem existente (e é protegido contra "volta silenciosa" na desativação).
- `tariffTableService` legado mantido (seeds/testes; sem chamador de
  produção; não valida). Seeds e as suítes que criam tarifa não mudaram.
- Caminho de produção alterado: (a) seleção exclui desativada e respeita fim
  efetivo; (b) armador privado com precedência e corte sem volta à pública;
  (c) Termo por Embarque em versão desativada → UNAVAILABLE
  `TARIFF_VERSION_DEACTIVATED`; (d) total fora da coluna → UNAVAILABLE com
  motivo, em vez de exceção; (e) etapa de base do tick só com tipos de Free
  Time. Sem nenhuma transição (todo o legado), (a)–(c) dão resultado idêntico
  ao anterior — **exceto** se existir linha privada de armador legada (criada
  fora da API; nenhum caminho de produção as criava): ela passa a valer para
  a organização a partir do seu início. O runbook confere, antes da
  implantação, que não há nenhuma (§15.1).
- Limitação MVP de organização única preservada; nada multiorganização novo.

**Testes existentes alterados** (só inventário e scaffold, nenhuma asserção
de regra afrouxada):

| Arquivo | Mudança | Por quê |
|---|---|---|
| `migrate`, `responsavelOperacional`, `registroDemurrageV12` (×2), `demurrageAcoesEntrega2V11`, `demurrageAcoesEntrega2V12`, `minutaEncerramentoP1`, `schedulerClaimFencing`, `responsabilidadeAuditoria`, `responsabilidadeV12` | listas de migrations com a 0052 | migration nova (precedente 0049–0051) |
| `migration0007` | `tariff_admin_eventos`, `tariff_versao_transicoes`, `tariff_recalculo_expansoes` em `TABELAS_COM_ORG` | tabelas novas com `organization_id` NOT NULL + trigger de imutabilidade |
| `testDb.truncateAll` | tabelas novas | limpeza explícita |
| `responsabilidadeV11`, `responsabilidadeV12`, `responsabilidadeAuditoria` | scaffold mínimo de `tariff_versao_transicoes` no schema congelado em 0032/0033 (removido antes da migration real) | a seleção passa a ler as transições; mesmo padrão dos scaffolds de `ativada_em`/`desativado_em` desses arquivos |

---

## 13. Testes

### 13.1 Os 32 testes obrigatórios

App real (Express, sessão e cookie reais, login Microsoft simulado),
PostgreSQL real; concorrência com conexões reais. Arquivos em
`__tests__/`: `tarifasAdminP1.test.ts` (1–16) e
`tarifasAdminP1Recalculo.test.ts` (17–32).

| # | Exigência | Teste |
|---|---|---|
| 1 | MANAGER cria e ativa tabela de cliente | `01.` Termo Único: rascunho → validação → ATIVA, auditada, selecionável |
| 2 | MANAGER cria e ativa tabela de armador | `02.` exposição estimada privada; o motor passa a usá-la no lugar da pública |
| 3 | ADMIN tem as mesmas capacidades | `03.` criar, editar, faixas, ativar, nova versão, desativar |
| 4 | ANALYST não altera | `04.` 403 em toda mutação, nada gravado; lê só o operacional |
| 5 | CLIENT sem acesso | `05.` login recusado; sem sessão 401; CLIENT de X que é ANALYST de Y nunca entra em X |
| 6 | outra organização não lê nem altera | `06.` 404 idêntico; `organizationId` do corpo recusado |
| 7 | rascunho editável | `07.` PATCH/PUT auditados com antes/depois |
| 8 | ativa imutável | `08.` API 409; SQL direto barrado pelo banco |
| 9 | nova versão substitui a anterior | `09.` truncamento e substituição integral |
| 10 | histórico acessível | `10.` substituídas legíveis; eventos e transições paginados |
| 11 | moeda original preservada | `11.` gravada e devolvida exatamente; nunca normalizada |
| 12 | moedas nunca somadas | `12.` duas moedas não ativa; grupos separados |
| 13 | faixas sobrepostas bloqueiam | `13.` 422 por faixa; nada gravado |
| 14 | lacuna proibida bloqueia | `14.` entre faixas e antes do dia 1; última faixa aberta |
| 15 | equipamento inválido bloqueia | `15.` inclusive rascunho legado |
| 16 | valor negativo bloqueia | `16.` 422 por faixa; formato idem |
| 17 | vigência conflitante bloqueia | `17.` dentro de outra / só o começo; Termo por Embarque nunca conflita |
| 18 | ativações concorrentes: um vencedor | `18.` 5 rodadas, mesma versão e versões diferentes |
| 19 | idempotência | `19.` replay sem efeito; corpo/autor diferente = 409; mesma chave concorrente = uma linha |
| 20 | simulação não grava | `20.` impressão digital do banco idêntica (parâmetros e processo) |
| 21 | versão temporal correta | `21.` data do processo por contêiner; fronteira de vigência |
| 22 | aberto recalculado | `22.` item correlacionado ao evento; valor novo com a versão ativada |
| 23 | FINAL inalterado | `23.` fora do escopo; versão histórica; sem pendência |
| 24 | reaberto segue a regra formal | `24.` SOLICITADA intocado; AUTORIZADA recalcula; varredura não refecha |
| 25 | falha observável e reexecutável | `25.` esgota, aparece, reprocessar rearma a mesma linha |
| 26 | motivos estáveis | `26.` não cadastrada, rascunho, sem vigente, sem faixa, pendente, desativada, dimensão ausente |
| 27 | cliente nunca alimenta armador | `27.` |
| 28 | armador nunca alimenta cliente | `28.` |
| 29 | valores agrupados por moeda | `29.` BRL/USD no cliente, USD no armador; nunca somados nem convertidos |
| 30 | encerramento prossegue | `30.` armador direto; cliente após a nova decisão exigida pela 0033 |
| 31 | auditoria sem segredo | `31.` autor, papel, motivo, antes/depois, chave, correlação; nenhum cookie/token/segredo |
| 32 | cursores presos | `32.` outra organização, outro filtro ou cursor adulterado = 400 |

### 13.2 Extras

`tarifasAdminP1.test.ts`: contrato HTTP (Idempotency-Key, CSRF, nunca 500);
tabela pública só leitura e origem de versão privada.
`tarifasAdminP1Recalculo.test.ts`: sem volta silenciosa à pública;
exposição de versão legada exige aceite; If-Match na desativação; qualidade
provisória só com aceite; etapa do tick isolada; truncar não reescreve
valores; total fora de NUMERIC(14,2) vira INDISPONÍVEL.

### 13.3 Regressões das revisões de código (`tarifasAdminP1Revisao.test.ts`, 16)

Cada uma reproduz um defeito confirmado. Prova: com a correção revertida
numa cópia de trabalho, todas falham pelo motivo esperado; com a correção,
todas passam.

1. validação com revisão, plano e impacto da mesma fotografia;
2. simulação por `tabelaId` só de Termo por Embarque;
3. simulação acusa moeda mista do legado;
4. equipamento não reconhecido → `EQUIPMENT_NOT_RECOGNIZED`, sem pendência eterna;
5. Termo por Embarque com início desconhecido ativa;
6. datas: ano 0000, calendário impossível em instante, substituição integral no 1º dia representável;
7. faixa nunca troca de versão (SQL direto);
8. desativação conta o processo reaberto (valor FINAL ativo);
9. item com falha não para a etapa (uma tentativa por item por etapa);
10. a etapa avalia o encerramento dos recalculados;
11. orçamento conferido por processo; cursor e contadores; retomada;
12. posse vencida não é "em execução"; quem perdeu a posse para (token por execução);
13. desativação conta a decisão do contêiner sem equipamento cuja seleção é a versão;
14. expansão com falha aparece na etapa e no log do tick;
15. desativação NÃO conta a decisão sem equipamento quando a seleção sem a versão tem a mesma vigência (legado de início desconhecido);
16. desativar logo depois de ativar (recálculo da ativação não consumido) não conta decisão de contêiner com equipamento reconhecido e valor ainda sem tabela.

### 13.4 Revisões adversariais

| Revisão | Escopo | Resultado |
|---|---|---|
| Desenho | 5 revisores + síntese, antes do código | todas as recomendações aplicadas (§2–§12) |
| Código, rodada 1 | 5 revisores (isolamento/autorização, versões/imutabilidade, concorrência/idempotência, temporal/moedas, recálculo/legado) + verificação independente de cada achado | 22 veredictos: 16 confirmados (4 major, 12 minor) — todos corrigidos com teste; 6 refutados |
| Código, rodada 2 | 2 revisores sobre as correções + verificação | 7 achados: 5 confirmados (minor) — corrigidos com teste; 2 refutados |
| Código, rodada 3 | 1 revisor sobre as correções da rodada 2 + verificação | 1 achado confirmado (minor: a contagem de decisões sem equipamento superestimava em legado de início desconhecido ou sobreposto) — corrigido pela regra de seleção, com teste |
| Código, rodada 4 | 1 revisor sobre a correção da rodada 3 + verificação | 2 achados confirmados (minor: contagem a partir da seleção atual superestimava com valor ainda não recalculado de equipamento reconhecido; custo por contêiner) — corrigidos (só equipamento não reconhecido pelo motor; uma seleção leve por data), com teste |
| Código, rodada 5 | 1 revisor sobre a correção da rodada 4 + verificação | nenhum achado — revisão encerrada (seca) |

Refutados (registrados, sem mudança de código): FKs de auditoria
autor↔membership e transição↔evento (só alcançáveis por SQL direto; o único
escritor grava os dois juntos); serviço legado sem chamador de produção;
deadlock do `FOR SHARE` só com escritor legado (abortado como 409); total da
simulação sem duas casas (valor exato); falso alarme de pendência (o item
existe de fato); legado de início desconhecido como conflito (regra
documentada); avaliação de encerramento fora do orçamento de tempo (limitada
por contagem, como a varredura); bloqueio na cabeça da fila de expansões
(limitado ao orçamento; retomado).

### 13.5 Validação em worktree limpo e banco novo

Worktree novo no commit `408aff18e2c19a3ce02e7de773ee602aeef8e512`
(`git status --porcelain` vazio antes e depois; só `dist/` e
`node_modules/` ignorados), PostgreSQL 16 com banco recém-criado, `npm ci`
limpo, passos **sequenciais** (`--test-concurrency=1`, nunca duas suítes de
banco ao mesmo tempo).

| Passo | Suíte | Testes | Passaram | Falharam | Cancelados | Ignorados | Todo |
|---|---|---|---|---|---|---|---|
| 01 | novos tarifários (`tarifasAdminP1`, `tarifasAdminP1Recalculo`, `tarifasAdminP1Revisao`) | 57 | 57 | 0 | 0 | 0 | 0 |
| 02 | tarifários existentes (`tariffs`, `d15c`, `d15cV11`, `d15cV12`, `apuracao`, `apuracaoV12`–`V14`, `gestaoSelecaoFinanceira`, `migrate`, `migration0007`) | 142 | 142 | 0 | 0 | 0 | 0 |
| 03 | minuta/encerramento (+ responsabilidade, lifecycle, estado operacional, claim do scheduler) | 215 | 215 | 0 | 0 | 0 | 0 |
| 04 | autenticação e filas (novos P1 + sessão/token/multi-tenant existentes) | 215 | 215 | 0 | 0 | 0 | 0 |
| 05 | Entrega 1 — handoff + capacidade | 87 | 87 | 0 | 0 | 0 | 0 |
| 06 | Entrega 2 — ações | 70 | 70 | 0 | 0 | 0 | 0 |
| 07 | Entrega 3 — leituras operacionais | 47 | 47 | 0 | 0 | 0 | 0 |
| 08 | D12 read-model (10 arquivos históricos) | **75** | 75 | 0 | 0 | 0 | 0 |
| 09 | notificações (divergência, pendência, fallback, tick) | 273 | 273 | 0 | 0 | 0 | 0 |
| 10 | suíte completa Demurrage Engine (`npm run test:demurrage-engine`) | 1402 | 1402 | 0 | 0 | 0 | 0 |
| 11 | V1 (`npm run test`) | 25 | 25 | 0 | 0 | 0 | 0 |
| 12 | D13 UI (`npm run test:demurrage-ui`) | 66 | 66 | 0 | 0 | 0 | 0 |
| 13 | `tsc --noEmit` | — | saída vazia, exit 0 | | | | |
| 14 | `npm run build` | — | exit 0 | | | | |

D12 congelado, cada arquivo rodado sozinho e conferido contra a contagem
congelada: `demurrageV2Routes` 7, `leituraAutorizacao` 10, `leituraContrato`
8, `leituraD12V12` 18, `leituraDetalhe` 6, `leituraFila` 6,
`leituraFilaV11` 8, `leituraFiltros` 4, `leituraTimeline` 5,
`leituraTimelineV11` 3 — total 75, todos passando, nenhum ignorado.

Os passos 01–09 são recortes; o passo 10 é a suíte inteira (inclui todos
eles). Nenhum teste foi pulado, desativado ou posto em quarentena.


---

## 14. Riscos e limitações registrados

Fora do escopo desta entrega (registrados, nenhum silencioso):

1. **Adoção de nova versão de Termo por Embarque.** A condição comercial
   fixa a versão por ID; `nova-versao` não migra processos. A resposta
   informa `termoEmbarque.processosAbertosFixadosNaBase` e
   `adotadaPorEles: false`. Trocar a versão fixada é mudança de condição
   comercial (fluxo existente), não operação tarifária.
2. **Condição apontando para versão desativada.** Nenhum trigger novo
   impede gravar `tabela_id` de versão desativada em `condicoes_comerciais`;
   o motor devolve UNAVAILABLE `TARIFF_VERSION_DEACTIVATED`, visível na
   situação do processo e bloqueando o encerramento — nunca valor fabricado.
3. **Desfecho por item.** O outbox registra `RECALCULADO` ou
   `IGNORADO_FINAL`; um recálculo que reproduz o mesmo `input_hash` também
   conta como `RECALCULADO` (não há `INALTERADO`).
4. **Reconciliação global.** Não há varredura periódica comparando todo
   valor com a seleção atual. A corrida conhecida (recálculo em voo com a
   tarifa anterior) é fechada pela expansão sob `lockProcesso`; qualquer
   divergência residual aparece como `TARIFF_RECALCULATION_PENDING` na
   leitura (relógio válido), e o próximo fato do contêiner a corrige.
5. **Regra 0033.** Todo valor novo do cliente invalida a decisão
   RELOGIO_CLIENTE (mesmo com a diária idêntica). Ativar a tabela do cliente
   pode exigir muitas re-decisões; a prévia mostra o número e a ativação
   exige confirmá-lo. Mudar a regra 0033 está fora do escopo.
6. **Reabertura de FINAL cuja versão foi desativada.** A autorização
   recalcula com a tabela vigente; sem nenhuma, o lado fica UNAVAILABLE e o
   re-encerramento espera uma tabela ativa (comportamento pretendido).
7. **Datas de referência ausentes.** Sem 1º dia de demurrage do cliente ou
   sem descarga, o motivo é `DATA_REFERENCIA_INDISPONIVEL`; a data do
   servidor nunca substitui a do processo.
8. **Tabelas públicas legadas** (seed) começam na data de verificação:
   processos anteriores a ela continuam `TARIFF_VERSION_NOT_PROVEN` até a
   organização ativar a sua versão privada (comportamento anterior mantido).
9. **Catálogo de armadores** fora da API: armador não cadastrado →
   `armador_inexistente`.
10. **`tariffTableService` legado** (seeds/testes) continua existindo sem
    validação nem auditoria; não tem chamador de produção. Quem o usar por
    script contorna a auditoria — os triggers de imutabilidade (0037/0038/
    0052) continuam valendo.
11. **Volume.** A etapa do tick tem orçamento de 60 s (metade, no máximo,
    para a expansão); uma ativação com muitos processos conclui em vários
    ticks (observável em `GET /eventos/:id/recalculo`), e a etapa avalia o
    encerramento de até 200 processos recalculados por tick (a varredura
    cobre o resto). Nenhuma medição de carga foi feita.
12. **Organização única (MVP).** Locks, cursores, FKs compostas e escopo já
    são por organização, mas o cenário multiorganização não foi validado em
    produção e não foi iniciado.
13. **ANALYST** lê a situação só de processos atribuídos a ele (escopo
    existente de `buscarDetalheProcesso`); nunca lê rascunho.
14. **Linha privada de armador legada.** Se existir (criada fora da API),
    passa a valer para a organização a partir do seu início, sem evento nem
    recálculo dirigido; a checagem pré-implantação (§15.1) deve dar 0.
15. **Contagem de decisões na desativação, contêiner sem equipamento.** Supõe
    o valor em dia com a seleção atual: se a versão for desativada antes de o
    recálculo da própria ativação ser consumido, o número de um contêiner sem
    equipamento pode ser maior que o real (nunca menor). Equipamento
    reconhecido é exato.

---

## 15. Checklist operacional e confirmação de escopo

### 15.1 Implantação

- [ ] Aplicar as migrations até a **0052** antes do código (o boot de
      produção recusa subir sem `tariff_versao_transicoes`). Conferir:
      `SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1`
      → `0052_administracao_tarifaria.sql`.
- [ ] Nenhum dado é migrado; versões já ativadas continuam ATIVAS e
      selecionáveis como antes (§12).
- [ ] **Antes** de publicar o código: `SELECT count(*) FROM tariff_tables
      WHERE tipo = 'armador' AND organization_id IS NOT NULL` deve ser 0.
      Diferente de 0 = linha privada de armador legada, que passaria a valer
      para a organização (§3.3, §12): revisar com o responsável antes de
      implantar.

### 15.2 Cadastro inicial (MANAGER ou ADMIN)

- [ ] Para cada condição Termo Único: tabela `rocket_cliente`/`unico` com
      vigência cobrindo o 1º dia de demurrage dos processos abertos.
- [ ] Para cada condição Termo por Embarque: conferir que a versão fixada
      está ATIVA (`GET /versoes/:id`).
- [ ] Para cada armador usado: versão privada da organização (exposição
      estimada ao armador), criada do zero ou com `nova-versao` a partir da
      pública.
- [ ] Antes de ativar: `GET /versoes/:id/validacao` sem erros; ler
      `efeitos.escopo` (processos/contêineres abertos, decisões que serão
      invalidadas) e enviar exatamente esses números com `revisaoDimensao` e
      `conteudoHash`.

### 15.3 Depois de cada ativação ou desativação

- [ ] `GET /eventos/:eventoId/recalculo` até `concluido: true`.
- [ ] Esgotados: entender a causa (`erroCodigo`) e então
      `POST /eventos/:eventoId/recalculo/reprocessar` (rearma as mesmas
      linhas; auditado). A ativação nunca é desfeita.
- [ ] SQL de conferência: `SELECT count(*) FROM recalculo_outbox WHERE
      tipo = 'tarifa' AND estado = 'FAILED' AND tentativas >= 5` = 0 e
      `SELECT count(*) FROM tariff_recalculo_expansoes WHERE concluida_em IS
      NULL` caindo a 0 em até um tick.
- [ ] Log do tick: segmento `recalculo-tarifario` sem `ERRO=`/`ENCERRAMENTO-ERRO=`
      e com `expansao-falhas=0` (diferente de 0 por vários ticks = processo
      com lock retido; a expansão é retomada sozinha quando ele solta).
- [ ] Processos com decisão RELOGIO_CLIENTE invalidada: nova decisão pelo
      fluxo existente.

### 15.4 Correção e retirada

- [ ] Nunca `UPDATE`/`DELETE` direto em `tariff_tables`, `tariff_brackets`,
      `valores_apurados`, `tariff_admin_eventos` ou
      `tariff_versao_transicoes` (triggers recusam).
- [ ] Corrigir = `nova-versao` → editar o rascunho → ativar (substitui a
      anterior a partir do início da nova).
- [ ] Retirar = `desativar` com o estado e a revisão vistos; se a resposta
      for `desativacao_exporia_versao_anterior`, decidir conscientemente
      (`aceitarVersoesExpostas`) ou ativar uma substituta antes.

### 15.5 Confirmação de escopo

- Frontend, HTML, CSS, JavaScript de apresentação e design: **não
  alterados**. Arquivos tocados: só `src/demurrage-engine/` (backend, testes,
  migration 0052), `src/routes/demurrageTarifasRoutes.ts`, `src/app.ts`
  (montagem da rota e boot check), `src/demurrage/schedulerBootstrap.ts`
  (etapa do tick) e `docs/`. Nenhum arquivo em `public/`,
  `src/frontend-tests/`, `src/browser/` ou com extensão `.html`/`.css`.
- Armazenamento definitivo de minutas, integração produtora da Liberação e
  multiorganização: **não iniciados**.
- Autenticação, filas pessoais, handoff, moedas e encerramento automático:
  **preservados** (suítes do §13).
- Migrations 0001–0051 (inclusive 0049, 0050, 0051): **não alteradas**; só a
  0052, aditiva.
- Entrega **não congelada**; Produção P1 **não** declarada concluída.
