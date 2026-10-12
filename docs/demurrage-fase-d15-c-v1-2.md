# D15-C v1.2 — Corretiva: bypass de visibilidade de rascunho no Termo por Embarque

**Baseline:** `0a0ee9c` (D15-C v1.1).

## Defeito

A D15-C v1.1 fechou o bypass de rascunhos em `selecionarVigente` (seleção por
vigência), mas o caminho de Termo por Embarque resolve a tabela por **ID fixo**
na condição comercial, e esse caminho chamava `TariffTableRepository.buscarPorId`
— método deliberadamente SEM filtro de `ativada_em`, porque administração/revisão
precisa inspecionar rascunhos.

Resultado: uma condição comercial podia referenciar um rascunho, e o cálculo de
produção usava e congelava esse rascunho via `valores_apurados`, contornando o
próprio gate de publicação que a v1.1 introduziu.

## Correção

Duas leituras distintas, nunca uma só:

- `buscarPorId` — **inalterado**. Continua sem filtro de `ativada_em`. Uso
  exclusivo de administração/revisão.
- `buscarAtivadaPorId` — **novo método**, dedicado à produção. Exige
  `ativada_em IS NOT NULL`; se o ID existe mas é rascunho, devolve
  `{ tabela: null, motivo: 'TARIFF_VERSION_NOT_ACTIVATED' }` — nunca `null`
  genérico, nunca zero.

O branch `termoTipo === 'embarque'` em `recalcularApuracao.ts` passou a chamar
`buscarAtivadaPorId`. Sem tabela ativada, o motor devolve `UNAVAILABLE` com o
motivo explícito via `unavailable()`, sem fabricar `tabelaId`/`versaoTabela`/`total`.
Nenhuma linha em `valores_apurados` referencia o rascunho.

Nenhuma migration foi necessária — correção inteiramente na camada de aplicação
(um método novo + a troca de um único call site de produção, confirmada por
varredura de todos os usos de `buscarPorId` em `src/`).

Após `ativar()`, a mesma condição comercial usa a tabela normalmente na próxima
recálculo autorizado. Processos FINAL seguem protegidos pela D15-A — ativar a
tabela depois não dispara recálculo automático.

## Testes (`d15cV12.test.ts`, 10 cenários obrigatórios, 6 blocos `test()`)

1–4. Condição referenciando rascunho → produção não usa, `UNAVAILABLE` com
     `TARIFF_VERSION_NOT_ACTIVATED`, nenhum `valores_apurados` referenciando o
     rascunho, relógio preservado.
5. Rascunho permanece editável após cálculo rejeitado.
6. `buscarPorId` (administração) continua devolvendo o rascunho.
7–8. Após `ativar()`, a mesma condição usa a tabela; a primeira apuração válida
     congela a versão.
9. FINAL inalterado — sem recálculo automático ao ativar depois.
10. D15-C v1.0 e v1.1 permanecem verdes (validado na regressão completa).

## Regressão completa

| Suíte | Resultado |
|---|---|
| Demurrage Engine completo (69 arquivos) | 938/938 ✅ |
| V1 (`npm test`) | 25/25 ✅ |
| D13 UI (`npm run test:demurrage-ui`) | 64/64 (2 skips pré-existentes) ✅ |
| `tsc --noEmit` | limpo ✅ |
| Build de produção (`npm run build`) | limpo ✅ |

Inclui D15-A v1.0–v1.3, D15-B e v1.1, D15-C v1.0, v1.1 e v1.2 — todos dentro do
Demurrage Engine completo.

## Status

D15-C **não** está declarada aprovada ou congelada. D16 **não** foi iniciada.
Aguardando auditoria final da D15.
