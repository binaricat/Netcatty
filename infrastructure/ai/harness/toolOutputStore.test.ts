import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolOutputStore } from './toolOutputStore';

test('ToolOutputStore stores and reads truncated output by handle', () => {
  const store = new ToolOutputStore();
  const handle = store.store({
    chatSessionId: 'chat-1',
    capabilityId: 'terminal.execute',
    sessionId: 'sess-1',
    content: 'A'.repeat(50_000),
  });

  assert.ok(handle.id.startsWith('tool-output-'));
  assert.equal(handle.totalChars, 50_000);

  const head = store.read({ handleId: handle.id, mode: 'head', maxChars: 100 }, 'chat-1');
  assert.equal(head?.length, 100);

  const tail = store.read({ handleId: handle.id, mode: 'tail', maxChars: 50 }, 'chat-1');
  assert.equal(tail?.length, 50);
  assert.equal(tail, 'A'.repeat(50));

  store.prune('chat-1');
  assert.equal(store.read({ handleId: handle.id }, 'chat-1'), null);
});
