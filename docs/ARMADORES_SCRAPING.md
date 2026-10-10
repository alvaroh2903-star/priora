# Cobertura de scraping por armador (mapa vivo)

Este documento é a **seção de referência** de como cada armador desenha a página
de rastreio e o **estado do parser** de cada um. É preenchido conforme capturamos
o DOM real de cada portal (com um número **real** de rastreio) — a regra da casa
vale aqui também: **nunca inventar** estrutura; um portal ainda não inspecionado
fica marcado como *a capturar*.

> O sandbox de build **não alcança** os portais. Para documentar/afinar um
> armador precisamos de uma **referência real** (BL ou contêiner que exista no
> sistema dele) e rodar o Scraping Browser contra ele (ver "Receita" no fim).

---

## 1. O pipeline (a visão)

```
e-mail (Microsoft Graph)
   └─ Clara (IA) extrai o número de rastreio (BL/booking/contêiner)
        └─ detect(ref)  → identifica o ARMADOR + monta a URL de rastreio
             └─ scrapeCarrier → Scraping Browser (Bright Data) abre o portal
                  (fura Cloudflare, roda o JS, aceita cookies, preenche o form)
                   └─ parser do armador → eventos normalizados
                        └─ deriveContainers → datas (descarga/retirada/devolução)
                             └─ módulo Demurrage (free time/diária vêm do e-mail)
```

O objetivo final: **a IA puxa o número do e-mail, descobre o armador, raspa e
devolve as datas — automaticamente**.

---

## 2. O que é COMPARTILHADO × o que é POR ARMADOR

Escrevemos **uma vez** (serve para todos) — nada disto se repete por armador:

| Peça | Arquivo | Papel |
|------|---------|-------|
| Registro + detecção | `carriers/registry.ts`, `carriers/detect.ts` | ref → armador + URL |
| Acesso (navegador remoto) | `browser/scrapingBrowser.ts` | Cloudflare/JS/cookies/form |
| Utilitários de página | `carriers/pageUtils.ts` | cookies, preencher busca, login/captcha |
| Anti-captcha | `browser/antiCaptcha.ts` | resolve captcha se aparecer |
| Normalização de evento | `carriers/eventTypes.ts` (`classifyEvent`) | "Discharged" → `discharge` |
| Datas de demurrage | `carriers/scrapers/hapag.ts` (`deriveContainers`) | eventos → datas |
| Parser de datas | `parseDateToISO` | qualquer formato → ISO |

### Regras que valem para TODOS (aprendidas ao vivo)

- **Previsão não é fato** (`carriers/estimates.ts`): evento com data depois de
  hoje+1 dia (margem de fuso) é estimativa e sai — na extração, na saída do
  `trackShipment` (scraping, IA e API), no `deriveContainers`, no histórico salvo e
  no TTL. Origem: a ONE mostrava descarga, retirada **e devolução** previstas para
  29/10 como se tivessem acontecido; o contêiner virava "resolvido" e era congelado.
  Previsão **vencida** que o portal não atualizou a data não é pega pela data —
  cada parser descarta pela marca do próprio portal: ONE = ícone "E" (Estimate),
  PIL = asterisco (`* 03-Oct-2026`). A IA (Clara) tem a mesma ordem no prompt.
- **Despachante (`scrapers/dispatch.ts`) reconhece o portal pelo DOM/domínio, nunca
  pelo nome do armador**: nome de armador aparece em página de outro (navio "OOCL …"
  na lista da PIL, "CMA CGM …" em BL da Evergreen). A palavra `/oocl/` fazia o parser
  da OOCL ler a página da PIL. Ordem: marcas exclusivas primeiro; CMA por último.
- **"T/S" = transbordo** (`classifyEvent`), igual a "transshipment".

**Por armador** só existe **um "tradutor" do DOM** (`extractXxxEvents`, ~30 linhas)
+ **uma linha** no mapa `SCRAPERS` (`carriers/scraper.ts`). Sem tradutor, o portal
cai no `genericScrape` (lê tabela simples; se não reconhece, devolve honestamente
"scraper específico a implementar" — nunca inventa).

---

## 3. Tabela dos 12 armadores

