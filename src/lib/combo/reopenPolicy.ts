import { GridSide, ReopenDiagnostics, ReopenPolicyName } from '../types';

export interface ReopenPolicyConfig {
  policy: ReopenPolicyName;
  avwapEnabled: boolean;
  atrRatioThreshold?: number;
  atrDecliningCandles?: number;
  rsiLongCross?: number;
  rsiShortCross?: number;
}

export interface ReopenPolicyInput {
  side: GridSide;
  price: number;
  previousPrice: number | null;
  atr: number;
  atrAtBreakout: number | null;
  atrHistory: number[];
  rsi: number;
  previousRsi: number | null;
  avwap: number | null;
  previousAvwap: number | null;
  regime: 'trending' | 'ranging';
  config: ReopenPolicyConfig;
}

export interface ReopenPolicyResult {
  allowed: boolean;
  diagnostics: ReopenDiagnostics;
}

const DEFAULT_ATR_RATIO_THRESHOLD = 0.6;
const DEFAULT_ATR_DECLINING_CANDLES = 3;
const DEFAULT_RSI_LONG_CROSS = 35;
const DEFAULT_RSI_SHORT_CROSS = 65;

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function strictlyDeclining(values: number[], count: number): boolean {
  if (count <= 1) return true;
  if (values.length < count) return false;
  const tail = values.slice(values.length - count);
  if (!tail.every(finite)) return false;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i] >= tail[i - 1]) return false;
  }
  return true;
}

/**
 * Compute the four exact v3.1 reopen diagnostics regardless of which policy is selected.
 * UI/observability lights read these fields directly, so they must remain honest and
 * comparable across policies. Policies decide which diagnostics combine into `allowed`.
 *
 * `avwapOk` is always the exact reclaim/rejection boolean — it does NOT short-circuit
 * to true when AVWAP is disabled, so AVWAP-off ablation diagnostics remain comparable
 * to AVWAP-on runs. `avwapRequired` reports whether the selected policy + config
 * actually consumed `avwapOk` for the `allowed` decision.
 */
export function computeDiagnostics(inp: ReopenPolicyInput): ReopenDiagnostics {
  const ratioThreshold = inp.config.atrRatioThreshold ?? DEFAULT_ATR_RATIO_THRESHOLD;
  const decliningCandles = inp.config.atrDecliningCandles ?? DEFAULT_ATR_DECLINING_CANDLES;
  const rsiLongCross = inp.config.rsiLongCross ?? DEFAULT_RSI_LONG_CROSS;
  const rsiShortCross = inp.config.rsiShortCross ?? DEFAULT_RSI_SHORT_CROSS;

  const atrRatioOk = finite(inp.atr)
    && finite(inp.atrAtBreakout)
    && inp.atrAtBreakout > 0
    && inp.atr / inp.atrAtBreakout < ratioThreshold;

  const atrDecliningOk = strictlyDeclining(inp.atrHistory, decliningCandles);

  const rsiCrossOk = finite(inp.rsi) && finite(inp.previousRsi)
    ? inp.side === 'long'
      ? inp.previousRsi <= rsiLongCross && inp.rsi > rsiLongCross
      : inp.previousRsi >= rsiShortCross && inp.rsi < rsiShortCross
    : false;

  const avwapOk = (() => {
    if (!finite(inp.avwap) || !finite(inp.previousAvwap) || !finite(inp.previousPrice)) return false;
    return inp.side === 'long'
      ? inp.previousPrice < inp.previousAvwap && inp.price > inp.avwap
      : inp.previousPrice > inp.previousAvwap && inp.price < inp.avwap;
  })();

  const policyNeedsAvwap = inp.config.policy === 'atr_rsi_avwap' || inp.config.policy === 'full_v31';
  const avwapRequired = policyNeedsAvwap && inp.config.avwapEnabled;

  return { atrRatioOk, atrDecliningOk, rsiCrossOk, avwapOk, avwapRequired };
}

/** Legacy MVP allow logic — kept for backwards comparability of `allowed` only. */
function mvpAllow(inp: ReopenPolicyInput): boolean {
  const avwapOk = (() => {
    if (!inp.config.avwapEnabled) return true;
    if (!finite(inp.avwap)) return true;
    const tolerance = 0.005;
    return inp.side === 'long'
      ? inp.price > inp.avwap * (1 - tolerance)
      : inp.price < inp.avwap * (1 + tolerance);
  })();
  const rsiCoiled = finite(inp.rsi) && inp.rsi > 40 && inp.rsi < 60;
  return inp.regime === 'trending' && rsiCoiled && avwapOk;
}

export function evaluateReopenPolicy(inp: ReopenPolicyInput): ReopenPolicyResult {
  const diagnostics = computeDiagnostics(inp);
  if (inp.config.policy === 'mvp_current') {
    return { diagnostics, allowed: mvpAllow(inp) };
  }
  const required: Array<keyof ReopenDiagnostics> = ['atrRatioOk', 'atrDecliningOk', 'rsiCrossOk'];
  if (diagnostics.avwapRequired) {
    required.push('avwapOk');
  }
  return {
    diagnostics,
    allowed: required.every(key => diagnostics[key]),
  };
}

