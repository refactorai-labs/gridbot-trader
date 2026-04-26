import { OHLC, AVWAPAnchorData } from '../types';
import { computeATRAtIndex, blendedATR } from '../indicators/atr';
import { computeERAtIndex } from '../indicators/efficiencyRatio';
import { computeRSIAtIndex } from '../indicators/rsi';

export interface AdaptiveEngineConfig {
  atrPeriod: number;
  erLookback: number;
  erSmoothingLength: number;
  erRegimeThreshold: number;
  rsiLength: number;
  blendedFactor: number;
}

export interface AdaptiveSignals {
  atr: number;
  blendedAtr: number;
  erRaw: number;
  erSmooth: number;
  rsi: number;
  avwap: number | null;
  regime: 'trending' | 'ranging';
  anchorJustArmed: boolean;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveEngineConfig = {
  atrPeriod: 14,
  erLookback: 10,
  erSmoothingLength: 3,
  erRegimeThreshold: 0.6,
  rsiLength: 14,
  blendedFactor: 1.4,
};

/**
 * AdaptiveEngine: the four-indicator supervisor signal producer (ATR, ER, RSI, AVWAP).
 *
 * Semantics:
 * - ATR/ER/RSI are computed on 4H aggregates (with 1H blend for ATR).
 * - ER_smooth is EMA-smoothed. When it transitions from <= threshold to > threshold,
 *   `anchorJustArmed` fires this tick and the AVWAP anchor is dropped at the current
 *   5m candle.
 * - Anchor persists across ticks. Caller should persist it (AVWAPAnchor row) for
 *   deterministic recomputation per spec §10.4.
 *
 * Performance note: update() accepts full arrays + index bounds (no slicing by caller).
 * 4H-derived indicators (ATR, ER, RSI) are recomputed only when count4h grows.
 * AVWAP is maintained with incremental accumulators (cumPV/cumV) — O(1) per 5m tick.
 */
export class AdaptiveEngine {
  private cfg: AdaptiveEngineConfig;
  private erSmoothPrev: number | null = null;
  private anchor: AVWAPAnchorData | null = null;
  private regimeTrendingPrev: boolean = false;

  // Incremental 4h state — only recomputed when count4h changes.
  private prev4hCount = 0;
  private prev1hCount = 0;
  private cachedCloses4h: number[] = [];
  private cachedAtr4h = NaN;
  private cachedAtr1h = NaN;
  private cachedErRaw = NaN;
  private cachedRsi = NaN;

  // Incremental AVWAP accumulators — reset when anchor changes.
  private avwapCumPV = 0;
  private avwapCumV = 0;
  private avwapNextIdx5m = 0;

  constructor(cfg: AdaptiveEngineConfig = DEFAULT_ADAPTIVE_CONFIG) {
    this.cfg = cfg;
  }

  getAnchor(): AVWAPAnchorData | null {
    return this.anchor ? { ...this.anchor } : null;
  }

  setAnchor(anchor: AVWAPAnchorData | null): void {
    this.anchor = anchor ? { ...anchor } : null;
    // Reset AVWAP accumulators so they rebuild from the anchor forward.
    this.avwapCumPV = 0;
    this.avwapCumV = 0;
    this.avwapNextIdx5m = anchor ? anchor.candleIdx : 0;
  }

