import { describe, it, expect } from 'vitest';
import { PionexLedger } from '../lib/pionex/ledger';
import { Capital } from '../lib/pionex/capital';
import { liqPrice, fullGridLiqPrice } from '../lib/pionex/liquidation';
import { gridLevels } from '../lib/pionex/gridLevels';
import { BotState } from '../lib/pionex/types';

const emptyBot = (n = 10): BotState => ({
  levels: gridLevels(90, 110, n, 'arithmetic'),
  slotQty: 100,
  held: Array(n).fill(null),
  wallet: 0,
  qty: 0,
  avgEntry: 0,
  status: 'active',
  rounds: 0,
  gridProfit: 0,
});

describe('pionex grid levels (plan §3.1)', () => {
  it('arithmetic and geometric levels', () => {
    expect(gridLevels(90, 110, 10, 'arithmetic')).toEqual([90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110]);
    const g = gridLevels(100, 400, 2, 'geometric');
    expect(g[0]).toBe(100);
    expect(g[1]).toBeCloseTo(200, 9);
    expect(g[2]).toBe(400);
  });
});

describe('pionex ledger (plan §3.2)', () => {
  it('a round trip deducts each fee exactly once', () => {
    const l = new PionexLedger(new Capital(1000), emptyBot());
    l.fund(100);
    const buyFee = l.buy(4, 1, 98, 0.001);
    expect(buyFee).toBeCloseTo(0.098, 12);
    expect(l.bot.wallet).toBeCloseTo(100 - 0.098, 12);
    l.sell(4, 100, 0.001);
    expect(l.totals.fees).toBeCloseTo(0.098 + 0.1, 12);
    expect(l.bot.wallet).toBeCloseTo(100 + 2 - 0.198, 12);
    expect(l.bot.gridProfit).toBeCloseTo(2 - 0.198, 12);
    expect(l.bot.qty).toBe(0);
    expect(l.bot.rounds).toBe(1);
    expect(l.invariantError()).toBeLessThan(1e-12);
  });

  it('average-price accounting: a sell realizes against avgEntry, the display pairs by lot', () => {
    const l = new PionexLedger(new Capital(1000), emptyBot());
    l.fund(100);
    l.buy(5, 1, 100, 0);
    l.buy(4, 1, 98, 0);
    expect(l.bot.avgEntry).toBe(99);
    l.sell(4, 100, 0); // lot bought at 98
    expect(l.totals.realizedTradePnl).toBe(1); // 1·(100 − 99)
    expect(l.bot.gridProfit).toBe(2);           // 1·(100 − 98)
    expect(l.bot.avgEntry).toBe(99);
    expect(l.equity(100)).toBe(102); // same equity either way
  });

  it('funding: long pays on a positive rate, receives on a negative one', () => {
    const l = new PionexLedger(new Capital(1000), emptyBot());
    l.fund(100);
    l.buy(5, 2, 100, 0);
    expect(l.funding(0.001, 110)).toBeCloseTo(0.22, 12);
    expect(l.bot.wallet).toBeCloseTo(99.78, 12);
    expect(l.funding(-0.001, 110)).toBeCloseTo(-0.22, 12);
    expect(l.bot.wallet).toBeCloseTo(100, 12);
  });

  it('top-up is a cash move capped at freeCash; liquidation loses the wallet; invariant holds', () => {
    const l = new PionexLedger(new Capital(150), emptyBot());
    l.fund(100);
    l.buy(5, 1, 100, 0.001);
    expect(l.topUp(80)).toBe(50);
    expect(l.freeCash).toBe(0);
    l.funding(0.01, 100);
    expect(l.invariantError()).toBeLessThan(1e-12);
    const lost = l.liquidate();
    expect(lost).toBeCloseTo(150 - 0.1 - 1, 12);
    expect(l.bot.status).toBe('liquidated');
    expect(l.bot.qty).toBe(0);
    expect(l.invariantError()).toBeLessThan(1e-12);
  });

  it('start is rejected when the common capital does not cover I + E', () => {
    const l = new PionexLedger(new Capital(50), emptyBot());
    expect(l.fund(100)).toBe(false);
    expect(l.freeCash).toBe(50);
  });
});

describe('pionex liquidation prices (plan §3.4.4)', () => {
  it('P_liq = (qty·avg − wallet) / (qty·(1 − mmr)); flat → null', () => {
    expect(liqPrice(10, 100, 100, 0)).toBe(90);
    expect(liqPrice(10, 100, 100, 0.005)).toBeCloseTo(900 / 9.95, 12);
    expect(liqPrice(0, 0, 100, 0.005)).toBeNull();
  });

  it('full-grid P_liq assumes every open buy fills at its level', () => {
    const bot = emptyBot();
    const l = new PionexLedger(new Capital(1000), bot);
    l.fund(200);
    for (let i = 5; i < 10; i++) l.buy(i, 1, 100, 0); // 5 lots at 100
    let qty = 5, cost = 500;
    for (let i = 0; i < 5; i++) { qty += 100 / bot.levels[i]; cost += 100; }
    expect(fullGridLiqPrice(bot, 0, 0)).toBeCloseTo((cost - 200) / qty, 9);
    expect(fullGridLiqPrice(bot, 0, 0)!).toBeGreaterThan(liqPrice(5, 100, 200, 0)!);
  });
});