Legenda **Parser**: ✅ feito · 🟡 genérico pode pegar (tabela simples) · ⬜ a capturar (precisa de nº real)
Legenda **Anti-bot**: 🔴 Cloudflare interativo · 🟠 aceite/anti-bot leve · 🟢 sem bloqueio conhecido · ❔ a confirmar

| id | Armador | SCAC | Portal | Deep link | Anti-bot | Parser |
|----|---------|------|--------|-----------|----------|--------|
| `hapag` | Hapag-Lloyd | HLCU, HLXU, UACU | SPA "Tracking BETA" (Vue/Quasar) | `?booking=`/`?container=` | 🔴 | ✅ (10/10: Online Business em manutenção programada até 21:30 UTC — o bot agora reconhece o aviso; retestar) |
| `maersk` | Maersk | MAEU, MSKU, MRKU | SPA (layout novo "ocean-design"; motor volta ao antigo) | `/tracking/{ref}` | 🟠 cookies + botões duplicados | ✅ histórico completo pelo layout antigo (validado 10/10, 274142590) |
| `one` | Ocean Network Express | ONEY | SPA (site novo www.one-line.com: resumo 1 linha/contêiner) | `?trakNoParam=<sem ONEY>&trakNoTpCdParam=B` | 🟢 | ✅ resumo + histórico por clique no contêiner (coletor `one`; validado 10/10, NB6IAM548300: 2 contêineres, 8 eventos cada, previsões "E" fora) |
| `msc` | MSC | MSCU, MEDU | SPA Alpine.js (driver) — dado lido do **estado Alpine** (`results`); reserva: DOM por `x-text` | 🟢 | ✅ (validado 10/10, MEDUY6394819: descarga 16/09, retirada 24/09, devolução 29/09, sem IA) |
| `cmacgm` | CMA CGM | CMDU, CMAU, APLU | SPA | a confirmar | ❔ | ⬜ |
| `cosco` | COSCO | COSU | SPA SCCT (iframe Ant/Vue) | `scct/public/ct/base?trackingType=BILLOFLADING&number=` | 🟢 | ✅ só o evento atual por contêiner (não publica histórico, nem por contêiner) — compensado por cadência de 12h após a atracação |
| `hmm` | HMM (Hyundai) | HDMU, HMMU, SGNM… | Formulário (srchBlNo1 + Retrieve) | form-based | 🟢 | ✅ (validado ao vivo; transbordo T/S ignorado) |
| `yangming` | Yang Ming | YMLU, YMJA | Next.js (form genérico já busca) | 🟢 | ✅ histórico completo via página de detalhe por contêiner (clique; validado 10/10, FFAU6989181) |
| `evergreen` | Evergreen (ShipmentLink) | EGLV, EVGL, EMCU | Servlet (driver dedicado: radio B/L + input#NO + Submit) | 🟠 | ✅ histórico completo via popup "Container Move Detail" por contêiner (validado 10/10, EGSU8138081) |
| `zim` | ZIM | ZIMU | SPA React (form `.chips-input`) | 🔴 Akamai | 🟡 acesso INTERMITENTE (1 sucesso, 3 desafios Akamai); parser DIV a escrever |
| `pil` | Pacific Int. Lines | PABV, NNPL, PILU | Página + form | `?...&refNo=` | 🟢 | ✅ (histórico completo via Trace, validado ao vivo; data com `*` = previsão, descartada) |
| `oocl` | OOCL | OOLU | ASPX com formulário | a confirmar | 🟠 | ⬜ |

> Detecção (ref → armador) e a URL de rastreio **já funcionam para os 12**. O que
> falta nos ⬜ é só o tradutor do DOM — capturado quando tivermos um nº real.

## 3.1 Validados + modo de operação (resumo executivo)

**✅ Raspando ponta a ponta na PRODUÇÃO (validado ao vivo) — 9:**
Hapag · Maersk · ONE · COSCO · PIL · HMM · Evergreen · MSC · Yang Ming

**⚠️ Acesso INTERMITENTE (Akamai Bot Manager) — `scrapeBlocked` até retestar — 1:**
- **ZIM:** a 1ª rodada trouxe o histórico completo; as 3 seguintes caíram no desafio
  do Akamai com IPs diferentes e com os dois modos de interceptação. Não é IP sujo
  nem efeito da correção de render — é o Akamai endurecendo (provável reputação após
  repetições no mesmo BL). Retestar com a reputação esfriada, poucas vezes.

**🔓 Acesso VENCIDO com Scrapfly pago (residential + Unblock), produção a liberar — 2:**
- **CMA (DataDome):** o DataDome **não apareceu** — portal renderizou inteiro (1 MB,
  "CMA CGM | Shipment Tracking"). Driver do form escrito (`drivers.ts:cma`:
  `#Reference` + `#btnTracking`). Falta uma rodada limpa p/ tirar o `scrapeBlocked`.
- **OOCL (Cloudflare Turnstile):** **furado** com `target_url` + `solve_captcha`
  (title virou "OOCL - Control Tower", 208 KB do app Vue). Falta validar a correção
  de não-renavegar (o `page.goto()` extra invalidava a sessão → `/moc/error`).

> **A descoberta que destravou os dois** (lendo a fonte do `scrapfly-sdk`): `unblock=true`
> sozinho é **no-op**. O bypass ASP é uma navegação que o PRÓPRIO Scrapfly faz no setup
> da sessão, e ele só sabe o destino via **`target_url`**. E existe **`solve_captcha=true`**
> (solver nativo: GeeTest, PerimeterX, *puzzle*/slider). Ver `withUnblockMode`.
> Corolário: com Unblock, a aba chega JÁ navegada — um `page.goto()` nosso em cima
> disso queima o estado (ver `alreadyOnTarget`).

### Como operar cada um (o caminho mais barato/estável)
| Armador | Acesso | Driver | Fonte dos dados |
|---|---|---|---|
| Hapag | deep link (booking/container) | scraper próprio (`scrapeHapag`) | HTML `.hal-event` |
| Maersk | deep link `/tracking/{ref}` | genérico | HTML `transport-plan` |
| ONE | deep link `trakNoParam` (sem ONEY) | genérico + coletor `one` (clica cada contêiner) | resumo `tnt-cargo-tracking-table-row` + HTML `EventTable` |
| COSCO | deep link `scct/public/ct/base` (iframe) | genérico | HTML (iframe) |
| PIL | deep link `refNo` | genérico + clique "Trace" | HTML (histórico completo) |
| HMM | form (`srchBlNo1` + Retrieve) | genérico | HTML `#shipmentProgress` |
| Evergreen | form dedicado (radio B/L + `#NO` + Submit) | `drivers.ts:shipmentlink` | HTML (tabela contêineres) |
| MSC | form Alpine (ícone busca) | `drivers.ts:msc` | **JSON da API** — da rede ou, se não vier, do estado Alpine; reserva: DOM `x-text` |
| Yang Ming | form (genérico já submete) | genérico | HTML `Container Status` |
| CMA / OOCL | — | — | **API oficial** (scraping bloqueado) |
| ZIM | — | `drivers.ts:zim` (parado) | — |

> **Regra geral de custo:** deep link (1 navegação, resultado auto-carregado) é mais
> barato que form (navegação + interação). Onde há deep link confirmado, ele é usado.

### Como o Cloud Browser do Scrapfly cobra (confirmado na doc oficial)
Fonte: [Cloud Browser Billing](https://scrapfly.io/docs/cloud-browser-api/billing).
**NÃO** é "+25 por chamada" (isso é o Scrape API, outro produto). O Cloud Browser
(o que usamos via CDP) cobra por:
- **Tempo de sessão** — blocos de **30s**, arredondado pra cima; **mínimo 5 créditos**
  por sessão.
- **Banda** — por **MB** trafegado (varia por plano).
- **Captcha** — valor fixo por solve, **somado** ao tempo/banda.

Logo, gastar menos = **menos sessões**, **sessões mais curtas** e **menos banda**.

### Eficiência de crédito (o que já está no código)
1. **TTL ADAPTATIVO ao estado do BL** (`scrapeIntervalMs`): o intervalo até a
   próxima raspagem depende de onde o BL está — a economia mais inteligente:
   - **Em trânsito** (sem descarga no destino): navio ainda navegando, nada muda →
     fica em ESPERA por dias (`BOT_TRANSIT_TTL_HOURS`, 72h). Pegar a descarga alguns
     dias depois NÃO altera as datas (o portal dá a data real quando raspamos).
   - **Ativo** (já descarregou, janela de demurrage correndo): re-raspa a cada 12h
     (`BOT_RESULT_TTL_HOURS`) p/ pegar retirada/devolução.
   - **Resolvido** (todos devolvidos, `isResolved`): **nunca mais raspa** (cache
     eterno). Maior corte numa carteira com muitos embarques fechados.
3. **`scrapeBlocked`** (CMA/OOCL/ZIM): a produção **nem abre sessão** — "use API".
   **Zero crédito** em falha garantida.
4. **Bloqueio de recursos pesados** (`blockHeavyResources`): aborta **imagens/mídia/
   fontes** no navegador — corta **banda** E encurta a sessão (menos blocos de 30s).
   CSS/JS/XHR seguem (a SPA e a captura de JSON dependem deles). **Menos banda + menos tempo.**
5. **`waitForResults`** (espera por conteúdo): a sessão encerra assim que o dado
   aparece, não em tempo fixo. **Sessões mais curtas.**
6. **Retry só em falha transitória** (1 retry, sessão nova): não gasta sessão extra
   quando a 1ª já deu certo (o comum nos 9).
7. **Acúmulo no store** (merge de eventos): reconstrói o histórico entre raspagens —
   dispensa re-raspar páginas de detalhe (que gastariam sessão e batem em anti-bot).
8. **Concorrência** (`BOT_CONCURRENCY`, 2) + **teto de lote** (`BOT_MAX_BATCH`, 10).

**Evergreen (ShipmentLink) — notas do driver dedicado (`driveShipmentLinkForm`):**
- **Form "Quick Tracking":** radios `#s_bl/#s_cntr/#s_bk` (tipo) + `input#NO`
  (`maxlength=12`) + `<input type=button value=Submit onclick=frmSubmit(13,2)>`.
  O driver marca **B/L**, digita **só a parte numérica** (searchRef tira EGLV/EVGL)
  e clica Submit. **Resultado na MESMA página** (`popupOpened:false` confirmado).
- **Anti-bot 🟠:** camada de idioma (`#shipmentlink_lang_layer`, IP hispânico →
  força "No, use English") **e** modal de cookies (`#btn_cookie_accept_all`) que
  fica **por cima** e intercepta o clique no Submit — o driver dispensa os dois
  antes de mexer no form (era o bloqueio real: `cookieVisibleBefore:true`).
- **Parser (`extractEvergreenEvents`):** tabela "Container(s) information on B/L"
  → 1 linha por contêiner com `Current Status` + `Date` (MON-DD-YYYY) + `Size/Type`.
- **Exemplo validado:** `EGLV010600577145` → 6 contêineres `40'(SH)` (TGBU6521228,
  EGSU6077773, TRHU5638208, EITU1518240, EITU8195983, EGSU9579348), status
  "Loaded (FCL) on EVER LEADER 0044-080W at NINGBO" (2026-07-16). B/L **em trânsito**
  (ETA destino SEP-13-2026) → `dischargeDate/emptyReturn = null` (correto, não inventa).
- **Limitação a refinar:** a tabela mostra só o **Current Status** (último evento) por
  contêiner. Para uma B/L **já entregue**, o status "Empty Returned" sobrescreve a
  descarga → perde-se a `dischargeDate`. O histórico completo (descarga+retirada+
  devolução) vive no popup **`frmCntrMove`** (`TYPE=CntrMove`, `target=CntrMoveWin`),
  ainda **não plugado** — validar com uma B/L Evergreen entregue e, se preciso, abrir
  esse popup por contêiner.

**MSC — notas do driver + parser JSON (`driveMscForm` / `extractMscEvents`):**
- **Form (Alpine.js):** `input#trackingNumber` (x-model) + radios `trackingMode`
  (0=Container/B/L já `checked`) + botão de busca ÍCONE sem texto
  (`button.msc-search-autocomplete__search`, desabilitado até focar/ter texto). O
  driver foca, preenche, dispara `input` e clica o ícone (+ Enter de reforço).
- **Fonte dos dados = JSON, não DOM:** a página renderiza templates Alpine `x-for`
  vazios; a SPA busca um JSON estruturado por baixo. O driver **captura essa
  resposta da rede** (`page.on('response')`, filtro por chaves
  `ContainersInfo/BillOfLadingNumber/GeneralTrackingInfo`) e o parser lê o JSON —
  robusto, sem seletores. Anti-bot 🟢 (o portal carregou sem Cloudflare/DataDome).
- **Forma do JSON:** `Data.BillOfLadings[].ContainersInfo[]` → `ContainerNumber`,
  `ContainerType`, `PodEtaDate`, `Delivered`, `Events[]` (`Date` DD/MM/YYYY,
  `Location`, `Description`, `Detail:[navio,viagem]`, `Vessel`, `EquipmentHandling`).
- **Transbordo:** "Full Transshipment Discharged/Loaded" (ex.: Pecem) → `other` pela
  guarda T/S do `classifyEvent` → NÃO vira `dischargeDate`. A descarga no DESTINO
  ("Import Discharged from Vessel" em Manaus) é que conta.
- **Exemplo validado:** `MEDUY8275040` (Qingdao → Manaus, T/S Pecem) → contêiner
  MSMU7811290 `40' HIGH CUBE`, 5 eventos, **em trânsito** (`Delivered:false`,
  POD ETA 12/09/2026) → descarga/retirada/devolução `null` (correto, não inventa).
- **Produção:** ligada — o `scrapeCarrier` (o que o "botão" chama) agora roda o
  MESMO motor do diagnóstico (`driveTrackingPage`), então driver + captura de JSON
  valem no produto. Validar via `/health/track?ref=<BL>`.
- **Pendente:** validar com uma B/L MSC **entregue** para confirmar os termos exatos
  de descarga/retirada/devolução no destino.

**Yang Ming — notas (`extractYangMingEvents`):**
- **Sem driver dedicado:** app Next.js, o preenchedor genérico já submete a busca.
  Anti-bot 🟢 (carregou sem Cloudflare/DataDome).
- **Parser da tabela "Container Status"** (grade react-aria, `<td>`): 1 linha por
  contêiner, colunas `Container No. | Size | Type | Seal | MoveType | Date/Time |
  Latest Event | Place | VGM`. Data `YYYY/MM/DD [HH:MM]` → ISO. Tipo = Size+Type
  (ex.: "40HQ"). SCAC detecta **YMJA** além de YMLU.
- **Exemplo validado:** `YMJAB237020139` (Shanghai → Rio de Janeiro) → contêiner
  BMOU6332262 `40HQ`, Latest Event "Empty Returned" 2026/08/25 em Rio Brasil
  Terminal (embarque já **entregue**).
- **Limitação a refinar (como Evergreen):** a tabela mostra só o **Latest Event** por
  contêiner. O histórico DCSA completo (descarga+retirada+devolução) fica na página
  de detalhe — link do nº do contêiner:
  `/en/esolution/tracking/cargo_tracking_detail?trackNo=<CNTR>&position=BL_CT&refNo=<BL sem prefixo YMJA>`
  — URL limpa/determinística, **a plugar** (navegar por contêiner e ler os eventos).

**ZIM — ACESSO INTERMITENTE (Akamai Bot Manager), `ZIMUTRT938698`:**
- **Histórico das rodadas ao vivo (10/10/2026):**

  | # | Interceptação | Idioma do desafio (≈ IP) | Resultado |
  |---|---|---|---|
  | 1 | total (`**/*`) | — | ✅ histórico completo (2,1 MB) |
  | 2 | só mídia | inglês | ❌ Akamai "I'm not a robot" |
  | 3 | só mídia | francês | ❌ Akamai |
  | 4 | total (`?block=all`) | inglês | ❌ Akamai |

  IP e modo de interceptação variaram, o bloqueio não. O `hcaptchaSolved:true` nas
  rodadas barradas mostra que o hCaptcha era resolvido (e pago) e o Akamai barrava
  depois. Por isso `scrapeBlocked` voltou: produção não abre sessão até um reteste
  limpo, feito com espaçamento (a hipótese é reputação por repetição).

**O que a rodada 1 provou (quando o acesso passa):**
- **O captcha NÃO gateia o rastreio.** A página serve `<meta name="tracing-captcha"
  content="0">`: o widget hCaptcha existe no DOM, mas a busca completa sem ele —
  o resultado veio com `hcaptchaSolved:false` e `mentionsRef:true`. Toda a análise
  antiga (abaixo) partia do pressuposto errado de que a busca era gated.
- **Fluxo que funciona:** driver `drivers.ts:zim` preenche `#shipment-main-search-2`
  (`.chips-input`) e clica `.chips-search-button`; a URL vira
  `?consnumber=<ref>` e o resultado renderiza (2,1 MB).
- **Exemplo validado:** B/L com 4 contêineres (`TEMU7287813;TCKU6162400;CAAU7777080;
  BSIU9240479`). Para `TCNU7625335` (HC40), em SANTOS (SP): descarga no destino
  **04-Sep-2026**, retirada (**Import Gate-Out ... to Customer**) **05-Sep-2026**,
  disponível **16-Sep-2026**, devolução (**Empty container gate in**) **18-Sep-2026**
  — ciclo de demurrage completo.
- **Parser:** layout em **DIV** (`rowCount:0`, sem `<table>`) → o genérico não pega.
  Hoje a **camada de IA** cobre (texto limpo e bem rotulado: `Date | Activity |
  Location | Vessel / Voyage`). Parser dedicado `extractZimEvents` a escrever —
  precisa de uma fatia do DOM em volta de um evento (`&find=Import Gate-Out`).
- **Termos p/ o `classifyEvent`:** "Container was discharged at Port of Destination"
  (destino) × "Container was discharged at Transshipment Port" (T/S, já coberto pela
  guarda); "Import Gate-Out from Port of Discharge to Customer"; "Empty container
  gate in"; "Container is available to be released / delivered".

**ZIM — recon ANTIGO (superado pelo acima, mantido como histórico):**
- **Anti-bot 🔴 = hCaptcha.** A página `zim.com/tools/track-a-shipment` carrega, mas a
  busca é gated por um **hCaptcha** (iframe `newassets.hcaptcha.com`, sitekey
  `40cd15d0-11fd-4fff-a866-17708fb25e7d`, botão "Verify Answers"). Sem resolver o
  captcha → nenhum resultado (`mentionsRef:false`).
- **Form (simples):** `input#shipment-main-search-2` (`.chips-input`) +
  `input[type=submit].chips-search-button`.
- **Tratabilidade (validado ao vivo):** o anti-captcha **resolve o hCaptcha** — teste
  com `ZIMUTRT938698` retornou `diag.hcaptchaSolved:true` (token obtido). PORÉM a
  busca não completa (`mentionsRef:false`): a ZIM é **React** com um componente
  **próprio** de captcha (`ZimCaptcha`), dois sitekeys (`site-key` +`less-site-key`)
  e XHR de tracing (`tracingHelper`/`crud`). Injetar o token no `textarea` do DOM
  **não registra** — o React só reage ao `onVerify` do widget, que o anti-captcha
  (proxyless) resolve POR FORA, sem disparar o callback na página.
- **O que faltaria (alto esforço):** engenharia reversa do `ZimCaptcha` (achar o
  callback React interno e chamá-lo com o token) OU capturar/replayar o XHR de
  tracing da ZIM com o token. Site-específico, incerto.
- **Prioridade:** BAIXA/PARADA — **volume ZERO** de ZIM na operação. A CAPACIDADE de
  hCaptcha (solver + injeção via callback) fica pronta e **reutilizável** p/ o próximo
  portal com hCaptcha/reCAPTCHA "padrão" (fora de React). ZIM específico: parado.

---

## 4. Detalhe por armador

### 4.1 Hapag-Lloyd — ✅ FEITO (referência validada ao vivo)

- **Portal:** `hapag-lloyd.com/.../track-by-booking-solution.html?booking={ref}`
  (SPA "Tracking BETA", framework Vue/Quasar).
- **Anti-bot:** Cloudflare **interativo** — o Web Unlocker (HTML) **não** basta
  (voltava só a casca "enable JavaScript"). Resolvido pelo **Scraping Browser**.
- **Resumo do contêiner:** tabela Quasar (`td.q-td`): Nº, Tara, Payload, Tipo
  (ex.: `45GP`), "Latest Event". O nº do contêiner sai daí (`firstContainerNo`).
- **Eventos (timeline):** `div.hal-event__inline` → 6× `span.hal-event__col` com
  `aria-labelledby="event-header-{campo}-{id}"`, onde `{campo}` ∈
  `event | locationName | date | time | transport | voyage`. Lido por
  `extractHapagEvents` (`carriers/scrapers/hapag.ts`).
- **Quirks importantes:**
  - "Gated out" e "Gated in" aparecem **duas vezes** — na **origem** (retirada do
    vazio / cheio no terminal de exportação) e no **destino** (retirada do cheio /
    devolução do vazio). `deriveContainers` usa o **evento mais recente** de cada
    tipo → pega naturalmente os do **destino**.
  - No destino, o **"Gated in" após o "Gated out"** = **devolução do vazio**
    (hoje classificado como `other`; regra de refino pendente — ver §6).
  - Datas vêm em **ISO** (`2026-08-03`); há transbordo (2 pernas de navio).
- **Datas derivadas:** `dischargeDate` (descarga no destino), `gateOut` (retirada
  no destino). `lastFreeDay` = `null` (vem do **e-mail**, não do portal).
- **Exemplo validado:** booking `HLCUSHA2606GIPM7` → contêiner `FSCU7219242`
  (SHANGHAI → SINGAPORE (transbordo) → NAVEGANTES/SC): descarga `2026-08-03`,
  retirada `2026-08-05`, devolução `2026-08-06`. 13 eventos extraídos.

### 4.2 Maersk / ONE / MSC / CMA CGM / COSCO / HMM / Yang Ming / Evergreen / ZIM / PIL / OOCL — ⬜ a capturar

Para cada um, quando houver um nº real, preencher aqui: **framework** (SPA/form),
**seletor/estrutura dos eventos**, **quirks** (transbordo, origem×destino,
idioma/formato de data), **exemplo validado**. Enquanto não capturado, o portal
usa o `genericScrape` (tabela simples) e reporta honestamente se não reconhecer.

---

## 5. Receita para plugar um armador novo

1. **Acesso (já funciona):** rodar o Scraping Browser no portal —
   `GET /health/scrape-sb?token=<DIAG_TOKEN>&ref=<nº real>` (auto-detecta o armador).
2. **Ver o DOM real:** `...&find=<nº do contêiner ou "Discharge">&htmlwin=8000`
   devolve uma fatia limpa do HTML em volta do dado.
3. **Escrever o tradutor:** `extractXxxEvents(html)` em `carriers/scrapers/xxx.ts`
   (mapear o DOM → `TrackingEvent[]`, reusando `parseDateToISO`/`classifyEvent`).
4. **Registrar:** uma linha em `SCRAPERS` (`carriers/scraper.ts`): `xxx: scrapeXxx`.
5. **Self-test offline:** fixture com `setContent` (como `hapagSelftest.ts`).

O passo caro (acesso + normalização + derivação) **já está pronto**; cada armador
é só os passos 3–4.

---

## 6. Pendências conhecidas

- ✅ **Wire do Scraping Browser no pipeline de produção — FEITO.** `scrapeCarrier`
  escolhe o navegador por armador: `withRemotePage` (Scraping Browser via CDP)
  quando `needsScrapingBrowser !== false` e há `BRIGHTDATA_SB_AUTH`; senão
  `withPage` (Chromium local + IPRoyal). O corpo de cada scraper é o mesmo nos
  dois. Assim `/api/demurrage/bot/enrich` já fura Cloudflare (Hapag ponta a ponta).
- **Refino `emptyReturn` (Hapag):** "Gated in" no destino após o "Gated out" =
  devolução do vazio (preencher `emptyReturn`).
- **Início da contagem por cliente:** qual evento inicia o demurrage (descarga ×
  disponibilidade × retirada) é configurável por contrato — decidir com dados
  reais (já é TODO do projeto).
