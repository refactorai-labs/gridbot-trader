import { describe, expect, it } from 'vitest';
import type { OHLC } from '../lib/types';
import type {
  ClassicFill, ClassicGridInput, ClassicGridResult, ClassicSideInput, EntrySkippedDetails,
} from '../lib/simulation/classicGridTypes';
import {
  runClassicGrid, newLedger, ledgerOpen, ledgerClose, ledgerEquity,
  type ClassicGridHooks, type ClassicPlacement, type ClassicProbe,
} from '../lib/simulation/classicGridCore';

// ---------- helpers ----------

const T0 = Date.UTC(2026, 0, 1) / 1000;
const S = 300;

// Path: close ≥ open → open, low, high, close; else open, high, low, close.
function cdl(i: number, open: number, high: number, low: number, close: number): OHLC {
  return { timestamp: T0 + i * S, open, high, low, close, volume: 1 };
}
const series = (rows: [number, number, number, number][]) => rows.map((r, i) => cdl(i, ...r));

function side(lower: number, upper: number, levels: number, orderSize: number, totalCapital: number,
  gridType: 'arithmetic' | 'geometric' = 'arithmetic'): ClassicSideInput {
  return { lowerBound: lower, upperBound: upper, gridLevels: levels, gridType, orderSize, totalCapital, profitMode: 'next_level' };
}

