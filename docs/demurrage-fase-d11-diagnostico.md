# Fase D11 — Responsabilidade Rocket × Cliente: diagnóstico e plano

> **Status:** diagnóstico técnico e plano, para aprovação. Nenhum código, migration
> ou teste foi escrito. A D10 está congelada em `5c733a1` e nada aqui altera suas
> regras.

## 0. O que existe hoje (ponto de partida real)

| Peça | Onde | Estado |
|---|---|---|
| Coluna `containers.responsabilidade` | migration 0016 | `TEXT` nullable com CHECK (`NAO_APLICAVEL`, `EM_ANALISE`, `CONFIRMADA_ROCKET`, `CONFIRMADA_CLIENTE`, `DIVIDIDA`). Nenhum código de produção grava nela; só os testes congelados (Fase 8 e D10) a escrevem com `UPDATE` direto como substituto. |
| Derivação | `lifecycle/responsabilidade.ts` | `derivarResponsabilidade(apuracao, stored)`: `stored` vence; sem `stored`, `DEMURRAGE_CONFIRMADA` → `EM_ANALISE`, caso contrário → `NAO_APLICAVEL`. |
| Consumidores | `lifecycleRepository` (badge `responsabilidadeEmAnalise`), `containerState` (impede `CONCLUIDO_PARA_ROCKET`), `closingService.finalizarProcesso` (`responsabilidade_em_analise` bloqueia o FINAL) | Todos leem só a projeção `containers.responsabilidade`. |
| Papel no fechamento | `ClosingService` | O papel (`MANAGER`/`ADMIN`) chega como **parâmetro do chamador**, sem verificação no banco. |
| Guarda de FINAL | migrations 0017/0018 | Bloqueia `relogios`, `valores_apurados` e alteração material de `effective_return_date`. **Não** bloqueia `containers.responsabilidade`. |
| Reabertura | `reaberturas` + `solicitarReabertura`/`autorizarReabertura` | Fluxo `SOLICITADA → AUTORIZADA → RECALCULADA → REFECHADA`, com `valores_anteriores` preservados. `reaberturas` não tem `organization_id`. |
| Eventos | `closing_events` | O CHECK de `tipo_evento` não tem eventos de responsabilidade. |

**Conclusão:** hoje não existe decisão de responsabilidade, só a coluna de
projeção. A D11 cria a fonte de verdade versionada e passa a alimentar essa
mesma coluna. Assim lifecycle, gate de fechamento e badge continuam funcionando
**sem mudar o código deles**.

---

## 1. Fonte temporal da responsabilidade

**Proposta:** o universo de dias atribuíveis vem da linha **persistida** do
relógio do cliente (`relogios`, `tipo = 'cliente'`). Essa linha é a saída do
motor congelado `freeTimeClock`, gravada pelo orquestrador:

- `primeiro_dia_demurrage`: primeiro dia real de demurrage (descarga + House FT);
- `data_final_apuracao`: data final efetiva usada pela apuração (`effective_return_date`, senão `tracking_return_date`, senão o `hoje` do cálculo);
- `dias_demurrage`: quantos dias são cobráveis;
- `input_hash`: impressão digital dos insumos.

**Lista civil de dias sujeitos à cobrança** = todos os dias de
`primeiro_dia_demurrage` a `data_final_apuracao`, com as duas pontas incluídas.

**Invariante obrigatória:** `tamanho da lista = dias_demurrage`. Se não bater, a
decisão é recusada (`BASE_INCONSISTENTE`).

**Sem duplicar a fórmula do relógio:** a D11 não recalcula Free Time nem
descarga. Ela só expande em dias um intervalo que o motor já produziu, usando
`toOrdinal`/`fromOrdinal` de `temporal/civilDate`. A invariante acima garante que
a expansão é fiel ao motor.

**Pré-condições para existir uma base decidível:**

1. relógio do cliente em `estado = 'OK'` com `dias_demurrage ≥ 1`
   (`INVALID`/`PENDING` → sem apuração determinável);
2. `apuracaoDemurrageStatus = DEMURRAGE_CONFIRMADA`;
3. contêiner **devolvido** (`effective_return_date` ou `tracking_return_date` presente).
   Sem devolução, a data final é o "hoje" móvel e os dias ainda crescem. Decidir
   sobre um intervalo aberto produziria uma decisão que vence sozinha no dia seguinte.

