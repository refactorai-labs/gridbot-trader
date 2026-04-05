# Change Purple/Indigo to Dark Blue

## Tasks
- [x] Update `globals.css` dark theme vars (`--grid-neutral`, `--adaptive-accent`, `--input-focus`)
- [x] Update `globals.css` light theme vars
- [x] Update `.btn-primary` gradient and shadows (with light theme override)
- [x] Convert all hard-coded `rgba(...)` to use `var(--grid-neutral-rgb)` for theme-awareness
- [x] Add global `input[type="checkbox"]` accent-color rule
- [x] Remove Tailwind `accent-*` classes from DCAConfig.tsx and ConfigPanel.tsx
- [x] Update BB color in DCAChart.tsx to be theme-aware
- [x] Update selected row rgba in OptimizerTab.tsx to use CSS variable
- [x] Update header icon box + status message rgba in page.tsx to use CSS variable

## Review

**Problem found during design review:** The initial implementation used `#1e3a8a` (blue-900) everywhere — a very dark blue that's nearly invisible on the dark theme's near-black background (`rgb(8, 10, 18)`). Contrast ratio was ~2:1, far below usable.

**Solution: Theme-adaptive blue palette using `--grid-neutral-rgb`**

| Element | Dark Theme | Light Theme |
|---------|-----------|-------------|
| `--grid-neutral` | `#3b82f6` (blue-500) | `#1e40af` (blue-800) |
| `--adaptive-accent` | `#2563eb` (blue-600) | `#1e3a8a` (blue-900) |
| `--grid-neutral-rgb` | `59, 130, 246` | `30, 64, 175` |
| `.btn-primary` gradient | `#2563eb` → `#1d4ed8` | `#1e40af` → `#172554` |

**Key design decisions:**
- Introduced `--grid-neutral-rgb` CSS variable containing the RGB triplet, so all `rgba()` overlays (badges, active states, focus rings, shadows) automatically adapt per theme
- Dark theme uses brighter blue for visibility; light theme uses darker blue for authority
- Button gets explicit light theme override for the darker gradient
- Checkbox accent colors now use global CSS rule (`accent-color: var(--grid-neutral)`) instead of Tailwind classes — cleaner and theme-aware
- DCAChart BB overlay uses JS-based theme detection since canvas colors can't use CSS variables

**Files changed:** `globals.css`, `DCAConfig.tsx`, `ConfigPanel.tsx`, `DCAChart.tsx`, `OptimizerTab.tsx`, `page.tsx`

**Impact:** Color values only — no logic changes.
