import { NextRequest, NextResponse } from 'next/server';
import { getOrFetchFundingRates, getCachedFundingRates } from '@/lib/data/fundingCache';

// POST: Fetch funding rates from Binance and cache them
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { symbol, startTime, endTime } = body;

    if (!symbol || !startTime || !endTime) {
      return NextResponse.json(
        { error: 'Missing required fields: symbol, startTime, endTime' },
        { status: 400 }
      );
    }

    const rates = await getOrFetchFundingRates(
      symbol,
      new Date(startTime),
      new Date(endTime)
    );

    return NextResponse.json({ success: true, count: rates.length, rates });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: Read cached funding rates
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const start = searchParams.get('start');
    const end = searchParams.get('end');

    if (!symbol || !start || !end) {
      return NextResponse.json({ error: 'Missing symbol, start, or end' }, { status: 400 });
    }

    const rates = await getCachedFundingRates(symbol, new Date(start), new Date(end));
    return NextResponse.json({ rates, count: rates.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
