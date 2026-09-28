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

test('system prompt keeps static content before dynamic sections for prompt caching', () => {
  const turnA = buildSystemPrompt({
    scopeType: 'workspace',
    hosts: [{ sessionId: 's1', hostname: 'a.example', label: 'A', connected: true }],
    permissionMode: 'confirm',
  });
  const turnB = buildSystemPrompt({
    scopeType: 'workspace',
    hosts: [
      { sessionId: 's1', hostname: 'a.example', label: 'A', connected: false },
      { sessionId: 's2', hostname: 'b.example', label: 'B', connected: true },
    ],
    permissionMode: 'auto',
    webSearchEnabled: true,
  });

  const guidelines = turnA.indexOf('## Guidelines');
  const currentScope = turnA.indexOf('## Current Scope');
  assert.ok(guidelines > -1 && currentScope > -1);
  assert.ok(guidelines < currentScope, 'static Guidelines must precede dynamic Current Scope');

  // Static prefix (intro + Guidelines) is identical across turns even when
  // dynamic context changes.
  assert.ok(turnA.startsWith('You are **Catty Agent**'));
  const staticEndA = turnA.indexOf('---');
  assert.ok(staticEndA > guidelines);
  assert.strictEqual(turnA.slice(0, staticEndA), turnB.slice(0, staticEndA));
});

test('system prompt renders web search guidance without breaking guideline numbering', () => {
  const withSearch = buildSystemPrompt({
    scopeType: 'global',
    hosts: [],
    permissionMode: 'auto',
    webSearchEnabled: true,
  });
  const withoutSearch = buildSystemPrompt({
    scopeType: 'global',
    hosts: [],
    permissionMode: 'auto',
  });

  assert.match(withSearch, /## Web Search/);
  assert.match(withSearch, /web_search/);
  assert.doesNotMatch(withoutSearch, /## Web Search/);
  // Guideline 10 is the last numbered guideline; web search moved to a
  // dedicated dynamic section after the dynamic context blocks.
  assert.ok(withSearch.indexOf('10. **Network device sessions.**') < withSearch.indexOf('## Web Search'));
});
