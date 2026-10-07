# Pionex — követő (trailing) ciklus: TP ár % és ciklustábla — 2026-10-06

**Állapot:** megvalósítva 2026-10-06 (F1 → F2A ‖ F2B → F3), tsc és a teljes tesztcsomag zöld, böngészős ellenőrzés kész; lásd a „Review” szakaszt. Nincs commit. A v1 review három hibáját (chart TP jelölés, újrafuttató gomb, nyitott ciklus kezdete) és két pontosítását ez a verzió rendezi, lásd a „Review v1 → v2” szakaszt.

## Cél

A `/pionex` backtesteren egy adott időszakon végigkövetni az árat: a bot egy `−X% / +5%` sávval (60 grid) indul, a ciklus zárásakor (TP) a profit beállított része visszaforog, a sáv az új ár körül ugyanezekkel az offsetekkel újraindul. A végén látszik, hány ciklus jött össze és mennyi volt a profit.

## Mi van már meg (nem változik)

- Ciklusszabály (`src/lib/pionex/interventions.ts`, plan §3.6): lezárt 5m gyertyán `netIfClosed ≥ TP% · I` → zárás a következő 1m nyitón, `settleCycle` (reinvest% az E‑be, a többi kivett), újraindítás ugyanazon a percen, a sáv az eredeti % offsetekkel az új árra központosítva (`lower = first.lower · ratio`).
- Sáv offset módban (`Lower % / Upper %`, 60 grid) a panelen; ciklusszám, kivett profit, végvagyon a kártyán; zöld ciklusvonal a charton. Ablak legfeljebb 365 nap.

## Döntések (grill‑interjú, 2026-10-06)

| # | Kérdés | Döntés |
|---|---|---|
| 1 | TP trigger | Profitalapú marad; új **opcionális TP ár %** mellé. Ha mindkettő be van állítva, amelyik előbb teljesül. |
| 2 | Lefelé követés | Nincs. Sáv alatt a bot tart (top‑up / bot 2 a meglévő szabályok szerint). |
| 3 | Reinvest célja | ~~E‑be, I és grid méret fix.~~ **Felülírva 2026-10-06:** a reinvest% · profit az **I‑be** megy (`I_next = I + reinvest·profit`), az új ciklus gridje `I_next`‑ből méreteződik (kamatos); E_next = E_start + feltöltések. Lásd `tasks/todo.md` „reinvest into I”. |
| 4 | Riport | Ciklusonkénti táblázat a kártya alá. Chart sávrajzolás később, külön. |
| 5 | Terv helye | Ez a fájl; `tasks/todo.md` csak hivatkozást kap. |
| 6 | TP ár referencia | A ciklus kezdőára = az (újra)indítás 1m nyitó ára. |
| 7 | TP ár kiértékelése | Lezárt 5m gyertya záróára `≥ kezdőár · (1 + x%)`, végrehajtás a következő 1m nyitón, a meglévő intervenciós sorrendben (zárás → top‑up → újraindítás → bot 2). Ellenőrizve: a motor 1m‑en fut, a szabályok a `closesFiveMinute` ponton, a `last.close` ott az 5m záróár. |
| 8 | TP ár negatív nettóval | Zár akkor is; a veszteség az E‑ből fogy (`settleCycle` változatlan). |
| 9 | UI mező | „Cycle (bot 1)” szekcióban egy szám mező, üresen = ki (mint a funding override). Nincs külön kapcsoló. |
| 10 | Ciklustábla forrása | Strukturált ciklusrekordok a futás összefoglalójában, a motor tölti. Régi mentett futásoknál felirat: „Re-run for cycle details” **és az újrafuttató gomb**. **Nincs `REPORT_VERSION` bump** (az minden mentett futást stale‑nek jelölne). |
| 11 | Tábla tartalma | Csak lezárt ciklusok + egy „open since …” sor, ha a bot 1 aktív. A/B választó a tábla fölött, mint az eseménylistánál. |
| 12 | Preset | Nincs. |

## Szerződések (a v1 review pontosításai)

