import { NextRequest, NextResponse } from 'next/server';
import { getOrFetchCandles, getCachedCandles } from '@/lib/data/candleCache';

// POST: Fetch candles from Binance and cache them
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { pair, timeframe, startTime, endTime } = body;

    if (!pair || !timeframe || !startTime || !endTime) {
      return NextResponse.json({ error: 'Missing required fields: pair, timeframe, startTime, endTime' }, { status: 400 });
    }

    const candles = await getOrFetchCandles(
      pair, timeframe,
      new Date(startTime), new Date(endTime)
    );

    return NextResponse.json({
      success: true,
      count: candles.length,
      candles,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: Read cached candles
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const pair = searchParams.get('pair');
    const timeframe = searchParams.get('timeframe') || '5m';
    const start = searchParams.get('start');
    const end = searchParams.get('end');

    if (!pair || !start || !end) {
      return NextResponse.json({ error: 'Missing pair, start, or end' }, { status: 400 });
    }

    const candles = await getCachedCandles(
      pair, timeframe,
      new Date(start), new Date(end)
    );

    return NextResponse.json({ candles, count: candles.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