**Ficam fora por construção:** dias de Free Time, dias antes do primeiro dia de
demurrage, dias depois da data final e contêineres sem apuração determinável.

**Base congelada na decisão:** cada decisão grava a base que usou
(`primeiroDia`, `dataFinal`, `diasDemurrage`, `input_hash` do relógio do
cliente). Se o relógio mudar depois (minuta que altera a data efetiva, tracking
corrigido em processo aberto), a decisão fica **desatualizada** e a projeção
volta a `EM_ANALISE` (ver §6).

---

## 2. Modelo da decisão (versionado e auditável)

Três tabelas append-only (trigger `forbid_mutation`, como os ledgers já
existentes) e uma coluna de projeção nova.

### 2.1 `responsabilidade_decisoes` (uma linha por versão)

| Coluna | Regra |
|---|---|
| `id`, `organization_id`, `processo_id`, `container_id` | FKs compostas: `(processo_id, organization_id)` → processos; `(container_id, organization_id)` → containers; `(container_id, processo_id)` → `containers (id, processo_id)` (chave já criada na 0030) |
| `versao` | inteiro ≥ 1, `UNIQUE (container_id, versao)` |
| `status` | `CONFIRMADA_ROCKET` / `CONFIRMADA_CLIENTE` / `DIVIDIDA` |
| `dias_rocket`, `dias_cliente` | inteiros ≥ 0; CHECK de coerência com o status (ver §4) |
| `base` (JSONB) + `base_hash` | `primeiroDia`, `dataFinal`, `diasDemurrage`, `relogioInputHash`, `valorApuradoId`, `tabelaId`, `versaoTabela`, `motor`, `total`, `moeda` |
| `justificativa` | não vazia (CHECK `length(trim()) > 0`) |
| `evidencia_ref` | não vazia (mesma regra do `manual_fallback` da D10) |
| `autor_membership_id` | FK `(autor_membership_id, organization_id)` → `organization_memberships (id, organization_id)` |
| `autor_papel` | retrato do papel no momento da decisão (`MANAGER`/`ADMIN`) |
| `decidido_em` | `now()` |
| `substitui_decisao_id` | FK para a própria tabela, `UNIQUE`. A cadeia é linear: uma versão só pode ser substituída uma vez |
| `motivo_correcao` | obrigatório quando `substitui_decisao_id` está preenchido; nulo na versão 1 |
| `origem` | `gestor_manual` (agora); `sugestao_liberacao_confirmada` (futuro, com `sugestao_id`) |
| `reabertura_id` | preenchido quando a decisão corrige um processo que estava FINAL |

**Decisão vigente** = a versão mais alta do contêiner, que nenhuma outra
substitui (garantido pela cadeia linear e pelo `UNIQUE`).

### 2.2 `responsabilidade_decisao_periodos` (representa o que o gestor declarou)

`decisao_id`, `organization_id`, `lado` (`ROCKET`|`CLIENTE`), `inicio`, `fim`
(DATE, `fim ≥ inicio`, as duas pontas incluídas).

**Intervalos descontínuos** são simplesmente várias linhas do mesmo lado. Por
exemplo, Rocket de 15/09 a 17/09 e Rocket de 22/09 a 23/09.

### 2.3 `responsabilidade_decisao_dias` (fonte de verdade da atribuição, dia a dia)

`decisao_id`, `dia`, `lado`, `indice_faixa`, `valor_dia`, `moeda`, com
**`PRIMARY KEY (decisao_id, dia)`**.

Com a chave primária por dia, o próprio banco torna impossível:

- ter um dia repetido;
- ter um dia atribuído aos dois lados ao mesmo tempo (sobreposição Rocket × cliente).

A cobertura completa é checada em trigger de commit:
`count(dias) = base.diasDemurrage`, e todo dia está dentro de `[primeiroDia, dataFinal]`.

Não é preciso `btree_gist`/`EXCLUDE`. A extensão existe no Postgres local, mas a
tabela de dias dispensa depender dela em produção.

### 2.4 Projeção

