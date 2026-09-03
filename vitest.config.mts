import { defineConfig } from 'vitest/config';

/**
 * Webview tests.
 *
 * Separate from the extension host's `node:test` suite because the two run in
 * different runtimes: the host is Node, the webview is a DOM. One runner per
 * target is clearer than bending either to the other's environment.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['webview/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./webview/src/test/setup.ts'],
    coverage: { provider: 'v8', include: ['webview/src/**/*.{ts,tsx}'] }
  }
});
