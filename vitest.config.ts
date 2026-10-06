import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // Automatic JSX runtime for the .tsx UI tests (tsconfig keeps "preserve" for Next).
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
  },
});
