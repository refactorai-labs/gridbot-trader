# Pionex Long Futures Grid Backteszter — terv (v3, második review után)

Repó: `refactorai-labs/gridbot-trader` · Cél fájl: `docs/pionex-backtester-plan.md` · Dátum: 2026‑10‑05 · Verzió: v3

## 0. Változásnapló

### 0.1 v2 → v3 (második review)

| Review pont | Döntés | Hol |
|---|---|---|
| 1. Funding időegyezés | **Elfogadva.** A settlement a perces vödrébe kerül (`floor(fundingTime / 60s)`), rekordonként pontosan egyszer. Külön, szigorú funding‑lefedettség (a meglévő `fundingCache` 95%‑os küszöbe a repóban ellenőrizve). A settlement `markPrice` mezőjét **nem** használjuk (indok a 3.4.3‑ban). | 3.4.3, 5 |
| 2. Likvidáció mint esemény | **Elfogadva.** A likvidációs küszöb átlépése megszakítja a szegmenst, utána nincs töltés. Ellenőrzés a nyitási résnél, a funding után és minden beavatkozás után is. Két új teszt. | 3.4, 4.3 |
| 3. Árutak, mark–last összerendelés, verdikt | **Elfogadva.** Két globális érzékenységi út: A = `O→L→H→C`, B = `O→H→L→C`, gyertyaszíntől függetlenül; „pesszimista” elnevezés törölve. Konkrét mark–last szabály. Verdikt: eltérő utaknál „árútfüggő” a fő címke. | 3.4.1–3.4.2, 6.1 |
| 4. Újraindítás és egyidejű beavatkozások | **Elfogadva** a válaszaid szerint: a ciklusbeli feltöltés a botnál marad; a `bot1ClosePrice` végleg leállítja az 1. botot. Rögzített beavatkozási sorrend. | 3.6–3.8 |
| 5. Bot B és a likvidációs validáció | **Elfogadva.** Bot B „részben validált”. A táblázat külön mutatja az aktuális pozíció és a teljes grid likvidációs árát; a ±2%‑os kapu csak a teljes gridre és csak a jelentés megerősítése után él. | 4 |
| Kisebb pontok | Mind elfogadva: marginfedezet csak a nyitott pozícióra; MTM és min. távolság a teljes eseményfolyamból; 1m események 5m gyertyára illesztve eredeti időponttal; TradingChart marker‑törlés javítása (repóban ellenőrizve); fáziskapuk szétválasztva; adathiány esetén nincs megbízható verdikt. | 3.5, 3.10, 5, 6, 7 |

### 0.2 v1 → v2 (első review, röviden)

Időrendi eseménymotor 1m last + mark adaton; egyetlen pénzügyi főkönyv; fix közös tőkekeret, elutasított események okkal; `I` fix, csak `E` nő; javított Bot B fixture (11,11 USDT, 0,117 = 23 kör összesen); `P_liq·0,985` korrekció törölve; minimális marginfedezet‑ellenőrzés; meglévő futures adatréteg és `ETHUSDTPERP` kulcskonvenció; `PionexRun` JSON‑t tartalmazó `String` mezőkkel (Prisma 5.22); Top N esés „utólag kiválasztott” címkével; azonos tőkéjű trió.

### 0.3 Megerősített keretek

- Döntéstámogató backteszt, nem Pionex‑klón.
- A botok és a feltöltések **fix közös tőkekeretből** gazdálkodnak.
- A bent hagyott profit **csak az extra margint** növeli; a ciklus közbeni feltöltés **a botnál marad** a következő ciklusban is.
- `bot1ClosePrice` **véglegesen** leállítja az 1. botot (nem ciklus).
- Végrehajtás **1 perces** futures last és mark adaton; beavatkozás **lezárt 5m gyertya** alapján, a **következő 1m nyitón**.
- v1 csak új botot tesztel indulástól.

## 1. Cél

Egyszerű, de Pionex‑hű backteszter, amellyel kijelölt időszakokon (főleg nagy eséseken) megnézhető, hogy egy **15x long futures grid bot** adott sávval, befektetéssel és extra marginnal

- túlélte volna‑e (likvidáció igen/nem, mikor, minimális likvidációs távolság, határeset, árútfüggő, adathiányos),
- mennyi grid profitot termelt, hány kört és ciklust zárt,
- mekkora volt a mark‑to‑market drawdown, mennyi ideig volt víz alatt, visszaért‑e a teszt végéig,
- és hogyan viselkedett volna **két lépcsőzött long bot** vagy **menet közbeni feltöltés** ugyanazzal a teljes tőkével.

Szimbólumok: ETHUSDT, SOLUSDT, BTCUSDT (Binance USDT‑M futures). Minden költség (maker/taker/funding/mmr) felülírható.

## 2. Alapdöntések

