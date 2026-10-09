# Liberação — Plano de implementação (L0–L11, S1–S8)

> **Status:** plano aprovado entre 2026-10-08 e 2026-10-09. A L0-A e a L0-A.1 foram aceitas. A L0-B se materializa com o commit documental que contém este plano.
> **Nenhuma fase depois da L0 está autorizada.** Cada fase, a começar pelo diagnóstico de S6, exige autorização explícita.
>
> **Autoridade:** Blueprint congelado (`docs/liberacao-blueprint-v1.fonte.md`) → decisões aprovadas
> (`docs/liberacao-decisoes.md`) → este plano → implementação.
>
> **Substrato técnico:** `a4b07b38a2ce520f4be3ed3c363f3a688b6a05d4`. A autorização é só técnica; ver `docs/liberacao-fase-l0.md`.

## 1. Regras de execução

- **Regras transversais:**
  - identidade compartilhada + domínios separados + fatos reutilizados (N-4);
  - Processo = 1 House (H-4);
  - escopos de propagação (N-9);
  - idempotência (N-16);
  - três dimensões do fato (N-17);
  - divergência em quatro estados (N-14);
  - "indisponibilidade da fonte não é mudança do mundo real";
  - nunca inventar hora, N-19 + fallback de fuso.

  Todos os detalhes estão em `docs/liberacao-decisoes.md`.
- **Princípio de eficiência:** máxima precisão operacional com o mínimo de recursos necessários. A correção operacional sempre prevalece sobre a economia (decisões §6).
- **Integração ausente:** é DEPENDÊNCIA TÉCNICA PENDENTE. Mock só em desenvolvimento e teste, identificado. Nenhum checkbox manual permanente.
- **Preflight obrigatório em todo teste de banco:**
  - URL de dev e URL de teste definidas e diferentes;
  - `DATABASE_URL` ausente;
  - conexão real conferindo que cada URL aponta para o banco esperado;
  - qualquer falha aborta os testes (procedimento em `docs/liberacao-fase-l0.md` §7).
- **Restrição operacional do scheduler:** enquanto não houver kill switch aprovado, não se inicia a Priora com banco configurado em ambiente onde credenciais reais de tracking ou Graph possam ser alcançadas.
- **Herança da Demurrage:** a Liberação não usa regras funcionais da Demurrage como autoridade. Código herdado que conflite com o Blueprint ou com as decisões se adapta a eles.

---

## 2. Fases L0–L11

### L0 — Preparação
- **L0-A, qualificação isolada do candidato:**
  - worktree isolada e cluster PostgreSQL temporário;
  - migrations `0001`–`0034`;
  - typecheck, build e todas as suítes.
- **L0-A.1, extensão da qualificação:** Node 20, diagnóstico da vulnerabilidade crítica e restrição do scheduler.
- **L0-B, materialização:**
  - fast-forward de `48ba7c1` para `a4b07b3`;
  - os quatro documentos da Liberação;
  - um commit documental e o push.
- **Evidências:** `docs/liberacao-fase-l0.md`.

### L1 — Domínio puro
Sem I/O: nenhum import de `pg`, `express`, `fs` ou Graph. Fica em `src/liberacao/dominio/`, testado com `node --test`.

- **L1a — fundamentos (no caminho crítico)**
  - Objetivo:
    - identidade (processo, Master, vínculo como fato);
    - propagação por escopo (N-9) e vínculo tardio (N-15);
    - fato com três dimensões (N-17); máquinas do N-14 e do N-16;
    - modalidade identificada × resolvida (cap. 21);
    - Master físico (cap. 22, H-2); House pelo caminho B (H-2);
    - etapa, bloqueador e próxima ação como saídas independentes (cap. 4, 33). A etapa sai só de marcos confirmados (decisões D-6).
  - Pronto quando: há um teste por regra, e os cenários 11 (propagação) e 12 do cap. 43 passam com fixtures.
