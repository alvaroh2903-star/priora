# Fase D10 — Demurrage vertical

## Objetivo

Comprovar que a Demurrage funciona **integralmente**, do registro de um processo até o
fechamento `FINAL`, sem depender de Auditoria, Courier, Liberação, HeadCargo ou Portal do
Cliente — usando banco real e os motores reais, e entrando **só pelo contrato técnico**
(nunca inserindo `processos`/`containers` diretamente nos testes).

Escopo: exclusivamente `src/demurrage-engine/**` (contrato, serviço de registro, fotografia,
testes) + uma migration aditiva. Nenhum arquivo de Auditoria, Courier, Liberação, telas,
Portal ou rotas V1/Outlook foi alterado.

## Decisão de arquitetura

O contrato técnico (`demurrage.registro.v1`) é a única porta de entrada para registrar um
processo/contêiner na Demurrage nesta fase. Não existe rota HTTP nem tela que o chame — ele
é pensado para ser chamado, no futuro, por uma integração entre módulos (ex.: Auditoria/
pré-alerta), mas essa integração **não** foi construída aqui.

A descarga só entra pela ingestão de tracking do armador já existente (`eventIngestion`).
O contrato **rejeita** qualquer data operacional (ETA, chegada, atracação, Gate Out, descarga
manual) — `CAMPO_NAO_ACEITO` — para impedir que qualquer coisa além do tracking do armador
promova a descarga.

Enquanto não houver descarga, o motor de lifecycle congelado (Fase 7) já produz
`PENDENCIA_DE_DADOS` com o motivo estruturado `DESCARGA_AUSENTE` nos dois relógios — não foi
criado nenhum enum novo. A camada de apresentação (`registro/situacao.ts`) só **traduz** esse
motivo estruturado para `AGUARDANDO_DESCARGA` / "Aguardando descarga", sem alterar o dado
persistido.

## Arquivos novos

| Arquivo | Papel |
|---|---|
| `src/demurrage-engine/db/migrations/0028_demurrage_registro.sql` | Migration **aditiva**: `demurrage_registros` (ledger idempotente), `processo_campos_selecionados`, `container_equipamento_original`, `demurrage_pendencias`, `armador_codigos_tracking` (referência global). |
| `src/demurrage-engine/registro/contrato.ts` | Contrato `demurrage.registro.v1` — tipos, validação pura, normalização de número de processo/contêiner, hash de payload. |
| `src/demurrage-engine/registro/registrarProcessoDemurrage.ts` | Serviço de aplicação: registro idempotente/transacional, preparação automática (equipamento, Free Time, vínculo de tracking), pendências explícitas. |
| `src/demurrage-engine/registro/fotografia.ts` | Fotografia versionada do Capítulo 14 (fatos + derivados), deduplicada por hash. |
| `src/demurrage-engine/registro/situacao.ts` | Leitura apresentável (`AGUARDANDO_DESCARGA` etc.) — só tradução, sem gravar nada. |
| `src/demurrage-engine/__tests__/registroDemurrageHelpers.ts` | Helpers de teste (contrato, número de contêiner ISO 6346, resultado de tracking fictício). |
| `src/demurrage-engine/__tests__/registroDemurrage.test.ts` | Gates 1–3 + integridade (30 testes). |
| `src/demurrage-engine/__tests__/demurrageVertical.test.ts` | Gates 4–6 + integridade adicional (8 testes). |

## Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/persistence/snapshotRepository.ts` | `criarVersaoSeMudouComClient`: cria a próxima versão da fotografia SÓ quando o `hashFatos` muda (dedupe transacional, lock consultivo por contêiner). Não altera `create`/`listForContainer` existentes. |
| `src/demurrage-engine/tracking/eventIngestion.ts` | Depois de recalcular a apuração dos contêineres afetados, chama `atualizarFotografia` para cada um (isolado em try/catch — falha na fotografia nunca reverte a ingestão). Corrige a lacuna apontada no diagnóstico: a tabela `snapshots` existia desde a Fase 1, mas nada a populava. |
| `src/demurrage-engine/__tests__/migrate.test.ts`, `migration0007.test.ts`, `responsavelOperacional.test.ts`, `testDb.ts` | Catálogo de migrations/tabelas com organização e truncagem entre suítes passam a incluir a 0028. |

