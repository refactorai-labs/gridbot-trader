# ETH grid kombinációk — spot és futures összehasonlítása

2026-10-06. A „Tisztázd a szimulációs chartot” beszélgetés folytatása. **844 naplózott A/B backtest, 128 eltérő paraméterkombináció**, valamint két további spot-elszámolási keresztellenőrzés.

**Ajánlás:** túlélésre és kisebb vagyon-visszaesésre a két 150 USDT-s spot grid referencia, vagy az alább megadott 2× futures / I100 / E300 / fél méretű bot 2 alkalmasabb vizsgálati alap. Az eredeti két időablakban egyetlen tesztelt változat sem hozott pozitív nettó eredményt. Ez kockázatcsökkentési eredmény, nem bizonyított nyereséges stratégia.

## Mit jelent a három pénzösszeg?

- **Investment I:** a modellben a grid méretét szabályozza. Futures teljes gridnévérték = I × tőkeáttétel, botonként.
- **Extra margin E:** ugyanazon grid fedezete; önmagában nem növeli annak méretét.
- **Total capital:** az egész közös keret. I és E már ebben van; nem szabad még egyszer hozzáadni.

Két botra: `Total = I1 + E1 + I2 + E2 + szabad közös tartalék`. A bot 2 multiplier az I-t és az E-t is szorozza. Spotnál E helyett külön díjpuffert számoltunk, nincs kölcsön vagy marginfedezet. A gridre kiosztott cash és a szabad közös cash egyaránt része a vagyonnak.

## Konkrét kombinációk 1000 USDT teljes keretre

Az alábbi eredmények jelöltenként **10 ablak × A/B = 20 esetből** származnak: a két korábbi ablak, három különálló stresszablak és öt eltolt indulás. Mindegyik sorban minden elvárt bot elindult és aktív maradt. A hozam- és drawdown-szélsőértékek eltérő esetekből is származhatnak.

| Változat | Tőkeáttétel | I1 | E1 / spot díjpuffer | Bot 2 multiplier | Közös tartalék | Teljes gridnévérték | Nettó hozam tartománya | Legnagyobb drawdown |
|---|---|---|---|---|---|---|---|---|
| Spot, óvatos | spot | 150,00 | 1,50 | 1,00 | 697,00 | 300,00 | -6,36 … 2,06% | 10,52% |
| Spot, több kitettség | spot | 300,00 | 3,00 | 1,00 | 394,00 | 600,00 | -12,72 … 4,13% | 21,02% |
| Futures, óvatos | 2× | 100,00 | 300,00 | 0,50 | 400,00 | 300,00 | -5,13 … 2,33% | 11,04% |
| Futures, közepes | 3× | 100,00 | 300,00 | 1,00 | 200,00 | 600,00 | -7,42 … 3,92% | 20,77% |
| Futures, nagyobb kitettség | 5× | 100,00 | 300,00 | 1,00 | 200,00 | 1000,00 | -13,72 … 7,40% | 34,60% |

A tartalék a két bot kezdeti finanszírozása után értendő, feltöltés nélkül. A névérték a kiosztott teljes gridméret, nem azonnali teljes pozíció. A tényleges csúcspozíció mennyiségét ETH-ban a részletes adatok tartalmazzák. Az 5× sor kockázati összehasonlítás, nem az elsőként választott változat.

A spot eredmény önálló cash + ETH kutatási referenciából készült, **valódi Binance spot gyertyákból**, a futures stratégia grid-, másodikbot- és ciklusszabályai mellett. Nem a jelenlegi `/pionex` felület spot funkciója, és nem a Pionex Spot Grid pontos másolata.

## Az óvatos futures változat pontos mezőértékei