| # | Döntés |
|---|--------|
| 1 | Új, önálló motor (`src/lib/pionex/`); a meglévő simulation / combo / strategies / optimizer / research kód érintetlen. Újrahasznosítva: `fetchBinanceKlines(market:'futures')`, candle cache, funding tábla, TradingChart, design tokenek. A főkönyv a `src/lib/research/account.ts` mintáját követi, de nem importálja. |
| 2 | Adat: Binance fapi **1m last** és **1m mark** (`/fapi/v1/markPriceKlines`) a kiválasztott ablakokra, igény szerint; teljes történet csak **1h**‑n, a Top N esés listához. Funding a `/fapi/v1/fundingRate`‑ből, ablakonként szigorú lefedettséggel. |
| 3 | Gyertyán belüli út: két globális érzékenységi forgatókönyv, **A = `O→L→H→C`** és **B = `O→H→L→C`**, minden gyertyára, színtől függetlenül. Egyik sem bizonyított alsó korlát. |
| 4 | Díjak: maker a gridtöltésekre, taker az induló vételre és minden beavatkozásos zárásra. `mmr` input (alap 0,5%). |
| 5 | Forgatókönyvek: egy bot kivárással; ciklus‑szabály; lépcsőzött 2. bot; extra margin előre + tartalékból feltöltés; fix záróár (végleges leállítás). Stop‑loss nem fókusz. |
| 6 | Beavatkozás: lezárt 5m gyertya (1m‑ből aggregálva) → végrehajtás a következő 1m nyitón, rögzített sorrendben (3.8). |
| 7 | Sáv %‑os offsetként a start‑árhoz képest (alap), abszolút felülírással. |
| 8 | Top N esés lista 1h adatból, „utólag kiválasztott stresszablak” címkével. |
| 9 | Összehasonlítás v1: futás‑előzmények, két futás kitűzése, azonos tőkéjű trió. Sweep = v2. |
| 10 | Mentés SQLite‑ba (`PionexRun`) JSON‑t tartalmazó `String` mezőkkel; metrikák a teljes eseményfolyamból, csak a megjelenítési idősorok ritkítva. |
| 11 | Chart 5m gyertyákkal; az 1m események az 5m gyertyájukra illesztve, eredeti időponttal a tooltipben és az eseménylistában. |
| 12 | UI: külön `/pionex` oldal (6. fejezet). |

## 3. Modell specifikáció

Forrás: Pionex support „Futures Grid Bot” és „Liquidation” cikkek, a két élő bot (4. fejezet), Binance fapi dokumentáció. Minden feltételezést a motor kommentben jelöl a pontra hivatkozva, és a UI „Feltételezések” panelje felsorolja.

### 3.1 Gridek és méretezés

- Aritmetikus: `p_i = L + i·(U−L)/n`, `i = 0..n`. Geometrikus: `p_i = L·r^i`, `r = (U/L)^(1/n)`.
- Gridenkénti notional `Q = I · lev / n`, mennyiség `qty_i = Q / vételi ár`. Két boton profit/körre 2%‑on belül egyezik; a pozíciómennyiséget a 4.2 rögzítés ellenőrzi.
- Vételi szintek az alsó `n` szint, minden vétel párja a felette lévő szint eladása.

### 3.2 Pénzügyi főkönyv

Botonként: `wallet` (izolált margin‑egyenleg, induláskor `I + E` a közös keretből), `qty` és `avgEntry` (tőzsdei, átlagáras), `lots` (párosítás csak a grid‑profit kijelzéshez), `status ∈ {aktív, likvidált, leállítva}`.

| Esemény | Hatás |
|---|---|
| Vétel (limit vagy piaci) | `wallet −= díj`; `qty`, `avgEntry` frissül; lot nyílik |
| Eladás (grid) | `wallet += q·(p − avgEntry) − díj`; `qty` csökken; lot párosítva zárul |
| Funding settlement | `wallet −= qty · markPrice · rate` (long fizet, ha rate > 0) |
| Extra margin feltöltés | `wallet += x`, `freeCash −= x` (pénzmozgás, nem profit) |
| Bot zárása | piaci eladás taker díjjal, a `wallet` vissza (3.6 / 3.8 szerint) |
| Likvidáció | `wallet` és pozíció elvész, `status = likvidált`; további esemény nincs |

Származtatott mutatók:

- `equity(P) = wallet + qty·(P − avgEntry)`; likvidációhoz és MTM‑hez **mark**, TP‑döntéshez **last** árral.
- **Grid profit** (kártya) = lezárt párok `q·(p_sell − p_buy)` mínusz a pár mindkét díja. Csak kijelzés.
- **Ciklusprofit** = zárás utáni `wallet` − (`I + E_start + Σ ciklusbeli feltöltés`). Tartalmaz minden díjat és fundingot.

A likvidáció csak `equity` és `qty` függvénye, ezért az átlagáras vs. párosított elszámolás a túlélést nem, csak a kijelzést befolyásolja.

### 3.3 Indulás

- Start‑ár feletti vételi szintek: azonnali piaci vétel (`k` grid, taker), `qty = k·Q / startPrice`, eladási limitek a felső szintekre.
- Start‑ár alatti szintekre limit vétel (maker).
- Ha a közös keret nem fedezi `I + E`‑t, a bot nem indul (`start_rejected`).

