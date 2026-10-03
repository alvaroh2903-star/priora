# Fase D13 — Tela Operacional Interna da Demurrage: relatório de entrega (NÃO aprovada, NÃO congelada)

> **Status:** entregue para auditoria. Base: D12 v1.2.3 aprovada e congelada
> em `f7ba55b`. Diagnóstico e plano aprovados em
> `docs/demurrage-fase-d13-diagnostico.md` (commit `3eb89aa`). Esta entrega
> implementa os Gates G1–G7 do plano. **Não** declaro a D13 aprovada nem
> congelada, e **não** iniciei a D14.

## 1. O que foi entregue

Um módulo novo, **só leitura**, consumindo exclusivamente
`GET /api/demurrage/v2/*`: fila operacional, filtros, detalhe de processo,
detalhe de contêiner e timeline, com os dois relógios (cliente e Rocket)
sempre em blocos separados, valores financeiros exibidos exatamente como o
contrato da D12 v1.2.3 decidiu (nunca recalculados, nunca somados no
navegador), paginação por cursor assinado, estados de erro fixos por
código HTTP e um primeiro passo real de acessibilidade e responsividade no
painel.

A tela passa a ser a **entrada principal** de Demurrage no menu. A tela V1
(`Demurrage.dc.html`) continua no repositório e acessível por um link
secundário ("Demurrage (clássico)"), sem nenhuma alteração nela.

## 2. Arquivos

### Criados

| Arquivo | Linhas | Conteúdo |
|---|---|---|
| `public/DemurrageOperacional.dc.html` | 900 | Módulo da tela: fila, filtros, três visões internas (fila → processo → contêiner), timeline, estados de carregamento/erro/vazio/bloqueio, acessibilidade, CSS responsivo |
| `public/demurrage-v2-apresentacao.js` | ~880 | Camada de apresentação PURA (UMD): rótulos dos envelopes de valor, formatação de data/moeda **sem soma e sem conversão numérica de strings decimais**, tabela fixa de mensagens por status/código HTTP, montagem da query string da fila, máquina de paginação por cursor, sanitização da timeline, persistência de filtros em `sessionStorage` |
| `src/frontend-tests/demurrageV2Apresentacao.test.ts` | 465 | 35 testes `node:test` puros (sem banco, sem CDN, sem navegador) + guarda estática de ausência de lógica de negócio |
| `src/frontend-tests/demurrageV2UiZeroWrite.test.ts` | 163 | 2 testes com PostgreSQL real: zero-escrita usando a PRÓPRIA query string que o módulo constrói, e RBAC (401/403) nos mesmos endpoints |
| `docs/demurrage-fase-d13.md` | este arquivo | Relatório de entrega |

### Alterados (mínimo, aditivo)

| Arquivo | Mudança |
|---|---|
| `public/Priora.dc.html` | +1 chave `demurrageop` em `KEYS`/`HREF2KEY`; +1 `<div data-view>` com `<dc-import name="DemurrageOperacional">`. Nenhuma chave antiga removida ou renomeada |
| `public/Sidebar.dc.html` | O link principal "Demurrage" passa a apontar para `DemurrageOperacional.dc.html` (chave `demurrageop`, mesmo ícone/posição); +1 link secundário menor "Demurrage (clássico)" para `Demurrage.dc.html` (inalterado); +1 opção no enum de design-time do `active`. O estilo do tour e os demais links não foram tocados |
| `package.json` | +1 script `test:demurrage-ui` |

### Não tocados (confirmado por `git diff` vazio contra `f7ba55b`)

`src/demurrage-engine/**` (D10, D11, D12 — motores tarifários, relógios,
Free Time, responsabilidade, apuração, timeline, filtros, autorização),
`src/routes/demurrageRoutes.ts` (V1), `src/routes/demurrageV2Routes.ts`,
`src/index.ts`, `public/support.js`, `public/Demurrage.dc.html`,
`public/Exigem Atencao.dc.html`, `public/Relatorios.dc.html`,
`public/PortalCliente.dc.html`, `public/Courier Module.dc.html`,
`src/auditoria/**`. Nenhuma migration.

## 3. Comportamento entregue, por Gate

### G1 — Navegação e autorização

- Item novo no menu, na posição principal de "Demurrage"; `#demurrageop`
  abre o módulo pelo mecanismo existente do shell (hash → `KEYS`); as
  demais abas continuam abrindo exatamente como antes.
- Nenhuma chamada do módulo envia `organizationId` em nenhum canal
  (verificado por teste estático, item 16d) — a organização vem só da
  sessão, como a D12 já garante.
