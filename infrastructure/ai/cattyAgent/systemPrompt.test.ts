import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from './systemPrompt';

test('system prompt tells Catty how to import unknown attached host lists safely', () => {
  const prompt = buildSystemPrompt({
    scopeType: 'terminal',
    hosts: [],
    permissionMode: 'confirm',
  });

  assert.match(prompt, /list_attachments/i);
  assert.match(prompt, /read_attachment/i);
  assert.match(prompt, /unknown/i);
  assert.match(prompt, /vault_hosts_create/i);
  assert.match(prompt, /tool_output_read/i);
  assert.match(prompt, /compressed|truncated/i);
});

test('system prompt prefers explicit script wait APIs', () => {
  const prompt = buildSystemPrompt({
    scopeType: 'terminal',
    hosts: [],
    permissionMode: 'confirm',
  });

  assert.match(prompt, /waitForText/);
  assert.match(prompt, /waitForRegex/);
  assert.doesNotMatch(prompt, /sendLine`,\s*`waitFor`,\s*dialogs/);
});

test('system prompt does not tell Catty to call host_open', () => {
  const prompt = buildSystemPrompt({
    scopeType: 'workspace',
    hosts: [],
    permissionMode: 'confirm',
  });

  assert.doesNotMatch(prompt, /host_open/);
  assert.match(prompt, /cannot open new terminal sessions yourself/i);
  assert.match(prompt, /ask them to open/i);
});
