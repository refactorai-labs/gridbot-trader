// Shared labels and number formatting for the /pionex components.

import { Verdict } from '@/lib/pionex/types';

export const VERDICT_LABEL: Record<Verdict, { text: string; badge: string; hu: string }> = {
  data_incomplete: { text: 'Data incomplete', badge: 'badge-short', hu: 'Adathiányos — van hiány az ablakban; túlélési állítás nincs.' },
  not_started: { text: 'Not started', badge: 'badge-neutral', hu: 'Nem indult — a közös keret nem fedezte I + E‑t, vagy nincs adat.' },
  path_dependent: { text: 'Path-dependent', badge: 'badge-fill', hu: 'Árútfüggő — az A és B út túlélése, likvidációs ideje (±1 h) vagy ciklusszáma eltér.' },
  liquidated: { text: 'Liquidated', badge: 'badge-short', hu: 'Likvidált — mindkét úton.' },
  borderline: { text: 'Borderline', badge: 'badge-fill', hu: 'Határeset — mindkét úton túlél, de a min. likvidációs távolság < 2 %.' },
  survived: { text: 'Survived', badge: 'badge-long', hu: 'Túlélt — mindkét úton, legalább 2 % likvidációs távolsággal.' },
};

export const fmtTime = (ms: number | null | undefined) =>
  ms == null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
export const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const fmtNum = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
export const fmtPct = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
// A non-positive P_liq means no positive liquidation price (the wallet covers the position).
export const fmtLiq = (x: number | null | undefined) => (x != null && Number.isFinite(x) && x <= 0 ? 'none (≤ 0)' : fmtNum(x));
export const fmtDuration = (ms: number) => {
  const h = ms / 3_600_000;
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`;
};

export const PATH_COLORS = { A: '#60a5fa', B: '#f59e0b' } as const;
export const BOT_COLORS = ['#ef4444', '#d946ef'] as const;
