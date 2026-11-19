import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const shared = fileURLToPath(new URL('../../shared', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': shared } },
  server: {
    port: 5173,
    strictPort: true,
    // pnpm keeps packages (and the fonts) in the workspace root, two levels up.
    fs: { allow: [workspaceRoot] },
    proxy: {
      // BUREAU_PORT points the dev server at an office on another port (a demo office, say).
      '/api': { target: `http://127.0.0.1:${process.env.BUREAU_PORT || 8787}`, changeOrigin: false, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});
