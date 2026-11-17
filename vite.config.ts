import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is a plain SPA. In dev, Vite proxies API + WebSocket calls to
// the Fastify server; in production Fastify serves the built files itself.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  // assetsInlineLimit: 0 keeps fonts as files, so the CSP never needs to allow data: fonts.
  build: { outDir: '../dist/web', emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/mcp': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