function run(candles: OHLC[], cfg: { long?: ClassicSideInput; short?: ClassicSideInput; fee?: number }, hooks?: ClassicGridHooks) {
  const input: ClassicGridInput = { candles, feeRate: cfg.fee ?? 0, long: cfg.long ?? null, short: cfg.short ?? null };
  return runClassicGrid(input, hooks);
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random walk with wicks and frequent small gaps between close and next open.
function randomWalk(n: number, start: number, vol: number, seed: number): OHLC[] {
  const rnd = mulberry32(seed);
  const out: OHLC[] = [];
  let open = start;
  for (let i = 0; i < n; i++) {
    const close = open * (1 + (rnd() - 0.5) * 2 * vol);
    const high = Math.max(open, close) * (1 + rnd() * vol);
    const low = Math.min(open, close) * (1 - rnd() * vol);
    out.push(cdl(i, open, high, low, close));
    open = close * (1 + (rnd() - 0.5) * vol);
  }
  return out;
}

const sideFills = (r: ClassicGridResult, s: 'long' | 'short') => r.fills.filter(f => f.side === s);
const skipEvents = (r: ClassicGridResult) =>
  r.events.filter(e => e.eventType === 'entry_skipped').map(e => e.details as unknown as EntrySkippedDetails);

// Replays fills and checks slot ownership and quantity conservation.
function checkSlots(r: ClassicGridResult) {
  const open = new Map<string, { qty: number; positionId: string; entrySeq: number; cycle: number }>();
  const cycles = new Map<string, number>();
  for (const f of r.fills) {
    const key = `${f.side}-${f.slotIndex}`;
    if (f.role === 'entry' || f.role === 'initial') {
      expect(open.has(key)).toBe(false);                  // ≤ 1 position per slot
      const cycle = cycles.get(key) ?? 0;
      expect(f.positionId).toBe(`${key}-${cycle}`);
      expect(f.orderType).toBe(f.side === 'long' ? 'buy' : 'sell');   // no reverse positions
      expect(f.pairedFillSeq).toBeNull();
      expect(f.pnl).toBeNull();
      cycles.set(key, cycle + 1);
      open.set(key, { qty: f.quantity, positionId: f.positionId, entrySeq: f.fillSeq, cycle });
    } else {
      const pos = open.get(key)!;
      expect(pos).toBeDefined();
      expect(f.positionId).toBe(pos.positionId);
      expect(f.pairedFillSeq).toBe(pos.entrySeq);
      expect(f.orderType).toBe(f.side === 'long' ? 'sell' : 'buy');
      expect(f.quantity).toBeCloseTo(pos.qty, 12);         // exits carry the full remaining quantity
      open.delete(key);
    }
  }
  return open;
}

// ---------- tests ----------

describe('classic grid core — ledger (Contract A)', () => {
  it('short worked example: 1 @ 100, cover @ 110 → 990', () => {
    const l = newLedger(1000);
    const { position } = ledgerOpen(l, 'short', 100, 1, 0);
    expect(l.cash).toBe(900);
    expect(ledgerEquity(l, 'short', 110)).toBe(990);
    const { realized } = ledgerClose(l, position!, 1, 110, 0);
    expect(realized).toBe(-10);
    expect(l.cash).toBe(990);
    expect(l.openBasis).toBe(0);
    expect(l.openPositions).toBe(0);
  });

  it('partial close of a short keeps the invariant', () => {
    const l = newLedger(1000);
    const pos = ledgerOpen(l, 'short', 100, 2, 0).position!;
    expect(l.cash).toBe(800);
    ledgerClose(l, pos, 0.5, 90, 0);                       // realized (100−90)·0.5 = 5
    expect(l.cash).toBe(855);                              // 800 + 50 + 5
    expect(pos.quantity).toBe(1.5);
    expect(pos.basis).toBe(150);
    expect(l.realizedGross).toBe(5);
    // equity at 90 = 855 + 150 + (100−90)·1.5 = 1020 = 1000 + 5 + 15
    expect(ledgerEquity(l, 'short', 90)).toBe(1020);
    ledgerClose(l, pos, 1.5, 120, 0);                      // realized −30
    expect(l.cash).toBe(975);
    expect(l.realizedGross).toBe(-25);
    expect(pos.quantity).toBe(0);
  });

  it('partial close of a long with fees', () => {
    const l = newLedger(1000);
    const pos = ledgerOpen(l, 'long', 100, 2, 0.001).position!;
    expect(l.cash).toBeCloseTo(1000 - 200 - 0.2, 12);
    const leg = ledgerClose(l, pos, 1, 110, 0.001);
    expect(leg.realized).toBeCloseTo(10, 12);
    expect(leg.fee).toBeCloseTo(0.11, 12);
    expect(l.cash).toBeCloseTo(799.8 + 110 - 0.11, 12);
    expect(l.fees).toBeCloseTo(0.31, 12);
    // invariant: cash + basis + unrealized = capital + realized − fees + unrealized
    expect(ledgerEquity(l, 'long', 110)).toBeCloseTo(1000 + 10 - 0.31 + 10, 9);
  });

  it('negative settlement: covering a short above 2× entry lowers cash', () => {
    const l = newLedger(100);
    const pos = ledgerOpen(l, 'short', 100, 1, 0).position!;
    expect(l.cash).toBe(0);
    ledgerClose(l, pos, 1, 250, 0);                        // credit 100 − 150 = −50
    expect(l.cash).toBe(-50);
    expect(l.realizedGross).toBe(-150);
  });

  it('entry requires cash ≥ notional + fee and leaves the ledger untouched otherwise', () => {
    const l = newLedger(100);
    const r = ledgerOpen(l, 'long', 100, 1, 0.01);
    expect(r.position).toBeNull();
    expect(r.shortfall).toBeCloseTo(1, 12);
    expect(l.cash).toBe(100);
    expect(ledgerOpen(l, 'long', 100, 1, 0).position).not.toBeNull();   // exactly funded
    expect(l.cash).toBe(0);
  });
});

describe('classic grid core — direction and startup inventory', () => {
  // Lines 90, 95, 100, 105, 110 → 4 slots; start at 100 (exactly on line 2).
  const candles = series([[100, 101, 99.5, 101], [101, 108, 101, 108], [108, 112, 108, 112]]);
  const cfg = { long: side(90, 110, 5, 100, 1000), short: side(90, 110, 5, 100, 1000) };

  it('rising price: long gains, short loses, no reverse positions (hand-computed)', () => {
    const r = run(candles, cfg);
    checkSlots(r);
    // Long: initial slots 2,3 bought 1 @ 100; exits 105 (+5) and 110 (+10).
    expect(r.long!.realizedGross).toBeCloseTo(15, 9);
    expect(r.long!.finalEquity).toBeCloseTo(1015, 9);
    expect(r.long!.openPositions).toBe(0);
    expect(r.long!.pendingOrders).toBe(4);
    // Short: initial 1 @ 100 in slots 0,1; entries 100/105 @ 105 and 100/110 @ 110; marked at 112.
    const shortUnreal = -12 - 12 - 7 * 100 / 105 - 2 * 100 / 110;
    expect(r.short!.unrealized).toBeCloseTo(shortUnreal, 9);
    expect(r.short!.finalEquity).toBeCloseTo(1000 + shortUnreal, 9);
    expect(r.short!.cash).toBeCloseTo(600, 9);
    expect(r.short!.realizedGross).toBe(0);
    expect(r.totalPnl).toBeCloseTo(15 + shortUnreal, 9);
  });

  it('exact-boundary start: line equal to the open is bought/sold at market', () => {
    const r = run(candles, cfg);
    const initial = r.fills.filter(f => f.role === 'initial');
    expect(initial.map(f => [f.side, f.slotIndex, f.level, f.levelPrice, f.fillPrice])).toEqual([
      ['long', 2, 2, 100, 100], ['long', 3, 3, 100, 100],
      ['short', 0, 1, 100, 100], ['short', 1, 2, 100, 100],
    ]);
  });

  it('grid above price: long buys every slot at market, short places limit sells', () => {
    const placed: ClassicPlacement[] = [];
    const r = run(series([[100, 100, 100, 100]]),
      { long: side(110, 130, 5, 100, 1000), short: side(110, 130, 5, 100, 1000) },
      { onPlace: p => placed.push(p) });
    expect(sideFills(r, 'long').map(f => [f.role, f.slotIndex, f.level, f.fillPrice, f.quantity]))
      .toEqual([0, 1, 2, 3].map(k => ['initial', k, k, 100, 1]));
    expect(placed.filter(p => p.side === 'long').map(p => [p.kind, p.limit])).toEqual(
      [['exit', 115], ['exit', 120], ['exit', 125], ['exit', 130]]);
    expect(sideFills(r, 'short')).toHaveLength(0);
    expect(placed.filter(p => p.side === 'short').map(p => [p.kind, p.limit])).toEqual(
      [['entry', 115], ['entry', 120], ['entry', 125], ['entry', 130]]);
    expect(r.long!.cash).toBe(600);
  });

  it('grid below price: short sells every slot at market, long places limit buys', () => {
    const placed: ClassicPlacement[] = [];
    const r = run(series([[100, 100, 100, 100]]),
      { long: side(70, 90, 5, 100, 1000), short: side(70, 90, 5, 100, 1000) },
      { onPlace: p => placed.push(p) });
    expect(sideFills(r, 'short').map(f => [f.role, f.orderType, f.slotIndex, f.level, f.fillPrice, f.quantity]))
      .toEqual([0, 1, 2, 3].map(k => ['initial', 'sell', k, k + 1, 100, 1]));
    expect(placed.filter(p => p.side === 'short').map(p => [p.kind, p.limit])).toEqual(
      [['exit', 70], ['exit', 75], ['exit', 80], ['exit', 85]]);
    expect(sideFills(r, 'long')).toHaveLength(0);
    expect(placed.filter(p => p.side === 'long').map(p => [p.kind, p.limit])).toEqual(
      [['entry', 70], ['entry', 75], ['entry', 80], ['entry', 85]]);
  });
});

describe('classic grid core — slots, invariant and placement', () => {
  it('slot ownership and quantity conservation over repeat cycles (arithmetic and geometric)', () => {
    const candles = randomWalk(3000, 100, 0.004, 7);
    for (const type of ['arithmetic', 'geometric'] as const) {
      const r = run(candles, { long: side(80, 120, 41, 50, 2000, type), short: side(80, 120, 41, 50, 2000, type) });
      const open = checkSlots(r);
      expect(r.roundTrips).toBeGreaterThan(100);
      expect(r.fills.some(f => f.positionId.endsWith('-5'))).toBe(true);   // a slot cycled ≥ 6 times
      expect(r.skippedEntries).toBe(0);                     // exactly funded: 40 slots × 50 = 2000
      expect(open.size).toBe(r.long!.openPositions + r.short!.openPositions);
      expect(r.fills.map(f => f.fillSeq)).toEqual(r.fills.map((_, i) => i));
    }
  });

  it('ledger invariant holds at every fill and path point for both sides; no entry placed marketable', () => {
    const candles = randomWalk(2000, 100, 0.01, 11);
    let probes = 0;
    let placements = 0;
    const hooks: ClassicGridHooks = {
      onPoint(p: ClassicProbe) {
        probes++;
        let combined = 0;
        for (const s of [p.long, p.short]) {
          if (!s) continue;
          const isLong = s === p.long;
          const basis = s.positions.reduce((a, x) => a + x.basis, 0);
          const unreal = s.positions.reduce((a, x) => a + (isLong ? p.price - x.entryPrice : x.entryPrice - p.price) * x.quantity, 0);
          for (const x of s.positions) expect(x.basis).toBeCloseTo(x.entryPrice * x.quantity, 9);
          expect(s.cash + basis + unreal).toBeCloseTo(s.equity, 7);
          expect(s.totalCapital + s.realizedGross - s.fees + unreal).toBeCloseTo(s.equity, 7);
          combined += s.equity;
        }
        expect(p.equity).toBeCloseTo(combined, 7);
      },
      onPlace(pl) {
        placements++;
        // Long entry buys below / exit sells above; short mirror: never marketable when placed.
        const below = (pl.side === 'long') === (pl.kind === 'entry');
        if (below) expect(pl.limit).toBeLessThan(pl.price);
        else expect(pl.limit).toBeGreaterThan(pl.price);
      },
    };
    // Underfunded (14 slots × 50 > 500) so starved entries occur too.
    const r = run(candles, { long: side(85, 115, 15, 50, 500), short: side(85, 115, 15, 50, 500), fee: 0.001 }, hooks);
    expect(probes).toBeGreaterThan(8000);
    expect(placements).toBeGreaterThan(200);
    expect(r.skippedEntries).toBeGreaterThan(0);
    expect(r.long!.finalEquity).toBeCloseTo(500 + r.long!.realizedGross - r.long!.fees + r.long!.unrealized, 7);
  });

  it('fees are charged exactly once per leg', () => {
    // Lines 100, 105, 110; start 107: limit buys at 100 and 105.
    const r = run(series([[107, 111, 104, 108]]), { long: side(100, 110, 3, 100, 1000), fee: 0.001 });
    const [entry, exit] = r.fills;
    expect(entry.fees).toBeCloseTo(100 * 0.001, 12);
    expect(exit.fees).toBeCloseTo(110 * (100 / 105) * 0.001, 12);
    expect(r.totalFees).toBeCloseTo(entry.fees + exit.fees, 12);
    expect(exit.pnl).toBeCloseTo(5 * 100 / 105 - exit.fees, 12);
    expect(r.long!.finalEquity).toBeCloseTo(1000 + 5 * 100 / 105 - entry.fees - exit.fees, 9);
    expect(r.winCount).toBe(1);
  });
});

describe('classic grid core — insufficient capital', () => {
  it('underfunded entry stays pending: one streak, exact skippedCandles, filled when cash returns', () => {
    // Lines 100, 150, 200. Start 149: slot 0 limit buy 100; slot 1 market buy 100/149 @ 149 → cash 90.
    const r = run(series([
      [149, 149, 149, 149],   // 0
      [149, 149, 99, 99],     // 1: crosses 100 → starved (shortfall 10)
      [99, 99, 98, 98],       // 2: open 99 marketable → starved
      [98, 200, 98, 200],     // 3: open 98 starved; exit slot 1 @ 200 → cash 224.23
      [200, 200, 199, 199],   // 4: no attempt → streak ends
      [199, 199, 99, 99],     // 5: slot 1 re-entry @ 150, then slot 0 @ 100 fills
    ]), { long: side(100, 200, 3, 100, 190) });
    const skips = skipEvents(r);
    expect(skips).toEqual([{ side: 'long', slotIndex: 0, firstCandleIdx: 1, lastCandleIdx: 3, skippedCandles: 3, shortfall: expect.closeTo(10, 9) }]);
    expect(r.events[0].candleIdx).toBe(1);
    expect(r.events[0].timestamp).toBe(T0 + S);
    expect(r.events[0].longMultiplier).toBeNull();
    expect(r.skippedEntries).toBe(3);
    const slot0 = r.fills.filter(f => f.slotIndex === 0);
    expect(slot0.map(f => [f.role, f.candleIdx, f.fillPrice])).toEqual([['entry', 5, 100]]);
    expect(r.fills.map(f => [f.role, f.slotIndex, f.candleIdx, f.fillPrice])).toEqual([
      ['initial', 1, 0, 149], ['exit', 1, 3, 200], ['entry', 1, 5, 150], ['entry', 0, 5, 100],
    ]);
    expect(r.long!.cash).toBeCloseTo(190 - 100 + 200 * 100 / 149 - 200, 9);
  });

  it('starved initial market entry: one-candle streak, slot waits, re-armed as limit at a later eligible open', () => {
    const placed: ClassicPlacement[] = [];
    const r = run(series([
      [149, 149, 149, 149],   // 0: slot 1 (line 150 ≥ 149) needs 100, cash 50 → starved
      [149, 155, 149, 155],   // 1: open 149 not above 150 → still waiting
      [155, 156, 154, 155],   // 2: open 155 > 150 → limit entry at 150
    ]), { long: side(100, 200, 3, 100, 50) }, { onPlace: p => placed.push(p) });
    expect(r.fills).toHaveLength(0);
    expect(skipEvents(r)).toEqual([{ side: 'long', slotIndex: 1, firstCandleIdx: 0, lastCandleIdx: 0, skippedCandles: 1, shortfall: 50 }]);
    expect(r.skippedEntries).toBe(1);
    expect(placed.map(p => [p.slotIndex, p.kind, p.limit, p.price, p.candleIdx])).toEqual([
      [0, 'entry', 100, 149, 0], [1, 'entry', 150, 155, 2],
    ]);
    expect(r.snapshots.map(s => s.longOrdersActive)).toEqual([1, 1, 2]);
    expect(r.long!.pendingOrders).toBe(2);
  });
});

describe('classic grid core — exhaustion', () => {
  it('max drawdown sees the pre-fee equity at the path price before a forced close', () => {
    // Long [100,400] ×2, size 500, cap 1000; short [90,100] ×2, size 100, cap 102; 1% fee.
    // One candle 100/250/100/200 (path open, low, high, close): the short is exhausted at
    // the high. Peak before the forced close and its fee is 1696; after it 1693.50; the
    // final equity at the close is 1443.50 → DD 252.50 (250.00 when the peak is missed).
    const r = run(series([[100, 250, 100, 200]]),
      { fee: 0.01, long: side(100, 400, 2, 500, 1000), short: side(90, 100, 2, 100, 102) });
    expect(r.short!.exhausted).toBe(true);
    expect(r.maxDrawdown).toBeCloseTo(252.5, 6);
  });

  it('closes the side at the path price, keeps the deficit and stops it', () => {
    // Short lines 100, 110: start 110 → market sell 1 @ 110 (all cash), buyback at 100.
    // Long lines 200, 210: market buy 100/110 @ 110, exit 210.
    const r = run(series([
      [110, 110, 110, 110],
      [300, 300, 300, 300],   // gap: short equity 2·110 − 300 = −80 ≤ 0 at the open
      [90, 90, 90, 90],
    ]), { short: side(100, 110, 2, 110, 110), long: side(200, 210, 2, 100, 1000) });
    const ex = r.fills.filter(f => f.role === 'exhaust');
    expect(ex.map(f => [f.side, f.orderType, f.slotIndex, f.level, f.levelPrice, f.fillPrice, f.candleIdx])).toEqual([
      ['short', 'buy', 0, 1, 300, 300, 1],
    ]);
    expect(ex[0].pnl).toBeCloseTo(-190, 9);
    expect(r.short!.exhausted).toBe(true);
    expect(r.short!.finalEquity).toBeCloseTo(-80, 9);         // deficit kept
    expect(r.short!.pendingOrders).toBe(0);
    expect(r.short!.lossCount).toBe(1);
    expect(r.fills.filter(f => f.side === 'short' && f.candleIdx === 2)).toHaveLength(0);
    const ev = r.events.filter(e => e.eventType === 'capital_exhausted');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      candleIdx: 1, timestamp: T0 + S, longMultiplier: 1, shortMultiplier: 0,
      details: {
        side: 'short', equity: expect.closeTo(-80, 9), positionsClosed: 1,
        state: { long: { trend: 'neutral', riskPhase: 'none', risk: 1 }, short: { trend: 'neutral', riskPhase: 'none', risk: 0 } },
      },
    });
    // Long gap-fills its exit at the open after the short is stopped.
    expect(sideFills(r, 'long').map(f => [f.role, f.fillPrice, f.candleIdx])).toEqual([
      ['initial', 110, 0], ['exit', 300, 1], ['entry', 90, 2],
    ]);
    expect(r.finalEquity).toBeCloseTo(r.long!.finalEquity - 80, 9);
  });
});