### 3.4 Futás — 1 perces eseménysor

Minden 1m gyertyára, minden aktív botra, **ebben a rögzített sorrendben**. A „likvidációs ellenőrzés” mindig ugyanaz: `equity(mark) ≤ qty · mark · mmr` → likvidáció, és a bot azonnal kiesik a további lépésekből.

1. **Nyitási rés szegmens:** előző 1m last close → aktuális 1m last open, a 3.4.1 szegmensszabályával (a résben keresztezett limitek töltődnek, a küszöb átlépése megszakít). A szegmens végén ellenőrzés a **mark open**‑nal.
2. **Funding**, ha a perces vödörbe settlement esik (3.4.3), majd ellenőrzés a mark open‑nal.
3. **Függő beavatkozások** a 3.8 sorrendjében, a last open áron (taker). Minden beavatkozás után ellenőrzés a mark open‑nal. Ami az 1–2. lépésben likvidálódott, azon beavatkozás nem hajtódik végre (a függő feltöltés `topup_cancelled: már likvidált` eseményt kap, a pénz a `freeCash`‑ben marad).
4. **Gyertyán belüli szegmensek** az aktív út szerint (A vagy B), 3.4.1.
5. Ha a gyertya egy 5m gyertyát zár: **beavatkozási szabályok kiértékelése** (TP, feltöltés, 2. bot trigger, fix záróár); a teljesülők a következő 1m nyitón hajtódnak végre.

#### 3.4.1 Szegmensek, mark–last összerendelés, likvidáció mint esemény

**Mark–last összerendelés (rögzített szabály):** gyertyánként egyetlen eltolás, `d = min(markO − lastO, markH − lastH, markL − lastL, markC − lastC)`. A gyertyán belül a modell‑mark `= last + d`. A gridtöltés last áron történik; a hozzá tartozó mark a töltés pillanatában `p + d`.

**Likvidációs küszöb last‑árban:** az aktuális állapotból `P_liq` (mark‑ár, 3.4.4), ebből `T = P_liq − d`.

**Lefelé haladó szegmens (X → Y, X > Y):** az eseményeket ár szerint csökkenő sorrendben dolgozza fel. A következő esemény a magasabb a következő vételi szint és a `T` közül:

- ha a vételi szint jön előbb: töltés (a 3.5 fedezetellenőrzéssel), főkönyv, `P_liq` és `T` újraszámolása, folytatás;
- ha `T` jön előbb (vagy egyenlő): **likvidáció ezen a ponton**, a szegmens megszakad, az alatta lévő szintek nem töltődnek.

A szegmens végén kiegészítő ellenőrzés a gyertya **tényleges** mark szélsőértékével (ha a szegmens a last low‑ban végződik: `markL`, ha a close‑ban: `markC`). Ha ez likvidál, a likvidáció időpontja a szegmens vége.

**Felfelé haladó szegmens:** eladások ár szerint növekvő sorrendben. A pozíció csökken és az ár nő, ezért itt likvidáció csak a szegmens elején állhat fenn, azt az előző lépés már elkapta.

Ez a szabály egyértelmű és reprodukálható, de **nem garantáltan konzervatív**: a gyertyán belüli valós mark‑last kapcsolatot nem ismerjük. A feltételezés a UI‑ban látszik.

#### 3.4.2 Két árút mint érzékenységi forgatókönyv

A teljes futás kétszer megy: az **A** úttal (`O→L→H→C`) és a **B** úttal (`O→H→L→C`), minden gyertyára. Ha a túlélési verdikt, a likvidáció időpontja (± 1 óra) vagy a ciklusok száma eltér, a futás **árútfüggő**. Egyik út sem bizonyított alsó korlát egy sokgyertyás futásra, ezért mindkét eredmény látszik.

#### 3.4.3 Funding

- **Hozzárendelés:** minden settlement rekord a `floor(fundingTime / 60 000 ms)` perces vödörbe kerül, ott a 3.4 / 2. lépésben alkalmazódik. A Binance `fundingTime` értéke néha 1–4 ms‑mal a percnyitás után van; pontos egyezésvizsgálat ezeket kihagyná.
- **Pontosan egyszer:** rekordonként (`symbol`, `fundingTime`) egyszeri alkalmazás, a vödör egyedi; ha egy vödörbe két rekord esne, az adathiba (futás leáll hibával).
- **Ár:** a vödör 1m **mark open** ára. A settlement rekord saját `markPrice` mezőjét nem használjuk: a különbség a funding összegében a rátával szorzódik, egy 0,05%‑os árkülönbség 0,01%‑os rátánál a notional ~5·10⁻⁸‑a, ami elhanyagolható, és nem éri meg a `BinanceFundingRate` séma bővítését.
- **Lefedettség (szigorú, csak Pionex‑futáshoz):** az ablakban két egymást követő rekord között legfeljebb 8 óra + 1 perc lehet, és az ablak elejétől az első, illetve az utolsótól az ablak végéig szintén. Ha nem teljesül: a hiányzó szakaszok célzott letöltése; ha utána is hiány marad, a futás **adathiányos** (3.10). A meglévő `getOrFetchFundingRates` 95%‑os, becsült rekordszámos elfogadását a Pionex‑útvonal nem használja.
- Konstans felülírás input megmarad.

