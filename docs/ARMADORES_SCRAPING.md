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
| `hapag` | Hapag-Lloyd | HLCU, HLXU, UACU | SPA "Tracking BETA" (Vue/Quasar) | `?booking=`/`?container=` | 🔴 | ✅ |
| `maersk` | Maersk | MAEU, MSKU, MRKU | SPA | `/tracking/{ref}` | 🟢 | ✅ (validado ao vivo, 274319835) |
| `one` | Ocean Network Express | ONEY | SPA | `?trakNoParam=&trakNoTpCdParam=` | 🟢 | ✅ (validado ao vivo, ONEYTA6RA1675800) |
| `msc` | MSC | MSCU, MEDU | SPA + aceite | a confirmar | 🟠 | ⬜ |
| `cmacgm` | CMA CGM | CMDU, CMAU, APLU | SPA | a confirmar | ❔ | ⬜ |
| `cosco` | COSCO | COSU | SPA SCCT (iframe Ant/Vue) | `scct/public/ct/base?trackingType=BILLOFLADING&number=` | 🟢 | ✅ |
| `hmm` | HMM (Hyundai) | HDMU, HMMU, SGNM… | Formulário (srchBlNo1 + Retrieve) | form-based | 🟢 | ✅ (validado ao vivo; transbordo T/S ignorado) |
| `yangming` | Yang Ming | YMLU | Formulário na página | a confirmar | ❔ | ⬜ |
| `evergreen` | Evergreen (ShipmentLink) | EGLV, EVGL, EMCU | Servlet (driver dedicado: radio B/L + input#NO + Submit) | 🟠 | ✅ (validado ao vivo, EGLV010600577145 → 6 contêineres) |
| `zim` | ZIM | ZIMU | SPA | `?consnumber=` (contêiner) | ❔ | ⬜ |
| `pil` | Pacific Int. Lines | PABV, NNPL, PILU | Página + form | `?...&refNo=` | 🟢 | ✅ (histórico completo via Trace, validado ao vivo) |
| `oocl` | OOCL | OOLU | ASPX com formulário | a confirmar | 🟠 | ⬜ |

> Detecção (ref → armador) e a URL de rastreio **já funcionam para os 12**. O que
> falta nos ⬜ é só o tradutor do DOM — capturado quando tivermos um nº real.

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
