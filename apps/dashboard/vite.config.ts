import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Agent 2（shiro）—— 必须排在 /api 前面，否则 /api 规则会优先命中
      '/api2': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/api2/, '/api'),
      },
      // Agent 1（assistant，默认）
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
