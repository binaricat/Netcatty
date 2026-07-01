import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createVaultArtifactNavigationActions,
  navigateVaultArtifact,
} from './VaultArtifactNavigationContext.tsx';

const t = (key: string) => key;

test('clicking an existing note artifact opens that note', () => {
  const openedNotes: string[] = [];
  const unavailable: Array<{ title: string; message: string }> = [];
  const navigation = createVaultArtifactNavigationActions({
    notes: [{ id: 'note-1', title: 'Runbook', content: '', createdAt: 1, updatedAt: 1 }],
    hosts: [],
    snippets: [],
    t,
    onOpenVaultNote: (noteId) => openedNotes.push(noteId),
    onOpenVaultHost: () => {},
    onOpenVaultSection: () => {},
    onUnavailable: (message, title) => unavailable.push({ title, message }),
  });

  navigateVaultArtifact({
    kind: 'vault.note',
    noteId: 'note-1',
    title: 'Runbook',
  }, navigation);

  assert.deepEqual(openedNotes, ['note-1']);
  assert.deepEqual(unavailable, []);
});

test('clicking an existing snippet artifact opens that snippet', () => {
  const openedSnippets: string[] = [];
  const navigation = createVaultArtifactNavigationActions({
    notes: [],
    hosts: [],
    snippets: [{ id: 'snippet-1', label: 'Restart nginx', command: 'sudo systemctl restart nginx' }],
    t,
    onOpenVaultSnippet: (snippetId) => openedSnippets.push(snippetId),
    onUnavailable: (message, title) => { void message; void title; },
  });

  navigateVaultArtifact({
    kind: 'vault.snippet',
    snippetId: 'snippet-1',
    label: 'Restart nginx',
  }, navigation);

  assert.deepEqual(openedSnippets, ['snippet-1']);
});

test('clicking a missing note artifact shows an unavailable message instead of opening', () => {
  const openedNotes: string[] = [];
  const unavailable: Array<{ title: string; message: string }> = [];
  const navigation = createVaultArtifactNavigationActions({
    notes: [],
    hosts: [],
    snippets: [],
    t,
    onOpenVaultNote: (noteId) => openedNotes.push(noteId),
    onOpenVaultHost: () => {},
    onOpenVaultSection: () => {},
    onUnavailable: (message, title) => unavailable.push({ title, message }),
  });

  navigateVaultArtifact({
    kind: 'vault.note',
    noteId: 'deleted-note',
    title: 'Deleted note',
  }, navigation);

  assert.deepEqual(openedNotes, []);
  assert.deepEqual(unavailable, [{
    title: 'ai.chat.artifact.unavailableTitle',
    message: 'ai.chat.artifact.noteMissing',
  }]);
});
