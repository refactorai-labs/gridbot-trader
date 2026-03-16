# Add Light Mode + UX Polish

## Plan

### 1. Add light mode CSS variables to `globals.css`
- Add `[data-theme="light"]` selector with light-appropriate CSS variable overrides
- Update body background, grid texture, scrollbar, and select dropdown arrow for light mode

### 2. Create a ThemeToggle component
- Simple Sun/Moon icon toggle button in the header
- Reads/writes `data-theme` on `<html>` element
- Persists preference to `localStorage`

### 3. Update `layout.tsx`
- Add a script to apply saved theme on load (prevent flash of wrong theme)

### 4. Update `TradingChart.tsx` to support theme-aware colors
- Make `CHART_COLORS` in `constants.ts` a function that reads current theme
- Re-initialize chart when theme changes

### 5. Minor UX polish (only necessary changes)
- Review for any visual inconsistencies between modes
- Ensure form selects, badges, and cards look good in both themes

## Tasks
- [x] Add light mode CSS variables
- [x] Create ThemeToggle component
- [x] Update layout.tsx for theme persistence
- [x] Make TradingChart theme-aware
- [x] UX review and minor polish

## Review

### Files changed
- `src/app/globals.css` — Added `[data-theme="light"]` block with full set of light-mode CSS variables; replaced hardcoded rgba values with CSS variables for table borders, timeline scrubber, grid texture, and select arrow; added light-mode card/stat-card shadows; switched btn-long/btn-short to use CSS variables; added body transition for smooth theme switching
- `src/components/ThemeToggle.tsx` — New component: Sun/Moon toggle, persists to localStorage, sets `data-theme` on `<html>`
- `src/app/page.tsx` — Added ThemeToggle import and placed it in the header
- `src/app/layout.tsx` — Added inline `<script>` to apply saved theme before paint (prevents flash)
- `src/lib/constants.ts` — Added `CHART_COLORS_LIGHT` and `getChartColors()` function for theme-aware chart colors
- `src/components/charts/TradingChart.tsx` — Uses `getChartColors()` instead of static `CHART_COLORS`; observes `data-theme` changes via MutationObserver to re-create chart on theme switch; added `theme` to candle data and grid line effect deps so data is re-applied after chart recreation; replaced hardcoded S/R zone colors with theme-aware colors
- `tailwind.config.js` — Changed hardcoded hex colors to CSS variable references so Tailwind utility classes (text-profit, text-loss, etc.) adapt to theme

### Bug found during review
- **TradingChart empty after theme switch**: The chart init effect had `theme` in its deps (correctly recreating the chart), but the candle data and grid line effects did NOT have `theme` in their deps. This meant after a theme switch, the new chart would render empty. Fixed by adding `theme` to both effect dependency arrays.

### Design decisions
- Used `[data-theme="light"]` on `<html>` rather than a media query, so users can manually toggle
- Light mode uses slightly darker green/red/indigo shades for better contrast on light backgrounds
- Cards get subtle box-shadows in light mode to maintain visual hierarchy without dark borders
- Chart fully re-renders on theme change (lightweight-charts doesn't support live color updates)
- Blocking inline script in `<head>` prevents flash of dark theme when user prefers light
