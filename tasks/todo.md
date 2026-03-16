# Add Grid Profit Breakdown (Long/Short)

## Plan

### Problem
The CombinedPnL panel shows Total P&L (realized + unrealized) and a long/short breakdown, but the long/short values come from `simulation.longPnl`/`shortPnl` (final end values), NOT from the live snapshot. Also, there's no separate "Grid Profit" metric (realized-only, like Pionex shows).

### Changes needed

1. **`src/lib/types.ts`** — Add `longRealizedPnl`, `shortRealizedPnl`, `longUnrealizedPnl`, `shortUnrealizedPnl` to `SnapshotData`
2. **`src/lib/simulation/pnlTracker.ts`** — Update `createSnapshot` to include per-side realized and unrealized values
3. **`src/components/simulation/CombinedPnL.tsx`** — Redesign to show Grid Profit (realized) separately from Total P&L, with per-side breakdown
4. **`src/app/page.tsx`** — Pass per-side snapshot values instead of final simulation values

## Tasks
- [ ] Add per-side P&L fields to SnapshotData type
- [ ] Update createSnapshot to populate new fields
- [ ] Update CombinedPnL component with grid profit display
- [ ] Update page.tsx to pass snapshot data
- [ ] Test that TypeScript compiles clean

## Review
(To be filled after completion)
