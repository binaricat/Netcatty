import { validateTarget } from '@netcatty/plugin-cli';

const target = process.argv[2] || 'dist/netcatty-monitor-0.1.0.ncpkg';
const result = await validateTarget(target);
console.log(`Validated ${result.manifest.id}@${result.manifest.version}: ${target}`);
