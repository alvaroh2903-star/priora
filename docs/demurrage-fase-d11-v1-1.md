# Fase D11 v1.1 — corretiva (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria. Base: `78c4e9e` (D11 G1–G7). Corrige só
> os quatro pontos pedidos. Nenhuma tela, rota ou integração real com
> Liberação.

## Migration `0033_responsabilidade_v1_1_corretiva.sql` (aditiva)

`0031` e `0032` não foram reescritas. A `0033`:

- substitui, via `CREATE OR REPLACE`, a função de validação de INSERT da
  decisão criada na `0031` (mesmo corpo + o ramo `NAO_APLICAVEL` ampliado);
- remove o trigger adiado ligado só a `responsabilidade_decisao_dias` e cria
  um trigger adiado em `responsabilidade_decisoes` (dispara por decisão, com
  ou sem linhas de dia);
- cria um trigger em `valores_apurados` que invalida a decisão quando o valor
  ativo do cliente muda.

Nenhuma tabela ou coluna nova. Nenhuma tabela nova com `organization_id`.

## 1. `NAO_APLICAVEL` restrito

Uma decisão `NAO_APLICAVEL` / base `NAO_APLICAVEL` / `DIFERENCA_COMERCIAL_FREE_TIME`
só existe quando **todas** as condições valem:

| Condição | Recusa (serviço) | Recusa (banco) |
|---|---|---|
| relógio do cliente `OK` | `SEM_APURACAO_DETERMINAVEL` | idem |
| cliente com **zero** dias | `BASE_RELOGIO_INVALIDA` | idem |
| relógio do cliente fechado na devolução | `INTERVALO_ABERTO` | idem |
| relógio Rocket `OK` (não pendente/inválido) | `NAO_APLICAVEL_INVALIDO` / `relogio_rocket_nao_ok` | idem |
| Rocket com ≥ 1 dia (não "ambos zero") | `NAO_APLICAVEL_INVALIDO` / `ambos_relogios_zero_dias` | idem |
| relógio Rocket fechado na devolução | `INTERVALO_ABERTO` | idem |
| House e Master Free Time determináveis | `NAO_APLICAVEL_INVALIDO` / `free_time_indeterminavel` | idem |
| House > Master | `NAO_APLICAVEL_INVALIDO` / `house_free_time_nao_maior_que_master` | idem |

No fluxo normal, relógios `OK` já implicam Free Time presente, e cliente zero
com Rocket positivo já implica House > Master. As duas últimas verificações
cobrem o caso em que o Free Time do contêiner muda depois de os relógios
terem sido projetados e antes do recálculo. Os testes criam esse estado
alterando o Free Time do contêiner por SQL.

## 2. Cobertura completa mesmo sem linhas de dia

A restrição adiada agora pertence à decisão. No `COMMIT` o banco garante:

- contagem Rocket = `dias_rocket` e contagem cliente = `dias_cliente`;
- em `RELOGIO_CLIENTE`, cobertura de todos os dias reais do relógio, sem buraco;
- nenhuma decisão com dias declarados e zero linhas gravadas;
- em `RELOGIO_ROCKET`, pelo menos um dia Rocket concreto (o CHECK de coerência
  da `0031` já exige `dias_rocket ≥ 1`; a restrição adiada exige que as linhas
  existam).

`NAO_APLICAVEL` (0/0) continua sendo o único caso sem linhas.

## 3. Base financeira versionada

Para `RELOGIO_CLIENTE`, o serviço grava em `base.valorCliente`: `id` e
`inputHash` do `valores_apurados` ativo do cliente, motor comercial, tabela,
versão da tabela, total, moeda e `faixasAplicadasHash` (hash estável de
`faixas_aplicadas`). Isso é gravado também quando o valor está indisponível,
com os campos numéricos nulos. As diárias por dia continuam vindo da
expansão de `faixas_aplicadas` desse mesmo valor apurado, e o serviço
verifica que Rocket + cliente = `total` antes de gravar.

**Invalidação pelo valor:** o novo trigger em `valores_apurados` dispara
quando nasce um valor ativo do cliente (`relogio_tipo = 'cliente'`, `OPEN` ou
`FINAL`). Se o `id` desse valor for diferente do `base.valorCliente.id` da
decisão vigente, o trigger:

