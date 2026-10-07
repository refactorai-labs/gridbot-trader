// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import GridSideConfig from '../components/config/GridSideConfig';
import ConfigPanel from '../components/config/ConfigPanel';
import TradeLog from '../components/results/TradeLog';
import PerformanceSummary from '../components/results/PerformanceSummary';
import AdaptiveStatus from '../components/simulation/AdaptiveStatus';
import EventLog from '../components/simulation/EventLog';
import { DEFAULT_COMBO_CONFIG } from '../components/config/ComboBotConfig';
import type { GridSideConfig as GridSideConfigType, SimulationConfig, SimulationSummary, DCABreakoutConfig } from '../lib/types';

// Classic grid UI (plan v4, C1.7): component-level checks with fixture data.

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const side = (s: 'long' | 'short', o: Partial<GridSideConfigType> = {}): GridSideConfigType => ({
  side: s, gridLevels: 10, gridType: 'arithmetic', upperBound: 0, lowerBound: 0,
  orderSizeType: 'fixed', orderSize: 100, totalCapital: 5000, profitMode: 'next_level', ...o,
});

describe('GridSideConfig', () => {
  it('keeps total capital user-set and shows the (N−1) funding estimate', () => {
    const onChange = vi.fn();
    render(<GridSideConfig side="long" config={side('long')} onChange={onChange} />);
    expect(screen.getByText(/Funding estimate: 9 slots \(N−1\) × \$100 = \$900/)).toBeTruthy();

    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    const orderSize = inputs.find(i => i.value === '100')!;
    fireEvent.change(orderSize, { target: { value: '250' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ orderSize: 250, totalCapital: 5000 }));

    const capital = inputs.find(i => i.value === '5000')!;
    fireEvent.change(capital, { target: { value: '1234' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ totalCapital: 1234, orderSize: 100 }));
  });
});

describe('ConfigPanel', () => {
  const dca = { direction: 'LONG' } as unknown as DCABreakoutConfig;
  function renderPanel(o: { long: boolean; short: boolean; combo?: boolean }) {
    const onRun = vi.fn<(c: SimulationConfig) => void>();
    localStorage.setItem('gridbot.config.v1.longConfig', JSON.stringify(side('long', { lowerBound: 90, upperBound: 110 })));
    localStorage.setItem('gridbot.config.v1.shortConfig', JSON.stringify(side('short'))); // no bounds
    render(
      <ConfigPanel
        selectedPairIdx={0} onPairChange={() => {}} onRunSimulation={onRun} isRunning={false}
        isCollapsed={false} onToggleCollapse={() => {}}
        gridLongEnabled={o.long} gridShortEnabled={o.short} dcaLongEnabled={false} dcaShortEnabled={false}
        onGridLongToggle={() => {}} onGridShortToggle={() => {}} onDcaLongToggle={() => {}} onDcaShortToggle={() => {}}
        dcaLongConfig={dca} dcaShortConfig={dca} onDcaLongConfigChange={() => {}} onDcaShortConfigChange={() => {}}
        comboConfig={{ ...DEFAULT_COMBO_CONFIG, enabled: !!o.combo }} onComboConfigChange={() => {}}
      />,
    );
    return onRun;
  }

  it('sends enabled per side, checks bounds only for enabled sides, adaptive off by default', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onRun = renderPanel({ long: true, short: false });
    fireEvent.click(screen.getByText('Run Simulation'));
    expect(alertSpy).not.toHaveBeenCalled();
    const cfg = onRun.mock.calls[0][0];
    expect(cfg.longConfig.enabled).toBe(true);
    expect(cfg.shortConfig.enabled).toBe(false);
    expect(cfg.adaptiveEnabled).toBe(false);
  });

  it('alerts when an enabled side has no bounds', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onRun = renderPanel({ long: true, short: true });
    fireEvent.click(screen.getByText('Run Simulation'));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(onRun).not.toHaveBeenCalled();
  });

  it('Combo requests carry no per-side enabled flag', () => {
    const onRun = renderPanel({ long: false, short: false, combo: true });
    fireEvent.click(screen.getByText('Run Simulation'));
    const cfg = onRun.mock.calls[0][0];
    expect('enabled' in cfg.longConfig).toBe(false);
    expect('enabled' in cfg.shortConfig).toBe(false);
    expect(cfg.combo?.enabled).toBe(true);
  });

  it('shows the adaptive checkpoint note', () => {
    renderPanel({ long: true, short: false });
    fireEvent.click(screen.getByText('Adaptive Layer'));
    expect(screen.getByText('Adaptive layer is unavailable until checkpoint 3')).toBeTruthy();
  });
});

describe('TradeLog', () => {
  it('shows role, quantity and position id; legacy rows show —', async () => {
    const trades = [
      { id: 'v1', side: 'long', level: 2, levelPrice: 100, orderType: 'buy', fillPrice: 100, fillCandleIdx: 0, pnl: null, status: 'filled', role: 'initial', quantity: 1.5, positionId: 'long-2-0' },
      { id: 'v0', side: 'short', level: 3, levelPrice: 110, orderType: 'sell', fillPrice: 110, fillCandleIdx: 1, pnl: 2, status: 'filled' },
    ];
    render(<TradeLog trades={trades} />);
    expect(screen.getByText('initial')).toBeTruthy();
    expect(screen.getByText('1.500000')).toBeTruthy();
    expect(screen.getByText('long-2-0')).toBeTruthy();
    const legacyRow = screen.getByText('L3').closest('tr')!;
    expect(legacyRow.textContent!.match(/—/g)!.length).toBe(3);

    let blob: Blob | undefined;
    // jsdom has no object URLs; stub them for the export.
    Object.assign(URL, {
      createObjectURL: (b: Blob) => { blob = b; return 'blob:x'; },
      revokeObjectURL: () => {},
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByTitle('Export CSV'));
    const text = await new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob!);
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Side,Type,Role,Level,Price,Fill Price,Quantity,Position,P&L,Status');
    expect(lines[1]).toBe('long,buy,initial,2,100,100,1.5,long-2-0,,filled');
    expect(lines[2]).toBe('short,sell,,3,110,110,,,2.0000,filled');
  });
});

