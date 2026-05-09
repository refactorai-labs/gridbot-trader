// Derive BotPhaseView + PnLView + SessionView from the existing ReplayData shape,
// so the ComboPane can be rendered against results produced by the combo supervisor.

import { BotPhase, GridSide, ComboMode } from '@/lib/types';
import { BotPhaseView, PnLView, AdaptiveEventView, ReopenLights } from './types';

const PHASE_EVENT_MAP: Record<string, BotPhase> = {
  breakout_entered: 'BREAKOUT',
  position_opened: 'RUNNING',
  sl_triggered: 'COOLDOWN',
  cooldown_entered: 'COOLDOWN',
  tier1_reopen: 'REOPENING',
  tier2_scale: 'REOPENING',
  tier3_scale: 'RUNNING',
  cycle_complete: 'IDLE',
  hibernation_entered: 'HIBERNATING',
  hibernation_exit: 'IDLE',
  retry_incremented: 'COOLDOWN',
};

const TIER_EVENT_MAP: Record<string, 0 | 1 | 2 | 3> = {
  tier1_reopen: 1,
  tier2_scale: 2,
  tier3_scale: 3,
  cycle_complete: 0,
  sl_triggered: 0,
};

export function deriveBotPhaseView(
  side: GridSide,
  events: AdaptiveEventView[],
  currentCandleIdx: number,
  retryCap: number = 2,
): BotPhaseView {
  const sideEvents = events
    .filter(e => e.candleIdx <= currentCandleIdx)
    .filter(e => {
      try {
        const d = JSON.parse(e.detailsJson) as { side?: string };
        return d.side === side;
      } catch { return false; }
    });

  let phase: BotPhase = 'IDLE';
  let currentTier: 0 | 1 | 2 | 3 = 0;
  let retryCount = 0;
  let lastEventType: string | undefined;
  let lastEventCandleIdx: number | undefined;

  for (const e of sideEvents) {
    if (e.eventType in PHASE_EVENT_MAP) phase = PHASE_EVENT_MAP[e.eventType];
    if (e.eventType in TIER_EVENT_MAP) currentTier = TIER_EVENT_MAP[e.eventType];
    if (e.eventType === 'retry_incremented') retryCount = Math.min(retryCap, retryCount + 1);
    if (e.eventType === 'cycle_complete' || e.eventType === 'tier3_scale') retryCount = 0;
    lastEventType = e.eventType;
    lastEventCandleIdx = e.candleIdx;
  }

  const latestDiagnostics = [...sideEvents].reverse().map(e => {
    try {
      const details = JSON.parse(e.detailsJson) as {
        reopenDiagnostics?: {
          atrRatioOk: boolean;
          atrDecliningOk: boolean;
          rsiCrossOk: boolean;
          avwapOk: boolean;
          avwapRequired?: boolean;
        };
      };
      return details.reopenDiagnostics;
    } catch {
      return undefined;
    }
  }).find(Boolean);

  const reopenLights: ReopenLights | undefined = phase === 'COOLDOWN' || phase === 'REOPENING'
    ? {
        cooldownElapsed: sideEvents.some(e => e.eventType === 'tier1_reopen' || e.eventType === 'retry_incremented'),
        regimeTrending: latestDiagnostics?.rsiCrossOk ?? false,
        atrCompressed: latestDiagnostics ? latestDiagnostics.atrRatioOk && latestDiagnostics.atrDecliningOk : false,
        avwapAligned: latestDiagnostics?.avwapRequired === false
          ? null
          : (latestDiagnostics?.avwapOk ?? false),
      }
    : undefined;

  return {
    side,
    phase,
    retryCount,
    retryCap,
    currentTier,
    cooldownCandlesRemaining: 0,   // not derivable from event log alone
    hibernationCandlesRemaining: 0,
    reopenLights,
    lastEventType,
    lastEventCandleIdx,
  };
}

export function derivePnLView(
  snapshot: {
    equity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    longRealizedPnl: number;
    shortRealizedPnl: number;
    longUnrealizedPnl: number;
    shortUnrealizedPnl: number;
  } | null | undefined,
  sim: {
    maxDrawdownPct?: number | null;
    winCount?: number | null;
    lossCount?: number | null;
    longTrades?: number | null;
    shortTrades?: number | null;
  } | null | undefined,
  baseCapital: number,
  leverage: number,
): PnLView {
  const equity = snapshot?.equity ?? baseCapital;
  const totalPnl = (snapshot?.realizedPnl ?? 0) + (snapshot?.unrealizedPnl ?? 0);
  const totalPnlPct = baseCapital > 0 ? (totalPnl / baseCapital) * 100 : 0;
  const notional = baseCapital * leverage;
  return {
    totalEquity: equity,
    baseCapital,
    totalPnl,
    totalPnlPct,
    longRealized: snapshot?.longRealizedPnl ?? 0,
    longUnrealized: snapshot?.longUnrealizedPnl ?? 0,
    shortRealized: snapshot?.shortRealizedPnl ?? 0,
    shortUnrealized: snapshot?.shortUnrealizedPnl ?? 0,
    fundingCost: 0, // not currently stored on snapshot; reserved for when PnlSnapshot gains the field
    notional,
    maxDrawdownPct: sim?.maxDrawdownPct ?? 0,
    winCount: sim?.winCount ?? 0,
    lossCount: sim?.lossCount ?? 0,
  };
}

export function coerceComboMode(raw: string | null | undefined): ComboMode {
  if (raw === 'long' || raw === 'short') return raw;
  return 'dual';
}

/**
 * Derive cooldown candle ranges (inclusive) for a given side from the persisted
 * event stream.
 *
 * A cooldown window opens on `cooldown_entered` and closes when the side leaves
 * COOLDOWN. The state machine has four exits (stateMachine.ts:204-227):
 * - `tier1_reopen`     → REOPENING (reopen path, NOT in the legacy closure list)
 * - `hibernation_entered` → HIBERNATING
 * - `breakout_entered` and `cycle_complete` close the rare external-exit paths.
 *
 * Without `tier1_reopen` in the closure list, shading bleeds across REOPENING /
 * RUNNING until the next breakout — the bug surfaced in the second review.
 */
export function deriveCooldownRanges(
  events: AdaptiveEventView[],
  side: GridSide,
  totalCandles: number,
): Array<{ startIdx: number; endIdx: number }> {
  const ranges: Array<{ startIdx: number; endIdx: number }> = [];
  let openStart: number | null = null;

  const sorted = [...events].sort((a, b) => a.candleIdx - b.candleIdx);
  for (const e of sorted) {
    let evSide: GridSide | null = null;
    try {
      const d = JSON.parse(e.detailsJson) as { side?: string };
      if (d.side === 'long' || d.side === 'short') evSide = d.side;
    } catch { /* noop */ }
    if (evSide !== side) continue;

    if (e.eventType === 'cooldown_entered') {
      openStart = e.candleIdx;
    } else if (
      e.eventType === 'breakout_entered'
      || e.eventType === 'tier1_reopen'
      || e.eventType === 'hibernation_entered'
      || e.eventType === 'cycle_complete'
    ) {
      if (openStart !== null) {
        ranges.push({ startIdx: openStart, endIdx: Math.max(openStart, e.candleIdx - 1) });
        openStart = null;
      }
    }
  }

  // Run ended without leaving COOLDOWN — close the range at the last candle.
  if (openStart !== null && totalCandles > 0) {
    ranges.push({ startIdx: openStart, endIdx: totalCandles - 1 });
  }
  return ranges;
}
