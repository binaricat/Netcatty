const fs = require('fs');
const path = require('path');

// Netcatty never configures Monaco's `vs/nls` `availableLanguages`, so the
// pre-localized `nls.messages*.js.js` bundles (~1.63 MiB) are never loaded at
// runtime. Keep `nls.messages-loader.js` and all other VS/worker/language files.
const UNUSED_MONACO_NLS_BUNDLE_RE = /^nls\.messages(?:\.[^/\\]+)?\.js\.js$/;

function shouldCopyMonacoAsset(sourcePath) {
  return !UNUSED_MONACO_NLS_BUNDLE_RE.test(path.win32.basename(sourcePath));
}

function copyMonacoAssets(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`[copy-monaco] Source not found: ${source}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) => shouldCopyMonacoAsset(src),
  });
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const source = path.join(repoRoot, 'node_modules', 'monaco-editor', 'min', 'vs');
  const target = path.join(repoRoot, 'public', 'monaco', 'vs');

  try {
    copyMonacoAssets(source, target);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log('[copy-monaco] Copied Monaco VS assets to', target);
}

module.exports = {
  UNUSED_MONACO_NLS_BUNDLE_RE,
  shouldCopyMonacoAsset,
  copyMonacoAssets,
};
