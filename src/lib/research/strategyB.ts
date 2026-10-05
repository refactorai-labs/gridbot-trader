// Strategy B — dual-grid partial-hedge mean reversion — plus its three
// baselines, all behind the same state machine so every run shares identical
// data, regime filter, anchoring, grids, and stops. Only the banking/hedging
// rule differs by mode:
//
//   'B'         — bank `partialFraction` of the favorable leg on a strong move,
//                 keep the rest as a hedge, unwind it on reversion.
//   'fullClose' — bank 100% of the favorable leg (no hedge remains).
//   'fullHold'  — bank nothing; the favorable leg rides until the unwind level.
//   'oneSided'  — plain long-only grid in the range (no short leg, no banking).
//
// Cycle lifecycle: idle → (regime says 'range', price near center) anchor +
// arm both grids + hard stops → active. A strong move to `bankAt` of the
// half-range triggers the mode's banking rule (favorable leg's entries are
// cancelled; the losing leg keeps recovering through its grid TPs inside the
// invalidation zone). Reversion to `unwindAt` closes everything and returns
// to idle for a fresh anchor. A hard stop on either leg closes the other leg
// too and starts a cooldown. Persistent non-range regime mid-cycle de-risks
// the whole cycle the same way.

import { OHLC } from '../types';
import { SignalContext, StrategyHooks } from './fillSim';
import { LegSide } from './types';
import { Regime, RegimeConfig, RegimeFilter, RegimeState, DEFAULT_REGIME } from './regime';
import { AnchorConfig, RangeZones, buildRange, DEFAULT_ANCHOR } from './rangeAnchor';

export type StrategyMode = 'B' | 'fullClose' | 'fullHold' | 'oneSided';

export interface StrategyBConfig {
  mode: StrategyMode;
  totalCapital: number;     // split across legs (oneSided puts it all on long)
  regime: RegimeConfig;
  anchor: AnchorConfig;
  bankAt: number;           // fraction of half-range from center that triggers banking
  partialFraction: number;  // mode 'B': fraction of the favorable leg closed at bank
  unwindAt: number;         // fraction of half-range; reversion to here ends the cycle
  deriskAfterBars: number;  // consecutive non-range 30m bars mid-cycle before de-risk
  cooldownBars: number;     // 30m bars to wait after a stop or de-risk
  // 'hard' market-closes everything on de-risk (taker + slippage on the full
  // inventory). 'soft' cancels entries but keeps TPs and stops — the cycle
  // winds down passively and ends when both legs are flat.
  deriskStyle: 'hard' | 'soft';
  initialFraction: number;  // scale of the TP-side inventory opened at arm (0–1)
}

export const DEFAULT_STRATEGY_B: StrategyBConfig = {
  mode: 'B',
  totalCapital: 10_000,
  regime: DEFAULT_REGIME,
  anchor: DEFAULT_ANCHOR,
  bankAt: 0.8,
  partialFraction: 0.6,
  unwindAt: 0.25,
  deriskAfterBars: 8,
  cooldownBars: 16,
  deriskStyle: 'hard',
  initialFraction: 1,
};

export type StrategyPhase = 'idle' | 'active' | 'hedgedUp' | 'hedgedDown' | 'windingDown' | 'cooldown';

export interface RegimePoint {
  timeSec: number;
  regime: Regime;
  er: number;
  phase: StrategyPhase;
}

export interface CycleSpan {
  startSec: number;
  endSec: number | null; // null = still open at end of data
  zones: RangeZones;
}

export interface StrategyDiagnostics {
  regimeSeries: RegimePoint[];
  anchors: RangeZones[];
  cycles: CycleSpan[];
  cyclesStarted: number;
  banks: number;
  unwinds: number;
  derisks: number;
  stopsHandled: number;
}

export interface StrategyInstance extends StrategyHooks {
  diagnostics: StrategyDiagnostics;
}

