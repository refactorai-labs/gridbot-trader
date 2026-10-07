import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { EVENTS_PAGE_DEFAULT, EVENTS_PAGE_MAX } from '@/lib/simulation/classicGridTypes';

// GET: paginated adaptive events (Contract D) — the only path by which per-order
// diagnostics (entry_skipped, restoration_entry) reach the client.
// Query: types=a,b  side=long|short  fromIdx/toIdx (inclusive 5m candleIdx)  offset  limit
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { searchParams } = new URL(request.url);

    const simulation = await prisma.simulation.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (!simulation) {
      return NextResponse.json({ error: 'Simulation not found' }, { status: 404 });
    }

    const intParam = (name: string): number | null => {
      const raw = searchParams.get(name);
      if (raw === null || raw === '') return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    };

    const limit = Math.min(EVENTS_PAGE_MAX, Math.max(1, intParam('limit') ?? EVENTS_PAGE_DEFAULT));
    const offset = Math.max(0, intParam('offset') ?? 0);
    const types = (searchParams.get('types') ?? '').split(',').map(t => t.trim()).filter(Boolean);
    const side = searchParams.get('side');
    const fromIdx = intParam('fromIdx');
    const toIdx = intParam('toIdx');

    const where: Prisma.AdaptiveEventWhereInput = { simulationId: params.id };
    if (types.length > 0) where.eventType = { in: types };
    if (side === 'long' || side === 'short') where.detailsJson = { contains: `"side":"${side}"` };
    if (fromIdx !== null || toIdx !== null) {
      where.candleIdx = {
        ...(fromIdx !== null ? { gte: fromIdx } : {}),
        ...(toIdx !== null ? { lte: toIdx } : {}),
      };
    }

    const [total, rows] = await Promise.all([
      prisma.adaptiveEvent.count({ where }),
      prisma.adaptiveEvent.findMany({
        where,
        orderBy: [{ candleIdx: 'asc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
      }),
    ]);

    const events = rows.map(e => {
      let details: unknown = null;
      try { details = JSON.parse(e.detailsJson); } catch { /* keep null */ }
      return {
        id: e.id,
        candleIdx: e.candleIdx,
        timestamp: Math.floor(e.timestamp.getTime() / 1000),
        eventType: e.eventType,
        details,
        longMultiplier: e.longMultiplier,
        shortMultiplier: e.shortMultiplier,
      };
    });

    return NextResponse.json({ events, total, offset, limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
