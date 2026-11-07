import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildPluginPackage } from '@netcatty/plugin-cli';
const root = path.dirname(fileURLToPath(import.meta.url));
export async function prepareTerminalDraftExample(outputPath) {
  const stage = await fs.mkdtemp(path.join(path.dirname(outputPath), '.terminal-draft-'));
  try {
    await fs.copyFile(path.join(root, 'netcatty.plugin.json'), path.join(stage, 'netcatty.plugin.json'));
    const bundle = await build({ entryPoints: [path.join(root, 'browser.js')], write: false, bundle: true, minify: true, platform: 'browser', format: 'esm' });
    await fs.writeFile(path.join(stage, 'browser.js'), bundle.outputFiles[0].contents);
    return await buildPluginPackage(stage, outputPath);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node prepare.mjs <output.ncpkg>');
  process.stdout.write(`${JSON.stringify(await prepareTerminalDraftExample(path.resolve(process.argv[2])))}\n`);
}
