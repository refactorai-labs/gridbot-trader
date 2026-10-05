// GET /api/pionex/runs — saved runs (light fields); DELETE /api/pionex/runs?id=… (plan §6).

import { NextRequest, NextResponse } from 'next/server';
import { deleteRun, listRuns } from '@/lib/pionex/runStore';

export async function GET() {
  try {
    return NextResponse.json({ runs: await listRuns() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await deleteRun(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
