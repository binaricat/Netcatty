import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptAntigravityApiKey,
  updateAntigravityAgentCredential,
} from './antigravityAgentSettings';

test('Antigravity credential helpers trim, encrypt, and build the managed agent', async () => {
  assert.equal(
    await encryptAntigravityApiKey('  secret  ', async (value) => `encrypted:${value}`),
    'encrypted:secret',
  );
  const agents = updateAntigravityAgentCredential([], {
    encryptedApiKey: 'encrypted:secret',
    resolvedPath: '/usr/bin/python3',
    available: true,
  });
  assert.deepEqual(agents, [{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    args: [],
    icon: 'gemini',
    sdkBackend: 'antigravity',
    enabled: true,
    apiKey: 'encrypted:secret',
    command: '/usr/bin/python3',
    commandSource: 'auto',
    available: true,
  }]);
});

test('Antigravity credential helpers preserve existing settings and allow key removal', () => {
  const agents = updateAntigravityAgentCredential([{
    id: 'discovered_antigravity',
    name: 'Google Antigravity',
    command: '/custom/python',
    args: [],
    icon: 'gemini',
    sdkBackend: 'antigravity',
    enabled: false,
    apiKey: 'old-key',
  }], {
    encryptedApiKey: undefined,
    customPath: '/custom/python',
    available: false,
  });
  assert.equal(agents[0].enabled, false);
  assert.equal(agents[0].apiKey, undefined);
  assert.equal(agents[0].commandSource, 'manual');
  assert.equal(agents[0].available, false);
});
