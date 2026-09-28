# Fase D10 v1.1 — corretiva do registro (NÃO aprovada, NÃO congelada)

> **Status:** entregue para nova auditoria. Esta correção **não** encerra a Fase
> D10 nem a declara concluída — aguarda aprovação antes de qualquer avanço
> (D11). Continua restrita a `src/demurrage-engine/**` + uma migration aditiva.

Corrige três problemas apontados na auditoria do commit `6319c70`, sem alterar
nenhuma regra congelada das Fases 7–9 (relógios, tarifas, hierarquia de fontes,
cadência, responsabilidade, minuta, fechamento) além da integração interna
estritamente necessária para reparar a consistência do próprio registro D10.
Auditoria, Courier, Liberação, Portal do Cliente, HeadCargo, telas e rotas V1
não foram tocados.

## Problema 1 — recuperação depois de falha no pós-registro

**Antes:** `registrarProcessoDemurrage` confirmava a transação principal e só
então rodava o recálculo/fotografia (`posCommit`) — fora de qualquer estado
persistente. Se essa etapa falhasse, o processo/contêineres/ledger já estavam
gravados, a chamada retornava erro, e repetir a MESMA chave só devolvia
`ja_registrado` sem nunca tentar o pós-processamento de novo — o contêiner
ficava **permanentemente** com relógios/fotografia ausentes.

**Correção:** um outbox durável, `demurrage_pos_commit_outbox` (migration
0029), com uma linha `pendente` por contêiner do processo, escrita na MESMA
transação que confirma processo/contêineres/ledger. Fora dessa transação (sem
transação longa envolvendo os cálculos derivados), `repararPosCommitOutbox`
roda **sempre** — `registrado` OU `ja_registrado` — e só toca linhas
`pendente`/`falha` (nunca `concluido`, que é NO-OP puro). Cada contêiner é
tentado independentemente: a falha de um nunca impede o reparo dos demais na
mesma chamada. Uma falha marca a linha `falha` com o erro e propaga
`PosCommitIncompletoError` (o processo principal permanece confirmado — só o
pós-processamento fica pendente); a PRÓXIMA chamada idempotente repara sem
duplicar nada.

Ganho de teste `_testeFalhaPosCommit` (só usado nos testes — nenhuma rota ou
integração o expõe) injeta a falha determinística exigida pelo roteiro.

**Teste** (`registroDemurrageV11.test.ts`, §1, 3 casos): falha injetada após o
COMMIT → processo/contêineres/ledger existem 1x; outbox registra `falha`; sem
relógios ainda. Repetir a MESMA entrada/chave → reparado (relógios aparecem,
outbox `concluido`, 2 tentativas). Repetir de novo → NO-OP (tentativas não
sobem, sem duplicação). Caso adicional: falha em UM contêiner não impede o
reparo do outro na mesma chamada. Caso adicional: `repararPosCommitOutbox`
chamado isolado sobre um registro já completo devolve `{reparados: [],
falhas: []}`.

## Problema 2 — matriz de fontes por campo

**Antes:** uma allowlist genérica (`FONTES_CONTRATO`) aceitava as mesmas 6
fontes em qualquer campo — `manual_fallback` e `outro` inclusive em House/
Master Free Time, MBL, armador etc., sem nenhuma justificativa de autoria.

**Correção:** `FONTES_POR_CAMPO` (`contrato.ts`) — uma entrada explícita por
campo, alinhada ao que cada documento plausivelmente atesta:

| Campo | Fontes autorizadas | Por quê |
|---|---|---|
| `cliente` | SI, HeadCargo, outro | nenhum documento de carga atesta o cliente Rocket |
| `house` (HBL) | House, SI, HeadCargo, outro | o Master BL não atesta o número do House |
| `mbl` | Master BL, SI, HeadCargo, outro | o House não atesta o número do Master |
| `armador` | Master BL, SI, HeadCargo, outro | o House não nomeia o armador |
| `condicaoComercial` | SI, HeadCargo, outro | termo comercial não vem de um documento de carga |
| `responsavelOperacionalMembershipId` | outro | designação INTERNA — nenhum documento externo atesta um membership |
| `tipoOriginal` | House, Master BL, SI, HeadCargo, outro | qualquer documento operacional pode informar o tipo |
| `houseFreeTimeDays` | House, SI, HeadCargo, **manual_fallback** | hierarquia já congelada (gap analysis Cap. 4) |
| `masterFreeTimeDays` | Master BL, SI, HeadCargo, **manual_fallback** | hierarquia já congelada (`masterFreeTimeService.ts`) |

