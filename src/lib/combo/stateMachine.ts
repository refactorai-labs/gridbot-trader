import {
  GridSide,
  BotPhase,
  BotState,
  ComboBotSideConfig,
  ReopenDiagnostics,
  ReopenContainmentState,
} from '../types';
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
  | 'retry_incremented'
  // Tooltip-only event: emitted on every post-expiry cooldown candle when the
  // reopen-policy gates fail. Carries the four gate booleans via reopenDiagnostics
  // so the chart's failed-gate tooltip can show why the side is still in cooldown.
  // Not surfaced in the event feed/timeline — it's diagnostic data, not a lifecycle
  // event.
  | 'reopen_check_failed';

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
  reopenDiagnostics?: ReopenDiagnostics;
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
  reopenDiagnostics?: ReopenDiagnostics;
}

export interface TickResult {
  instruction: BotInstruction;
  events: ComboEvent[];
}

const TIER2_CONTAINMENT_WINDOW = 24;
const TIER2_CONTAINMENT_RATIO = 0.8;
const TIER3_VALID_CONTAINMENT_CANDLES = 12;

export class ComboBotStateMachine {
  private state: BotState;
  private sideCfg: ComboBotSideConfig;
  private erBelowHibernationCount: number = 0;
  private containment: ReopenContainmentState | null = null;
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
      atrAtLastSL: null,
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
      this.resetContainment();
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
      this.resetContainment();
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
      // Carry the active SL on position_opened so observability paths (chart SL line,
      // ComboPane derivation) can render it without recomputing engine logic.
      const sl = inp.position.avgEntry > 0
        ? slPrice(this.sideCfg, this.state.side, inp.position.avgEntry, inp.signals.atr)
        : null;
      events.push(this.mkEvent('position_opened', inp, sl));
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
      this.resetContainment();
      this.freezeContainmentBand(inp);
      instr.allowNewOrders = true;
      instr.sizeMultiplier = tierSize(1, this.sideCfg);
      events.push(this.mkEvent('tier1_reopen', inp));
    } else if (this.state.cooldownCandlesRemaining <= 0 && inp.reopenDiagnostics) {
      // Timer expired but gates failed — emit a diagnostic-only event so the
      // failed-gate tooltip has per-candle data. mkEvent attaches inp.reopenDiagnostics
      // automatically (line 354). Pre-expiry candles intentionally stay silent;
      // the tooltip shows "no reopen attempt yet" for those.
      events.push(this.mkEvent('reopen_check_failed', inp));
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
        this.resetContainment();
        return;
      }
      const contained = this.recordContainment(inp.price);
      if (this.state.currentTier === 1 && this.tier2ContainmentSatisfied()) {
        this.state.currentTier = 2;
        if (this.containment) this.containment.tier2HoldCount = 0;
        events.push(this.mkEvent('tier2_scale', inp));
      } else if (this.state.currentTier === 2) {
        if (this.containment && contained) this.containment.tier2HoldCount++;
        else if (this.containment) this.containment.tier2HoldCount = 0;

        if ((this.containment?.tier2HoldCount ?? 0) >= TIER3_VALID_CONTAINMENT_CANDLES) {
          this.state.currentTier = 3;
          instr.sizeMultiplier = tierSize(3, this.sideCfg);
          events.push(this.mkEvent('tier3_scale', inp));
          this.state.phase = 'RUNNING';
          this.state.currentTier = 0;
          this.state.retryCount = 0;
          this.resetContainment();
          instr.allowNewOrders = true;
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
      this.state.atrAtLastSL = null;
      this.erBelowHibernationCount = 0;
      this.resetContainment();
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
    if (Number.isFinite(inp.signals.atr) && inp.signals.atr > 0) {
      this.state.atrAtLastSL = inp.signals.atr;
    }
    this.resetContainment();
    events.push(this.mkEvent('sl_triggered', inp, slPriceVal));
    events.push(this.mkEvent('cooldown_entered', inp));
  }

  private resetContainment(): void {
    this.containment = null;
  }

  private freezeContainmentBand(inp: TickInputs): void {
    const width = Number.isFinite(inp.signals.atr) && inp.signals.atr > 0
      ? inp.signals.atr
      : Math.max(0.00000001, inp.price * 0.005);
    this.containment = {
      lower: Math.max(0.00000001, inp.price - width),
      upper: inp.price + width,
      recentCloses: [],
      tier2HoldCount: 0,
    };
  }

  private recordContainment(price: number): boolean {
    if (!this.containment) return false;
    const contained = price >= this.containment.lower && price <= this.containment.upper;
    this.containment.recentCloses.push(contained);
    if (this.containment.recentCloses.length > TIER2_CONTAINMENT_WINDOW) {
      this.containment.recentCloses.shift();
    }
    return contained;
  }

  private tier2ContainmentSatisfied(): boolean {
    if (!this.containment || this.containment.recentCloses.length < TIER2_CONTAINMENT_WINDOW) {
      return false;
    }
    const contained = this.containment.recentCloses.filter(Boolean).length;
    return contained / TIER2_CONTAINMENT_WINDOW >= TIER2_CONTAINMENT_RATIO;
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
      reopenDiagnostics: inp.reopenDiagnostics,
    };
  }
}
