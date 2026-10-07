// Classic grid core v1 (plan v4, Contracts A and B) — pure, deterministic
// directional long/short grid simulation over 5m candles. No I/O and no
// module-level state; the engine wrapper loads candles and persists the result.
//
// Tiebreaks beyond the contract:
// - Segment fills: path order (price), then exits before entries, then long
//   before short, then slot index.
// - Open-point gap fills (all at the open price): exits before entries, then
//   long before short, then slot index.
// - A side is checked for exhaustion at path points and at its OWN fills
//   (before and after the fill), never at the other side's fills, so a side's
//   result does not depend on whether the other side is enabled.

import type { GridSide, OHLC, SnapshotData } from '../types';
import type {
  ClassicEvent, ClassicFill, ClassicGridInput, ClassicGridResult, ClassicSideInput,
  ClassicSideResult, EntrySkippedDetails, FillRole, SideSignalState,
} from './classicGridTypes';
import { getIntraCandlePath } from './orderMatcher';
import { generateGridLevels } from './gridGenerator';

const MAX_LEVELS = 2000;
// Absorbs float rounding so an exactly funded entry is not starved (quote units).
const CASH_TOLERANCE = 1e-9;

// ---------- Ledger (Contract A) ----------

export interface Ledger {
  cash: number;
  realizedGross: number;
  fees: number;
  openQuantity: number;   // Σ remaining quantity of open positions
  openBasis: number;      // Σ basis of open positions
  openPositions: number;
}

export interface LedgerPosition {
  side: GridSide;
  entryPrice: number;
  quantity: number;       // remaining
  fullQuantity: number;   // quantity at open (adaptive baseline)
  basis: number;          // entryPrice × quantity
  entryFees: number;
}

export function newLedger(totalCapital: number): Ledger {
  return { cash: totalCapital, realizedGross: 0, fees: 0, openQuantity: 0, openBasis: 0, openPositions: 0 };
}

// Entry of `quantity` at `price`: needs cash ≥ q·P + fee. Returns the position,
// or null with the shortfall when cash is insufficient (ledger untouched).
export function ledgerOpen(
  l: Ledger, side: GridSide, price: number, quantity: number, feeRate: number,
): { position: LedgerPosition | null; shortfall: number } {
  const notional = price * quantity;
  const fee = notional * feeRate;
  const required = notional + fee;
  if (l.cash - required < -CASH_TOLERANCE) return { position: null, shortfall: required - l.cash };
  l.cash -= required;
  l.fees += fee;
  l.openQuantity += quantity;
  l.openBasis += notional;
  l.openPositions++;
  return {
    position: { side, entryPrice: price, quantity, fullQuantity: quantity, basis: notional, entryFees: fee },
    shortfall: 0,
  };
}

// Exit/reduce of `quantity` (≤ remaining) at `price`. Never needs cash; the
// credit q·entry + realized − fee can be negative for a short.
export function ledgerClose(
  l: Ledger, pos: LedgerPosition, quantity: number, price: number, feeRate: number,
): { realized: number; fee: number } {
  const full = quantity >= pos.quantity;
  const q = full ? pos.quantity : quantity;
  const basisOut = full ? pos.basis : pos.entryPrice * q;
  const realized = (pos.side === 'long' ? price - pos.entryPrice : pos.entryPrice - price) * q;
  const fee = q * price * feeRate;
  l.cash += basisOut + realized - fee;
  l.realizedGross += realized;
  l.fees += fee;
  pos.quantity = full ? 0 : pos.quantity - q;
  pos.basis = full ? 0 : pos.basis - basisOut;
  l.openQuantity -= q;
  l.openBasis -= basisOut;
  if (full && --l.openPositions === 0) {
    l.openQuantity = 0;   // drop float residue once flat
    l.openBasis = 0;
  }
  return { realized, fee };
}

// Σ (value − basis): long q·M − basis; short (entry − M)·q = basis − q·M.
export function ledgerUnrealized(l: Ledger, side: GridSide, price: number): number {
  return side === 'long' ? l.openQuantity * price - l.openBasis : l.openBasis - l.openQuantity * price;
}

