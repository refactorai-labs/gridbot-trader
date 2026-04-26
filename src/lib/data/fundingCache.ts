import prisma from '../prisma';
import { FundingRateEntry } from '../simulation/funding';

const BINANCE_FUNDING_URL = 'https://fapi.binance.com/fapi/v1/fundingRate';

export async function getCachedFundingRates(
  symbol: string,
  startTime: Date,
  endTime: Date
): Promise<FundingRateEntry[]> {
  const rows = await prisma.binanceFundingRate.findMany({
    where: {
      symbol,
      fundingTime: {
        gte: BigInt(startTime.getTime()),
        lte: BigInt(endTime.getTime()),
      },
    },
    orderBy: { fundingTime: 'asc' },
  });
  return rows.map(r => ({
    fundingTimeSec: Number(r.fundingTime) / 1000,
    fundingRate: r.fundingRate,
  }));
}

async function storeFundingRates(
  symbol: string,
  rates: { fundingTime: number; fundingRate: number }[]
): Promise<number> {
  if (rates.length === 0) return 0;
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    throw new Error(`Invalid symbol "${symbol}"`);
  }

  // SQLite: use INSERT OR IGNORE for idempotent batch writes.
  const BATCH_SIZE = 500;
  let stored = 0;
  for (let i = 0; i < rates.length; i += BATCH_SIZE) {
    const batch = rates.slice(i, i + BATCH_SIZE).filter(r => isFinite(r.fundingRate));
    if (batch.length === 0) continue;
    const values = batch
      .map(r => `('${symbol}', ${BigInt(r.fundingTime)}, ${r.fundingRate})`)
      .join(',\n');
    const result = await prisma.$executeRawUnsafe(`
      INSERT OR IGNORE INTO BinanceFundingRate (symbol, fundingTime, fundingRate)
      VALUES ${values}
    `);
    stored += result;
  }
  return stored;
}

/**
 * Fetch funding rates from Binance in 1000-row pages and cache them.
 * Returns all rates in the requested window (cached + fetched).
 */
export async function getOrFetchFundingRates(
  symbol: string,
  startTime: Date,
  endTime: Date
): Promise<FundingRateEntry[]> {
  // Try cache first
  const cached = await getCachedFundingRates(symbol, startTime, endTime);
  // Funding runs every 8h, so expected count ≈ ceil((end-start)/8h)
  const expected = Math.ceil((endTime.getTime() - startTime.getTime()) / (8 * 3600 * 1000));
  if (cached.length >= expected * 0.95) {
    return cached;
  }

  let cursor = startTime.getTime();
  const endMs = endTime.getTime();
  const allFetched: { fundingTime: number; fundingRate: number }[] = [];

  while (cursor < endMs) {
    const url = `${BINANCE_FUNDING_URL}?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance funding fetch failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Array<{ symbol: string; fundingTime: number; fundingRate: string }>;
    if (!Array.isArray(data) || data.length === 0) break;

    for (const row of data) {
      const rate = Number(row.fundingRate);
      if (isFinite(rate)) {
        allFetched.push({ fundingTime: row.fundingTime, fundingRate: rate });
      }
    }

    const last = data[data.length - 1].fundingTime;
    if (last <= cursor) break; // safety
    cursor = last + 1;
    if (data.length < 1000) break;
  }

  if (allFetched.length > 0) {
    await storeFundingRates(symbol, allFetched);
  }

  return getCachedFundingRates(symbol, startTime, endTime);
}
