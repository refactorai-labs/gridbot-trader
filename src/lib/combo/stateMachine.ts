import { GridSide, BotPhase, BotState, ComboBotSideConfig } from '../types';
import { AdaptiveSignals } from './adaptiveEngine';
import { slPrice, tierSize } from './sizing';

export interface PositionSnapshot {
  hasPosition: boolean;
  avgEntry: number;
  currentPrice: number;
  unrealizedPnlPct: number;
}

export interface BotInstruction {
  allowNewOrders: boolean;
  sizeMultiplier: number;
  slPrice: number | null;
  slHit: boolean;
  closePosition: boolean;
}

export type ComboEventType =
  | 'breakout_entered'
  | 'position_opened'
  | 'sl_triggered'
  | 'cooldown_entered'
  | 'tier1_reopen'
  | 'tier2_scale'
  | 'tier3_scale'
  | 'cycle_complete'
  | 'hibernation_entered'
  | 'hibernation_exit'
  | 'retry_incremented';

export interface ComboEvent {
  candleIdx: number;
  timestamp: number;
  side: GridSide;
  type: ComboEventType;
  phase: BotPhase;
  snapshot: {
    atr: number;
    erSmooth: number;
    rsi: number;
    price: number;
    slPrice?: number | null;
  };
}

export interface TickInputs {
  candleIdx: number;
  timestamp: number;
  price: number;
  /** Candle high — used for short-side SL wick detection (close alone misses wicks). */
  candleHigh: number;
  /** Candle low — used for long-side SL wick detection (close alone misses wicks). */
  candleLow: number;
  signals: AdaptiveSignals;
  position: PositionSnapshot;
  entryConditionMet: boolean;
  reopenConditionsMet: boolean;
}

export interface TickResult {
  instruction: BotInstruction;
  events: ComboEvent[];
}

const TIER_ADVANCE_CANDLES = 2;

export class ComboBotStateMachine {
  private state: BotState;
  private sideCfg: ComboBotSideConfig;
  private erBelowHibernationCount: number = 0;
  private candlesInTier: number = 0;
  private HIBERNATION_ER_THRESHOLD = 0.3;

  constructor(side: GridSide, sideCfg: ComboBotSideConfig) {
    this.sideCfg = sideCfg;
    this.state = {
      side,
      phase: 'IDLE',
      retryCount: 0,
      hibernationCandlesRemaining: 0,
      cooldownCandlesRemaining: 0,
      currentTier: 0,
      lastSLCandleIdx: null,
      lastSLPrice: null,
      atrAtPhaseEntry: null,
      breakoutPrice: null,
    };
  }

  getState(): BotState {
    return { ...this.state };
  }

  forceStopLoss(inp: TickInputs, slPriceVal: number): ComboEvent[] {
    if (!['BREAKOUT', 'RUNNING', 'REOPENING'].includes(this.state.phase)) {
      return [];
    }
    const instr: BotInstruction = {
      allowNewOrders: false,
      sizeMultiplier: 0,
      slPrice: null,
      slHit: false,
      closePosition: false,
    };
    const events: ComboEvent[] = [];
    this.enterCooldownFromSL(inp, slPriceVal, instr, events);
    if (this.state.phase === 'COOLDOWN') {
      this.state.currentTier = 0;
      this.candlesInTier = 0;
    }
    return events;
  }

  tick(inp: TickInputs): TickResult {
    const events: ComboEvent[] = [];
    const instr: BotInstruction = {
      allowNewOrders: false,
      sizeMultiplier: 0,
      slPrice: null,
      slHit: false,
      closePosition: false,
    };

    switch (this.state.phase) {
      case 'IDLE':
        this.tickIdle(inp, instr, events);
        break;
      case 'BREAKOUT':
        this.tickBreakout(inp, instr, events);
        break;
      case 'RUNNING':
        this.tickRunning(inp, instr, events);
        break;
      case 'COOLDOWN':
        this.tickCooldown(inp, instr, events);
        break;
      case 'REOPENING':
        this.tickReopening(inp, instr, events);
        break;
      case 'HIBERNATING':
        this.tickHibernating(inp, instr, events);
        break;
    }

    return { instruction: instr, events };
  }

  private tickIdle(inp: TickInputs, instr: BotInstruction, events: ComboEvent[]): void {
    if (inp.entryConditionMet) {
      this.state.phase = 'BREAKOUT';
      this.state.breakoutPrice = inp.price;
      this.state.atrAtPhaseEntry = inp.signals.atr;
      instr.allowNewOrders = true;
      instr.sizeMultiplier = 1.0;
      events.push(this.mkEvent('breakout_entered', inp));
    }
  }

  private tickBreakout(inp: TickInputs, instr: BotInstruction, events: ComboEvent[]): void {
    instr.allowNewOrders = true;
    instr.sizeMultiplier = 1.0;
    if (inp.position.hasPosition) {
      this.state.phase = 'RUNNING';
      events.push(this.mkEvent('position_opened', inp));
    }
  }