describe('classic grid core — execution order', () => {
  it('same-candle round-trip: entry in one segment, exit in a later one', () => {
    // Lines 100, 105, 110; start 107. Path 107 → 104 → 111 → 108.
    const placed: ClassicPlacement[] = [];
    const r = run(series([[107, 111, 104, 108]]), { long: side(100, 110, 3, 100, 1000) }, { onPlace: p => placed.push(p) });
    expect(r.fills.map(f => [f.role, f.slotIndex, f.fillPrice, f.candleIdx])).toEqual([['entry', 1, 105, 0], ['exit', 1, 110, 0]]);
    expect(r.fills[1].level).toBe(2);
    expect(placed.at(-1)).toMatchObject({ slotIndex: 1, kind: 'entry', limit: 105, price: 110 });
    expect(r.roundTrips).toBe(1);
  });

  it('multiple levels crossed in one segment fill in path order', () => {
    // Lines 100..110 step 2; start 111 → limit buys 100..108. Path 111 → 111 → 99 → 100.
    const r = run(series([[111, 111, 99, 100]]), { long: side(100, 110, 6, 100, 1000) });
    expect(r.fills.map(f => f.fillPrice)).toEqual([108, 106, 104, 102, 100]);
    expect(r.fills.map(f => f.slotIndex)).toEqual([4, 3, 2, 1, 0]);
  });

  it('exits precede entries at an equal price', () => {
    // Short lines 100, 110: start 110 → market sell, buyback at 100. Long lines 100, 120: limit buy at 100.
    const r = run(series([[110, 110, 95, 96]]), { long: side(100, 120, 2, 100, 1000), short: side(100, 110, 2, 100, 1000) });
    expect(r.fills.map(f => [f.fillSeq, f.side, f.role, f.fillPrice])).toEqual([
      [0, 'short', 'initial', 110], [1, 'short', 'exit', 100], [2, 'long', 'entry', 100],
    ]);
    // Same at the open point: a gap to 95 makes both marketable; both fill at 95, exit first.
    const g = run(series([[110, 110, 105, 106], [95, 95, 95, 95]]),
      { long: side(100, 120, 2, 100, 1000), short: side(100, 110, 2, 100, 1000) });
    expect(g.fills.map(f => [f.fillSeq, f.side, f.role, f.levelPrice, f.fillPrice, f.candleIdx])).toEqual([
      [0, 'short', 'initial', 110, 110, 0], [1, 'short', 'exit', 100, 95, 1], [2, 'long', 'entry', 100, 95, 1],
    ]);
  });

  it('open-point gap fill at the open price; its exit is eligible in the first segment', () => {
    // Lines 100, 105, 110; start 107. Candle 1 gaps to 103 then runs 103 → 111 → 102 → 102.5.
    const r = run(series([[107, 108, 106, 107.5], [103, 111, 102, 102.5]]), { long: side(100, 110, 3, 100, 1000) });
    expect(r.fills.map(f => [f.role, f.slotIndex, f.levelPrice, f.fillPrice, f.candleIdx])).toEqual([
      ['entry', 1, 105, 103, 1],     // gap fill at the open, not at the limit
      ['exit', 1, 110, 110, 1],      // first segment 103 → 111
      ['entry', 1, 105, 105, 1],     // re-armed at 105, eligible from the next segment (111 → 102)
    ]);
    expect(r.fills[0].quantity).toBeCloseTo(100 / 103, 12);
    expect(r.fills[1].pnl).toBeCloseTo(7 * 100 / 103, 9);
  });

  it('short mirror: rising gap fills the short entry at the open', () => {
    // Short lines 100, 105, 110; start 103 → limit sells at 105 (slot 0) and 110 (slot 1).
    const r = run(series([[103, 104, 102, 103.5], [108, 108, 99, 99.5]]), { short: side(100, 110, 3, 100, 1000) });
    // Candle 1 opens 108: sell at 105 marketable → fills at 108, buyback at 100 hit on 108 → 99.
    expect(r.fills.map(f => [f.role, f.slotIndex, f.levelPrice, f.fillPrice, f.candleIdx])).toEqual([
      ['entry', 0, 105, 108, 1],
      ['exit', 0, 100, 100, 1],
    ]);
    expect(r.short!.realizedGross).toBeCloseTo(8 * 100 / 108, 9);
  });
});

