const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const source = path.join(repoRoot, 'node_modules', '@withfig', 'autocomplete', 'build');
const target = path.join(repoRoot, 'public', 'fig-specs');

if (!fs.existsSync(source)) {
  console.error('[copy-fig-specs] Source not found:', source);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });

const count = fs.readdirSync(target).length;
console.log(`[copy-fig-specs] Copied ${count} fig spec files to ${target}`);
