# Liberação — reconstrução das projeções legadas (G-3c)

## O que é

Projeções da Liberação gravadas antes do motor oficial (versão < 3, saída da L1a) não são decisão vigente:
- a tela as mostra como "Aguardando reavaliação pelo motor oficial" (o LIBERADO legado, como "Liberado (registro histórico)");
- a reconstrução as reavalia pelos **fatos persistidos**, pelo adaptador oficial (`liberacao/aplicacao/projecao.ts`), e grava a decisão da L1b.

Garantias:
- **Fontes:** nenhuma fonte não integrada é chamada nem presumida.
- **LIBERADO legado (Decisão A):**
  - é histórico: nunca é copiado nem apagado;
  - o processo é apresentado como **"Liberado (registro histórico)"**: não é reaberto, não gera pendência operacional e não exige confirmação do Analista por falta de evidências antigas;
  - a decisão oficial atual da L1b fica inteira na projeção, para consulta à parte na tela ("Avaliação pelas evidências atuais"), com a origem e os limites ditos;
  - se ela não comprovar a liberação, fica o registro "Decisão histórica diverge da decisão oficial atual" (`liberacao_revisoes`), mostrado de forma discreta como "Diferença entre o histórico e as evidências atuais". Ausência de evidência não é prova de erro;
  - o registro é append-only e não tem fluxo de encerramento (entrega futura); continua visível mesmo se a L1b depois comprovar a liberação;
  - o ato já feito fora da Priora não é desfeito.
- **Fila durável** (`liberacao_reconstrucoes`):
  - lotes limitados, isolamento por organização;
  - posse com dono, token e expiração; cerca pelo token na finalização;
  - posse expirada recuperada; tentativas limitadas; esgotamento visível;
  - item concluído é imutável (repetir é no-op).
- **Concorrência:** a finalização usa o mesmo bloqueio por processo do recálculo normal, recarrega os fatos depois dele e grava a projeção e o item na mesma transação.
- **Guarda no banco (0107):**
  - LIBERADO oficial (versão >= 3): irreversível e não removível;
  - a versão da projeção nunca diminui (rebaixar não é caminho de reabertura);
  - o LIBERADO legado só dá lugar à decisão oficial se o registro da liberação histórica for gravado pela **mesma** transação (a aplicação grava o registro antes da linha); o registro é conferido contra os eventos que cita.

## Master compartilhado (N-13): regra mantida (decisão V2(a))

A regra N-13 aprovada considera ativo todo processo vinculado "não LIBERADO", e só o SISCARGA com consulta fresca cria LIBERADO. Um processo liberado só pelo motor anterior continua, portanto, ativo para a trava dos vinculados: tratá-lo como não ativo mudaria a semântica da regra, e foi decidido mantê-la (V2(a)). Com as fontes de hoje isso não muda nada (a L1b não chega à ação de Master sem fontes de cliente e procedimento); quando essas fontes forem integradas, ele pode deixar a ação de Master de um vinculado ativo como não determinável ou bloqueada.

## Interruptores

| Variável | Efeito |
|---|---|
| `PRIORA_FATOS_DURAVEIS` | Liberação ligada (rotas e recálculo normal). Pré-requisito. |
| `PRIORA_LIBERACAO_RECONSTRUCAO=on` | Liga **só** o laço da reconstrução. Qualquer outro valor (ou ausente) desliga. É relido a cada tick. |

## Operação (só ADMIN; a organização é sempre a da sessão)

| Rota | Efeito |
|---|---|
| `POST /api/liberacao/admin/reconstrucao/processos/:processoId` | Pede a reconstrução de um processo (`PEDIDO_ADMIN`). Reabre um esgotado. 404 igual para processo de outra organização ou inexistente. |
| `POST /api/liberacao/admin/reconstrucao/organizacao` | Enfileira até 500 projeções legadas da organização. Repetir é seguro. |
| `GET /api/liberacao/admin/reconstrucao/status` | Mostra: pendentes, processando, concluídos, falhas retentáveis, esgotados, posses perdidas, divergências históricas e legados ainda sem item. |

Laço:
- a cada 5 min: descoberta de até 100 legados e lote de até 25 itens;
- posse de 5 min, até 5 tentativas, recuo exponencial a partir de 60 s;
- logs só com contagens.

## Implantação (uma liberação controlada, sem corte simultâneo)

1. **Migração 0107**:
   - só esquema: duas tabelas novas de operação, a tabela de revisão e a guarda do terminal estreitada a v ≥ 3;
   - nenhuma linha existente muda;
   - pode ir antes do código: o servidor atual (`4e6cdfc`) não lê as tabelas novas, e a guarda só se afrouxa para linhas legadas, que o servidor atual não regrava.
2. **Servidor novo** com `PRIORA_LIBERACAO_RECONSTRUCAO` ausente:
   - atende a tela atual (campos novos são aditivos; a tela atual os ignora);
   - o recálculo normal passa a reavaliar um LIBERADO legado quando chega um fato novo (com a revisão), mas nada roda em massa.
3. **Tela nova** (mesmo deploy do servidor, ou logo depois). Mostra:
   - legado pendente: "Aguardando reavaliação";
   - esgotado: "Reavaliação esgotada — requer intervenção";
   - LIBERADO legado: "Liberado (registro histórico)" (também pendente ou esgotado), com a diferença em aviso discreto e a decisão atual só para consulta.
   Tela antiga com servidor novo continua correta (legado continua "Aguardando reavaliação").
4. **Piloto**:
   - por organização, um ADMIN chama `POST .../organizacao` e confere o `status`;
   - opcional: `PRIORA_LIBERACAO_RECONSTRUCAO=on` em uma instância.
5. **Ativação do agendador**:
   - `PRIORA_LIBERACAO_RECONSTRUCAO=on` em todas as instâncias;
   - acompanhar o `status` até `legadosSemItem = 0` e `pendentes = processando = 0`;
   - tratar `esgotados` e `divergenciasHistoricas`.

## Reversão

- **Parar a reconstrução:** retirar `PRIORA_LIBERACAO_RECONSTRUCAO` (ou mudar para `off`) e reiniciar. O recálculo normal e a leitura continuam. Um item em andamento termina ou expira; outro trabalhador o recupera depois.
- **Voltar o código para `4e6cdfc`:**
  - seguro; a migração não é revertida (só para frente);
  - as tabelas novas ficam e a fila não se corrompe (nada as lê ou escreve);
  - projeções já reconstruídas são v3, que `4e6cdfc` exibe normalmente;
  - eventos históricos são append-only e as revisões também.
- **Não apagar** as tabelas `liberacao_reconstrucoes`, `liberacao_reconstrucao_posses_perdidas` e `liberacao_revisoes`: são o histórico da operação e das divergências.
- **Para retomar:** reimplantar o código novo e religar o interruptor. Itens concluídos não são refeitos; pendentes e expirados continuam de onde pararam.