describe('classic grid core — metrics', () => {
  it('hand-computed equity, drawdown and snapshots', () => {
    // Lines 100, 110; start 105 → limit buy at 100.
    const r = run(series([
      [105, 105, 100, 102],   // buy 1 @ 100 → equity 1002 at close (peak)
      [102, 102, 90, 95],     // low 90: equity 990 → drawdown 12
      [95, 110, 95, 110],     // exit @ 110 → 1010
    ]), { long: side(100, 110, 2, 100, 1000) });
    expect(r.maxDrawdown).toBeCloseTo(12, 9);
    expect(r.maxDrawdownPct).toBeCloseTo(12 / 1002 * 100, 9);
    expect(r.finalEquity).toBeCloseTo(1010, 9);
    expect(r.totalPnl).toBeCloseTo(10, 9);
    expect(r.totalPnlPct).toBeCloseTo(1, 9);
    expect(r.snapshots[1]).toMatchObject({
      candleIdx: 1, timestamp: T0 + S, price: 95, equity: 995, realizedPnl: 0, unrealizedPnl: -5,
      longEquity: 995, longUnrealizedPnl: -5, shortEquity: 0, shortRealizedPnl: 0,
      longOrdersActive: 1, shortOrdersActive: 0, longFillCount: 1, shortFillCount: 0,
    });
    expect(r.snapshots[2]).toMatchObject({ equity: 1010, realizedPnl: 10, unrealizedPnl: 0, longFillCount: 2 });
  });

  it('drawdown sees the equity at a fill price before the fill fee', () => {
    // Fee 1 %: buy 1 @ 100 (fee 1); exit @ 110: equity 1009 just before the exit fee 1.1;
    // re-buy @ 100 (fee 1) → 1006.9. Drawdown 1009 − 1006.9 = 2.1.
    const r = run(series([
      [105, 105, 100, 102],
      [102, 110, 100, 100],
    ]), { long: side(100, 110, 2, 100, 1000), fee: 0.01 });
    expect(r.fills.map(f => [f.role, f.fillPrice])).toEqual([['entry', 100], ['exit', 110], ['entry', 100]]);
    expect(r.finalEquity).toBeCloseTo(1006.9, 9);
    expect(r.maxDrawdown).toBeCloseTo(2.1, 9);
    expect(r.maxDrawdownPct).toBeCloseTo(2.1 / 1009 * 100, 9);
  });

  it('snapshot realized is net of fees and equity = start + realized + unrealized', () => {
    const r = run(randomWalk(500, 100, 0.01, 3), { long: side(90, 110, 11, 50, 600), short: side(90, 110, 11, 50, 600), fee: 0.001 });
    for (const s of r.snapshots) {
      expect(s.equity).toBeCloseTo(1200 + s.realizedPnl + s.unrealizedPnl, 7);
      expect(s.longEquity).toBeCloseTo(600 + s.longRealizedPnl + s.longUnrealizedPnl, 7);
      expect(s.shortEquity).toBeCloseTo(600 + s.shortRealizedPnl + s.shortUnrealizedPnl, 7);
    }
    const last = r.snapshots.at(-1)!;
    expect(last.candleIdx).toBe(499);
    expect(last.realizedPnl).toBeCloseTo(r.realizedGross - r.totalFees, 9);
    expect(last.equity).toBeCloseTo(r.finalEquity, 7);
  });

  it('closed profit cannot hide a larger open loss', () => {
    // Lines 100, 105, 110; start 104 → market buy 100/104, exit 110; limit buy at 100.
    const r = run(series([[104, 110, 104, 110], [110, 110, 60, 60]]), { long: side(100, 110, 3, 100, 1000) });
    const realized = 6 * 100 / 104;
    const unreal = (60 - 105) * 100 / 105 + (60 - 100);
    expect(r.realizedGross).toBeCloseTo(realized, 9);
    expect(r.unrealized).toBeCloseTo(unreal, 9);
    expect(r.totalPnl).toBeCloseTo(realized + unreal, 9);
    expect(r.totalPnl).toBeLessThan(0);
    expect(r.maxDrawdown).toBeCloseTo(-unreal, 9);           // peak 1000 + realized at 110
  });

  it('snapshot cadence: every floor(n/2000) candles plus the last', () => {
    const r = run(randomWalk(4002, 100, 0.002, 5), { long: side(90, 110, 5, 10, 1000) });
    expect(r.snapshots).toHaveLength(2001 + 1);            // 0, 2, …, 4000, then the last (4001)
    expect(r.snapshots[1].candleIdx).toBe(2);
    expect(r.snapshots.at(-1)!.candleIdx).toBe(4001);
    expect(r.snapshots.at(-2)!.candleIdx).toBe(4000);
  });
});