| Mező | Érték |
|---|---|
| Symbol | ETHUSDT |
| Band | offset |
| Lower / Upper | −15% / +1,2% |
| Grids / Mode | 60 / arithmetic |
| Investment I | 100 USDT |
| Extra margin E | 300 USDT |
| Leverage | 2× |
| Common capital | bekapcsolva, 1000 USDT |
| Maker / Taker / MMR | 0,02% / 0,05% / 0,5% |
| Funding override | üres — történelmi funding |
| Minimum margin check | bekapcsolva |
| Cycle / Take profit / Reinvest | bekapcsolva / I 1,2%-a / 20% |
| Top-up / Trigger / Amount | bekapcsolva / 5% / 50 USDT |
| Bot 2 / Offset / Multiplier | bekapcsolva / 1% / 0,5 |
| Fixed close | kikapcsolva |

Így bot 1: I100 + E300; bot 2: I50 + E150; közös tartalék: **400 USDT**. A két teljes grid névértéke 200 + 100 = **300 USDT**, a teljes induló saját tőke 0,3-szorosa. Egyetlen feltöltés sem történt a 20 ellenőrzött esetben. A közepes változatnál csak a leverage 3× és a bot 2 multiplier 1×; a nagyobb kitettségűnél leverage 5× és multiplier 1×. Mindkettőnél I100, E300 és 200 USDT közös tartalék.

A spot óvatos referencia gridkerete botonként 150 USDT, külön 1,50 USDT díjpufferrel, 697 USDT közös tartalékkal. Sáv és gridszám azonos, bot 2 multiplier 1×, ciklus TP 1,2% / reinvest20%. Nincs funding, top-up vagy likvidáció.

## Az eredeti két időablak — végső vagyon

| Változat | Jan. 1 → márc. 31, A | B | Jan. 16 → ápr. 17, A | B |
|---|---|---|---|---|
| Spot, óvatos | 960,08 | 962,49 | 960,98 | 960,92 |
| Spot, több kitettség | 920,15 | 924,98 | 921,97 | 921,83 |
| Futures, óvatos | 960,01 | 960,19 | 955,47 | 955,49 |
| Futures, közepes | 955,50 | 956,80 | 929,04 | 929,12 |
| Futures, nagyobb kitettség | 917,77 | 902,98 | 881,73 | 881,87 |

A záródátum UTC éjfélt jelent és kizárt: például a március 31-i nap már nincs benne. A végső vagyon tartalmazza a kivett profitot, a szabad pénzt és a nyitott pozíció aktuális értékét; nem kényszerű piaci zárás utáni cash.

Kontroll: 1000 USDT-ből a spot ETH buy-and-hold vételi és végső eladási díjjal **681,26 / 706,85 USDT** lett volna a két ablakban. A készpénzkontroll 1000 USDT. A grid kisebb veszteségének egy része a kisebb ETH-kitettségből és a későbbi második indulásból ered; nem szabad teljesen befektetett buy-and-holdhoz képest kizárólag gridelőnynek tulajdonítani.

## Csak a leverage változik — I150 / E200 / total1000

| Leverage | Két teljes grid névértéke | Legrosszabb nettó hozam | Legnagyobb drawdown | Mindkét bot aktív minden esetben? |
|---|---|---|---|---|
| 2× | 600,00 | -7,10% | 20,77% | igen |
| 3× | 900,00 | -10,64% | 31,14% | igen |
| 5× | 1500,00 | -17,74% | 51,86% | igen |
| 15× | 4500,00 | -99,70% | 99,70% | nem |

## Azonos kitettség — a címke önmagában nem magyarázza a kockázatot

A négy kontrollban botonként 450 USDT névérték, 350 USDT induló fedezet, total1000 és 1,80 USDT TP-küszöb volt.

| Leverage | I | E | TP az I %-ában | Legrosszabb nettó hozam | Legnagyobb drawdown |
|---|---|---|---|---|---|
| 2× | 225,00 | 125,00 | 0,80 | -10,64% | 31,14% |
| 3× | 150,00 | 200,00 | 1,20 | -10,64% | 31,14% |
| 5× | 90,00 | 260,00 | 2,00 | -10,64% | 31,14% |
| 15× | 30,00 | 320,00 | 6,00 | -10,64% | 31,14% |

