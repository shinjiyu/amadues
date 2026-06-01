import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 更长前缀优先（避免 /api 吞掉 /api2、/api3、/api4、/api5）
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