- **A profit‑TP kötelező marad.** A Cycle szabály bekapcsolva továbbra is `takeProfitPct > 0`‑t követel; az ár‑TP kiegészítő, önmagában nem választható. (Az 1. döntés szó szerint: a profitalapú marad, az ár‑TP mellé kerül.) Ha később csak ár‑TP kell, az külön döntés: a `takeProfitPct` nullable‑lé tétele.
- **Mindkét TP egy 5m záron:** a profit feltétel értékelődik ki előbb; ha teljesül, a trigger `profit`, különben az ár feltétel, trigger `price`.
- **A `close` esemény `reason` értéke marad pontosan `take profit`** mindkét triggernél. A chart (`chartData.ts`, `markerOf`) pontos egyezéssel ad zöld TP jelölést, ezt nem bántjuk. A trigger a ciklusrekordban (`trigger`) és a `cycle` esemény `reason` szövegében jelenik meg (`cycle 3 (price): …`).
- **Mentett összefoglaló típusa:** az új motoreredményben `RunResult.cycleLog: CycleRecord[]` kötelező; a betöltött `RunSummary`‑ban opcionális: `RunSummary = Omit<RunResult, 'events' | 'samples' | 'cycleLog'> & { cycleLog?: CycleRecord[] }`. Hiányzó mező = „nincs részletes adat” (régi futás), üres tömb = „nincs lezárt ciklus”. A kettő nem mosható össze.
- **Nyitott ciklus kezdete** nem az ablak kezdete (a motor az első közös last/mark percen indul, ami lehet pár perccel később). A tábla a bot 0 utolsó `start` / `restart` eseményének `timeMs` és `price` értékét használja az adott út eseménylistájából; a sor csak akkor jelenik meg, ha `summary.bots[0].status === 'active'`. Elutasított újraindítás után a bot `stopped`, tehát nincs nyitott sor.
- **Újrafuttató gomb** a `page.tsx`‑ben: a mostani `run.stale` feltétel mellett akkor is látszik, ha `run.config.cycle` be van állítva és `run.report.paths.A.summary.cycleLog` hiányzik. `rerunRequest` változatlan.

## Teendők

### 1. Típusok — `src/lib/pionex/types.ts`
- [x] `CycleRule.takeProfitPricePct?: number | null` (hiányzó/null = ki).
- [x] Új `CycleRecord { index, startMs, endMs, startPrice, closePrice, rounds, profit, withdrawn, eNext, trigger: 'profit' | 'price' }`.
- [x] `RunResult.cycleLog: CycleRecord[]` (bot 1).
- [x] `src/lib/pionex/report.ts`: `RunSummary` a fenti szerződés szerint (`cycleLog` opcionális). A `metricsJson` a summary‑t menti, így a rekordok automatikusan tárolódnak.

### 2. Motor — `src/lib/pionex/interventions.ts`, `src/lib/pionex/engine.ts`
- [x] `BotRun`: `cycleStartMs`, `cycleStartPrice`, `cycleStartRounds` (első indításkor és minden újraindításkor beállítva).
- [x] `Pending.tpTrigger: 'profit' | 'price' | null` (a `tpClose` mellett; `describePending` változatlan).
- [x] `evaluateRules`: profit feltétel előbb; ha nem teljesül és `config.cycle.takeProfitPricePct` szám és `last.close ≥ cycleStartPrice · (1 + pct)` → `tpClose`, trigger `price`.
- [x] `executePending`: a TP `close` esemény `reason` értéke marad `take profit`; a `cycle` esemény szövege tartalmazza a triggert; a `cycle` esemény után egy `CycleRecord` kerül a `cycleLog`‑ba (`rounds = bot.rounds − cycleStartRounds`, `profit/withdrawn/eNext` a `settleCycle`‑ből). Újraindításkor a ciklus kezdőmezők frissülnek. Hiányzó végrehajtási percnél (`intervention_missed`) vagy TP előtti likvidációnál nem keletkezik rekord (a meglévő útvonalak ezt már biztosítják, csak teszt kell).
- [x] `engine.ts`: `cycleLog` tömb a `ctx`‑ben vagy `bot1`‑en, a `RunResult`‑ba kerül.

### 3. Kérés és paraméterek — `src/lib/pionex/runStore.ts`, `src/lib/pionex/params.ts`
- [x] `validateRunRequest`: ha `cycle.takeProfitPricePct != null`, akkor `> 0` kell; `takeProfitPct > 0` marad kötelező.
- [x] `PionexParams.tpPricePct: number | null`; `BOT_A_PARAMS.tpPricePct = null`; `toRunRequest`: `takeProfitPricePct: p.tpPricePct === null ? null : pct(p.tpPricePct)`.
- [x] `rerunRequest` változatlan.

### 4. UI — `src/components/pionex/ParamPanel.tsx`, új `src/components/pionex/CycleTable.tsx`, `src/app/pionex/page.tsx`
- [x] Panel: „TP price % above cycle start” nullable mező a Cycle szekcióban.
- [x] `CycleTable`: A/B választó; oszlopok: #, start, end, duration, start price, close price, Δ %, rounds, profit, withdrawn, E_next, trigger. „Open since …” sor a fenti szerződés szerint (utolsó start/restart esemény, csak aktív bot 1‑nél). `cycleLog` hiányában „Re-run for cycle details” felirat; üres tömbnél „No closed cycle”. Formázás a meglévő `format.ts` helpereivel.
- [x] `page.tsx`: a `CycleTable` közvetlenül a `PionexCard` alá, csak ha `run.config.cycle` be van állítva; az újrafuttató gomb feltétele bővül a szerződés szerint.