Mind a négy végső vagyon is azonos volt mind a négy kontrollban: **933,26 / 935,21 / 893,56 / 893,69 USDT**. Vételkihagyás és feltöltés nem történt. A fix MMR-t használó modellben a gridnévérték, a fedezet és az abszolút TP együtt írja le ezt az összevetést; nem általános kijelentés a Pionex minden leverage-beállításáról.

## A 15× megtartása nagyobb fedezettel

| E botonként | Teljes tőke | Legrosszabb nettó hozam | Legnagyobb drawdown | Minimum algebrai liq távolság |
|---|---|---|---|---|
| 500,00 | 1600 | -36,41% | 98,24% | 0,05% |
| 900,00 | 2400 | -24,27% | 65,56% | 8,80% |
| 1200,00 | 3000 | -19,42% | 52,47% | 32,68% |
| 1600,00 | 3800 | -15,33% | 41,44% | 64,51% |
| 2200,00 | 5000 | -11,65% | 31,50% | 106,45% |

E2200 mellett a minimum távolság 100% feletti: a vizsgált pozíciókhoz nem adódott pozitív likvidációs ár. Ez nem spot, mert a funding és futures elszámolás megmarad. A 15× / I150 / E2200 / total5000 mind a további 16 esetben is aktív maradt, de a legrosszabb nettó eredmény ott −13,02%. A több készpénz önmagában csökkenti a százalékos veszteséget; az USDT-ben mért esés ettől még nagy lehet.

## További mezők érzékenysége

A következő sorok a két korábbi ablak négy esetének szélsőértékei; az óvatos alap itt 2× / I100 / E300 / total1000, teljes méretű bot 2. Egy változót módosítottunk egyszerre.

| Változtatás | Legrosszabb nettó hozam | Legnagyobb drawdown |
|---|---|---|
| Alap, teljes bot 2 | -4,73% | 13,85% |
| Bot 2 multiplier0,5 | -4,45% | 11,04% |
| Bot 2 kikapcsolva | -4,50% | 8,23% |
| Sáv −20% / +5% | -5,24% | 12,03% |
| 30 grid | -4,70% | 13,83% |
| 90 grid | -4,80% | 13,91% |
| Bot 2 offset5% | -4,72% | 13,86% |
| Bot 2 offset10% | -4,45% | 13,70% |
| Ciklus kikapcsolva | -4,73% | 13,85% |
| TP3% | -4,73% | 13,85% |
| Reinvest0% | -4,73% | 13,85% |
| Reinvest50% | -4,73% | 13,85% |
| Top-up kikapcsolva | -4,73% | 13,85% |

A szélesebb sáv ezen az adaton néha csökkentette a drawdownt, de nem javított következetesen a nettó eredményen; a külön stresszablakokkal együtt az óvatos wide legrosszabb hozama −5,43%, drawdownja 12,05%. Emiatt a −15%/+1,2% sáv maradt az ajánlott ellenőrzési alap. A 30/90 grid csak a két eredeti ablakon lett variálva; a többablakos ajánlás 60 gridre szól.

Az 5/10/15%-os top-up triggereknél és 50/100 USDT összegeknél a három előszűrt jelölt egyikének sem kellett feltöltés az eredeti ablakokban. Emiatt ezek az inputok itt nem javítottak az eredményen. A profitciklust megtartom: a külön ellenőrzésekben a kikapcsolás a 2× alap legrosszabb hozamát −5,22%-ról −7,92%-ra rontotta. A reinvesthez nem mutatkozott következetes javulás, ezért 20% marad.

## Különálló stresszablakok — utólagos újrahangolás nélkül

