// GET /api/pionex/drawdowns?symbol=ETHUSDT&n=10&lookbackDays=30 — Top N drops
// from the full 1h futures history (plan §2/8). An incomplete history returns
// no ranking, only the gaps and the fetch error.

import { NextRequest, NextResponse } from 'next/server';
import { getFullHistory1h, topDrawdowns } from '@/lib/pionex/drawdowns';
import { PIONEX_SYMBOLS } from '@/lib/constants';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') ?? 'ETHUSDT';
    const n = Math.min(50, Math.max(1, Number(searchParams.get('n') ?? 10)));
    const lookbackDays = Math.min(120, Math.max(1, Number(searchParams.get('lookbackDays') ?? 30)));
    if (!(PIONEX_SYMBOLS as readonly string[]).includes(symbol)) {
      return NextResponse.json({ error: `symbol must be one of ${PIONEX_SYMBOLS.join(', ')}` }, { status: 400 });
    }
    const t = Date.now();
    const { candles, gaps, error } = await getFullHistory1h(symbol);
    // An incomplete history could hide the deepest drops → no ranking from it.
    const complete = gaps.length === 0 && error === null;
    const episodes = complete ? topDrawdowns(candles, n, lookbackDays) : [];
    return NextResponse.json({
      symbol,
      lookbackDays,
      complete,
      gaps,
      historyError: error,
      bars: candles.length,
      firstMs: candles[0] ? candles[0].timestamp * 1000 : null,
      lastMs: candles.length ? candles[candles.length - 1].timestamp * 1000 : null,
      episodes,
      timingMs: Date.now() - t,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
