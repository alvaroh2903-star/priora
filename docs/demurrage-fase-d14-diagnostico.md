# Fase D14 — Gestão e Indicadores: diagnóstico e plano de implementação (NÃO aprovado, NÃO implementado)

> **Status:** diagnóstico apenas. Nenhum código foi alterado. D10, D11 e D12
> v1.2.3 (`f7ba55b`) permanecem congelados. D13 (`fe37daf`) é um protótipo
> técnico de frontend — prova que os contratos V2 alimentam uma interface,
> mas seu desenho visual foi rejeitado; **não** é referência visual para a
> D14 nem para o frontend definitivo, que será redesenhado depois de o
> comportamento de backend estar completo. A D14 aqui descrita é
> **backend-first e independente de UI**. Fonte: `Blueprint Demurrage
> Priora V1 Revisado V2` (capítulos 1–32), cruzado com o schema e o código
> realmente existentes em `src/demurrage-engine/**` nesta base.

---

## 1. Propósito e limites

A D14 constrói a camada de **Gestão e Indicadores** do Cap. 30 do
Blueprint: visão operacional, visão financeira (somente leitura),
responsabilidade da Rocket, eficiência operacional, qualidade de dados e
tracking, e separação por moeda — tudo sobre os fatos já persistidos pelas
fases D10 (registro/observações), D11 (responsabilidade) e D12 v1.2.3
(leitura operacional). **Nenhum dado novo de negócio é inventado nesta
fase**: todo indicador deriva de fato já gravado por uma fase anterior, ou
é explicitamente adiado por falta de fonte.

Limites explícitos desta fase:

- **Backend only.** Contratos de leitura (`GET`) e, se aprovado, um
  materializador de histórico. Nenhuma tela é desenhada ou implementada
  aqui.
- **Sem escrita de negócio nova.** Nenhuma correção, confirmação de
  responsabilidade, fechamento ou tracking manual é criada ou alterada
  por esta fase — esses fluxos já existem (D10/D11) e continuam intocados.
- **Sem integração financeira nova.** HeadCargo (faturamento, recebimento,
  saldo) continua sem integração nesta base de código (confirmado por
  busca: zero referências). Os três indicadores do Cap. 30.2 que dependem
  dele ficam como "Status financeiro não disponível" (mesmo texto fixo já
  usado pelo Cap. 27.3/D13), nunca um valor fabricado.
- **Sem alteração de D10/D11/D12/D13**, rotas V1, Portal, Supabase,
  HeadCargo, Auditoria, Courier, Release, cadência de tracking, motores
  tarifários, relógios, responsabilidade ou fechamento.

---

## 2. Matriz de rastreabilidade com o Blueprint

| Indicador/área | Capítulo | Fato(s) de origem persistido(s) |
|---|---|---|
| Visão operacional (contagens por estado/balde) | 30.1 | `containers.estado`, `containers.prioridade_balde`, `processos.estado_mais_relevante`, `processos.prioridade_balde` (0015) — ou re-derivação em lote congelada (Cap. 21/22) |
| Separação por cliente/armador/responsável/tipo/período | 30.1 | `processos.cliente_id/armador_id/responsavel_operacional_id` (0003); `containers.container_type_id` (0004); `containers.discharge_date`, `effective_return_date` (0004); `processos.fechado_em` (0016) |
| Valor bruto do cliente / exposição Rocket (estimada/confirmada) | 30.2, 24, 25 | `valores_apurados` (0009): `relogio_tipo`, `confirmation_status`, `total`, `moeda`, `calculation_status` |
| Valor efetivamente atribuído ao cliente / à Rocket | 30.2, 26 | `responsabilidade_decisoes.valor_cliente/valor_rocket/valor_status` (0031) |
| Diferença potencial interna | 30.2, 11, 24.3, 25 | `valores_apurados` ativo de cliente × Rocket do mesmo contêiner, mesma moeda (ver §7) |
| Faturado / recebido / saldo | 30.2, 27.2 | **Sem fonte nesta base** — HeadCargo não integrado. Adiado. |
| Responsabilidade da Rocket (sugerida/confirmada/diárias/valor) | 30.3, 26 | `responsabilidade_decisoes` + `responsabilidade_decisao_dias/_periodos` (0031); sugestão pura (`sugerirResponsabilidade`, não persistida) depende de dados da Liberação, que não existe nesta base (gap pré-existente, confirmado pelo diagnóstico do gap-analysis) |
| % devolvido dentro do House/Master FT | 30.4 | `containers.discharge_date`, `effective_return_date`, `house_free_time_days`, `master_free_time_days` (0004) |
| Média de dias descarga→Empty Return | 30.4 | `containers.discharge_date`, `tracking_return_date`/`effective_return_date` |
| Média de dias de demurrage por contêiner | 30.4 | `relogios.dias_demurrage` (cache atual) OU `valores_apurados.dias_cobrados` FINAL (histórico reconstruível) |
| Tempo médio Empty Return → conclusão operacional | 30.4 | `containers.effective_return_date` → `closing_events` tipo `FECHAMENTO_FINAL`/`processos.fechado_em` (0016) |
| Tempo médio de resolução de pendências | 30.4 | `demurrage_pendencias.criado_em/resolvido_em` (0028) |
| Processos concluídos com/sem custo | 30.4 | `processos.apuracao_status='FINAL'` + `valores_apurados` ativo do processo (algum >0 ou todos NAO_APLICAVEL/0) |
| Consultas de tracking / cache / taxa de sucesso por armador | 30.5 | `tracking_fetches` (0011): `cached`, `status`, `carrier`, join por `container_tracking_targets` |
| Conectores com 3+ falhas consecutivas | 30.5, 18 | `tracking_incidents` (0013, **GLOBAL**, ver §4) |
| House/Master FT por fonte automática × MANUAL_FALLBACK | 30.5, 4, 10 | `field_observations.fonte`/`manual_fallback` (0004/D10 v1.1-v1.2) |
| Tipos de contêiner não reconhecidos | 30.5, 9 | `demurrage_pendencias.tipo IN ('tipo_ausente','tipo_nao_reconhecido')` (0028) |
| Tabelas/faixas indisponíveis | 30.5, 8 | `valores_apurados.confirmation_status='UNAVAILABLE'` |
| Tracking suspenso após 30 dias | 30.5, 16 | política de cadência (`src/demurrage-engine/scheduler`) — confirmar se o estado "suspenso" é persistido (ver §4) |
| Separação por moeda, sem soma USD/BRL | 30.6 | `valores_apurados.moeda`, `tariff_brackets.moeda` — já é a regra em vigor em `agregarLado`/`moedaExata.ts` (D12 v1.2.1) |
| Composição aberta de todo indicador | 30.7 | drill-down = os mesmos filtros/paginação da D12, aplicados ao conjunto que compõe o número |

---

## 3. Fatos autoritativos já existentes (reaproveitáveis sem migration)

Inventariado em `src/demurrage-engine/db/migrations/0001`–`0034`:

- **`valores_apurados`** (0009) — memória de cálculo append-only por
  contêiner/relógio/motor comercial: `confirmation_status`,
  `calculation_status` (`OPEN`→`FINAL`→`SUPERSEDED` via `supersedes_id`),
  `total NUMERIC(14,2)`, `moeda`, `dias_cobrados`, `calculated_at`,
  `input_hash`. Nenhum `UPDATE` de memória de cálculo — só a transição de
  `calculation_status` e a confirmação de custo real. **Única linha ATIVA
  por `(container_id, relogio_tipo, motor_comercial)`** garantida por
  índice único parcial.
