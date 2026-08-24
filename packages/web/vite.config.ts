import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    // The native debug app opens this exact loopback address.  Do not silently
    // fall back to another port, or Tauri can load another project's dev UI.
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4187',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
