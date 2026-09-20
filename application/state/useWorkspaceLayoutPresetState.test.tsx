import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  collectSidePanelPanes,
  createSidePanelLayout,
  splitSidePanelPane,
  type SidePanelLayout,
} from '../../domain/sidePanelLayout.ts';
import { STORAGE_KEY_WORKSPACE_LAYOUT_PRESET } from '../../infrastructure/config/storageKeys.ts';
import { useWorkspaceLayoutPresetState } from './useWorkspaceLayoutPresetState.ts';

function buildSplitLayout(): SidePanelLayout {
  let layout = createSidePanelLayout('scripts', 'pane-scripts');
  layout = splitSidePanelPane(layout, 'pane-scripts', 'sftp', 'horizontal', {
    paneId: 'pane-sftp',
    splitId: 'split-root',
  }, 400);
  return layout;
}

test('saved default resolves per session with fresh ids and protocol-aware pruning', async () => {
  const values = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    localStorage?: typeof fakeStorage;
  };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'localStorage', {
    value: fakeStorage,
    configurable: true,
  });

  let state: ReturnType<typeof useWorkspaceLayoutPresetState> | null = null;
  const Probe = () => {
    state = useWorkspaceLayoutPresetState();
    return null;
  };

  try {
    await act(async () => {
      create(React.createElement(Probe));
    });
    assert.ok(state);

    // Nothing saved yet: no preset to apply.
    assert.equal(state.resolveDefaultLayoutForSession({ protocol: 'ssh' }), null);

    let saved = false;
    await act(async () => {
      saved = state?.saveWorkspaceLayoutAsDefault(buildSplitLayout()) ?? false;
    });
    assert.equal(saved, true);
    assert.ok(values.has(STORAGE_KEY_WORKSPACE_LAYOUT_PRESET));

    // SSH sessions keep their SFTP pane; ids are rekeyed per application.
    const sshResolved = state.resolveDefaultLayoutForSession({ protocol: 'ssh' });
    assert.ok(sshResolved);
    assert.equal(sshResolved.protocol, 'ssh');
    assert.deepEqual(
      collectSidePanelPanes(sshResolved.layout.root).map((pane) => pane.tool),
      ['scripts', 'sftp'],
    );
    assert.notEqual(sshResolved.layout.root.id, buildSplitLayout().root.id);
    assert.equal(sshResolved.focusedTool, 'sftp');

    // Protocols that cannot serve SFTP lose that pane.
    const telnetResolved = state.resolveDefaultLayoutForSession({ protocol: 'telnet' });
    assert.ok(telnetResolved);
    assert.deepEqual(
      collectSidePanelPanes(telnetResolved.layout.root).map((pane) => pane.tool),
      ['scripts'],
    );
    assert.equal(telnetResolved.focusedTool, 'scripts');

    // A second resolve rekeys again so parallel workspaces share no node ids.
    const again = state.resolveDefaultLayoutForSession({ protocol: 'ssh' });
    assert.ok(again);
    assert.notEqual(again.layout.root.id, sshResolved.layout.root.id);
  } finally {
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('saving falls back to false when persistence rejects the write', async () => {
  const fakeStorage = {
    getItem: () => null,
    setItem: () => {
      const quotaError = new DOMException('full', 'QuotaExceededError');
      throw quotaError;
    },
    removeItem: () => undefined,
  };
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    localStorage?: typeof fakeStorage;
  };
  const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'localStorage', {
    value: fakeStorage,
    configurable: true,
  });

  let state: ReturnType<typeof useWorkspaceLayoutPresetState> | null = null;
  const Probe = () => {
    state = useWorkspaceLayoutPresetState();
    return null;
  };

  try {
    await act(async () => {
      create(React.createElement(Probe));
    });
    assert.ok(state);

    let saved = true;
    await act(async () => {
      saved = state?.saveWorkspaceLayoutAsDefault(buildSplitLayout()) ?? true;
    });
    assert.equal(saved, false);
  } finally {
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