Nenhum arquivo de Auditoria, Courier, Liberação, telas, Portal do Cliente ou rotas V1/Outlook
foi tocado (comprovado pelo teste de varredura estática do Gate 1 e pelo teste de não-importação
do Gate 3/arquitetura, ambos em `registroDemurrage.test.ts`).

## Evidência por gate

### Gate 1 — Contrato técnico (12 testes, `registroDemurrage.test.ts`)

- Código do processo preserva o sufixo integralmente: `IM3126-26 ≠ IM3126 ≠ IM3126-25`
  (normalização só remove espaço/caixa).
- Versão não suportada, campo desconhecido no topo ou no contêiner, fonte não aceita
  (`tracking_service`/`email_heuristic`), `observadoEm` ilegível, Free Time negativo/fracionário,
  número de contêiner com dígito verificador inválido, contêiner duplicado na mesma entrada,
  condição comercial inválida e `organizationId` ausente/inválido — todos rejeitados com o
  código correto, **sem tocar o banco** (validação pura).
- Nenhuma data operacional (`dischargeDate`, `eta`, `dataChegada`, `dataAtracacao`,
  `gateOutDate`) é aceita pelo contrato.
- Varredura estática: nenhum arquivo em `src/routes`, `src/index.ts` ou `public` referencia
  `registrarProcessoDemurrage` — não há rota nem botão.

### Gate 2 — Registro idempotente e transacional (6 testes)

- Registrar duas vezes a mesma entrada (sem chave explícita) → segunda chamada devolve
  `ja_registrado` com o **mesmo** `processoId`/`containerId`; nenhuma duplicação em
  `processos`, `containers` ou no ledger `demurrage_registros`.
- Duas organizações com o **mesmo** `numeroProcesso` → processos distintos (isolamento).
- Duas chamadas **concorrentes idênticas** (`Promise.all`) → serializadas pelo lock
  consultivo; uma vira `registrado`, a outra `ja_registrado`; só um contêiner persistido.
- Contêiner já pertencente a **outro** processo da mesma organização → `CONTAINER_EM_OUTRO_PROCESSO`
  e **rollback integral** da chamada (nem o processo novo, nem o contêiner sem conflito
  sobrevivem).
- Reutilizar a mesma `chaveIdempotencia` com payload diferente → `CHAVE_IDEMPOTENCIA_REUTILIZADA`.
- Organização inexistente → `ORGANIZACAO_INEXISTENTE` (nada é inventado).

### Gate 3 — Preparação automática e vínculo de tracking (9 testes)

- Tipo original preservado no ledger (`container_equipamento_original`) + normalização por
  identidade quando o código já é conhecido (`40HC`); nenhuma pendência de tipo é aberta.
- Tipo **não reconhecido** → pendência `tipo_nao_reconhecido`, sem inventar classe; tipo
  **ausente** → pendência `tipo_ausente`.
- Sem MBL/armador → processo e contêiner **registrados**; pendências `mbl_ausente`/
  `armador_ausente` explícitas; **nenhum** `tracking_target` criado.
- Armador informado mas não cadastrado → `armador_nao_cadastrado`; armador cadastrado mas sem
  carrier na tabela de referência de tracking → `armador_sem_tracking`.
- MBL + armador com tracking → vínculo automático (`TrackingTargetRepository`), **todos** os
  contêineres do processo linkados ao mesmo target; **zero** linhas em `tracking_fetches`
  (nenhuma consulta real durante o cadastro — o scheduler existente é quem consulta); reprocessar
  reaproveita o **mesmo** target (não duplica).
- House/Master Free Time por processo e com sobreposição por contêiner; ausência de Free Time
  não promove nada.
- Campos do processo (MBL/House/armador/cliente/condição) aplicados pela hierarquia de fontes
  existente, com histórico no ledger `field_observations`; fonte de prioridade menor **não**
  sobrescreve um valor já selecionado por fonte melhor.

### Gate 4 — Estado pré-descarga + fotografia inicial (2 testes, `demurrageVertical.test.ts`)