- **`responsabilidade_decisoes`** (0031) + `_dias`/`_periodos` — decisão
  versionada (`versao`, `substitui_decisao_id`, `motivo_correcao`
  obrigatório a partir da v2), autor restrito a `MANAGER`/`ADMIN`,
  `valor_rocket`/`valor_cliente`/`valor_status` coerentes por `CHECK` e
  por trigger de agregado (0034) que garante que os dias gravados batem
  com o relógio-base.
- **`closing_events`** (0016) — timeline append-only de todo o ciclo de
  fechamento (`EMPTY_RETURN`, `MINUTA_VALIDADA`, `FECHAMENTO_FINAL`,
  `REABERTURA*`, `RECALCULO`), com `origem` automático/humano.
- **`reaberturas`** (0016) — preserva `valores_anteriores` (JSONB,
  snapshot não sobrescrito) a cada reabertura.
- **`snapshots`** (0004, D10) — fotografia versionada por contêiner,
  `forbid_mutation` (append-only).
- **`demurrage_registros`** (0028, D10 v1.2) — log de ingestão
  idempotente (`chave_idempotencia` única por organização),
  `forbid_mutation`.
- **`demurrage_pendencias`** (0028) — pendência aberta/resolvida com
  `criado_em`/`resolvido_em` preservados (não apaga ao resolver).
- **`tracking_fetches`** (0011, append-only) — toda consulta de tracking,
  com `cached`/`status`/`carrier`/`finalizado_em`.
- **`tracking_incidents`** (0013) — incidente técnico por
  `tracking_target_id`, mas **GLOBAL** (sem `organization_id` direto —
  ver risco no §4).
- **`containers.estado`/`prioridade_balde`** e
  **`processos.estado_mais_relevante`/`prioridade_balde`** (0015) — cache
  regenerável (não fonte de verdade), mas já é o mesmo projeção usada pela
  fila D12 e consistente com ela.
- **`field_observations`** (0004) — toda observação de campo com fonte e
  timestamp (base do Cap. 4/10).
- **`processo_campos_selecionados`** (0028) — qual fonte venceu, por
  campo, por processo.

**Já existe código de agregação financeira exata e reutilizável:**
`agregarFinanceiroProcesso`/`agregarLado`
(`src/demurrage-engine/leitura/contrato.ts:449`) soma por moeda em
**centavos `bigint`** via `moedaExata.ts` (`centavosExatos`,
`somarCentavosExatos`, `formatarCentavos`), nunca `Number`/`+`. Hoje opera
só no nível de UM processo (array de envelopes de seus contêineres). A
D14 deve **generalizar esta mesma função** (extrair `agregarLado` para
aceitar qualquer lista de envelopes) em vez de duplicar a lógica de soma
exata para o nível de organização.

---

## 4. Lacunas de dados atuais

1. **`tracking_incidents` e `tracking_fetches` são GLOBAIS por
   `tracking_target_id`**, não por organização — um mesmo MBL
   compartilhado entre organizações (vessel sharing, F9v1.1) pode ter um
   único incidente/fetch relevante para mais de uma organização
   simultaneamente. O padrão de join já usado em
   `filaOperacional.ts:buscarAgregadosPorProcesso` (join
   `tracking_incidents`/`tracking_fetches` → `container_tracking_targets`
   → `containers.processo_id/organization_id`) resolve o escopo por
   organização corretamente — **a D14 deve reusar exatamente este
   padrão**, nunca contar incidentes/fetches no nível do `tracking_target`
   compartilhado diretamente (dobraria a contagem entre organizações que
   compartilham o mesmo MBL).
2. **"Consultas evitadas" (30.5) não tem fonte persistida identificada.**
   A política de cadência (`src/demurrage-engine/scheduler/cadencia.ts` e
   afins) decide quando NÃO consultar, mas não encontrei uma tabela que
   registre essa decisão como evento (só o que FOI consultado, em
   `tracking_fetches`). **Requer confirmação de código antes da
   implementação** — se não existir, o indicador é adiado ou
   redefinido como "consultas previstas pela cadência menos consultas
   realizadas" (uma estimativa, não uma contagem direta — precisa decisão
   do usuário se essa aproximação é aceitável).
3. **"Tracking automático suspenso após 30 dias" (30.5) — persistência não
   confirmada.** Não localizei uma coluna/flag "suspenso" em
   `tracking_targets`/`container_tracking_targets`. Se a suspensão for só
   um efeito да política de cadência calculado em tempo de execução (sem
   persistir), o indicador precisa ser recomputado por filtro
   (`dias_demurrage > 30` sobre o relógio aplicável), não lido de uma
   coluna de estado. **Decisão a confirmar em G1** (grep dedicado antes de
   escrever a query).
4. **"Possível responsabilidade sugerida" (30.3) não é persistida.**
   `sugerirResponsabilidade` (`liberacaoPort.ts`) é uma função pura que
   depende de dados da timeline do módulo Liberação — e o Liberação não
   tem backend nesta base (confirmado: só existe `Liberacao.dc.html`
   estático, sem rota). **Este indicador fica fora do escopo da D14**,
   coerente com o gap já registrado desde o diagnóstico original do
   Blueprint; só "responsabilidade confirmada" (persistida em
   `responsabilidade_decisoes`) é implementável agora.
5. **Nenhuma tabela agrega valores no nível de ORGANIZAÇÃO.** Toda
   agregação financeira hoje para no nível do processo
   (`agregarFinanceiroProcesso`). Somar por organização exige nova
   consulta (não nova tabela de fonte — ver §6/§14).
6. **`processos_prioridade_balde_idx` (0015) não é composto com
   `organization_id`.** Toda consulta real desta coluna já filtra por
   organização primeiro (nenhuma tabela de fila/estado é "global"), mas o
   índice atual não ajuda o planner a combinar os dois filtros — ver
   risco de performance no §14.
7. **Nenhum histórico ponto-no-tempo da fila/contagens existe.** `relogios`
   e as colunas de 0015 são cache regenerável (podem ser recalculadas a
   qualquer momento, mutáveis) — não servem para responder "quantos
   processos estavam em demurrage crítico em 1º de setembro". Ver §9.

---

## 5. Catálogo completo de indicadores

Convenção de ID: `G-<grupo><número>`. Todos herdam: organização **apenas
do membership autenticado**; CLIENT nunca acessa; moedas nunca somadas
entre si; pendente/indisponível nunca viram zero (aparecem como contagem
própria ao lado do total, nunca dentro dele).

### Grupo A — Visão operacional (Cap. 30.1)

| ID | Nome (PT) | Grão | Regra de seleção | Fonte | Natureza |
|---|---|---|---|---|---|
| G-A1 | Contêineres em monitoramento | contêiner | `estado IS NOT NULL` (qualquer estado derivado, inclusive silencioso) | `containers.estado` | Vivo |
| G-A2 | Contêineres com prazo próximo | contêiner | `estado = 'PRAZO_PROXIMO'` | `containers.estado` | Vivo |
| G-A3 | Em demurrage — Atenção (1–6) | contêiner | `estado = 'EM_DEMURRAGE_ATENCAO'` | idem | Vivo |
| G-A4 | Em demurrage — Crítico (7–14) | processo | `prioridade_balde = 'CRITICA_7_14'` | `processos.prioridade_balde` | Vivo |
| G-A5 | Críticos 15+ dias | processo | `prioridade_balde = 'CRITICA_15'` | idem | Vivo |
| G-A6 | Contêineres com exposição Rocket | contêiner | relógio Rocket com `estado='OK'` e `dias_demurrage > 0` (a tabela/valor pode estar indisponível — isso é outro indicador, G-E6) | `relogios` tipo=rocket | Vivo |
| G-A7 | Processos com tracking desatualizado | processo | badge `TRACKING_DESATUALIZADO` presente (`estado_badges`) | `containers.estado_badges` | Vivo |
| G-A8 | Processos com dados críticos pendentes | processo | `estado = 'PENDENCIA_DE_DADOS'` OU `demurrage_pendencias` aberta do processo | `containers.estado` + `demurrage_pendencias` | Vivo |
| G-A9 | Processos aguardando tratamento | processo | `estado_mais_relevante = 'DEVOLVIDO_AGUARDANDO_TRATAMENTO'` | `processos.estado_mais_relevante` | Vivo |
| G-A10 | Processos concluídos operacionalmente | processo | `apuracao_status = 'FINAL'` | `processos.apuracao_status` | Vivo (mas a TRANSIÇÃO para FINAL é um evento — ver G-D5) |

