// Read-only OS assessments and normal copy installation. No OS settings change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pinned = require('./candidate.json');
const root = path.resolve(process.env.QA_ROOT), arch = process.env.QA_ARCH;
const evidence = path.join(root, 'evidence');
const app = path.join(root, 'Applications/Netcatty.app');
const mount = path.join(root, 'mount');
const report = { candidate: pinned.sha, arch, qaHead: process.env.QA_HEAD_SHA, commands: [], dmgIntegrity: 'not_run', installedApp: 'not_run', developerId: 'not_run', appNotarizationTicket: 'not_run', gatekeeperApp: 'not_run', scope: 'Runner-owned Applications copy from read-only mounted official DMG. DMG integrity differs from app Developer ID/notarization; no Finder-quarantine or personal-device claim.' };
let mounted = false;
function command(label, executable, args, required = true, timeout = 60000) {
  const r = spawnSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 5e6 });
  const item = { label, executable, args, exitCode: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
  report.commands.push(item);
  if (required) assert.equal(r.status, 0, `${label}: ${item.stderr || item.stdout || item.error}`);
  return item;
}
function main() {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, arch); assert.notEqual(process.getuid(), 0);
  assert(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN);
  fs.mkdirSync(evidence, { recursive: true });
  report.uname = command('runner uname', '/usr/bin/uname', ['-m']).stdout.trim();
  assert.equal(report.uname, arch === 'arm64' ? 'arm64' : 'x86_64');
  report.os = command('runner OS', '/usr/bin/sw_vers', []).stdout;
  report.uid = process.getuid(); report.runnerLabel = process.env.QA_RUNNER; report.nodeArch = process.arch;
  const dmg = path.join(root, pinned.dmgs[arch]);
  command('DMG integrity verification', '/usr/bin/hdiutil', ['verify', dmg]); report.dmgIntegrity = 'passed';
  // Informational only: unsigned outer DMG != unsigned/not-notarized inner app.
  report.outerDmgSignature = command('outer DMG signature display (not an app assessment)', '/usr/bin/codesign', ['-d', '--verbose=4', dmg], false);
  report.outerDmgStapler = command('outer DMG staple validation (reported separately)', '/usr/bin/xcrun', ['stapler', 'validate', dmg], false);
  fs.mkdirSync(mount, { recursive: true });
  command('mount official DMG read-only', '/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]); mounted = true;
  assert(fs.existsSync(path.join(mount, 'Netcatty.app')));
  fs.mkdirSync(path.dirname(app), { recursive: true }); assert(!fs.existsSync(app));
  command('copy original app preserving bundle metadata', '/usr/bin/ditto', [path.join(mount, 'Netcatty.app'), app]); report.installedApp = 'passed: normal runner-owned Applications copy; original bundle unchanged';
  command('unmount read-only image', '/usr/bin/hdiutil', ['detach', mount]); mounted = false;
  report.bundleIdentifier = command('bundle identifier', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')]).stdout.trim();
  assert.equal(report.bundleIdentifier, pinned.bundleId);
  report.bundleVersion = command('bundle version', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')]).stdout.trim();
  const executableName = command('bundle executable', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')]).stdout.trim();
  assert.equal(executableName, 'Netcatty');
  report.executable = path.join(app, 'Contents/MacOS', executableName);
  report.executableArchitectures = command('Mach-O architecture', '/usr/bin/lipo', ['-archs', report.executable]).stdout.trim().split(/\s+/);
  assert(report.executableArchitectures.includes(report.uname), 'Official executable must contain native runner architecture');
  command('strict deep code signature verification', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=4', app]);
  const signature = command('Developer ID signature identifiers', '/usr/bin/codesign', ['-d', '--verbose=4', app]);
  const description = signature.stdout + signature.stderr;
  assert(description.includes(`Identifier=${pinned.bundleId}`)); assert(/Authority=Developer ID Application:/.test(description)); assert(/TeamIdentifier=[A-Z0-9]+/.test(description)); assert(/flags=.*runtime/.test(description));
  report.teamIdentifier = description.match(/TeamIdentifier=([A-Z0-9]+)/)[1];
  report.authorities = [...description.matchAll(/^Authority=(.+)$/gm)].map(m => m[1]);
  command('designated requirements', '/usr/bin/codesign', ['-d', '-r-', app]); report.developerId = 'passed: valid strict Developer ID application signature with hardened runtime';
  command('notarization ticket on installed APP', '/usr/bin/xcrun', ['stapler', 'validate', app]); report.appNotarizationTicket = 'passed';
  const status = command('stock Gatekeeper status (read only)', '/usr/sbin/spctl', ['--status']);
  assert(/assessments enabled/i.test(status.stdout + status.stderr), 'Runner must have stock Gatekeeper assessments enabled; never enable/disable to obtain a pass');
  const gatekeeper = command('Gatekeeper assessment of installed APP', '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], true, 90000);
  assert(/Notarized Developer ID/.test(gatekeeper.stdout + gatekeeper.stderr)); report.gatekeeperApp = 'passed: accepted, Notarized Developer ID';
  report.installedAppXattrs = command('observe app xattrs without modification', '/usr/bin/xattr', ['-l', app], false);
  report.installPath = app; report.status = 'passed';
}
try { main(); } catch (error) { report.status = 'failed'; report.blocker = error.stack; process.exitCode = 1; }
finally {
  if (mounted) command('detach after failed assessment', '/usr/bin/hdiutil', ['detach', mount], false);
  fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'verification.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
