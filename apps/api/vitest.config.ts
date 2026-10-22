import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // swc (unlike esbuild) emits decorator metadata, which Nest's DI needs.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
  },
});
