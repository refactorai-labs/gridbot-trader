'use client';

import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import { PlaybackSpeed } from '@/lib/types';

interface PlaybackControlsProps {
  isPlaying: boolean;
  speed: PlaybackSpeed;
  currentIdx: number;
  totalCandles: number;
  currentTime?: string;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (idx: number) => void;
  onSpeedChange: (speed: PlaybackSpeed) => void;
}

const SPEEDS: PlaybackSpeed[] = [1, 2, 5, 10];

export default function PlaybackControls({
  isPlaying,
  speed,
  currentIdx,
  totalCandles,
  currentTime,
  onPlay,
  onPause,
  onSeek,
  onSpeedChange,
}: PlaybackControlsProps) {
  return (
    <div className="card px-4 py-2 flex items-center gap-4">
      {/* Transport controls */}
      <div className="flex items-center gap-1">
        <button
          className="playback-btn"
          onClick={() => onSeek(0)}
          title="Go to start"
        >
          <SkipBack size={14} />
        </button>
        <button
          className={`playback-btn ${isPlaying ? 'active' : ''}`}
          onClick={isPlaying ? onPause : onPlay}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          className="playback-btn"
          onClick={() => onSeek(totalCandles - 1)}
          title="Go to end"
        >
          <SkipForward size={14} />
        </button>
      </div>

      {/* Timeline scrubber */}
      <div className="flex-1 flex items-center gap-3">
        <input
          type="range"
          className="timeline-scrubber flex-1"
          min={0}
          max={Math.max(0, totalCandles - 1)}
          value={currentIdx}
          onChange={(e) => onSeek(parseInt(e.target.value))}
        />
      </div>

      {/* Candle counter */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
          {currentIdx + 1}/{totalCandles}
        </span>
        {currentTime && (
          <span className="text-xs font-mono" style={{ color: 'var(--text-secondary)' }}>
            {currentTime}
          </span>
        )}
      </div>

      {/* Speed selector */}
      <div className="flex items-center gap-0.5 rounded-md p-0.5" style={{ background: 'var(--btn-secondary-bg)' }}>
        {SPEEDS.map(s => (
          <button
            key={s}
            className={`speed-btn ${speed === s ? 'active' : ''}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}x
          </button>
        ))}
      </div>
    </div>
  );
}
