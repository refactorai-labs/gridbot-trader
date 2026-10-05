/**
 * Fetch ETH/USDT USDT-M perpetual research data into the local cache:
 *   - 30m klines (signal timeframe)  — cache pair key ETHUSDTPERP
 *   - 1m  klines (fill timeframe)    — cache pair key ETHUSDTPERP
 *   - funding rates (8h settlements) — symbol ETHUSDT
 *
 * Usage:
 *   npx tsx scripts/research/fetch-data.ts                 # 2024-02-01 → now
 *   npx tsx scripts/research/fetch-data.ts --report-only   # gap report only, no fetching
 *
 * Fetches go straight to fapi.binance.com (no dev server needed) in monthly
 * chunks so progress is cached incrementally and a transient failure can be
 * resumed by re-running. Ends with a gap report over the full window.
 */

import prisma from '../../src/lib/prisma';
import { getOrFetchCandles, getCachedCandles, computeMissingGaps } from '../../src/lib/data/candleCache';
import { getOrFetchFundingRates } from '../../src/lib/data/fundingCache';

const CACHE_PAIR = 'ETHUSDTPERP'; // cache key — keeps perp rows separate from spot ETHUSDT
const SYMBOL = 'ETHUSDT';         // exchange symbol on fapi
const START = new Date('2024-02-01T00:00:00.000Z');

function monthChunks(start: Date, end: Date): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(start);
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    chunks.push({ from: new Date(cursor), to: next < end ? next : new Date(end) });
    cursor = next;
  }
  return chunks;
}

async function fetchInterval(interval: string, end: Date): Promise<void> {
  const chunks = monthChunks(START, end);
  let total = 0;
  for (const { from, to } of chunks) {
    const label = `${interval} ${from.toISOString().slice(0, 10)}→${to.toISOString().slice(0, 10)}`;
    try {
      const candles = await getOrFetchCandles(CACHE_PAIR, interval, from, to, undefined, {
        market: 'futures',
        symbol: SYMBOL,
      });
      total += candles.length;
      process.stdout.write(`[fetch] ${label}  ok (${candles.length} bars, running total ${total})\n`);
    } catch (err) {
      process.stdout.write(`[fetch] ${label}  WARN: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

async function gapReport(interval: string, end: Date): Promise<void> {
  const tfMs = interval === '1m' ? 60_000 : 1_800_000;
  const cached = await getCachedCandles(CACHE_PAIR, interval, START, end);
  // Only fully-closed buckets are expected in the cache.
  const coverageEnd = Math.floor(Date.now() / tfMs) * tfMs;
  const gaps = computeMissingGaps(cached, START.getTime(), Math.min(end.getTime(), coverageEnd), tfMs);
  const missingBars = gaps.reduce((s, g) => s + (g.endMs - g.startMs) / tfMs, 0);
  process.stdout.write(`\n[gap-report] ${interval}: ${cached.length} bars cached, ${gaps.length} gaps, ${missingBars} bars missing\n`);
  for (const g of gaps.slice(0, 20)) {
    process.stdout.write(`  [${new Date(g.startMs).toISOString()}, ${new Date(g.endMs).toISOString()})  ${(g.endMs - g.startMs) / tfMs} bars\n`);
  }
  if (gaps.length > 20) process.stdout.write(`  … ${gaps.length - 20} more\n`);
}

async function main(): Promise<void> {
  const reportOnly = process.argv.includes('--report-only');
  const end = new Date();
  process.stdout.write(`[fetch] window ${START.toISOString()} → ${end.toISOString()}\n`);

  if (!reportOnly) {
    await fetchInterval('30m', end);
    await fetchInterval('1m', end);
    process.stdout.write(`[fetch] funding rates…\n`);
    const rates = await getOrFetchFundingRates(SYMBOL, START, end);
    process.stdout.write(`[fetch] funding rows: ${rates.length}\n`);
  }

  await gapReport('30m', end);
  await gapReport('1m', end);

  const rates = await prisma.binanceFundingRate.count({
    where: { symbol: SYMBOL, fundingTime: { gte: BigInt(START.getTime()) } },
  });
  const expected = Math.floor((end.getTime() - START.getTime()) / (8 * 3600 * 1000));
  process.stdout.write(`[gap-report] funding: ${rates} rows cached (~${expected} expected)\n`);
}

main()
  .catch(err => {
    process.stderr.write(`[fetch] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
