import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = path.join(__dirname, '..', '..', '..');

export default defineConfig({
  root: path.join(__dirname),
  envDir: repoRoot,
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 7779,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7777', changeOrigin: true },
    },
  },
});