- Tabela fixa de erro por status/código (`classificarErro`), nunca o
  `error`/`detalhe` do servidor: `401` → sessão encerrada; `403` → acesso
  restrito; `409 organizacao_ambigua` → texto fixo sem listar IDs;
  `409 ordem_alterada`/`400 cursor_invalido` → reinício discreto da 1ª
  página; `404` → não encontrado; `5xx`/rede → mensagem genérica de
  "tentar de novo", mesmo que o corpo contenha uma stack trace (testado
  explicitamente, item 12b).

### G2 — Fila e ordem oficial

- `prepararItensFila` preserva EXATAMENTE a ordem e o tamanho do array que
  a API devolve — nenhuma chamada a `.sort()` em todo o módulo de
  apresentação nem no script do `.dc.html` (verificado por teste estático
  que varre o código-fonte, item 16/16b).
- Envelopes de valor seguem a tabela de rótulos do diagnóstico
  (CONFIRMADO/ESTIMADO/ESTIMADO_PROVISORIO/INDISPONIVEL por lado/
  PENDENTE/NAO_APLICAVEL); `total` nunca aparece quando é `null`.
- `agregadoFinanceiro` (DV-01, da D12 v1.2) é exibido por moeda, SEM soma
  entre moedas nem entre cliente e Rocket; `subtotalConhecido` (string
  decimal exata) é concatenado como texto, nunca convertido com `Number()`
  ou `parseFloat()`.
- Contêiner líder rotulado explicitamente ("Contêiner líder"), vindo
  exclusivamente do bloco `lider` da D12 — nenhuma nova escolha no
  navegador.

### G3 — Filtros e paginação

- Os 15 filtros da D12 (`responsavel`, `cliente`, `armador`, `estado`,
  `prioridade`, 7 booleanos, período com campo explícito
  descarga/devolução, `busca`, `incluirSilenciosos`) geram exatamente os
  parâmetros de `normalizarFiltrosFila` — nomes idênticos, nenhuma
  tradução nova.