- **L1b — regras completas (fora do caminho crítico)**
  - Objetivo:
    - T-10 (D-2); T-48h (N-19 + fallback); condição do N-10;
    - janela de 48h (H-10, com a exceção Maersk);
    - lado cliente (cap. 14–19; H-5, H-14, H-15);
    - matriz (cap. 26; H-12, H-13);
    - N-12 e N-13; override (H-16); ordenação (N-11 corrigido, D-1 a D-5); conclusão (cap. 11, 39).
  - Pronto quando: os 15 cenários do cap. 43 passam com fixtures e não existe limiar além de T-10, T-48h e 48h.

### L2 — Fundação de persistência da Liberação
- **Objetivo:**
  - projeção por processo: as três dimensões e os motivos de "não determinável";
  - histórico append-only com autor, data/hora, estado anterior e posterior, evidência e justificativa (cap. 6);
  - pendências com identidade estável;
  - componente neutro de evidência e divergência (N-14).
- **Regras:**
  - FK composta para `processos (id, organization_id)` (`0024`);
  - imutabilidade pelos padrões `forbid_mutation()` (`0004`) e `forbid_organization_change()` (`0007`);
  - reingestão idêntica não gera linha nem recálculo (N-16);
  - tabelas de cada funcionalidade nascem na fase que as usa (YAGNI); por exemplo, os episódios regulatórios do T-48h nascem na L5.
- **Precisa de:** L1a e S6.
- **Onde:** `src/liberacao/persistencia/` e migrations `0100_liberacao_*`.
- **Pronto quando:** a suíte Demurrage passa com as migrations novas aplicadas; os testes de idempotência e imutabilidade passam; nenhum objeto da baseline é alterado.

### L3 — Referência temporal (consome S3)
- **Objetivo:**
  - ETA, ATA/chegada e atracação prevista/confirmada, com precisão e fuso, vindas de S3; sem polling próprio;
  - grupo temporal: ATA ocorrida → ETA conhecida → ETA desconhecida ("Referência temporal indisponível");
  - condição do N-10 (Classe A), sem algoritmo de "ETA ambígua".
- **Precisa de:** S3, L2, L1b.
- **Pronto quando:** os testes de precisão, fuso e fallback passam, e a reingestão idêntica não gera evento.

### L4 — Fatos de Courier e Auditoria, com propagação
- **Objetivo:**
  - Master físico pela conferência do MBL do processo (S1);
  - House pelo caminho B (S1);
  - vínculo Processo↔Master (S2-mín; H-7);
  - propagação no escopo Master;
  - vínculo tardio (N-15, D-7);
  - evidência válida que contradiz o "Recebido" abre divergência sem apagá-lo (cap. 22).
  - Os fatos de S1/S2 são lidos por referência, sem cópia.
- **Precisa de:** S1, S2-mín, S6, L2.
- **Pronto quando:**
  - os cenários 11 (propagação) e 12 (Courier sem atualização = "não confirmável", nunca "não recebido") passam com dados persistidos;
  - os fatos sobrevivem à troca de conta;
  - a Liberação faz zero chamadas de OCR.

### L5 — CE House, SISCARGA e conclusão
- **Objetivo:**
  - **CE House:** CE House e desconsolidação vindos de S2 (cap. 8); "aguardando CE House / desconsolidação" (cap. 9).
  - **T-48h** (N-19 + fallback): uma única condição regulatória ativa por processo, com base na atracação prevista no porto final ou, na falta dela, na ETA. Retirada e reativação sem alerta duplicado.
  - **Culpa da Rocket:** só com a evidência de envio (S2, N-8, H-17).
  - **SISCARGA:** frete e fiscal separados; o fiscal roda por gatilho e é obrigatório antes da conclusão (cap. 11); a exceção e-CAC fica visível (cap. 12).
  - **Mudança de rota:** segue a sequência de retificação (cap. 13).
  - **Conclusão:**
    - LIBERADO só com consulta fresca (N-17) e terminal (cap. 39, N-16);
    - CE Master 72h documentado, sem alerta (cap. 9–10);
    - frequência do SISCARGA configurável (H-11).
- **Precisa de:** S2 completo (que depende de S7), S3, L3, S8-SISCARGA.
- **Pronto quando:** passam os cenários 9, 10, 13 e 14.

