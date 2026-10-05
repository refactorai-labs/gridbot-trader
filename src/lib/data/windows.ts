// Pionex backtester — on-demand window loader (plan §2/2, §3.10, §7 phase 0).
// Loads 1m last, 1m mark and funding for [startMs, endMs); fills cache gaps from
// Binance; never throws on residual holes or fetch failures — they come back in
// the gap report with their reason. Database and funding data errors throw.

import { OHLC } from '../types';
import { getOrFetchCandles, getCachedCandles } from './candleCache';
import { getOrFetchMarkCandles } from './markPrice';
import { pionexLastPair, pionexMarkPair } from '../constants';
import { loadFundingStrict, FundingRecord } from '../pionex/funding';
import { buildGapReport, DataGapReport } from '../pionex/dataQuality';

export interface PionexWindowData {
  symbol: string;
  startMs: number;
  endMs: number;
  last1m: OHLC[];
  mark1m: OHLC[];
  funding: FundingRecord[];
  report: DataGapReport;
  timingMs: { last: number; mark: number; funding: number };
}

// getOrFetchCandles throws when holes remain after fetching (or the fetch fails);
// here that is a report entry with its reason, not an error, so fall back to
// whatever the cache now holds. Database errors are real errors and propagate.
async function loadOrCached(
  pair: string,
  fetcher: () => Promise<OHLC[]>,
  start: Date,
  end: Date,
  errors: string[]
): Promise<OHLC[]> {
  try {
    return await fetcher();
  } catch (e) {
    if (e instanceof Error && e.name.startsWith('PrismaClient')) throw e;
    errors.push(`${pair}: ${e instanceof Error ? e.message : String(e)}`);
    return getCachedCandles(pair, '1m', start, end);
  }
}

export async function loadWindow(symbol: string, startMs: number, endMs: number): Promise<PionexWindowData> {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const lastPair = pionexLastPair(symbol);
  const markPair = pionexMarkPair(symbol);
  const errors: string[] = [];

  let t = Date.now();
  const last1m = await loadOrCached(
    lastPair,
    () => getOrFetchCandles(lastPair, '1m', start, end, undefined, { market: 'futures', symbol }),
    start,
    end,
    errors
  );
  const lastMs = Date.now() - t;

  t = Date.now();
  const mark1m = await loadOrCached(markPair, () => getOrFetchMarkCandles(symbol, '1m', start, end), start, end, errors);
  const markMs = Date.now() - t;

  t = Date.now();
  const funding = await loadFundingStrict(symbol, startMs, endMs);
  const fundingMs = Date.now() - t;
  if (funding.error) errors.push(`funding: ${funding.error}`);

  const report = buildGapReport(symbol, startMs, endMs, last1m, mark1m, {
    records: funding.records.length,
    gaps: funding.gaps,
  }, errors);

  return {
    symbol,
    startMs,
    endMs,
    last1m,
    mark1m,
    funding: funding.records,
    report,
    timingMs: { last: lastMs, mark: markMs, funding: fundingMs },
  };
}
