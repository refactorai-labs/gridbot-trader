// GET /api/pionex/runs/:id — one saved run with its 5m candles from the cache.

import { NextResponse } from 'next/server';
import { loadRun } from '@/lib/pionex/runStore';

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const run = await loadRun(params.id);
    if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