Separáveis por cliente (`processos.cliente_id`), armador
(`processos.armador_id`), responsável
(`processos.responsavel_operacional_id`), tipo de equipamento
(`containers.container_type_id`) e período (ver §11). Risco de dupla
contagem: **nenhum** nesta tabela — cada linha é um `COUNT` sobre um
conjunto mutuamente exclusivo por definição do próprio estado/balde
(Cap. 21.10 garante um único estado por contêiner/processo). Visibilidade:
`ANALYST`/`MANAGER`/`ADMIN` — nenhum destes é financeiro nem expõe
Rocket além da MERA contagem de contêineres expostos (G-A6 não expõe
valor).

### Grupo B — Visão financeira (Cap. 30.2)

| ID | Nome (PT) | Grão | Fórmula | Fonte | Natureza |
|---|---|---|---|---|---|
| G-B1 | Valor bruto do cliente, por moeda/status | organização×moeda×status | soma exata (`agregarLado` generalizado) de `valores_apurados.total` onde `relogio_tipo='cliente'`, linha ATIVA (`calculation_status IN (OPEN,FINAL)`) | `valores_apurados` | Vivo |
| G-B2 | Valor efetivamente atribuído ao cliente | organização×moeda | soma `responsabilidade_decisoes.valor_cliente` onde `valor_status='CALCULADO'` e decisão é a vigente (não superseded) | `responsabilidade_decisoes` | Vivo |
| G-B3 | Valor atribuído à Rocket (responsabilidade) | organização×moeda | soma `responsabilidade_decisoes.valor_rocket` nas mesmas condições de G-B2 | idem | Vivo |
| G-B4 | Exposição estimada da Rocket | organização×moeda | soma `valores_apurados.total` onde `relogio_tipo='rocket'`, `confirmation_status IN ('ESTIMATED','ESTIMATED_PROVISIONAL')`, ATIVA | `valores_apurados` | Vivo |
| G-B5 | Exposição confirmada da Rocket | organização×moeda | idem, `confirmation_status='CONFIRMED'` | idem | Vivo |
| G-B6 | Diferença potencial total | organização×moeda | soma das diferenças ELEGÍVEIS por contêiner (ver §7) — nunca uma subtração de totais já agregados | `valores_apurados` (par cliente/Rocket por contêiner) | Vivo, **estritamente interno** |
| G-B7/8/9 | Faturado / recebido / saldo | — | **Sem fonte.** Fixo "Status financeiro não disponível" | HeadCargo (não integrado) | **Adiado** |

Todo indicador do Grupo B retorna, ao lado do total por moeda: contagem de
`pendente`, `indisponível` e `não aplicável` que **não entraram na soma**
(Cap. 30.7 — nenhum total esconde pendência). Visibilidade: **decisão do
usuário (§21, D10/D11)** — ver análise abaixo. Risco de dupla contagem:
G-B1 soma por `(container_id, relogio_tipo, motor_comercial)` ativo —
nunca duas linhas ativas do mesmo trio coexistem (garantido pelo índice
único 0009), então não há duplicação por reconsulta.

### Grupo C — Responsabilidade da Rocket (Cap. 30.3)

| ID | Nome (PT) | Grão | Regra | Fonte | Natureza |
|---|---|---|---|---|---|
| G-C1 | Processos com responsabilidade confirmada | processo | existe decisão vigente com `status IN ('CONFIRMADA_ROCKET','CONFIRMADA_CLIENTE','DIVIDIDA')` | `responsabilidade_decisoes` | Vivo |
| G-C2 | Diárias confirmadas para a Rocket | organização | soma `dias_rocket` das decisões vigentes `CONFIRMADA_ROCKET`/`DIVIDIDA` | idem | Vivo |
| G-C3 | Valor correspondente (Rocket) | organização×moeda | = G-B3, mesma fonte, outra lente (por decisão em vez de por processo) | idem | Vivo |
| G-C4 | Cliente/responsável/processo por decisão | linha | detalhamento (drill-down), não um total | `responsabilidade_decisoes` + `processos` | Vivo |
| G-C5 | Justificativa e evidências | linha | `justificativa`, `evidencia_ref` da decisão vigente | idem | Vivo — **estritamente interno**, nunca no Portal (Cap. 26.4) |
| G-C6 | Recorrência por período | organização×período | `COUNT`/`GROUP BY` de decisões por `decidido_em` no período filtrado | idem | Vivo, filtrado por período (não um snapshot) |
| ~~G-C0~~ | Possível responsabilidade sugerida | — | **Fora de escopo** (ver §4.4) | Liberação (inexistente) | Adiado |

### Grupo D — Eficiência operacional (Cap. 30.4)

| ID | Nome (PT) | Grão | Fórmula | Fonte | Natureza |
|---|---|---|---|---|---|
| G-D1 | % devolvido dentro do House FT | organização, período | `COUNT(effective_return_date <= discharge_date + house_free_time_days - 1) / COUNT(effective_return_date IS NOT NULL)`, filtrado por período (§11) | `containers` | Histórico-por-período (ver §8) |
| G-D2 | % devolvido dentro do Master FT | idem, com `master_free_time_days` | idem | `containers` | idem |
| G-D3 | Média de dias descarga→Empty Return | organização, período | média de `(tracking_return_date - discharge_date)` só sobre containers com ambas as datas | `containers` | idem — **decisão #3 (dias corridos vs. úteis)** |
| G-D4 | Média de dias de demurrage por contêiner | organização, período | **decisão #2** (inclui processos abertos ou só fechados — ver §21) | `valores_apurados.dias_cobrados` (FINAL) ou `relogios.dias_demurrage` (vivo) | Mista — ver §8 |
| G-D5 | Tempo médio Empty Return → conclusão | organização, período | média de `(fechado_em - effective_return_date)`, só processos `apuracao_status='FINAL'` | `processos.fechado_em` + `containers.effective_return_date` | Histórico-por-período |
| G-D6 | Tempo médio de resolução de pendências | organização, período | média de `(resolvido_em - criado_em)` só pendências resolvidas | `demurrage_pendencias` | Histórico-por-período |
| G-D7 | Processos concluídos sem custo | organização, período | `apuracao_status='FINAL'` e nenhum `valores_apurados` ativo com `total > 0` em nenhum lado | `processos` + `valores_apurados` | Histórico-por-período |
| G-D8 | Processos concluídos com demurrage | organização, período | complemento de G-D7 dentro dos `FINAL` | idem | idem |

### Grupo E — Qualidade de dados e tracking (Cap. 30.5)

