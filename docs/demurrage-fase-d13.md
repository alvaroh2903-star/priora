# Fase D13 — Tela Operacional Interna da Demurrage: relatório de entrega CORRETIVA (NÃO aprovada, NÃO congelada)

> **Status:** entregue para nova auditoria. A entrega anterior, commit
> `c732555`, foi **rejeitada** pelo usuário após abertura real pela casca
> (`Priora.dc.html → Demurrage`): erro de runtime
> (`DemurrageOperacional: DemurrageV2 is not defined`), conteúdo que não
> renderizava, título/subtítulo espremidos numa coluna estreita, e uma
> redução visual não autorizada (tabela administrativa cheia de filtros no
> lugar do dashboard simples). Este documento substitui o relatório
> anterior e descreve a correção. Base inalterada: D12 v1.2.3 aprovada e
> congelada em `f7ba55b`. **Não** declaro a D13 aprovada nem congelada, e
> **não** iniciei a D14.

## 1. Causa exata do erro de runtime e correção exata

### 1.1 Causa

O runtime do `support.js` (que **não** foi alterado) instancia a classe
`Component` de cada módulo `.dc.html` **dentro do próprio `render()`**, via
`__reconcileLogic()`/`__makeLogic()` — e isso acontece **antes** de o
template do módulo (incluindo o bloco `<helmet>`) ser montado no DOM. O
`<helmet>` é quem acrescenta `<script src="./demurrage-v2-apresentacao.js">`
em `<head>`, e esse `<script>` carrega **de forma assíncrona**.

A versão rejeitada (`c732555`) chamava `DemurrageV2.carregarFiltros(...)`
diretamente no **construtor** do componente. Na primeira renderização real
pela casca, o construtor executava antes de o script do helmet sequer
começar a carregar — `DemurrageV2` ainda não existia em `window`, e o
JavaScript lançava `ReferenceError: DemurrageV2 is not defined`. O runtime
do `support.js` capturava esse erro e substituía a classe por uma
`StreamableLogic` neutra (sem estado, sem efeitos), exibindo o aviso
`sc-logic-error` e deixando o template renderizar com todos os valores
indefinidos — daí a tela "quebrada": sidebar e cabeçalho (que pertencem ao
shell, não a este módulo) continuavam visíveis, mas o conteúdo do painel
nunca aparecia.

A abertura direta do arquivo (`DemurrageOperacional.dc.html` fora da
casca) não reproduzia o problema de forma confiável porque o timing de
carregamento de script variava o bastante para, às vezes, o script já
estar pronto quando o construtor rodava — por isso o diagnóstico anterior
era enganoso e a auditoria exigiu, com razão, validação **pela casca
real**.

### 1.2 Correção

`public/DemurrageOperacional.dc.html` — a classe `Component` **nunca mais
toca `window.DemurrageV2` no construtor nem em `renderVals()` antes de o
módulo estar pronto**:

- O construtor só inicializa estado local puro (`pronto: false`, nenhuma
  chamada a `DemurrageV2`).
- `componentDidMount()` chama `aguardarApresentacao(cb)`, que:
  1. verifica se `window.DemurrageV2` já existe (idempotente — cobre o
     caso raro em que o script já carregou primeiro);
  2. senão, localiza a tag `<script src="./demurrage-v2-apresentacao.js">`
     que o próprio `<helmet>` do módulo inseriu, e escuta os eventos
     `load`/`error` dela;
  3. e, como rede de segurança, faz polling leve (a cada 50 ms, até
     ~15 s) checando `window.DemurrageV2` — cobre qualquer navegador ou
     timing em que o evento `load` não seja confiável.
  4. só então chama `iniciar()`, que carrega filtros, fila e contagens.
- `renderVals()` devolve um objeto **mínimo** (`carregandoModulo: true`)
  enquanto `pronto` é falso — o template mostra um estado de carregamento
  dedicado (`data-dop="carregando-modulo"`) em vez de qualquer tentativa
  de usar dados que ainda não existem.
