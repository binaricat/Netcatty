import { build } from 'esbuild';
import { mkdir, readFile, rm, copyFile, cp, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export async function buildHostViewExample(directory) {
  const root = fileURLToPath(directory);
  await build({ entryPoints: [path.join(root, 'host.js')], outfile: path.join(root, 'dist/host.js'), bundle: true, platform: 'browser', format: 'esm', loader: { '.html': 'text', '.css': 'text' }, minify: true });
  const staging = path.join(root, '.package');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'dist'), { recursive: true });
  for (const file of ['netcatty.plugin.json', 'dist/host.js']) await copyFile(path.join(root, file), path.join(staging, file));
  if (await stat(path.join(root, 'assets')).then((info) => info.isDirectory(), () => false)) await cp(path.join(root, 'assets'), path.join(staging, 'assets'), { recursive: true });
  // Parse at build time so a forgotten view declaration fails before packaging.
  const manifest = JSON.parse(await readFile(path.join(root, 'netcatty.plugin.json'), 'utf8'));
  if (!manifest.contributes?.views?.length) throw new Error('Example has no declared view');
}
