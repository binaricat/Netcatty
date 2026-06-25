import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { getSharedBuiltinMcpToolDefinition } from './capabilityToolDefinitions';

test('Catty SDK reads terminal tool schema from shared capability catalog', () => {
  const definition = getSharedBuiltinMcpToolDefinition('terminal_execute', z);
  assert.equal(definition.toolName, 'terminal_execute');
  assert.match(definition.description, /short command/);

  const schema = z.object(definition.inputSchema);
  assert.deepEqual(
    schema.parse({ sessionId: 'session-1', command: 'pwd' }),
    { sessionId: 'session-1', command: 'pwd' },
  );
  assert.throws(() => schema.parse({ sessionId: 'session-1' }));
});

test('Catty SDK can read long-running terminal tool schema from shared catalog', () => {
  const definition = getSharedBuiltinMcpToolDefinition('terminal_poll', z);
  const schema = z.object(definition.inputSchema);

  assert.deepEqual(schema.parse({ jobId: 'job-1' }), { jobId: 'job-1' });
  assert.throws(() => schema.parse({ jobId: 'job-1', offset: -1 }));
});
