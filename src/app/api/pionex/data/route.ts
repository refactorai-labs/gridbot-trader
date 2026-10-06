// POST /api/pionex/data — load (and cache) a window's 1m last, 1m mark and
// funding; returns the gap report and timings, not the candles (plan §7 phase 0).

import { NextRequest, NextResponse } from 'next/server';
import { loadWindow } from '@/lib/data/windows';
import { PIONEX_MAX_WINDOW_DAYS, PIONEX_SYMBOLS } from '@/lib/constants';

export async function POST(request: NextRequest) {
  try {
    const { symbol, startMs, endMs } = await request.json();
    if (!PIONEX_SYMBOLS.includes(symbol)) {
      return NextResponse.json({ error: `symbol must be one of ${PIONEX_SYMBOLS.join(', ')}` }, { status: 400 });
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return NextResponse.json({ error: 'startMs/endMs invalid' }, { status: 400 });
    }
    if (endMs - startMs > PIONEX_MAX_WINDOW_DAYS * 86_400_000) {
      return NextResponse.json({ error: `window longer than ${PIONEX_MAX_WINDOW_DAYS} days` }, { status: 400 });
    }
    const w = await loadWindow(symbol, startMs, endMs);
    return NextResponse.json({
      report: w.report,
      timingMs: w.timingMs,
      counts: { last1m: w.last1m.length, mark1m: w.mark1m.length, funding: w.funding.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