- `containers.responsabilidade`: continua sendo a entrada do lifecycle e do gate de fechamento.
- `containers.responsabilidade_decisao_id` (nova, nullable, FK): aponta para a
  decisão que a projeção reflete.

As duas são gravadas na **mesma transação** da decisão.

---

## 3. Autoridade

| Ação | ANALYST | MANAGER | ADMIN | CLIENT |
|---|---|---|---|---|
| Confirmar responsabilidade | ✗ | ✓ | ✓ | ✗ |
| Corrigir / substituir decisão | ✗ | ✓ | ✓ | ✗ |

O papel **não** é recebido como parâmetro, como hoje em `ClosingService`. O
serviço recebe o `autorMembershipId` e o banco valida:

- **Mesma organização:** as FKs compostas com `organization_id` em processo, contêiner e autor.
- **Contêiner ∈ processo:** FK `(container_id, processo_id)`.
- **Autor pertence à organização:** FK `(autor_membership_id, organization_id)`.
- **Papel autorizado:** trigger `BEFORE INSERT` que lê o papel com `FOR SHARE`,
  exige `MANAGER`/`ADMIN` e confere que `autor_papel` bate com o papel real. É o
  mesmo padrão da 0007 para o responsável operacional.
- **Não rebaixar o papel pela metade:** uma troca de papel concorrente fica
  bloqueada pelo `FOR SHARE` enquanto a decisão está sendo gravada.

---

## 4. Validações obrigatórias

A validação acontece em duas camadas: uma **pura** (entrada + base, sem banco) e
uma no **banco** (FKs, CHECKs e triggers). Rejeições em ordem:

| Regra | Onde | Código |
|---|---|---|
| Contêiner sem demurrage confirmada / relógio do cliente não OK / sem devolução | serviço (lê base) | `SEM_DEMURRAGE_DECIDIVEL` |
| Tamanho da lista ≠ `dias_demurrage` | serviço | `BASE_INCONSISTENTE` |
| Período com `inicio > fim` | pura + CHECK | `PERIODO_INVALIDO` |
| Dia fora de `[primeiroDia, dataFinal]` (inclui Free Time e dias após a data final) | pura + trigger | `DIA_FORA_DA_DEMURRAGE` |
| Dias duplicados no mesmo lado | pura + PK | `DIA_DUPLICADO` |
| Sobreposição Rocket × cliente | pura + PK | `SOBREPOSICAO` |
| Lacuna (dia da base sem lado) | pura + trigger de cobertura | `LACUNA` |
| `CONFIRMADA_ROCKET` sem nenhum dia Rocket | pura + CHECK (`dias_rocket ≥ 1`) | `STATUS_INCOERENTE` |
| `CONFIRMADA_ROCKET` com dia cliente | pura + CHECK (`dias_cliente = 0`) | `STATUS_INCOERENTE` |
| `CONFIRMADA_CLIENTE` com dia Rocket | pura + CHECK (`dias_rocket = 0`) | `STATUS_INCOERENTE` |
| `DIVIDIDA` sem dias dos dois lados | pura + CHECK (os dois ≥ 1) | `STATUS_INCOERENTE` |
| Justificativa ou evidência vazia | pura + CHECK | `JUSTIFICATIVA_AUSENTE` / `EVIDENCIA_AUSENTE` |
| Processo `FINAL` sem reabertura autorizada | serviço + trigger `BEFORE INSERT` | `EXIGE_REABERTURA` |
| Autor sem permissão / de outra organização | trigger + FK | `AUTOR_NAO_AUTORIZADO` |
| Associação cruzada entre organizações | FKs compostas | violação de FK |
| Correção que não aponta para a vigente atual (concorrência) | serviço (lock no contêiner) + `UNIQUE (substitui_decisao_id)` | `VERSAO_DESATUALIZADA` |

**Divisão sempre completa.** Toda decisão cobre 100% dos dias da base. Não
existe decisão parcial: enquanto o gestor não souber atribuir algum dia, o
contêiner permanece `EM_ANALISE`.

**O status é derivado dos dias e conferido contra o declarado:**

- só Rocket → `CONFIRMADA_ROCKET`;
- só cliente → `CONFIRMADA_CLIENTE`;
- os dois lados → `DIVIDIDA`.

