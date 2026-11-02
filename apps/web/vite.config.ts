import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy /api and /collab to the local services so the app always uses relative URLs,
// exactly as it does behind Caddy in production.
const api = process.env.BEE_API_URL ?? 'http://localhost:8421';
const collab = process.env.BEE_COLLAB_URL ?? 'ws://localhost:8422';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/mcp': { target: api, changeOrigin: true },
      '/oauth': { target: api, changeOrigin: true },
      '/.well-known/oauth-': { target: api, changeOrigin: true },
      '/collab': { target: collab, ws: true, changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 4000 },
  test: { environment: 'jsdom' },
} as Parameters<typeof defineConfig>[0]);
