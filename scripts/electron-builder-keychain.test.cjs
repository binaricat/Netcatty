const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');

test('macOS signing separates temporary keychain and certificate passwords', async () => {
  const modulePath = require.resolve('app-builder-lib/out/codeSign/macCodeSign.js');
  const localRequire = createRequire(modulePath);
  const calls = [];
  const sandbox = {
    exports: {},
    __dirname: path.dirname(modulePath),
    process: { env: { TRAVIS: 'true' } },
    require(id) {
      if (id === 'builder-util') return {
        exec: async (file, args) => { assert.equal(file, '/usr/bin/security'); calls.push(args); return ''; },
      };
      if (id === './codesign') return { importCertificate: async (file) => file };
      return localRequire(id);
    },
  };
  vm.runInNewContext(readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  await sandbox.exports.createKeychain({
    tmpDir: {}, currentDir: '/signing-test', cscLink: '/app.p12', cscKeyPassword: 'application-password',
    cscILink: '/installer.p12', cscIKeyPassword: 'installer-password',
  });
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const keychainPassword = flag(calls.find((args) => args[0] === 'create-keychain'), '-p');
  assert.equal(flag(calls.find((args) => args[0] === 'unlock-keychain'), '-p'), keychainPassword);
  const partitions = calls.filter((args) => args[0] === 'set-key-partition-list');
  assert.equal(partitions.length, 2);
  for (const args of partitions) assert.equal(flag(args, '-k'), keychainPassword);
  assert.deepEqual(calls.filter((args) => args[0] === 'import').map((args) => flag(args, '-P')), [
    'application-password', 'installer-password',
  ]);
});
