import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SIDE_PANEL_PANES,
  canSplitSidePanelPaneAtSize,
  closeSidePanelPane,
  collectSidePanelPanes,
  createSidePanelLayout,
  cycleSidePanelDockPosition,
  focusSidePanelPane,
  getSidePanelNodeMinimumPixels,
  getSidePanelSplitResizeBounds,
  isSidePanelDockPosition,
  resizeSidePanelSplit,
  selectSidePanelTool,
  sidePanelLayoutHasTool,
  splitSidePanelPane,
} from './sidePanelLayout.ts';

test('panes smaller than two minimum cells cannot be split again', () => {
  const layout = createSidePanelLayout('notes', 'pane-notes');
  const tooSmall = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 160);

  assert.equal(canSplitSidePanelPaneAtSize(160), false);
  assert.equal(canSplitSidePanelPaneAtSize(161), true);
  assert.equal(tooSmall, layout);
});

test('nested split resize bounds preserve every descendant pane minimum', () => {
  let layout = createSidePanelLayout('notes', 'pane-notes');
  layout = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 420);
  layout = splitSidePanelPane(layout, 'pane-ai', 'system', 'vertical', {
    paneId: 'pane-system',
    splitId: 'split-nested',
  }, 210);

  assert.equal(layout.root.type, 'split');
  if (layout.root.type !== 'split') return;
  assert.equal(getSidePanelNodeMinimumPixels(layout.root, 'vertical'), 242);
  assert.equal(getSidePanelNodeMinimumPixels(layout.root, 'horizontal'), 80);

  const bounds = getSidePanelSplitResizeBounds(layout.root, 0, 1, 419);
  assert.ok(bounds.firstMax < 0.62);
  assert.ok((1 - bounds.firstMax) * 419 >= 161);
});

test('a focused pane can be split repeatedly into a nested multi-pane layout', () => {
  let layout = createSidePanelLayout('notes', 'pane-notes');

  layout = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 400);
  layout = splitSidePanelPane(layout, 'pane-ai', 'system', 'horizontal', {
    paneId: 'pane-system',
    splitId: 'split-nested',
  }, 400);

  assert.equal(layout.root.type, 'split');
  assert.equal(layout.root.direction, 'vertical');
  assert.equal(layout.root.children[1]?.type, 'split');
  assert.equal(layout.root.children[1]?.type === 'split' ? layout.root.children[1].direction : null, 'horizontal');
  assert.deepEqual(collectSidePanelPanes(layout.root).map((pane) => pane.tool), [
    'notes',
    'ai',
    'system',
  ]);
  assert.equal(layout.focusedPaneId, 'pane-system');
});

test('splitting with an occupied tool focuses its existing pane without duplicating it', () => {
  let layout = createSidePanelLayout('notes', 'pane-notes');
  layout = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 400);

  const next = splitSidePanelPane(layout, 'pane-ai', 'notes', 'horizontal', {
    paneId: 'unused-pane',
    splitId: 'unused-split',
  }, 400);

  assert.equal(next.focusedPaneId, 'pane-notes');
  assert.equal(collectSidePanelPanes(next.root).length, 2);
  assert.equal(collectSidePanelPanes(next.root).filter((pane) => pane.tool === 'notes').length, 1);
});

test('the shared tool selection changes only the focused pane or focuses an existing tool', () => {
  let layout = createSidePanelLayout('notes', 'pane-notes');
  layout = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 400);
  layout = focusSidePanelPane(layout, 'pane-notes');

  const replaced = selectSidePanelTool(layout, 'system');
  assert.deepEqual(collectSidePanelPanes(replaced.root).map((pane) => pane.tool), ['system', 'ai']);
  assert.equal(replaced.focusedPaneId, 'pane-notes');

  const focusedExisting = selectSidePanelTool(replaced, 'ai');
  assert.deepEqual(collectSidePanelPanes(focusedExisting.root).map((pane) => pane.tool), ['system', 'ai']);
  assert.equal(focusedExisting.focusedPaneId, 'pane-ai');
});

test('closing panes collapses their parent split and closing the last pane closes the layout', () => {
  let layout = createSidePanelLayout('notes', 'pane-notes');
  layout = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 400);
  layout = splitSidePanelPane(layout, 'pane-ai', 'system', 'horizontal', {
    paneId: 'pane-system',
    splitId: 'split-nested',
  }, 400);

  const withoutAi = closeSidePanelPane(layout, 'pane-ai');
  assert.ok(withoutAi);
  assert.deepEqual(collectSidePanelPanes(withoutAi.root).map((pane) => pane.tool), ['notes', 'system']);
  assert.equal(withoutAi.focusedPaneId, 'pane-system');

  const single = closeSidePanelPane(withoutAi, 'pane-system');
  assert.ok(single);
  assert.equal(single.root.type, 'pane');
  assert.equal(single.root.type === 'pane' ? single.root.tool : null, 'notes');

  assert.equal(closeSidePanelPane(single, 'pane-notes'), null);
});

test('split sizes can be updated without changing any nested pane', () => {
  let layout = createSidePanelLayout('notes', 'pane-notes');
  layout = splitSidePanelPane(layout, 'pane-notes', 'ai', 'vertical', {
    paneId: 'pane-ai',
    splitId: 'split-root',
  }, 400);

  const resized = resizeSidePanelSplit(layout, 'split-root', [3, 1]);
  assert.equal(resized.root.type, 'split');
  assert.deepEqual(resized.root.type === 'split' ? resized.root.sizes : [], [0.75, 0.25]);
  assert.equal(sidePanelLayoutHasTool(resized, 'ai'), true);
});

test('the pane limit rejects additional splits without changing the layout', () => {
  let layout = createSidePanelLayout('sftp', 'pane-0');
  const tools = ['scripts', 'history', 'theme', 'system', 'notes', 'ai'] as const;
  tools.forEach((tool, index) => {
    layout = splitSidePanelPane(layout, `pane-${index}`, tool, 'vertical', {
      paneId: `pane-${index + 1}`,
      splitId: `split-${index}`,
    }, 400);
  }, 400);

  // The product currently has seven unique tools, but the domain limit remains
  // explicit so future tools cannot create an unbounded layout.
  assert.equal(MAX_SIDE_PANEL_PANES, 8);
  assert.equal(collectSidePanelPanes(layout.root).length, 7);

  const duplicateAttempt = splitSidePanelPane(layout, 'pane-6', 'sftp', 'horizontal', {
    paneId: 'pane-extra',
    splitId: 'split-extra',
  }, 400);
  assert.equal(collectSidePanelPanes(duplicateAttempt.root).length, 7);
  assert.equal(duplicateAttempt.focusedPaneId, 'pane-0');
});

test('dock position cycles through left, right and bottom', () => {
  assert.equal(cycleSidePanelDockPosition('left'), 'right');
  assert.equal(cycleSidePanelDockPosition('right'), 'bottom');
  assert.equal(cycleSidePanelDockPosition('bottom'), 'left');
});

test('dock position validator accepts only known positions', () => {
  assert.equal(isSidePanelDockPosition('bottom'), true);
  assert.equal(isSidePanelDockPosition('top'), false);
  assert.equal(isSidePanelDockPosition(42), false);
});
