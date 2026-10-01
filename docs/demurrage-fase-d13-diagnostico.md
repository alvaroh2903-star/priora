# Fase D13 — Tela Operacional Interna da Demurrage: diagnóstico e plano

> **Status:** diagnóstico e plano, **sem código**, aguardando validação.
> Base: D12 v1.1 aprovada e congelada em `1bdd406`. Nada foi alterado no
> repositório além deste documento. D13 **não** está aprovada nem congelada.

## 0. Resumo

**Fonte funcional.** Li integralmente o Blueprint
`Blueprint_Demurrage_Priora_V1_Revisado_V2_Estilo_Priora23-09` (versão
revisada V2, 23/09/2026, 32 capítulos). O caminho `C:\Users\diogo\...` não é
acessível deste contêiner; usei o arquivo enviado a esta sessão com o mesmo
nome. As duas cópias enviadas (com e sem extensão `.docx`) e a cópia extraída
anteriormente são idênticas (SHA-256 `02bdc440…6f01421d`).

**Como a D13 entra no frontend.** O painel é um shell de "DesignCode"
(`public/Priora.dc.html` + `support.js`, React 18 e Babel carregados de CDN),
com um arquivo `.dc.html` por módulo. A D13 entra como **um módulo novo**,
`public/DemurrageOperacional.dc.html`, mais um arquivo JS puro de
apresentação, com **duas alterações pequenas** de navegação (`Priora.dc.html`
e `Sidebar.dc.html`). O módulo Demurrage V1 existente (`Demurrage.dc.html`,
baseado em e-mails do Outlook) não é tocado, e nem as rotas V1.

**O que a cobertura do Blueprint mostrou.** A D12 sustenta a maior parte da
tela (fila oficial, dois relógios, envelopes de valor, pendências, falhas,
responsabilidade, timeline, filtros). Mas o Blueprint pede, para a tela
operacional, informações que **o contrato congelado da D12 não fornece** ou
fornece de forma **inconsistente entre endpoints**. As mais importantes:

1. **DV-04 — estado/prioridade divergem entre fila e detalhe.** Desde a v1.1,
   a fila deriva estado e prioridade com o hoje operacional; o detalhe do
   processo, o detalhe do contêiner e as contagens de `/filtros` ainda leem
   as colunas persistidas (e o detalhe fixa `promocaoTopo: false`). Abrir um
   processo da fila pode mostrar outro estado/prioridade.
2. **DV-03 — a tela não consegue dizer qual contêiner gerou a prioridade.**
   Nem o item da fila nem o detalhe trazem o contêiner-líder.
3. **DV-01 — valores do processo.** O Blueprint (Caps. 25 e 28.3) pede totais
   do processo por moeda, com indicação de composição mista; a fila da D12
   entrega só o envelope do contêiner-líder.
4. **DV-05 — próximo vencimento / dias restantes** (Caps. 21.2, 28.2, 28.4)
   não existem no contrato; calculá-los no navegador seria duplicar a regra
   temporal do Cap. 6.

Nenhuma dessas divergências foi resolvida silenciosamente. Estão na seção 12
com impacto e recomendação, e as decisões pendentes estão na seção 13.

## 1. Como o painel atual está estruturado

| Peça | Arquivo | Papel |
|---|---|---|
| Servidor estático | `src/index.ts` (`express.static(public)`, `GET /` → `Priora.dc.html`) | Serve todos os arquivos de `public/` sem autenticação (os arquivos não contêm dados; os dados vêm das APIs) |
| Runtime | `public/support.js` (gerado de `dc-runtime`, "do not edit") | Interpreta `<x-dc>`: template com `{{ }}`, `<sc-if>`, `<sc-for>`, `<dc-import name="X">` (carrega `X.dc.html`) e uma classe `Component extends DCLogic` (React). Carrega React 18.3.1, ReactDOM e **Babel standalone** de `unpkg.com` em tempo de execução |
| Shell | `public/Priora.dc.html` | Sidebar fixa (250 px) + uma `<div data-view>` por módulo. A aba ativa vem de `location.hash` (`#demurrage`, `#couriers`…); só aceita chaves da lista `KEYS`. Monta os módulos sob demanda e "aquece" os demais em segundo plano |
| Navegação | `public/Sidebar.dc.html` | Links `href="X.dc.html"` interceptados pelo shell (`HREF2KEY`); grupo "Gestão" (Exigem Atenção, Equipe, Relatórios); tema claro/escuro; tour de onboarding |
| Cabeçalho | `public/Topbar.dc.html` | Título, subtítulo, ícone, notificações e perfil (perfil em `localStorage`) |
| Barramento | `public/priora-bus.js` | `PrioraBus.focus(módulo, id)` (navega e foca um item), `consume`, `scrollToSel` |
| Módulos | `Inicio`, `Fila de Decisoes`, `Auditoria`, `Processos`, `Liberacao`, `Courier Module`, `Demurrage` (V1), `Exigem Atencao`, `Equipe e Desempenho`, `Relatorios`, `PortalCliente`, `Login` | Cada um é um `.dc.html` autocontido, com estilos inline |

Consumidores atuais de Demurrage: `Demurrage.dc.html` usa `GET /api/demurrage`
e `POST /api/demurrage/solicitar-minuta`; `Exigem Atencao.dc.html` e
`Relatorios.dc.html` também leem `GET /api/demurrage` (V1). **Nenhum** usa a V2.

O módulo V1 calcula prazos, dias e valores **no navegador** a partir de
extração de e-mail e soma valores para os KPIs (`moneyOf`, `sumOrNull`). Isso
contraria os Caps. 5, 11, 25 e 30.6 e as regras da D13; **nada dele será
reaproveitado como lógica**.

## 2. Onde o módulo entra na navegação

**Recomendação (U-01):** novo item de menu **"Demurrage Operacional"**, logo
abaixo de "Demurrage", com chave de shell `demurrageop` e hash
`#demurrageop`.

- Não substitui a aba V1: `Demurrage.dc.html`, `Exigem Atenção` e
  `Relatórios` continuam consumindo `/api/demurrage` sem mudança.
- A aposentadoria da V1 (ou a troca de nome das duas entradas) fica para
  uma decisão posterior, fora da D13.
- Alternativas registradas para a sua escolha:
  - (b) trocar o link "Demurrage" para a V2 e esconder a V1 — altera a tela
    V1 que hoje está em uso;
  - (c) abas internas dentro de `Demurrage.dc.html` — exige editar o módulo
    V1.

Dentro do módulo, a navegação é interna (estado do componente), em três
níveis: **Fila → Detalhe do processo → Detalhe do contêiner**. A timeline é
uma aba do detalhe do processo. O shell só reconhece o hash exato da chave;
para não alterar o shell além do mínimo, o detalhe é aberto por estado
interno, e **links profundos** usam o mecanismo existente
`PrioraBus.focus('demurrageop', processoId)` (U-07).

## 3. Componentes e padrões visuais reutilizáveis

