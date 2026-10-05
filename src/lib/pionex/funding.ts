// Pionex backtester — funding settlements (plan §3.4.3).
//
//   - Bucket: every settlement goes to minute bucket floor(fundingTime / 60_000).
//     Binance fundingTime is sometimes 1–4 ms after the minute open, so an exact
//     match would miss it.
//   - Exactly once: one record per bucket; two records in one bucket is a data
//     error and aborts the run.
//   - Completeness: the whole requested window is always reconciled against
//     /fapi/v1/fundingRate (≤1000 rows per request, so usually a single call); the rows are stored via the existing cache, and the cache must then
//     hold exactly the API's settlements. Spacing alone cannot prove completeness
//     (short windows, a missing first settlement, or 1h/4h schedules all fit within
//     8h), so the 8h + 1min rule is only a supplementary check. A failed fetch makes
//     the whole window a gap with the error reason (plan §3.10). The 95 % heuristic
//     of getOrFetchFundingRates is NOT used.
//   - The settlement's own markPrice field is intentionally not used (plan §3.4.3).

import { getCachedFundingRates, storeFundingRates } from '../data/fundingCache';
import { fetchWithTimeout } from '../data/fetch';
import { BINANCE_FUTURES_API } from '../constants';

export interface FundingRecord {
  fundingTimeMs: number;
  rate: number; // signed; long pays when rate > 0
}

export interface FundingGap {
  startMs: number;
  endMs: number;
}

export const MAX_FUNDING_SPACING_MS = 8 * 3_600_000 + 60_000;

export const fundingBucket = (fundingTimeMs: number): number => Math.floor(fundingTimeMs / 60_000);

// Minute bucket → record. Throws on two records in one bucket (data error).
export function bucketFunding(records: FundingRecord[]): Map<number, FundingRecord> {
  const buckets = new Map<number, FundingRecord>();
  for (const r of records) {
    const b = fundingBucket(r.fundingTimeMs);
    if (buckets.has(b)) {
      throw new Error(`Funding data error: two settlements in minute bucket ${new Date(b * 60_000).toISOString()}`);
    }
    buckets.set(b, r);
  }
  return buckets;
}

// Strict coverage over [startMs, endMs): returns the stretches longer than 8h+1m.
export function fundingCoverageGaps(records: FundingRecord[], startMs: number, endMs: number): FundingGap[] {
  const inWindow = records
    .filter(r => r.fundingTimeMs >= startMs && r.fundingTimeMs < endMs)
    .sort((a, b) => a.fundingTimeMs - b.fundingTimeMs);
  const gaps: FundingGap[] = [];
  let cursor = startMs;
  for (const r of inWindow) {
    if (r.fundingTimeMs - cursor > MAX_FUNDING_SPACING_MS) gaps.push({ startMs: cursor, endMs: r.fundingTimeMs });
    cursor = r.fundingTimeMs;
  }
  if (endMs - cursor > MAX_FUNDING_SPACING_MS) gaps.push({ startMs: cursor, endMs });
  return gaps;
}

// Network / HTTP failure of the funding endpoint: the window becomes a reported
// gap, not a crash. Database and data errors are not wrapped and still throw.
export class FundingFetchError extends Error {}

// All settlements in [startMs, endMs) from Binance. Throws a plain Error on an
// invalid row (data error) and FundingFetchError on a network/API failure.
export async function fetchFundingRange(symbol: string, startMs: number, endMs: number): Promise<{ fundingTime: number; fundingRate: number }[]> {
  const rows: { fundingTime: number; fundingRate: number }[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${BINANCE_FUTURES_API.baseUrl}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs - 1}&limit=1000`;
    let data: Array<{ fundingTime: number; fundingRate: string }>;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      data = await res.json();
    } catch (e) {
      throw new FundingFetchError(`Binance funding fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Array.isArray(data)) throw new FundingFetchError('Binance funding fetch failed: unexpected response');
    if (data.length === 0) break;
    for (const row of data) {
      const rate = Number(row.fundingRate);
      if (!Number.isFinite(row.fundingTime) || row.fundingRate === '' || !Number.isFinite(rate)) {
        throw new Error(`Funding data error: invalid settlement ${JSON.stringify(row)}`);
      }
      rows.push({ fundingTime: row.fundingTime, fundingRate: rate });
    }
    const last = data[data.length - 1].fundingTime;
    if (last <= cursor) break;
    cursor = last + 1;
    if (data.length < 1000) break;
    await new Promise(r => setTimeout(r, BINANCE_FUTURES_API.requestDelay));
  }
  return rows.filter(r => r.fundingTime >= startMs && r.fundingTime < endMs);
}

async function readCached(symbol: string, startMs: number, endMs: number): Promise<FundingRecord[]> {
  const rows = await getCachedFundingRates(symbol, new Date(startMs), new Date(endMs - 1));
  return rows.map(r => ({ fundingTimeMs: Math.round(r.fundingTimeSec * 1000), rate: r.fundingRate }));
}

export interface StrictFundingResult {
  records: FundingRecord[];
  gaps: FundingGap[]; // non-empty → run is "data-incomplete" (plan §3.10)
  error?: string;     // why the window could not be reconciled with Binance
}

// Binance reconcile → cache → exactly-once buckets → supplementary spacing check.
export async function loadFundingStrict(symbol: string, startMs: number, endMs: number): Promise<StrictFundingResult> {
  let apiCount: number | null = null;
  let error: string | undefined;
  try {
    const rows = await fetchFundingRange(symbol, startMs, endMs);
    await storeFundingRates(symbol, rows);
    apiCount = rows.length;
  } catch (e) {
    if (!(e instanceof FundingFetchError)) throw e;
    error = e.message;
  }
  const records = await readCached(symbol, startMs, endMs);
  bucketFunding(records); // two settlements in one minute → data error, stops the load
  if (apiCount !== null && records.length !== apiCount) {
    throw new Error(`Funding data error: cache holds ${records.length} settlements in the window, Binance ${apiCount}`);
  }
  const gaps = error ? [{ startMs, endMs }] : fundingCoverageGaps(records, startMs, endMs);
  return { records, gaps, error };
}
