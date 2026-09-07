import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAIState } from './useAIState';
import { latestAIDraftsByScopeSnapshot } from './aiStateSnapshots';
import { createVaultNoteAttachment } from './vaultNoteAttachment';
import { createTerminalSelectionAttachment } from './terminalSelectionAttachment';

test('batched attachment changes report the applied result and preserve earlier changes', async () => {
  const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'localStorage', 'CustomEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  let ai!: ReturnType<typeof useAIState>;
  function Harness() { ai = useAIState(); return null; }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Harness />));
  const scope = 'terminal:attachment-batch';
  const note = createVaultNoteAttachment({ id: 'note', title: 'Note', content: 'small' })!;
  const large = createTerminalSelectionAttachment('x'.repeat(650_000))!;
  const refreshed = createVaultNoteAttachment({ id: 'note', title: 'Note', content: 'n'.repeat(200_000) })!;
  try {
    await act(async () => {
      ai.ensureDraftForScope(scope, 'catty');
      assert.equal(ai.addDraftAttachment(scope, 'catty', note), true);
      ai.updateDraft(scope, 'catty', (draft) => ({ ...draft, attachments: [...draft.attachments, large] }));
      assert.equal(ai.refreshDraftVaultNoteAttachment(scope, 'catty', refreshed), false);
      assert.equal(ai.addDraftAttachment(scope, 'catty', { ...refreshed, vaultNoteId: 'second' }), false);
    });
    assert.deepEqual(latestAIDraftsByScopeSnapshot?.[scope]?.attachments.map(a => a.id), [note.id, large.id]);
    await act(async () => {
      ai.removeDraftFile(scope, 'catty', large.id);
      assert.equal(ai.refreshDraftVaultNoteAttachment(scope, 'catty', refreshed), true);
    });
    assert.deepEqual(latestAIDraftsByScopeSnapshot?.[scope]?.attachments.map(a => a.id), [refreshed.id]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
