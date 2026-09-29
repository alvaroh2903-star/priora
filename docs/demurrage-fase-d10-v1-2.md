# Fase D10 v1.2 — corretiva final do registro (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria. Não declara a Fase D10 concluída nem
> congelada; nada da D11 foi iniciado. Escopo: `src/demurrage-engine/**` +
> migration aditiva 0030. 0028 e 0029 não foram reescritas.

Base: commit `521910a` (D10 v1.1). Corrige exatamente os quatro pontos da
auditoria.

## 1. Evidência obrigatória no fallback manual

`manual_fallback` em House ou Master Free Time (processo ou contêiner) agora
exige, **simultaneamente**: justificativa não vazia, `evidenciaRef` não vazia
e `autorMembershipId` válido. Evidência `null`, ausente, `''` ou só espaços →
`MANUAL_FALLBACK_INCOMPLETO` (`campo: …evidenciaRef`), na validação pura —
nada é gravado.

Auditabilidade depois do registro: justificativa e autor em
`demurrage_fallback_manual_justificativas` (append-only), evidência em
`field_observations.evidencia_ref` da observação selecionada e o usuário do
autor em `field_observations.criado_por`.

## 2. Autor interno e aviso ao gestor

`resolverAutorManualFallback` passou a exigir papel interno — a **mesma**
regra já aprovada para o responsável operacional (migration 0007, Decisão 3):
`ANALYST` (operacional), `MANAGER`, `ADMIN`. `CLIENT` →
`MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO`. Outra organização →
`MANUAL_FALLBACK_INCOMPLETO` (`autor_membership_invalido`). Nenhum papel novo.
O membership é lido com `FOR SHARE` (mesmo cuidado da 0007 contra troca
concorrente de papel).

**Aviso durável:** cada fallback cria, na mesma transação do registro, uma
entrega `PENDING` por gestor (`MANAGER`/`ADMIN` da organização — mesmo critério
dos avisos de divergência de Free Time) em `demurrage_fallback_manual_avisos`.
Nenhuma comunicação externa acontece dentro da transação. Idempotente:
`UNIQUE (justificativa_id, destinatario_membership_id)`.

**Por que outbox próprio:** `ft_divergencia_entregas` é atado a
`ft_divergencias` por FK e `tracking_alert_deliveries` a `tracking_incidents`
— nenhum comporta este evento sem alterar regra congelada. O protocolo é o
**mesmo** (`registro/avisosFallbackManual.ts`,
`processarAvisosFallbackManualPendentes`): claim persistente de uma entrega por
vez com `claim_token`, envio fora de transação, finalização condicionada ao
token vigente, `PROCESSING` vencido recuperável, `FAILED` reprocessável.

**Limitação desta fase:** o worker e a porta `AvisoFallbackManualTransport`
existem e estão testados, mas **não** foram ligados ao tick do scheduler
(`src/demurrage/schedulerBootstrap.ts`) — cadência/scheduler estão fora do
escopo autorizado. Até essa ligação, as entregas ficam `PENDING` (duráveis,
nada se perde). Decisão pendente para a próxima etapa aprovada.

## 3. Compatibilidade com dados anteriores à 0029 (migration 0030)

**Backfill seguro:** cada linha de `container_equipamento_original` sem
`observation_id` é casada com as observações `tipoEquipamentoOriginal` por
**todos** os atributos — contêiner, campo, fonte, instante observado, valor e
organização. Só vincula com **exatamente uma** candidata. Zero ou mais de uma →
nada é escolhido: a linha fica intacta (`observation_id` NULL, dados
preservados) e nasce uma pendência aberta `tipo_selecao_sem_observacao` em
`demurrage_pendencias`, com motivo, candidatas e o retrato da seleção legada.

Observação sobre "mais de uma": a `UNIQUE (entidade_tipo, entidade_id, campo,
fonte, observado_em)` do ledger impede, estruturalmente, duas observações com
os mesmos atributos; o caso realmente ambíguo no dado legado é a seleção
sobrescrita pelo bug da 0028 (valor que a fonte/instante gravados não atestam,
com "iscas" plausíveis: mesmo valor em outro instante, mesmo instante com
outro valor). O teste cobre exatamente esse caso — nenhuma associação é feita.
O código trata `> 1` do mesmo jeito, por robustez.

**Guarda depois do backfill:**
- `CHECK (observation_id IS NOT NULL) NOT VALID` — toda escrita nova (INSERT e
  UPDATE) exige o vínculo. **Razão técnica do `NOT VALID`** (em vez de
  `NOT NULL`): as linhas legadas que não puderam ser vinculadas com segurança
  permanecem NULL para auditoria, com pendência aberta; `NOT NULL` obrigaria
  escolher arbitrariamente ou apagar dados.
- Trigger `container_equip_observation_coerente`: o `observation_id` precisa
  ser do **mesmo** contêiner, campo `tipoEquipamentoOriginal`, com a mesma
  fonte/instante/valor gravados na seleção.

## 4. Concorrência no outbox pós-commit

`demurrage_pos_commit_outbox` ganhou `estado = 'processando'`, `claim_token`,
`worker_id`, `expira_em` e `geracao` (CHECK: `processando` ⇔ token + worker +
prazo). `repararPosCommitOutbox` segue o padrão de `ft_divergencia_entregas`/
`recalculo_outbox`:

1. claim de **uma** linha por vez (UPDATE autocommit + `FOR UPDATE SKIP
   LOCKED`) — `pendente`, `falha` ou `processando` vencido;
