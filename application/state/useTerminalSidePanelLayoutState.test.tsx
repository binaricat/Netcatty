import assert from 'node:assert/strict';
import test from 'node:test';
import React, { startTransition, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { readFileSync } from 'node:fs';

import { collectSidePanelPanes } from '../../domain/sidePanelLayout.ts';
import { useTerminalSidePanelLayoutState } from './useTerminalSidePanelLayoutState.ts';

test('terminal side panel layouts stay isolated and keep one pane per tool', async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let state: ReturnType<typeof useTerminalSidePanelLayoutState> | null = null;
  let renderer: ReactTestRenderer | null = null;

  const Probe = () => {
    state = useTerminalSidePanelLayoutState();
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      state?.setSidePanelOpenTabs(new Map([
        ['terminal-a', 'notes'],
        ['terminal-b', 'scripts'],
      ]));
    });

    const layoutA = state?.sidePanelLayouts.get('terminal-a');
    const layoutB = state?.sidePanelLayouts.get('terminal-b');
    assert.ok(layoutA);
    assert.ok(layoutB);

    await act(async () => {
      state?.splitPane('terminal-a', 'ai', 'vertical', {
        paneId: 'pane-ai',
        splitId: 'split-a',
      }, 400);
    });
    assert.deepEqual(
      collectSidePanelPanes(state!.sidePanelLayouts.get('terminal-a')!.root).map((pane) => pane.tool),
      ['notes', 'ai'],
    );
    assert.deepEqual(
      collectSidePanelPanes(state!.sidePanelLayouts.get('terminal-b')!.root).map((pane) => pane.tool),
      ['scripts'],
    );

    await act(async () => {
      state?.splitPane('terminal-a', 'notes', 'horizontal', {
        paneId: 'unused-pane',
        splitId: 'unused-split',
      }, 400);
    });
    const focused = state!.sidePanelLayouts.get('terminal-a')!;
    assert.equal(collectSidePanelPanes(focused.root).length, 2);
    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'notes');

    // External open paths still write the focused-tool map. They must replace
    // only the focused pane, then focus an existing pane without duplicating it.
    await act(async () => {
      state?.setSidePanelOpenTabs((current) => new Map(current).set('terminal-a', 'system'));
    });
    assert.deepEqual(
      collectSidePanelPanes(state!.sidePanelLayouts.get('terminal-a')!.root).map((pane) => pane.tool),
      ['system', 'ai'],
    );
    await act(async () => {
      state?.setSidePanelOpenTabs((current) => new Map(current).set('terminal-a', 'ai'));
    });
    const externallyFocused = state!.sidePanelLayouts.get('terminal-a')!;
    assert.deepEqual(collectSidePanelPanes(externallyFocused.root).map((pane) => pane.tool), ['system', 'ai']);
    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'ai');
    assert.equal(
      collectSidePanelPanes(externallyFocused.root).find((pane) => pane.id === externallyFocused.focusedPaneId)?.tool,
      'ai',
    );
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('closing the final pane removes only that terminal side panel state', async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let state: ReturnType<typeof useTerminalSidePanelLayoutState> | null = null;
  let renderer: ReactTestRenderer | null = null;

  const Probe = () => {
    state = useTerminalSidePanelLayoutState();
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    await act(async () => {
      state?.setSidePanelOpenTabs(new Map([
        ['terminal-a', 'notes'],
        ['terminal-b', 'scripts'],
      ]));
    });
    const paneId = state!.sidePanelLayouts.get('terminal-a')!.focusedPaneId;

    let closedLast = false;
    await act(async () => {
      closedLast = state!.closePane('terminal-a', paneId);
    });

    assert.equal(closedLast, true);
    assert.equal(state!.sidePanelLayouts.has('terminal-a'), false);
    assert.equal(state!.sidePanelOpenTabs.has('terminal-a'), false);
    assert.equal(state!.sidePanelLayouts.has('terminal-b'), true);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('selecting a side panel tool commits open tabs and layout in one render', async () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  let state: ReturnType<typeof useTerminalSidePanelLayoutState> | null = null;
  let renderer: ReactTestRenderer | null = null;
  let renders = 0;

  const Probe = () => {
    state = useTerminalSidePanelLayoutState();
    renders += 1;
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    renders = 0;
    await act(async () => {
      state?.selectSidePanelToolForTab('terminal-a', 'notes');
    });
    assert.equal(renders, 1, 'open tabs and layout share one commit');
    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'notes');
    const layout = state!.sidePanelLayouts.get('terminal-a')!;
    assert.equal(
      collectSidePanelPanes(layout.root).find((pane) => pane.id === layout.focusedPaneId)?.tool,
      'notes',
    );

    await act(async () => {
      state?.splitPane('terminal-a', 'ai', 'vertical', {
        paneId: 'pane-ai',
        splitId: 'split-a',
      }, 400);
    });
    const beforeFocus = state!.sidePanelLayouts.get('terminal-a')!;
    await act(async () => {
      state?.selectSidePanelToolForTab('terminal-a', 'notes');
    });
    const focusedExisting = state!.sidePanelLayouts.get('terminal-a')!;
    assert.deepEqual(
      collectSidePanelPanes(focusedExisting.root).map((pane) => pane.tool),
      ['notes', 'ai'],
    );
    assert.equal(
      collectSidePanelPanes(focusedExisting.root).find((pane) => pane.id === focusedExisting.focusedPaneId)?.tool,
      'notes',
    );
    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'notes');
    assert.notEqual(focusedExisting, beforeFocus);
    assert.equal(focusedExisting.root, beforeFocus.root, 'focusing an open tool must not rebuild the split');

    const settled = state!.sidePanelLayouts;
    renders = 0;
    await act(async () => {
      state?.selectSidePanelToolForTab('terminal-a', 'notes');
    });
    assert.equal(renders, 0);
    assert.equal(state!.sidePanelLayouts, settled);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('a pending side-panel write survives an urgent render on another tab', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  let state: ReturnType<typeof useTerminalSidePanelLayoutState> | null = null;
  let bump: ((value: number) => void) | null = null;
  const Probe = () => {
    state = useTerminalSidePanelLayoutState();
    const [, setTick] = useState(0);
    bump = setTick;
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const tools = (tabId: string, fromRef = false) => {
    const layout = fromRef
      ? state?.sidePanelLayoutsRef.current.get(tabId)
      : state?.sidePanelLayouts.get(tabId);
    return layout ? collectSidePanelPanes(layout.root).map((pane) => pane.tool) : [];
  };

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await act(async () => {
      state?.selectSidePanelToolForTab('terminal-a', 'notes');
      state?.selectSidePanelToolForTab('terminal-b', 'scripts');
    });
    await act(async () => {
      state?.splitPane('terminal-a', 'ai', 'vertical', {
        paneId: 'pane-ai',
        splitId: 'split-a',
      }, 400);
    });

    await act(async () => {
      startTransition(() => {
        state?.selectSidePanelToolForTab('terminal-a', 'history');
      });
      flushSync(() => {
        bump?.(1);
      });
      assert.deepEqual(tools('terminal-a'), ['notes', 'ai']);
      assert.deepEqual(tools('terminal-a', true), ['notes', 'history']);
      startTransition(() => {
        state?.selectSidePanelToolForTab('terminal-b', 'sftp');
      });
    });

    assert.deepEqual(tools('terminal-a'), ['notes', 'history']);
    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'history');
    assert.deepEqual(tools('terminal-b'), ['sftp']);
    assert.equal(state!.sidePanelOpenTabs.get('terminal-b'), 'sftp');
  } finally {
    await act(async () => {
      root.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    dom.window.close();
  }
});

test('a pending tool switch does not leave another tab ref behind an urgent open', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  let state: ReturnType<typeof useTerminalSidePanelLayoutState> | null = null;
  const Probe = () => {
    state = useTerminalSidePanelLayoutState();
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const focusedTool = (tabId: string, fromRef = false) => {
    const layout = fromRef
      ? state?.sidePanelLayoutsRef.current.get(tabId)
      : state?.sidePanelLayouts.get(tabId);
    if (!layout) return null;
    return collectSidePanelPanes(layout.root).find((pane) => pane.id === layout.focusedPaneId)?.tool ?? null;
  };

  try {
    await act(async () => {
      root.render(React.createElement(Probe));
    });
    await act(async () => {
      state?.selectSidePanelToolForTab('terminal-a', 'notes');
      state?.selectSidePanelToolForTab('terminal-b', 'scripts');
    });

    await act(async () => {
      startTransition(() => {
        state?.selectSidePanelToolForTab('terminal-a', 'history');
      });
      flushSync(() => {
        state?.setSidePanelOpenTabs((previous) => new Map(previous).set('terminal-b', 'browser'));
      });
    });

    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'history');
    assert.equal(state!.sidePanelOpenTabs.get('terminal-b'), 'browser');
    assert.equal(state!.sidePanelOpenTabsRef.current.get('terminal-a'), 'history');
    assert.equal(
      state!.sidePanelOpenTabsRef.current.get('terminal-b'),
      'browser',
      'B stays rendered as browser while its ref still reports the pre-queue tool',
    );
    assert.equal(focusedTool('terminal-b', true), 'browser');

    // handleSwitchSidePanelTab returns before select when the ref already
    // matches the clicked tool. A stale scripts ref would ignore this click.
    assert.notEqual(state!.sidePanelOpenTabsRef.current.get('terminal-b'), 'scripts');
    await act(async () => {
      state?.selectSidePanelToolForTab('terminal-b', 'scripts');
    });
    assert.equal(state!.sidePanelOpenTabs.get('terminal-b'), 'scripts');
    assert.equal(state!.sidePanelOpenTabsRef.current.get('terminal-b'), 'scripts');
    assert.equal(focusedTool('terminal-b'), 'scripts');
    assert.equal(state!.sidePanelOpenTabs.get('terminal-a'), 'history');
  } finally {
    await act(async () => {
      root.unmount();
    });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    dom.window.close();
  }
});

test('side panel icon clicks write the tool through selectSidePanelToolForTab', () => {
  const layerSource = readFileSync(new URL('../../components/TerminalLayer.tsx', import.meta.url), 'utf8');
  const start = layerSource.indexOf('const handleSwitchSidePanelTab = useCallback');
  const end = layerSource.indexOf('const handleFocusSidePanelPane = useCallback');
  const body = layerSource.slice(start, end);
  assert.match(body, /startTransition\(\(\) => \{\s*selectSidePanelToolForTab\(tabId, tab\);/);
  assert.doesNotMatch(body, /setSidePanelOpenTabs/);
});

test('all five side-panel open triggers commit atomically through selectSidePanelToolForTab', () => {
  const layerSource = readFileSync(new URL('../../components/TerminalLayer.tsx', import.meta.url), 'utf8');
  const sliceBetween = (startMarker: string, endMarker: string) => {
    const start = layerSource.indexOf(startMarker);
    const end = layerSource.indexOf(endMarker, start);
    assert.ok(start !== -1, `missing marker: ${startMarker}`);
    assert.ok(end !== -1 && end > start, `missing end marker: ${endMarker}`);
    return layerSource.slice(start, end);
  };

  const applyAutoOpenBody = sliceBetween('const applyAutoOpen = (remoteSshVersion?: string) => {', 'const explicitSftpAutoOpen =');
  assert.match(applyAutoOpenBody, /selectSidePanelToolForTab\(tabId, targetPanel\);/);
  assert.doesNotMatch(applyAutoOpenBody, /setSidePanelOpenTabs/);

  const handleOpenSftpBody = sliceBetween('const handleOpenSftp = useCallback(', 'const handlePendingUploadHandled = useCallback(');
  assert.match(handleOpenSftpBody, /selectSidePanelToolForTab\(tabId, 'sftp'\);/);
  assert.doesNotMatch(handleOpenSftpBody, /setSidePanelOpenTabs/);

  const handleToggleScriptsBody = sliceBetween('const handleToggleScriptsSidePanel = useCallback(', 'const handleToggleSidePanel = useCallback(');
  assert.match(handleToggleScriptsBody, /startTransition\(\(\) => \{\s*selectSidePanelToolForTab\(tabId, 'scripts'\);/);
  assert.doesNotMatch(handleToggleScriptsBody, /setSidePanelOpenTabs/);

  const hostBrowserEffectBody = sliceBetween('useEffect(() => subscribeHostBrowserPanelRequests(', 'const handleOpenNotes = useCallback(');
  assert.match(hostBrowserEffectBody, /selectSidePanelToolForTab\(tabId, 'browser'\);/);
  assert.doesNotMatch(hostBrowserEffectBody, /setSidePanelOpenTabs/);

  const openNotesBody = sliceBetween('const openNotesPanelForSourceNote = useCallback(', 'const handleOpenHostFromNotes = useCallback(');
  assert.match(openNotesBody, /selectSidePanelToolForTab\(tabId, 'notes'\);/);
  assert.doesNotMatch(openNotesBody, /setSidePanelOpenTabs/);
});
