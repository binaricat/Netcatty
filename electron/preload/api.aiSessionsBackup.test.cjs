const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreloadApi } = require('./api.cjs');

test('backup write and export forward the serialized JSON payload unchanged', async () => {
  const calls = [];
  const api = createPreloadApi({
    ipcRenderer: { invoke: async (...args) => { calls.push(args); } },
    webUtils: {},
  });
  const payload = { json: '[]' };
  await api.aiSessionsBackupWrite(payload);
  await api.aiSessionsBackupExport(payload);
  assert.deepEqual(calls, [
    ['netcatty:aiSessionsBackup:write', payload],
    ['netcatty:aiSessionsBackup:export', payload],
  ]);
  for (const [, argument] of calls) assert.equal(typeof argument.json, 'string');
});