| ID | Nome (PT) | Grão | Regra | Fonte | Natureza |
|---|---|---|---|---|---|
| G-E1 | Consultas de tracking realizadas | organização, período | `COUNT(tracking_fetches)` via join `container_tracking_targets`→`containers` (escopo de organização, §4.1) | `tracking_fetches` | Histórico-por-período |
| G-E2 | Respostas reaproveitadas pelo cache | idem | idem, `cached = true` | idem | idem |
| G-E3 | Consultas evitadas | — | **Pendente de confirmação de fonte** (§4.2) | ? | Adiado até confirmação |
| G-E4 | Taxa de sucesso por armador | organização, período | `COUNT(status='ok') / COUNT(*)` agrupado por `carrier`, mesmo join | `tracking_fetches` | Histórico-por-período |
| G-E5 | Conectores com 3+ falhas consecutivas | organização | `tracking_incidents` aberto (`fechado_em IS NULL`) via join de escopo (§4.1) | `tracking_incidents` | Vivo |
| G-E6 | House/Master FT automático × MANUAL_FALLBACK | organização, período | `COUNT` por `field_observations.fonte` (ou flag de fallback manual da D10 v1.1/1.2) nos campos `house_free_time`/`master_free_time` | `field_observations` | Histórico-por-período |
| G-E7 | Tipos de contêiner não reconhecidos | organização | `demurrage_pendencias.tipo IN ('tipo_ausente','tipo_nao_reconhecido')` aberta | `demurrage_pendencias` | Vivo |
| G-E8 | Tabelas/faixas indisponíveis | organização | `valores_apurados.confirmation_status='UNAVAILABLE'` ativo | `valores_apurados` | Vivo |
| G-E9 | Processos com tracking suspenso 30+ dias | organização | **Pendente de confirmação de fonte** (§4.3) | ? | Adiado até confirmação |

### Grupo F — Moeda (Cap. 30.6)

Transversal: todo indicador dos Grupos B/C/D que envolve valor monetário
é reportado **por moeda separadamente**, nunca somado entre moedas. Não
há conversão nesta fase (nenhuma taxa de câmbio é uma fonte existente no
sistema). Se um indicador precisar de uma visão "total" multi-moeda, a
resposta é uma LISTA por moeda, nunca um número único.

---

## 6. Modelo de agregação financeira

Regra única, válida para todo indicador dos Grupos B/C: **generalizar
`agregarLado`** (hoje interna a `contrato.ts`, escopada a um processo) para
aceitar qualquer lista de `ValorEnvelope` vindos de qualquer grão —
processo, organização inteira ou um subconjunto filtrado — produzindo
exatamente a mesma estrutura (`GrupoFinanceiroPorMoeda[]` +
`pendentes`/`indisponiveis`/`semAplicacao`/`completo`), usando os MESMOS
`centavosExatos`/`somarCentavosExatos`/`formatarCentavos` de
`moedaExata.ts`. **Nenhuma segunda implementação de soma monetária é
criada.** A função atual de processo (`agregarFinanceiroProcesso`) passa
a ser um caso particular (um processo = N containers) da nova função de
organização (organização = M processos = N×M containers).

Regras obrigatórias (já impostas pelo motor atual, preservadas):

- Nunca somar `cliente` com `rocket`.
- Nunca somar moedas diferentes.
- `PENDENTE`/`INDISPONIVEL`/`NAO_APLICAVEL` nunca entram na soma — contam
  à parte; `completo` é `false` sempre que houver `pendentes>0` ou
  `indisponiveis>0` (a definição atual já ignora `semAplicacao`, que
  **não** é pendência).
- Status (`CONFIRMADO`/`ESTIMADO`/`ESTIMADO_PROVISORIO`) preservado em
  contadores próprios dentro de cada grupo de moeda — nunca um único
  número "valor total" sem a composição ao lado (Cap. 30.7/25).
- Só a linha **ATIVA** (`calculation_status IN ('OPEN','FINAL')`) de cada
  `(container_id, relogio_tipo, motor_comercial)` entra — `SUPERSEDED`
  nunca é somado a um total atual (mas fica disponível para a timeline/
  auditoria, nunca apagado).

---

## 7. Matriz de elegibilidade da diferença potencial

`diferença potencial = valor do cliente − exposição da Rocket` (Cap. 24.3,
11). Avaliada **por contêiner**, nunca por processo ou organização
diretamente (a soma organização = soma das diferenças elegíveis por
contêiner, não a subtração de dois totais já agregados — subtrair totais
agregados misturaria contêineres onde só um lado está disponível).

| Condição | Checagem | Se falhar |
|---|---|---|
| Mesma moeda | `cliente.moeda === rocket.moeda` | `incompatível_moeda` |
| Ambos os lados financeiramente disponíveis | `cliente.situacao NOT IN (PENDENTE, INDISPONIVEL)` E idem para `rocket` | `pendente` ou `indisponivel` (o lado que falhou) |
| Período de apuração compatível | mesmo `relogio.data_final_apuracao` (ou ambos cobrindo o mesmo intervalo — decisão: ver nota) | `periodo_incompativel` |
| Frescor pelos `dias_cobrados` | ambos os `valores_apurados` ativos calculados com o `dias_cobrados` correspondente ao estado ATUAL do relógio (mesma regra de frescor da D12 v1.2.3 — `RELOGIO_OBSOLETO` nunca entra) | `obsoleto` |
| Status de confirmação compatível | **decisão #8** (ver §21): permitir quando um lado é só `ESTIMADO`? Recomendação: permitir, mas marcar a diferença resultante como `parcialmente_estimada` (nunca ocultar que faltou confirmação) | — |
| Nenhum valor pendente que torne a diferença enganosa | se QUALQUER lado for `PENDENTE`, a diferença NÃO é calculada (nunca aparece como zero) | `pendente` |

Quando inválida, a resposta é um objeto estruturado
`{ elegivel: false, motivo: 'pendente'|'indisponivel'|'incompativel_moeda'|'periodo_incompativel'|'obsoleto' }`
— nunca `null` silencioso nem `0`. Nunca há conversão de moeda para
viabilizar a subtração. **Este valor é estritamente interno**: a rota que
o expõe deve recusar `CLIENT` do mesmo jeito que `autorizacao.ts` já
recusa hoje (nunca um papel novo o alcança por engano), e o contrato
público (se algum dia existir Portal) nunca inclui este campo — Cap. 24.3
e 32.2 são explícitos.

---

## 8. Indicadores vivos × históricos

Dois tipos de "histórico" precisam ser distinguidos, porque exigem
soluções diferentes:

1. **Histórico-por-período (vivo, filtrado por data passada).** Uma
   consulta agregada sobre fatos **já fechados/append-only**
   (`effective_return_date`, `closing_events`, `valores_apurados` FINAL,
   `demurrage_pendencias` resolvidas, `tracking_fetches`), filtrada por
   uma data de atribuição ao período (§11). **Não precisa de nenhuma
   tabela nova** — é uma query com `WHERE` de data sobre o estado atual
   dos fatos fechados. Groups D e E (eficiência, qualidade) são
   majoritariamente deste tipo.
2. **Snapshot ponto-no-tempo (precisa de materialização).** "Quantos
   processos estavam em `CRITICA_15` em 1º de outubro" não é
   reconstruível a partir de `containers.estado`/`prioridade_balde` hoje:
   essas colunas são cache regenerável, sobrescrito a cada recálculo —
   não existe uma versão "como estava naquele dia". O Grupo A (contagens
   vivas de backlog) é fundamentalmente **o estado atual**; para ver sua
   evolução ao longo do tempo, é obrigatório um snapshot diário (§9).

