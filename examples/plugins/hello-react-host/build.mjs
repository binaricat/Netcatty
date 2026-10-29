import { build } from 'esbuild';
import { fileURLToPath, URL } from 'node:url';
await build({ entryPoints: [fileURLToPath(new URL('./src/index.tsx', import.meta.url))], outfile: fileURLToPath(new URL('./dist/index.js', import.meta.url)), bundle: true, platform: 'browser', format: 'esm',
  plugins: [{ name: 'host-sdk', setup(buildApi) { buildApi.onResolve({ filter: /^@netcatty\/plugin-sdk$/ }, (args) => ({ path: args.path, external: true })); } }],
  define: { 'process.env.NODE_ENV': '"production"' }, minify: true });
