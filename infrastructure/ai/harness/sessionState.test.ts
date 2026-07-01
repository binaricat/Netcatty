import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStateStore } from './sessionState.ts';

test('SessionStateStore tracks terminal commands and reinjection text', () => {
  const store = new SessionStateStore();
  store.mergeFromUserGoal('chat-1', 'Fix nginx upstream timeout');
  store.updateFromToolResult(
    'chat-1',
    'terminal_execute',
    { sessionId: 'sess-1', command: 'tail -n 100 /var/log/nginx/error.log' },
    'upstream timed out',
    false,
  );

  const text = store.toReinjectionText('chat-1');
  assert.ok(text?.includes('Fix nginx upstream timeout'));
  assert.ok(text?.includes('sess-1'));
  assert.ok(text?.includes('tail -n 100'));
});

test('SessionStateStore records tool errors as blockers', () => {
  const store = new SessionStateStore();
  store.updateFromToolResult(
    'chat-1',
    'terminal_execute',
    { sessionId: 'sess-1', command: 'systemctl restart nginx' },
    '{ "error": "Job failed" }',
    true,
  );
  const text = store.toReinjectionText('chat-1');
  assert.ok(text?.includes('Open blockers'));
});
