// Client-side mirror of the research artifact JSON shape
// (written by scripts/research/run-sample.ts).

export interface ArtifactCandle {
  timestamp: number; // unix seconds (30m bar open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ArtifactEvent {
  type: 'initialOpen' | 'gridFill' | 'partialClose' | 'fullClose' | 'stop' | 'funding';
  timeSec: number;
  leg?: 'long' | 'short';
  orderType?: 'buy' | 'sell';
  price?: number;
  qty?: number;
  fee?: number;
  realizedPnl?: number;
  fraction?: number;
  levelIndex?: number;
  reduceOnly?: boolean;
  fundingRate?: number;
  reason?: string;
}

export interface ArtifactZones {
  anchoredAtSec: number;
  center: number;
  halfWidth: number;
  lower: number;
  upper: number;
  invalidLower: number;
  invalidUpper: number;
  stopLong: number;
  stopShort: number;
  levels: number[];
}

export interface ArtifactCycle {
  startSec: number;
  endSec: number | null;
  zones: ArtifactZones;
}

export interface ArtifactRegimePoint {
  timeSec: number;
  regime: 'warmup' | 'range' | 'trend' | 'volatile';
  er: number;
  phase: string;
}

export interface ArtifactEquityPoint {
  timeSec: number;
  price: number;
  equity: number;
  cash: number;
  unrealized: number;
  longQty: number;
  shortQty: number;
}

export interface ResearchArtifact {
  kind: string;
  generatedAt: string;
  mode: string;
  window: { start: string; end: string };
  capital: number;
  candles30m: ArtifactCandle[];
  events: ArtifactEvent[];
  equity: ArtifactEquityPoint[];
  diagnostics: {
    regimeSeries: ArtifactRegimePoint[];
    anchors: ArtifactZones[];
    cycles: ArtifactCycle[];
    cyclesStarted: number;
    banks: number;
    unwinds: number;
    derisks: number;
    stopsHandled: number;
  };
  summary: {
    equityStart: number;
    equityEnd: number;
    maxDrawdown: number;
    buyHoldReturn: number;
    fundingTotal: number;
    stops: { long: number; short: number };
  };
}
