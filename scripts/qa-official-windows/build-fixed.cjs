// Trusted exact-SHA source build only. No Actions credentials reach npm/build.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const pinned = require('./fixed-candidate.json');
const source = path.resolve(process.env.QA_FIX_SOURCE);
const output = path.resolve(process.env.QA_BUILD_OUTPUT);
const report = { ...pinned, origin: 'CI QA-built from exact trusted same-repository fix; unsigned, unreleased, no automatic updater certification', run: process.env.GITHUB_RUN_ID, qaHead: process.env.QA_HEAD_SHA, node: process.version, platform: process.platform, arch: process.arch, steps: [] };
const logs = [];
function environment() {
  const allowed = ['PATH', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN', 'USERDNSDOMAIN', 'COMPUTERNAME', 'SESSIONNAME', 'PSModulePath', 'PSHOME', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP'];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return { ...env, CI: 'true', BUNDLE_MOSH: 'false', BUNDLE_ET: 'false', ELECTRON_BUILDER_PUBLISH: 'never', CSC_IDENTITY_AUTO_DISCOVERY: 'false', NPM_CONFIG_FETCH_RETRIES: '4', NPM_CONFIG_FETCH_RETRY_FACTOR: '2', NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '1000', NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '10000' };
}
const safe = environment();
function git(...args) { return execFileSync('git', args, { cwd: source, env: safe, encoding: 'utf8', timeout: 30000 }).trim(); }
async function digest(file) { const hash = crypto.createHash('sha256'); for await (const part of fs.createReadStream(file)) hash.update(part); return hash.digest('hex'); }
async function main() {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  fs.mkdirSync(output, { recursive: true });
  assert.equal(git('rev-parse', 'HEAD'), pinned.sha);
  assert.equal(git('config', '--get', 'remote.origin.url').replace(/\.git$/, ''), `https://github.com/${pinned.repository}`);
  assert.equal(git('status', '--porcelain'), '', 'Exact source checkout must begin clean');
  const originalSourceHash = await digest(path.join(source, 'application/state/useAIState.ts'));
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { env: safe, encoding: 'utf8', timeout: 30000 }).trim();
  assert(installation, 'Stock Windows hosted MSVC installation required');
  const vsScript = path.join(installation, 'Common7/Tools/Launch-VsDevShell.ps1');
  assert(fs.existsSync(vsScript));
  const script = `$ErrorActionPreference = 'Stop'
    & $env:QA_VS_SCRIPT -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
    if (-not $?) { throw 'MSVC developer shell failed' }
    Set-Location -LiteralPath $env:QA_FIX_SOURCE
    Write-Output 'QA_BUILD_STEP npm ci'
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'QA_BUILD_STEP repository non-release version metadata'
    & npm.cmd pkg set "version=$env:QA_FIX_VERSION"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'QA_BUILD_STEP npm run pack:win-x64 -- publish never'
    & npm.cmd run pack:win-x64
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'QA_BUILD_STEP packaged SSH cipher verification'
    & node scripts/test-packaged-ssh-ciphers.cjs
    exit $LASTEXITCODE`;
  const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: source, env: { ...safe, QA_FIX_SOURCE: source, QA_FIX_VERSION: pinned.version, QA_VS_SCRIPT: vsScript }, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => logs.push(error.stack));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { const text = String(part); logs.push(text); process.stdout.write(text); });
  const code = await new Promise(resolve => child.once('close', resolve));
  report.buildExit = code;
  assert.equal(code, 0, 'Repository Windows packaging failed');
  assert.equal(await digest(path.join(source, 'application/state/useAIState.ts')), originalSourceHash, 'Do not modify application source to package it');
  assert.equal(git('rev-parse', 'HEAD'), pinned.sha);
  const installer = path.join(source, 'release', pinned.installer);
  assert(fs.existsSync(installer), 'Exact NSIS installer must be produced');
  report.installerSha256 = await digest(installer);
  report.installerBytes = fs.statSync(installer).size;
  report.sourceFileSha256 = originalSourceHash;
  report.versionMetadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version;
  assert.equal(report.versionMetadata, pinned.version);
  fs.copyFileSync(installer, path.join(output, pinned.installer));
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `installer_sha=${report.installerSha256}\n`);
  report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  fs.mkdirSync(output, { recursive: true });
  const log = logs.join('');
  const sensitive = /(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|Authorization:\s*Bearer\s+\S+)/i.test(log);
  report.logReview = sensitive ? 'blocked' : 'passed: no credentials supplied to build process; output pattern scan passed';
  if (!sensitive) fs.writeFileSync(path.join(output, 'build.log'), log);
  else { process.exitCode = 1; fs.rmSync(path.join(output, pinned.installer), { force: true }); }
  fs.writeFileSync(path.join(output, 'build-provenance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});