- Se o script falhar ao carregar (evento `error`, ou os ~15 s de polling
  esgotarem), `erroModulo: true` mostra uma tela de erro dedicada — nunca
  uma exceção solta.

**Garantias mantidas (verificadas por teste, seção 4):**
- `support.js` não foi tocado.
- O módulo de apresentação é importado **uma única vez**, pelo
  `<helmet>` — nenhuma segunda cópia inline no `.dc.html`.
- Toda referência a `DemurrageV2` no script embutido é `window.DemurrageV2`
  (nunca um identificador solto que dispararia o mesmo `ReferenceError` se
  executado cedo demais).
- O UMD de `demurrage-v2-apresentacao.js` foi tornado **idempotente**
  (`root.DemurrageV2 = root.DemurrageV2 || factory()`), para o caso de o
  script ser avaliado mais de uma vez pelo navegador (cache/race).

## 2. Arquivos alterados nesta correção

| Arquivo | O que mudou |
|---|---|
| `public/DemurrageOperacional.dc.html` | **Reescrito por completo** (1188 linhas): composição V1 (dashboard simples), espera do módulo de apresentação antes de qualquer uso, nova estrutura de seções/cartões/coluna direita, CSS escopado do Topbar para não espremer o título |
| `public/demurrage-v2-apresentacao.js` | Estendido (1153 linhas): UMD idempotente; novas funções puras do dashboard — `formatarDecimalExatoBr`, `montarSecoesFila`, `montarIndicadores`, `montarResumoOperacional`, `consultasIndicadores`, `contarFiltrosAtivos`, `estadoInicialPainelFiltros`, `linhasStatusLado`, `referenciasDoItem`/`textoComposicao` — nenhuma mudança nas funções já existentes de leitura/sanitização/paginação |
| `src/frontend-tests/fixtures/demurrageV2Fixtures.ts` | **Novo** — fixtures tipadas do contrato D12 v1.2.3 (import `type` de `contrato.ts`), 6 processos representativos, 2 contêineres, timeline com payload bruto injetado (para provar que nunca vaza) |
| `src/frontend-tests/browserHarness.ts` | **Novo** — servidor Express determinístico (mesmo `express.static`+`Priora.dc.html` do `src/index.ts`), mock dos 5 endpoints V2 por cenário (`normal`/`vazio`/`lento`/`s401`/`s403`/`s500`/`organizacao`/`d404`), interceptação de rede do Playwright que serve os 3 arquivos de CDN (React/ReactDOM/Babel) a partir de `node_modules` — o próprio navegador confere o SRI que o `support.js` já declarava |
| `src/frontend-tests/demurrageV2Browser.test.ts` | **Novo** — 17 testes Playwright em navegador real, pela casca real (`Priora.dc.html`), cobrindo os 15 passos exigidos (seção 5) |
| `src/frontend-tests/demurrageV2Apresentacao.test.ts` | +12 testes novos (decimal BR, seções/ordem/fallback, indicadores, contagem de filtros, guarda de runtime); 5 testes antigos corrigidos para o novo formato de saída (`subtotalExato`/`texto` em vez do número cru; marcador `VIEW: PAINEL`; acessibilidade via controles nativos) |
| `package.json` / `package-lock.json` | +4 dependências de desenvolvimento, fixadas por versão exata: `react@18.3.1`, `react-dom@18.3.1`, `@babel/standalone@7.29.0` (as MESMAS versões que `support.js` já carregava do CDN — usadas só para servir os bytes localmente no teste) e `axe-core@4.13.0` (varredura de acessibilidade) |
| `docs/demurrage-fase-d13.md` | Este arquivo — substitui o relatório da entrega rejeitada |

**Não tocados nesta correção** (além dos arquivos já protegidos listados na
seção 7): `public/Priora.dc.html` e `public/Sidebar.dc.html` — a navegação
(chave `demurrageop`, link principal "Demurrage", link secundário
"Demurrage (clássico)") já estava correta na entrega anterior e segue
inalterada.

## 3. Diferenças visuais em relação à D13 rejeitada (`c732555`)

