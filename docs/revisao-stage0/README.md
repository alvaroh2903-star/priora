# Revisão de código — Stage 0 v2 (diagnóstico da Relatórios)

Documentação para a revisão de código. Este diretório não contém código.

| Documento | Conteúdo |
|---|---|
| [`Proposta_Integracao_Medicao.md`](Proposta_Integracao_Medicao.md) | **Para aprovação:** revisão a integrar, sequência mínima de medição, tetos, paradas, desativação e rollback |
| [`Pacote_Revisao_Stage0_v2.md`](Pacote_Revisao_Stage0_v2.md) | Pacote de revisão do Stage 0 v2, com a seção 12. A abertura avisa que o `ddb831e` substitui as descrições do limite de corpo e do escopo da coleta |
| [`../diagnostico-relatorios-stage0.md`](../diagnostico-relatorios-stage0.md) | Procedimento: ativação, limites, auth/isolamento, medição real (não executada) e rollback |
| [`Priora_Diagnostico_Courrier_Rev3.md`](Priora_Diagnostico_Courrier_Rev3.md) | Relatório completo do diagnóstico, revisão 3, com a nota sobre achados desatualizados |
| [`Matriz_Requisitos_Courrier.md`](Matriz_Requisitos_Courrier.md) | Matriz de requisitos por identificador, com a revisão de código avaliada |

**Código revisado:** `8e055b0` (tip da Linha A) → `ddb831e`. A comparação está em `8e055b0...ddb831e`.

O diagnóstico fica **desligado** por padrão. Para ligar, são necessárias cinco variáveis: `PRIORA_DIAG_RELATORIOS`, `PRIORA_DIAG_SALT` e a seleção `PRIORA_DIAG_ORG`, `PRIORA_DIAG_OPERADOR` e `PRIORA_DIAG_CONTA`. Não houve publicação, ativação nem medição em produção.