Uma divergência entre o declarado e o derivado é erro, nunca é corrigida em silêncio.

**Exemplo obrigatório:** base de 15/09 a 20/09 (6 dias). Rocket = [15/09–17/09];
cliente = [18/09–20/09]. O status derivado é `DIVIDIDA`, com 3 dias Rocket e
3 dias cliente.

---

## 5. Valores financeiros por dia

**Tabela usada:** a do **cliente**. A atribuição reparte o valor do relógio do
cliente; a exposição Rocket × armador (relógio Master) não é tocada.

**Motor:** o do `valores_apurados` ativo do cliente (`termo_embarque` ou
`termo_unico`), com a `tabela_id`/`versao_tabela` já gravadas. No Termo Único, a
tabela foi escolhida pelo primeiro dia de demurrage e **não** é reescolhida.

**Diária de cada dia sem duplicar fórmula nem reiniciar a tabela.** Cada dia é
valorado pela **diferença de prefixos** do próprio motor congelado:

```
diária(dia k) = motor(dias = k).total − motor(dias = k − 1).total
faixa(dia k)  = última faixa em motor(dias = k).faixasAplicadas
```

- **Termo Único:** o motor é `posicionarFaixas` (bracketEngine) com o mesmo Free
  Time e a mesma `dayCountBasis`. O dia k usa exatamente a faixa da sua posição
  cronológica. Tirar dias anteriores do lado Rocket nunca reinicia a tabela do
  lado cliente, porque o índice é sempre a posição na base completa.
- **Termo por Embarque:** o motor é `calcularTermoPorEmbarque`. A diária é constante.
- Os motores trabalham em centavos inteiros, então as diferenças são exatas.
- `bracketEngine.ts`, `termoUnicoEngine.ts` e `termoPorEmbarqueEngine.ts` ficam
  **intactos**.

**Invariantes testadas:**

- soma das diárias Rocket + soma das diárias cliente = `total` do valor ativo, ao centavo;
- `motor(dias = diasDemurrage)` recalculado = `total` gravado. Se não bater (tabela
  ou equipamento mudaram), a atribuição financeira fica indisponível, mas a decisão
  de dias continua válida.

**Componentes reutilizáveis:**

- `posicionarFaixas`, `calcularTermoUnico`, `calcularTermoPorEmbarque`;
- `TariffTableRepository.buscarPorId`, que devolve as faixas da versão fixada;
- `valores_apurados`: `tabela_id`, `versao_tabela`, `day_count_basis_aplicada`, `dias_cobrados`, `total`, `moeda`, `confirmation_status`;
- `relogios`: `primeiro_dia_demurrage` e `data_final_apuracao`;
- `ValorApuradoRepository.ativosDoContainer`.

**Dados que faltam hoje:**

| Falta | Consequência | Solução |
|---|---|---|
| `valores_apurados` não grava o Free Time nem o equipamento usados | não dá para recalcular o motor fielmente só a partir do valor | derivar o Free Time da base (`primeiroDia − descarga`) e o equipamento de `container_type_id`; conferir o total contra o gravado |
| Valor `UNAVAILABLE` (tabela ou equipamento ausentes) | não há diária | a decisão de dias é aceita; a atribuição financeira fica `UNAVAILABLE`, nunca zero |
| Divisão dos dias do relógio Master (exposição Rocket × armador) | não pedida | fora de escopo; sinalizado na questão Q2 |

---

## 6. Efeito no ciclo existente

