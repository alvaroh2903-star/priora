# Fase D11 v1.2 — corretiva final (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria. Base: `642e3a6` (D11 v1.1). Só
> integridade do agregado da decisão e validade dos relógios usados — nenhuma
> funcionalidade nova, nenhuma tela, rota ou integração com Liberação.

## Migration `0034_responsabilidade_v1_2_agregado.sql` (aditiva)

`0031`–`0033` não foram reescritas. Nenhuma tabela ou coluna nova. A `0034`:

- cria **uma** função de validação do agregado,
  `responsabilidade_validar_agregado(decisao_id)`;
- aponta para ela as duas funções de trigger já existentes (via `CREATE OR
  REPLACE`) — a da decisão (0033) e a da linha de dia (0031);
- mantém **três** restrições ADIADAS, todas chamando a mesma função:

| Trigger (adiado ao `COMMIT`) | Tabela | Disparado por |
|---|---|---|
| `responsabilidade_decisoes_cobertura` | `responsabilidade_decisoes` | criação da decisão (cobre decisão com zero dias) |
| `responsabilidade_decisao_dias_cobertura` | `responsabilidade_decisao_dias` | inclusão de cada dia (restaurado — a 0033 o removera) |
| `responsabilidade_decisao_periodos_cobertura` | `responsabilidade_decisao_periodos` | inclusão de cada período (novo) |

Não há duas regras: o que a decisão valida na criação é exatamente o que um
dia ou período acrescentado depois revalida.

### O que o `COMMIT` sempre garante

| Regra | Erro |
|---|---|
| contagem Rocket = `dias_rocket`; contagem cliente = `dias_cliente` | `LACUNA` |
| `RELOGIO_CLIENTE`: todos os dias reais do relógio do cliente, sem buraco | `LACUNA` |
| `RELOGIO_ROCKET`: pelo menos um dia Rocket concreto | `LACUNA` |
| `NAO_APLICAVEL`: nenhum dia e nenhum período | `AGREGADO_INVALIDO` / `PERIODO_INCOMPATIVEL` |
| posições únicas e iguais à posição real do dia no relógio-base | `POSICAO_INVALIDA` |
| moeda de cada dia = moeda da decisão | `MOEDA_DIVERGENTE` |
| `CALCULADO`: todo dia com diária e soma por lado = `valor_rocket` / `valor_cliente`; demais status: nenhum dia com diária | `VALOR_DIVERGENTE` |
| períodos sem sobreposição | `PERIODO_INCOMPATIVEL` |
| expansão dos períodos = conjunto (dia, lado) gravado — nenhum dia sem período, nenhum período sem seus dias | `PERIODO_INCOMPATIVEL` |

Tudo vale por SQL direto, sem o serviço TypeScript.

**Ajuste no serviço:** a diária e a moeda por dia só são gravadas quando a
divisão está `CALCULADO`. Antes, uma decisão `INDISPONIVEL` por divergência
de soma podia deixar diárias soltas nos dias.

## Relógio obsoleto (`RELOGIO_OBSOLETO`)

Antes de gravar, `decidirResponsabilidade` chama
`RelogioRepository.buscarValido` — a validação de cache existente, mesma
fórmula de `input_hash` do recalculador, nada duplicado. A chamada usa os
fatos atuais do contêiner e a data final da devolução, dentro da mesma
transação.

| Base | Relógios exigidos `VALIDO` |
|---|---|
| `RELOGIO_CLIENTE` | cliente |
| `RELOGIO_ROCKET` | Rocket **e** cliente (o que prova o zero do cliente) |
| `NAO_APLICAVEL` | cliente e Rocket |

`OBSOLETO` ou `AUSENTE` → `RELOGIO_OBSOLETO`, com `{ relogio, validade }` no
detalhe. O serviço não recalcula: o pipeline recalcula primeiro, o Gestor
decide depois.

Efeito colateral intencional num teste da v1.1: o teste de Free Time
indeterminável / House ≤ Master agora recebe `RELOGIO_OBSOLETO` do serviço,
porque alterar o Free Time sem recalcular torna o relógio obsoleto. A
barreira do banco (`NAO_APLICAVEL_INVALIDO`) continua coberta por SQL direto
no mesmo teste.

## Evidência (`__tests__/responsabilidadeV12.test.ts`, 12 testes, PostgreSQL real)

