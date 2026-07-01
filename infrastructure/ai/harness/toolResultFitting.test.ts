import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fitLargeToolResultForModel } from './toolResultFitting';
import { ToolOutputStore } from './toolOutputStore';

describe('fitLargeToolResultForModel', () => {
  it('truncates large nested string fields and stores the full content behind a handle', () => {
    const store = new ToolOutputStore();
    const body = `${'alpha\n'.repeat(1000)}important-tail`;

    const fitted = fitLargeToolResultForModel({
      result: {
        ok: true,
        note: {
          id: 'note-1',
          title: 'Runbook',
          content: body,
        },
      },
      capabilityId: 'vault.note.get',
      chatSessionId: 'chat-1',
      toolOutputStore: store,
      maxStringChars: 500,
    }) as {
      note: { content: string };
    };

    assert.notEqual(fitted.note.content, body);
    assert.match(fitted.note.content, /tool output handle/);
    assert.match(fitted.note.content, /capability=vault\.note\.get/);
    assert.match(fitted.note.content, /field=note\.content/);
    assert.match(fitted.note.content, /handleId=tool-output-/);

    const handleId = fitted.note.content.match(/handleId=(tool-output-[^\]\s]+)/)?.[1];
    assert.ok(handleId);
    assert.equal(store.read({ handleId, mode: 'full', maxChars: body.length + 100 }, 'chat-1'), body);
  });

  it('leaves small results unchanged', () => {
    const result = {
      ok: true,
      note: {
        id: 'note-1',
        content: 'short note',
      },
    };

    const fitted = fitLargeToolResultForModel({
      result,
      capabilityId: 'vault.note.get',
      chatSessionId: 'chat-1',
      toolOutputStore: new ToolOutputStore(),
      maxStringChars: 500,
    });

    assert.equal(fitted, result);
  });
});