### 5. Tesztek
- [x] `pionexCycles.test.ts`: TP ár: 5m záró a szint alatt → nincs zárás; a szinten → zárás a következő 1m nyitón (`reason: 'take profit'`), `trigger: 'price'`, újraindítás ugyanazon a percen, az új sáv az új árra központosítva.
- [x] Mindkét szabály beállítva, egyszerre teljesül → trigger `profit`; külön‑külön → amelyik előbb.
- [x] Újraindítás után az árküszöb az új ciklus kezdőárához igazodik.
- [x] TP ár negatív nettóval (díjjal): zár, nincs kivét, E csökken, rekord `profit < 0`.
- [x] `cycleLog`: két ciklus után 2 rekord, mezők (startPrice = újraindítás ára, rounds a cikluson belül).
- [x] Hiányzó végrehajtási perc, illetve TP előtti likvidáció: nincs lezárt rekord.
- [x] Elutasított újraindítás: a lezárt rekord megmarad, a bot `stopped`.
- [x] `pionexRunStore.test.ts`: validáció (`takeProfitPricePct: 0` elutasítva, `null` elfogadva); mentés–visszatöltés után mindkét út `cycleLog`‑ja megvan; régi sor (nincs `cycleLog`) `stale: false` marad.
- [x] `pionexPage.test.tsx`: A/B váltás a táblán; késleltetett első indulás (open since = start esemény ideje, nem az ablak kezdete); üres és hiányzó ciklusadat; újrafuttató gomb hiányzó ciklusadatnál.
- [x] `chartData`: a TP zárás mindkét triggernél zöld TP jelölés (a `reason` nem változott, egy regressziós assert elég).

### 6. Ellenőrzés
- [x] `npx tsc --noEmit`, `npm test`.
- [x] Böngészős ellenőrzés a scratchpad rsync másolatból (a repóban fut a `:3000` dev szerver, nem indítok mellé másikat, és nem futtatok `next build`‑et a repóban). A másolat a repó `prisma/dev.db`‑be ír: a tesztfutások mentett sorként megjelennek.

## Fázisok és párhuzamosítás

| Fázis | Tartalom | Függés | Ki |
|---|---|---|---|
| **F1 — típusok** | Teendők 1. (types.ts, report.ts RunSummary) | — | fő ügynök, először; ez a közös alap |
| **F2A — motor + kérés** | Teendők 2. és 3. + a motor‑ és runStore‑tesztek (5. első nyolc pontja) | F1 | 1. sub agent |
| **F2B — UI** | Teendők 4. + page/chart tesztek (5. utolsó két pontja) | F1 (csak a típusokra; a motor kimenetére nem, a tesztek fixture‑rel dolgoznak) | 2. sub agent, F2A‑val **párhuzamosan**; diszjunkt fájlok |
| **F3 — integráció** | `tsc`, teljes `npm test`, böngészős ellenőrzés, review szakasz kitöltése | F2A és F2B | fő ügynök |

A két F2 sáv nem érinti egymás fájljait: F2A a `lib/pionex` és a `__tests__/pionexCycles|pionexRunStore`, F2B a `components/pionex`, `app/pionex/page.tsx` és `__tests__/pionexPage`. Az egyetlen közös pont a `types.ts`, amit F1 lezár.

## Review v1 → v2

| # | Finding | Megoldás |
|---|---|---|
| 1 | Az új `reason` szövegek a charton narancssárga STOP jelölést kapnának (`chartData.ts:25` pontos egyezés), és a ciklusteszt is `'take profit'`‑ot vár. | A `reason` marad `take profit`; a trigger a ciklusrekordba és a `cycle` esemény szövegébe kerül. Chart és meglévő teszt érintetlen, egy regressziós assert jön. |
| 2 | Régi futásnál „Re-run for cycle details” jelenne meg, de a gomb csak `stale` esetén látszik (`page.tsx:466`). | A gomb feltétele: `stale` **vagy** (ciklusszabály be és `cycleLog` hiányzik). Teszt `stale: false` + hiányzó ciklusadat esetére. |
| 3 | A nyitott ciklus kezdete az ablak kezdetéből jönne, de a motor az első közös last/mark percen indul. | A kezdet a bot 0 utolsó `start`/`restart` eseményéből; aktív állapot a `summary.bots[0].status` alapján. Nincs új mező. |
| 4 | Profit‑TP kötelező? | Igen, a szerződés rögzíti; az ár‑TP kiegészítő. |
| 5 | A betöltött summary típusa tükrözze a régi adatot. | `RunSummary.cycleLog` opcionális; hiányzó ≠ üres. |
| 6 | Tesztterv bővítése | Beépítve az 5. pontba. |