| Ponto | Testes |
|---|---|
| 1 (SQL direto) | decisão completa confirmada; em nova transação: dia extra → o INSERT passa e o **`COMMIT`** falha; dia extra com período → falha; dia de outro lado → falha · diária divergente, dia sem diária, moeda divergente, posição duplicada, posição fora da ordem, diária sem valor calculado → todos falham no `COMMIT`; agregado coerente confirma · decisão legítima do serviço (DIVIDIDA, períodos descontínuos, `CALCULADO`) funciona |
| 2 (SQL direto) | dia sem período; nenhum período; lado divergente; período sem os dias; períodos sobrepostos; lado trocado num trecho → todos falham no `COMMIT` · períodos descontínuos válidos confirmam · período acrescentado depois → falha · `NAO_APLICAVEL` com período (na criação e depois) → falha; sem período → confirma |
| 3 | **obrigatório:** House alterado sem recálculo → `RELOGIO_OBSOLETO` e relógio intocado; recálculo; decisão passa com os dias novos (4) e o `input_hash` novo · descarga alterada → obsoleto · devolução efetiva alterada → obsoleto · `RELOGIO_ROCKET` com Master alterado (Rocket obsoleto) e com só House alterado (cliente obsoleto), depois recálculo → passa · `NAO_APLICAVEL` com Rocket obsoleto · relógio `AUSENTE` → `RELOGIO_OBSOLETO` sem recálculo silencioso |
| migração | banco em 0033 com decisões `RELOGIO_ROCKET`, `DIVIDIDA` e `NAO_APLICAVEL` (e a prova de que na 0033 o dia extra passava) → `0034` aplicada: decisões, dias, períodos e projeções intactos; três triggers adiados presentes; período extra em decisão existente → falha; serviço corrige a decisão normalmente |

Testes v1.1 ajustados: o helper de SQL direto passa a gravar o período
correspondente aos dias; o teste de migração 0032 → 0033 aplica só até a
0033; e o teste de Free Time explicado acima. Catálogos de migration
atualizados: `migrate`, `responsavelOperacional`, `registroDemurrageV12`.

## Validação (PostgreSQL 16 real, `priora_test`)

| Suíte | Aprovados | Falhos | Ignorados |
|---|---|---|---|
| Engine completa (inclui banco novo 0001→0034) | 565 | 0 | 0 |
| — D11 completa (`responsabilidadeDecisao` 25, `V11` 18, `V12` 12; inclui 0032→0033 e 0033→0034) | 55 | 0 | 0 |
| — relógios (`relogios`) | 6 | 0 | 0 |
| — tarifas (`tariffs`) | 35 | 0 | 0 |
| — apuração e reabertura (`apuracao`, `V12`, `V13`, `V14`) | 31 | 0 | 0 |
| — fechamento (`closing`) | 21 | 0 | 0 |
| — D10 e fotografia (`registroDemurrage`, `V11`, `V12`, `demurrageVertical`, `demurrageTickFilas`) | 95 | 0 | 0 |
| — catálogo de migrations (`migrate`, `migration0007`, `responsavelOperacional`) | 29 | 0 | 0 |
| V1 | 25 | 0 | 0 |
| `tsc --noEmit` / `npm run build` | sem erros | — | — |

## Ajustes validados pelo auditor (rodada final da v1.2)

| Ponto | Validação | O que ficou no código |
|---|---|---|
| 1 | aprovado | Diária e moeda por dia só quando `valor_status = CALCULADO`. Decisão, cálculo, fotografia, projeção, faixas e motores tarifários inalterados. Único caminho afetado: `INDISPONIVEL` por soma dos dias ≠ total do valor apurado (só alcançável com valor apurado inconsistente) — os dias deixam de guardar diárias parciais. |
| 2a | **não aprovado** → corrigido | `VERSAO_DESATUALIZADA` é verificada **antes** de `RELOGIO_OBSOLETO`. A mesma verificação de versão (uma função) é antecipada **somente** quando o relógio está obsoleto; com relógio válido a ordem é exatamente a da v1.1 (validações de relógio antes de `VERSAO_DESATUALIZADA`). Nenhuma outra precedência mudou. |
| 2b | aprovado | Relógio `AUSENTE` → `RELOGIO_OBSOLETO` no serviço. |
| 2c | aprovado | Ver abaixo. |
| 2d | aprovado | `RELOGIO_ROCKET` exige relógio Rocket **e** relógio cliente `VALIDO` (a decisão precisa provar o zero do cliente). |

### 2c — `INTERVALO_ABERTO` no serviço

A data final da apuração (a devolução efetiva) compõe o `input_hash` do
relógio, junto com descarga, Free Time e versão do motor temporal. Por isso,
**no serviço**, qualquer alteração desses fatos sem recálculo — inclusive da
devolução — produz `RELOGIO_OBSOLETO` antes de qualquer validação que dependa
daquele relógio. Consequência explícita e aprovada: um relógio cuja data final
difere da devolução é sempre obsoleto para o serviço, e **`INTERVALO_ABERTO`
não é mais alcançável no fluxo normal do serviço**. Ele permanece como
proteção do **banco** (gatilho de INSERT da decisão, 0031/0033), válida para
SQL direto.

