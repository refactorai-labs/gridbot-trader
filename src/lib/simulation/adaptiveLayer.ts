// Adaptive layer — trend detection, breakout detection, gradual de-risking, re-entry

import { OHLC, AdaptiveState, AdaptiveEventData, TrendDirection } from '../types';
import { ema, avgVolume } from '../analysis/technical';
import { ADAPTIVE_DEFAULTS } from '../constants';

export function createInitialAdaptiveState(): AdaptiveState {
  return {
    trend: 'neutral',
    longMultiplier: 1.0,
    shortMultiplier: 1.0,
    deRiskPhase: 'none',
    reEntryConfirmations: 0,
  };
}

// Evaluate adaptive layer at a 4H boundary
export function evaluateAdaptive(
  candles4H: OHLC[],
  currentCandle: OHLC,
  currentState: AdaptiveState,
  support: number,
  resistance: number,
  config: {
    emaPeriod: number;
    volumeMultiplier: number;
  }
): { newState: AdaptiveState; events: AdaptiveEventData[] } {
  const events: AdaptiveEventData[] = [];
  const state = { ...currentState };

  // 1. Trend detection via EMA slope
  if (candles4H.length >= config.emaPeriod) {
    const closes = candles4H.map(c => c.close);
    const emaShort = ema(closes, 12);
    const emaLong = ema(closes, 26);
    const threshold = ADAPTIVE_DEFAULTS.trendThreshold;

    let newTrend: TrendDirection;
    if (emaShort > emaLong * (1 + threshold)) {
      newTrend = 'bullish';
    } else if (emaShort < emaLong * (1 - threshold)) {
      newTrend = 'bearish';
    } else {
      newTrend = 'neutral';
    }

    if (newTrend !== state.trend) {
      events.push({
        type: 'trend_change',
        details: { from: state.trend, to: newTrend, emaShort, emaLong },
        longMultiplier: newTrend === 'bearish' ? 0.5 : 1.0,
        shortMultiplier: newTrend === 'bullish' ? 0.5 : 1.0,
      });

      state.trend = newTrend;
      if (newTrend === 'neutral') {
        state.longMultiplier = 1.0;
        state.shortMultiplier = 1.0;
      } else if (newTrend === 'bullish') {
        state.longMultiplier = 1.0;
        state.shortMultiplier = 0.5;
      } else {
        state.longMultiplier = 0.5;
        state.shortMultiplier = 1.0;
      }
    }
  }

  // 2. Volume-confirmed breakout detection
  const vol20Avg = avgVolume(candles4H, ADAPTIVE_DEFAULTS.volumeAvgPeriod);
  const volumeConfirmed = currentCandle.volume >= vol20Avg * config.volumeMultiplier;

  const breakoutUp = currentCandle.close > resistance && volumeConfirmed;
  const breakoutDown = currentCandle.close < support && volumeConfirmed;

  // 3. Gradual de-risking on breakout
  if (breakoutUp && state.deRiskPhase === 'none') {
    state.deRiskPhase = 'phase1';
    state.deRiskSide = 'short';
    state.breakoutPrice = resistance;
    state.breakoutDirection = 'up';
    state.shortMultiplier = 0.5;
    state.reEntryConfirmations = 0;

    events.push({
      type: 'breakout_detected',
      details: { direction: 'up', price: currentCandle.close, resistance, volume: currentCandle.volume, avgVolume: vol20Avg },
      longMultiplier: state.longMultiplier,
      shortMultiplier: 0.5,
    });
    events.push({
      type: 'de_risk',
      details: { side: 'short', phase: 'phase1', multiplier: 0.5 },
      shortMultiplier: 0.5,
    });
  } else if (breakoutDown && state.deRiskPhase === 'none') {
    state.deRiskPhase = 'phase1';
    state.deRiskSide = 'long';
    state.breakoutPrice = support;
    state.breakoutDirection = 'down';
    state.longMultiplier = 0.5;
    state.reEntryConfirmations = 0;

    events.push({
      type: 'breakout_detected',
      details: { direction: 'down', price: currentCandle.close, support, volume: currentCandle.volume, avgVolume: vol20Avg },
      longMultiplier: 0.5,
      shortMultiplier: state.shortMultiplier,
    });
    events.push({
      type: 'de_risk',
      details: { side: 'long', phase: 'phase1', multiplier: 0.5 },
      longMultiplier: 0.5,
    });
  }

  // Progressive de-risking based on distance from breakout
  if (state.breakoutPrice && state.deRiskSide) {
    const distance = state.breakoutDirection === 'up'
      ? (currentCandle.close - state.breakoutPrice) / state.breakoutPrice
      : (state.breakoutPrice - currentCandle.close) / state.breakoutPrice;

    if (distance >= ADAPTIVE_DEFAULTS.deRiskClosePct && state.deRiskPhase !== 'closed') {
      // 4% beyond → close all on losing side
      state.deRiskPhase = 'closed';
      if (state.deRiskSide === 'long') {
        state.longMultiplier = 0;
      } else {
        state.shortMultiplier = 0;
      }
      events.push({
        type: 'de_risk',
        details: { side: state.deRiskSide, phase: 'closed', multiplier: 0, distance: (distance * 100).toFixed(2) + '%' },
        longMultiplier: state.longMultiplier,
        shortMultiplier: state.shortMultiplier,
      });
    } else if (distance >= ADAPTIVE_DEFAULTS.deRiskPhase2Pct && state.deRiskPhase === 'phase1') {
      // 2% beyond → reduce to 25%
      state.deRiskPhase = 'phase2';
      if (state.deRiskSide === 'long') {
        state.longMultiplier = 0.25;
      } else {
        state.shortMultiplier = 0.25;
      }
      events.push({
        type: 'de_risk',
        details: { side: state.deRiskSide, phase: 'phase2', multiplier: 0.25, distance: (distance * 100).toFixed(2) + '%' },
        longMultiplier: state.longMultiplier,
        shortMultiplier: state.shortMultiplier,
      });
    }

    // 4. Re-entry: price returns inside range
    const insideRange = state.breakoutDirection === 'up'
      ? currentCandle.close <= resistance
      : currentCandle.close >= support;

    if (insideRange && state.deRiskPhase !== 'none') {
      state.reEntryConfirmations++;

      if (state.reEntryConfirmations >= ADAPTIVE_DEFAULTS.reEntryCandles) {
        // Gradual restoration
        const currentMult = state.deRiskSide === 'long' ? state.longMultiplier : state.shortMultiplier;
        let newMult: number;

        if (currentMult === 0) newMult = 0.25;
        else if (currentMult === 0.25) newMult = 0.5;
        else if (currentMult === 0.5) newMult = 1.0;
        else newMult = 1.0;

        if (state.deRiskSide === 'long') {
          state.longMultiplier = newMult;
        } else {
          state.shortMultiplier = newMult;
        }

        events.push({
          type: 're_entry',
          details: {
            side: state.deRiskSide,
            confirmations: state.reEntryConfirmations,
            newMultiplier: newMult,
          },
          longMultiplier: state.longMultiplier,
          shortMultiplier: state.shortMultiplier,
        });

        // Reset for next re-entry step
        state.reEntryConfirmations = 0;

        // Fully restored
        if (newMult >= 1.0) {
          state.deRiskPhase = 'none';
          state.deRiskSide = undefined;
          state.breakoutPrice = undefined;
          state.breakoutDirection = undefined;
        }
      }
    } else if (!insideRange) {
      // Price still outside range, reset re-entry counter
      state.reEntryConfirmations = 0;
    }
  }

  return { newState: state, events };
}
