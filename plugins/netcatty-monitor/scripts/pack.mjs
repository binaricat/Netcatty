import { packPlugin, validateTarget, checkPluginCompatibility } from '@netcatty/plugin-cli';
import { writeFile } from 'node:fs/promises';

const stage = await validateTarget('dist/package');
const features = stage.manifest.features?.required ?? [];
const compat = checkPluginCompatibility(stage.manifest, {
  netcattyVersion: '0.0.0',
  apiVersion: '0.1.0-internal.1',
  features,
});
if (!compat.compatible) {
  throw new Error(compat.errors.join('\n'));
}

const fileName = `netcatty-monitor-${stage.manifest.version}.ncpkg`;
const result = await packPlugin('dist/package', `dist/${fileName}`);
await validateTarget(result.outputPath);
await writeFile('dist/SHA256SUMS', `${result.sha256}  ${fileName}\n`);
console.log(`Validated ${result.fileCount} files: ${result.outputPath}\nSHA256 ${result.sha256}`);
