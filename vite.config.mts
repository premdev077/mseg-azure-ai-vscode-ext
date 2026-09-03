import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * Builds the webview only. The extension host is bundled separately by
 * esbuild.js — the two halves run in different processes and share nothing but
 * the event contract in `src/events`, which the webview imports directly so
 * there is one definition rather than two that can drift.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./webview', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./media/webview', import.meta.url)),
    emptyOutDir: true,
    // A webview loads its assets by URL from the extension, so the filenames
    // have to be predictable rather than content-hashed.
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: 'app.[ext]'
      }
    },
    // Sourcemaps are for the diagnostics build, not the shipped default.
    sourcemap: process.env.WEBVIEW_SOURCEMAP === 'true',
    target: 'es2022',
    // The UI is small; one file loads faster than several across the bridge.
    cssCodeSplit: false,
    reportCompressedSize: false
  }
});
