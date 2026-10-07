import { describe, expect, it, vi } from 'vitest';
import type { OHLC } from '../lib/types';

vi.mock('../lib/prisma', () => ({ default: {} }));

import { computeMissingGaps } from '../lib/data/candleCache';
import { normalizeExecutionWindow, classicCandleFetchRange, EXECUTION_TF_MS } from '../lib/data/executionWindow';

const TF = EXECUTION_TF_MS;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW = Date.UTC(2026, 5, 1);
const min = (m: number) => m * 60_000;

function c(ms: number): OHLC {
  return { timestamp: ms / 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

describe('normalizeExecutionWindow (Contract E)', () => {
  it('[00:00, 00:07) holds exactly the 00:00 candle', () => {
    const w = normalizeExecutionWindow(T0, T0 + min(7), NOW);
    expect(w).toEqual({ effStart: T0, effEnd: T0 + TF });
  });

  it('raw helper is window-naive; normalized inputs report no false gap', () => {
    const cached = [c(T0)];
    // Raw: reports 00:05 missing although that candle is incomplete in the window.
    expect(computeMissingGaps(cached, T0, T0 + min(7), TF)).toEqual([{ startMs: T0 + TF, endMs: T0 + 2 * TF }]);
    const w = normalizeExecutionWindow(T0, T0 + min(7), NOW);
    expect(computeMissingGaps(cached, w.effStart, w.effEnd, TF)).toEqual([]);
  });

  it('rounds an unaligned start up and an unaligned end down', () => {
    const w = normalizeExecutionWindow(T0 + min(2), T0 + min(33), NOW);
    expect(w).toEqual({ effStart: T0 + TF, effEnd: T0 + min(30) });
  });

  it('fixture window 15:52 → 14:52 gives first open 15:55 and last open 14:45', () => {
    const start = Date.parse('2026-01-14T15:52:00Z');
    const end = Date.parse('2026-05-31T14:52:00Z');
    const w = normalizeExecutionWindow(start, end, NOW);
    expect(new Date(w.effStart).toISOString()).toBe('2026-01-14T15:55:00.000Z');
    expect(new Date(w.effEnd - TF).toISOString()).toBe('2026-05-31T14:45:00.000Z');
  });

  it('clamps the end to the last closed candle at now', () => {
    const now = T0 + min(23);
    const w = normalizeExecutionWindow(T0, T0 + min(60), now);
    expect(w.effEnd).toBe(T0 + min(20));
  });

  it('throws when no complete 5m candle fits', () => {
    expect(() => normalizeExecutionWindow(T0 + min(1), T0 + min(6), NOW)).toThrow('Window holds no complete 5m candle');
    expect(() => normalizeExecutionWindow(T0, T0, NOW)).toThrow();
    expect(() => normalizeExecutionWindow(NaN, T0, NOW)).toThrow();
  });

  it('reports a genuine interior gap on the normalized window', () => {
    const w = normalizeExecutionWindow(T0, T0 + min(20), NOW);
    const cached = [c(T0), c(T0 + TF), c(T0 + 3 * TF)];
    expect(computeMissingGaps(cached, w.effStart, w.effEnd, TF)).toEqual([{ startMs: T0 + 2 * TF, endMs: T0 + 3 * TF }]);
  });
});

describe('classicCandleFetchRange (classic pre-run /api/candles body)', () => {
  it('sends the normalized [effStart, effEnd) window', () => {
    const body = classicCandleFetchRange('2026-01-01T00:02:00.000Z', '2026-01-01T00:33:00.000Z', NOW);
    expect(body).toEqual({ startTime: '2026-01-01T00:05:00.000Z', endTime: '2026-01-01T00:30:00.000Z' });
  });
});