Conclusão: **Grupo A é sempre vivo** (não existe "Grupo A histórico" sem
snapshot); **Grupos D e E são histórico-por-período sobre fatos já
fechados**, sem necessidade de snapshot; **Grupo B/C são vivos**, mas se o
usuário quiser uma série temporal de "exposição Rocket ao longo do
tempo" (em vez de só "exposição Rocket agora"), isso também exige
snapshot — os valores `valores_apurados` ATIVOS mudam (são substituídos
por `SUPERSEDED`) e o estado "qual era o total em 1º de setembro" não é
mais reconstruível sem um registro próprio além da proveniência do
`supersedes_id` (que reconstrói a CADEIA de um contêiner, mas não um
TOTAL agregado de organização num instante passado, sem reprocessar todo
o histórico de cada contêiner — caro e fora do escopo de uma leitura
`GET`).

---

## 9. Recomendação de snapshot histórico

Proposto (aditivo, append-only), condicionado à aprovação do usuário
(decisão #9, §21):

```sql
CREATE TABLE demurrage_gestao_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  data_operacional DATE NOT NULL,          -- dia civil operacional (America/Sao_Paulo, já centralizado — v1.3-4)
  versao_calculo TEXT NOT NULL,            -- versão do materializador (ex.: 'd14.snapshot.v1')
  grao TEXT NOT NULL CHECK (grao IN ('organizacao', 'processo', 'container')),
  metricas JSONB NOT NULL,                 -- os indicadores do Grupo A/B/C congelados daquele dia
  moeda TEXT,                              -- NULL quando a linha não é monetária
  status_financeiro TEXT,                  -- quando aplicável (grupo B)
  fontes_hash TEXT NOT NULL,               -- hash dos fatos usados (auditável, mesmo princípio de input_hash)
  gerado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  chave_idempotencia TEXT NOT NULL,        -- 1 materialização por (organização, data, grão, versão)
  CONSTRAINT demurrage_gestao_snapshots_idempotencia UNIQUE (organization_id, data_operacional, grao, versao_calculo, chave_idempotencia)
);
-- forbid_mutation (mesmo padrão de `snapshots`/`demurrage_registros`): nunca UPDATE/DELETE.
```

Princípios:

- **Nunca sobrescrever um snapshot passado.** Uma correção de dado que
  afeta um dia já materializado gera uma **nova versão**
  (`versao_calculo` incrementada ou uma segunda linha com
  `fontes_hash` diferente), nunca um `UPDATE` na linha antiga — a
  decisão #9 do usuário define exatamente quando um dia "fecha" (torna-se
  imutável) e a partir de quando uma correção posterior vira nota lateral
  em vez de reescrita.
- **Materialização é um comando interno separado, nunca dentro de um
  `GET`.** Um scheduler próprio (análogo ao `schedulerBootstrap` já
  existente para tracking) roda uma vez por dia civil operacional,
  idempotente por `(organization_id, data_operacional, grao, versao)` —
  reprocessar o mesmo dia não duplica.
- **Granularidade organização é suficiente para os indicadores do
  Cap. 30** (nenhum capítulo pede snapshot por processo individual) —
  `grao='processo'/'container'` fica reservado para uma necessidade futura
  de drill-down histórico, não implementado nesta fase a menos que
  aprovado.
- Snapshots nunca retroagem: a primeira materialização de um dia só
  acontece quando esse dia já é passado (nunca um "snapshot do futuro" nem
  um snapshot do dia corrente, que ainda está mudando).

**Alternativa mais simples (sem nova tabela), se o usuário preferir não
aprovar materialização nesta fase:** expor só os indicadores Vivos (Grupo
A/B/C "agora") e Históricos-por-período (Grupos D/E, que não precisam de
snapshot). Uma série temporal de backlog (Grupo A ao longo do tempo) fica
**explicitamente fora de escopo** até a aprovação do snapshot. Esta é a
recomendação se o apetite for minimizar superfície nova nesta fase.

---

## 10. Contratos de API propostos (sem desenhar UI)

Seguem a mesma convenção da D12 v1.2.3: organização só do membership,
`organizationId` nunca aceito em nenhum canal (`400 parametro_nao_aceito`
explícito), `GET` nunca escreve/recalcula/dispara tracking/notificação,
paginação/filtros estáveis, valores monetários como string decimal exata,
moedas e status sempre separados, `CLIENT` nunca alcança estas rotas
(mesmo guard de `autorizacao.ts`).

| Rota | Propósito | Indicadores | Paginação |
|---|---|---|---|
| `GET /api/demurrage/v2/gestao/operacional` | Visão operacional atual | Grupo A completo | Não pagina (contagens), filtros de §11 |
| `GET /api/demurrage/v2/gestao/financeiro` | Visão financeira atual | Grupo B (exceto faturado/recebido/saldo — fixo "não disponível") | idem |
| `GET /api/demurrage/v2/gestao/responsabilidade` | Responsabilidade Rocket | Grupo C | idem, + período (recorrência) |
| `GET /api/demurrage/v2/gestao/eficiencia` | Eficiência operacional | Grupo D | período **obrigatório** (sem período, nenhuma média é exibida — nunca uma média "desde sempre" implícita) |
| `GET /api/demurrage/v2/gestao/qualidade` | Qualidade de dados/tracking | Grupo E | período obrigatório para E1/E2/E3/E4/E6; vivo para E5/E7/E8/E9 |
| `GET /api/demurrage/v2/gestao/indicadores/:id/composicao` | Drill-down (Cap. 30.7) | qualquer indicador acima | cursor igual ao da fila D12 (mesma paginação, mesmos filtros de processo/contêiner) — reaproveita `FilaItemV1`/`construirQueryFila`, nunca reimplementa |
| `GET /api/demurrage/v2/gestao/historico/:grao` | Série temporal | snapshots (§9), **condicional à aprovação** | cursor por `data_operacional` |

Todas retornam, ao lado de cada total monetário, as contagens
`pendente`/`indisponível`/`não aplicável` que ficaram fora da soma — nunca
um total "limpo" sem essa composição (Cap. 30.7).

---

## 11. Filtros e períodos de relatório

Filtros comuns a todas as rotas (reaproveitando `FiltroFila`/
`normalizarFiltrosFila` como base, estendido só com o necessário):
`cliente`, `armador`, `responsavel`, `tipoEquipamento` (novo — hoje a D12
não filtra por tipo de equipamento; precisa ser adicionado), e período.

**Decisão #4 do usuário (§21):** qual data atribui um processo/contêiner a
um período de relatório. Opções e a recomendação:

| Opção | O que mede | Problema |
|---|---|---|
| Data de descarga | "o que chegou neste mês" | Um processo de setembro pode fechar em novembro — média de eficiência do mês de descarga fica incompleta até todos fecharem |
| **1º dia de demurrage** (recomendado para Grupo D "eficiência") | "o que começou a gerar risco/custo neste mês" | Só existe para quem chegou a ter demurrage — processos sem demurrage ficam de fora desta contagem especificamente (não de outras) |
| Empty Return (devolução efetiva) | "o que foi devolvido neste mês" | Não serve para indicadores de "entrada" (ex.: quantos entraram em monitoramento) |
| Data de fechamento | "o que foi concluído neste mês" | É a única data estável para os indicadores de EFICIÊNCIA do Grupo D (G-D1/D2/D3/D5/D7/D8 — todos exigem conclusão/devolução para existir) |