`manual_fallback` só nas duas linhas de Free Time; `outro` nunca nelas (não é
mais atalho genérico); House e Master nunca se cruzam (documento de um lado
não atesta o outro). Combinação fora da matriz → `FONTE_NAO_ACEITA`
(conservador por padrão — nada foi ampliado silenciosamente).

**Governança do `manual_fallback`** (`Observado.manualFallback`):
`justificativa` (texto não vazio) + `autorMembershipId` (um
`organization_memberships.id` real da MESMA organização) — exigidos sempre
que a fonte é `manual_fallback` (`MANUAL_FALLBACK_INCOMPLETO` senão) e
rejeitados com qualquer outra fonte (`MANUAL_FALLBACK_NAO_ACEITO`). O autor é
resolvido para o `usuarios.id` correspondente (é o que
`field_observations.criado_por` já espera — governança existente desde a Fase
1) e a justificativa é gravada em `demurrage_fallback_manual_justificativas`
(migration 0029), idempotente por observação (`ON CONFLICT (observation_id)
DO NOTHING`) e append-only.

**Teste** (§2, 13 casos): negativos individualizados — `manual_fallback` em
cada um dos 7 campos não-Free-Time; `outro` em House/Master FT (processo e
contêiner); House↔Master cruzados (4 combinações); responsável só aceita
`outro` (4 fontes rejeitadas); governança incompleta (sem objeto, justificativa
vazia, autor não-UUID); `manualFallback` com qualquer outra fonte; autor de
outra organização. Positivos: um teste por fonte (SI, House, Master, HeadCargo)
cobrindo exatamente os campos em que cada uma é autorizada; um teste de
`manual_fallback` completo (promove o valor, grava a governança, autor
correto em `criado_por`, não duplica ao reprocessar a mesma observação).

## Problema 3 — tipo original e normalizado da mesma observação

**Antes:** `container_equipamento_original` (tipo original exibido) era
sobrescrita **incondicionalmente** a cada chamada, enquanto
`containers.container_type_id` (tipo normalizado) só promovia por prioridade
— dois caminhos de decisão independentes. Uma fonte inferior podia substituir
o tipo original exibido mesmo quando não substituía o normalizado, e a
fotografia podia acabar mostrando tipo original de uma fonte e normalizado de
outra.

**Correção:** `container_equipamento_original` ganhou `observation_id`
(migration 0029, aponta para `field_observations`). Uma ÚNICA comparação de
prioridade (contra a fonte hoje selecionada) decide se a observação vence; só
quando vence é que tipo original exibido E tipo normalizado
(`containers.container_type_id`) são atualizados **juntos**, a partir da
MESMA observação — nunca dois caminhos separados. Quando a observação
vencedora não normaliza, o normalizado é limpo (`NULL`), nunca deixado órfão
apontando para uma fonte já superada. Quando a mesma fonte relata o mesmo
instante com valor diferente (conflito de mesma autoridade), a observação
segue no ledger (auditável) mas não altera a seleção — mesmo padrão já usado
nos campos do processo (`aplicarCampoProcesso`).

**Teste** (§3, 3 casos): fonte superior define o tipo → fonte inferior com
valor diferente NÃO promove (original e normalizado continuam da fonte
superior; observação inferior preservada no ledger) → fonte superior válida e
MAIS RECENTE promove os dois coerentemente (o `observation_id` selecionado
aponta exatamente para essa observação). Caso adicional: fonte superior que
NÃO normaliza limpa o normalizado (nunca deixa order órfão de fonte inferior
superada). Caso adicional: conflito de mesma fonte/mesmo instante é reportado
e não altera a seleção.

## Arquivos