| Jelölt | Ablak | A/B nettó hozam | Legnagyobb drawdown | Állapot |
|---|---|---|---|---|
| Spot, óvatos | terra2022 | -2,29 … -2,26% | 5,82% | aktív mindkét bot |
| Spot, óvatos | ftx2022 | -2,34 … -2,31% | 5,69% | aktív mindkét bot |
| Spot, óvatos | drop2025 | -0,91 … -0,68% | 7,57% | aktív mindkét bot |
| Spot, több kitettség | terra2022 | -4,58 … -4,52% | 11,64% | aktív mindkét bot |
| Spot, több kitettség | ftx2022 | -4,69 … -4,62% | 11,38% | aktív mindkét bot |
| Spot, több kitettség | drop2025 | -1,82 … -1,36% | 15,00% | aktív mindkét bot |
| Futures, óvatos | terra2022 | -2,96 … -2,95% | 6,87% | aktív mindkét bot |
| Futures, óvatos | ftx2022 | -2,08 … -2,05% | 5,63% | aktív mindkét bot |
| Futures, óvatos | drop2025 | -0,05 … -0,01% | 8,01% | aktív mindkét bot |
| Futures, közepes | terra2022 | -1,90 … -1,86% | 10,89% | aktív mindkét bot |
| Futures, közepes | ftx2022 | -1,26 … -1,22% | 9,22% | aktív mindkét bot |
| Futures, közepes | drop2025 | 1,63 … 2,03% | 15,43% | aktív mindkét bot |
| Futures, nagyobb kitettség | terra2022 | -3,11 … -3,04% | 18,08% | aktív mindkét bot |
| Futures, nagyobb kitettség | ftx2022 | -1,07 … -0,91% | 13,95% | aktív mindkét bot |
| Futures, nagyobb kitettség | drop2025 | -0,82 … 2,60% | 25,99% | aktív mindkét bot |

A stresszablakok: 2022-05-04→05-20 (Terra), 2022-11-06→11-24 (FTX), 2025-01-04→02-10. Az öt eltolt indulás: 2026-01-05,01-10,01-20,01-25,02-01, közös 2026-03-31 zárással. Az átfedő 2026-ablakok nem független minták. A stresszablakok szándékosan ismert esések; nem élő belépési jelzések.

## Részletes pénzügyi bontás az ajánlott jelöltekre

Pozitív funding = fizetett; negatív = kapott. Gridprofit a párosított gridügyletek díj utáni mutatója, és nem adható hozzá újra a végső vagyonhoz. A realized érték a futures átlagáras, spotnál készletlot alapján számított bruttó realizált eredmény; a két oszlop önmagában nem közvetlenül azonos számviteli mutató.

