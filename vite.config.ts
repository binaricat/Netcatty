import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// Custom plugin to suppress monaco-editor source map warnings
const suppressMonacoSourcemapWarning = () => ({
  name: 'suppress-monaco-sourcemap-warning',
  apply: 'serve' as const,
  configResolved(config: { logger: { warn: (msg: string, options?: { timestamp?: boolean }) => void } }) {
    const originalWarn = config.logger.warn;
    config.logger.warn = (msg: string, options?: { timestamp?: boolean }) => {
      // Suppress monaco-editor source map warnings
      if (msg.includes('monaco-editor') && msg.includes('source map')) return;
      if (msg.includes('loader.js.map')) return;
      originalWarn(msg, options);
    };
  },
});

export default defineConfig(() => {
    return {
      base: "./",
      server: {
        port: 5173,
        host: 'localhost',
        headers: {
          // Required for SharedArrayBuffer and WASM in some browsers
          'Cross-Origin-Opener-Policy': 'same-origin',
          // Use credentialless to allow loading cross-origin images (e.g. Google avatars)
          // while still enabling crossOriginIsolated.
          'Cross-Origin-Embedder-Policy': 'credentialless',
        },
        hmr: {
          overlay: true,
        },
      },
      build: {
        chunkSizeWarningLimit: 3000,
        target: 'esnext', // Required for top-level await in WASM modules
        sourcemap: false, // Disable source maps to avoid missing map file warnings
        // Optimize chunk splitting for faster initial load
        rollupOptions: {
          output: {
            manualChunks: {
              // Vendor chunks - rarely change, can be cached aggressively
              'vendor-radix': [
                '@radix-ui/react-collapsible',
                '@radix-ui/react-context-menu',
                '@radix-ui/react-dialog',
                '@radix-ui/react-popover',
                '@radix-ui/react-scroll-area',
                '@radix-ui/react-select',
                '@radix-ui/react-tabs',
              ],
              'vendor-xterm': [
                '@xterm/xterm',
                '@xterm/addon-fit',
                '@xterm/addon-search',
                '@xterm/addon-serialize',
                '@xterm/addon-web-links',
                '@xterm/addon-webgl',
              ],
              'vendor-ai': [
                'ai',
                '@ai-sdk/openai',
                '@ai-sdk/anthropic',
                '@ai-sdk/google',
                'zod',
              ],
            },
          },
        },
      },
      plugins: [suppressMonacoSourcemapWarning(), tailwindcss(), react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
