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
    port: 3000,
    host: '0.0.0.0', // Needed for Codespaces port forwarding
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // No sourcemaps in production — OPSEC
  },
});
