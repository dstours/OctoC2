// dashboard/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: process.env['VITE_BASE_URL'] ?? '/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // Pre-bundle libsodium so Vite can resolve its CJS entrypoint correctly.
  optimizeDeps: {
    include: ['libsodium-wrappers'],
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'https://127.0.0.1:8080',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // No sourcemaps in production — OPSEC
  },
});