- Sem descarga: situação `AGUARDANDO_DESCARGA` (motivo `DESCARGA_AUSENTE`); `containers.estado
  = PENDENCIA_DE_DADOS` (**nenhum enum novo**); os dois relógios `PENDING` com a pendência
  `DESCARGA_AUSENTE`; `dias_demurrage` **indisponível** (`null`, nunca ativo); zero linhas em
  `valores_apurados`; zero fotografias (`snapshots`).
- Reprocessar o registro sem descarga mantém `discharge_date` nulo — nenhuma data lateral
  (ETA/chegada/atracação/Gate Out) promove a descarga (a única via aceita nem existe no
  contrato — Gate 1).

### Gate 5 — Cenário vertical A, sem custo (1 teste, fim a fim)

Passos comprovados numa única transação de teste, todos entrando pelo contrato/tracking:
1. registro **antes** da descarga;
2. `Aguardando descarga`;
3. reprocessar a mesma entrada → idempotente (mesmo processo/contêiner, sem duplicar);
4. ingestão de descarga oficial (tracking do armador) — `2026-09-25`;
5. fotografia inicial (versão 1) + os dois relógios `OK` com LFD `2026-10-08` (14 dias de free
   time); reingestão idêntica → **zero** eventos novos, **nenhuma** fotografia nova;
6. Gate Out (`2026-09-30`) → fato relevante, nova versão da fotografia;
7. Empty Return dentro dos dois Free Times (`2026-10-03`);
8. **zero** valores ativos em `valores_apurados`;
9. `finalizarProcesso` com sucesso **sem minuta** (regra congelada: zero confirmado fecha sem
   comprovação);
10. `processos.apuracao_status = FINAL`; reprocessar o contrato sobre o processo `FINAL` →
    `PROCESSO_FINAL` (nada reabre por trás do fechamento).

### Gate 6 — Cenário vertical B, com demurrage + regressão completa (1 teste, fim a fim)

House FT = 3, Master FT = 5, descarga `2026-09-25` (LFD cliente `09-27`, LFD Rocket `09-29`).
1. passagem de calendário (sem novo evento de tracking) até `2026-10-02` → os dois Free Times
   estourados: cliente 5 dias de demurrage, Rocket 3 dias — **valores separados**:
   cliente `termo_embarque` US$1.250 (5 × US$250, tabela Rocket×cliente), Rocket
   `exposicao_armador` US$240 (3 × US$80, tabela de referência normalizada — ver limitação
   abaixo); `total` do cliente ≠ `total` da Rocket;
2. Gate Out (`09-30`) + Empty Return (`10-04`, pelo tracking) → cliente 7 dias, Rocket 5 dias;
3. acúmulo **parado**: uma nova passagem de calendário (`10-10`) nem mais seleciona o contêiner
   (já devolvido) — os dias ficam congelados em 7/5;
4. estado `DEVOLVIDO_AGUARDANDO_TRATAMENTO`;
5. gate congelado de fechamento, na ordem certa: sem responsabilidade decidida →
   `responsabilidade_em_analise`; com responsabilidade decidida (substituto de Fase 11, mesmo
   padrão dos testes já congelados: `UPDATE containers SET responsabilidade = …`) mas sem
   minuta → `comprovacao_pendente`;
6. `registrarMinuta` + `validarMinuta` (serviços já existentes, papel `MANAGER`) → `validada`
   (sem divergência: a data informada bate com o tracking);
7. `finalizarProcesso` → `{ ok: true }`; `apuracao_status = FINAL`; todos os valores ativos
   ficam `ESTIMATED` (nunca `UNAVAILABLE`) antes do fechamento — nenhuma regra de fechamento foi
   afrouxada para o teste passar.

**Regressão completa**: `npm run test:demurrage-engine` — **453/453** testes passando (toda a
suíte pré-existente da engine, intacta), mais os 38 testes novos da Fase D10.

### Integridade adicional (5 testes, `demurrageVertical.test.ts`)

- Descarga por **contêiner** em datas diferentes no mesmo processo (o segundo contêiner não
  herda a descarga do primeiro).
- Alteração retroativa do Master Free Time: as **duas** observações permanecem no ledger
  append-only (`field_observations`), o valor corrente é o mais recente pela hierarquia de
  fontes, e uma **nova versão** da fotografia é criada (fato relevante mudou).
