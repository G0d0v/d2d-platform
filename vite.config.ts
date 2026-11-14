import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()], root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 19091, strictPort: true, proxy: { '/api': 'http://127.0.0.1:19090' } },
});