2. confirma a posse e executa recálculo + fotografia fora de transação longa
   (o perdedor nem executa);
3. finaliza só com o `claim_token` vigente; se um registro novo incrementou a
   `geracao` durante o claim, a linha volta a `pendente` e o dono a reprocessa
   na mesma chamada (nenhum pedido se perde).

`concluido` nunca é reivindicado (no-op). Nenhuma linha fica presa:
`processando` vence e é recuperado; `falha` libera a posse. No intervalo
residual de um claim vencido ainda em execução, o recálculo é idempotente
(`input_hash`) e a fotografia deduplicada por hash sob lock consultivo — o
teste confirma zero fotografias/valores duplicados.

`processarPosCommitOutboxPendentes` varre todo o outbox (qualquer processo);
como o worker de avisos, **não** está ligado a loop nesta fase.

**FK contêiner ∈ processo:** `containers_id_processo_unique UNIQUE (id,
processo_id)` (trivialmente única — `id` é PK; existe só para a FK) +
`demurrage_pos_commit_outbox_container_processo_fk (container_id, processo_id)`.
Contêiner de outro processo da mesma organização é rejeitado pelo banco.

## Testes (`registroDemurrageV12.test.ts`, 20)

| § | Testes |
|---|---|
| 1 | puro: sem evidência (House/Master × processo/contêiner; `null` e chave ausente); vazia/só espaços; completo aceito. PG: rejeições não gravam nada; completo deixa justificativa, evidência e autor auditáveis (justificativa append-only). |
| 2 | outra organização rejeitada; `CLIENT` rejeitado; `ANALYST`/`MANAGER`/`ADMIN` aceitos; aviso durável `PENDING` só para gestores (CLIENT e analista autor excluídos); reprocessamento (mesma chave e chave nova) não duplica; falha no transporte → `FAILED` com posse liberada → reenvio `SENT`; `SENT` não reenviado; entrega com posse vencida recuperada e o worker antigo não finaliza. |
| 3 | caminho REAL: `DROP SCHEMA` → migrations até 0028 → seleção no formato antigo → 0029 + 0030 → vínculo à observação correta (com iscas), original × normalizado coerentes, caso indeterminável sem associação e com pendência, dados preservados, guarda (INSERT sem vínculo, vínculo incoerente, UPDATE de linha legada sem vínculo — todos recusados). Banco novo 0001→0030 com registro pelo contrato. |
| 4 | dois workers simultâneos → um executa; perdedor não executa nem altera a posse; claim vencido recuperado e o antigo não finaliza nem toca a posse do novo dono; falha recuperável; concluído no-op; registro novo durante o claim (geração) reprocessado; FK rejeita contêiner de outro processo; `PosCommitIncompletoError` + reparo; concorrência/claim vencido sem fotografia ou valor duplicado. |

Testes de v1.1 ajustados só onde a regra nova exige: fallbacks completos
passaram a trazer evidência; o resultado de `repararPosCommitOutbox` inclui
`possePerdida`. A varredura estática de imports cobre o novo
`avisosFallbackManual.ts`.

## Arquivos

| Arquivo | Mudança |
|---|---|
| `db/migrations/0030_demurrage_registro_v1_2.sql` | **Novo**, aditivo: pendência `tipo_selecao_sem_observacao`; backfill; `CHECK … NOT VALID`; trigger de coerência; `containers_id_processo_unique`; FK contêiner∈processo; claim/geração no outbox; `demurrage_fallback_manual_avisos`. |
| `registro/contrato.ts` | evidência obrigatória no `manual_fallback`; código `MANUAL_FALLBACK_AUTOR_NAO_AUTORIZADO`. |
| `registro/registrarProcessoDemurrage.ts` | papel interno do autor; aviso aos gestores; claim de posse no reparo; geração no upsert do outbox; `processarPosCommitOutboxPendentes`. |
| `registro/avisosFallbackManual.ts` | **Novo** — worker de entrega com transporte injetável. |
| `__tests__/registroDemurrageV12.test.ts` | **Novo** — 20 testes. |
| `__tests__/registroDemurrageV11.test.ts`, `registroDemurrage.test.ts` | ajustes descritos acima. |
| `__tests__/migrate.test.ts`, `migration0007.test.ts`, `responsavelOperacional.test.ts`, `testDb.ts` | catálogos incluem 0030 e a tabela nova. |

Nada em Auditoria, Courier, Liberação, Portal, HeadCargo, telas, rotas públicas,
relógios, tarifas, cadência, tracking compartilhado, responsabilidade, minutas
ou fechamento. Nenhuma referência ao serviço em `src/routes`, `src/index.ts`,
`public` ou `src/demurrage` (varredura + teste estático).

## Validação

| Verificação | Aprovados | Falhos | Ignorados |
|---|---|---|---|
| Engine completa (`npm run test:demurrage-engine`) | 492 | 0 | 0 |
| — dos quais D10 (gates 1–6 + v1.1 + v1.2 + migrations) | 78 | 0 | 0 |
| V1 (`npm test`) | 25 | 0 | 0 |
| `tsc --noEmit` / `npm run build` | sem erros | — | — |

Por gate (nomes `D10 gateN` no log da engine): G1 12, G2 6, G3 11, G4 2, G5 1,
G6 1 — todos aprovados. Todas as execuções usaram **PostgreSQL 16 real**
(`DATABASE_URL`/`DEMURRAGE_DATABASE_URL` → `priora_test`); nenhum teste foi
pulado. Migrations validadas em banco novo (0001→0030) e no caminho
0028→0029→0030 com dados preexistentes.
