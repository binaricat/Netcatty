import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panelSource = readFileSync(new URL('./AIChatPanelContent.tsx', import.meta.url), 'utf8');
const selectorSource = readFileSync(new URL('./ai/AgentSelector.tsx', import.meta.url), 'utf8');
const preparingSource = readFileSync(new URL('./AIChatSidePanel.tsx', import.meta.url), 'utf8');

const primaryToolbarSources = [
  panelSource,
  readFileSync(new URL('./ScriptsSidePanel.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./HistorySidePanel.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./SftpSidePanel.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./notes/NotesManager.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./systemManager/SystemManagerSidePanel.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./terminal/ThemeSidePanel.tsx', import.meta.url), 'utf8'),
];

test('AI chat header matches the compact system panel toolbar height', () => {
  assert.match(panelSource, /TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS/);
  assert.match(selectorSource, /className="group flex h-6/);
  assert.match(selectorSource, /truncate text-\[11px\]/);
  assert.match(panelSource, /className="h-6 w-6 rounded-md/);
});

test('AI chat preparing state keeps the same compact header height', () => {
  assert.match(preparingSource, /TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS/);
  assert.match(preparingSource, /className="h-6 w-32/);
});

test('agent selector menu stays compact with restrained corners', () => {
  assert.match(selectorSource, /w-\[256px\].*rounded-md/);
  assert.match(selectorSource, /flex h-9 w-full items-center gap-2\.5 px-3/);
  assert.doesNotMatch(selectorSource, /rounded-lg/);
  assert.doesNotMatch(selectorSource, /rounded-2xl/);
});

test('terminal side panel tools share one primary toolbar height', () => {
  for (const source of primaryToolbarSources) {
    assert.match(source, /TERMINAL_SIDE_PANEL_INNER_HEADER_CLASS/);
  }
});

test('AI chat panel wires coordinated turn history actions into the message list', () => {
  assert.match(panelSource, /onForkAfterTurn\?: \(assistantMessageId: string\) => void/);
  assert.match(panelSource, /onUndoLastTurn\?: \(\) => void/);
  assert.match(panelSource, /canUndoLastTurn\?: boolean/);
  assert.match(panelSource, /onForkAfterTurn=\{onForkAfterTurn\}/);
  assert.match(panelSource, /onUndoLastTurn=\{onUndoLastTurn\}/);
  assert.match(panelSource, /canUndoLastTurn=\{canUndoLastTurn\}/);
});
