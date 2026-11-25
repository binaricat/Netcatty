const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  copyMonacoAssets,
  shouldCopyMonacoAsset,
} = require('./copy-monaco.cjs');

test('shouldCopyMonacoAsset skips unused nls.messages*.js.js locale bundles while keeping loader and core assets', () => {
  const skipped = [
    '/vs/nls.messages.js.js',
    '/vs/nls.messages.zh-cn.js.js',
    '/vs/nls.messages.zh-tw.js.js',
    '/vs/nls.messages.pt-br.js.js',
    '/vs/nls.messages.ja.js.js',
    'C:\\monaco\\vs\\nls.messages.de.js.js',
  ];
  for (const filePath of skipped) {
    assert.equal(shouldCopyMonacoAsset(filePath), false, `expected ${filePath} to be skipped`);
  }

  const kept = [
    '/vs/nls.messages-loader.js',
    '/vs/loader.js',
    '/vs/editor/editor.main.js',
    '/vs/base/worker/workerMain.js',
    '/vs/basic-languages/shell/shell.js',
    '/vs/language/json/jsonWorker.js',
  ];
  for (const filePath of kept) {
    assert.equal(shouldCopyMonacoAsset(filePath), true, `expected ${filePath} to be kept`);
  }
});

test('copyMonacoAssets omits nls.messages*.js.js while preserving nls.messages-loader.js and nested files', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-copy-monaco-'));
  try {
    const src = path.join(tmpRoot, 'src', 'vs');
    const dst = path.join(tmpRoot, 'dst', 'vs');
    fs.mkdirSync(path.join(src, 'editor'), { recursive: true });
    fs.mkdirSync(path.join(src, 'base', 'worker'), { recursive: true });

    fs.writeFileSync(path.join(src, 'nls.messages-loader.js'), '// loader');
    fs.writeFileSync(path.join(src, 'nls.messages.js.js'), '// default messages');
    fs.writeFileSync(path.join(src, 'nls.messages.zh-cn.js.js'), '// zh-cn messages');
    fs.writeFileSync(path.join(src, 'nls.messages.pt-br.js.js'), '// pt-br messages');
    fs.writeFileSync(path.join(src, 'loader.js'), '// amd loader');
    fs.writeFileSync(path.join(src, 'editor', 'editor.main.js'), '// editor');
    fs.writeFileSync(path.join(src, 'base', 'worker', 'workerMain.js'), '// worker');

    copyMonacoAssets(src, dst);

    assert.equal(fs.existsSync(path.join(dst, 'nls.messages-loader.js')), true);
    assert.equal(fs.existsSync(path.join(dst, 'loader.js')), true);
    assert.equal(fs.existsSync(path.join(dst, 'editor', 'editor.main.js')), true);
    assert.equal(fs.existsSync(path.join(dst, 'base', 'worker', 'workerMain.js')), true);

    assert.equal(fs.existsSync(path.join(dst, 'nls.messages.js.js')), false);
    assert.equal(fs.existsSync(path.join(dst, 'nls.messages.zh-cn.js.js')), false);
    assert.equal(fs.existsSync(path.join(dst, 'nls.messages.pt-br.js.js')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('copyMonacoAssets throws when source directory does not exist', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-copy-monaco-missing-'));
  try {
    assert.throws(
      () => copyMonacoAssets(path.join(tmpRoot, 'missing'), path.join(tmpRoot, 'dst')),
      /Source not found/,
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