#### 3.4.4 Likvidációs árak

- **Aktuális pozíció likvidációs ára** (motor, chart‑vonal, minden állapotváltozás után): `P_liq = (qty·avgEntry − wallet) / (qty·(1 − mmr))`.
- **Teljes grid likvidációs ára** (kártya, a Pionex Est. Liq. összevetéséhez): ugyanez a képlet azzal a feltételezéssel, hogy minden még nyitott vételi szint a saját árán teljesül. A kettő induláskor nagyon eltér (Bot A: ~1862 vs ~2367).

#### 3.4.5 Sávon kívül

Alul: nincs több töltés. Felül: pozíció üres, várakozás.

### 3.5 Minimális marginfedezet‑ellenőrzés

- Egy vételi limit csak akkor teljesül, ha `equity(mark) − qty·avgEntry / lev ≥ Q / lev + díj`, ahol `qty` és `avgEntry` **csak a jelenleg nyitott pozíció** (lezárt lotok nem foglalnak fedezetet; nyitott limit megbízások sem). Ha nem, `buy_skipped` (szint, ár, hiányzó fedezet); a szint később újra élhet.
- Kapcsolható (alap: be). Kikapcsolva is érvényes a 3.4.1: a likvidációs küszöb alatt nincs töltés.
- Mért hatás: a két fixture‑nél a sávon belül nem köt; alacsony induló extra marginnál (Bot A `E = 0`) köt, ezért a „tartalékból feltöltés” forgatókönyvet érinti.
- Közelítés; a Pionex pontos szabálya nem ismert.

### 3.6 Ciklus‑szabály (1. bot)

- Kiértékelés lezárt 5m gyertyán: `netIfClosed = equity(last close) − qty·close·taker − (I + E_start + Σ ciklusbeli feltöltés)`. Ha `netIfClosed ≥ TP% · I` → zárás a következő 1m nyitón (3.8), `cycles++`.
- A ténylegesen realizált ciklusprofit dönt:
  - **pozitív** (módosítva 2026-10-06, kamatos): `I_next = I + reinvest% · profit`; `E_next = E_start + Σ ciklusbeli feltöltés`; `kivett += (1 − reinvest%) · profit`;
  - **nem pozitív** (a végrehajtási ár a TP‑döntés óta romlott): `I_next = I`; `E_next = E_start + Σ ciklusbeli feltöltés + profit` (a veszteség az extra marginból fogy), nincs kivét.
- Az új ciklus gridje `I_next`‑ből méreteződik (`Q = I_next·lev/n`), a profit‑TP küszöb `TP% · I_next`. Újraindítás ugyanazon az 1m nyitón **a bot saját visszakapott pénzéből** (`I_next + E_next`), a `freeCash`‑ből nem húz. Ha `E_next < 0`: nincs újraindítás (`restart_rejected`), a pénz a `freeCash`‑be kerül.
- Példa: `I = 1000`, `E_start = 1750`, ciklusbeli feltöltés 200, nettó profit 100, reinvest 20% → `I_next = 1020`, `E_next = 1950`, kivett 80.
- A 2. botra v1‑ben nincs ciklus‑szabály (tartás).
- Opcionális `takeProfitPrice` (Pionex natív, árszintes TP). Fázis 1 ellenőrzés: a Pionex Customize nézet TP‑mezői futures gridnél.

### 3.7 Közös tőkekeret és feltöltés

- `capitalTotal` = minden pénz. Állapot: `freeCash`, botonkénti `wallet`, `kivett`.
- Feltöltés: lezárt 5m gyertyán, ha `(markClose − P_liq) / markClose < topUpTriggerPct` → a következő 1m nyitón `wallet += min(topUpAmount, freeCash)`, a ciklusbeli feltöltések közé számítva. `freeCash = 0` esetén `topup_rejected`.
- **Invariáns (teszt, minden esemény után):** `freeCash + Σ wallet + kivett = capitalTotal + Σ realizált trade PnL − Σ díj − Σ funding − Σ likvidációs veszteség`.
- Hozam‑nevező: `capitalTotal`. Teljes vagyon = `freeCash + Σ equity(mark) + kivett`.

### 3.8 Lépcsőzött 2. bot, fix záróár, beavatkozási sorrend

**2. bot:** trigger lezárt 5m gyertyán, záróár `< L1 · (1 − triggerOffset%)`. Sáv `[L1 − szélesség1, L1]` (alap), `I2 = I1 · capitalMultiplier`, `E2 = E1 · capitalMultiplier`, a `freeCash`‑ből; hiány esetén `bot2_rejected`. Saját izolált margin és `P_liq2`. Max 2 bot, egyszer indul.

