// POST /api/pionex/run — load the window, run path A and B, save a PionexRun and
// return it with the 5m display candles and the timings (plan §5, §7 phase 3).
// A window without any minute of both last and mark data → 422 with the gap report
// (same shape as /api/pionex/data), nothing saved (plan §3.10).

import { NextRequest, NextResponse } from 'next/server';
import { PIONEX_SYMBOLS } from '@/lib/constants';
import { executeRun, PionexRunRequest, validateRunRequest } from '@/lib/pionex/runStore';

const MAX_WINDOW_MS = 120 * 86_400_000;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as PionexRunRequest;
    const { symbol, startMs, endMs } = body;
    if (!PIONEX_SYMBOLS.includes(symbol as (typeof PIONEX_SYMBOLS)[number])) {
      return NextResponse.json({ error: `symbol must be one of ${PIONEX_SYMBOLS.join(', ')}` }, { status: 400 });
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return NextResponse.json({ error: 'startMs/endMs invalid' }, { status: 400 });
    }
    if (endMs - startMs > MAX_WINDOW_MS) {
      return NextResponse.json({ error: 'window longer than 120 days' }, { status: 400 });
    }
    const invalid = validateRunRequest(body);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    const result = await executeRun(body);
    if (!result.ok) {
      const { ok: _ok, ...noData } = result;
      return NextResponse.json(noData, { status: 422 });
    }
    return NextResponse.json({ run: result.run, timingMs: result.timingMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