| | D13 rejeitada (`c732555`) | D13 corretiva (esta entrega) |
|---|---|---|
| Composição geral | Tabela administrativa densa, filtros expandidos ocupando a tela inteira ao abrir | Dashboard: 4 cartões de KPI no topo, seções por urgência com cartões grandes, coluna direita fixa — a mesma composição de `Demurrage.dc.html` (V1) |
| Primeira impressão ao abrir | Painel de filtros (7 campos + 7 checkboxes) antes da fila | Fila **imediatamente visível**; filtros atrás de um botão recolhido (`Filtros`), painel fechado por padrão |
| Cartão de processo | Linha de tabela (`tabIndex` numa `<div>`, grade de colunas fixas) | Cartão (`<article>`) com barra de cor lateral, ícone, bloco de valor do cliente à direita, 3 caixas de estatística (líder/vencimento/informação), badges, botão "Abrir processo" — mesmo padrão visual do V1 |
| Agrupamento | Nenhum agrupamento visual — lista única | 4 seções por urgência oficial: **Em demurrage** (vermelho), **Devolvidos — aguardando tratamento** (roxo), **Risco iminente** (laranja), **Monitoramento** (cinza) — cores do Cap. 22/tema V1 |
| Coluna direita | Inexistente | Resumo geral (contagem por balde oficial), Maior risco atual (primeiro item da fila, com botão de ação), Atualizações recentes (5 primeiros itens) — reconstrução fiel da coluna direita do V1 |
| Indicadores do topo | Nenhum | 4 cartões de KPI: processos em demurrage, Free Time terminando, pendências de informação, devolvidos em tratamento — cada um uma contagem real da D12, nunca somado, nunca "impacto total" |
| Cabeçalho (Topbar compartilhado) | Título/subtítulo espremidos palavra a palavra em telas estreitas (nenhum CSS escopado tratava a quebra) | CSS **escopado só a este módulo** (`[data-sc-name="DemurrageOperacional"] [data-sc-name="Topbar"] header{flex-wrap:wrap}`) — a busca quebra para a linha de baixo quando falta espaço, o título nunca é espremido; `Topbar.dc.html` em si **não foi tocado** |
| Erro de runtime | `DemurrageV2 is not defined` ao abrir pela casca | Nenhum — módulo espera o script do helmet antes de qualquer uso (seção 1) |

## 4. Elementos preservados do design original (`Demurrage.dc.html`, V1)

- Sidebar escura da Priora e Topbar padrão — **inalterados**, nenhum CSS
  global novo (só uma regra escopada ao módulo, seção 3).
- Paleta de cor fiel ao Cap. 22/tema V1: **vermelho** (`#E5484D`/`#C2333A`)
  para custo ativo (demurrage), **laranja** (`#E8990C`/`#8A5A09`) para
  risco iminente (Free Time terminando, ainda sem custo), **roxo**
  (`#4327E6`/`#3D34C9`) para ações e informação neutra da Priora, cinza
  para monitoramento silencioso.
- Cartões de KPI simples no topo (4, não uma grade extensa).
- Processos agrupados visualmente por urgência, com cartões grandes e
  legíveis — cliente, número do processo, House/Master, armador,
  contêiner líder, contagem de contêineres, Free Time e valores visíveis
  de relance, sem precisar abrir nada.
- Coluna direita fixa (sticky) com resumo de gestão, maior risco atual e
  atividade recente.
- Leitura operacional simples — nenhuma tabela técnica dominando a tela.
- Botões de ação sólidos em roxo (`solid-btn`) e secundários "ghost"
  (`ghost-btn`) com a mesma transição visual do V1.

## 5. Validação obrigatória em navegador real — evidência pela casca

Suíte `src/frontend-tests/demurrageV2Browser.test.ts` (Playwright,
Chromium real `/opt/pw-browsers`, **17 testes, 17/17 verdes**), cada um
abrindo `Priora.dc.html` e clicando no item de menu **Demurrage** —
nenhum teste abre o módulo isoladamente. Servidor determinístico local
(`browserHarness.ts`): fixtures tipadas do contrato D12 v1.2.3, sem dado
de produção, sem rede externa (os 3 scripts de CDN que `support.js` já
carregava são respondidos com os mesmos bytes de `node_modules` — o
próprio navegador confere o SRI já declarado no `support.js`).

