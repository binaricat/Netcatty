import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkspaceLayoutPreset,
  rekeySidePanelLayout,
  sanitizeWorkspaceLayoutPreset,
  withoutUnavailableSidePanelTools,
} from './workspaceLayoutPreset.ts';
import {
  collectSidePanelPanes,
  createSidePanelLayout,
  getFocusedSidePanelPane,
  splitSidePanelPane,
} from './sidePanelLayout.ts';

function buildSplitLayout() {
  let layout = createSidePanelLayout('scripts', 'pane-scripts');
  layout = splitSidePanelPane(layout, 'pane-scripts', 'sftp', 'horizontal', {
    paneId: 'pane-sftp',
    splitId: 'split-root',
  }, 400);
  layout = splitSidePanelPane(layout, 'pane-scripts', 'notes', 'vertical', {
    paneId: 'pane-notes',
    splitId: 'split-scripts',
  }, 200);
  return layout;
}

test('sanitize accepts a valid saved preset and rejects malformed data', () => {
  const preset = createWorkspaceLayoutPreset(buildSplitLayout());
  assert.ok(preset);
  assert.equal(sanitizeWorkspaceLayoutPreset(preset)?.layout.focusedPaneId, preset.layout.focusedPaneId);

  assert.equal(sanitizeWorkspaceLayoutPreset(null), null);
  assert.equal(sanitizeWorkspaceLayoutPreset({ version: 2, layout: preset?.layout }), null);
  assert.equal(sanitizeWorkspaceLayoutPreset({ version: 1 }), null);
  assert.equal(sanitizeWorkspaceLayoutPreset({ version: 1, layout: { focusedPaneId: 'x' } }), null);
  assert.equal(
    sanitizeWorkspaceLayoutPreset({
      version: 1,
      layout: { root: { id: 'p', type: 'pane', tool: 'nope' }, focusedPaneId: 'p' },
    }),
    null,
  );
  assert.equal(
    sanitizeWorkspaceLayoutPreset({
      version: 1,
      layout: { root: { id: 'p', type: 'pane', tool: 'notes' }, focusedPaneId: 'missing' },
    }),
    null,
  );
  assert.equal(
    sanitizeWorkspaceLayoutPreset({
      version: 1,
      layout: {
        root: {
          id: 's',
          type: 'split',
          direction: 'diagonal',
          children: [
            { id: 'a', type: 'pane', tool: 'notes' },
            { id: 'b', type: 'pane', tool: 'ai' },
          ],
          sizes: [0.5, 0.5],
        },
        focusedPaneId: 'a',
      },
    }),
    null,
  );
  assert.equal(
    sanitizeWorkspaceLayoutPreset({
      version: 1,
      layout: {
        root: {
          id: 's',
          type: 'split',
          direction: 'horizontal',
          children: [
            { id: 'a', type: 'pane', tool: 'notes' },
            { id: 'b', type: 'pane', tool: 'ai' },
          ],
          sizes: [0.5, 0, 0.5],
        },
        focusedPaneId: 'a',
      },
    }),
    null,
  );
});

test('sanitize rejects duplicate node ids', () => {
  assert.equal(
    sanitizeWorkspaceLayoutPreset({
      version: 1,
      layout: {
        root: {
          id: 's',
          type: 'split',
          direction: 'horizontal',
          children: [
            { id: 'dup', type: 'pane', tool: 'notes' },
            { id: 'dup', type: 'pane', tool: 'ai' },
          ],
          sizes: [0.5, 0.5],
        },
        focusedPaneId: 'dup',
      },
    }),
    null,
  );
});

test('rekey keeps structure, sizes and focused ordinal with fresh ids', () => {
  const source = buildSplitLayout();
  const sourceFocusedTool = getFocusedSidePanelPane(source).tool;
  let counter = 0;
  const rekeyed = rekeySidePanelLayout(source, () => `fresh-${++counter}`);

  assert.deepEqual(collectSidePanelPanes(rekeyed.root).map((pane) => pane.tool),
    collectSidePanelPanes(source.root).map((pane) => pane.tool));
  assert.equal(getFocusedSidePanelPane(rekeyed).tool, sourceFocusedTool);
  // Fresh ids are assigned depth-first; focus follows the focused pane's
  // ordinal position in the source layout.
  const sourcePanes = collectSidePanelPanes(source.root);
  const rekeyedPanes = collectSidePanelPanes(rekeyed.root);
  const focusedIndex = sourcePanes.findIndex((pane) => pane.id === 'pane-notes');
  assert.equal(rekeyed.focusedPaneId, rekeyedPanes[focusedIndex].id);
  assert.equal(getFocusedSidePanelPane(rekeyed).id, rekeyedPanes[focusedIndex].id);
  assert.ok(!rekeyedPanes.some((pane) => pane.id === 'pane-notes'));

  const sourceSplits = (source.root as { children: unknown[] }).children;
  const rekeyedSplits = (rekeyed.root as { children: unknown[] }).children;
  assert.notDeepEqual(rekeyedSplits, sourceSplits);
  assert.notEqual(rekeyed.root.id, source.root.id);
});

test('withoutUnavailableSidePanelTools prunes only unavailable panes', () => {
  const layout = buildSplitLayout();
  const kept = withoutUnavailableSidePanelTools(layout, (tool) => tool !== 'sftp');
  assert.ok(kept);
  assert.deepEqual(collectSidePanelPanes(kept.root).map((pane) => pane.tool), ['scripts', 'notes']);
  assert.ok(getFocusedSidePanelPane(kept));

  // The remaining split sizes renormalize after pruning (close collapse).
  const split = kept.root as { type: 'split'; sizes: number[] };
  assert.equal(split.sizes.reduce((sum, size) => sum + size, 0), 1);

  // Removing the only remaining pane collapses the layout entirely.
  assert.equal(withoutUnavailableSidePanelTools(createSidePanelLayout('notes', 'p'), () => false), null);
  // Nothing unavailable keeps the layout untouched.
  assert.equal(withoutUnavailableSidePanelTools(layout, () => true), layout);
});
