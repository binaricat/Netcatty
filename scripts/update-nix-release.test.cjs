const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

test('update-nix-release writes version and AppImage hashes', () => {
  const root = path.join(__dirname, '..');
  const script = path.join(root, '.github', 'scripts', 'update-nix-release.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcatty-nix-release-'));
  const artifacts = path.join(tmp, 'artifacts');
  fs.mkdirSync(path.join(tmp, 'nix'));
  fs.mkdirSync(artifacts);

  const x64 = Buffer.from('x64 appimage');
  const arm64 = Buffer.from('arm64 appimage');
  fs.writeFileSync(path.join(artifacts, 'Netcatty-1.2.3-linux-x86_64.AppImage'), x64);
  fs.writeFileSync(path.join(artifacts, 'Netcatty-1.2.3-linux-arm64.AppImage'), arm64);

  execFileSync(process.execPath, [script, '--artifacts', artifacts, '--version', 'v1.2.3'], {
    cwd: tmp,
    stdio: 'pipe',
  });

  const releaseNix = fs.readFileSync(path.join(tmp, 'nix', 'release.nix'), 'utf8');
  const x64Hash = `sha256-${crypto.createHash('sha256').update(x64).digest('base64')}`;
  const arm64Hash = `sha256-${crypto.createHash('sha256').update(arm64).digest('base64')}`;

  assert.match(releaseNix, /version = "1\.2\.3";/);
  assert.match(releaseNix, new RegExp(`hash = "${x64Hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}";`));
  assert.match(releaseNix, new RegExp(`hash = "${arm64Hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}";`));
});