| Jelölt | Ablak | Út | Vagyon | Gridprofit | Realized bruttó | Unrealized | Díj | Funding | Szabad tartalék | Ciklus | Max. DD USDT | Csúcspozíció ETH |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Spot, óvatos | jan01 | A | 960,08 | 17,49 | 24,58 | -57,24 | 7,26 | 0,00 | 697,00 | 1 | 82,65 | 0,12 |
| Spot, óvatos | jan01 | B | 962,49 | 18,74 | 26,25 | -56,04 | 7,72 | 0,00 | 697,00 | 1 | 81,46 | 0,12 |
| Spot, óvatos | jan16 | A | 960,98 | 8,18 | 11,58 | -47,06 | 3,54 | 0,00 | 697,00 | 0 | 105,08 | 0,11 |
| Spot, óvatos | jan16 | B | 960,92 | 8,12 | 11,48 | -47,06 | 3,50 | 0,00 | 697,00 | 0 | 105,18 | 0,11 |
| Spot, több kitettség | jan01 | A | 920,15 | 34,97 | 49,16 | -114,49 | 14,52 | 0,00 | 394,00 | 1 | 165,30 | 0,24 |
| Spot, több kitettség | jan01 | B | 924,98 | 37,48 | 52,50 | -112,09 | 15,44 | 0,00 | 394,00 | 1 | 162,92 | 0,24 |
| Spot, több kitettség | jan16 | A | 921,97 | 16,37 | 23,16 | -94,12 | 7,07 | 0,00 | 394,00 | 0 | 210,17 | 0,22 |
| Spot, több kitettség | jan16 | B | 921,83 | 16,24 | 22,95 | -94,12 | 7,00 | 0,00 | 394,00 | 0 | 210,36 | 0,22 |
| Futures, óvatos | jan01 | A | 960,01 | 21,37 | 4,02 | -41,93 | 2,99 | -0,91 | 400,00 | 2 | 86,77 | 0,12 |
| Futures, óvatos | jan01 | B | 960,19 | 21,55 | 4,71 | -42,43 | 3,00 | -0,91 | 400,00 | 2 | 86,82 | 0,12 |
| Futures, óvatos | jan16 | A | 955,47 | 9,93 | -7,44 | -36,32 | 1,44 | -0,67 | 400,00 | 0 | 110,46 | 0,10 |
| Futures, óvatos | jan16 | B | 955,49 | 9,95 | -6,93 | -36,82 | 1,44 | -0,67 | 400,00 | 0 | 110,46 | 0,10 |
| Futures, közepes | jan01 | A | 955,50 | 57,52 | 23,81 | -62,54 | 7,63 | -1,87 | 200,00 | 3 | 150,74 | 0,25 |
| Futures, közepes | jan01 | B | 956,80 | 58,96 | 25,81 | -63,06 | 7,81 | -1,87 | 200,00 | 3 | 150,59 | 0,25 |
| Futures, közepes | jan16 | A | 929,04 | 21,83 | -15,67 | -53,72 | 3,03 | -1,46 | 200,00 | 0 | 207,81 | 0,22 |
| Futures, közepes | jan16 | B | 929,12 | 21,91 | -14,74 | -54,56 | 3,03 | -1,46 | 200,00 | 0 | 207,81 | 0,22 |
| Futures, nagyobb kitettség | jan01 | A | 917,77 | 92,75 | 34,50 | -107,42 | 12,42 | -3,11 | 200,00 | 5 | 255,42 | 0,41 |
| Futures, nagyobb kitettség | jan01 | B | 902,98 | 86,67 | 29,04 | -117,50 | 11,65 | -3,08 | 200,00 | 6 | 263,95 | 0,40 |
| Futures, nagyobb kitettség | jan16 | A | 881,73 | 36,38 | -26,12 | -89,53 | 5,05 | -2,43 | 200,00 | 0 | 346,36 | 0,36 |
| Futures, nagyobb kitettség | jan16 | B | 881,87 | 36,52 | -24,56 | -90,94 | 5,06 | -2,43 | 200,00 | 0 | 346,34 | 0,36 |

## Adat és ellenőrzés

| Ablak | Futures last1m | Mark1m | Funding | Teljes? |
|---|---|---|---|---|
| jan01 | 128160 | 128160 | 267 | igen |
| jan16 | 131040 | 131040 | 273 | igen |
| terra2022 | 23040 | 23040 | 48 | igen |
| ftx2022 | 25920 | 25920 | 54 | igen |
| drop2025 | 53280 | 53280 | 111 | igen |
| start2026-01-05 | 122400 | 122400 | 255 | igen |
| start2026-01-10 | 115200 | 115200 | 240 | igen |
| start2026-01-20 | 100800 | 100800 | 210 | igen |
| start2026-01-25 | 93600 | 93600 | 195 | igen |
| start2026-02-01 | 83520 | 83520 | 174 | igen |


A fundinghoz minden ablakot korábban Binance API-val egyeztetett, teljesnek mentett jelentés fed le; a cache spacing és az egyező határú jelentések settlement-darabszáma is ellenőrizve. A spot archívumok minden havi SHA256 ellenőrzőösszege egyezett a Binance mellékelt checksumával; minden futtatott spotablak perces lefedettsége teljes.

Az eredeti négy végső vagyon pontosan reprodukálva. Meglévő motortesztek: **71/71**. TypeScript-ellenőrzés: sikeres. Spot kézi példák: készpénzkorlát, díj mindkét oldalon, inventory és ciklus elszámolás. Az unborrowed cash elszámolás két további ellenőrzésben az azonos spotárat és díjat használó, funding nélküli 1× ledger algebrai megfelelőjével is egyezett; A különbség 0, B 4,32×10⁻¹² USDT. Ettől a tényleges spot referencia továbbra is külön cash modell, nem 1× futures átnevezése.