| Reuso | Origem | Como |
|---|---|---|
| Topbar (título, subtítulo, ícone) | `Topbar.dc.html` via `<dc-import name="Topbar">` | Igual aos demais módulos |
| Paleta, tipografia, raios, sombras | Todos os módulos (Plus Jakarta Sans, JetBrains Mono para códigos, `#161A2E` texto, `#4327E6` primário, `#E5484D` crítico, `#E8990C` atenção, `#1F9D6B` ok, cartões `#fff` com borda `#EAEBF4`) | **Usar exatamente os mesmos hex**: o tema escuro do Sidebar troca cores por seletor de atributo (`[style*="background: rgb(255, 255, 255)"]`); cores fora da paleta não ganham tema escuro |
| Estados carregando/erro/vazio | `Demurrage.dc.html` (spinner, cartão de erro com "Tentar novamente", cartão vazio) | Mesmo visual; **textos e lógica novos** (o V1 exibe a mensagem crua do servidor, o que a D13 proíbe) |
| Cartões de KPI | `Demurrage.dc.html`, `Exigem Atencao.dc.html` | Grid `auto-fit` |
| Linhas de tabela com grid fixo | `Processos.dc.html`, `Courier Module.dc.html` (`grid-template-columns` fixo + `row-hover`) | Fila em modo tabela |
| Painel lateral / layout 2 colunas | `minmax(0,1fr) 320px` (Processos, Courier, Demurrage V1) | Detalhe do processo com coluna lateral de pendências/falhas |
| Overlay modal | `Courier Module.dc.html` (`position:fixed;inset:0;rgba(22,26,46,.45)`) | Opcional para o detalhe do contêiner |
| Classes utilitárias | `.solid-btn`, `.ghost-btn`, `.row-hover`, `.chev` | Copiadas no `<helmet>` do novo módulo |
| Foco cruzado | `priora-bus.js` | Abrir processo a partir de outro módulo (futuro) |

## 4. Limitações técnicas do frontend atual

1. **Dependência de CDN em tempo de execução.** React, ReactDOM e Babel vêm
   de `unpkg.com`. Neste contêiner o proxy bloqueia `unpkg.com` (403), então
   **um teste de navegador do app real não carrega aqui** sem uma cópia
   local desses arquivos (U-11).
2. **Sem build nem módulos.** O JS do módulo é transpilado no navegador; não
   há bundler, TypeScript nem testes de frontend no repositório (`npm test`
   cobre só a Auditoria/pré-alerta).
3. **Sem responsividade estruturada.** Nenhum `@media` no shell nem nos
   módulos operacionais (só Relatórios e Portal); sidebar fixa de 250 px. Os
   módulos se adaptam por grids `auto-fit`.
4. **Sem acessibilidade.** Nenhum `role`, `aria-*` ou `tabindex` nos módulos;
   navegação só por clique.
5. **Hash do shell só com a chave exata.** Sub-rotas (`#demurrageop/processo/…`)
   cairiam em "Início"; o shell precisaria de mudança para aceitá-las.
6. **Tema escuro por casamento de cor inline.** Cores novas não são
   adaptadas automaticamente.
7. **Papel do usuário desconhecido no frontend.** Nenhum endpoint devolve o
   papel nem a organização. O menu não sabe esconder itens para `CLIENT`;
   quem não tem papel interno recebe `403` da API.
8. **Tratador central de erro devolve `err.message`.** Em erro inesperado
   (`500`), `src/index.ts` responde a mensagem interna. A D12 só usa esse
   caminho para erros não previstos, mas o frontend **nunca** deve exibir o
   campo `error` de um `500` (seção 5).

## 5. Autenticação, sessão e erros HTTP

| Situação | Hoje | Na D13 |
|---|---|---|
| Sem login ou conta trocada | O shell chama `GET /api/me`; se `authenticated: false`, mostra a tela "Entrar com a Microsoft" | Igual (o shell cuida) |
| `401` em qualquer `/api/*` | O shell envolve `window.fetch` e abre "Sua sessão expirou" | Igual. O módulo para de carregar e mostra o estado "Sessão encerrada" sob a sobreposição |
| `403 usuario_sem_papel_interno` | Não existe hoje | Tela "Acesso restrito à equipe interna", sem detalhes técnicos e sem nova tentativa automática |
| `409 organizacao_ambigua` | Não existe hoje | Tela "Seu usuário pertence a mais de uma organização; a seleção de organização ainda não está disponível. Fale com o administrador." Sem listar os IDs que a API devolve |
| `409 ordem_alterada` | Não existe hoje | Aviso "A fila mudou desde a última página. Recarregamos a partir do início." e recarga automática da primeira página com os mesmos filtros |
| `400 cursor_invalido` | — | Mesmo tratamento de `ordem_alterada` (reinicia), com texto neutro |
| `400 valor_invalido` / `parametro_nao_aceito` | — | Indica erro de programação do cliente: mensagem genérica "Filtro inválido" e o filtro volta ao padrão |
| `404 nao_encontrado` | — | "Processo/contêiner não encontrado ou sem acesso" (a API não distingue os dois casos, de propósito) |
| `5xx`, rede, tempo excedido | V1 exibe a mensagem crua | "Não foi possível carregar. Tentar novamente." **Nunca** exibir `error`, stack ou corpo |

Regra única: o módulo decide o texto **pelo status + código** da API, a
partir de uma tabela fixa no código. Nenhum texto do servidor é exibido. A
D13 **não envia** `organizationId` em nenhum canal (a D12 responde `400`).

## 6. Como implementar sem tocar no que é proibido

- **Não alterados:** Auditoria, Courier, tracking, D10, D11, D12
  (`src/demurrage-engine/**`, `src/routes/demurrageV2Routes.ts`), rotas V1
  (`src/routes/demurrageRoutes.ts`), `Demurrage.dc.html`,
  `Exigem Atencao.dc.html`, `Relatorios.dc.html`, `PortalCliente.dc.html`,
  `support.js`, `src/index.ts`. Nenhuma migration.
- **Somente leitura:** o módulo só faz `GET` em `/api/demurrage/v2/*`. Sem
  `POST`, sem criação de processo, sem ações.
- **Sem regra de negócio no navegador:** o JS formata e rotula o que a API
  devolve. Não ordena a fila, não deriva estado, não calcula dias, prazos ou
  valores, não soma. Isso é verificado por teste (seção 14, G2/G4).
- **Prova de regressão:** suíte da engine, V1, `tsc`, build e um teste que
  compara os arquivos proibidos com `1bdd406` (diff vazio).

## 7. Arquivos a criar ou alterar

