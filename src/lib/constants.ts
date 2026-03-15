import { PairConfig } from './types';

// Known trading pairs with their GeckoTerminal pool addresses
// Using highest-liquidity USDC pools on Ethereum mainnet
export const SUPPORTED_PAIRS: PairConfig[] = [
  {
    label: 'ETH/USD',
    pair: 'WETH/USDC',
    poolAddress: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // Uniswap V3 WETH/USDC 0.05%
    chain: 'eth',
  },
  {
    label: 'BTC/USD',
    pair: 'WBTC/USDC',
    poolAddress: '0x99ac8ca7087fa4a2a1fb6357269965a2014abc35', // Uniswap V3 WBTC/USDC 0.3%
    chain: 'eth',
  },
];

// Timeframe configurations
export const TIMEFRAMES = [
  { value: '1h', label: '1H', apiTimeframe: 'hour' as const, aggregate: 1 },
  { value: '4h', label: '4H', apiTimeframe: 'hour' as const, aggregate: 4 },
] as const;

// Default grid configuration
export const DEFAULT_GRID_CONFIG = {
  gridLevels: 10,
  gridType: 'arithmetic' as const,
  orderSizeType: 'fixed' as const,
  orderSize: 100, // $100 per order
  totalCapital: 5000, // $5000 per side
  profitMode: 'next_level' as const,
};

// Default simulation settings
export const DEFAULT_SIMULATION = {
  feeRate: 0.001, // 0.1%
  adaptiveEnabled: true,
  emaPeriod: 50,
  volumeMultiplier: 1.5,
  timeframe: '1h',
};

// GeckoTerminal API config
export const GECKO_API = {
  baseUrl: 'https://api.geckoterminal.com/api/v2',
  maxRetries: 3,
  initialRetryDelay: 2000,
  requestDelay: 2100, // ~28 requests/min (under 30/min limit)
  candlesPerRequest: 1000,
};

// Adaptive layer defaults
export const ADAPTIVE_DEFAULTS = {
  emaPeriod: 50,
  trendThreshold: 0.001, // 0.1% EMA difference for trend detection
  volumeBreakoutMultiplier: 1.5,
  volumeAvgPeriod: 20,
  deRiskPhase1Pct: 0.0, // At boundary
  deRiskPhase2Pct: 0.02, // 2% beyond boundary
  deRiskClosePct: 0.04, // 4% beyond boundary
  reEntryCandles: 3, // Candles needed to confirm re-entry
};

// Chart colors
export const CHART_COLORS = {
  background: '#0a0c14',
  text: 'rgba(255, 255, 255, 0.6)',
  gridLines: 'rgba(255, 255, 255, 0.03)',
  longGrid: '#10b981',
  longGridDim: 'rgba(16, 185, 129, 0.15)',
  shortGrid: '#ef4444',
  shortGridDim: 'rgba(239, 68, 68, 0.15)',
  fillFlash: '#facc15',
  supportZone: 'rgba(16, 185, 129, 0.08)',
  resistanceZone: 'rgba(239, 68, 68, 0.08)',
  upCandle: '#10b981',
  downCandle: '#ef4444',
};