**Fix záróár (`bot1ClosePrice`):** lezárt 5m gyertyán, ha a záróár `≤ bot1ClosePrice` → az 1. bot zárása a következő 1m nyitón, `status = leállítva`, **nincs újraindítás**, a `wallet` a `freeCash`‑be kerül. Ez nem ciklus, a ciklusszámláló nem nő, kivét nincs.

**Egy 1m nyitón esedékes beavatkozások sorrendje:**

1. Zárások: fix záróár, majd TP‑zárás (a fix záróár elsőbbséget élvez, ha mindkettő esedékes, mert az végleges). A felszabaduló pénz előbb a `freeCash`‑be / a bot újraindítási keretébe kerül.
2. Feltöltések a még nyitott botokra (meglévő pozíció védelme előbb, mint új kitettség). Záruló botra esedékes feltöltés törlődik.
3. TP után újraindítás (saját visszakapott pénzből, 3.6).
4. 2. bot indítása a maradék `freeCash`‑ből.

Minden lépés után likvidációs ellenőrzés (3.4 / 3. lépés).

### 3.9 Ismert, elfogadott eltérések

- Binance mark ≠ Pionex mark.
- Gyertyán belüli last és mark út ismeretlen → két globális út (3.4.2) és rögzített mark–last szabály (3.4.1), egyik sem garantált alsó korlát.
- Tier‑es `mmr` → egyetlen input.
- Two‑layer buffer → 3.5 közelítés.
- Likvidációs díj nem modellezve.
- Funding: Binance ráta, a vödör mark open árán.
- A teljes grid likvidációs ára a Pionex Est. Liq.‑tól eltér (Bot A +1,4%). Nincs korrekciós szorzó; „határeset” szabály (6.1).

### 3.10 Adatminőség

- Futás előtt ellenőrzés az ablakra: 1m last, 1m mark (várt vs talált percek, lyukak listája) és funding (3.4.3).
- **Bármilyen hiány esetén a futás lefuthat, de a verdikt „adathiányos”**, túlélési állítás nélkül; a kártya a lyukakat listázza. Dokumentált hiány sem ad megbízható verdiktet.
- Ha egy percből csak az egyik sorozat hiányzik, a motor nem pótol; a perc hiányként szerepel.

## 4. Validáció

### 4.1 Fixture‑ök

| | Bot A (2026‑09‑29) | Bot B (screenshot‑bot, korábbi) |
|---|---|---|
| Sáv | 2546,9 – 2839, 60 grid, aritmetikus | 2509,51 – 2868,01, 60 grid, aritmetikus |
| I / E / lev | 134,68 / 103,59 / 15x | 11,11 / ~19,44 (megerősítendő) / 15x |
| Start ár / induláskor nyitott gridek | 2728,77 / 22 | 2689,29 / 29 |
| Pionex profit | 8,93 / 192 kör = 0,0465 / kör | 0,117 / 23 kör = 0,00509 / kör |
| Modell profit/kör (átlag, maker–maker) | 0,0475 (+2%) | 0,005076 (−0,2%) |
| Pionex Est. Liq. | 2334,74 | 2135,67 |
| Modell P_liq — induló pozíció | ~1862 | ~1679 |
| Modell P_liq — teljes grid | 2366,7 (+1,4%) | 2168,6 (+1,5%) |
| Státusz | profit/kör validált; likvidáció a jelentés megerősítéséig nyitott | **részben validált**: profit/kör konzisztens; `E` és a screenshot eredete megerősítendő |

Megjegyzések:

- Mindkét Pionex Est. Liq. a teljes grid modellértékétől ~1,5%‑ra, az induló pozíció modellértékétől ~20%‑ra van. Ez arra utal, hogy a Pionex Est. Liq. teljesen feltöltött gridre számolt becslés, de **ez következtetés, nem igazolt tény**. Ellenőrzés: ugyanannál a botnál két eltérő pozícióállapotban leolvasva az Est. Liq. nem mozdul a pozícióval (4.2).
- Bot B `E`‑je a kalkulátor 1,75‑ös arányából becsült. A teljes grid likvidációs ára azonos `E/I` mellett skálafüggetlen, de az `E`‑t a screenshotról kell megerősíteni.
- Az „1000 / 1750” csak UI preset.

### 4.2 Fixture‑rögzítési lista (Sandor teendője, a következő élő botnál)

Indításkor **és** legalább egy későbbi, eltérő pozícióállapotban:

- pontos időpont (UTC);
- pozíció mennyisége és átlagára a Pionex pozíció nézetből;
- margin / extra margin, és minden menet közbeni marginváltozás;
- díjszint, összes kifizetett funding;
- Est. Liq. Price, grid profit, Total profit, körök száma;
- a kártyaszámok jelentése (díjat tartalmaz‑e a grid profit, fundingot a Total profit).

Bot B‑hez: a screenshot forrása (melyik bot, mikor) és az extra margin értéke.

