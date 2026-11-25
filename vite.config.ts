import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/webview',
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        sidebar: resolve(__dirname, 'src/webview/sidebar/main.tsx'),
        workbench: resolve(__dirname, 'src/webview/workbench/main.tsx'),
        busPanel: resolve(__dirname, 'src/webview/busPanel/main.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'webview.css';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