A legnagyobb tőkekönyvelési eltérés az összes naplózott futásban **1.2e-09 USDT**. A mentett alkalmazásfutások száma 24 maradt; új PionexRun sor nem készült. Alkalmazáskód és DB nem módosult.

## A modell gyakorlati határai

Binance-adatokkal modellezzük a Pionex jellegű szabályokat, nem Pionex-végrehajtásból számolunk. A/B a perces OHLC két feltételezett sorrendje, nem bizonyított kockázati korlát. Futuresben fix 0,5% MMR és a meglévő közelítő margin check szerepel. Spread, slippage, részleges teljesülés, exchange lot-kerekítés és minimum order nincs modellezve. A kis gridösszegek ezért a backtester mezőiben használható kutatási inputok; az élő Pionex minimális befektetését a választott sávval és gridszámmal a létrehozási panelen kell ellenőrizni. A spot díjat 0,05%-nak feltételeztük mindkét oldalon, a jelenlegi standard díj alapján.

A spot liq távolsága nem értelmezhető; cash és ETH értékvesztése továbbra is okozhat drawdownt. A riport 10 ablaka nem bizonyít jövőbeli nyereséget. A nyitott végső ETH/futures pozíciók piaci eladásának további költsége nincs levonva a mark-to-market vagyonból; a buy-and-hold kontroll végső eladási díját külön levontuk.

## Újrafuttatás és fájlok

A futtató: `scripts/research/pionex-combinations.ts`, fázisok: baseline, sweep, controls, sensitivity, validation, spot. Naplózott eredményt nem futtat újra ugyanazon azonosítóval. A havi spotarchívumokat a `scripts/research/fetch-pionex-spot.py` tölti `/private/tmp/pionex-spot-research` alá. Az adatbázishoz csak a SQLite csak olvasásos hozzáférését használja. A DB aktuális gyertyaadatai a `metadata.json` sorozathash-eivel ellenőrizhetők.

- `results.jsonl`: minden konfiguráció, ablak, A/B út és pénzügyi mutató.
- `metadata.json`: adathash, funding-lefedő mentett jelentések, ellenőrzések.
- `spot-manifest.json`: eredeti Binance URL-ek és SHA256 checksumok.
- `benchmarks.jsonl`: spot buy-and-hold és cash kontroll.