### L6 — Master: Wave, emissão no destino, não localizado
- **Objetivo:**
  - Wave por e-mail válido do agente (cap. 23);
  - emissão no destino em dois passos (cap. 24);
  - "Master não localizado" só quando Courier, Wave e emissão no destino têm fonte integrada (cap. 7, 25), com a ação "verificar/identificar a situação do Master";
  - T-10 como escalada de C para B (D-2);
  - e-mail ambíguo não promove nem diverge (cap. 5, 41).
- **Precisa de:** L4, S7, S3.
- **Pronto quando:** passam os cenários 3 e 4, mais a parte Wave do 2.

### L7 — House e cliente
- **Objetivo:**
  - HBL pelo caminho A: foto no Portal + Analista; o OCR só alerta (cap. 15);
  - Telex só por e-mail do agente (H-5, cap. 16);
  - Termo Único via HeadCargo, como projeção com fonte e data (H-14), com validade e reconfirmação (N-17);
  - Termo por Embarque com procuração e assinatura (cap. 18, H-15);
  - financeiro do cliente (cap. 19);
  - cliente concluído = Termo + Financeiro + House (cap. 14);
  - backend do Portal (cap. 20).
- **Precisa de:** L4, S4, S5 (arquivos, PDF e assinatura), S7, S8-HeadCargo.
- **Pronto quando:** passam os cenários 5 e 6.

### L8 — Agência e apresentação
- **Objetivo:**
  - matriz (cap. 26); armador fora dela: "Procedimento de apresentação não mapeado" (H-12);
  - Unimar/Maersk: status "Finalizado" (cap. 27), ou DEPENDÊNCIA TÉCNICA PENDENTE (H-13);
  - MSC/Rochamar: "Enviar para apresentação" → "Apresentação em andamento" → "Confirmar apresentação" (cap. 28);
  - Evergreen/Grieg: atracação real + pagamento (cap. 29, H-8);
  - evidências (cap. 30);
  - ação de Master única com snapshot (N-12, N-13, N-15);
  - pagamento ao armador por Master (N-9, cap. 31);
  - janela de 48h e cobrança (H-10, cap. 32).
  - A precisão dos instantes da janela depende dos contratos de HeadCargo e portais (D-8).
- **Precisa de:** L6, L7, S3, S5 (PDF), S8.
- **Pronto quando:** passam os cenários 1, 2, 8 e 11 completos.

### L9 — Override
- **Objetivo:**
  - o ANALYST solicita; MANAGER ou ADMIN aprova ou rejeita;
  - escopo: pendência + ação + processo; a pendência original permanece; não há override global do Master (H-16, cap. 38, N-13);
  - antes da aprovação, nada aparece como execução normal recomendada.
- **Precisa de:** L2, L7, S4.
- **Pronto quando:** passa o cenário 7.

### L10 — Fila e visões
- **Objetivo:**
  - entrada na Fila Principal (cap. 35);
  - uma entrada por ação de Master, posicionada pelo processo vinculado de maior prioridade (N-12);
  - prioridade lexicográfica (N-11 corrigido): mapeamento de classes em D-1, T-10 em D-2, ETA vigente em D-3, ação C depois da chegada em D-4, desempates com proximidade medida pela etapa em D-5;
  - seis visões (cap. 37), com CE/Prazos sem ultrapassar processos aptos (cap. 10, 35).
- **Precisa de:** L3 e L5–L9.
- **Pronto quando:** passam o cenário 15 e os testes de ordenação.

### L11 — Interface e integrações reais
- **L11a — tela da Vertical 1, somente leitura (no caminho crítico):**
  - `/api/liberacao` montado em `src/index.ts`;
  - `public/Liberacao.dc.html` substitui o placeholder (`:26-27`, `renderVals` em `:33-35`);
  - foco via `priora-bus.js`.
- **L11b — interface completa:**
  - cards do cap. 40, com evidências e ações;
  - Portal real no lugar do mock de `PortalCliente.dc.html`;
  - o card de Liberação em `Processos.dc.html:392-397` passa a ler a projeção.
- **L11c:** troca dos mocks rotulados pelas integrações de S8, conforme elas existirem.

---

## 3. Frentes compartilhadas S1–S8