| Arquivo | Mudança |
|---|---|
| `src/demurrage-engine/db/migrations/0029_demurrage_registro_v1_1.sql` | **Novo**, aditivo. `demurrage_pos_commit_outbox`; `ALTER TABLE container_equipamento_original ADD COLUMN observation_id`; `demurrage_fallback_manual_justificativas`. Não reescreve a 0028. |
| `src/demurrage-engine/registro/contrato.ts` | `FONTES_POR_CAMPO` (substitui a allowlist genérica); `ManualFallbackGovernanca`; `validarObservado`/`validarFreeTime` passam a receber o campo da matriz; códigos `MANUAL_FALLBACK_INCOMPLETO`/`MANUAL_FALLBACK_NAO_ACEITO`. |
| `src/demurrage-engine/registro/registrarProcessoDemurrage.ts` | Outbox de pós-commit (grava + `repararPosCommitOutbox` + `PosCommitIncompletoError`, substitui o antigo `posCommit`); tipo original/normalizado decididos por uma única comparação de prioridade; `resolverAutorManualFallback` + `registrarGovernancaManualFallback`; `criadoPor` do Free Time passa a ser o `usuario_id` resolvido do membership quando a fonte é `manual_fallback`. |
| `src/demurrage-engine/__tests__/registroDemurrageV11.test.ts` | **Novo** — 19 testes (§1: 3, §2: 13, §3: 3) cobrindo os três problemas. |
| `src/demurrage-engine/__tests__/registroDemurrageHelpers.ts` | `o()` passa a aceitar `manualFallback` opcional. |
| `migrate.test.ts`, `migration0007.test.ts`, `responsavelOperacional.test.ts`, `testDb.ts` | Catálogo de migrations/tabelas com organização e truncagem passam a incluir a 0029 e as duas tabelas novas. |

Nenhum arquivo de Auditoria, Courier, Liberação, Portal do Cliente, telas ou
rotas V1/Outlook foi tocado. Nenhuma rota pública ou tela de criação manual de
processo foi adicionada — confirmado pelo teste de varredura estática já
existente (`registroDemurrage.test.ts`, Gate 1), que continua verde e agora
também cobre os arquivos novos por importação transitiva.

## Validação final

| Verificação | Resultado |
|---|---|
| Gates D10 (1–6) | Reexecutados — `registroDemurrage.test.ts` (30) + `demurrageVertical.test.ts` (8), todos verdes, mais os 19 novos desta corretiva (`registroDemurrageV11.test.ts`) |
| Suíte completa da engine (`npm run test:demurrage-engine`) | **472 testes executados, 472 aprovados, 0 pulados, 0 cancelados** — contra PostgreSQL real (`DATABASE_URL`/`DEMURRAGE_DATABASE_URL` apontando para `priora_test`), não simulado |
| Suíte V1 (`npm test`) | **25 testes executados, 25 aprovados, 0 pulados** |
| `npx tsc --noEmit` | sem erros |
| `npm run build` | sem erros |
| Migration | `0029_demurrage_registro_v1_1.sql` — aditiva; 0028 intacta |

Detalhamento dos 472: 453 já existiam antes desta corretiva (incluindo os 38
testes dos Gates 1–3 e 8 dos Gates 4–6 da Fase D10 original) + **19 novos**
desta v1.1 (`registroDemurrageV11.test.ts`). Nenhum teste foi pulado em
nenhuma execução — todas rodaram com PostgreSQL real.

## O que esta corretiva NÃO fez

- Não alterou Auditoria, Courier, Liberação, Portal do Cliente, telas ou rotas
  V1/Outlook.
- Não criou integração real com HeadCargo.
- Não criou rota pública nem tela de criação manual de processo.
- Não alterou fórmulas temporais, tarifas, cadência de tracking, tracking
  compartilhado, responsabilidade (Fase 11 continua inexistente) ou as regras
  de minuta/fechamento das Fases 7–9.
- Não reescreveu a migration 0028.
- **Não declara a Fase D10 aprovada, congelada ou concluída.** Esta entrega
  aguarda nova auditoria antes de qualquer avanço para a Fase D11.