### 4.3 Kapuk és tesztek

**Fázis 1 kapu (egy bot, ciklus nélkül):**

1. Statikus fixture‑tesztek: profit/kör ±3%; induló mennyiség ±2%. A teljes grid `P_liq` ≥ Pionex Est. Liq. és ±2% **csak akkor kapu**, ha a 4.2 megerősítette, hogy az Est. Liq. teljes gridre szól; addig csak riportált érték. A ±2% regressziós tűrés, nem döntési pontosság.
2. Visszajátszás (Bot A, ha az időpontok rögzítve): körök 192 ±15%, grid profit 8,93 ±10%.
3. Egységtesztek:
   - visszapattanás nem ment meg (az ár a küszöb alá esik, majd a nyitó fölé zár → likvidáció);
   - **likvidációs küszöb alatti vételi szint nem töltődik**, fedezetellenőrzés kikapcsolva is;
   - **nyitáskori likvidáció + függő feltöltés:** a mark open már a küszöb alatt → likvidáció, a feltöltés `topup_cancelled`, a `freeCash` változatlan (ehhez a teszthez egy minimális, beégetett feltöltési esemény elég, a feltöltés‑szabály nélkül);
   - nyitási rés szegmens: résben keresztezett vételi szint töltődik, és a küszöb átlépése megszakít;
   - funding: 1–4 ms‑mal eltolt `fundingTime` a helyes percben, pontosan egyszer; előjel; settlement előtt nyitott pozíció fizet, utána nyitott nem; funding utáni azonnali likvidációs ellenőrzés;
   - funding‑lefedettség: kihagyott rekord → adathiányos verdikt;
   - díj nincs kétszer levonva;
   - mark–last szabály: `d` számítása és a `T = P_liq − d` küszöb;
   - A és B út eltérése „árútfüggő” címkét ad;
   - marginfedezet csak a nyitott pozícióra; Bot A `E = 0`‑val kihagyott vételek a sávon belül;
   - főkönyvi invariáns egy botra.

**Fázis 2 kapu (ciklusok, közös keret, 2. bot):**

- 3.6 példa: `E_next = 1970`, kivett 80;
- nem pozitív ciklusprofit: veszteség az `E`‑ből, nincs kivét;
- `bot1ClosePrice` végleges leállítás, nincs újraindítás, ciklusszámláló nem nő;
- egyidejű beavatkozások a 3.8 sorrendjében; záruló botra esedékes feltöltés törlődik;
- elutasított feltöltés / 2. bot / újraindítás okkal;
- főkönyvi invariáns két bottal, minden eseménynél.

**Bias‑vizsgálat** (időkeret: egy délután): jelöltek a tier‑es `mmr`, a Pionex mark price, díj/funding tartalék a marginban, eltérő pozíciómennyiség. A 4.2 adatai döntenek; ha nincs meg az ok, dokumentálva marad, korrekció nélkül.

## 5. Hogyan egészül ki a kód

**Nem változik:** `src/lib/simulation/*`, `combo/*`, `strategies/*`, `optimizer/*`, `research/*`, `src/app/page.tsx` (egy rail‑link kivételével), `BinanceCandle` és `BinanceFundingRate` séma, `getOrFetchFundingRates` viselkedése, meglévő tesztek.

**Új fájlok**

```
src/lib/pionex/
  types.ts            config, BotState, LedgerEvent, RunResult, Verdict
  gridLevels.ts       szintek + %‑offset → abszolút sáv
  ledger.ts           3.2 főkönyv + invariáns
  capital.ts          3.7 közös keret: allocate / release / reject okkal
  engine.ts           3.4 eseménysor, tiszta függvény: (last1m, mark1m, funding, config, path) → RunResult
  segments.ts         3.4.1 szegmensek, mark–last eltolás, likvidáció mint esemény
  liquidation.ts      aktuális és teljes grid P_liq, távolság
  funding.ts          perces vödör, egyszeri alkalmazás, lefedettség‑ellenőrzés
  interventions.ts    3.6–3.8 szabályok és végrehajtási sorrend
  aggregate.ts        1m → 5m (döntések, megjelenítés)
  drawdowns.ts        Top N esés 1h adatból
  metrics.ts          metrikák a teljes eseményfolyamból; ritkítás csak megjelenítéshez
  dataQuality.ts      3.10 ellenőrzés (last, mark, funding)
src/lib/data/markPrice.ts   fetchBinanceMarkPriceKlines (/fapi/v1/markPriceKlines)
src/lib/data/windows.ts     ablak letöltése igény szerint + hiányjelentés
src/app/pionex/page.tsx
src/components/pionex/
  ParamPanel.tsx  PionexCard.tsx  ExposurePanel.tsx  SubCharts.tsx
  DrawdownPicker.tsx  Assumptions.tsx  EventList.tsx  RunHistory.tsx
src/app/api/pionex/{run,runs,data,drawdowns}/route.ts
src/__tests__/pionexLedger.test.ts
src/__tests__/pionexEngine.test.ts
src/__tests__/pionexFunding.test.ts
src/__tests__/pionexFixtures.test.ts
src/__tests__/pionexCycles.test.ts     (Fázis 2)
```