**S1 — Courier durável** (dono: Courier; aditivo; H-2, H-6, N-7)
- **O que registra:** conferência de MBL e HBL por processo, append-only, com autor, data/hora, valor anterior e evidência.
- **Organização e autor:** vêm das tabelas existentes (`email_caixas` em `0027`; `usuarios`/`organization_memberships` em `0001`).
- **Identidade do processo:** resolvida por S6, nunca por `processBase` (`courierRoutes.ts:56-57`). Sem resolução, vira pendência de identidade e o fato é preservado.
- **Troca ou desconexão da conta:** deixa de apagar conferências confirmadas. No substrato, `wipeConnectionData` ainda chama `resetCourierStore()`; o reset passa a limpar só o estado derivado da caixa.
- **Contrato de saída** publicado; estados e regras do Courier ficam intactos.
- **Primeiro passo:** diagnóstico curto da gravação dupla JSON + Postgres e da reapresentação na UI.

**S2 — Fatos da Auditoria** (dono: Auditoria; aditivo; H-3, H-7, H-17, N-8)
- **S2-mín (Vertical 1):**
  - persiste uma vez a saída da extração que já existe: `tipoDetectado`, `conhecimento`, mensagem/anexo, `observado_em` e versão do extrator;
  - daí vêm o vínculo Processo↔Master (MBL, armador quando houver) e o número do HBL;
  - gatilho: a execução atual da Auditoria, sem OCR novo;
  - S6 só cria processo a partir do código integral com origem documental.
- **S2 completo (com S7):**
  - desconsolidação + número do CE House (cap. 8);
  - evidência do envio do pré-alerta (Itens Enviados, N-8);
  - referências para tracking (MBL, armador, containers).

**S3 — Tracking/VesselCall compartilhado** (N-5, H-8, N-10, N-19)
- **Primeiro passo:** diagnóstico próprio.
- **Agenda e demanda:**
  - demanda por módulo e uma agenda efetiva por alvo (claims por alvo + janela, `schedulerRepository.ts:112`);
  - hoje a seleção usa campos da Demurrage (`:38-63`); a apuração Demurrage continua restrita a containers com contexto Demurrage.
- **Fatos de viagem:**
  - ETA, ATA/chegada e atracação prevista/confirmada;
  - precisão DATA / DATA-HORA COM FUSO / DATA-HORA SEM FUSO;
  - fuso só quando o contrato do adaptador o garante;
  - porto pelo seed UN/LOCODE, acrescido do fuso;
  - associação por container.
- **Aditivo:** as colunas `DATE` são mantidas.
- **Lacunas atuais:**
  - os adaptadores não fornecem ETA (`armadorTrackingSource.ts:62-67`);
  - a chegada fica nula e a atracação não é confirmada (`vesselCallSync.ts:17-21,204-215`);
  - CMA CGM, OOCL e ZIM estão bloqueados e ficam como desconhecido.
- **Antes de ativar o caminho `webUnblocker`/`undici`:** resolver a compatibilidade de runtime e dependências (dívida 13).
- **Na convergência com a linha Demurrage:** considerar a mudança D15-A em `tracking/eventIngestion.ts`.

**S4 — Autenticação multiusuário** (N-6)
- **Primeiro passo:** diagnóstico específico antes de implementar.
- **Alvo:**
  - a pessoa é separada da caixa monitorada;
  - ANALYST, MANAGER, ADMIN e CLIENT coexistem;
  - a organização vem da membership, nunca da requisição.
- **Até lá:** a Vertical 1 usa `requireAuth` + `membro()` (`capturaPreAlerta.ts:135`), sem mecanismo novo.

**S5 — Infra e ambiente** (N-1, N-2)
- **S5-dev:** cluster PostgreSQL dedicado (procedimento qualificado na L0-A). O banco de dev persistente do time entra por variável de ambiente.
- **S5-deploy:**
  - Postgres e etapa de migration no deploy; hoje `render.yaml` está em `plan: free`, sem disco e sem banco;
  - `PRIORA_TOKEN_CACHE_KEY` é obrigatória quando houver banco;
  - kill switch aprovado do scheduler antes de subir com banco em ambiente com credenciais reais.
- **Arquivos, PDF e assinatura:** armazenamento de arquivos e bibliotecas de PDF/assinatura (L7, L8).

