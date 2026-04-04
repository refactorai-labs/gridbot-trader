'use client';

import { useState } from 'react';
import { Download, Database, Loader2 } from 'lucide-react';
import { SUPPORTED_PAIRS } from '@/lib/constants';

export default function DataManager() {
  const [selectedPairIdx, setSelectedPairIdx] = useState(0);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [cachedCount, setCachedCount] = useState<number | null>(null);

  const selectedPair = SUPPORTED_PAIRS[selectedPairIdx];
  const binanceSymbol = selectedPair.binanceSymbol;

  const handleDownload = async () => {
    if (!binanceSymbol) {
      setStatus('No Binance symbol configured for this pair');
      return;
    }

    setIsDownloading(true);
    setProgress(0);
    setStatus('Fetching 5m candles from Binance...');

    try {
      const res = await fetch('/api/candles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: binanceSymbol,
          timeframe: '5m',
          startTime: new Date(startDate).toISOString(),
          endTime: new Date(endDate).toISOString(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');

      setCachedCount(data.count);
      setStatus(`Done! ${data.count.toLocaleString()} candles cached.`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleCheckCache = async () => {
    if (!binanceSymbol) return;

    try {
      const params = new URLSearchParams({
        pair: binanceSymbol,
        timeframe: '5m',
        start: new Date(startDate).toISOString(),
        end: new Date(endDate).toISOString(),
      });
      const res = await fetch(`/api/candles?${params}`);
      const data = await res.json();
      setCachedCount(data.count ?? 0);
      setStatus(`${(data.count ?? 0).toLocaleString()} cached candles found.`);
    } catch {
      setStatus('Failed to check cache');
    }
  };

  return (
    <div className="card p-4 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Database size={14} style={{ color: 'var(--grid-neutral)' }} />
        <span className="card-header text-xs">Data Manager</span>
      </div>

      {/* Pair selection */}
      <div>
        <label className="form-label">Trading Pair</label>
        <select
          className="form-select"
          value={selectedPairIdx}
          onChange={(e) => {
            setSelectedPairIdx(parseInt(e.target.value));
            setCachedCount(null);
          }}
        >
          {SUPPORTED_PAIRS.map((pair, idx) => (
            <option key={pair.pair} value={idx}>{pair.label}</option>
          ))}
        </select>
      </div>

      {/* Date range */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="form-label">Start Date</label>
          <input
            type="date"
            className="form-input text-xs"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label">End Date</label>
          <input
            type="date"
            className="form-input text-xs"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleDownload}
          disabled={isDownloading || !binanceSymbol}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded"
          style={{
            backgroundColor: 'var(--accent)',
            color: 'var(--card-bg)',
            opacity: isDownloading || !binanceSymbol ? 0.5 : 1,
          }}
        >
          {isDownloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {isDownloading ? 'Downloading...' : 'Download 5m Data'}
        </button>
        <button
          onClick={handleCheckCache}
          disabled={!binanceSymbol}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded"
          style={{
            backgroundColor: 'var(--card-bg)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        >
          <Database size={12} />
          Check Cache
        </button>
      </div>

      {/* Status */}
      {status && (
        <div
          className="text-xs font-mono px-2 py-1.5 rounded"
          style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--hover-bg)' }}
        >
          {status}
        </div>
      )}

      {cachedCount !== null && (
        <div className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          Cached: {cachedCount.toLocaleString()} candles ({selectedPair.label} 5m)
        </div>
      )}
    </div>
  );
}
