import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5199, host: '127.0.0.1' },
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
});