**Módosul (minimálisan)**

- `src/lib/constants.ts`: SOL pár, ha még nincs; futures/mark kulcskonvenció.
- `src/lib/data/fundingCache.ts`: a meglévő `storeFundingRates` **exportálása** (viselkedésváltozás nélkül), hogy a `pionex/funding.ts` a hiányzó szakaszokat célzottan letöltse és eltárolja. A 95%‑os logika érintetlen.
- Cache‑kulcsok séma‑módosítás nélkül: last = `pair: 'ETHUSDTPERP'`, `symbol: 'ETHUSDT'`, `market: 'futures'`; mark = `pair: 'ETHUSDTMARK'`. Intervallumok: `1m`, `1h`.
- `prisma/schema.prisma`: új `PionexRun` modell, `String` JSON mezőkkel: `id, name, symbol, startTs, endTs, configJson, metricsJson, equityJson, liqSeriesJson, eventsJson, verdict, dataGapsJson, createdAt`. Az equity és likvidációs idősor 5m‑re ritkítva (minden 5m vödörben a minimum is megőrizve); az események teljesen, eredeti időponttal.
- `src/components/charts/TradingChart.tsx`: három opcionális prop: `lineSeries` (időfüggő likvidációs vonal botonként, 2. bot sáv), `markers` (töltések, beavatkozások, 5m gyertyára illesztett időponttal), `verticalMarkers` (ciklushatárok). **Marker‑kezelés javítása:** a jelenlegi effekt combo nélkül `setMarkers([])`‑szel töröl (repóban ellenőrizve, ~1249. sor), ami az új markereket is törölné. Egyetlen helyen kell összefésülni: combo markerek (ha vannak) + `markers` prop, idő szerint rendezve (lightweight‑charts 4.x), egy `setMarkers` hívással. `markers` prop nélkül a viselkedés változatlan.
- `src/app/page.tsx`: egy rail‑link.

**Teljesítmény:** mérendő cél. Kiírva külön: adatbetöltés, számítás (2 út), mentés + válasz.

## 6. UI — `/pionex` oldal

Elv változatlan: egy képernyő, három zóna, meglévő design tokenek.

```
┌─ rail ─┬───────────────────────────────────────────────────────────┐
│        │  ETH ▾  [Adat: ablak ⟳ · lefedettség]  Top esések ▾  Dátum│
│        ├──────────────┬────────────────────────────────────────────┤
│        │ PARAMÉTEREK  │  VERDIKT                                   │
│        │ (accordion)  │  PIONEX‑KÁRTYA botonként                   │
│        │ Bot          │  Est. Liq (teljes grid) · aktuális P_liq   │
│        │ Közös tőke   │  MTM max DD · min liq táv · ciklusok       │
│        │ Költségek    │  víz alatt · visszatért? · kivett          │
│        │ Ciklus       │  kihagyott vételek · elutasított események │
│        │ Feltöltés    ├────────────────────────────────────────────┤
│        │ 2. bot       │  KITETTSÉG: bot1 · bot2 · összesen · szabad│
│        │ Fix záróár   ├────────────────────────────────────────────┤
│        │ Feltételezés │  FŐ CHART (5m): gridek · töltések ·        │
│        │              │  aktuális liq vonal botonként · jelölők    │
│        │ ▶ Futtatás   ├────────────────────────────────────────────┤
│        │              │  [Vagyon] [Liq táv %] [Pozíció] [Funding]  │
│        │              │  [Események]                               │
│        │              ├────────────────────────────────────────────┤
│        │              │  FUTÁSOK · 📌 kitűzés (2) · trió           │
└────────┴──────────────┴────────────────────────────────────────────┘
```

### 6.1 Verdikt

Prioritás:

1. **Adathiányos** — van hiány az ablakban (3.10); túlélési állítás nincs, a lyukak listázva.
2. **Árútfüggő** — az A és B út eltér (az egyik túlél, a másik likvidálódik, vagy eltér az időpont / ciklusszám). Mindkét eredmény egymás mellett.
3. **Likvidált** — mindkét úton.
4. **Határeset** — mindkét úton túlél, de a minimális likvidációs távolság kisebb, mint a fixture‑eken mért legnagyobb eltérés (alap 2%).
5. **Túlélt**.

A minimális likvidációs távolság és az MTM drawdown a teljes eseményfolyamból (minden szegmensvég és esemény) számolódik, a ritkítás előtt.

### 6.2 Stresszablak

Címke: „Utólag kiválasztott stresszablak — a csúcs ismerete jövőbeli információ, az eredmény nem élő belépési stratégia teljesítménye.” Opcionális „indítás a csúcs előtt X nappal”.

### 6.3 Azonos tőkéjű trió

