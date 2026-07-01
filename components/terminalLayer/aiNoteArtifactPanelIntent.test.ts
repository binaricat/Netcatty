import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAiNoteArtifactPanelIntent } from './aiNoteArtifactPanelIntent.ts';

test('AI note artifact opens the notes side panel for the active tab and returns to AI', () => {
  assert.deepEqual(
    resolveAiNoteArtifactPanelIntent({
      activeTabId: 'session-1',
      currentPanel: 'ai',
      noteId: 'note-1',
    }),
    {
      kind: 'openNotesSidePanel',
      tabId: 'session-1',
      noteId: 'note-1',
      returnPanel: 'ai',
    },
  );
});

test('AI note artifact falls back when there is no active side-panel tab', () => {
  assert.deepEqual(
    resolveAiNoteArtifactPanelIntent({
      activeTabId: '',
      currentPanel: null,
      noteId: 'note-1',
    }),
    {
      kind: 'fallback',
      noteId: 'note-1',
    },
  );
});