  /**
   * Advance engine by one 5m candle.
   * Takes full arrays + index bounds — the caller must NOT slice before calling.
   * @param candles5m  Full 5m candle array
   * @param idx5m      Current 5m candle index (0-based)
   * @param candles1h  Full 1h candle array
   * @param count1h    Number of completed 1h candles at this 5m tick
   * @param candles4h  Full 4h candle array
   * @param count4h    Number of completed 4h candles at this 5m tick
   */
  update(
    candles5m: OHLC[], idx5m: number,
    candles1h: OHLC[], count1h: number,
    candles4h: OHLC[], count4h: number,
  ): AdaptiveSignals {
    // Recompute 4h-derived indicators only when a new 4h candle has closed.
    if (count4h > this.prev4hCount) {
      for (let i = this.prev4hCount; i < count4h; i++) {
        this.cachedCloses4h.push(candles4h[i].close);
      }
      const idx4h = count4h - 1;
      this.cachedAtr4h = count4h > 0
        ? computeATRAtIndex(candles4h, idx4h, this.cfg.atrPeriod).value
        : NaN;
      this.cachedErRaw = count4h > 0
        ? computeERAtIndex(this.cachedCloses4h, idx4h, this.cfg.erLookback).value
        : NaN;
      this.cachedRsi = count4h > 0
        ? computeRSIAtIndex(this.cachedCloses4h, idx4h, this.cfg.rsiLength).value
        : NaN;
      this.prev4hCount = count4h;
    }

    // Recompute 1h ATR only when a new 1h candle has closed.
    if (count1h > this.prev1hCount) {
      this.cachedAtr1h = count1h > 0
        ? computeATRAtIndex(candles1h, count1h - 1, this.cfg.atrPeriod).value
        : NaN;
      this.prev1hCount = count1h;
    }

    const atr = !isNaN(this.cachedAtr4h) ? this.cachedAtr4h : this.cachedAtr1h;
    const blended = (!isNaN(this.cachedAtr4h) && !isNaN(this.cachedAtr1h))
      ? blendedATR(this.cachedAtr4h, this.cachedAtr1h, this.cfg.blendedFactor)
      : atr;

    const erRaw = this.cachedErRaw;
    let erSmooth: number;
    if (isNaN(erRaw)) {
      erSmooth = this.erSmoothPrev ?? NaN;
    } else {
      const alpha = 2 / (this.cfg.erSmoothingLength + 1);
      erSmooth = this.erSmoothPrev === null
        ? erRaw
        : alpha * erRaw + (1 - alpha) * this.erSmoothPrev;
      this.erSmoothPrev = erSmooth;
    }

    const regimeTrendingNow = !isNaN(erSmooth) && erSmooth > this.cfg.erRegimeThreshold;
    const regime: 'trending' | 'ranging' = regimeTrendingNow ? 'trending' : 'ranging';
    const anchorJustArmed = !this.regimeTrendingPrev && regimeTrendingNow;

    if (anchorJustArmed && idx5m >= 0 && idx5m < candles5m.length) {
      const candle = candles5m[idx5m];
      this.anchor = {
        candleIdx: idx5m,
        timestamp: candle.timestamp,
        typicalPrice: (candle.high + candle.low + candle.close) / 3,
        volume: candle.volume,
      };
      // Reset incremental AVWAP accumulators from the new anchor.
      this.avwapCumPV = 0;
      this.avwapCumV = 0;
      this.avwapNextIdx5m = idx5m;
    }
    this.regimeTrendingPrev = regimeTrendingNow;

    // Advance incremental AVWAP from where we left off to idx5m.
    let avwap: number | null = null;
    if (this.anchor !== null && idx5m >= this.anchor.candleIdx) {
      const start = Math.max(this.avwapNextIdx5m, this.anchor.candleIdx);
      for (let i = start; i <= idx5m; i++) {
        const c = candles5m[i];
        const tp = (c.high + c.low + c.close) / 3;
        this.avwapCumPV += tp * c.volume;
        this.avwapCumV += c.volume;
      }
      this.avwapNextIdx5m = idx5m + 1;
      avwap = this.avwapCumV === 0 ? null : this.avwapCumPV / this.avwapCumV;
    }

    return {
      atr,
      blendedAtr: blended,
      erRaw,
      erSmooth,
      rsi: this.cachedRsi,
      avwap: avwap === null || isNaN(avwap) ? null : avwap,
      regime,
      anchorJustArmed,
    };
  }

  reset(): void {
    this.erSmoothPrev = null;
    this.anchor = null;
    this.regimeTrendingPrev = false;
    this.prev4hCount = 0;
    this.prev1hCount = 0;
    this.cachedCloses4h = [];
    this.cachedAtr4h = NaN;
    this.cachedAtr1h = NaN;
    this.cachedErRaw = NaN;
    this.cachedRsi = NaN;
    this.avwapCumPV = 0;
    this.avwapCumV = 0;
    this.avwapNextIdx5m = 0;
  }
}