| Arquivo | Ação | Conteúdo |
|---|---|---|
| `public/DemurrageOperacional.dc.html` | **criar** | Módulo: fila, filtros, detalhe do processo, detalhe do contêiner, timeline e estados |
| `public/demurrage-v2-apresentacao.js` | **criar** | JS puro (UMD, sem DOM): rótulos dos envelopes, formatação de data/moeda sem soma, tabela de mensagens por código HTTP, montagem da query string, máquina de paginação por cursor. Carregado no `<helmet>` como o `priora-bus.js` e testável em Node |
| `public/Priora.dc.html` | **alterar (mínimo)** | +1 chave `demurrageop` em `KEYS`/`HREF2KEY` e +1 `<div data-view>` |
| `public/Sidebar.dc.html` | **alterar (mínimo)** | +1 link, +1 entrada de estilo ativo, +1 opção na lista `active` e, opcionalmente, +1 passo do tour |
| `src/frontend-tests/demurrageV2Apresentacao.test.ts` | **criar** | Testes `node:test` do JS de apresentação |
| `src/frontend-tests/demurrageV2Tela.e2e.test.ts` | **criar (condicional, U-11)** | Playwright contra o app real com a D12 servida por um banco de teste |
| `package.json` | **alterar (U-11)** | Script `test:demurrage-ui`; dependências de teste se a U-11 for aprovada |
| `docs/demurrage-fase-d13.md` | **criar** | Relatório de entrega |

## 8. Hierarquia da tela

Ordem de leitura pensada para responder, em poucos segundos: qual processo
precisa de atenção, por quê, qual contêiner, como estão os dois relógios,
custo do cliente, exposição da Rocket e qual pendência ou falha resolver.

```
┌ Topbar: "Demurrage Operacional" · subtítulo · última atualização da fila ───────────┐
├ Faixa de alertas (só se houver): falhas técnicas · tracking desatualizado ·         ┤
│   pendências de dados  (contagens da página/fila, nunca texto técnico)               │
├ Resumo (U-05): Crítico 15+ · Crítico 7–14 · Atenção 1–6 · Devolvidos em tratamento · │
│   Prazo preventivo · Tracking desatualizado   — cada um clicável = aplica o filtro   │
├ Filtros: [Busca: processo, BL ou contêiner] [Responsável][Cliente][Armador]          ┤
│   [Estado][Prioridade]  ☐Pendência ☐Falha ☐No Free Time ☐Em demurrage ☐Devolvido     │
│   ☐Resp. em análise ☐Exposição indisponível  Período: (•)Descarga ( )Devolução       │
│   [de][até]  ☐Incluir silenciosos   [Limpar]   "Mostrando N de TOTAL"                │
├ Fila (ordem da API, nunca reordenada) ──────────────────────────────────────────────┤
│ ▌CRÍTICO 15+  IM2151 · Cliente X · HBL … · MBL … · MAERSK · Resp.: Ana              │
│ ▌  Motivo: "Cliente/Rocket em demurrage (16 dias); escalada/contato obrigatório"     │
│ ▌  Badges: [Cliente em demurrage] [Rocket exposta] [Escalada obrigatória]            │
│ ▌  Contêineres: 3 · 1 em demurrage · 2 devolvidos · 0 com pendência                  │
│ ▌  Cliente (contêiner líder): US$ 2.400 ESTIMADO │ Rocket (líder): Indisponível      │
│ ▌  Pendências 2 · Falhas 1 · Tracking há 3 h · Atualizado há 10 min        [Abrir ›] │
│   … [Carregar mais]                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Detalhe do processo** (o que exige ação vem primeiro, Cap. 29):

```
← Fila   IM2151 · Cliente X · HBL/MBL · Armador · Responsável · Apuração OPEN/FINAL
[Avisos no topo: falhas técnicas por tipo · pendências por tipo · relógio pendente]
Estado + prioridade + motivo (DV-04: ver origem)   Composição dos contêineres
Abas: [Contêineres] [Timeline] [Fechamento e reaberturas]
Contêineres: tabela resumida (número, estado, descarga, LFD cliente, LFD Rocket,
  dias cliente, dias Rocket, Empty Return, tracking, minuta) → abrir contêiner
```

**Detalhe do contêiner:**

```
Contêiner MSKU1234567 · estado · badges · Gate Out · Empty Return · tracking
┌ RELÓGIO DO CLIENTE (House) ─────────────┐ ┌ RELÓGIO DA ROCKET (Master) ─────────────┐
│ Descarga 01/09 (fonte, observado em)    │ │ Descarga 01/09 (fonte, observado em)    │
│ House Free Time 14 d (fonte)            │ │ Master Free Time 10 d (fonte)           │
│ Último dia livre 14/09                  │ │ Último dia livre 10/09                  │
│ 1º dia de demurrage 15/09               │ │ 1º dia de demurrage 11/09               │
│ Apurado até 20/09                       │ │ Apurado até 20/09                       │
│ Dias de demurrage: 6                    │ │ Dias de exposição: 10                   │
│ Valor: US$ 900 · ESTIMADO               │ │ Exposição: indisponível                 │
│ Tabela v2 · fonte · vigência            │ │ Tabela do armador · versão · fonte      │
│ Situação do cálculo: válido/desatual.   │ │ Situação do cálculo: válido/desatual.   │
└─────────────────────────────────────────┘ └─────────────────────────────────────────┘
Minutas (estado, data informada/validada, divergência)
┌ INFORMAÇÃO INTERNA — RESPONSABILIDADE ROCKET × CLIENTE ──────────────────────────────┐
│ Estado derivado · decisão vigente (versão, base, dias, valores, autor, data,         │
│ justificativa, evidência) · invalidação (motivo) · histórico de versões              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Os dois relógios ficam **lado a lado e com títulos distintos**; não existe
campo "status geral". Em telas estreitas eles empilham (cliente primeiro), e
cada bloco repete o título.

**Telas menores (abaixo de cerca de 1.100 px de conteúdo):** a fila passa de
tabela para cartões; os filtros recolhem em "Filtros (N ativos)"; o detalhe
vira uma coluna única. A sidebar do shell continua fixa (limitação 4.3, fora
do escopo).

## 9. Regras de apresentação (contrato D12 → tela)

| Regra | Implementação |
|---|---|
| Ordem da fila | Renderizar `itens` na ordem recebida; páginas seguintes acrescentadas ao fim. Nenhum `sort` |
| Envelope de valor | `CONFIRMADO` → "Confirmado"; `ESTIMADO` → "Estimado"; `ESTIMADO_PROVISORIO` → "Estimativa provisória — sujeita à confirmação" (Cap. 24.3.1); `INDISPONIVEL` → "Valor ainda não disponível" (Rocket: "Exposição ao armador ainda não disponível"); `PENDENTE` → "Pendente de cálculo"; `NAO_APLICAVEL` → "Sem demurrage" |
| Valor numérico | Só exibido quando `total !== null`, sempre com a `moeda` ao lado. `null` nunca vira `0`, `—` ou "R$ 0" |
| Moedas | Nunca somar. Cada valor aparece com a sua moeda |
| Estimado × confirmado | Selo textual sempre visível junto do número; a cor reforça, mas não substitui o texto (Caps. 22.7 e 28.5) |
| `null` em qualquer campo | "Não informado" / "Sem registro" conforme o campo; nada inferido |
| Datas | `CivilDate` (AAAA-MM-DD) formatada como DD/MM/AAAA sem conversão de fuso; instantes ISO exibidos em horário local com indicação relativa ("há 3 h") |
| Relógio `PENDING` | "Relógio pendente" + motivo: `DESCARGA_AUSENTE` → "Aguardando descarga"; `FREE_TIME_AUSENTE` → "Free Time ausente"; código desconhecido → "Dado pendente" |
| Relógio `INVALID` | "Cálculo inválido — requer verificação" (sem exibir `motivo` técnico livre) |
| `cache: OBSOLETO` | "Cálculo desatualizado em relação aos dados atuais; será refeito pelo processamento automático" |
| Processo sem contêiner derivado | `estadoMaisRelevante.codigo = NAO_DERIVADO`: rótulo "Ainda não derivado", **sem** mostrar o balde `SILENCIOSO` que a API preenche nesse caso |
| Badges | Rótulo em português por código; código desconhecido é exibido como está |
| Responsabilidade | Sempre dentro do bloco "Informação interna", em detalhe de contêiner; nunca na fila |
| Timeline | Só `resumo`, `tipo` (rotulado), `dataOperacional`, `registradoEm`, `origem`, `fonte`, `autor.nome`, `evidenciaRef`, `containerId`/`escopo`. Sem interpretar nada |