- Busca não vazia liga `incluirSilenciosos` automaticamente e de forma
  **visível** (aviso próprio na tela, "A busca incluiu automaticamente os
  processos em monitoramento silencioso"), via `aplicarAutoIncluirSilenciosos`
  — escolha de parâmetro (U-06), nunca uma regra de filtragem nova.
- Qualquer mudança de filtro descarta o cursor e recarrega a 1ª página;
  `409 ordem_alterada`/`400 cursor_invalido` reiniciam com aviso; respostas
  atrasadas (de um filtro que já não é o atual) são descartadas pela
  máquina de paginação (`reduzirPaginacao`), provado por teste (item 2b).
- Filtros persistidos em `sessionStorage` (por aba), lidos de volta ao
  montar o módulo.

### G4 — Detalhes e separação dos relógios

- `formatarDoisRelogios` devolve dois objetos SEPARADOS
  (`relogios.cliente`/`relogios.rocket`), cada um com seu próprio título
  ("Relógio do cliente"/"Relógio da Rocket") — nenhum campo de "status
  geral" existe no par (testado, item 4). Um relógio `PENDING`/`INVALID`
  nunca contamina o outro (item 4b).
- Bloco "Informação interna — Responsabilidade" só aparece no detalhe do
  contêiner, visualmente isolado (fundo e borda próprios); nunca é
  renderizado na fila (teste estático confirma que o texto desse bloco não
  faz parte do template da fila — item 4c).
- `404` no processo/contêiner mostra o texto neutro "Não encontrado ou sem
  acesso" com botão de voltar.

### G5 — Timeline

- `prepararEventoTimeline` só repassa os campos permitidos pela seção 9 do
  diagnóstico (`resumo`, `tipo` rotulado, `dataOperacional`,
  `registradoEm`, `origem`, `fonte`, `autor.nome`, `evidenciaRef`,
  `containerId`/`escopo`) — um campo extra no objeto bruto (`payload`,
  `erro`, `raw_ref`, `trecho_evidencia`) NUNCA aparece no view-model, mesmo
  presente na entrada (testado explicitamente, item 11).
- Paginação pelo cursor assinado exatamente como a API devolve; timeline
  vazia tem texto próprio ("Nenhum evento registrado para este
  processo.").

### G6 — Estados de erro e acessibilidade

- Todos os estados da seção 10 do diagnóstico implementados: carregando
  (esqueleto com `aria-busy`), vazio (com e sem filtro), erro de conexão
  (cartão + "Tentar de novo", preservando a lista anterior), 401/403/
  `organizacao_ambigua` (telas bloqueantes dedicadas), `ordem_alterada`
  (aviso discreto), relógio pendente (com motivo, o outro relógio intacto),
  timeline vazia, 404.
- Primeiro módulo do painel Priora com acessibilidade real: `role`,
  `aria-live` (avisos), `aria-label`, `aria-busy`, `aria-expanded`,
  `aria-selected`, `aria-pressed`, navegação por `tabIndex`/`onKeyDown`
  (Enter/Espaço abrem linha, Esc volta um nível) — confirmado por teste
  estático (item 15) que exige múltiplas ocorrências de cada atributo, não
  um uso decorativo isolado.
- Nenhum selo depende só de cor: todo envelope de valor, badge e estado
  sempre carrega o TEXTO do rótulo ao lado da cor.

### G7 — Regressão e desempenho

- Suíte da engine, V1, `tsc --noEmit` e `npm run build` verdes (seção 4).
- `git diff` vazio contra `f7ba55b` em todos os arquivos proibidos (seção 2).
- A tela só faz `GET` em `/api/demurrage/v2/*` — confirmado por teste
  estático que varre todas as chamadas `fetch(...)` do módulo (item 16c) —
  e por um teste com PostgreSQL real que roda a PRÓPRIA query que o módulo
  constrói contra os 5 endpoints e tira o fingerprint de TODO o schema
  antes/depois (item 4 abaixo).

## 4. Testes e resultados

### Novos — apresentação pura (`demurrageV2Apresentacao.test.ts`, Node puro, sem CDN/navegador)

**35/35.** Cobre os 16 itens pedidos:

| # | Item | Resultado |
|---|---|---|
| 1 | Renderização da fila preserva a ordem da API (inclusive com prioridades "fora de ordem" de propósito) | ok |
| 2 | Paginação por cursor sem duplicar; resposta atrasada de filtro antigo é descartada; 409/400 reiniciam | ok (3 testes) |
| 3 | Contêiner líder exibido tal como veio; processo sem contêiner nunca inventa um líder | ok (2 testes) |
| 4 | Dois relógios SEMPRE separados, sem "status geral"; pendência de um não contamina o outro; bloco interno de responsabilidade ausente do template da fila | ok (3 testes) |
| 5 | Valor desatualizado (PENDENTE) nunca aparece como atual | ok |
| 6 | INDISPONIVEL nunca é "0"/"R$ 0" — rótulo específico por lado | ok |
| 7 | `subtotalConhecido` exibido byte a byte, nunca convertido com `Number`/`parseFloat` | ok (2 testes) |
| 8 | Moedas diferentes nunca somadas — uma linha por moeda | ok |
| 9 | Busca liga "Incluir silenciosos" de forma visível, sem reativar silenciosamente depois | ok (3 testes) |
| 10 | Persistência de filtros em `sessionStorage` simulado (round-trip exato; indisponível não quebra) | ok (2 testes) |
| 11 | Timeline sanitizada — campo extra no bruto nunca aparece; tipo desconhecido nunca é omitido | ok (2 testes) |
| 12 | 401/403/404/cursor inválido/ordem alterada com texto fixo; 500 com stack trace nunca exibido | ok (3 testes) |
| 13 | Estados carregando/vazio/conteúdo/erro derivados corretamente do mesmo shape | ok |
| 14 | Presença de `@media (max-width: 1100px)` para tabela → cartões | ok |
| 15 | `role`/`aria-*`/`tabIndex`/`onKeyDown` presentes e em múltiplos pontos | ok |
| 16 | Guarda estática: nenhum `sort`/`reduce`/`Number`/`parseFloat`/`parseInt` nem nome de função do motor (faixas, relógios, moeda exata) no JS de apresentação NEM no script do `.dc.html`; só `GET /api/demurrage/v2`; nunca `organizationId` no código executável | ok (4 testes) |

Mais 3 testes de apoio (query string, chave de filtros, datas civis sem `Date`).

### Novos — integração com PostgreSQL real (`demurrageV2UiZeroWrite.test.ts`)

**2/2.**

1. **Zero-escrita com a query da própria UI.** Usa `construirQueryFila` e
   `aplicarAutoIncluirSilenciosos` do módulo de apresentação para montar as
   MESMAS query strings que a tela produziria (fila vazia, fila com busca +
   filtros + período, paginação por cursor, filtros, detalhe de processo,
   timeline paginada, detalhe de contêiner) contra os 5 endpoints reais da
   D12 v1.2.3. Fingerprint de TODAS as tabelas do schema (`information_schema`,
   não uma lista escolhida à mão) idêntico antes e depois; todas as
   respostas `200`.
2. **RBAC nos mesmos endpoints.** `CLIENT` recebe `403`
   (`acesso_restrito`, pela própria tabela de erro do módulo); sem sessão
   recebe `401` (`sessao_encerrada`) — nos 5 caminhos que o módulo chama.

### Regressão completa (isolada)

| Suíte | Resultado |
|---|---|
| Testes novos de apresentação (`demurrageV2Apresentacao`) | 35/35 |
| Testes novos de integração da UI (`demurrageV2UiZeroWrite`) | 2/2 |
| **Engine completa** (`npm run test:demurrage-engine`) | **724/724** — idêntico ao da D12 v1.2.3, nenhuma regressão |
| V1 (`npm test`) | 25/25 |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

Zero falhas e **zero testes ignorados** em todas as linhas. `git diff
f7ba55b` vazio em `src/demurrage-engine/**`, nas rotas V1 e V2, em
`src/index.ts`, `support.js` e nos quatro módulos `.dc.html` protegidos
(`Demurrage`, `Exigem Atencao`, `Relatorios`, `PortalCliente`) — confirmado
na seção 2.

## 5. Evidência de acessibilidade e responsividade

- **Acessibilidade:** o teste estático (item 15) exige, e o arquivo
  contém, `role=` (tabela/linha/coluna/região/status/alerta/aba),
  `aria-live="polite"` (avisos de ordem alterada/filtro inválido),
  `aria-label` (linhas da fila, contêineres, blocos de relógio),
  `aria-busy` (esqueletos de carregamento), `aria-expanded`
  (painel de filtros), `aria-selected` (abas), `aria-pressed` (chips de
  resumo), `tabIndex="0"` e `onKeyDown` (linhas da fila e de contêiner
  abrem com Enter/Espaço; Esc volta um nível na visão de processo/
  contêiner). Nenhum selo de situação depende só de cor — o rótulo em
  texto está sempre ao lado.
- **Responsividade:** uma única estrutura de dados e DOM serve as duas
  apresentações — grade CSS (`dop-grid-head`/`dop-grid-row`) no desktop, e
  o mesmo bloco empilhado em cartão abaixo de 1.100 px
  (`@media (max-width: 1100px)`), sem duplicar lógica. Os blocos de
  relógio (cliente/Rocket) também colapsam de duas colunas para uma.
- **Limite real desta evidência:** por causa da limitação 4.1 do
  diagnóstico (React/ReactDOM/Babel do `support.js` vêm de `unpkg.com`, e o
  proxy deste contêiner bloqueia `unpkg.com` com `403`), **não** foi
  possível abrir o painel real num navegador nem rodar Playwright (U-11)
  para confirmar visualmente o breakpoint, o foco visível e a navegação por
  teclado em DOM renderizado de verdade. A evidência acima é estática
  (presença e multiplicidade da marcação no arquivo-fonte, mais os 35
  testes puros da lógica que alimenta essa marcação) — não uma captura de
  tela nem uma verificação `axe` real. Isto é consistente com o que o
  próprio diagnóstico já previa no item U-11 e na limitação 4.1, e é a
  razão pela qual `demurrageV2Tela.e2e.test.ts` (Playwright, condicional)
  **não foi criado** nesta entrega.

## 6. Prova de que o navegador não faz cálculo de negócio

Três camadas independentes de evidência:

1. **Guarda estática exaustiva** (testes 16/16b): nem
   `demurrage-v2-apresentacao.js` nem o script embutido de
   `DemurrageOperacional.dc.html` contêm, em código executável (comentários
   removidos antes da verificação), `.sort(`, `.reduce(`, `Number(`,
   `parseFloat(`, `parseInt(`, nem o nome de nenhuma das funções de cálculo
   do motor: `toOrdinal`, `fromOrdinal`, `posicionarFaixas`,
   `calcularDoisRelogios`, `diasDemurrageOperacionais`, `blocoPrazoRelogio`,
   `centavosExatos`, `somarCentavosExatos`, `calcularExposicaoRocket`,
   `calcularTermoPorEmbarque`, `calcularTermoUnico`, `envelopeDeValor`,
   `envelopeDoRelogio`, `selecionarValorAtivo`, `agregarFinanceiroProcesso`.
2. **Comportamento testado** (testes 1, 7, 8): a fila nunca é reordenada
   (ordem de saída idêntica à de entrada, mesmo com prioridades fora de
   ordem de propósito no fixture); `subtotalConhecido` sai como string
   byte a byte; moedas diferentes nunca viram uma soma.
3. **Superfície de rede restrita** (teste 16c + teste de integração): só
   `GET /api/demurrage/v2/*`, nunca a V1, nunca um método de escrita;
   confirmado também pelo fingerprint de schema inteiro antes/depois do
   teste de integração.

Único uso de `Date` no módulo de apresentação: formatação de INSTANTES já
calculados pelo backend (`calculadoEm`, `trackingAtualizadoEm`,
`registradoEm` da timeline) em horário local e "há X" — nunca uma
`CivilDate` de negócio (que é sempre corte de string, "AAAA-MM-DD" →
"DD/MM/AAAA", nunca um objeto `Date`, testado no item extra "datas civis
nunca passam por Date").

## 7. Limitações conhecidas

- **Sem verificação em navegador real (U-11).** Ver seção 5 — bloqueio de
  rede (`unpkg.com`) deste contêiner, documentado desde o diagnóstico. A
  tela não foi aberta visualmente nem testada com Playwright/axe nesta
  entrega.
- **Rótulos de estado nos cartões da fila/detalhe não são coloridos por
  estado** (todos usam o mesmo par neutro de cor de fundo/texto) — decisão
  consciente para não depender de uma paleta de cor-por-estado inventada
  sem validação visual; o texto do rótulo é sempre a fonte da informação,
  nunca a cor. Pode ser refinado em uma fase visual posterior, sem
  qualquer mudança de contrato.
- **Resumo por balde na fila** usa as contagens de `GET /filtros`
  (`contarEstadosEBaldes` da D12 v1.2, mesma derivação atual da fila) —
  consistente com a recomendação U-05 do diagnóstico, carregado numa
  segunda chamada depois da fila (nunca bloqueia a primeira renderização).
- **Tour de onboarding do Sidebar não foi atualizado** com um passo para o
  novo item — o diagnóstico marcava isso como opcional; o passo existente
  que aponta para "Demurrage" agora destaca o link secundário/clássico
  (ainda funcional, apenas aponta para outro elemento).
- **Sem teste automático de contraste (axe)** — depende de U-11 (mesma
  limitação de rede).

## 8. Itens do Blueprint explicitamente adiados (D14/fase futura/Liberação/HeadCargo/Portal)

Nenhuma decisão nova aqui — são exatamente as divergências DV-02, DV-07 a
DV-19 já registradas e decididas na seção 12 do diagnóstico (`DV-01`,
`DV-03`, `DV-04` e `DV-05` já foram resolvidas de forma aditiva pela D12
v1.2). Resumo do que esta entrega **não** faz, por decisão já tomada no
diagnóstico:

- Diferença potencial entre cliente e Rocket (DV-02) — fica para a D14
  (Gestão).
- Status financeiro do HeadCargo (DV-07) — texto fixo "Status financeiro
  não disponível" é o único tratamento previsto pelo próprio Cap. 27.3 do
  Blueprint; sem integração.
- Situação detalhada de tracking — próxima consulta programada, "em
  andamento", suspensão após 30 dias, incidente agrupado por armador
  (DV-08) — só o que a D12 já expõe (`trackingAtualizadoEm`,
  `falhaTrackingAtiva`, falhas por tipo) é mostrado.
- Tipo de contêiner original/normalizado (DV-09), memória de cálculo
  completa — faixas e tarifa por dia (DV-10), estimativa anterior
  preservada (DV-11), pré-análise e datas da Liberação (DV-13), filtros
  adicionais de estado financeiro/vencimento/minuta pendente (DV-14),
  destaque de divergência de valor quando o motor vier a emiti-lo
  (DV-16) — todos campos aditivos de fase futura, sem dado hoje no
  contrato da D12.
- **Ações operacionais** (DV-15: correção, tratativa, atualizar tracking
  manualmente, confirmar/corrigir responsabilidade) — fora do escopo desta
  D13 por instrução explícita; a tela é só leitura.
- **Indicadores de Gestão** (Cap. 30) — D14.
- **Portal do Cliente** — não tocado; a tela é interna, `CLIENT` recebe
  `403` da própria API (D12), nunca chega a ver o módulo.

## 9. Limites respeitados

Não reabri nem alterei D10, D11, D12 (motores tarifários, relógios, Free
Time, responsabilidade, cadência, apuração, fechamento), rotas V1, Portal,
Supabase, HeadCargo, Courier, Auditoria, nem o futuro módulo de Release.
Nenhuma migration. Nenhuma ação operacional criada. A tela é estritamente
`GET /api/demurrage/v2/*`; nenhuma escrita, comprovada por teste com banco
real. Nenhum defeito de contrato do backend foi encontrado durante esta
implementação — o contrato da D12 v1.2.3 já fornecia tudo o que os Gates
G1–G7 pediam.

**A D13 não está aprovada nem congelada.** A D14 não foi iniciada.