**S6 — Identidade central** (N-3, N-4, N-18)
- **Processo** (sobre `processos.id`):
  - o código integral é a identidade canônica, com match exato;
  - alias só com evidência inequívoca na mesma organização; depois de comprovado, é persistido e reutilizado;
  - nunca remover ano ou sufixo; referência parcial nunca cria processo;
  - satélite com a origem da criação;
  - pendência de identidade na máquina do N-14.
- **Master:**
  - UUID próprio;
  - referências append-only: MBL original, limpo, armador, forma canônica por `referenceCanonical.ts`, fonte, evidência, `observado_em`;
  - referências incompatíveis viram pendência, sem fusão silenciosa.
- **Diagnóstico:**
  - consumidores de `processos` que assumem contexto Demurrage (por exemplo `apuracao_status DEFAULT 'OPEN'`);
  - inventário dos códigos existentes antes do deploy.
- **Restrição:** nenhuma regra de Liberação ou Demurrage dentro de S6.

**S7 — Ingestão mínima de e-mail** (YAGNI)
- Cursor por caixa e pasta (Caixa de Entrada + Itens Enviados), no padrão de lease de `email_sync_estado` (`0027`).
- Metadados lidos uma vez; conteúdo completo só quando vira evidência.
- Consumidores: S2 completo, L5, L6, L7.
- A captura de SI continua com cursor próprio (dívida 1).

**S8 — Integrações externas** (H-11, H-13, N-17)
- Sistemas: SISCARGA (L5), HeadCargo (L7/L8), portais Unimar/Maersk (L8).
- Cada uma nasce na fase que a usa, com estas regras:
  - três dimensões;
  - validade e reconfirmação;
  - periodicidades configuráveis, sem número;
  - mock rotulado só em dev/teste;
  - DEPENDÊNCIA TÉCNICA PENDENTE até haver endpoint.

---

## 4. Dependências

| Item | Precisa de |
|---|---|
| L1a | L0 |
| L1b | L1a |
| S6 | L0 |
| S1 · S2-mín | S6 |
| L2 | L1a, S6 |
| L4 | L2, S1, S2-mín |
| L11a | L4 |
| S7 | L0 |
| S2 completo | S2-mín, S7 |
| S3 | S6, S2 (MBL, armador, containers) |
| L3 | S3, L2, L1b |
| L5 | S2 completo, S3, L3, S8-SISCARGA |
| L6 | L4, S7, S3 |
| L7 | L4, S4, S5 (arquivos/PDF), S7, S8-HeadCargo |
| L8 | L6, L7, S3, S5 (PDF), S8 (HeadCargo, portais) |
| L9 | L2, L7, S4 |
| L10 | L3, L5–L9 |
| L11b | L10, S4 |
| L11c | S8 (endpoints externos) |
| Uso em produção | S5-deploy |

**Quem consome cada frente:**
- S1 → L4, L6, L7
- S2 → L4, L5, L6, S3
- S3 → L3, L5, L6, L8, L10
- S4 → L7, L9, L11b
- S6 → S1, S2, S3, L2
- S7 → S2, L5, L6, L7
- S8 → L5, L7, L8, L11c

---

## 5. Caminho crítico: Vertical 1 — Fundação Real de Liberação

```
L0 ──► S6 ──┬──► S1 ───────┐
            ├──► S2-mín ───┼──► L4 ──► L11a  ⇒  Vertical 1 — Fundação Real de Liberação
            └──► L2 ◄──────┘
L0 ──► L1a ─────────────────► (pré-requisito de L2)
```

O caminho tem cinco degraus em sequência; a L1a corre em paralelo desde a L0. Ele **não depende de HeadCargo, SISCARGA, portal de armador nem tracking novo**.

**Por que é o menor caminho:**
- S1 é a única fonte já integrada que resolve um gate real: o Master físico (cap. 22) e o House pelo caminho B.
- Sem S2-mín não há Master compartilhado.
- Sem S6, os processos seriam resolvidos por heurística, o que o N-3 proíbe.

**A Vertical 1 não é o MVP/V1 da Liberação.** Ela prova identidade, fatos reais, Master compartilhado, Courier e Auditoria. Ainda não responde plenamente à pergunta central da Priora, "o que exige atenção agora?", porque não tem Fila nem decisão operacional completa.