  private tickRunning(inp: TickInputs, instr: BotInstruction, events: ComboEvent[]): void {
    if (inp.position.hasPosition && inp.position.avgEntry > 0) {
      const sl = slPrice(this.sideCfg, this.state.side, inp.position.avgEntry, inp.signals.atr);
      instr.slPrice = sl;
      // Use wick (low for long, high for short) so a candle that pierces SL but closes back
      // inside still triggers exit. Close-only check materially overstates performance.
      const slHit = this.state.side === 'long' ? inp.candleLow <= sl : inp.candleHigh >= sl;
      if (slHit) {
        this.enterCooldownFromSL(inp, sl, instr, events);
        return;
      }
    }
    instr.allowNewOrders = true;
    instr.sizeMultiplier = 1.0;
  }

  private tickCooldown(inp: TickInputs, instr: BotInstruction, events: ComboEvent[]): void {
    if (this.state.cooldownCandlesRemaining > 0) {
      this.state.cooldownCandlesRemaining--;
    }
    if (this.state.cooldownCandlesRemaining <= 0 && inp.reopenConditionsMet) {
      this.state.retryCount++;
      events.push(this.mkEvent('retry_incremented', inp));

      if (this.state.retryCount >= this.sideCfg.retryCap) {
        this.state.phase = 'HIBERNATING';
        this.erBelowHibernationCount = 0;
        events.push(this.mkEvent('hibernation_entered', inp));
        return;
      }

      this.state.phase = 'REOPENING';
      this.state.currentTier = 1;
      this.candlesInTier = 0;
      instr.allowNewOrders = true;
      instr.sizeMultiplier = tierSize(1, this.sideCfg);
      events.push(this.mkEvent('tier1_reopen', inp));
    }
  }

  private tickReopening(inp: TickInputs, instr: BotInstruction, events: ComboEvent[]): void {
    if (inp.position.hasPosition && inp.position.avgEntry > 0) {
      const sl = slPrice(this.sideCfg, this.state.side, inp.position.avgEntry, inp.signals.atr);
      instr.slPrice = sl;
      // Wick-based SL: see tickRunning rationale.
      const slHit = this.state.side === 'long' ? inp.candleLow <= sl : inp.candleHigh >= sl;
      if (slHit) {
        this.enterCooldownFromSL(inp, sl, instr, events);
        this.state.currentTier = 0;
        this.candlesInTier = 0;
        return;
      }
      this.candlesInTier++;
      if (this.candlesInTier >= TIER_ADVANCE_CANDLES) {
        if (this.state.currentTier < 3) {
          this.state.currentTier = (this.state.currentTier + 1) as 1 | 2 | 3;
          this.candlesInTier = 0;
          const type: ComboEventType = this.state.currentTier === 2 ? 'tier2_scale' : 'tier3_scale';
          events.push(this.mkEvent(type, inp));
        } else {
          // Tier 3 complete → cycle back to IDLE (success loop, diagram 3)
          this.state.phase = 'IDLE';
          this.state.currentTier = 0;
          this.state.retryCount = 0;
          this.candlesInTier = 0;
          events.push(this.mkEvent('cycle_complete', inp));
          return;
        }
      }
    }
    instr.allowNewOrders = true;
    instr.sizeMultiplier = tierSize(this.state.currentTier, this.sideCfg);
  }

  private tickHibernating(inp: TickInputs, _instr: BotInstruction, events: ComboEvent[]): void {
    if (!isNaN(inp.signals.erSmooth) && inp.signals.erSmooth < this.HIBERNATION_ER_THRESHOLD) {
      this.erBelowHibernationCount++;
    } else {
      this.erBelowHibernationCount = 0;
    }
    if (this.erBelowHibernationCount >= this.sideCfg.hibernationCandles) {
      this.state.phase = 'IDLE';
      this.state.retryCount = 0;
      this.erBelowHibernationCount = 0;
      events.push(this.mkEvent('hibernation_exit', inp));
    }
  }

  private enterCooldownFromSL(
    inp: TickInputs,
    slPriceVal: number,
    instr: BotInstruction,
    events: ComboEvent[]
  ): void {
    instr.slHit = true;
    instr.closePosition = true;
    instr.allowNewOrders = false;
    instr.sizeMultiplier = 0;
    instr.slPrice = slPriceVal;
    this.state.phase = 'COOLDOWN';
    this.state.cooldownCandlesRemaining = this.sideCfg.cooldownCandles;
    this.state.lastSLCandleIdx = inp.candleIdx;
    this.state.lastSLPrice = slPriceVal;
    events.push(this.mkEvent('sl_triggered', inp, slPriceVal));
    events.push(this.mkEvent('cooldown_entered', inp));
  }

  private mkEvent(type: ComboEventType, inp: TickInputs, slPriceVal?: number | null): ComboEvent {
    return {
      candleIdx: inp.candleIdx,
      timestamp: inp.timestamp,
      side: this.state.side,
      type,
      phase: this.state.phase,
      snapshot: {
        atr: inp.signals.atr,
        erSmooth: inp.signals.erSmooth,
        rsi: inp.signals.rsi,
        price: inp.price,
        slPrice: slPriceVal ?? null,
      },
    };
  }
}