export function ledgerEquity(l: Ledger, side: GridSide, price: number): number {
  return l.cash + l.openBasis + ledgerUnrealized(l, side, price);
}

// ---------- Test probes (optional, zero-cost when absent) ----------

export interface ClassicProbeSide {
  totalCapital: number;
  cash: number;
  realizedGross: number;
  fees: number;
  equity: number;
  positions: LedgerPosition[];   // open positions (copies)
  pendingOrders: number;
}

export interface ClassicProbe {
  kind: 'fill' | 'point';
  candleIdx: number;
  price: number;
  equity: number;                // combined, as used for drawdown
  long: ClassicProbeSide | null;
  short: ClassicProbeSide | null;
}

export interface ClassicPlacement {
  side: GridSide;
  slotIndex: number;
  kind: 'entry' | 'exit';
  limit: number;
  price: number;                 // price at the placement point
  candleIdx: number;
}

export interface ClassicGridHooks {
  onPoint?(probe: ClassicProbe): void;
  onPlace?(placement: ClassicPlacement): void;
}

// ---------- Internal state ----------

interface Order {
  s: SideRun;
  slot: number;
  entry: boolean;
  line: number;
  price: number;
  active: boolean;
  streak: EntrySkippedDetails | null;
}

interface Position extends LedgerPosition {
  id: string;
  slot: number;
  entryFillSeq: number;
  realized: number;     // Σ realized legs
  legFees: number;      // entry fee + Σ closing fees
}

// Pending orders indexed by grid line plus an occupancy bitset, so a price range
// visits only occupied lines. Each book holds at most one order per line.
interface Book {
  orders: (Order | null)[];
  bits: Uint32Array;
}

interface SideRun {
  side: GridSide;
  long: boolean;
  cfg: ClassicSideInput;
  levels: number[];
  slots: number;
  ledger: Ledger;
  buys: Book;
  sells: Book;
  orderOf: (Order | null)[];      // pending order per slot
  position: (Position | null)[];  // open position per slot
  cycles: number[];               // positions opened per slot
  waiting: number[];              // sorted free slots awaiting an eligible 5m open
  pending: number;
  fills: number;
  roundTrips: number;
  winCount: number;
  lossCount: number;
  skipped: number;
  stopped: boolean;
}

function newBook(n: number): Book {
  return { orders: new Array<Order | null>(n).fill(null), bits: new Uint32Array((n + 31) >>> 5) };
}

// Appends the orders on lines lo..hi (inclusive) in ascending line order.
function collect(book: Book, lo: number, hi: number, out: Order[]): void {
  if (lo > hi) return;
  for (let w = lo >>> 5; w <= hi >>> 5; w++) {
    let word = book.bits[w];
    while (word !== 0) {
      const line = (w << 5) | (31 - Math.clz32(word & -word));
      word &= word - 1;
      if (line >= lo && line <= hi) out.push(book.orders[line]!);
    }
  }
}

// First index with arr[i] ≥ x (lower) / > x (upper).
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

const isPos = (x: number) => Number.isFinite(x) && x > 0;

function validateSide(name: GridSide, cfg: ClassicSideInput): number[] {
  if (cfg.profitMode === 'custom') throw new Error('Custom profit target is not available until checkpoint 2');
  if (cfg.profitMode !== 'next_level') throw new Error(`${name}: unknown profit mode`);
  if (!isPos(cfg.lowerBound) || !Number.isFinite(cfg.upperBound) || cfg.upperBound <= cfg.lowerBound) {
    throw new Error(`${name}: bounds must satisfy 0 < lower < upper`);
  }
  if (!Number.isInteger(cfg.gridLevels) || cfg.gridLevels < 2 || cfg.gridLevels > MAX_LEVELS) {
    throw new Error(`${name}: grid levels must be an integer between 2 and ${MAX_LEVELS}`);
  }
  if (!isPos(cfg.orderSize)) throw new Error(`${name}: order size must be a finite positive number`);
  if (!isPos(cfg.totalCapital)) throw new Error(`${name}: total capital must be a finite positive number`);
  const levels = generateGridLevels(cfg.lowerBound, cfg.upperBound, cfg.gridLevels, name, cfg.gridType)
    .map(l => l.price);
  for (let i = 1; i < levels.length; i++) {
    if (!(levels[i] > levels[i - 1])) throw new Error(`${name}: grid levels are not strictly increasing`);
  }
  return levels;
}