**Recomendação:** usar **data de fechamento
(`processos.fechado_em`)** como período-padrão para o Grupo D (eficiência
— os indicadores só fazem sentido para processos concluídos, e usar a
data de conclusão evita o problema de "mês incompleto" de usar a data de
descarga); usar **data de descarga** como período-padrão para o Grupo A
(visão operacional — mede o que entrou, não o que terminou); permitir
override explícito do campo de data por filtro (como a D12 já faz com
`periodoCampo: 'descarga'|'devolucao'`), estendido com `'fechamento'` e
`'primeiro_dia_demurrage'`.

---

## 12. Matriz de visibilidade por papel

| Indicador/grupo | ANALYST | MANAGER | ADMIN | CLIENT |
|---|---|---|---|---|
| Grupo A (operacional) | ✅ | ✅ | ✅ | ❌ (403, igual D12) |
| G-A6 (contêineres com exposição Rocket — só contagem, sem valor) | **decisão #10** | ✅ | ✅ | ❌ |
| Grupo B (financeiro, valores) | **decisão #10/#11** | ✅ | ✅ | ❌ |
| G-B6 (diferença potencial) | **decisão #10** (recomendação: não) | ✅ | ✅ | ❌ sempre (Cap. 24.3/32.2, nunca negociável) |
| Grupo C (responsabilidade) | **decisão #11** (recomendação: leitura sim, nunca decidir) | ✅ (decide) | ✅ (decide) | ❌ sempre (Cap. 26.4/32.2) |
| Grupo D (eficiência) | ✅ | ✅ | ✅ | ❌ |
| Grupo E (qualidade/tracking) | ✅ (consulta) | ✅ | ✅ | ❌ |
| Histórico/snapshot (§9) | mesma regra do indicador vivo correspondente | | | ❌ |

Hoje (D12) os três papéis internos têm exatamente a mesma visibilidade de
leitura — não existe nenhuma diferenciação de campo por papel em
`filaOperacional.ts`/`detalhe.ts`. O Blueprint Cap. 10 diferencia
APENAS permissões de **escrita** (Analista não corrige Free Time já
fornecido por fonte aprovada; só Gestor confirma responsabilidade) — não
diz explicitamente que o Analista não pode **ler** exposição Rocket ou
diferença potencial. Por isso as células acima marcadas "decisão #10/#11"
não têm resposta no Blueprint e **exigem decisão do usuário** (ver §21);
a recomendação desta análise segue o princípio de menor exposição: dados
estritamente internos de margem (diferença potencial) ficam restritos a
MANAGER/ADMIN por padrão, enquanto contagens operacionais (quantos
contêineres estão expostos, sem valor) ficam abertas a todos os papéis
internos.

---

## 13. Isolamento de organização

Nenhuma rota aceita `organizationId` de query/corpo/cabeçalho — mesmo guard
de `autorizacao.ts` (`resolverAutorizacao`), reutilizado sem alteração.
Toda nova consulta segue o padrão já em uso: **toda tabela com
`organization_id` filtra por ele diretamente; toda tabela sem
`organization_id` (as GLOBAIS de tracking) filtra por JOIN através de
`container_tracking_targets`/`containers`**, nunca por filtro aplicado
depois de uma soma/contagem já feita sobre o universo inteiro (o padrão
errado seria "contar tudo, filtrar depois" — o padrão certo, já usado em
`buscarAgregadosPorProcesso`, é "o JOIN já restringe antes de agregar").
A suíte de teste de zero-escrita/RBAC da D12 (`demurrageV2UiZeroWrite`)
deve ganhar casos equivalentes para as novas rotas (mesmo fingerprint de
schema completo antes/depois, mesmo teste de 403 para `CLIENT`/401 sem
sessão).

---

## 14. Estratégia de consulta e desempenho

### Leituras em lote já reaproveitáveis da D12

- `buscarProcessosCandidatos`/`buscarContainersDosCandidatos` (fila) — já
  usam `= ANY($1)`, nunca uma consulta por processo.
- `buscarAgregadosPorProcesso` — já resolve pendências/falhas/tracking em
  3 consultas agregadas (`UNION ALL` + `GROUP BY`), não N+1.
- `contarEstadosEBaldes` — já existe, mas **não escala** (ver abaixo).

### Risco de N+1 e de custo linear identificado

`contarEstadosEBaldes` (reaproveitada pelos KPIs da D13) carrega **todos**
os processos e containers da organização e roda
`derivarEmLote`/`consolidarProcesso` em memória a cada chamada — O(N)
processos × containers, sem paginação, a cada requisição. Isso é aceitável
para os 4 KPIs da D13 (chamada uma vez ao abrir a tela), mas o Grupo A da
D14 soma MAIS dimensões (cliente/armador/responsável/tipo/período) sobre a
MESMA base — se implementado copiando o padrão atual, o custo cresce na
mesma proporção.

**Recomendação:** os indicadores do Grupo A devem ser respondidos por
`SELECT COUNT(*) ... GROUP BY` diretamente sobre as colunas persistidas
(`containers.estado`, `processos.prioridade_balde`, já materializadas pela
Fase 7/0015), **não** por re-derivação em memória — aceitando que essas
colunas são "quase vivas" (atualizadas a cada tick do scheduler/leitura
que já as recalcula), em vez de 100% recalculadas a cada leitura de
Gestão. Isso é uma mudança de postura em relação à D12 (que prioriza
"sempre recalculado" para a fila, por ser uma tela de poucos itens) —
**precisa de aprovação explícita do usuário** porque troca
"sempre exatamente vivo" por "vivo com a defasagem de um tick do
scheduler" em troca de custo constante por grupo em vez de custo linear
no total de contêineres da organização.

### Tabela de custo esperado (estimativa, sem medição real disponível)

| Processos na organização | Grupo A (hoje, re-derivação em memória) | Grupo A (proposto, `GROUP BY` sobre coluna persistida) | Grupo B/C (nova agregação financeira) | Grupo D/E (histórico-por-período) |
|---|---|---|---|---|
| 100 | ~instantâneo | instantâneo | 1 `GROUP BY` sobre `valores_apurados` filtrado por organização — rápido com índice | 1–2 `GROUP BY` com filtro de data — rápido |
| 1.000 | perceptível (centenas de ms) | ainda rápido (índice composto) | ainda rápido | ainda rápido |
| 10.000 | risco real de lentidão (milhares de linhas recalculadas por chamada) | **ainda O(índice)**, não O(N) de re-derivação | depende de índice em `valores_apurados(container_id, relogio_tipo, calculation_status)` já parcialmente coberto (0009) — confirmar com `EXPLAIN` antes de aprovar índice novo | depende de volume de `tracking_fetches`/`demurrage_pendencias` no período — paginar por período evita problema |

**Nenhuma estimativa acima substitui medição real.** O plano de teste
(§18) inclui `EXPLAIN ANALYZE` contra um volume sintético antes de
qualquer índice novo ser proposto como migration.

### Índices potenciais (não criados nesta fase — só apontados)

1. `containers (organization_id, estado)` — suporta G-A1/A2/A3 por
   `GROUP BY estado` com filtro de organização já citado no plano de
   consulta.
2. `processos (organization_id, prioridade_balde)` — hoje só existe
   `processos_prioridade_balde_idx` sem `organization_id`; toda consulta
   real filtra pelos dois. Suporta G-A4/A5.
3. `valores_apurados (relogio_tipo, confirmation_status, calculation_status)`
   combinado com `container_id` — suporta Grupo B agregado por
   organização via join com `containers`. Precisa confirmar se o índice
   existente (`valores_apurados_container_idx`) já é suficiente via
   `container_id` primeiro (provavelmente sim para consultas por
   processo; para consulta por ORGANIZAÇÃO inteira, provavelmente não —
   medir).
