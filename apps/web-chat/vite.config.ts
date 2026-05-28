import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base`：默认 `/`（dev 走 vite proxy）。
 * 生产子路径部署（如 nginx `/webchat/`）：构建时设 `VITE_BASE=/webchat/`：
 *   VITE_BASE=/webchat/ npm -w @utlra/web-chat run build
 */
const BASE = process.env['VITE_BASE'] || '/';

export default defineConfig({
  base: BASE,
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