Mesma consequência, pelo mesmo motivo (o Free Time também compõe o
`input_hash`): os motivos `free_time_indeterminavel` e
`house_free_time_nao_maior_que_master` de `NAO_APLICAVEL_INVALIDO` não são
alcançáveis no serviço com relógios válidos — Free Time alterado sem
recálculo gera `RELOGIO_OBSOLETO`; Free Time ausente deixa o relógio
`PENDING`; e cliente zero com Rocket positivo já implica House > Master. As
duas verificações permanecem no serviço (defesa) e no banco (SQL direto),
cobertas por teste.

### Ordem final dos erros em `decidirResponsabilidade`

1. Validação pura da entrada (`contrato.ts`, sem banco): `CAMPO_OBRIGATORIO`,
   `JUSTIFICATIVA_AUSENTE`, `EVIDENCIA_AUSENTE`, `MOTIVO_CORRECAO_AUSENTE`,
   `PERIODO_INVALIDO` / `PERIODOS_AUSENTES`, `LADO_INCOMPATIVEL_COM_BASE`,
   `PERIODO_INVALIDO` / `SOBREPOSICAO` (expansão), `STATUS_INCOERENTE`.
2. `CONTAINER_NAO_ENCONTRADO`
3. `EXIGE_REABERTURA` (processo FINAL)
4. `AUTOR_NAO_AUTORIZADO`
5. `ANTES_DA_DEVOLUCAO`
6. Relógio exigido não `VALIDO` → primeiro `VERSAO_DESATUALIZADA` (se a versão
   estiver desatualizada), senão `RELOGIO_OBSOLETO`.
7. Validações que dependem do relógio (por base): `SEM_APURACAO_DETERMINAVEL`,
   `BASE_RELOGIO_INVALIDA`, `INTERVALO_ABERTO` (inalcançável no serviço — ver
   2c), `NAO_APLICAVEL_INVALIDO`.
8. `VERSAO_DESATUALIZADA` (relógio válido — posição da v1.1)
9. `DIA_FORA_DA_BASE`
10. `LACUNA`
11. Banco: gatilho de INSERT (mesmos códigos, defesa em profundidade) e, no
    `COMMIT`, o agregado da 0034 (`LACUNA`, `AGREGADO_INVALIDO`,
    `POSICAO_INVALIDA`, `MOEDA_DIVERGENTE`, `VALOR_DIVERGENTE`,
    `PERIODO_INCOMPATIVEL`).

Em relação à v1.1, a única diferença de ordem é a inclusão do passo 6.

## Auditoria do banco real (pré-requisito do freeze)

Script **somente leitura**: `scripts/auditoria/auditoria_agregado_0034.sql`.
Não é migration (o `migrate` só lê `src/demurrage-engine/db/migrations/`),
não corrige nada, roda em `BEGIN TRANSACTION READ ONLY` e termina em
`ROLLBACK`. Exige o banco já na 0034.

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/auditoria/auditoria_agregado_0034.sql
```

Saída: uma linha `NOTICE: VIOLA|<decisao_id>|container=…|versao=…|<status>|<base>|<valor_status>|situacao=…|<motivo>`
por decisão que viola hoje `responsabilidade_validar_agregado`, e ao final
`NOTICE: RESUMO|decisoes=N|violam_hoje=V|conformes=C`.

- `situacao=vigente`: a decisão é a projeção atual do contêiner — **é isso que
  bloqueia o freeze**.
- `maior_versao_sem_projecao` / `substituida`: histórico; pode "violar hoje"
  só porque o relógio do contêiner mudou depois da decisão.

Prova automatizada: `__tests__/responsabilidadeAuditoria.test.ts` executa o
próprio arquivo do repositório sobre um banco reproduzindo a herança da 0033
(decisões legítimas + as brechas que a 0033 permitia), confere IDs, motivos e
situações, confirma impressão digital idêntica antes e depois, e que o script
recusa rodar sem a 0034.

## Validação final da rodada (PostgreSQL 16 real, `priora_test`)

| Suíte | Aprovados | Falhos | Ignorados |
|---|---|---|---|
| Engine completa (inclui banco novo 0001→0034) | 569 | 0 | 0 |
| — D11 (`responsabilidadeDecisao` 25, `V11` 18, `V12` 14, `Auditoria` 2) | 59 | 0 | 0 |
| — relógios | 6 | 0 | 0 |
| — tarifas | 35 | 0 | 0 |
| — apuração e reabertura (`apuracao`, `V12`, `V13`, `V14`) | 31 | 0 | 0 |
| — fechamento | 21 | 0 | 0 |
| — D10 e fotografia (`registroDemurrage`, `V11`, `V12`, `demurrageVertical`, `demurrageTickFilas`) | 95 | 0 | 0 |
| — catálogo de migrations (`migrate`, `migration0007`, `responsavelOperacional`) | 29 | 0 | 0 |
| V1 | 25 | 0 | 0 |
| `tsc --noEmit` / `npm run build` | sem erros | — | — |

A D11 **não** está congelada: o freeze depende de executar a auditoria acima
no banco real e confirmar que não há violação com `situacao=vigente`.
