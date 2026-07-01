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