4. `tracking_fetches (criado_em)` ou `(tracking_target_id, criado_em)` já
   existe (`tracking_fetches_target_idx`) — suficiente para Grupo E
   filtrado por `tracking_target_id` após o join; confirmar com
   `EXPLAIN` se filtro por período (`criado_em BETWEEN`) se beneficia de
   um índice adicional só em `criado_em`.

Qualquer um destes só vira migration real na fase de implementação, **com
o `EXPLAIN ANALYZE` que o justifica** anexado ao PR, nunca adicionado por
suposição.

### Paginação estável

Drill-down (`/composicao`) reaproveita o cursor assinado da D12
(`cursorAssinado.ts`) — mesmo HMAC, mesma versão de contrato por rota, sem
nova implementação de paginação.

---

## 15. Migrations propostas (se aprovadas)

**Nenhuma migration é criada nesta fase.** Se o usuário aprovar o modelo
de snapshot (§9), a única migration necessária na implementação é:

- `0035_demurrage_gestao_snapshots.sql` — cria `demurrage_gestao_snapshots`
  (schema no §9), `forbid_mutation` (mesmo padrão de `snapshots`/
  `demurrage_registros`), índice
  `(organization_id, data_operacional, grao)`.

Se o usuário aprovar os índices do §14 após medição real, eles entram
numa migration separada e aditiva (`0036` ou seguinte), cada um
acompanhado do `EXPLAIN ANALYZE` que o motivou. Nenhuma coluna existente
muda de tipo, nenhuma tabela existente é alterada estruturalmente.

---

## 16. Arquivos a criar/alterar (na implementação, não nesta fase)

Só leitura (novo), seguindo a convenção de `src/demurrage-engine/leitura/`:

- `src/demurrage-engine/leitura/gestao/contrato.ts` — tipos dos payloads
  dos 6 grupos (A–F) + resposta de drill-down + resposta de histórico.
- `src/demurrage-engine/leitura/gestao/operacional.ts` — Grupo A.
- `src/demurrage-engine/leitura/gestao/financeiro.ts` — Grupos B/F
  (generaliza `agregarLado`, movida ou reexportada de `contrato.ts`
  original sem duplicar).
- `src/demurrage-engine/leitura/gestao/responsabilidade.ts` — Grupo C.
- `src/demurrage-engine/leitura/gestao/eficiencia.ts` — Grupo D.
- `src/demurrage-engine/leitura/gestao/qualidade.ts` — Grupo E.
- `src/routes/demurrageGestaoRoutes.ts` — as 7 rotas do §10, mesmo padrão
  de `demurrageV2Routes.ts` (RBAC via `autorizacao.ts`, reexportado sem
  alteração).
- Se snapshot aprovado: `src/demurrage-engine/gestao/snapshotMaterializer.ts`
  + bootstrap próprio (análogo a `schedulerBootstrap.ts`), chamado por
  `src/index.ts` como um novo ciclo independente — nunca dentro de um
  `GET`.
- `src/demurrage-engine/db/migrations/0035_demurrage_gestao_snapshots.sql`
  (condicional).
- Testes: `src/demurrage-engine/__tests__/gestaoOperacional.test.ts`,
  `gestaoFinanceiro.test.ts`, `gestaoResponsabilidade.test.ts`,
  `gestaoEficiencia.test.ts`, `gestaoQualidade.test.ts`,
  `gestaoDiferencaPotencial.test.ts`, `gestaoSnapshot.test.ts`
  (condicional) + `src/frontend-tests`-equivalente para zero-escrita/RBAC
  das novas rotas, seguindo `demurrageV2UiZeroWrite.test.ts`.
- `docs/demurrage-fase-d14.md` — relatório de entrega, só depois da
  implementação e validação (não nesta fase).

**Nada em `public/**`, `src/routes/demurrageRoutes.ts` (V1),
`src/routes/demurrageV2Routes.ts` (D12, só lido como referência), nem em
qualquer motor de D10/D11/D12.**

---

## 17. Gates de aceitação propostos G1–G7

- **G1 — Confirmação de fontes pendentes.** Resolver §4.2/§4.3 (consultas
  evitadas, suspensão de 30 dias) por leitura de código antes de escrever
  qualquer query que dependa delas; documentar a fonte real encontrada ou
  formalizar o adiamento.
- **G2 — Agregação financeira generalizada.** Extrair/generalizar
  `agregarLado` para aceitar qualquer lista de envelopes; implementar
  Grupos B/F sobre ela; nenhuma segunda soma monetária no código.
- **G3 — Elegibilidade da diferença potencial.** Implementar a matriz do
  §7 como função pura testável isoladamente (fixtures cobrindo cada motivo
  de inelegibilidade), antes de ligar a qualquer rota.
- **G4 — Grupos A/C/E (contagens vivas).** Implementar sobre colunas
  persistidas (não re-derivação em memória, conforme §14), com
  `EXPLAIN ANALYZE` anexado.
- **G5 — Grupos D (histórico-por-período).** Implementar sobre fatos
  fechados existentes, com os 4 períodos de atribuição (§11) selecionáveis.
- **G6 — Snapshot (condicional à aprovação).** Migration + materializador
  + bootstrap próprio, idempotente, nunca dentro de um `GET`.
- **G7 — Regressão, RBAC, isolamento e relatório final.** Testes das
  novas rotas (zero-escrita, 401/403, fingerprint de schema), suíte
  completa da engine, V1, `tsc`, `build`, `git diff` vazio nos arquivos
  protegidos, relatório de entrega em português.

---

## 18. Plano de teste PostgreSQL

Reaproveita a infraestrutura já existente
(`src/demurrage-engine/__tests__/*.test.ts`, `node:test` com banco real):

1. **Fixtures de volume sintético** — gerar 100/1.000/10.000 processos com
   distribuição realista entre baldes/estados/moedas/status de confirmação
   (reaproveitando os helpers de fixture já usados em D11/D12), para medir
   G-A/G-B/G-D/G-E com `EXPLAIN ANALYZE` real, não estimado.
2. **Zero-escrita.** Cada rota nova roda contra o banco real e tira o
   fingerprint de TODO o schema (`information_schema`) antes/depois —
   mesmo padrão de `demurrageV2UiZeroWrite.test.ts`.
3. **RBAC.** `CLIENT` recebe 403 nas 7 rotas; sem sessão recebe 401;
   `organizationId` em qualquer canal recebe 400 `parametro_nao_aceito`.
4. **Isolamento multi-organização.** Duas organizações com dados
   concorrentes (incluindo um `tracking_target` COMPARTILHADO entre
   ambas, reproduzindo o cenário de vessel sharing) — nenhum indicador de
   uma organização conta fato da outra (G-E1/E2/E4/E5, que dependem do
   join através de tabelas globais).
5. **Elegibilidade da diferença potencial.** Casos de cada motivo de
   inelegibilidade do §7 isoladamente, mais o caso elegível.
6. **Não combinação de moedas.** Fixture com BRL e USD no mesmo processo —
   nunca uma linha somando os dois.
7. **Snapshot (se aprovado).** Idempotência (rodar duas vezes o mesmo dia
   não duplica), imutabilidade (tentar `UPDATE`/`DELETE` falha), e
   materialização nunca roda dentro do ciclo de request HTTP.
8. **Regressão completa.** `test:demurrage-engine` (baseline atual:
   724/724), V1 (25/25), `tsc --noEmit`, `npm run build`.

---

## 19. Riscos de regressão

- **Nenhum risco para D10/D11/D12/D13**: toda leitura nova é aditiva,
  sobre tabelas/colunas já existentes, sem nenhuma alteração nelas.
