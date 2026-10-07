// Effective 5m execution window for the classic grid engine (Contract E).
// Pure module (no Prisma import) shared by the engine, the API and the page.

export const EXECUTION_TF_MS = 300_000;

export interface ExecutionWindow {
  effStart: number; // ms, first required 5m open
  effEnd: number;   // ms, exclusive; last required open is effEnd - 5m
}

// Required candles: open ∈ [effStart, effEnd − 5m], i.e. only complete 5m candles
// inside [start, end) that have already closed at `nowMs`.
export function normalizeExecutionWindow(startMs: number, endMs: number, nowMs: number): ExecutionWindow {
  const tf = EXECUTION_TF_MS;
  const effStart = Math.ceil(startMs / tf) * tf;
  const effEnd = Math.min(Math.floor(endMs / tf) * tf, Math.floor(nowMs / tf) * tf);
  if (!Number.isFinite(effStart) || !Number.isFinite(effEnd) || effEnd - effStart < tf) {
    throw new Error('Window holds no complete 5m candle');
  }
  return { effStart, effEnd };
}

// Body dates for the classic pre-run `/api/candles` fetch, so the fetch and the
// engine require exactly the same candles.
export function classicCandleFetchRange(startIso: string, endIso: string, nowMs: number): { startTime: string; endTime: string } {
  const { effStart, effEnd } = normalizeExecutionWindow(Date.parse(startIso), Date.parse(endIso), nowMs);
  return { startTime: new Date(effStart).toISOString(), endTime: new Date(effEnd).toISOString() };
}