export function createStrategy(cfg: StrategyBConfig): StrategyInstance {
  const filter = new RegimeFilter(cfg.regime);
  const diagnostics: StrategyDiagnostics = {
    regimeSeries: [],
    anchors: [],
    cycles: [],
    cyclesStarted: 0,
    banks: 0,
    unwinds: 0,
    derisks: 0,
    stopsHandled: 0,
  };

  let phase: StrategyPhase = 'idle';
  let zones: RangeZones | null = null;
  let cooldownLeft = 0;
  let nonRangeStreak = 0;
  let lastStopCounts: Record<LegSide, number> = { long: 0, short: 0 };

  const dualLegs: LegSide[] = cfg.mode === 'oneSided' ? ['long'] : ['long', 'short'];
  const capitalPerLeg = cfg.totalCapital / dualLegs.length;

  function endCycle(ctx: SignalContext, closeBoth: boolean, reason: string, nextPhase: StrategyPhase): void {
    const open = diagnostics.cycles[diagnostics.cycles.length - 1];
    if (open && open.endSec === null) open.endSec = ctx.nowSec;
    for (const leg of dualLegs) {
      ctx.api.clearGrid(leg);
      ctx.api.setStop(leg, null);
      if (closeBoth && ctx.api.account.legQty(leg) > 0) {
        ctx.api.queueAction({ kind: 'closeAll', leg, reason });
      }
    }
    zones = null;
    phase = nextPhase;
  }

  function tryAnchor(ctx: SignalContext, rs: RegimeState): void {
    const z = buildRange(ctx.closed30m, rs.atr, ctx.nowSec, cfg.anchor);
    if (!z) return;
    zones = z;
    diagnostics.anchors.push(z);
    diagnostics.cycles.push({ startSec: ctx.nowSec, endSec: null, zones: z });
    diagnostics.cyclesStarted += 1;
    const qtyPerLevel = capitalPerLeg / cfg.anchor.gridLevels / z.center;

    for (const leg of dualLegs) {
      ctx.api.setGrid(leg, { levels: z.levels, qtyPerLevel, initialFraction: cfg.initialFraction });
      ctx.api.setStop(leg, leg === 'long' ? z.stopLong : z.stopShort);
    }
    nonRangeStreak = 0;
    phase = 'active';
  }

  function bank(ctx: SignalContext, direction: 'up' | 'down'): void {
    if (cfg.mode === 'oneSided') return;
    const favorable: LegSide = direction === 'up' ? 'long' : 'short';
    diagnostics.banks += 1;

    // The favorable leg stops adding; its remaining lots become the hedge.
    ctx.api.cancelEntries(favorable);
    if (cfg.mode === 'B') {
      ctx.api.queueAction({ kind: 'closeFraction', leg: favorable, fraction: cfg.partialFraction, reason: 'bankProfit' });
    } else if (cfg.mode === 'fullClose') {
      ctx.api.queueAction({ kind: 'closeAll', leg: favorable, reason: 'bankProfit' });
    }
    // 'fullHold': close nothing — the leg rides to the unwind.
    phase = direction === 'up' ? 'hedgedUp' : 'hedgedDown';
  }

  return {
    diagnostics,
    onSignal(ctx: SignalContext): void {
      const last = ctx.closed30m[ctx.closed30m.length - 1];
      const rs = filter.update(last);
      const price = last.close;
      const account = ctx.api.account;

      // Engine-side hard stops fired since the last signal? De-risk everything.
      for (const leg of dualLegs) {
        const count = account.legs[leg].stopCount;
        if (count > lastStopCounts[leg]) {
          lastStopCounts[leg] = count;
          if (phase !== 'idle' && phase !== 'cooldown') {
            diagnostics.stopsHandled += 1;
            endCycle(ctx, true, 'stopDerisk', 'cooldown');
            cooldownLeft = cfg.cooldownBars;
          }
        }
      }

      switch (phase) {
        case 'cooldown':
          cooldownLeft -= 1;
          if (cooldownLeft <= 0) phase = 'idle';
          break;

        case 'idle':
          if (rs.regime === 'range') tryAnchor(ctx, rs);
          break;

        case 'active': {
          if (!zones) { phase = 'idle'; break; }
          if (rs.regime !== 'range') {
            nonRangeStreak += 1;
            if (nonRangeStreak >= cfg.deriskAfterBars) {
              diagnostics.derisks += 1;
              if (cfg.deriskStyle === 'soft') {
                // Stop adding; let TPs and stops finish the cycle passively.
                for (const leg of dualLegs) ctx.api.cancelEntries(leg);
                phase = 'windingDown';
              } else {
                endCycle(ctx, true, 'derisk', 'cooldown');
                cooldownLeft = cfg.cooldownBars;
              }
              break;
            }
          } else {
            nonRangeStreak = 0;
          }

          if (cfg.mode === 'oneSided') {
            // Flat above the range with nothing left to do → re-anchor fresh.
            if (price > zones.upper && account.legQty('long') === 0) {
              endCycle(ctx, false, 'rangeExit', 'idle');
            }
            break;
          }

          if (price >= zones.center + cfg.bankAt * (zones.upper - zones.center)) bank(ctx, 'up');
          else if (price <= zones.center - cfg.bankAt * (zones.center - zones.lower)) bank(ctx, 'down');
          break;
        }

        case 'windingDown': {
          if (account.legQty('long') <= 1e-12 && account.legQty('short') <= 1e-12) {
            endCycle(ctx, false, 'windDownComplete', 'idle');
          }
          break;
        }

        case 'hedgedUp':
        case 'hedgedDown': {
          if (!zones) { phase = 'idle'; break; }
          const up = phase === 'hedgedUp';
          const unwindLevel = up
            ? zones.center + cfg.unwindAt * (zones.upper - zones.center)
            : zones.center - cfg.unwindAt * (zones.center - zones.lower);
          const reverted = up ? price <= unwindLevel : price >= unwindLevel;
          if (reverted) {
            diagnostics.unwinds += 1;
            endCycle(ctx, true, 'hedgeUnwind', 'idle');
          }
          break;
        }
      }

      diagnostics.regimeSeries.push({ timeSec: ctx.nowSec, regime: rs.regime, er: rs.er, phase });
    },
  };
}
