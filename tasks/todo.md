# Fix: Short grid not placing orders when starting price is above grid

## Root Cause
`initializeOrders()` in `orderMatcher.ts` only places:
- Long: buy orders at levels **below** current price
- Short: sell orders at levels **above** current price

When starting price (2309) is above the short grid's upper bound (2300), **no short sell orders are placed** because all levels are below the price. The short side is permanently inactive.

## Fix
Handle the edge case where price starts outside the grid bounds:
- **Short grid, price above all levels**: place BUY orders at all levels (price will drop into grid, buys fill, counter sells placed one level up)
- **Long grid, price below all levels**: place SELL orders at all levels (price will rise into grid, sells fill, counter buys placed one level down)

## Tasks
- [x] Fix `initializeOrders()` in `src/lib/simulation/orderMatcher.ts`
- [x] Verify TypeScript compiles clean

## Review
Changed `initializeOrders()` to detect when the starting price is outside the grid range:
- For SHORT: when `currentPrice > highestLevel`, places buy orders at all levels instead of nothing
- For LONG: when `currentPrice < lowestLevel`, places sell orders at all levels instead of nothing
- Normal behavior (price within grid) is unchanged
- Only file changed: `src/lib/simulation/orderMatcher.ts`
