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

test('system prompt keeps static guidelines before dynamic sections', () => {
  const prompt = buildSystemPrompt({
    scopeType: 'terminal',
    hosts: [],
    permissionMode: 'confirm',
  });

  const guidelines = prompt.indexOf('## Guidelines');
  const scope = prompt.indexOf('## Current Scope');
  const sessions = prompt.indexOf('## Available Sessions');
  const permission = prompt.indexOf('## Permission Mode:');
  assert.ok(guidelines !== -1);
  assert.ok(scope > guidelines, 'Current Scope should come after Guidelines');
  assert.ok(sessions > scope, 'Available Sessions should come after Current Scope');
  assert.ok(permission > sessions, 'Permission Mode should come after Available Sessions');
});

test('static prefix stays stable when dynamic context changes', () => {
  const base = buildSystemPrompt({
    scopeType: 'terminal',
    hosts: [],
    permissionMode: 'confirm',
  });
  const changed = buildSystemPrompt({
    scopeType: 'workspace',
    scopeLabel: 'Prod',
    hosts: [
      {
        sessionId: 's1',
        hostname: 'example.com',
        label: 'web-1',
        connected: true,
      },
    ],
    permissionMode: 'auto',
  });

  const guidelines = base.indexOf('## Guidelines');
  assert.ok(guidelines > 0);
  assert.strictEqual(
    base.slice(0, guidelines + '## Guidelines'.length),
    changed.slice(0, guidelines + '## Guidelines'.length),
    'opening + Guidelines prefix must be identical regardless of dynamic context',
  );
  assert.notStrictEqual(base, changed);
});