## 10. Estados da interface

| Estado | Comportamento |
|---|---|
| Carregando (primeira vez) | Esqueleto da fila (5 linhas) com `aria-busy`; filtros já visíveis e desabilitados |
| Carregando (mudança de filtro/página) | Mantém a lista atual esmaecida com indicador; descarta respostas atrasadas (só vale a última requisição) |
| Lista vazia sem filtro | "Nada exige ação agora." + atalho "Ver também os processos em monitoramento silencioso" (liga `incluirSilenciosos`) |
| Lista vazia com filtro | "Nenhum processo atende aos filtros." + "Limpar filtros" |
| Erro de conexão / 5xx | Cartão "Não foi possível carregar" + "Tentar novamente"; lista anterior preservada se existir |
| 401 | Sobreposição do shell; o módulo para e mostra "Sessão encerrada" |
| 403 | "Acesso restrito à equipe interna" |
| 409 `organizacao_ambigua` | Texto da seção 5; sem tentar de novo |
| 409 `ordem_alterada` | Aviso discreto e recarga da 1ª página |
| Valor pendente / indisponível | Selos da seção 9 |
| Relógio pendente | Bloco do relógio com o motivo; o outro relógio continua exibido normalmente (Cap. 12) |
| Processo sem contêiner derivado | Cartão sem prioridade; texto "Ainda não derivado" |
| Timeline vazia | "Nenhum evento registrado para este processo." |
| Detalhe 404 | "Não encontrado ou sem acesso" + voltar à fila |

## 11. Matriz de rastreabilidade do Blueprint (capítulo a capítulo)

Legenda: **Atendida** = a D13 cumpre com o contrato atual; **Não atendida** =
o Blueprint pede e a D13 não entrega; **Fase futura** = depende de dado ou
integração inexistente; **Decisão** = referência às seções 12 e 13.