| Efeito | Mecanismo | Código congelado tocado |
|---|---|---|
| `EM_ANALISE` → decisão confirmada | serviço grava a projeção `containers.responsabilidade` + `responsabilidade_decisao_id`; `derivarResponsabilidade` já faz `stored` vencer | nenhum |
| Badge / lifecycle | o serviço dispara `recalcularApuracaoContainer` depois do commit. Relógios e valores são idempotentes por `input_hash`; o lifecycle é re-derivado e o badge `responsabilidadeEmAnalise` some | nenhum |
| Estado do contêiner | continua `DEVOLVIDO_AGUARDANDO_TRATAMENTO` até o FINAL: a regra v4.1 da Fase 7 só conclui com zero confirmado | nenhum (ver Q3) |
| Fotografia | precisa de campo novo `fatos.responsabilidade` (`status`, `versao`, `decisaoId`) em `registro/fotografia.ts`; o hash muda e nasce nova versão | **alteração aditiva em arquivo da D10** (ver Q4) |
| Gate de fechamento | `finalizarProcesso` deixa de ver `EM_ANALISE`; os demais gates (minuta validada, valores confirmados) continuam iguais | nenhum |
| Minuta / apuração / relógios / Free Time / tracking / totais | só são lidos | nenhum |
| **Decisão que ficou desatualizada** | trigger `AFTER UPDATE` em `relogios` (tipo cliente): se `primeiro_dia`, `data_final` ou `dias` divergirem da base da decisão vigente, a projeção volta a `NULL`, a derivação volta a `EM_ANALISE` e o FINAL fica bloqueado de novo. A decisão continua no histórico, só deixa de valer | nenhum TS; trigger aditivo |
| Correção em processo FINAL | mesmo padrão da minuta: o serviço devolve `EXIGE_REABERTURA`. O gestor usa `solicitarReabertura`/`autorizarReabertura` (existentes); com o processo OPEN, grava a correção com `reabertura_id`; depois `finalizarProcesso` gera o REFECHAMENTO | nenhum |
| Escrita direta na projeção | trigger `BEFORE UPDATE` em `containers.responsabilidade`: quando **existe** decisão vigente, a projeção tem de ser igual ao status dela, e também fica bloqueada em processo FINAL. Sem decisão, o comportamento legado é mantido, para que os testes congelados (Fase 8/D10) continuem válidos | nenhum (ver Q5) |

---

## 7. Porta futura para a Liberação (sem implementar o módulo)

```ts
interface LinhaDoTempoLiberacao {
  containerId: string;
  versaoFatos: string;          // versão/hash dos fatos da Liberação
  geradaEm: string;
  periodosDependenciaExclusivaRocket: Array<{ inicio: CivilDate; fim: CivilDate; referencia: string }>;
}
interface LiberacaoTimelinePort {
  obterLinhaDoTempo(organizationId: string, containerId: string): Promise<LinhaDoTempoLiberacao | null>;
}
```

- `sugerirResponsabilidade(baseDias, linhaDoTempo)` é **pura**: interseção dos
  dias de demurrage com os períodos de dependência exclusiva da Rocket; o que
  sobra é cliente; o status é sugerido pela mesma derivação do §4.
- Tabela `responsabilidade_sugestoes` (append-only): `container_id`, `base_hash`,
  `versao_fatos_liberacao`, os períodos sugeridos e o status sugerido. É uma
  tabela separada da decisão.
- Confirmar uma sugestão = decisão nova de `MANAGER`/`ADMIN` com
  `origem = 'sugestao_liberacao_confirmada'` e `sugestao_id`. A sugestão nunca
  grava na projeção.
- **Nesta fase não existe adaptador:** a porta padrão devolve `null` e nenhuma
  sugestão é produzida. Nenhuma data de liberação é fabricada. Os testes do G7
  usam uma porta fake **declarada como fixture de teste**.

---

## 8. Plano por gates

A numeração das migrations continua de 0031. Todos os caminhos abaixo estão em
`src/demurrage-engine/` salvo indicação.

### G1 — Modelo versionado e integridade
- **Arquivos:** `db/migrations/0031_responsabilidade_decisoes.sql`, `responsabilidade/tipos.ts`, catálogos de teste (`migrate`, `migration0007`, `responsavelOperacional`, `testDb`).
- **Migration:** 0031 — as três tabelas do §2; `containers.responsabilidade_decisao_id`; FKs compostas; CHECKs de coerência status × dias; append-only; `organization_id_immutable`.
- **Testes:** catálogo de migrations; UPDATE/DELETE recusados; FK cruzada entre organizações recusada; contêiner de outro processo recusado; `UNIQUE (container_id, versao)` e `UNIQUE (substitui_decisao_id)`; PK por dia recusa duplicata e sobreposição.
- **Riscos:** FK composta exige `containers_id_processo_unique` (já existe na 0030).
- **Congelado:** D10 inteira, Fases 7–9, 0001–0030.
- **Aprovação:** banco novo 0001→0031 limpo; todas as violações estruturais barradas pelo **banco** sem passar pelo serviço.

