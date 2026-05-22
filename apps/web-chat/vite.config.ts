import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api/, ''),
      },
      '/uploads': {
        target: 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8790',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
