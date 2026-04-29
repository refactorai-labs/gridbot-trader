'use client';

import { Play, Pause, SkipBack, SkipForward, Maximize2, MonitorDot } from 'lucide-react';
import { CSSProperties } from 'react';
import { PlaybackSpeed } from '@/lib/types';

interface PlaybackControlsProps {
  isPlaying: boolean;
  speed: PlaybackSpeed;
  currentIdx: number;
  totalCandles: number;
  currentTime?: string;
  isFitAll: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (idx: number) => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onToggleFitAll: () => void;
}

const SPEEDS: PlaybackSpeed[] = [1, 2, 5, 10];

export default function PlaybackControls({
  isPlaying,
  speed,
  currentIdx,
  totalCandles,
  currentTime,
  isFitAll,
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
  onToggleFitAll,
}: PlaybackControlsProps) {
  const maxIdx = Math.max(0, totalCandles - 1);
  const progressPct = maxIdx > 0 ? (currentIdx / maxIdx) * 100 : 0;
  const scrubberStyle = { '--scrubber-progress': `${progressPct}%` } as CSSProperties;

  return (
    <div className="transport-bar">
      {/* Transport controls */}
      <div className="transport-group">
        <button
          className="playback-btn"
          onClick={() => onSeek(0)}
          title="Go to start"
        >
          <SkipBack size={14} />
        </button>
        <button
          className={`playback-btn transport-play ${isPlaying ? 'active' : ''}`}
          onClick={isPlaying ? onPause : onPlay}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}
        </button>
        <button
          className="playback-btn"
          onClick={() => onSeek(maxIdx)}
          title="Go to end"
        >
          <SkipForward size={14} />
        </button>
      </div>

      {/* Timeline scrubber */}
      <div className="transport-scrubber">
        <input
          type="range"
          className="timeline-scrubber"
          min={0}
          max={maxIdx}
          value={currentIdx}
          onChange={(e) => onSeek(parseInt(e.target.value))}
          style={scrubberStyle}
        />
      </div>

      {/* Candle counter */}
      <div className="transport-readout">
        <span
          className="font-mono tabular-nums"
          style={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--text-primary)',
          }}
        >
          {String(currentIdx + 1).padStart(4, '0')} / {totalCandles}
        </span>
        {currentTime && (
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 9.5,
              fontWeight: 500,
              letterSpacing: '0.06em',
              color: 'var(--text-muted)',
            }}
          >
            {currentTime}
          </span>
        )}
      </div>

      {/* Fit all / Follow toggle */}
      <button
        className={`transport-toggle-btn ${isFitAll ? 'active' : ''}`}
        onClick={onToggleFitAll}
        title={isFitAll ? 'Switch to follow mode' : 'Fit all candles on screen'}
      >
        {isFitAll ? <MonitorDot size={12} /> : <Maximize2 size={12} />}
        <span>{isFitAll ? 'Follow' : 'Fit All'}</span>
      </button>

      {/* Speed selector */}
      <div className="speed-selector">
        {SPEEDS.map(s => (
          <button
            key={s}
            className={`speed-btn ${speed === s ? 'active' : ''}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
