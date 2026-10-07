import { describe, it, expect } from 'vitest';
import { buildChartData } from '../components/pionex/chartData';
import type { PionexRunPayload } from '../lib/pionex/runStore';
import type { LedgerEvent } from '../lib/pionex/types';

// Regression (trailing plan, contract): a TP close keeps `reason: 'take profit'` for
// both triggers, so the chart's exact match gives the green TP marker.
const T = Date.UTC(2022, 4, 4);
const M = 60_000;

function runWith(events: LedgerEvent[]): PionexRunPayload {
  return {
    config: { bot: { lower: 90, upper: 110, gridCount: 10, mode: 'arithmetic', investment: 100, extraMargin: 50, leverage: 10 } },
    candles5m: [{ timestamp: T / 1000, open: 100, high: 101, low: 99, close: 100, volume: 0 }],
    report: { events: { A: events, B: [] }, paths: { A: { summary: { bots: [] } }, B: { summary: { bots: [] } } }, liqSeries: { A: [], B: [] } },
  } as unknown as PionexRunPayload;
}

describe('pionex chart data markers', () => {
  it('a close with reason "take profit" is a green TP marker, any other close is an orange STOP', () => {
    const { markers } = buildChartData(runWith([
      { type: 'close', bot: 0, timeMs: T + M, price: 105, reason: 'take profit' },
      { type: 'close', bot: 0, timeMs: T + 2 * M, price: 95, reason: 'fixed close' },
    ]), 'A');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ color: '#10b981', text: 'B1 TP 00:01' });
    expect(markers[1]).toMatchObject({ color: '#f59e0b', text: 'B1 STOP 00:02' });
  });
});