| # | Passo exigido | Como foi coberto | Resultado |
|---|---|---|---|
| 1–2 | Abrir `Priora.dc.html` → clicar no menu Demurrage | Todos os 17 testes fazem exatamente isso (`abrirDemurrage`) | ok |
| 3 | Sem erro de runtime | `coletarErros` escuta `pageerror` e `console.error` ligados a `DemurrageOperacional`/`DemurrageV2`/`dc-runtime`/`is not defined` — lista vazia em todos os testes | ok |
| 4 | Dashboard renderiza | `[data-dop="painel"]`, 4 KPIs, cartões com `IM-24001`/`Alfa Importadora` da fixture | ok |
| 5 | Sidebar visível | `aside a[href="DemurrageOperacional.dc.html"]` visível após a navegação | ok |
| 6 | Header com largura normal | `boundingBox().width > 700px`; título "Demurrage" legível por inteiro, nunca espremido | ok |
| 7 | Cartões com dados representativos | Conteúdo do primeiro cartão confere com a fixture (cliente, processo, valores) | ok |
| 8 | Abrir processo | Clique em "Abrir processo" → `[data-dop="lider"]` mostra `MSKU1234565`; 2 blocos de agregado (cliente/rocket), nunca somados | ok |
| 9 | Abrir contêiner | A partir da aba Contêineres → `[data-dop="detalhe-container"]` com os dois relógios | ok |
| 10 | Dois relógios (cliente/Rocket) | Exatamente 2 `[data-dop="relogio"]`, `data-lado` distintos, títulos distintos (House/Master Free Time), valores distintos — nunca combinados | ok |
| 11 | Timeline | Aba "Linha do tempo"; texto nunca contém o marcador de payload bruto injetado na fixture (`NAO-EXIBIR-PAYLOAD-BRUTO`) | ok |
| 12 | Vazio/carregando/401/403/404/erro de servidor | 7 testes dedicados: `vazio` (estado vazio, não erro), `lento` (esqueleto com `aria-busy="true"`), `s401`→bloqueio "sessao", `s403`→bloqueio "acesso", `organizacao`→bloqueio "organizacao", `s500`→cartão de erro **sem** a stack trace injetada no corpo da resposta, `d404`→detalhe com "Não encontrado ou sem acesso" | ok (8 testes) |
| 13 | Layouts desktop e responsivo | 1440px: coluna direita ao lado da fila, sem rolagem horizontal; 1024px e 820px: coluna direita **abaixo** das seções, sem rolagem horizontal, sem tabela técnica, filtros recolhidos, título não espremido | ok (3 testes) |
| 14 | Teclado e foco visível | Enter abre o painel de filtros (`aria-expanded`), Esc fecha e devolve o foco ao botão; Enter sobre "Abrir processo" focado navega ao detalhe; `outlineStyle !== 'none'` no elemento focado; Esc no detalhe volta à fila | ok |
| 15 | Varredura de acessibilidade | `axe-core@4.13.0` rodado contra `[data-dop="painel"]` renderizado de verdade — **zero violações `serious`/`critical`** | ok |

Mais 2 testes de guarda: rede (só `GET /api/demurrage/v2/*`, nunca
`organizationId`) e filtros (busca liga "incluir silenciosos" de forma
visível, persiste em `sessionStorage`, sobrevive a um `reload()` real da
página, "Limpar" funciona com o painel recolhido).

## 6. Evidência visual (capturas do navegador real, pela casca)

Três capturas anexadas a esta entrega (desktop 1440px: painel, processo,
contêiner; responsivo 820px: painel completo) mostram:

- Sidebar escura e Topbar padrão intactos, título "Demurrage" por inteiro.
- 4 KPIs no topo, seções coloridas por urgência, cartões grandes com
  cliente/processo/HBL/MBL/armador/contêiner líder/valores visíveis.
- Coluna direita com Resumo geral, Maior risco atual e Atualizações
  recentes — ao lado da fila no desktop, **abaixo** das seções em 820px.