- **Risco real: reaproveitar mal `agregarLado`.** Se a generalização para
  organização não preservar exatamente as mesmas regras (nunca somar
  moeda, nunca converter `PENDENTE`/`INDISPONIVEL` em zero), o Grupo B
  herdaria um bug sutil de um lugar que hoje está correto e testado (D12
  v1.2.1). Mitigação: extrair sem reescrever a lógica interna, só o grão
  de entrada; reexecutar os testes atuais de `agregarFinanceiroProcesso`
  sem alteração de expectativa.
- **Risco de desempenho se o Grupo A copiar o padrão de
  `contarEstadosEBaldes` sem a mudança do §14** — não quebra nada, mas
  degrada em organizações grandes. Mitigação: gate G4 explícito.
- **Risco de vazamento cross-organização via tabelas globais de
  tracking** se um desenvolvedor futuro copiar uma consulta de Grupo E sem
  o join de escopo do §4.1. Mitigação: teste de isolamento dedicado
  (§18.4) como gate de regressão permanente, não só desta fase.

---

## 20. Itens explicitamente adiados

- **Integração financeira com HeadCargo** (Grupo B7/8/9) — sem fonte.
- **Possível responsabilidade SUGERIDA** (G-C0) — depende do módulo
  Liberação, inexistente nesta base.
- **"Consultas evitadas" e "suspensão de tracking após 30 dias"** (G-E3,
  G-E9) — fonte não confirmada; ver G1.
- **Série temporal de backlog (Grupo A histórico)** sem aprovação do
  snapshot (§9) — fica só "agora", sem "como estava".
- **Qualquer ação de escrita** (correção, confirmação de responsabilidade,
  reabertura, tracking manual) a partir da tela de Gestão — D14 é
  somente leitura; essas ações já existem em D10/D11 e não são tocadas.
- **Conversão de moeda** — nunca implementada; todo valor fica na sua
  moeda original.
- **UI de Gestão** — fora do escopo desta fase (backend-first, conforme
  instrução).

---

## 21. Decisões que exigem aprovação do usuário

Cada uma com a recomendação desta análise; nenhuma foi decidida
silenciosamente no código (nenhuma implementação foi feita).

1. **O que significa "duração média de demurrage".** Recomendação:
   G-D4 usando `valores_apurados.dias_cobrados` da linha **FINAL** (não
   `OPEN`), para que a média reflita apuração encerrada e auditável, não
   um valor "em andamento" que ainda vai mudar.
2. **Médias incluem processos abertos?** Recomendação: **não** — G-D1 a
   D8 só sobre processos com `apuracao_status='FINAL'` (ou, no caso de
   G-D3, containers com `effective_return_date` preenchida). Processos
   abertos entram nos indicadores VIVOS do Grupo A, não nas médias
   históricas do Grupo D (evita viés: um processo recém-aberto com "0
   dias até agora" puxaria a média para baixo artificialmente).
3. **Duração usa dias corridos?** Recomendação: **sim, dias corridos**
   (coerente com o Cap. 23, que já define a apuração em dias corridos,
   sem cálculo por hora) — não dias úteis.
4. **Qual data atribui um processo a um período de relatório?**
   Recomendação detalhada no §11: fechamento para Grupo D, descarga para
   Grupo A, com override explícito por filtro.
5. **Processos reabertos contam uma vez ou por ciclo operacional?**
   Recomendação: **uma vez por ciclo de fechamento** — cada
   fechamento→reabertura→refechamento gera um novo "ciclo" rastreável por
   `reaberturas`/`closing_events`; um indicador de eficiência (G-D5/D7/D8)
   conta o CICLO mais recente (o resultado final), mas a composição
   (drill-down) mostra os ciclos anteriores como histórico, nunca
   escondidos. Alternativa: contar cada ciclo separadamente nos
   indicadores agregados (infla a contagem de "processos concluídos"
   artificialmente) — não recomendada.
6. **Totais confirmado/estimado aparecem juntos, separados ou nunca
   combinados?** Recomendação: **nunca combinados em um único número**
   — sempre como hoje em `agregarLado` (grupos por moeda com
   confirmados/estimados/provisórios como contadores ao lado do
   subtotal exato daquele grupo, nunca um "total" que mistura os status
   sem marcação).
7. **Totais de processo incluem todos os contêineres ou só o líder?**
   Recomendação: **todos os contêineres** — Cap. 25 é explícito ("total
   do processo corresponde à soma dos valores individuais"); o
   contêiner-líder decide ESTADO/prioridade (Cap. 21/22), nunca decide
   sozinho o total financeiro do processo.
8. **Diferença potencial é permitida quando um lado é só estimado?**
   Recomendação: **permitir, mas marcar como `parcialmente_estimada`**
   (nunca ocultar a composição) — ver §7.
9. **Quando um dia histórico se torna imutável?** Recomendação: um dia
   operacional só é materializado (§9) quando já é passado (nunca o dia
   corrente); uma correção que afeta um dia já materializado gera uma
   NOVA versão do snapshot daquele dia (nunca reescreve a linha antiga) —
   análogo ao próprio `valores_apurados` (nunca `UPDATE` de memória de
   cálculo, só supersede).
10. **ANALYST pode ver exposição Rocket / diferença potencial?**
    Recomendação: contagem (G-A6, "quantos contêineres expostos") sim;
    **valor** de exposição (Grupo B) e diferença potencial (G-B6) **não**
    por padrão — restritos a MANAGER/ADMIN (ver §12). O Blueprint não
    decide isso explicitamente; esta é a leitura mais conservadora do
    Cap. 10/11 (margem é informação de gestão, não de operação do
    dia a dia).
11. **Só MANAGER/ADMIN veem indicadores financeiros sensíveis?**
    Recomendação: sim para os Grupos B (valores) e C (responsabilidade,
    inclusive leitura) — ANALYST vê que existe uma decisão de
    responsabilidade e seu estado (Cap. 10: "consultar dados, cálculos e
    evidências" é papel do Analista), mas não decide (já garantido pela
    migration 0031: `autor_papel IN ('MANAGER','ADMIN')`).
12. **Como registros históricos incompletos são representados?**
    Recomendação: um snapshot cujas fontes tinham pendência naquele dia
    preserva a pendência DENTRO do snapshot (mesma filosofia de "nunca
    virar zero") — o snapshot registra "X pendente naquele dia", não
    tenta completá-lo retroativamente com dado que só chegou depois.
13. **Processos em monitoramento silencioso entram nos totais
    operacionais?** Recomendação: entram em G-A1 (monitoramento total,
    que por definição inclui todos), mas **não** nos indicadores de "fila
    que exige ação" (G-A2 a G-A9 já são, por definição de estado, estados
    que NÃO são silenciosos) — coerente com Cap. 13 ("estar sendo
    monitorado não significa ser exibido como problema").
14. **Contêineres devolvidos mas não fechados financeiramente continuam
    "ativos" nas métricas de gestão?** Recomendação: sim — entram em
    G-A9 (aguardando tratamento) até `apuracao_status='FINAL'`; só saem
    dos indicadores operacionais de backlog depois do fechamento (Cap. 27.1
    — "saem da fila principal" só após concluídos operacionalmente), mas
    continuam disponíveis para consulta em Gestão mesmo depois de
    concluídos (Cap. 27.1: "o eventual saldo financeiro permanece
    disponível para Gestão e consulta").

---

**A D14 não está implementada, aprovada nem congelada.** Nenhum código foi
alterado por este diagnóstico. A implementação só começa após o usuário
responder às 14 decisões do §21 (ou aceitar as recomendações como estão) e
aprovar explicitamente este documento. A D15 não foi iniciada.