**O que a Vertical 1 mostra** (somente leitura, dados reais):
- **Processo:** identidade, aliases e pendências de identidade.
- **Master:**
  - UUID, referências de MBL, armador quando houver, processos vinculados;
  - "Resolvido — físico (Courier)", com autor e data/hora;
  - propagação aos vinculados, inclusive no vínculo tardio (D-7).
- **Master sem Courier:** "Wave: fonte não integrada · Emissão no destino: fonte não integrada". A Vertical 1 **não** afirma "Master não localizado" (D-6).
- **House:** caminho B. O caminho A e o Telex aparecem como "fonte não integrada".
- **Três dimensões** em cada fato.
- **Etapa, bloqueador e próxima ação:** "não determinável — marcos posteriores sem fonte" (D-6). Por isso não há Fila nem classe.

**Pronto quando:**
- os cenários 11 (propagação), 12 (parte Courier) e o primeiro passo do 1 passam com dados persistidos;
- os fatos sobrevivem à troca e à desconexão de conta, com autor e data originais;
- `IM2151` ≠ `IM2151-26` sem alias comprovado;
- reexecutar a Auditoria não cria fato novo;
- não há OCR, scraping nem polling novo;
- a suíte Demurrage passa com as `0100_liberacao_*` aplicadas, e o diff de schema contém só objetos novos.

**Pré-condição operacional** (consequência da restrição do scheduler, §1):
- A validação ponta a ponta da Vertical 1 exige o app rodando com banco e com acesso Graph real, porque Courier e Auditoria leem a caixa monitorada.
- Por isso essa validação depende de um kill switch aprovado para o scheduler da Demurrage.
- S6, S1, S2-mín, L2 e L4 podem ser desenvolvidas e testadas sem subir o app.

## 6. Verticais seguintes e MVP

- **Vertical 2 — Master e House por e-mail:** S7, S2 completo, L6 e Telex. "Master não localizado" passa a ser afirmável.
- **Vertical 3 — Visões temporais:** S3, L3, T-48h e T-10. Entrega as visões "Master não localizado" e "CE/Prazos Regulatórios" (parte T-48h; a parte fiscal depende do SISCARGA), sem depender de HeadCargo.
- **Vertical 4 — Cliente, agência e conclusão:** S4, S5-deploy e S8, levando a L5 (SISCARGA), L7, L8, L9, L10, L11b e L11c.
- **MVP/V1 da Liberação:** é o módulo funcionando conforme o Blueprint, com todas as integrações do cap. 42 ou com as DEPENDÊNCIAS TÉCNICAS PENDENTES explicitamente marcadas. Nenhuma vertical intermediária recebe esse nome.

## 7. Convenção de migrations (N-2)

- **Runner e local:** runner único (`npm run db:migrate:demurrage`, `src/demurrage-engine/db/migrate.ts`); os arquivos ficam em `src/demurrage-engine/db/migrations/`.
- **Nomes:** `0100_liberacao_<frente>_<assunto>.sql`, depois `0101_liberacao_…`, em sequência. O marcador `liberacao` indica que o arquivo foi introduzido pelo esforço da Liberação.
- **Nomes de tabela:** seguem o domínio. As tabelas de S6 não levam "liberacao"; não existe `liberacao_masters` (N-18).
- **Dependências:** cada arquivo depende só de `0001`–`0034` e das `01xx_liberacao_*` anteriores.
- **Ordem de aplicação:** o runner aplica pendentes em ordem lexical, sem rejeitar fora de ordem. Futuras migrations da Demurrage (`0035`+) precisam ser independentes das `0100_liberacao_*`.
- **Objetos da baseline:** só mudanças aditivas, por exemplo colunas novas em S3. Nada de DROP, RENAME ou mudança de tipo/constraint existente.
- **Validação:** a suíte Demurrage aplica todas as migrations do diretório e funciona como guarda de regressão de schema.

## 8. Requisitos de handoff para a linha Demurrage

Registro apenas; nenhuma ação na Demurrage faz parte deste plano.

