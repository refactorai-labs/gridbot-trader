// DCA-specific types beyond what's in types.ts

import { DCATradeState } from '../types';

export interface SafetyOrderLevel {
  orderNumber: number;       // 1, 2, 3, ...
  deviation: number;         // % from base order price
  size: number;              // USDT
  triggerPrice: number;      // computed based on deviation
}

export interface DCATradeSnapshot {
  candleIdx: number;
  timestamp: number;
  price: number;
  state: DCATradeState;
  avgEntryPrice: number;
  totalInvested: number;
  unrealizedPnl: number;
  realizedPnlCumulative: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  safetyOrdersFilled: number;
}
