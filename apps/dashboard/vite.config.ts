import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 更长前缀优先（避免 /api 吞掉 /api2…/api8）
      '/api8': {
        target: 'http://127.0.0.1:8798',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api8/, '/api'),
      },
      '/api7': {
        target: 'http://127.0.0.1:8797',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api7/, '/api'),
      },
      '/api6': {
        target: 'http://127.0.0.1:8796',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api6/, '/api'),
      },
      '/api5': {
        target: 'http://127.0.0.1:8793',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api5/, '/api'),
      },
      '/api4': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api4/, '/api'),
      },
      '/api3': {
        target: 'http://127.0.0.1:8789',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api3/, '/api'),
      },
      '/api2': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api2/, '/api'),
      },
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