### G2 — Serviço de decisão e autorização
- **Arquivos:** `responsabilidade/decidirResponsabilidade.ts` (serviço interno, sem rota); trigger de papel na 0031, ou 0032 se separado.
- **Migration:** trigger `BEFORE INSERT` de papel/organização (pode ir na 0031).
- **Testes:** MANAGER e ADMIN aceitos; ANALYST e CLIENT recusados; membership de outra organização recusado; papel lido do banco (um parâmetro forjado não adianta); transação única (decisão + dias + projeção) com rollback integral; duas decisões concorrentes no mesmo contêiner → uma vence, a outra recebe `VERSAO_DESATUALIZADA`.
- **Riscos:** serializar por contêiner (advisory lock + `FOR UPDATE` no contêiner).
- **Congelado:** `closingService` (inclusive o papel-parâmetro existente).
- **Aprovação:** nenhuma decisão gravada sem papel autorizado verificado no banco.

### G3 — Validação dos dias e intervalos
- **Arquivos:** `responsabilidade/baseTemporal.ts` (lê o relógio persistido e expande a lista), `responsabilidade/validarDecisao.ts` (pura).
- **Migration:** trigger de cobertura e de intervalo (0031).
- **Testes:** o exemplo obrigatório (15–17 Rocket / 18–20 cliente → `DIVIDIDA`); intervalos descontínuos; todas as rejeições do §4, uma a uma; contêiner sem devolução ou com relógio PENDING/INVALID recusado; invariante lista = `dias_demurrage`.
- **Riscos:** fuso: só datas civis (`civilDate`), nunca `Date` com hora.
- **Congelado:** `freeTimeClock`, `dualClockCalculator`, `relogios`.
- **Aprovação:** 100% das rejeições com teste negativo individual; a base vem só de `relogios`, sem nenhuma fórmula de Free Time na D11.

### G4 — Atribuição financeira diária por faixa
- **Arquivos:** `responsabilidade/valorarDias.ts` (diferença de prefixos sobre os motores).
- **Migration:** nenhuma além da 0031 (`valor_dia`, `indice_faixa`, `moeda` na tabela de dias).
- **Testes:** dia Rocket na 3ª faixa usa a diária da 3ª faixa; tirar dias iniciais não reinicia a tabela; `since_discharge_absolute` e `excess_over_free_time`; Termo por Embarque constante; soma dos lados = total ao centavo; valor `UNAVAILABLE` → atribuição `UNAVAILABLE`; total recalculado ≠ gravado → indisponível.
- **Riscos:** custo O(n²) no número de dias (n pequeno, na casa de dezenas); tabela de versão fixada precisa continuar legível.
- **Congelado:** `bracketEngine`, os três motores, `tariff_tables`, `valores_apurados`.
- **Aprovação:** invariante da soma verificada em todos os cenários; nenhum arquivo de tarifa alterado.

### G5 — Lifecycle, fotografia e fechamento
- **Arquivos:** serviço (recálculo depois do commit); `registro/fotografia.ts` (**só com aprovação da Q4**); trigger de desatualização e de guarda da projeção (0032).
- **Migration:** 0032 — trigger `AFTER UPDATE` em `relogios` (desatualização) e `BEFORE UPDATE` em `containers.responsabilidade` (coerência com a vigente e bloqueio em FINAL).
- **Testes:** `EM_ANALISE` → confirmada; badge some; FINAL passa a ser liberado (com minuta validada e valores confirmados, como hoje); nova versão de fotografia; minuta, relógios, valores e totais byte a byte iguais; data efetiva alterada depois da decisão → volta a `EM_ANALISE`; escrita direta incoerente recusada; todos os testes congelados (Fase 8 e D10) seguem verdes sem alteração.
- **Riscos:** o trigger em `relogios` roda dentro do pipeline congelado. Precisa ser barato e não pode lançar erro, só limpar a projeção.
- **Congelado:** `lifecycleRepository`, `containerState`, `responsabilidade.ts`, `closingService`, `recalcularApuracao`.
- **Aprovação:** regressão completa sem alterar nenhum teste congelado.