function validateCandles(candles: OHLC[]): void {
  if (!Array.isArray(candles) || candles.length === 0) throw new Error('No candles to simulate');
  for (const c of candles) {
    if (!isPos(c.open) || !isPos(c.high) || !isPos(c.low) || !isPos(c.close)) {
      throw new Error(`Invalid candle prices at timestamp ${c.timestamp}`);
    }
  }
}

// ---------- Simulation ----------

export function runClassicGrid(input: ClassicGridInput, hooks?: ClassicGridHooks): ClassicGridResult {
  const { candles, feeRate } = input;
  if (!input.long && !input.short) throw new Error('At least one grid side must be enabled');
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new Error('Fee rate must be a finite number ≥ 0');
  validateCandles(candles);

  const makeSide = (side: GridSide, cfg: ClassicSideInput | null): SideRun | null => {
    if (!cfg) return null;
    const levels = validateSide(side, cfg);
    const slots = levels.length - 1;
    return {
      side, long: side === 'long', cfg, levels, slots, ledger: newLedger(cfg.totalCapital),
      buys: newBook(levels.length), sells: newBook(levels.length),
      orderOf: new Array<Order | null>(slots).fill(null),
      position: new Array<Position | null>(slots).fill(null),
      cycles: new Array<number>(slots).fill(0),
      waiting: [], pending: 0, fills: 0, roundTrips: 0, winCount: 0, lossCount: 0, skipped: 0, stopped: false,
    };
  };
  const long = makeSide('long', input.long);
  const short = makeSide('short', input.short);
  const sides = [long, short].filter((s): s is SideRun => s !== null);
  const startingCapital = sides.reduce((a, s) => a + s.cfg.totalCapital, 0);

  const fills: ClassicFill[] = [];
  const events: ClassicEvent[] = [];
  const snapshots: SnapshotData[] = [];
  const cands: Order[] = [];
  let ci = 0;           // current 5m candle index
  let ts = 0;           // its open timestamp (seconds)
  let peak = startingCapital;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const entryLine = (s: SideRun, k: number) => (s.long ? k : k + 1);
  const exitLine = (s: SideRun, k: number) => (s.long ? k + 1 : k);
  const bookOf = (o: Order) => (o.entry === o.s.long ? o.s.buys : o.s.sells);  // long entries / short exits buy

  function place(s: SideRun, slot: number, entry: boolean, atPrice: number): void {
    const line = entry ? entryLine(s, slot) : exitLine(s, slot);
    const o: Order = { s, slot, entry, line, price: s.levels[line], active: true, streak: null };
    const book = bookOf(o);
    book.orders[line] = o;
    book.bits[line >>> 5] |= 1 << (line & 31);
    s.orderOf[slot] = o;
    s.pending++;
    hooks?.onPlace?.({ side: s.side, slotIndex: slot, kind: entry ? 'entry' : 'exit', limit: o.price, price: atPrice, candleIdx: ci });
  }

  function removeOrder(o: Order): void {
    const book = bookOf(o);
    book.orders[o.line] = null;
    book.bits[o.line >>> 5] &= ~(1 << (o.line & 31));
    o.s.orderOf[o.slot] = null;
    o.s.pending--;
    o.active = false;
    o.streak = null;    // finalizes any open skip streak
  }

  // Entry placement rule: place only when the entry line is strictly on the
  // eligible side of `price`; otherwise the slot waits for a later 5m open.
  function placeEntryOrWait(s: SideRun, slot: number, price: number): void {
    if (s.long ? s.levels[slot] < price : s.levels[slot + 1] > price) {
      place(s, slot, true, price);
    } else {
      s.waiting.splice(lowerBound(s.waiting, slot), 0, slot);
    }
  }

  function pushFill(
    s: SideRun, role: FillRole, buy: boolean, slot: number, positionId: string, level: number,
    levelPrice: number, price: number, quantity: number, fee: number, pnl: number | null, paired: number | null,
  ): number {
    const fillSeq = fills.length;
    fills.push({
      fillSeq, side: s.side, role, orderType: buy ? 'buy' : 'sell', slotIndex: slot, positionId, level, levelPrice,
      fillPrice: price, quantity, notional: price * quantity, fees: fee, pnl, pairedFillSeq: paired,
      candleIdx: ci, timestamp: ts,
    });
    s.fills++;
    return fillSeq;
  }

  // Opens slot's position at `price`; returns 0, or the shortfall when starved.
  function openAt(s: SideRun, slot: number, price: number, role: FillRole, level: number, levelPrice: number): number {
    const { position, shortfall } = ledgerOpen(s.ledger, s.side, price, s.cfg.orderSize / price, feeRate);
    if (!position) return shortfall;
    const id = `${s.side}-${slot}-${s.cycles[slot]++}`;
    const seq = pushFill(s, role, s.long, slot, id, level, levelPrice, price, position.quantity, position.entryFees, null, null);
    s.position[slot] = { ...position, id, slot, entryFillSeq: seq, realized: 0, legFees: position.entryFees };
    return 0;
  }

  // Closes the position's whole remaining quantity at `price`.
  function closeAt(s: SideRun, pos: Position, price: number, role: FillRole, level: number, levelPrice: number): void {
    const quantity = pos.quantity;
    const { realized, fee } = ledgerClose(s.ledger, pos, quantity, price, feeRate);
    pos.realized += realized;
    pos.legFees += fee;
    pushFill(s, role, !s.long, pos.slot, pos.id, level, levelPrice, price, quantity, fee, realized - fee, pos.entryFillSeq);
    if (pos.quantity === 0) {
      s.position[pos.slot] = null;
      s.roundTrips++;
      const net = pos.realized - pos.legFees;
      if (net > 0) s.winCount++;
      else if (net < 0) s.lossCount++;
    }
  }

  // Records a starved attempt in the holder's streak (one event per maximal run
  // of consecutive candles with a starved attempt; the details object is the
  // event's own and is updated in place until the run ends).
  function starve(s: SideRun, holder: { streak: EntrySkippedDetails | null }, slot: number, shortfall: number): void {
    const st = holder.streak;
    if (st && st.lastCandleIdx >= ci - 1) {
      if (st.lastCandleIdx < ci) {
        st.lastCandleIdx = ci;
        st.skippedCandles++;
        s.skipped++;
      }
      st.shortfall = shortfall;
      return;
    }
    const details: EntrySkippedDetails = {
      side: s.side, slotIndex: slot, firstCandleIdx: ci, lastCandleIdx: ci, skippedCandles: 1, shortfall,
    };
    holder.streak = details;
    s.skipped++;
    events.push({
      candleIdx: ci, timestamp: ts, eventType: 'entry_skipped',
      details: details as unknown as Record<string, unknown>, longMultiplier: null, shortMultiplier: null,
    });
  }

  const signalState = (s: SideRun | null): SideSignalState | null =>
    s ? { trend: 'neutral', riskPhase: 'none', risk: s.stopped ? 0 : 1 } : null;
  const multiplier = (s: SideRun | null): number | null => (s ? (s.stopped ? 0 : 1) : null);

  // Exhaustion: equity ≤ 0 → close everything at `price`, remove orders, stop the side.
  function exhaustIfBroke(s: SideRun, price: number): boolean {
    if (s.stopped || ledgerEquity(s.ledger, s.side, price) > 0) return false;
    let closed = 0;
    for (let k = 0; k < s.slots; k++) {
      const o = s.orderOf[k];
      if (o) removeOrder(o);
      const pos = s.position[k];
      if (pos) {
        closeAt(s, pos, price, 'exhaust', entryLine(s, k), price);
        closed++;
      }
    }
    s.waiting.length = 0;
    s.stopped = true;
    events.push({
      candleIdx: ci, timestamp: ts, eventType: 'capital_exhausted',
      details: {
        side: s.side, equity: ledgerEquity(s.ledger, s.side, price), positionsClosed: closed,
        state: { long: signalState(long), short: signalState(short) },
      },
      longMultiplier: multiplier(long), shortMultiplier: multiplier(short),
    });
    return true;
  }

  const probeSide = (s: SideRun | null, price: number): ClassicProbeSide | null => s && {
    totalCapital: s.cfg.totalCapital, cash: s.ledger.cash, realizedGross: s.ledger.realizedGross, fees: s.ledger.fees,
    equity: ledgerEquity(s.ledger, s.side, price),
    positions: s.position.filter((p): p is Position => p !== null).map(p => ({
      side: p.side, entryPrice: p.entryPrice, quantity: p.quantity, fullQuantity: p.fullQuantity,
      basis: p.basis, entryFees: p.entryFees,
    })),
    pendingOrders: s.pending,
  };

  // Drawdown from full combined equity at every fill and path point.
  function observe(kind: 'fill' | 'point', price: number): void {
    let equity = 0;
    for (const s of sides) equity += ledgerEquity(s.ledger, s.side, price);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (dd / peak * 100 > maxDrawdownPct) maxDrawdownPct = dd / peak * 100;
    hooks?.onPoint?.({ kind, candleIdx: ci, price, equity, long: probeSide(long, price), short: probeSide(short, price) });
  }

  function pathPoint(price: number): void {
    observe('point', price);   // equity at the path price before any forced close and its fee
    let exhausted = false;
    for (const s of sides) if (exhaustIfBroke(s, price)) exhausted = true;
    if (exhausted) observe('point', price);
  }

  function fillOrder(o: Order, price: number): void {
    const s = o.s;
    if (!o.active) return;
    observe('point', price);   // equity at the fill price before the fill and its fee
    if (!exhaustIfBroke(s, price)) {
      if (o.entry) {
        const shortfall = openAt(s, o.slot, price, 'entry', o.line, o.price);
        if (shortfall > 0) {
          starve(s, o, o.slot, shortfall);   // stays pending; no fill
          return;
        }
        removeOrder(o);
        place(s, o.slot, false, price);
      } else {
        removeOrder(o);
        closeAt(s, s.position[o.slot]!, price, 'exit', o.line, o.price);
        placeEntryOrWait(s, o.slot, price);
      }
      exhaustIfBroke(s, price);
    }
    observe('fill', price);
  }

  // Start (candle 0 open): limit entries where the entry line is eligible,
  // market entries (role initial) in slot order otherwise.
  function start(s: SideRun, open: number): void {
    for (let k = 0; k < s.slots && !s.stopped; k++) {
      if (s.long ? s.levels[k] < open : s.levels[k + 1] > open) {
        place(s, k, true, open);
        continue;
      }
      const shortfall = openAt(s, k, open, 'initial', entryLine(s, k), open);
      if (shortfall > 0) {
        starve(s, { streak: null }, k, shortfall);   // one-candle streak; slot waits
        s.waiting.push(k);
        continue;
      }
      place(s, k, false, open);
      exhaustIfBroke(s, open);
      observe('fill', open);
    }
  }

  const tiebreak = (a: Order, b: Order) =>
    (a.entry === b.entry ? 0 : a.entry ? 1 : -1) || (a.s.long === b.s.long ? 0 : a.s.long ? -1 : 1) || a.slot - b.slot;
  const downOrder = (a: Order, b: Order) => b.price - a.price || tiebreak(a, b);
  const upOrder = (a: Order, b: Order) => a.price - b.price || tiebreak(a, b);

  // Open point: gap-fill every marketable order at the open, then re-arm
  // waiting slots whose entry line is now eligible.
  function openPoint(open: number): void {
    cands.length = 0;
    for (const s of sides) {
      if (s.stopped) continue;
      collect(s.buys, lowerBound(s.levels, open), s.levels.length - 1, cands);
      collect(s.sells, 0, upperBound(s.levels, open) - 1, cands);
    }
    cands.sort(tiebreak);
    for (const o of cands) fillOrder(o, open);
    for (const s of sides) {
      const w = s.waiting;
      if (s.stopped || w.length === 0) continue;
      // Eligible waiting slots are a prefix (long, L_k < open) or suffix (short, L_{k+1} > open).
      let m = 0;
      if (s.long) while (m < w.length && s.levels[w[m]] < open) m++;
      else { m = w.length; while (m > 0 && s.levels[w[m - 1] + 1] > open) m--; }
      const ready = s.long ? w.splice(0, m) : w.splice(m);
      for (const k of ready) place(s, k, true, open);
    }
  }

  // Segment: orders eligible at its start fill at their limit when crossed.
  function segment(from: number, to: number): void {
    cands.length = 0;
    for (const s of sides) {
      if (s.stopped) continue;
      if (to < from) collect(s.buys, lowerBound(s.levels, to), lowerBound(s.levels, from) - 1, cands);
      else if (to > from) collect(s.sells, upperBound(s.levels, from), upperBound(s.levels, to) - 1, cands);
    }
    cands.sort(to < from ? downOrder : upOrder);
    for (const o of cands) fillOrder(o, o.price);
    pathPoint(to);
  }

  const sideMark = (s: SideRun | null, price: number) => s
    ? {
      realized: s.ledger.realizedGross - s.ledger.fees,
      unrealized: ledgerUnrealized(s.ledger, s.side, price),
      equity: ledgerEquity(s.ledger, s.side, price),
      pending: s.pending, fills: s.fills,
    }
    : { realized: 0, unrealized: 0, equity: 0, pending: 0, fills: 0 };

  const n = candles.length;
  const snapshotEvery = Math.max(1, Math.floor(n / 2000));
  for (ci = 0; ci < n; ci++) {
    const c = candles[ci];
    ts = c.timestamp;
    pathPoint(c.open);
    if (ci === 0) for (const s of sides) start(s, c.open);
    else openPoint(c.open);
    const path = getIntraCandlePath(c);
    for (let p = 0; p < path.length - 1; p++) segment(path[p], path[p + 1]);

    if (ci % snapshotEvery === 0 || ci === n - 1) {
      const l = sideMark(long, c.close);
      const sh = sideMark(short, c.close);
      snapshots.push({
        candleIdx: ci, timestamp: c.timestamp, price: c.close,
        equity: l.equity + sh.equity,
        realizedPnl: l.realized + sh.realized,
        unrealizedPnl: l.unrealized + sh.unrealized,
        longRealizedPnl: l.realized, shortRealizedPnl: sh.realized,
        longUnrealizedPnl: l.unrealized, shortUnrealizedPnl: sh.unrealized,
        longEquity: l.equity, shortEquity: sh.equity,
        longOrdersActive: l.pending, shortOrdersActive: sh.pending,
        longFillCount: l.fills, shortFillCount: sh.fills,
      });
    }
  }

  // End of data: open positions are marked at the final close, nothing is closed.
  const finalClose = candles[n - 1].close;
  const sideResult = (s: SideRun | null): ClassicSideResult | null => s && {
    totalCapital: s.cfg.totalCapital,
    cash: s.ledger.cash,
    finalEquity: ledgerEquity(s.ledger, s.side, finalClose),
    realizedGross: s.ledger.realizedGross,
    fees: s.ledger.fees,
    unrealized: ledgerUnrealized(s.ledger, s.side, finalClose),
    fills: s.fills,
    roundTrips: s.roundTrips,
    winCount: s.winCount,
    lossCount: s.lossCount,
    skippedEntries: s.skipped,
    exhausted: s.stopped,
    openPositions: s.ledger.openPositions,
    pendingOrders: s.pending,
  };
  const longResult = sideResult(long);
  const shortResult = sideResult(short);
  const results = [longResult, shortResult].filter((r): r is ClassicSideResult => r !== null);
  const sum = (f: (r: ClassicSideResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const finalEquity = sum(r => r.finalEquity);

  return {
    fills, snapshots, events,
    long: longResult, short: shortResult,
    startingCapital,
    finalEquity,
    totalPnl: finalEquity - startingCapital,
    totalPnlPct: (finalEquity - startingCapital) / startingCapital * 100,
    realizedGross: sum(r => r.realizedGross),
    totalFees: sum(r => r.fees),
    unrealized: sum(r => r.unrealized),
    roundTrips: sum(r => r.roundTrips),
    winCount: sum(r => r.winCount),
    lossCount: sum(r => r.lossCount),
    maxDrawdown,
    maxDrawdownPct,
    skippedEntries: sum(r => r.skippedEntries),
    totalCandles: n,
  };
}