| Cap./regra | Elemento D13 | Dado / endpoint D12 | Atendida | Não atendida | Fase futura | Decisão |
|---|---|---|---|---|---|---|
| 1 — ver último dia livre dos dois relógios | Detalhe do contêiner | `GET /containers/:id` `relogios.*.ultimoDiaLivre` | Sim, no detalhe | Não aparece na fila | Campo na fila | DV-05 |
| 1 — se algum prazo terminou | Badges, estado, dias por relógio | `badges`, `relogios.*.dias` | Sim | — | — | — |
| 1 — valor do cliente e exposição | Cartão e detalhe | `exposicaoFinanceira` (líder), `relogios.*.valor` | Parcial | Total do processo | Totais | DV-01 |
| 1 — devolvido / minuta faltando | Composição, Empty Return, minutas | `conteineres.devolvidos`, `emptyReturn`, `minutas`, `documentaryStatus` | Sim | Filtro de minuta pendente | Filtro | DV-14 |
| 1 — próxima ação necessária | Motivo + badges (`escalationRequired`) | `motivoPrioridade`, `badges` | Parcial (texto do motor) | "Próxima ação" explícita | — | U-04 |
| 2 — sem valor incerto como definitivo | Envelopes de valor | `valor.situacao` | Sim | — | — | — |
| 3 — processo = apresentação; contêiner = cálculo | Fila por processo, detalhe por contêiner | fila + detalhe | Sim | — | — | — |
| 3 — devolvido e em demurrage no mesmo processo | Composição + lista de contêineres | `conteineres.*`, `estado` por contêiner | Sim | — | — | — |
| 4 — fonte e data de cada dado | Detalhe: fonte/observado em de descarga e Free Times | `descarga.fonte/observadoEm`, `freeTime.fonte/observadoEm/fallbackManual` | Parcial | Fonte do tipo de contêiner, fonte alternativa | Campos | DV-09 |
| 4 — divergência entre fontes sinalizada | Pendências por tipo (ex.: `free_time_divergencia`) | `pendenciasAbertas.porTipo` | Sim (contagem) | Detalhe das fontes conflitantes | Campo | — |
| 5 — dois relógios independentes | Dois blocos separados | `relogios.cliente` / `relogios.rocket` | Sim | — | — | — |
| 5/11/24.3/25 — diferença potencial | **Não exibida** | — | — | Sim | D14 | DV-02 |
| 6 — datas derivadas para conferência | Descarga, Free Times, LFD, 1º dia, data final, por relógio | `relogios.*` | Sim | — | — | — |
| 7 — condição comercial aplicada | Tabela do cliente | `relogios.cliente.tabela` | Parcial | Modelo do termo (embarque/único) | Campo | DV-10 |
| 8 — tabela, versão, fonte | Bloco "Tabela" de cada relógio | `tabela.{id,versao,fonte,qualidade,vigencia*}` | Sim | Faixas e dias por faixa | Memória de cálculo | DV-10 |
| 9 — tipo original e normalizado | — | Não existe no detalhe | — | Sim | Campo | DV-09 |
| 10 — permissões (Analista × Gestor) | Tela só leitura para os 3 papéis internos | RBAC da D12 | Sim (nada é alterável) | Ações por papel | Fase de ações | DV-15 |
| 10 — consulta manual de tracking só Gestor | Não exibida | — | Sim (não exibir) | — | Fase de ações | DV-15 |
| 11 — três resultados separados | Cliente e Rocket separados | `valor` por relógio | Parcial | Diferença potencial | D14 | DV-02 |
| 11/12/23 — "apurado até" | "Apurado até DD/MM" por relógio | `dataFinalApuracao` | Sim no detalhe | Na fila | Campo | DV-19 |
| 12 — pendência num relógio não bloqueia o outro | Blocos independentes | `status` por relógio | Sim | — | — | — |
| 12 — exceção mostra dado, fontes e cálculo afetado | Aviso no topo do detalhe + relógio pendente | `pendencias`, `pendenciasAbertas` | Parcial | Fontes encontradas | Campo | — |
| 13 — monitorado ≠ fila | Fila padrão sem silenciosos; opção para incluir | `incluirSilenciosos` | Sim | — | — | U-06 |
| 14 — fotografia e versões | Não exibida | Sem endpoint de fotografia | — | Visualizar fotografia | Fase futura | — |
| 15 — mostrar quando a resposta de tracking foi obtida | "Tracking há X" | `trackingAtualizadoEm` | Sim | — | — | — |
| 16 — cadência | Não exibida (motor) | — | — | Próxima consulta | Campo | DV-08 |
| 16.7/31.13 — tracking suspenso após 30 dias | — | Não exposto | — | Sim | Campo | DV-08 |
| 17 — última atualização, próxima consulta, em andamento, última tentativa falhou | "Tracking há X", falha ativa | `trackingAtualizadoEm`, `falhaTrackingAtiva`, `falhasTecnicas` | Parcial | Próxima consulta, "em andamento" | Campos | DV-08 |
| 17 — tela nunca bloqueia aguardando tracking | Só lê a API | — | Sim | — | — | — |
| 17.1 — botão Atualizar tracking (Gestor) | Ausente | — | — | Sim | Fase de ações | DV-15 |
| 18 — falha não apaga última informação; sinalizar desatualizado | Falhas por tipo + estado `TRACKING_DESATUALIZADO` | `falhasTecnicas`, `estado`, timeline `falha_tracking` | Sim | — | — | — |
| 18 — incidente agrupado por armador | — | Não existe | — | Sim | Campo | DV-08 |
| 18 — alerta técnico com erro HTTP | **Não exibido** na tela operacional (vai ao desenvolvedor) | — | Sim (não expor) | — | — | — |
| 19 — devolução, evento, valores até a data | Empty Return + relógios | `emptyReturn`, `relogios.*` | Sim | — | — | — |
| 19/21.8 — rótulo "aguardando comprovação" × "aguardando tratamento" | "Devolvido — aguardando tratamento" | `estado` | Sim (21.8) | — | — | DV-18 |
| 19.1/31.14 — minuta divergente do tracking | Minutas: "divergente do tracking" | `minutas[].divergenteDoTracking` | Sim | — | — | — |
| 20/21.9 — concluído sem custo sai da fila | Fila padrão | ordem da D12 | Sim | — | — | — |
| 20.3 — estados separados (interno, documental, financeiro) | Estado, `documentaryStatus`, apuração | `estado`, `documentaryStatus`, `apuracaoStatus` | Parcial | Estado financeiro | HeadCargo | DV-07 |
| 21.1–21.9 — estados por contêiner | Rótulos dos 8 estados | `estado` | Sim | — | — | — |
| 21.2 — qual relógio vence primeiro e dias restantes | — | Não existe | — | Sim | Campo | DV-05 |
| 21.2/22.5 — "Prazo próximo" | Rótulo existe | Limiar `DEMURRAGE_PRAZO_PROXIMO_DIAS` não configurado → estado nunca emitido | Rótulo pronto | Estado inativo | Configuração | DV-05 |
| 21.3/22.3 — indicar quem está em demurrage | Badges `clienteEmDemurrage`, `rocketExposta` | `badges` | Sim | — | — | — |
| 21.4 — destacar dias, valor do cliente e exposição | Cartão crítico | `motivo`, `exposicaoFinanceira` | Parcial | Dias por relógio na fila | Campo | DV-05 |
| 21.5/22.1 — escalada obrigatória explícita | Badge "Escalada obrigatória" em destaque | `badges: escalationRequired` | Sim | — | — | — |
| 21.10 — processo assume o estado mais relevante | Estado do cartão | `estadoMaisRelevante` | Sim na fila | Diverge no detalhe | Correção na D12 | **DV-04** |
| 22 — ordem da fila | Render na ordem da API | `GET /processos` | Sim | — | — | — |
| 22.1 — promoção ao topo no 15+ | Indicador "Promovido ao topo" | `prioridade.promocaoTopo` | Sim na fila | Sempre `false` no detalhe | Correção na D12 | DV-04 |
| 22.2 — divergência de valor em destaque | Badge `divergenciaValor` se vier | `badges` | Rótulo pronto | Motor nunca emite | Fase futura | DV-16 |
| 22.6 — silenciosos acessíveis por pesquisa e filtros | Busca + "Incluir silenciosos" | `busca`, `incluirSilenciosos` | Parcial | Busca não traz silencioso se a opção estiver desligada | — | DV-17 |
| 22.7 — motivo em texto, não só cor | Linha "Motivo:" sempre visível | `motivoPrioridade` | Sim | — | — | — |
| 23 — dias por relógio, data final | Detalhe do contêiner | `dias`, `dataFinalApuracao` | Sim | — | — | — |
| 24.1/24.2 — modelo comercial | Tabela do cliente | `tabela` | Parcial | Rótulo do modelo | Campo | DV-10 |
| 24.3 — exposição estimada/confirmada/indisponível | Selos | `valor.situacao` | Sim | — | — | — |
| 24.3 — preservar estimativa anterior para comparação | — | Não existe | — | Sim | Campo | DV-11 |
| 24.3.1 — PIL provisória: texto "sujeita à confirmação" | Selo de estimativa provisória | `ESTIMADO_PROVISORIO` | Sim | — | — | — |
| 24.3.1 — indisponível nunca é zero | Regra da seção 9 | `total: null` | Sim | — | — | — |
| 24.4 — conferência de dias, faixas, tarifas | Bloco "Tabela" | `tabela` | Parcial | Memória de cálculo completa | Campo | DV-10 |
| 25 — totais do processo por moeda, com composição de estados | — | Só valor do líder | — | Sim | Campo | **DV-01** |
| 25 — contêiner sem valor fora da soma, como pendência | Selo por contêiner no detalhe | `valor.situacao` | Sim (no detalhe) | Na fila | Campo | DV-01 |
| 26 — responsabilidade interna, decisão humana | Bloco "Informação interna" | `interno.responsabilidade` | Sim | — | — | — |
| 26.1–26.2 — sugestão e possível responsabilidade Rocket | — | Sem integração com Liberação | — | Sim | Liberação | DV-13 |
| 26.4 — datas apta/liberação/intervalo sugerido | Exibe dias, valores, autor, data, justificativa, evidência | decisão D11 | Parcial | Datas da Liberação | Liberação | DV-13 |
| 27 — HeadCargo (status financeiro) | "Status financeiro não disponível" (texto do Cap. 27.3) | — | Sim (texto previsto pelo próprio Blueprint) | Status real | HeadCargo | DV-07 |
| 28.1 — resumo superior, alertas, última atualização, concluídos | Faixa de alertas, resumo, "Incluir silenciosos" / estado concluído | `/processos` (`total` por filtro), `/filtros` | Parcial | Exposição estimada/confirmada total; tratamento financeiro | Campos | DV-06 |
| 28.2 — card | Cartão da fila | item da fila | Parcial | Próximo vencimento | Campo | DV-05 |
| 28.3 — multi-contêiner: composição e prioridade do mais urgente | Composição | `conteineres` | Parcial | Qual contêiner é o líder; totais | Campos | DV-03, DV-01 |
| 28.4 — dois relógios no card | Cartão: valor cliente × exposição Rocket (líder) | `exposicaoFinanceira` | Parcial | Dias/dias restantes por relógio no card | Campo | DV-05 |
| 28.5 — prioridade visível em texto | Motivo + badges | `motivoPrioridade`, `badges` | Sim | — | — | — |
| 28.6 — ações rápidas | Só "Abrir" e "Timeline" | — | Parcial | Correção, tratativa, financeiro, atualizar tracking | Fase de ações | DV-15 |
| 28.7 — filtros | 15 filtros da D12 | `/processos`, `/filtros` | Parcial | Estado financeiro, vencimento, tracking (só por estado), exposição estimada/confirmada, minuta pendente | Campos | DV-14 |
| 28.7 — busca por processo, BL e contêiner | Campo de busca | `busca` | Sim | — | — | — |
| 29.1 — resumo do processo | Cabeçalho do detalhe | `GET /processos/:id` | Parcial | Estado financeiro, próxima consulta | Campos | DV-07, DV-08 |
| 29.1 — avisos no início da tela | Faixa de avisos do detalhe | `pendenciasAbertas`, `falhasTecnicas` | Sim | — | — | — |
| 29.2 — lista de contêineres | Tabela de contêineres | `conteineres[]` | Parcial | Tipo original/normalizado | Campo | DV-09 |
| 29.2 — alternar resumida/completa | Linha resumida → detalhe do contêiner | — | Sim | — | — | — |
| 29.3 — valores do contêiner | Relógios + bloco interno | `valor`, `interno.responsabilidade` | Parcial | Diferença potencial, financeiro, memória de cálculo | Campos | DV-02, DV-07, DV-10 |
| 29.4 — linha do tempo, automático × humano | Aba Timeline | `GET /processos/:id/timeline` | Parcial | Vencimentos, início da demurrage, liberação, solicitações de correção, cobrança, pagamentos | Eventos | DV-12 |
| 29.5–29.6 — ações do Analista/Gestor | Ausentes | — | — | Sim | Fase de ações | DV-15 |
| 29.7 — documentos e evidências | Só `evidenciaRef` exibida como texto | `evidenciaRef` | Parcial | Vincular e listar documentos | Fase futura | DV-15 |
| 30 — Gestão e indicadores | Fora da D13 | — | — | Sim | D14 | — |
| 30.6/31.10 — moedas separadas | Regra da seção 9 | `moeda` | Sim | — | — | — |
| 31.1 — sem descarga | "Aguardando descarga" | `pendencias: DESCARGA_AUSENTE` | Sim | — | — | — |
| 31.2 — descargas em datas diferentes | Descarga por contêiner | `descarga` por contêiner | Sim | — | — | — |
| 31.3 — Free Time zero ≠ ausente | `0 dias` exibido; ausente = "Free Time ausente" | `freeTime.dias` (0 ≠ `null`) | Sim | — | — | — |
| 31.4 — Free Time ausente: fontes, última tentativa, cálculos bloqueados | Relógio pendente + fallback manual | `pendencias`, `freeTime.fallbackManual` | Parcial | Fontes consultadas, última tentativa | Campos | — |
| 31.5–31.7 — Empty Return inválido ou retroativo | Timeline + recálculo (motor) | timeline, `cache` | Parcial | Aviso específico | — | — |
| 31.8 — tabela incompleta | Selos | `valor.situacao` | Sim | — | — | — |
| 31.9 — tipo não reconhecido | Pendência `demurrage:tipo_nao_reconhecido` | `pendenciasAbertas.porTipo` | Sim (contagem) | Valor original | Campo | DV-09 |
| 31.11 — divergência HeadCargo | — | — | — | Sim | HeadCargo | DV-07 |
| 31.12 — reabertura com valores preservados | Aba "Fechamento e reaberturas" | `fechamento`, `reaberturas` | Parcial | Valores anteriores | Campo | — |
| 32 — Portal do Cliente | **Fora da D13** | — | Não tocado | — | Portal | — |
| 32.2 — o que nunca aparece ao cliente | Tela interna; `CLIENT` recebe 403 da API; Portal não alterado | RBAC D12 | Sim | Menu visível a todos | — | U-08 |