### G6 — Correção, reabertura e regressão
- **Arquivos:** serviço (`corrigirResponsabilidade`).
- **Migration:** nenhuma nova (`reabertura_id` já na 0031). Opcional: novos `tipo_evento` em `closing_events` (Q6).
- **Testes:** correção em processo OPEN gera a v2 com `substitui` e `motivo`; correção em processo FINAL → `EXIGE_REABERTURA`; depois de `autorizarReabertura` → correção aceita → REFECHAMENTO; correção sem motivo recusada; correção de versão antiga recusada; histórico completo e consultável; engine completa, V1, `tsc`, build.
- **Riscos:** `reaberturas` não tem `organization_id`; o vínculo passa pelo processo.
- **Congelado:** fluxo de reabertura existente (só é reutilizado).
- **Aprovação:** nenhuma decisão muda um processo FINAL sem reabertura autorizada; regressão total verde com PostgreSQL real.

### G7 — Porta da Liberação (sem implementação externa)
- **Arquivos:** `responsabilidade/liberacaoPort.ts` (interface + adaptador nulo), `responsabilidade/sugerirResponsabilidade.ts` (pura).
- **Migration:** 0033 — `responsabilidade_sugestoes` (append-only) + `sugestao_id` na decisão.
- **Testes:** interseção com períodos descontínuos e parciais; sugestão nunca altera a projeção; confirmação exige MANAGER/ADMIN e registra `sugestao_id` + `versao_fatos`; porta nula → nenhuma sugestão; varredura estática sem import de módulo Liberação, IA ou e-mail.
- **Riscos:** a forma da linha do tempo real pode divergir. A porta é versionada para absorver isso.
- **Congelado:** tudo acima; nenhum módulo Liberação é criado.
- **Aprovação:** nenhum dado fabricado fora de fixtures de teste declaradas; sugestão e decisão fisicamente separadas.

---

## 9. Questões que precisam da sua decisão antes do código

| # | Questão | Recomendação |
|---|---|---|
| **Q1** | Demurrage só no relógio **Rocket** (House FT > Master FT): `DEMURRAGE_CONFIRMADA`, mas o cliente tem 0 dias. A base atribuível fica vazia, e a regra "Rocket precisa de ≥ 1 dia" impede qualquer decisão. O FINAL fica bloqueado para sempre. | Permitir `CONFIRMADA_ROCKET` com base vazia **só** nesse caso (sem dias cliente para dividir; o custo é a exposição da própria Rocket), com justificativa e evidência obrigatórias. Precisa de aprovação por excepcionar uma validação. |
| **Q2** | A divisão vale para o valor **do cliente** (House). A exposição Rocket × armador (Master) não entra. | Confirmar que a D11 não reparte a exposição Master. |
| **Q3** | Depois da decisão, o contêiner continua `DEVOLVIDO_AGUARDANDO_TRATAMENTO` até o FINAL (regra v4.1 da Fase 7). | Manter a regra congelada. O "tratamento" termina no FINAL. |
| **Q4** | A fotografia (D10, congelada) precisa do campo `responsabilidade` para cumprir o §6. | Autorizar essa alteração **aditiva** em `registro/fotografia.ts` (novo campo em `fatos`, que gera nova versão); o resto da D10 fica intacto. |
| **Q5** | Testes congelados (Fase 8 e D10 vertical) gravam `containers.responsabilidade` com `UPDATE` direto. | Manter a escrita legada permitida quando o contêiner **não** tem decisão, para não tocar nesses testes. |
| **Q6** | Eventos de responsabilidade na timeline de fechamento. | Opcional: acrescentar `RESPONSABILIDADE_CONFIRMADA`/`RESPONSABILIDADE_CORRIGIDA` ao CHECK de `closing_events` (aditivo). A própria tabela de decisões já é a trilha de auditoria completa. |
| **Q7** | Decisão antes da devolução (intervalo ainda aberto). | Não permitir: só decidir com data final determinável. |

## 10. Fora de escopo, confirmado

Tela, rota pública, módulo Liberação, IA e inferência por e-mail, Portal, HeadCargo,
Auditoria, Courier, cadência, tracking, Free Time, tarifas, minuta e fechamento
(além da integração pela projeção). Nada da D10 muda, exceto o campo aditivo da
fotografia, se a Q4 for aprovada.