- Processo aberto: cartão de cabeçalho, 4 caixas de estatística (líder,
  vencimento, apuração, status financeiro), agregados por lado **sem
  soma**, abas Contêineres/Linha do tempo/Fechamento.
- Contêiner aberto: **dois** blocos de relógio lado a lado — "Relógio do
  cliente" (House Free Time, 16 dias, valor do cliente) e "Relógio da
  Rocket" (Master Free Time, 20 dias, exposição ao armador indisponível)
  — nunca combinados num status único; bloco "Informação interna —
  Responsabilidade" isolado abaixo, visualmente distinto (fundo roxo
  claro), presente **só** aqui.

## 7. Testes e resultados — totais

| Suíte | Resultado |
|---|---|
| Apresentação pura (`demurrageV2Apresentacao.test.ts`, Node puro) | **47/47** (35 preexistentes revisados + 12 novos desta correção) |
| Navegador real pela casca (`demurrageV2Browser.test.ts`, Playwright/Chromium) | **17/17** — primeira vez que este Gate é cumprido com navegador de verdade, não estático |
| Integração com PostgreSQL real (`demurrageV2UiZeroWrite.test.ts`) | **2/2** (zero-escrita com a query da própria UI; RBAC 401/403) |
| **`npm run test:demurrage-ui` (soma das 3 suítes acima)** | **66/66** |
| Engine completa (`npm run test:demurrage-engine`) | ver rodapé — rodando em paralelo à redação deste relatório; resultado final na seção 7.1 |
| V1 (`npm test`) | **25/25** |
| `tsc --noEmit` | limpo |
| `npm run build` | limpo |

Zero falhas, zero testes ignorados.

### 7.1 Resultado final da engine completa

`npm run test:demurrage-engine` — **724/724**, zero falhas, zero
ignorados, idêntico ao baseline da D12 v1.2.3 (`f7ba55b`). Nenhuma
regressão introduzida por esta correção, que não tocou nenhum arquivo de
`src/demurrage-engine/**` (confirmado também por `git diff` vazio, seção
8).

## 8. Guardas de negócio — reconfirmadas nesta correção

As mesmas três camadas de evidência da entrega anterior continuam válidas
e foram reexecutadas:

1. **Guarda estática exaustiva**: nem `demurrage-v2-apresentacao.js` nem o
   script embutido de `DemurrageOperacional.dc.html` contêm, fora de
   comentários, `.sort(`, `.reduce(`, `Number(`, `parseFloat(`,
   `parseInt(`, nem o nome de nenhuma função de cálculo do motor.
2. **Comportamento testado**: `montarSecoesFila` nunca reordena — agrupa
   mantendo a ordem recebida, e verifica essa invariante a cada chamada;
   se o agrupamento um dia violasse a ordem, cai para uma seção única
   (`preservaOrdem:false`) em vez de reordenar (testado explicitamente,
   itens 18/18b/18c); `formatarGrupoFinanceiro`/`formatarAgregadoLado`
   nunca somam moedas diferentes; `subtotalConhecido` sai byte a byte em
   `subtotalExato`, e `formatarDecimalExatoBr` só reformata os MESMOS
   dígitos para o padrão BR (nunca `Number()`/arredondamento — testado com
   `0.30` para excluir o clássico erro de ponto flutuante).
3. **Superfície de rede restrita**: só `GET /api/demurrage/v2/*` (também
   confirmado em navegador real nesta correção — item 16 da seção 5), e o
   teste de integração com PostgreSQL real tira o fingerprint de TODO o
   schema antes/depois.
4. **Novo nesta correção**: teste estático (item 23) garante que o script
   embutido nunca referencia `DemurrageV2` fora de `window.DemurrageV2`
   (nenhuma referência solta que reproduziria o `ReferenceError` da
   auditoria), e que o módulo é importado uma única vez pelo helmet.
5. **Guarda de produto** (item 24): nenhum texto "Solicitar Minuta" nem
   "impacto total" no template — nenhuma ação simulada sem backend real,
   nenhum indicador fictício somando moedas/situações diferentes.

