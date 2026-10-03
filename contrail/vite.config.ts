import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Multi-page build: the game (index.html) and the Look-Dev Lab (lab/index.html).
// base './' so dist/ runs from any static server path with zero external requests.
export default defineConfig({
  base: './',
  // Docs/ (including the private reference pack) is never served or bundled.
  publicDir: false,
  server: { port: 5173, strictPort: false, host: '127.0.0.1' },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lab: resolve(__dirname, 'lab/index.html'),
      },
    },
  },
});
