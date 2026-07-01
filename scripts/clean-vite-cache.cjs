const fs = require('fs');
const path = require('path');

const cacheDir = path.join(__dirname, '..', 'node_modules', '.vite');

if (!fs.existsSync(cacheDir)) {
  console.log('[clean-vite] No Vite cache to remove');
  process.exit(0);
}

fs.rmSync(cacheDir, { recursive: true, force: true });
console.log('[clean-vite] Removed', cacheDir);