Ugyanazzal a `capitalTotal`‑lal és ablakkal: (1) egy bot, minden tartalék előre extra marginként; (2) egy bot, kis `E`, a többi tartalékból feltöltve; (3) két lépcsőzött bot. Három oszlopos kártya, aggregált kitettség.

### 6.4 Chart és események

- 5m gyertyák; az 1m események az 5m gyertyájukra illesztett markerként, az eredeti percidőponttal a tooltipben.
- Az „Események” fül időrendben, eredeti időponttal listáz minden főkönyvi eseményt, elutasítást és törlést.

## 7. Fázisok és kapuk

| Fázis | Tartalom | Kapu |
|---|---|---|
| 0 | `fetchBinanceMarkPriceKlines`, ablak‑letöltő + hiányjelentés, `storeFundingRates` export, szigorú funding‑lefedettség, 1h teljes történet, SOL, `/pionex` váz | ETH/SOL/BTC 1m last + mark + funding a 2022‑05, 2022‑11 és egy 2025‑ös esés ablakára; hiányjelentés üres, vagy a hiányos ablak adathiányosként jelölve |
| 1 | főkönyv, egy bot eseménymotorja ciklus nélkül, likvidáció mint esemény, funding, fedezet, A/B út, adatminőség | **Check‑in:** 4.3 Fázis 1 kapu; mért számok bemutatva; bias‑vizsgálat eredménye |
| 2 | közös keret, ciklus‑szabály, feltöltés, 2. bot, fix záróár, beavatkozási sorrend | 4.3 Fázis 2 kapu |
| 3 | UI: panel, kártya + verdikt, kitettség, chart propok + marker‑javítás, subchartok, események, Top N, futások, trió | a három ablak egy kattintással fut; trió és két kitűzött futás egymás mellett; feltételezések és adathiány látszik; a meglévő főoldali chart markerei változatlanok |

## 8. Nem‑célok (v1)

Paraméter‑sweep/optimalizáló, gördülő indítású eloszlás, short/neutral grid, Pionex mark price rekonstrukció, tier‑es `mmr`, 2‑nél több bot, ciklus‑szabály a 2. botra, élő bot állapotának importja, Pionex API élő bekötés, a settlement `markPrice` tárolása.

---

## 9. Claude Code indító prompt

```
Olvasd el a docs/pionex-backtester-plan.md fájlt (v3) és dolgozz pontosan a terv szerint, fázisonként.

Kontextus: Next.js 14 + TS + Prisma 5.22/SQLite + lightweight-charts 4.x backteszter. Új, önálló
Pionex long futures grid motort építünk src/lib/pionex/ alá és egy új /pionex oldalt. A meglévő
src/lib/simulation, combo, strategies, optimizer, research és src/app/page.tsx kódját NE módosítsd
(page.tsx-ben csak egy rail-link). A BinanceCandle és BinanceFundingRate séma nem változik; futures
adat a meglévő kulcskonvencióval (pair 'ETHUSDTPERP' + symbol 'ETHUSDT' + market 'futures'; mark:
'ETHUSDTMARK'). fundingCache.ts-ben csak a storeFundingRates exportja változik. A TradingChart három
opcionális propot kap (lineSeries, markers, verticalMarkers), és a marker-effektet úgy kell
összefésülni, hogy combo nélkül ne törölje a markers propot (terv 5. fejezet). Minden meglévő teszt
zöld marad.

Fázis 0: terv 7. fejezet. Funding-lefedettség a terv 3.4.3 szerint, NEM a 95%-os becsléssel.

Fázis 1: ledger.ts (3.2), egy bot eseménymotorja ciklus nélkül, a 3.4 rögzített 1m sorrendjével:
nyitási rés szegmens → funding (perces vödör, floor(fundingTime/60s), pontosan egyszer) → függő
beavatkozások → gyertyán belüli szegmensek; minden lépés után likvidációs ellenőrzés mark árral.
A likvidáció esemény: a 3.4.1 szerinti T = P_liq − d küszöb átlépése megszakítja a szegmenst, utána
nincs töltés. A és B út (O→L→H→C és O→H→L→C) minden gyertyára. Fedezetellenőrzés csak a nyitott
pozícióra. Adatminőség 3.10. Korrekciós szorzó NINCS. Vitest: a terv 4.3 Fázis 1 kapuja, a 4.1
fixture-ökkel. Itt ÁLLJ MEG és mutasd meg a mért számokat.

Fázis 2: capital.ts, interventions.ts (3.6–3.8: E_next = E_start + ciklusbeli feltöltés +
reinvest% × profit; bot1ClosePrice végleges leállítás; rögzített beavatkozási sorrend), 4.3 Fázis 2
kapu.

Fázis 3: UI a terv 6. fejezete szerint, PionexRun String JSON mezőkkel, /api/pionex/* route-ok.

Stílus: kevés, egyértelmű kód; minden Pionex-modellezési feltételezést kommentben jelölj a terv
pontjára hivatkozva. Ha a terv és a kód között ellentmondást találsz, kérdezz, ne találj ki.
```
