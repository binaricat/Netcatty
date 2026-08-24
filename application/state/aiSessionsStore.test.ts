import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyDraft } from './aiDraftState.ts';
import { aiSessionsStore } from './aiSessionsStore.ts';

test('AI sessions store does not notify listeners when only composer text changes', () => {
  const previous = aiSessionsStore.getSnapshot();
  const draft = createEmptyDraft('catty');
  const base = {
    sessions: Object.freeze([]),
    activeSessionIdMap: Object.freeze({}),
    draftsByScope: { 'terminal:1': draft },
    panelViewByScope: {},
  };

  try {
    aiSessionsStore.setSnapshot(base);

    let notified = 0;
    const unsubscribe = aiSessionsStore.subscribe(() => {
      notified += 1;
    });

    aiSessionsStore.setSnapshot({
      ...base,
      draftsByScope: {
        'terminal:1': { ...draft, text: 'hello', updatedAt: draft.updatedAt + 1 },
      },
    });
    assert.equal(notified, 0);
    assert.equal(aiSessionsStore.getSnapshot().draftsByScope['terminal:1']?.text, 'hello');

    aiSessionsStore.setSnapshot({
      ...base,
      draftsByScope: {},
    });
    notified = 0;
    aiSessionsStore.setSnapshot({
      ...base,
      draftsByScope: {
        'terminal:1': { ...draft, text: '你好' },
      },
    });
    assert.equal(notified, 0);

    notified = 0;
    aiSessionsStore.setSnapshot({
      ...base,
      draftsByScope: {
        'terminal:1': { ...draft, text: '' },
      },
    });
    assert.equal(notified, 1);

    notified = 0;
    aiSessionsStore.setSnapshot({
      ...base,
      draftsByScope: {
        'terminal:1': { ...draft, text: 'hello', attachments: [{ id: 'a' } as never] },
      },
    });
    assert.equal(notified, 1);
    unsubscribe();
  } finally {
    aiSessionsStore.setSnapshot(previous);
  }
});