## 12. Divergências Blueprint × contrato D12 (aguardam decisão)

Nenhuma foi resolvida no plano. Para cada uma: referência, impacto e
recomendação.

**DV-01 — Valores consolidados do processo.** Caps. 25, 28.3 e 11 pedem total
do cliente e exposição total da Rocket por processo (soma por moeda),
indicando quando o total mistura estimados, confirmados e indisponíveis. A
fila da D12 entrega só o envelope do **contêiner-líder**.
*Impacto:* um processo com 3 contêineres em demurrage mostra no cartão só o
valor de um; o analista pode subestimar o custo.
*Recomendação:* na D13, rotular explicitamente "Contêiner líder" no cartão e
mostrar os valores por contêiner no detalhe, **sem somar no navegador**. Os
totais por moeda entram por extensão aditiva do contrato de leitura (D12.x)
ou na D14, por sua decisão.

**DV-02 — Diferença potencial interna.** Caps. 5, 11, 24.3, 25, 29.3 e 30.2
pedem a diferença como indicador interno. O escopo da D13 proíbe exibi-la.
*Impacto:* nenhum na operação diária.
*Recomendação:* seguir o escopo (omitir) e manter para a D14 (Gestão).

**DV-03 — Contêiner que gerou a prioridade.** Cap. 28.3 ("o processo assume a
prioridade do contêiner com a situação mais urgente") e o objetivo 3 desta
fase. Nem a fila nem o detalhe trazem o contêiner-líder; o texto do motivo
não traz o número do contêiner.
*Impacto:* com vários contêineres, o analista não sabe qual abrir.
*Recomendação:* acrescentar ao contrato, de forma aditiva, o identificador
do contêiner-líder (o dado já existe na consolidação da fila). Exige reabrir
a D12 congelada, então depende da sua decisão. Na D13 sem esse campo, a tela
**não** tenta adivinhar (ordenar contêineres por dias no navegador seria
copiar a regra do Cap. 22.7).

**DV-04 — Estado e prioridade inconsistentes entre endpoints.** Caps. 21.10 e 22.
A fila (D12 v1.1) deriva estado e prioridade com o hoje operacional. O
detalhe do processo e do contêiner e as contagens de `/filtros` leem as
colunas persistidas, e o detalhe do processo devolve `promocaoTopo: false`
fixo.
*Impacto:* abrir um processo pode mostrar outro estado ou prioridade que o
cartão; o resumo por contagens pode não bater com a fila.
*Recomendação:* corretiva pequena na D12 (reusar a mesma derivação no
detalhe e nas contagens), sob sua autorização. Até lá, a D13 mostra no
detalhe "Estado registrado no último processamento" e calcula o resumo pela
própria fila (DV-06).

**DV-05 — Próximo vencimento e dias restantes.** Caps. 21.2, 28.2 e 28.4. O
contrato não traz "próximo vencimento" nem "dias restantes". Além disso, o
estado `PRAZO_PROXIMO` depende do limiar `DEMURRAGE_PRAZO_PROXIMO_DIAS`, que
não está definido: o estado **nunca é emitido** hoje.
*Impacto:* o card não mostra quanto falta para vencer; "Prazo próximo" não
aparece.
*Recomendação:* não calcular datas no navegador (regra do Cap. 6). Exibir os
últimos dias livres no detalhe e pedir o campo no contrato. Definir o limiar
é decisão de negócio, fora da D13.

**DV-06 — Resumo superior.** Cap. 28.1. As contagens de `/filtros` vêm das
colunas persistidas (DV-04); a exposição estimada e confirmada total não
existe.
*Recomendação:* o resumo usa o campo `total` da própria fila com o filtro de
prioridade de cada cartão (cada chamada tem custo constante: 13 consultas,
cerca de 150 ms para 2.000 processos). Somas de exposição ficam para a D14.

**DV-07 — Estado financeiro (HeadCargo).** Caps. 20.3, 27, 28.1, 28.6, 28.7,
29.1, 29.3 e 31.11. Sem integração.
*Recomendação:* exibir "Status financeiro não disponível", texto previsto no
próprio Cap. 27.3, ou omitir o campo (U-09).

**DV-08 — Situação do tracking.** Caps. 16, 16.7, 17, 18 e 29.1: próxima
consulta programada, atualização em andamento, suspensão após 30 dias,
incidente agrupado por armador. O contrato só traz a última consulta válida,
a falha ativa e as falhas por tipo.
*Recomendação:* mostrar o que existe e registrar os campos para fase futura.

**DV-09 — Tipo de contêiner.** Caps. 9, 29.2 e 31.9. O detalhe não traz tipo
original nem normalizado.
*Recomendação:* campo aditivo no contrato (fase futura).

**DV-10 — Memória de cálculo e modelo comercial.** Caps. 7, 8, 24.1, 24.2,
24.4 e 29.3. O contrato traz tabela, versão, fonte, qualidade e vigência, mas
não as faixas aplicadas, dias por faixa, tarifa nem o modelo do termo.
*Recomendação:* exibir o que existe; memória completa em fase futura.

**DV-11 — Estimativa anterior preservada.** Cap. 24.3. Quando a exposição
passa a confirmada, a estimativa anterior não é exposta.
*Recomendação:* fase futura.

**DV-12 — Eventos da linha do tempo.** Cap. 29.4: vencimentos, início da
demurrage, liberação, solicitações de correção, cobrança e pagamentos não
são eventos da timeline da D12.
*Recomendação:* **não sintetizar eventos no navegador**; os vencimentos
aparecem nos relógios do detalhe.

**DV-13 — Pré-análise e registro da responsabilidade.** Caps. 26.1, 26.2
e 26.4 pedem a sugestão "Possível responsabilidade Rocket", o intervalo
sugerido e as datas "apta para liberação" e "liberação efetiva". A decisão
da D11 guarda dias, valores, base, autor, data, justificativa e evidência,
mas não essas datas nem a sugestão: a integração com a Liberação não
existe (a porta da D11 está pronta, sem fonte).
*Impacto:* o Gestor vê a decisão, mas não a evidência temporal que a
originou.
*Recomendação:* exibir só o que a D11 registra; o restante depende da
integração com a Liberação (fase futura).

**DV-14 — Filtros.** Cap. 28.7 pede filtros que a D12 não oferece: estado
financeiro, vencimento, tracking atualizado/desatualizado (só existe por
estado), exposição estimada/confirmada, minuta pendente.
*Recomendação:* oferecer os 15 da D12; os demais em fase futura.

**DV-15 — Ações.** Caps. 17.1, 28.6, 29.5, 29.6 e 29.7. Fora do escopo desta
D13 por instrução.
*Recomendação:* fase própria de ações (o mapeamento para os serviços
existentes está na seção 9 do diagnóstico da D12).

**DV-16 — Destaque de divergência de valor.** Cap. 22.2. O badge
`divergenciaValor` existe, mas o motor nunca o emite (premissa registrada na
Fase 7).
*Recomendação:* rótulo pronto na D13; produção do badge em fase futura.

**DV-17 — Busca de silenciosos.** Cap. 22.6 ("disponíveis por pesquisa e
filtros"). Na D12, a busca respeita `incluirSilenciosos=false`: um processo
silencioso não aparece na busca com a opção desligada.
*Recomendação:* ao digitar uma busca, a tela liga "Incluir silenciosos"
automaticamente, de forma **visível** (a caixa aparece marcada e com aviso).
É escolha de parâmetro, não regra nova (U-06).

**DV-18 — Rótulo da devolução.** O Cap. 19 usa "Devolvido — aguardando
comprovação"; o Cap. 21.8 usa "Devolvido — aguardando tratamento". A D12 usa
o do 21.8.
*Recomendação:* manter o do 21.8 (estado operacional); a minuta pendente
aparece separada pelo `documentaryStatus`.

**DV-19 — "Apurado até" na fila.** Caps. 11, 12 e 23 pedem informar até que
data o valor foi apurado. O detalhe traz `dataFinalApuracao`; a fila não.
*Recomendação:* exibir no detalhe; campo da fila em fase futura.

## 13. Decisões de UX que precisam de validação

| # | Decisão | Recomendação |
|---|---|---|
| U-01 | Posição no menu | Novo item "Demurrage Operacional", mantendo a V1 |
| U-02 | Fila em tabela ou cartões | Tabela densa no desktop (uma linha por processo, 2 linhas de altura); cartões abaixo de cerca de 1.100 px |
| U-03 | Valores no cartão sendo do líder (DV-01) | Rótulo explícito "Contêiner líder" até existir total do processo |
| U-04 | "Próxima ação" | Usar o motivo do motor + destaque da escalada; sem texto inventado |
| U-05 | Resumo superior | Usar `total` da fila por balde (DV-06), carregado depois da fila |
| U-06 | Busca liga "Incluir silenciosos" (DV-17) | Sim, com aviso visível |
| U-07 | Link profundo para processo | Via `PrioraBus.focus`, sem mudar o hash do shell |
| U-08 | Menu visível para `CLIENT` | Aceitar o 403 com tela clara (o frontend não sabe o papel) |
| U-09 | "Status financeiro não disponível" | Exibir no detalhe do processo, uma vez |
| U-10 | Persistência dos filtros | `sessionStorage` (por aba), sem mexer na URL |
| U-11 | Teste de navegador | Ver G6/G7: copiar React/ReactDOM/Babel como dependências de teste e servi-los ao Playwright por interceptação, sem alterar `support.js` |
| U-12 | Estado/prioridade no detalhe até a correção da DV-04 | Rótulo "registrado no último processamento" |

Decisões de contrato (reabrem a D12 congelada; só com sua autorização):
DV-01, DV-03, DV-04 (corretiva) e DV-05. As demais são lacunas de fase futura.

## 14. Gates

### G1 — Navegação e autorização

- **Arquivos:** `Priora.dc.html`, `Sidebar.dc.html`, `DemurrageOperacional.dc.html` (casca), `demurrage-v2-apresentacao.js` (tabela de erros).
- **Comportamento verificável:** item novo no menu; `#demurrageop` abre o módulo; as outras abas continuam iguais; 401, 403 e `organizacao_ambigua` mostram as telas da seção 5; nenhuma requisição envia `organizationId`.
- **Testes:**
  - unitário da tabela status/código → texto (inclui `500` com `error` contendo stack: o texto exibido é o genérico);
  - E2E (U-11) com usuários ANALYST, MANAGER, ADMIN, CLIENT e com dois memberships.
- **Critério de aprovação:** os 3 papéis internos entram; CLIENT vê a tela de acesso restrito; diff vazio nos módulos proibidos.
- **Risco de regressão:** médio — as duas alterações do shell e da sidebar afetam a navegação de todos os módulos. Mitigação: alteração só aditiva e teste de que todas as chaves antigas continuam abrindo.

### G2 — Fila e ordem oficial

- **Arquivos:** módulo + JS de apresentação.
- **Comportamento verificável:** a ordem exibida é idêntica a `itens[].processo.id` da API, inclusive após "Carregar mais"; envelopes com os rótulos da seção 9; `null` nunca vira zero; moedas nunca somadas.
- **Testes:**
  - unitário: rótulo de cada `situacao`, formatação sem soma, `NAO_DERIVADO`;
  - teste estático: o JS de apresentação não contém `sort(`, `reduce(` sobre valores, nem aritmética de datas;
  - E2E: a sequência de IDs no DOM é igual à resposta da API.
- **Critério de aprovação:** 100% dos campos do item renderizados conforme a seção 9; nenhum valor calculado.
- **Risco de regressão:** baixo.

### G3 — Filtros e paginação

- **Arquivos:** módulo + JS de apresentação (query string, máquina de paginação).
- **Comportamento verificável:**
  - cada um dos 15 filtros gera exatamente o parâmetro da D12;
  - o período mostra "Descarga" ou "Devolução" de forma explícita;
  - "Carregar mais" usa o cursor;
  - mudar qualquer filtro descarta o cursor;
  - `409 ordem_alterada` e `400 cursor_invalido` reiniciam com aviso;
  - respostas atrasadas são descartadas.
- **Testes:**
  - unitário da montagem da query (todas as combinações dos booleanos, período nos dois campos);
  - unitário da máquina de paginação (sucesso, 409, 400, filtro trocado no meio);
  - E2E com 120 processos: a soma das páginas é igual à lista completa, sem duplicar nem omitir.
- **Critério de aprovação:** matriz de filtros verde; paginação percorrida igual à lista completa.
- **Risco de regressão:** baixo.

### G4 — Detalhes e separação dos relógios

- **Arquivos:** módulo + JS de apresentação.
- **Comportamento verificável:**
  - dois blocos distintos, com títulos "Relógio do cliente" e "Relógio da Rocket";
  - nenhum elemento combina os dois;
  - relógio pendente com motivo e o outro relógio intacto;
  - responsabilidade só dentro do bloco "Informação interna" e nunca na fila;
  - 404 com o texto neutro.
- **Testes:**
  - E2E com cenários reais da engine: House ≠ Master, estimado, indisponível, relógio pendente, responsabilidade invalidada;
  - verificação de que nenhum texto do bloco interno aparece na fila.
- **Critério de aprovação:** todos os campos do detalhe da D12 visíveis e rotulados; separação comprovada.
- **Risco de regressão:** baixo.

### G5 — Timeline

- **Arquivos:** módulo.
- **Comportamento verificável:**
  - mostra só os campos seguros;
  - data operacional e data de registro em colunas separadas;
  - "Humano"/"Automático" visível;
  - contêiner relacionado (ou "Embarque" no escopo compartilhado);
  - paginação pelo cursor;
  - timeline vazia com texto próprio.
- **Testes:**
  - E2E: ordem igual à da API em páginas de 1 e de 50;
  - o DOM não contém nenhum campo além dos listados;
  - cursor inválido reinicia.
- **Critério de aprovação:** ordem idêntica à da API; nada interpretado.
- **Risco de regressão:** baixo.

### G6 — Estados de erro e acessibilidade

- **Arquivos:** módulo.
- **Comportamento verificável:**
  - todos os estados da seção 10;
  - navegação por teclado (Tab, Enter abre o processo, Esc volta);
  - `aria-live` para avisos;
  - prioridade e situação de valor sempre em texto, não só cor;
  - contraste AA nos selos;
  - layout sem rolagem horizontal da página em 1.024 px.
- **Testes:**
  - E2E simulando cada status HTTP por interceptação;
  - verificação automática de acessibilidade (axe, se a U-11 aprovar as dependências de teste) e checagem manual de teclado.
- **Critério de aprovação:** todos os estados cobertos; zero violação de nível crítico.
- **Risco de regressão:** baixo.

### G7 — Regressão e desempenho

- **Arquivos:** nenhum novo.
- **Comportamento verificável:**
  - suíte da engine, V1, `tsc` e build verdes;
  - diff vazio em D10/D11/D12, rotas V1, Auditoria, Courier, tracking, Portal, `Demurrage.dc.html`, `Exigem Atencao.dc.html`, `Relatorios.dc.html`, `support.js` e `src/index.ts`;
  - a tela só faz `GET` em `/api/demurrage/v2/*`;
  - primeira página da fila (50 itens) visível em menos de 1 s com 2.000 processos no banco de teste, medido apenas como observação;
  - nenhuma requisição repetida em laço.
- **Testes:**
  - E2E registra todas as requisições: só `GET` em `/api/demurrage/v2`;
  - fingerprint do banco antes e depois de navegar por toda a tela.
- **Critério de aprovação:** regressão verde, zero escrita, nenhum arquivo proibido alterado.
- **Risco de regressão:** médio, pelo shell e pela sidebar (ver G1).

## 15. Testes de aceitação planejados

| Aceitação | Gate |
|---|---|
| Fila exibida exatamente na ordem da API | G2 |
| Estimado nunca aparece como confirmado; indisponível nunca vira zero | G2/G4 |
| Moedas nunca somadas | G2 |
| Dois relógios em blocos separados, sem status geral | G4 |
| Responsabilidade só no bloco interno | G4 |
| Período deixa claro descarga × devolução | G3 |
| Paginação sem duplicar nem omitir; 409 reinicia com aviso | G3 |
| Timeline com datas separadas e origem visível | G5 |
| 401/403/409/404/5xx com textos fixos, sem texto do servidor | G1/G6 |
| CLIENT bloqueado | G1 |
| Nenhum POST; nenhuma escrita no banco | G7 |
| Módulos e fases congeladas sem alteração | G7 |

## 16. Fora do escopo

Ações operacionais, Portal do Cliente, Supabase, Liberação, HeadCargo,
indicadores de Gestão (Cap. 30, D14), qualquer alteração de D10/D11/D12 sem
sua autorização expressa, migrations e D14.

Aguardo a validação das decisões U-01 a U-12 e das divergências DV-01, DV-03,
DV-04 e DV-05 antes de implementar.
