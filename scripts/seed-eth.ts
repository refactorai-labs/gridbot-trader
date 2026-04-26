/**
 * Seed ETH/USDT 5m candles + funding rates for the Combo Bot acceptance run.
 *
 * Usage:
 *   npm run dev                              # in another terminal, start the Next.js app
 *   npx tsx scripts/seed-eth.ts              # seed 2022-01-01 → today (option A)
 *   npx tsx scripts/seed-eth.ts --ytd        # seed Jan 2026 → today only
 *
 * The script POSTS to the existing /api/candles and /api/funding endpoints so the
 * candle / funding caches are populated for both the walk-forward endpoint and the
 * Optuna driver.
 */

const SYMBOL = 'ETHUSDT';
const API = process.env.API_BASE ?? 'http://localhost:3000';

function parseArgs(): { start: string; end: string; label: string } {
  const args = process.argv.slice(2);
  const today = new Date();
  const end = today.toISOString();
  if (args.includes('--ytd')) {
    return {
      start: new Date(`${today.getUTCFullYear()}-01-01T00:00:00.000Z`).toISOString(),
      end,
      label: 'YTD',
    };
  }
  return {
    start: '2022-01-01T00:00:00.000Z',
    end,
    label: 'FULL',
  };
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${path} failed [${res.status}]: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function main(): Promise<void> {
  const { start, end, label } = parseArgs();
  process.stdout.write(`[seed-eth] ${label} window  · ${start}  →  ${end}\n`);

  process.stdout.write(`[seed-eth] Fetching ETHUSDT 5m candles…\n`);
  const candles = await post('/api/candles', {
    pair: SYMBOL,
    timeframe: '5m',
    startTime: start,
    endTime: end,
  });
  process.stdout.write(`[seed-eth] Candles cached: ${String(candles.count ?? '?')}\n`);

  process.stdout.write(`[seed-eth] Fetching ETHUSDT funding rates…\n`);
  const funding = await post('/api/funding', {
    symbol: SYMBOL,
    startTime: start,
    endTime: end,
  });
  process.stdout.write(`[seed-eth] Funding rows cached: ${String(funding.count ?? '?')}\n`);

  process.stdout.write(`[seed-eth] Done.\n`);
}

main().catch(err => {
  process.stderr.write(`[seed-eth] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