describe('PerformanceSummary', () => {
  const base: SimulationSummary = {
    id: 's', name: 'n', pair: 'ETH', timeframe: '1h', status: 'completed', createdAt: '', startTime: '', endTime: '',
    totalPnl: 12.5, totalPnlPct: 1.25, longPnl: 10, shortPnl: 2.5, totalTrades: 9, maxDrawdown: 4, maxDrawdownPct: 0.4,
    winCount: 3, lossCount: 1,
  };

  it('classic v1 shows net/gross/fees/unrealized, round-trip win rate and skipped entries', () => {
    render(<PerformanceSummary simulation={{
      ...base, engineVersion: 1, comboBotEnabled: false, realizedPnl: 15, totalFees: 3.25, unrealizedPnl: 0.75,
      roundTrips: 4, skippedEntries: 17,
    }} />);
    expect(screen.getByText('Total P&L (net)')).toBeTruthy();
    expect(screen.getByText('Realized (gross)')).toBeTruthy();
    expect(screen.getByText('$15.00')).toBeTruthy();
    expect(screen.getByText('$3.25')).toBeTruthy();
    expect(screen.getByText('$0.75')).toBeTruthy();
    expect(screen.getByText('Win Rate (round-trips)')).toBeTruthy();
    expect(screen.getByText('75.0')).toBeTruthy();
    expect(screen.getByText('3W / 1L · 4 round-trips')).toBeTruthy();
    expect(screen.getByText('Fills')).toBeTruthy();
    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.queryByText('Total Trades')).toBeNull();
  });

  it('classic v1 win rate counts break-even round-trips in the denominator', () => {
    const v1 = { ...base, engineVersion: 1, comboBotEnabled: false };
    const { unmount } = render(<PerformanceSummary simulation={{ ...v1, winCount: 1, lossCount: 0, roundTrips: 2 }} />);
    expect(screen.getByText('50.0')).toBeTruthy();
    expect(screen.getByText('1W / 0L · 2 round-trips')).toBeTruthy();
    unmount();
    render(<PerformanceSummary simulation={{ ...v1, winCount: 0, lossCount: 0, roundTrips: 3 }} />);
    expect(screen.getByText('0.0')).toBeTruthy();
    expect(screen.getByText('0W / 0L · 3 round-trips')).toBeTruthy();
  });

  it('legacy rows keep the old cards', () => {
    render(<PerformanceSummary simulation={{ ...base, engineVersion: 0 }} />);
    expect(screen.getByText('Total P&L')).toBeTruthy();
    expect(screen.getByText('Total Trades')).toBeTruthy();
    expect(screen.queryByText('Realized (gross)')).toBeNull();
    expect(screen.getByText('3W / 1L · 9 trades')).toBeTruthy();
  });
});

describe('AdaptiveStatus', () => {
  it('shows a one-line note only when state events were compacted', () => {
    const { rerender } = render(<AdaptiveStatus events={[]} currentCandleIdx={0} compactedStateEvents={0} />);
    expect(screen.queryByText(/thinned/)).toBeNull();
    rerender(<AdaptiveStatus events={[]} currentCandleIdx={0} compactedStateEvents={1234} />);
    expect(screen.getByText(/1,234 state events thinned/)).toBeTruthy();
  });
});

describe('EventLog', () => {
  const skip = (i: number) => ({
    id: i, candleIdx: i, timestamp: 0, eventType: 'entry_skipped', longMultiplier: null, shortMultiplier: null,
    details: { side: 'long', slotIndex: i, firstCandleIdx: i, lastCandleIdx: i + 4, skippedCandles: 5, shortfall: 12.5 },
  });
  let urls: string[];

  beforeEach(() => { urls = []; });

  it('pages through diagnostics with Load more', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset'));
      const events = offset === 0
        ? Array.from({ length: 200 }, (_, i) => skip(i))
        : [skip(200), { id: 'r', candleIdx: 201, timestamp: 0, eventType: 'restoration_entry', longMultiplier: null, shortMultiplier: null,
            details: JSON.stringify({ side: 'short', slotIndex: 7, price: 101.5, quantity: 0.25 }) }];
      return { ok: true, status: 200, json: async () => ({ events, total: 202, offset, limit: 200 }) } as Response;
    }) as typeof fetch;

    await act(async () => { render(<EventLog simulationId="sim1" total={202} />); });
    expect(urls[0]).toBe('/api/simulations/sim1/events?types=entry_skipped%2Crestoration_entry&offset=0&limit=200');
    expect(screen.getByText('200 / 202')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByText('Load more')); });
    expect(urls[1]).toContain('offset=200');
    expect(screen.getByText('202 / 202')).toBeTruthy();
    expect(screen.queryByText('Load more')).toBeNull();
    expect(screen.getByText('$101.50 × 0.250000')).toBeTruthy();
    expect(screen.getAllByText('$12.50').length).toBe(201);
  });

  it('shows an error state', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'db down' }) }) as Response) as typeof fetch;
    await act(async () => { render(<EventLog simulationId="sim1" total={5} />); });
    expect(screen.getByText('Failed to load diagnostics: db down')).toBeTruthy();
  });
});
