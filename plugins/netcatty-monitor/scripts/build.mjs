import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

await rm('dist/package', { recursive: true, force: true });
await mkdir('dist/package', { recursive: true });

const result = await build({
  entryPoints: { browser: 'src/index.tsx' },
  outdir: 'dist/package',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  metafile: true,
});

await writeFile('dist/build-inputs.json', JSON.stringify(result.metafile, null, 2));

for (const file of ['netcatty.plugin.json', 'LICENSE', 'README.md']) {
  await cp(file, `dist/package/${file}`);
}
await cp('assets', 'dist/package/assets', { recursive: true });

async function checkNoDynamicEval(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await checkNoDynamicEval(full);
    } else if (entry.name.endsWith('.js')) {
      const code = await readFile(full, 'utf8');
      if (/\b(?:eval|new Function)\(/.test(code)) {
        throw new Error(`Dynamic evaluation in plugin bundle: ${full}`);
      }
    }
  }
}

await checkNoDynamicEval('dist/package');
console.log('Built plugins/netcatty-monitor -> dist/package');