## Nem része
- Lefelé követés / stop‑loss újraindítás.
- ~~Reinvest az I‑be~~ (megvalósítva 2026-10-06); csak ár‑TP (profit‑TP nélkül).
- Sávok rajzolása a charton ciklusonként.
- Bot 2 ciklusszabály.

## Review (2026-10-06, megvalósítás után)

**Lefutás a terv szerint:** F1 (típusok) a fő ügynök, utána F2A (motor + kérés + tesztek) és F2B (UI + tesztek) két sub agent párhuzamosan, diszjunkt fájlokon; F3 integráció a fő ügynök. Nem volt ütközés.

**Változások**
- `types.ts`: `CycleRule.takeProfitPricePct?`, `CycleTrigger`, `CycleRecord`, `RunResult.cycleLog`. `report.ts`: `RunSummary.cycleLog` opcionális (hiányzó ≠ üres).
- `interventions.ts`: `BotRun.cycleStartMs/Price/Rounds`; `Pending.tpTrigger`; `evaluateRules` profit előbb, aztán ár (`last.close ≥ cycleStartPrice · (1 + pct)`); `executePending` egy plusz `cycleLog` paramétert kap, a `close` esemény `reason` marad `take profit`, a `cycle` esemény szövege a triggert tartalmazza (`cycle 3 (price): …`), rekord a logba, újraindításkor a ciklus kezdőmezők frissülnek. Bot 2 `BotRun` literálja is kapja a mezőket.
- `engine.ts`: `cycleLog` tömb, első indításkor ciklus kezdőmezők, a tömb a `RunResult`‑ba kerül.
- `runStore.ts`: `takeProfitPricePct != null` → `> 0` kell (`TP price must be > 0`). Nincs `REPORT_VERSION` bump; a `cycleLog` a summary részeként automatikusan mentődik és visszatöltődik.
- `params.ts`: `tpPricePct: number | null` (alap `null`), `toRunRequest` a ciklusobjektumba teszi. `rerunRequest` változatlan.
- `ParamPanel.tsx`: „TP price % above cycle start (empty = off)” nullable mező a Cycle szekcióban. Új `CycleTable.tsx` (A/B választó, 12 oszlop, „open since …” sor a bot 0 utolsó start/restart eseményéből, csak aktív bot 1‑nél; „Re-run for cycle details” hiányzó, „No closed cycle” üres lognál). `page.tsx`: tábla a kártya alatt, ha van ciklusszabály; újrafuttató gomb `stale` vagy (ciklus be és `cycleLog` hiányzik) esetén.
- Tesztek: `pionexCycles` +7, `pionexRunStore` +2, `pionexPage` +4, új `pionexChartData.test.ts` (TP zárás zöld jelölés). `pionexReport.test.ts` két `toEqual` sora bővült `takeProfitPricePct: null`‑lal (a `toRunRequest` most mindig kiadja a mezőt) — ez a tervben nem szerepelt, egyetlen szükséges kiegészítés.

**Ellenőrzés:** `npx tsc --noEmit` zöld; `npm test` 34 fájl / 525 teszt zöld. Böngészős ellenőrzés scratchpad rsync másolatból (:3101, leállítva): SOLUSDT 2026‑08‑22 → 10‑06 ablak, profit‑TP 1,3 % + ár‑TP 3 %: A út 14 ciklus (9 ár, 5 profit), ellenőrzött küszöb 93,73 · 1,03 = 96,54 ≤ 96,91 záró; ugyanez ár‑TP nélkül 6 ciklus. A tábla, az A/B váltás, a nyitott sor, a régi futásnál a „Re-run for cycle details” felirat és az újrafuttató gomb, valamint a panelmező mind rendben. Konzolhiba nincs.

**Review-finding javítva (2026-10-06):** az ár‑TP összehasonlítás pontosan a küszöbön elmaradhatott lebegőpontos kerekítés miatt (`100 · 1.1 = 110.00000000000001`). Javítás: a küszöb `(1 − 1e‑12)` relatív toleranciával (`interventions.ts`, egy sor); regressziós teszt a `pionexCycles.test.ts`‑ben (100 → 110 A/B úton, 30 → 30,90), ami a javítás nélkül elbukik. `npm test` 532 teszt zöld.

**Megjegyzés:** a másolat a repó `prisma/dev.db`‑be ír, így két teszt futás mentett sorként látszik („verify trailing tpPrice=null” és „… =0.03”) — törölhetők a Run history listából. A :3000 dev szervert nem kell újraindítani (nincs sémaváltozás).
