import { describe, it, expect } from 'vitest';
import { deriveCooldownRanges } from '../components/combo/derive';
import { AdaptiveEventView } from '../components/combo/types';
import { ReopenDiagnostics } from '../lib/types';

function ev(candleIdx: number, eventType: string, side: 'long' | 'short' = 'long'): AdaptiveEventView {
  return {
    candleIdx,
    timestamp: 1_700_000_000 + candleIdx * 300,
    eventType,
    detailsJson: JSON.stringify({ side }),
  };
}

// Mirrors the tooltip lookup in TradingChart.tsx around line 920–929. Kept as a
// pure helper here so it can be unit-tested without spinning up the chart.
// `ranges` and `ticks` are the per-side arrays that ComboPane.tsx builds and
// hands to the chart through ComboOverlayData.
function lookupTooltipDiagnostics(
  ranges: Array<{ startIdx: number; endIdx: number }>,
  ticks: Array<{ candleIdx: number; diagnostics: ReopenDiagnostics }>,
  hoveredIdx: number,
): ReopenDiagnostics | null {
  const range = ranges.find(r => hoveredIdx >= r.startIdx && hoveredIdx <= r.endIdx);
  if (!range) return null;
  for (let i = ticks.length - 1; i >= 0; i--) {
    const tk = ticks[i];
    if (tk.candleIdx >= range.startIdx && tk.candleIdx <= hoveredIdx) {
      return tk.diagnostics;
    }
  }
  return null;
}

function diag(overrides: Partial<ReopenDiagnostics> = {}): ReopenDiagnostics {
  return {
    atrRatioOk: true,
    atrDecliningOk: true,
    rsiCrossOk: true,
    avwapOk: true,
    avwapRequired: false,
    ...overrides,
  };
}

describe('deriveCooldownRanges', () => {
  it('closes a cooldown range at tier1_reopen (the regression case)', () => {
    // The bug: prior to Phase 2.6, the closure list was
    //   [breakout_entered, hibernation_entered, cycle_complete]
    // and `tier1_reopen` was missing. Cooldown shading would bleed across
    // REOPENING / RUNNING until the next breakout. This test pins the fix.
    const events = [
      ev(50, 'cooldown_entered', 'long'),
      ev(60, 'tier1_reopen', 'long'),
      ev(70, 'sl_triggered', 'long'),
    ];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ startIdx: 50, endIdx: 59 });
  });

  it('closes a cooldown range at hibernation_entered', () => {
    const events = [
      ev(20, 'cooldown_entered', 'long'),
      ev(35, 'hibernation_entered', 'long'),
    ];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toEqual([{ startIdx: 20, endIdx: 34 }]);
  });

  it('closes a cooldown range at breakout_entered (rare external-exit path)', () => {
    const events = [
      ev(10, 'cooldown_entered', 'long'),
      ev(40, 'breakout_entered', 'long'),
    ];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toEqual([{ startIdx: 10, endIdx: 39 }]);
  });

  it('closes an open cooldown at the last candle if the run ends inside cooldown', () => {
    const events = [ev(80, 'cooldown_entered', 'long')];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toEqual([{ startIdx: 80, endIdx: 99 }]);
  });

  it('does NOT close another sides cooldown', () => {
    // Long opens cooldown, short fires tier1_reopen — must not close long.
    const events = [
      ev(10, 'cooldown_entered', 'long'),
      ev(20, 'tier1_reopen', 'short'),
      ev(30, 'tier1_reopen', 'long'),
    ];
    const longRanges = deriveCooldownRanges(events, 'long', 100);
    const shortRanges = deriveCooldownRanges(events, 'short', 100);
    expect(longRanges).toEqual([{ startIdx: 10, endIdx: 29 }]);
    // Short never had a cooldown_entered, so no range opens.
    expect(shortRanges).toHaveLength(0);
  });

  it('handles multiple sequential cooldown→tier1_reopen cycles', () => {
    const events = [
      ev(10, 'cooldown_entered', 'long'),
      ev(20, 'tier1_reopen', 'long'),
      ev(30, 'cooldown_entered', 'long'),
      ev(40, 'tier1_reopen', 'long'),
      ev(50, 'cooldown_entered', 'long'),
      ev(60, 'hibernation_entered', 'long'),
    ];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toEqual([
      { startIdx: 10, endIdx: 19 },
      { startIdx: 30, endIdx: 39 },
      { startIdx: 50, endIdx: 59 },
    ]);
  });

  it('ignores closure events when no cooldown is open', () => {
    const events = [
      ev(10, 'tier1_reopen', 'long'),
      ev(20, 'breakout_entered', 'long'),
    ];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toHaveLength(0);
  });

  it('processes events in candleIdx order regardless of input order', () => {
    const events = [
      ev(60, 'tier1_reopen', 'long'),
      ev(50, 'cooldown_entered', 'long'),
    ];
    const ranges = deriveCooldownRanges(events, 'long', 100);
    expect(ranges).toEqual([{ startIdx: 50, endIdx: 59 }]);
  });
});