1. **Fila D12** (`leitura/filaOperacional.ts:272-288` em `practical-cerf`): deve filtrar por contexto Demurrage quando S6 criar processos sem esse contexto (N-4), e não deve tratar `apuracao_status DEFAULT 'OPEN'` (`0016`) como contexto.
2. **Containers via S2/S3:** os criados por essas frentes não entram na apuração da Demurrage.
3. **Cópias em `processos`:** `processos.mbl/hbl/armador_id` (`0003`, promovidos em `registrarProcessoDemurrage.ts:125-156`) são cópias e podem passar a consumir S2.
4. **Precedência universal:** `FIELD_OBSERVATION_SOURCE_PRIORITY` (`domain/types.ts:17-48`) continua válido só para a Demurrage. O cap. 5 do Blueprint proíbe precedência universal.
5. **D15-A em `tracking/eventIngestion.ts`:** a mudança (outcome `bloqueada_final`) toca o caminho de tracking compartilhado e deve ser conciliada com S3 na convergência.

## 9. Registro de dívidas técnicas

1. A captura de SI mantém cursor próprio, fora de S7.
2. Cópias de MBL/HBL em `processos`.
3. Colunas da Demurrage na tabela de identidade `processos` (`apuracao_status DEFAULT 'OPEN'`).
4. Fonte `headcargo` em `field_observations` com prioridade universal.
5. Colunas `DATE` de VesselCall convivendo com os novos campos de precisão.
6. Estado JSON do Courier convivendo com o contrato durável; `resetCourierStore()` na troca de conta (S1/N-7).
7. CMA CGM, OOCL e ZIM sem tracking até haver API oficial.
8. Diretório de migrations e script com nome "demurrage" funcionando como runner único.
9. `membro()` em `capturaPreAlerta.ts:135`, reutilizado pela Vertical 1; mover para módulo compartilhado em S4.
10. Fallback de URL no `testDb.ts`. Está mitigado pelo preflight obrigatório; a guarda em código seria mudança na Demurrage.
11. **Inferências de Liberação no front de outros módulos:** Courier Module `:925-931`; Exigem Atenção `:224-289`; Processos `:392-397` e ETA = data do e-mail `:378,414`. Nenhuma é fonte para a Liberação; a L11b substitui o card de Processos.
12. **Segurança do scheduler da Demurrage.** Com banco configurado, o scheduler sobe automaticamente, com a porta real de tracking e os alertas Graph, sem kill switch. Enquanto não houver kill switch aprovado, não iniciar a Priora com banco configurado em ambiente onde credenciais reais de tracking ou Graph sejam alcançáveis. A captura do pré-alerta tem kill switch (`PRIORA_CAPTURA_PRE_ALERTA=off`).
13. **Node 20 / undici.**
    - O substrato usa `undici@8.11.2`, que exige Node ≥22.19.0; o deploy declara Node 20.
    - Em Node 20 o módulo falha ao carregar.
    - O boot atual não carrega `src/browser/webUnblocker.ts`, o único importador; por isso não bloqueia.
    - Antes de S3 ativar esse caminho, a compatibilidade de runtime e dependências precisa ser resolvida.
14. **Advisory do `proxy-addr`.**
    - `proxy-addr@2.0.7` (via `express@4.22.2`) tem o advisory GHSA-jqcg-44mw-7w3h (crítico) e já existia em `48ba7c1`.
    - A configuração atual (`trust proxy` = 1) não exercita a confiança por sub-rede vulnerável.
    - Existe correção compatível (2.0.8). Fica como hardening de segurança antes de produção; não se usa `npm audit fix` fora de fase autorizada.
15. **Testes de banco destrutivos.** As suítes executam `TRUNCATE … CASCADE` e `DROP SCHEMA public CASCADE`. Banco de teste dedicado + preflight são obrigatórios em toda fase futura.
16. **Outras pendências de configuração:**
    - com banco configurado, `PRIORA_TOKEN_CACHE_KEY` é necessária (sem ela, o cache MSAL fica só em memória);
    - 5 vulnerabilidades moderadas do lockfile não foram analisadas (`body-parser`, `qs`, `express` via `qs`, `uuid` e `@azure/msal-node` via `uuid`).