describe('classic grid core — causality, independence, validation', () => {
  it('changing later candles leaves earlier fills unchanged', () => {
    const a = randomWalk(400, 100, 0.01, 21);
    const b = [...a.slice(0, 200), ...randomWalk(200, 130, 0.02, 99).map((c, i) => ({ ...c, timestamp: a[200 + i].timestamp }))];
    const cfg = { long: side(85, 115, 13, 50, 400), short: side(85, 115, 13, 50, 400), fee: 0.001 };
    const ra = run(a, cfg);
    const rb = run(b, cfg);
    const early = (r: ClassicGridResult) => r.fills.filter(f => f.candleIdx < 200);
    expect(early(ra).length).toBeGreaterThan(20);
    expect(early(rb)).toEqual(early(ra));
    expect(rb.snapshots.filter(s => s.candleIdx < 200)).toEqual(ra.snapshots.filter(s => s.candleIdx < 200));
  });

  it('is deterministic (the core has no timeframe input: results depend on 5m candles only)', () => {
    const c = randomWalk(500, 100, 0.01, 4);
    const cfg = { long: side(90, 110, 9, 50, 300), short: side(90, 110, 9, 50, 300), fee: 0.0008 };
    expect(run(c, cfg)).toEqual(run(c, cfg));
  });

  it('long-only + short-only = dual', () => {
    // Wide walk, underfunded sides, and a short that can exhaust.
    const c = randomWalk(3000, 100, 0.015, 13);
    const long = side(70, 130, 25, 40, 500);
    const short = side(70, 130, 25, 40, 300);
    const dual = run(c, { long, short, fee: 0.001 });
    const lo = run(c, { long, fee: 0.001 });
    const so = run(c, { short, fee: 0.001 });
    const strip = (fs: ClassicFill[]) => fs.map(f => ({
      ...f, fillSeq: 0, pairedFillSeq: f.pairedFillSeq === null ? null : fs.findIndex(g => g.fillSeq === f.pairedFillSeq),
    }));
    expect(strip(sideFills(dual, 'long'))).toEqual(strip(lo.fills));
    expect(strip(sideFills(dual, 'short'))).toEqual(strip(so.fills));
    expect(dual.long).toEqual(lo.long);
    expect(dual.short).toEqual(so.short);
    expect(skipEvents(dual).filter(d => d.side === 'long')).toEqual(skipEvents(lo));
    expect(skipEvents(dual).filter(d => d.side === 'short')).toEqual(skipEvents(so));
    expect(dual.skippedEntries).toBeGreaterThan(0);
    expect(dual.finalEquity).toBeCloseTo(lo.finalEquity + so.finalEquity, 7);
    dual.snapshots.forEach((s, i) => {
      expect(s.longEquity).toBeCloseTo(lo.snapshots[i].longEquity, 9);
      expect(s.shortEquity).toBeCloseTo(so.snapshots[i].shortEquity, 9);
    });
  });

  it('rejects invalid input with clear errors', () => {
    const c = series([[100, 100, 100, 100]]);
    const ok = side(90, 110, 5, 10, 100);
    expect(() => run(c, {})).toThrow(/At least one grid side/);
    expect(() => run([], { long: ok })).toThrow(/No candles/);
    expect(() => run(c, { long: ok, fee: -0.1 })).toThrow(/Fee rate/);
    expect(() => run(c, { long: ok, fee: NaN })).toThrow(/Fee rate/);
    expect(() => run(c, { long: { ...ok, profitMode: 'custom', customProfitDistance: 1 } }))
      .toThrow('Custom profit target is not available until checkpoint 2');
    expect(() => run(c, { long: side(110, 90, 5, 10, 100) })).toThrow(/0 < lower < upper/);
    expect(() => run(c, { short: side(0, 90, 5, 10, 100) })).toThrow(/0 < lower < upper/);
    expect(() => run(c, { long: side(90, 110, 1, 10, 100) })).toThrow(/between 2 and 2000/);
    expect(() => run(c, { long: side(90, 110, 2001, 10, 100) })).toThrow(/between 2 and 2000/);
    expect(() => run(c, { long: side(90, 110, 4.5, 10, 100) })).toThrow(/between 2 and 2000/);
    expect(() => run(c, { long: side(90, 110, 5, 0, 100) })).toThrow(/order size/);
    expect(() => run(c, { long: side(90, 110, 5, 10, Infinity) })).toThrow(/total capital/);
    expect(() => run(c, { long: side(1, 1.0000000001, 2000, 10, 100) })).toThrow(/strictly increasing/);
    expect(() => run([cdl(0, 100, 100, 0, 100)], { long: ok })).toThrow(/Invalid candle/);
  });
});

describe('classic grid core — performance', () => {
  it('2 × 2000 lines over one year of 5m candles in under 10 s', () => {
    const candles = randomWalk(105_120, 2000, 0.0015, 2026);
    const t = performance.now();
    const r = run(candles, {
      long: side(1000, 3000, 2000, 10, 25_000), short: side(1000, 3000, 2000, 10, 25_000), fee: 0.0008,
    });
    const elapsed = performance.now() - t;
    console.log(`classic grid perf: ${r.fills.length} fills, ${elapsed.toFixed(0)} ms`);
    expect(r.totalCandles).toBe(105_120);
    expect(r.fills.length).toBeGreaterThan(10_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);
});