`git diff f7ba55b` permanece **vazio** em todos os arquivos protegidos:
`src/demurrage-engine/**`, `src/routes/demurrageRoutes.ts`,
`src/routes/demurrageV2Routes.ts`, `src/index.ts`, `public/support.js`,
`public/Demurrage.dc.html`, `public/Topbar.dc.html`,
`public/Exigem Atencao.dc.html`, `public/Relatorios.dc.html`,
`public/PortalCliente.dc.html`, `public/Courier Module.dc.html`,
`src/auditoria/**`. Nenhuma migration.

## 9. Rastreabilidade com o Blueprint

Nenhuma decisão nova de produto nesta correção — ela é estritamente uma
correção de runtime e de composição visual sobre o mesmo contrato D12
v1.2.3. As divergências já registradas no diagnóstico da D13
(`docs/demurrage-fase-d13-diagnostico.md`, DV-01 a DV-19) continuam
válidas sem alteração: DV-01, DV-03, DV-04, DV-05 já resolvidas de forma
aditiva pela D12 v1.2; DV-02, DV-06 a DV-19 permanecem adiadas para D14 ou
fase futura, pelos mesmos motivos já documentados (sem integração
financeira do HeadCargo, sem ações operacionais nesta tela somente
leitura, sem indicadores de Gestão do Cap. 30, Portal do Cliente
bloqueado por RBAC na própria API).

Nenhum defeito de contrato do backend foi encontrado nesta correção — o
contrato da D12 v1.2.3 continuou fornecendo tudo o que o dashboard
corretivo precisou (os indicadores do topo usam `/filtros` mais 3
consultas de contagem `limite=1`, já previstas no plano original, DV-06).

## 10. Limitações conhecidas

- **Resumo da coluna direita usa as contagens de `GET /filtros`**
  (`contarEstadosEBaldes` da D12), carregado numa segunda chamada depois
  da fila — nunca bloqueia a primeira renderização; se essa chamada falhar,
  o resumo some com "—" em vez de inventar um número.
- **"Maior risco atual" é sempre o primeiro item da fila oficial** (ordem
  do backend) — nenhuma comparação adicional é feita no navegador.
- **"Atualizações recentes" mostra só os 5 primeiros itens da fila**, com
  o tempo relativo de tracking/cálculo que a própria fila já trouxe —
  decisão explícita para não criar N+1 requisições de timeline por
  processo; a linha do tempo completa de qualquer processo continua
  disponível ao abri-lo.
- **Sem indicador de "impacto total"** — decisão consciente (DV-06): o
  contrato D12 não consolida valores da fila inteira, e somar no
  navegador misturaria moedas e situações (estimado × confirmado,
  cliente × Rocket).
- **Status financeiro do HeadCargo**: texto fixo "Não disponível" (sem
  integração) — igual à entrega anterior, previsto pelo Cap. 27.3 do
  Blueprint.
- **Tour de onboarding do Sidebar** não foi atualizado com um passo
  específico para o item novo — mesma limitação já registrada na entrega
  anterior, marcada como opcional no diagnóstico.
- **Ações operacionais continuam fora de escopo** — a tela é só leitura;
  nenhum botão simula uma ação sem endpoint real por trás (confirmado por
  teste estático, item 24).

## 11. Limites respeitados

Não reabri nem alterei D10, D11, D12 (motores tarifários, relógios, Free
Time, responsabilidade, cadência, apuração, fechamento), rotas V1,
Portal, Supabase, HeadCargo, Courier, Auditoria. Nenhuma migration.
Nenhuma ação operacional criada. A tela é estritamente
`GET /api/demurrage/v2/*`; nenhuma escrita, comprovada por teste com banco
real e, nesta correção, também por teste em navegador real pela casca.
`support.js` não foi tocado; nenhuma segunda cópia do módulo de
apresentação foi criada; `Topbar.dc.html` não foi tocado (só uma regra de
CSS escopada ao módulo Demurrage corrige a quebra do título).

**A D13 não está aprovada nem congelada.** A D14 não foi iniciada.