- zera a projeção (volta a `EM_ANALISE`);
- registra `RESPONSABILIDADE_INVALIDADA` com `motivo = 'VALOR_CLIENTE_RECALCULADO'`.

Consequências:

- **O hash do relógio não participa dessa verificação.** O registro de valores
  é idempotente por `input_hash`, então um recálculo sem mudança não cria
  linha e não dispara nada.
- **Histórico preservado.** A decisão, os dias e o valor apurado antigo
  continuam no histórico (o valor antigo fica `SUPERSEDED`).
- **Fechamento bloqueado** pelo gate existente até uma nova decisão.
- **Exposição ao armador não interfere.** Valores `rocket` não disparam o
  trigger.

## 4. Conflito na sugestão da Liberação

`sugerirResponsabilidade` deixou de usar "último evento vence":

- **Conflito.** Um dia atribuído a lados diferentes por dois eventos vai para
  `diasAmbiguos` e não entra em `periodos`.
- **Sem precedência.** A ordem dos eventos não altera o resultado, e um
  terceiro evento concordante não desempata.
- **Duplicatas.** Eventos do mesmo lado no mesmo dia são consolidados.
- **Completude.** O novo campo `completa` só é `true` sem dias ambíguos e sem
  dias não atribuídos.

A função continua pura, sem decisão e sem período fabricado.

## Evidência (`__tests__/responsabilidadeV11.test.ts`, 18 testes, PostgreSQL real)

| Ponto | Testes |
|---|---|
| 1 | válido aceito; ambos zero; Rocket pendente; cliente com demurrage; Free Time indeterminável e House ≤ Master (serviço **e** SQL direto); SQL direto ambos zero |
| 2 (SQL direto, sem serviço) | `RELOGIO_CLIENTE`: zero linhas → `COMMIT` falha; parcial → falha; declara 4 de 5 → falha; completa → confirma · `RELOGIO_ROCKET`: zero linhas → falha; dia concreto → confirma; declarar 0 dias → CHECK recusa · `NAO_APLICAVEL` sem linhas → confirma |
| 3 | casos 1–6 num fluxo (tarifa vigente → nova versão da tabela com relógio intacto → invalidação `VALOR_CLIENTE_RECALCULADO` → fechamento bloqueado → nova decisão com as novas faixas → soma = novo total → fechamento liberado); caso 7 (exposição Rocket não invalida); caso 8 (indisponível → disponível, nova versão auditável); recálculo idempotente não invalida |
| 4 | conflito → ambíguo e incompleta, ordem irrelevante; duplicata do mesmo lado consolidada; terceiro evento não desempata |
| migração | 0001–0032, decisões criadas, `0033` aplicada: decisões/dias/projeção intactos, triggers corretos, correção sem dias falha no `COMMIT`, decisão pré-0033 fecha normalmente |

Catálogos de migration atualizados: `migrate.test.ts`,
`responsavelOperacional.test.ts` e `registroDemurrageV12.test.ts`.

## Validação (PostgreSQL 16 real, `priora_test`)

| Suíte | Aprovados | Falhos | Ignorados |
|---|---|---|---|
| Engine completa (inclui banco novo 0001→0033) | 553 | 0 | 0 |
| — D11 v1.1 (`responsabilidadeV11`, inclui 0032→0033) | 18 | 0 | 0 |
| — D11 (`responsabilidadeDecisao`, inclui projeção incompatível) | 25 | 0 | 0 |
| — relógios (`relogios`) | 6 | 0 | 0 |
| — tarifas (`tariffs`) | 35 | 0 | 0 |
| — apuração + reabertura (`apuracao`, `apuracaoV12/V13/V14`) | 31 | 0 | 0 |
| — fechamento (`closing`) | 21 | 0 | 0 |
| — D10 / fotografia (`registroDemurrage`, `V11`, `V12`, `demurrageVertical`, `demurrageTickFilas`) | 95 | 0 | 0 |
| — catálogo de migrations (`migrate`, `migration0007`) | 19 | 0 | 0 |
| V1 | 25 | 0 | 0 |
| `tsc --noEmit` / `npm run build` | sem erros | — | — |
