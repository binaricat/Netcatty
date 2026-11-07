import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';

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

const devContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: ws: wss: https: http://localhost:5173",
  "img-src 'self' data: https:",
].join("; ");

const devContentSecurityPolicyPlugin = () => ({
  name: 'dev-content-security-policy',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    return html.replace(
      /content="default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' data: blob: ws: wss: https:; img-src 'self' data: https:;"/,
      `content="${devContentSecurityPolicy}"`,
    );
  },
});

/**
 * Stale pre-bundles return 504 after git pull / npm install. Vite retries the
 * module once optimize finishes — do not full-reload the Electron window.
 * Opening the lazy AI panel pulls `ai` / streamdown; a 504 there used to flash
 * the boot splash and wipe renderer state.
 */
const warnOnOutdatedOptimizeDep = (): Plugin => ({
  name: 'warn-on-outdated-optimize-dep',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.on('finish', () => {
        if (
          res.statusCode === 504
          && req.url?.includes('/node_modules/.vite/deps/')
        ) {
          server.config.logger.warn(
            `[vite] stale optimize dep 504 for ${req.url} (not reloading the app)`,
          );
        }
      });
      next();
    });
  },
});

const VENDOR_CHUNK_PACKAGES: Array<[chunk: string, packages: string[]]> = [
  ['vendor-radix', ['@radix-ui/']],
  ['vendor-xterm', ['@xterm/']],
  ['vendor-ai', ['ai', '@ai-sdk/', 'zod']],
];

/** Group node_modules packages into the vendor chunks; leave everything else to Rollup. */
function resolveVendorChunk(id: string): string | undefined {
  // Rollup also moves unassigned dependencies of manual-chunk modules into
  // that chunk. Vite's dynamic-import preload helper is needed by the startup
  // entry, so give it its own tiny chunk instead of letting it ride along
  // with the (lazily used) AI SDK.
  if (id.includes('vite/preload-helper')) return 'preload-helper';
  const marker = '/node_modules/';
  const index = id.lastIndexOf(marker);
  if (index < 0) return undefined;
  const packagePath = id.slice(index + marker.length);
  for (const [chunk, packages] of VENDOR_CHUNK_PACKAGES) {
    const matches = packages.some((name) => (name.endsWith('/')
      ? packagePath.startsWith(name)
      : packagePath === name || packagePath.startsWith(`${name}/`)));
    if (matches) return chunk;
  }
  return undefined;
}

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
        // The shared runtime is also required by Electron; convert it for browser builds.
        commonjsOptions: {
          include: [/node_modules/, /domain\/systemManager\/containerRuntime\.shared\.cjs$/, /domain\/plugin(?:RuntimePolicy|PermissionDescriptions|ThemePack|RemoteTreePolicy|ViewStylePolicy|GitHubRepository)\.cjs$/],
        },
        chunkSizeWarningLimit: 3000,
        target: 'esnext', // Required for top-level await in WASM modules
        sourcemap: false, // Disable source maps to avoid missing map file warnings
        // Optimize chunk splitting for faster initial load
        rollupOptions: {
          output: {
            // Vendor chunks - rarely change, can be cached aggressively.
            // Function form on purpose: the object form also moves every
            // dependency of the listed packages into the chunk, including
            // Vite's shared preload helper (the AI SDK uses import()). The
            // startup entry then imported that helper from vendor-ai and the
            // whole AI SDK chunk was preloaded and evaluated on every launch.
            manualChunks: resolveVendorChunk,
          },
        },
      },
      plugins: [suppressMonacoSourcemapWarning(), devContentSecurityPolicyPlugin(), warnOnOutdatedOptimizeDep(), tailwindcss(), react()],
      optimizeDeps: {
        include: [
          // Keep the renderer alias pre-bundled so dev serves ESM instead of raw CommonJS.
          '@/domain/systemManager/containerRuntime.shared.cjs',
          '@/domain/pluginRuntimePolicy.cjs',
          '@/domain/pluginGitHubRepository.cjs',
          '@/domain/pluginPermissionDescriptions.cjs',
          '@/domain/pluginThemePack.cjs',
          '@/domain/pluginRemoteTreePolicy.cjs',
          '@/domain/pluginViewStylePolicy.cjs',
          'ai',
          '@ai-sdk/openai',
          '@ai-sdk/anthropic',
          '@ai-sdk/google',
          'streamdown',
          '@streamdown/cjk',
          '@streamdown/code',
          'zod',
        ],
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
          // The ligatures addon pulls lru-cache's node:diagnostics_channel import
          // into the renderer bundle. Stub it; the cache never publishes metrics.
          'node:diagnostics_channel': path.resolve(__dirname, 'infrastructure/shims/nodeDiagnosticsChannel.ts'),
          'diagnostics_channel': path.resolve(__dirname, 'infrastructure/shims/nodeDiagnosticsChannel.ts'),
        }
      }
    };
});