Elsődleges külső források: [Pionex investment és margin](https://www.pionex.com/blog/whats-the-difference-for-me-add-investment-as-compare-to-me-adding-margin-to-the-bot/), [spot díj ügyletenként](https://www.pionex.com/blog/pionex-fee-trx-grid-is-0-05-buy-0-05-sell-or-0-05-fee-buy-sell/), [minimális befektetés](https://www.pionex.com/blog/the-minimum-investment-required-to-start-on-pionex/), [Binance public data](https://github.com/binance/binance-public-data).

## Teljes első futures sweep — a két eredeti ablak

| Leverage | I | E | Legrosszabb hozam | Max DD% | Max DD USDT | Mindkét bot aktív? | Max. kihagyott vétel | Max. top-up |
|---|---|---|---|---|---|---|---|---|
| 2 | 50 | 50 | -2,37% | 6,93% | 69,27 | igen | 0 | 0,00 |
| 2 | 50 | 100 | -2,37% | 6,93% | 69,27 | igen | 0 | 0,00 |
| 2 | 50 | 200 | -2,37% | 6,93% | 69,27 | igen | 0 | 0,00 |
| 2 | 50 | 300 | -2,37% | 6,93% | 69,27 | igen | 0 | 0,00 |
| 2 | 100 | 50 | -4,73% | 13,85% | 138,54 | igen | 0 | 0,00 |
| 2 | 100 | 100 | -4,73% | 13,85% | 138,54 | igen | 0 | 0,00 |
| 2 | 100 | 200 | -4,73% | 13,85% | 138,54 | igen | 0 | 0,00 |
| 2 | 100 | 300 | -4,73% | 13,85% | 138,54 | igen | 0 | 0,00 |
| 2 | 150 | 50 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 2 | 150 | 100 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 2 | 150 | 200 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 2 | 150 | 300 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 3 | 50 | 50 | -3,55% | 10,39% | 103,91 | igen | 0 | 0,00 |
| 3 | 50 | 100 | -3,55% | 10,39% | 103,91 | igen | 0 | 0,00 |
| 3 | 50 | 200 | -3,55% | 10,39% | 103,91 | igen | 0 | 0,00 |
| 3 | 50 | 300 | -3,55% | 10,39% | 103,91 | igen | 0 | 0,00 |
| 3 | 100 | 50 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 3 | 100 | 100 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 3 | 100 | 200 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 3 | 100 | 300 | -7,10% | 20,77% | 207,81 | igen | 0 | 0,00 |
| 3 | 150 | 50 | -10,64% | 31,14% | 311,72 | igen | 0 | 0,00 |
| 3 | 150 | 100 | -10,64% | 31,14% | 311,72 | igen | 0 | 0,00 |
| 3 | 150 | 200 | -10,64% | 31,14% | 311,72 | igen | 0 | 0,00 |
| 3 | 150 | 300 | -10,64% | 31,14% | 311,72 | igen | 0 | 0,00 |
| 5 | 50 | 50 | -5,91% | 17,31% | 173,18 | igen | 0 | 50,00 |
| 5 | 50 | 100 | -5,91% | 17,31% | 173,18 | igen | 0 | 0,00 |
| 5 | 50 | 200 | -5,91% | 17,31% | 173,18 | igen | 0 | 0,00 |
| 5 | 50 | 300 | -5,91% | 17,31% | 173,18 | igen | 0 | 0,00 |
| 5 | 100 | 50 | -11,83% | 34,60% | 346,36 | igen | 0 | 150,00 |
| 5 | 100 | 100 | -11,83% | 34,60% | 346,36 | igen | 0 | 50,00 |
| 5 | 100 | 200 | -11,83% | 34,60% | 346,36 | igen | 0 | 0,00 |
| 5 | 100 | 300 | -11,83% | 34,60% | 346,36 | igen | 0 | 0,00 |
| 5 | 150 | 50 | -17,76% | 51,89% | 519,73 | igen | 5 | 200,00 |
| 5 | 150 | 100 | -17,74% | 51,86% | 519,53 | igen | 0 | 100,00 |
| 5 | 150 | 200 | -17,74% | 51,86% | 519,53 | igen | 0 | 0,00 |
| 5 | 150 | 300 | -17,74% | 51,86% | 519,53 | igen | 0 | 0,00 |
| 15 | 50 | 50 | -22,51% | 52,42% | 525,05 | nem | 101 | 400,00 |
| 15 | 50 | 100 | -22,33% | 52,29% | 523,78 | nem | 0 | 300,00 |
| 15 | 50 | 200 | -19,42% | 52,47% | 525,57 | igen | 0 | 100,00 |
| 15 | 50 | 300 | -19,42% | 52,47% | 525,57 | igen | 0 | 0,00 |
| 15 | 100 | 50 | -45,21% | 83,18% | 834,57 | nem | 278 | 650,00 |
| 15 | 100 | 100 | -99,80% | 99,80% | 1001,22 | nem | 101 | 600,00 |
| 15 | 100 | 200 | -99,80% | 99,80% | 1001,22 | nem | 0 | 400,00 |
| 15 | 100 | 300 | -99,80% | 99,80% | 1001,22 | nem | 0 | 200,00 |
| 15 | 150 | 50 | -97,37% | 97,45% | 1006,67 | nem | 370 | 600,00 |
| 15 | 150 | 100 | -84,70% | 84,78% | 852,03 | nem | 111 | 450,00 |
| 15 | 150 | 200 | -99,70% | 99,70% | 1002,03 | nem | 0 | 300,00 |
| 15 | 150 | 300 | -99,70% | 99,70% | 1002,03 | nem | 0 | 100,00 |