describe('cooldown failed-gate tooltip lookup', () => {
  // These tests pin the contract between the per-side arrays ComboPane.tsx
  // builds (cooldownRanges + cooldownTickDiagnostics) and the lookup the chart
  // does on crosshair-move (TradingChart.tsx:920-929). The bug surfaced in the
  // P1 review was that the data side was sparse — failed gates produced no
  // diagnostics. With `reopen_check_failed` events now firing every post-expiry
  // cooldown candle, the lookup should resolve to per-candle data.

  it('returns the diagnostic at the hovered candle when one exists for that candle', () => {
    const ranges = [{ startIdx: 50, endIdx: 59 }];
    const ticks = [
      { candleIdx: 56, diagnostics: diag({ atrRatioOk: false }) },
      { candleIdx: 57, diagnostics: diag({ rsiCrossOk: false }) },
      { candleIdx: 58, diagnostics: diag({ avwapOk: false, avwapRequired: true }) },
    ];
    expect(lookupTooltipDiagnostics(ranges, ticks, 56)?.atrRatioOk).toBe(false);
    expect(lookupTooltipDiagnostics(ranges, ticks, 57)?.rsiCrossOk).toBe(false);
    expect(lookupTooltipDiagnostics(ranges, ticks, 58)?.avwapOk).toBe(false);
  });

  it('returns null while hovering pre-expiry cooldown candles (no diagnostic emitted yet)', () => {
    // Pre-expiry: state machine is silent (cooldownCandlesRemaining > 0). The
    // first `reopen_check_failed` only fires once the timer hits zero. Hovering
    // candles before that returns null → tooltip shows "no reopen attempt yet".
    const ranges = [{ startIdx: 50, endIdx: 70 }];
    const ticks = [
      { candleIdx: 56, diagnostics: diag({ atrRatioOk: false }) },
      { candleIdx: 57, diagnostics: diag({ atrRatioOk: false }) },
    ];
    expect(lookupTooltipDiagnostics(ranges, ticks, 50)).toBeNull();
    expect(lookupTooltipDiagnostics(ranges, ticks, 55)).toBeNull();
  });

  it('returns the most recent failed-check diagnostic when hovering the last cooldown candle (boundary case)', () => {
    // Resolves the boundary mismatch noted in the review: deriveCooldownRanges
    // closes ranges at `e.candleIdx - 1` for tier1_reopen, so the closure event
    // itself sits one candle past the shaded range. Before P1 was fixed, only
    // the closure event carried diagnostics, so hovering the last shaded candle
    // returned null. With per-candle failed-gate events, the last shaded candle
    // (endIdx) carries its own failure diagnostic and the lookup finds it.
    const ranges = [{ startIdx: 50, endIdx: 59 }]; // tier1_reopen at candle 60
    const ticks = [
      { candleIdx: 56, diagnostics: diag({ atrRatioOk: false }) },
      { candleIdx: 57, diagnostics: diag({ atrRatioOk: false }) },
      { candleIdx: 58, diagnostics: diag({ atrRatioOk: false }) },
      { candleIdx: 59, diagnostics: diag({ atrRatioOk: false, atrDecliningOk: false }) },
      // The success diagnostic on candle 60 is intentionally NOT in the lookup
      // window because it's outside the shaded range — that's correct: the
      // success info belongs to the reopen candle, not the cooldown range.
      { candleIdx: 60, diagnostics: diag() },
    ];
    const result = lookupTooltipDiagnostics(ranges, ticks, 59);
    expect(result).not.toBeNull();
    expect(result!.atrRatioOk).toBe(false);
    expect(result!.atrDecliningOk).toBe(false);
  });

  it('returns null when hovering outside any cooldown range', () => {
    const ranges = [{ startIdx: 50, endIdx: 59 }];
    const ticks = [{ candleIdx: 58, diagnostics: diag({ atrRatioOk: false }) }];
    expect(lookupTooltipDiagnostics(ranges, ticks, 49)).toBeNull();
    expect(lookupTooltipDiagnostics(ranges, ticks, 60)).toBeNull();
  });

  it('finds the most recent prior diagnostic when hovering between failed-check candles', () => {
    // Walking backwards from ticks.length - 1, the lookup should pick the
    // candle nearest to (but not after) hoveredIdx.
    const ranges = [{ startIdx: 50, endIdx: 70 }];
    const ticks = [
      { candleIdx: 56, diagnostics: diag({ atrRatioOk: false }) },
      { candleIdx: 60, diagnostics: diag({ rsiCrossOk: false }) },
      { candleIdx: 65, diagnostics: diag({ avwapOk: false, avwapRequired: true }) },
    ];
    expect(lookupTooltipDiagnostics(ranges, ticks, 58)?.atrRatioOk).toBe(false);
    expect(lookupTooltipDiagnostics(ranges, ticks, 62)?.rsiCrossOk).toBe(false);
    expect(lookupTooltipDiagnostics(ranges, ticks, 70)?.avwapOk).toBe(false);
  });
});