- **Limitação externa real** (ver seção própria abaixo): a tabela literal do Blueprint
  (vocabulário próprio da Maersk, `40DRYHC`) não cobre a classe normalizada `40HC` → exposição
  Rocket `UNAVAILABLE` → bloqueia o `FINAL` com demurrage (`valor_rocket_nao_confirmado`) —
  comprovando que o motor **nunca** inventa valor e a regra de fechamento continua vigente.
- Ausência do HeadCargo não é fabricada nem impede o fechamento sem custo: nenhuma tabela/estado
  de HeadCargo existe no schema, e o zero-custo fecha exatamente como antes.

## Limitações externas reais (não fabricadas)

1. **Vocabulário das tabelas de armador do Blueprint.** `seedArmadorTables` transcreve as
   tabelas do Blueprint com a grafia própria de cada armador (ex.: Maersk usa `40DRYHC`,
   `20_40REEFER`). A classe normalizada que o motor de equipamento produz a partir do
   vocabulário Rocket (Cap. 9) é `40HC`. Sem uma tabela de equivalência entre as duas grafias
   — que não existe nesta fase e não estava no escopo autorizado — a exposição Rocket para
   armadores do Blueprint fica `UNAVAILABLE` quando há demurrage real, e o fechamento `FINAL`
   com custo é bloqueado pela própria regra congelada (`valor_rocket_nao_confirmado`), como
   comprovado no teste de integridade. O Cenário B usa uma tabela de armador **de referência**
   (dados de teste, não uma tarifa real) já na grafia normalizada `40HC` para demonstrar o
   caminho completo até o `FINAL` com custo — isso está documentado no próprio teste e não é
   apresentado como tarifa real de nenhum armador.
2. **HeadCargo.** Continua indisponível nesta fase, como determinado. Nenhuma tabela, estado ou
   valor financeiro do HeadCargo foi criado ou simulado; o fechamento sem custo (Cenário A)
   comprovadamente não depende dele, e o Cenário B fecha usando somente os motores tarifários
   já existentes (Rocket×cliente e exposição Rocket/armador).
3. **Responsabilidade (Fase 11).** Não existe ainda um serviço de decisão de responsabilidade.
   O Cenário B usa o mesmo substituto que os testes já congelados de fechamento usam
   (`UPDATE containers SET responsabilidade = 'CONFIRMADA_CLIENTE'`) — não é uma tela nem uma
   rota nova, só o mesmo atalho de teste já em uso antes da Fase D10.
4. **`IM3126-26`.** É usado apenas como identidade de referência do contrato (para provar que
   o sufixo nunca é removido). Nenhuma validação com o processo real da Blueprint foi feita
   nesta fase — o piloto real fica para quando os documentos/eventos reais estiverem
   disponíveis, como pedido.

## Resultados

| Verificação | Resultado |
|---|---|
| Gates aprovados | **6/6** |
| Testes adicionados | **38** (30 em `registroDemurrage.test.ts` + 8 em `demurrageVertical.test.ts`) |
| Suíte da engine (`npm run test:demurrage-engine`) | **453/453** ✅ (inclui os 38 novos) |
| Suíte V1 (`npm test`) | **25/25** ✅ (intacta) |
| TypeScript (`npx tsc --noEmit`) | ✅ sem erros |
| Build (`npm run build`) | ✅ sem erros |
| Migration | `0028_demurrage_registro.sql` — aditiva; 0001–0027 não tocadas |

## O que NÃO foi feito nesta fase (por restrição explícita)

- Nenhuma migração/alteração em Courier, Liberação ou Auditoria.
- Nenhuma tela, rota pública ou botão de criação manual de processo.
- Nenhuma integração real com HeadCargo.
- Nenhum uso de JSON ou rota V1/Outlook para provar o cenário — tudo passou pelo contrato
  técnico e pelos motores reais, contra o Postgres real.
- Nenhuma inserção direta em `processos`/`containers` nos testes verticais.
- Nenhuma regra congelada (Fases 7, 8, 9; fórmulas temporais; hierarquia de fontes; cadência;
  tarifas; responsabilidade; minuta e fechamento) foi alterada ou afrouxada.
