'use client';

import { Dispatch, SetStateAction, useEffect, useState } from 'react';

// Namespace for every persisted config field. Bump the version suffix to
// invalidate all stored config at once. Mirrors the pattern in
// `src/components/combo/ComboOverlayPanel.tsx`.
export const CONFIG_PREFIX = 'gridbot.config.v1.';

/**
 * Drop-in replacement for `useState` that persists the value to localStorage
 * under `CONFIG_PREFIX + key`, so config inputs survive page reloads.
 *
 * SSR-safe: initialises to the default on both server and client (no hydration
 * mismatch), then loads the stored value in a mount effect. Writes on change.
 */
export function usePersistentState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const storageKey = CONFIG_PREFIX + key;

  // Load once on mount. `hydrated` must be STATE, not a ref: the save effect
  // runs in the same commit as this load effect, and a ref would already read
  // `true` there — causing it to persist the default and clobber stored data.
  // As state, the save effect's mount-run closure captures `hydrated === false`
  // and skips that first write (also safe under React StrictMode double-invoke).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch { /* noop */ }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every change after the initial load.
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch { /* noop */ }
  }, [storageKey, value, hydrated]);

  return [value, setValue];
}

/** Remove every persisted config key so the form reverts to its defaults. */
export function clearPersistentConfig(): void {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(CONFIG_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch { /* noop */ }
}
