import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';

import { useAppearanceChromeStore } from '../../application/state/appearanceChromeStore';
import { isSavedVaultHost } from '../../domain/ephemeralHosts';
import {
  clearHostFontFamilyOverride,
  clearHostFontSizeOverride,
  clearHostFontWeightOverride,
  clearHostThemeOverride,
  hasHostFontFamilyOverride,
  hasHostFontSizeOverride,
  hasHostFontWeightOverride,
  hasHostThemeOverride,
  resolveHostTerminalFontFamilyId,
  resolveHostTerminalFontSize,
  resolveHostTerminalFontWeight,
  resolveHostTerminalThemeId,
} from '../../domain/terminalAppearance';
import type { ResolvedAppearance, TerminalAppearanceHostScope } from '../../domain/terminalAppearanceRuntime';
import { isSameResolvedTerminalFont } from '../../infrastructure/config/fonts';
import type { Host, TerminalSession, TerminalTheme, Workspace } from '../../types';
import { getScopedTopTabsThemeId } from '../terminalTopTabsTheme';
import {
  terminalLayerSidePanelStableCtxEqual,
  terminalLayerViewCtxEqual,
} from './terminalLayerViewMemo';
import { useTerminalThemePanelState } from './useTerminalThemePanelState';

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const CALLBACK_KEYS = [
  'handleThemeChangeForFocusedSession',
  'handleThemeResetForFocusedSession',
  'handleFontFamilyChangeForFocusedSession',
  'handleFontFamilyResetForFocusedSession',
  'handleFontSizeChangeForFocusedSession',
  'handleFontSizeResetForFocusedSession',
  'handleFontWeightChangeForFocusedSession',
  'handleFontWeightResetForFocusedSession',
] as const;

const makeTheme = (id: string): TerminalTheme => ({
  id,
  name: id,
  type: 'dark',
  colors: {
    background: '#111111',
    foreground: '#eeeeee',
    cursor: '#ffffff',
    selection: '#333333',
    black: '#000000',
    red: '#ff0000',
    green: '#00ff00',
    yellow: '#ffff00',
    blue: '#0000ff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#ffffff',
    brightBlack: '#666666',
    brightRed: '#ff6666',
    brightGreen: '#66ff66',
    brightYellow: '#ffff66',
    brightBlue: '#6666ff',
    brightMagenta: '#ff66ff',
    brightCyan: '#66ffff',
    brightWhite: '#ffffff',
  },
});

const makeHost = (id: string, overrides: Partial<Host> = {}): Host => ({
  id,
  label: `Host ${id}`,
  hostname: `${id}.example.com`,
  username: 'root',
  port: 22,
  protocol: 'ssh',
  tags: [],
  os: 'linux',
  createdAt: 1,
  ...overrides,
});

const makeSession = (id: string, hostId: string, overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id,
  hostId,
  hostLabel: `Host ${hostId}`,
  username: 'root',
  hostname: `${hostId}.example.com`,
  status: 'connected',
  ...overrides,
});

const makeWorkspace = (focusedSessionId: string): Workspace => ({
  id: 'workspace-1',
  title: 'Workspace',
  viewMode: 'split',
  focusedSessionId,
  root: {
    id: 'split-1',
    type: 'split',
    direction: 'vertical',
    sizes: [0.5, 0.5],
    children: [
      { id: 'pane-a', type: 'pane', sessionId: 'session-a' },
      { id: 'pane-b', type: 'pane', sessionId: 'session-b' },
    ],
  },
});

type HookOptions = Parameters<typeof useTerminalThemePanelState>[0];
type HookResult = ReturnType<typeof useTerminalThemePanelState>;

function createBaseOptions(overrides: Partial<HookOptions> = {}): {
  options: HookOptions;
  calls: {
    clearIntent: number;
    pickTheme: Array<unknown[]>;
    updatedHosts: Host[];
    updatedTerminalThemeIds: string[];
    updatedTerminalFontFamilyIds: string[];
    updatedTerminalFontSizes: number[];
    updatedTerminalFontWeights: number[];
    updatedSessionFontSizes: Array<{ sessionId: string; fontSize: number }>;
    clearedSessionFontSizes: string[];
  };
} {
  const hostA = makeHost('host-a');
  const hostB = makeHost('host-b');
  const sessionA = makeSession('session-a', 'host-a');
  const sessionB = makeSession('session-b', 'host-b');
  const defaultTheme = makeTheme('default-dark');

  const calls = {
    clearIntent: 0,
    pickTheme: [] as Array<unknown[]>,
    updatedHosts: [] as Host[],
    updatedTerminalThemeIds: [] as string[],
    updatedTerminalFontFamilyIds: [] as string[],
    updatedTerminalFontSizes: [] as number[],
    updatedTerminalFontWeights: [] as number[],
    updatedSessionFontSizes: [] as Array<{ sessionId: string; fontSize: number }>,
    clearedSessionFontSizes: [] as string[],
  };

  const options: HookOptions = {
    activeSession: sessionA,
    activeSidePanelTab: 'theme',
    activeWorkspace: undefined,
    clearIntent: () => { calls.clearIntent += 1; },
    followAppTerminalTheme: false,
    focusedSessionId: 'session-a',
    fontSize: 14,
    hostMap: new Map([
      [hostA.id, hostA],
      [hostB.id, hostB],
    ]),
    isSidePanelOpenForCurrentTab: true,
    isVisible: true,
    onUpdateHost: (host) => { calls.updatedHosts.push(host); },
    onUpdateTerminalFontFamilyId: (id) => { calls.updatedTerminalFontFamilyIds.push(id); },
    onUpdateTerminalFontSize: (size) => { calls.updatedTerminalFontSizes.push(size); },
    onUpdateTerminalFontWeight: (weight) => { calls.updatedTerminalFontWeights.push(weight); },
    onUpdateTerminalThemeId: (themeId) => { calls.updatedTerminalThemeIds.push(themeId); },
    onUpdateSessionFontSize: (sessionId, size) => {
      calls.updatedSessionFontSizes.push({ sessionId, fontSize: size });
    },
    onClearSessionFontSizeOverride: (sessionId) => {
      calls.clearedSessionFontSizes.push(sessionId);
    },
    pickTheme: ((...args: unknown[]) => { calls.pickTheme.push(args); }) as HookOptions['pickTheme'],
    resolveFocusedAppearance: (hostScope: TerminalAppearanceHostScope): ResolvedAppearance => {
      const themeId = hostScope.host?.themeOverride && hostScope.host.theme
        ? hostScope.host.theme
        : defaultTheme.id;
      return {
        themeId,
        theme: makeTheme(themeId),
        themeSource: hostScope.host?.themeOverride ? 'host' : 'global',
      } as ResolvedAppearance;
    },
    sessionHostsMap: new Map([
      [sessionA.id, hostA],
      [sessionB.id, hostB],
    ]),
    terminalFontFamilyId: 'jetbrains-mono',
    terminalSettings: { fontWeight: 400 },
    terminalTheme: defaultTheme,
    ...overrides,
  };

  return { options, calls };
}

test('all 8 theme panel callbacks keep identical references and preserve terminalLayerSidePanelStableCtxEqual across focus/host changes', async () => {
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const { options } = createBaseOptions();
  let latestResult!: HookResult;

  function Harness({ hookOptions }: { hookOptions: HookOptions }) {
    latestResult = useTerminalThemePanelState(hookOptions);
    return null;
  }

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(Harness, { hookOptions: options }));
    });

    const initialCallbacks = Object.fromEntries(
      CALLBACK_KEYS.map((key) => [key, latestResult[key]]),
    );
    const prevCtx = {
      mountedSftpTabIds: ['session-a', 'session-b'],
      sidePanelOpenTabs: new Map([['session-a', 'theme']]),
      ...initialCallbacks,
    };

    // Switch standalone terminal tab to a different host + different workspace focus.
    const hostB = options.hostMap.get('host-b')!;
    const sessionB = makeSession('session-b', hostB.id);
    const nextOptions: HookOptions = {
      ...options,
      activeSession: sessionB,
      activeWorkspace: makeWorkspace('session-b'),
      focusedSessionId: 'session-b',
      fontSize: 16,
      terminalSettings: { fontWeight: 500 },
    };

    await act(async () => {
      renderer!.update(React.createElement(Harness, { hookOptions: nextOptions }));
    });

    const nextCallbacks = Object.fromEntries(
      CALLBACK_KEYS.map((key) => [key, latestResult[key]]),
    );

    for (const key of CALLBACK_KEYS) {
      assert.equal(
        nextCallbacks[key],
        initialCallbacks[key],
        `${key} must keep a stable reference across focus/host changes`,
      );
    }

    const nextCtx = {
      ...prevCtx,
      ...nextCallbacks,
    };
    assert.equal(terminalLayerSidePanelStableCtxEqual(prevCtx, nextCtx), true);
    assert.equal(terminalLayerViewCtxEqual(prevCtx, nextCtx), true);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('stable callbacks read latest focused host/session after focus changes', async () => {
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  const hostA = makeHost('host-a', {
    theme: 'nord',
    themeOverride: true,
    fontFamily: 'fira-code',
    fontFamilyOverride: true,
    fontSize: 15,
    fontSizeOverride: true,
    fontWeight: 500,
    fontWeightOverride: true,
  });
  const hostB = makeHost('host-b', {
    theme: 'solarized',
    themeOverride: true,
    fontFamily: 'menlo',
    fontFamilyOverride: true,
    fontSize: 13,
    fontSizeOverride: true,
    fontWeight: 400,
    fontWeightOverride: true,
  });
  const sessionA = makeSession('session-a', 'host-a');
  const sessionB = makeSession('session-b', 'host-b');

  const { options, calls } = createBaseOptions({
    activeSession: sessionA,
    focusedSessionId: 'session-a',
    hostMap: new Map([
      [hostA.id, hostA],
      [hostB.id, hostB],
    ]),
    sessionHostsMap: new Map([
      [sessionA.id, hostA],
      [sessionB.id, hostB],
    ]),
  });

  let latestResult!: HookResult;
  function Harness({ hookOptions }: { hookOptions: HookOptions }) {
    latestResult = useTerminalThemePanelState(hookOptions);
    return null;
  }

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(Harness, { hookOptions: options }));
    });

    // Capture callbacks from the first render (while focused on host-a).
    const firstRender = latestResult;

    // Switch focus to host-b (standalone session).
    await act(async () => {
      renderer!.update(React.createElement(Harness, {
        hookOptions: {
          ...options,
          activeSession: sessionB,
          focusedSessionId: 'session-b',
        },
      }));
    });

    await act(async () => {
      firstRender.handleThemeChangeForFocusedSession('dracula');
      firstRender.handleThemeResetForFocusedSession();
      firstRender.handleFontFamilyChangeForFocusedSession('jetbrains-mono');
      firstRender.handleFontFamilyResetForFocusedSession();
      firstRender.handleFontSizeChangeForFocusedSession(18);
      firstRender.handleFontSizeResetForFocusedSession();
      firstRender.handleFontWeightChangeForFocusedSession(600);
      firstRender.handleFontWeightResetForFocusedSession();
    });

    assert.deepEqual(calls.pickTheme, [
      ['dracula', { followApp: false, scopeHostId: 'host-b' }],
    ]);
    assert.equal(calls.clearIntent, 1);
    assert.equal(calls.updatedHosts.length, 8);
    assert.ok(
      calls.updatedHosts.every((host) => host.id === 'host-b'),
      'all host mutations must target the latest focused host (host-b)',
    );
    assert.equal(calls.updatedHosts[0].theme, 'dracula');
    assert.equal(calls.updatedHosts[0].themeOverride, true);
    assert.equal(calls.updatedHosts[1].theme, undefined);
    assert.equal(calls.updatedHosts[1].themeOverride, false);
    assert.equal(calls.updatedHosts[2].fontFamily, 'jetbrains-mono');
    assert.equal(calls.updatedHosts[2].fontFamilyOverride, true);
    assert.equal(calls.updatedHosts[3].fontFamily, undefined);
    assert.equal(calls.updatedHosts[3].fontFamilyOverride, false);
    assert.equal(calls.updatedHosts[4].fontSize, 18);
    assert.equal(calls.updatedHosts[4].fontSizeOverride, true);
    assert.equal(calls.updatedHosts[5].fontSize, undefined);
    assert.equal(calls.updatedHosts[5].fontSizeOverride, false);
    assert.equal(calls.updatedHosts[6].fontWeight, 600);
    assert.equal(calls.updatedHosts[6].fontWeightOverride, true);
    assert.equal(calls.updatedHosts[7].fontWeight, undefined);
    assert.equal(calls.updatedHosts[7].fontWeightOverride, false);

    // Switch into a split workspace focused on session-b and verify session-scoped font size calls.
    await act(async () => {
      renderer!.update(React.createElement(Harness, {
        hookOptions: {
          ...options,
          activeSession: undefined,
          activeWorkspace: makeWorkspace('session-b'),
          focusedSessionId: 'session-b',
        },
      }));
    });

    await act(async () => {
      firstRender.handleFontSizeChangeForFocusedSession(20);
      firstRender.handleFontSizeResetForFocusedSession();
    });

    assert.deepEqual(calls.updatedSessionFontSizes, [{ sessionId: 'session-b', fontSize: 20 }]);
    assert.deepEqual(calls.clearedSessionFontSizes, ['session-b']);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('startTransition callbacks snapshot target host/session before a focus change commits', async () => {
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;

  // Run the real hook body with a controllable startTransition so we can shift
  // focus between callback invocation and transition execution.
  const source = readFileSync(new URL('./useTerminalThemePanelState.ts', import.meta.url), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const pendingTransitions: Array<() => void> = [];
  const deferredStartTransition = (callback: () => void) => {
    pendingTransitions.push(callback);
  };

  const exportsObj: Record<string, unknown> = {};
  const moduleObj = { exports: exportsObj };
  const deps: Record<string, unknown> = {
    react: {
      startTransition: deferredStartTransition,
      useCallback,
      useEffect,
      useMemo,
      useRef,
    },
    '../../application/state/appearanceChromeStore': { useAppearanceChromeStore },
    '../../domain/terminalAppearance': {
      clearHostFontFamilyOverride,
      clearHostFontSizeOverride,
      clearHostFontWeightOverride,
      clearHostThemeOverride,
      hasHostFontFamilyOverride,
      hasHostFontSizeOverride,
      hasHostFontWeightOverride,
      hasHostThemeOverride,
      resolveHostTerminalFontFamilyId,
      resolveHostTerminalFontSize,
      resolveHostTerminalFontWeight,
      resolveHostTerminalThemeId,
    },
    '../../domain/ephemeralHosts': { isSavedVaultHost },
    '../../infrastructure/config/fonts': { isSameResolvedTerminalFont },
    '../terminalTopTabsTheme': { getScopedTopTabsThemeId },
  };

  vm.runInNewContext(transpiled, {
    exports: exportsObj,
    module: moduleObj,
    require: (specifier: string) => {
      if (!(specifier in deps)) {
        throw new Error(`Unexpected require in test harness: ${specifier}`);
      }
      return deps[specifier];
    },
    navigator: globalThis.navigator,
  });

  const useHookWithDeferredTransition = moduleObj.exports.useTerminalThemePanelState as typeof useTerminalThemePanelState;

  const { options, calls } = createBaseOptions();
  const sessionB = makeSession('session-b', 'host-b');

  let latestResult!: HookResult;
  function Harness({ hookOptions }: { hookOptions: HookOptions }) {
    latestResult = useHookWithDeferredTransition(hookOptions);
    return null;
  }

  let renderer: ReactTestRenderer | undefined;
  try {
    // 1. Standalone saved host: invoke all 3 startTransition handlers while focused on host-a.
    await act(async () => {
      renderer = create(React.createElement(Harness, { hookOptions: options }));
    });

    latestResult.handleFontFamilyChangeForFocusedSession('fira-code');
    latestResult.handleFontSizeChangeForFocusedSession(17);
    latestResult.handleFontWeightChangeForFocusedSession(700);
    assert.equal(pendingTransitions.length, 3);

    // Move focus to host-b BEFORE any of the 3 transitions execute.
    await act(async () => {
      renderer!.update(React.createElement(Harness, {
        hookOptions: {
          ...options,
          activeSession: sessionB,
          focusedSessionId: 'session-b',
        },
      }));
    });

    // Now flush the queued transitions and verify all 3 still mutate host-a.
    while (pendingTransitions.length > 0) {
      pendingTransitions.shift()!();
    }

    assert.equal(calls.updatedHosts.length, 3);
    assert.deepEqual(
      calls.updatedHosts.map((host) => host.id),
      ['host-a', 'host-a', 'host-a'],
      'deferred startTransition updates must target the snapshotted host-a, not newly focused host-b',
    );
    assert.equal(calls.updatedHosts[0].fontFamily, 'fira-code');
    assert.equal(calls.updatedHosts[1].fontSize, 17);
    assert.equal(calls.updatedHosts[2].fontWeight, 700);

    // 2. Workspace split-pane focus change before transition commits.
    await act(async () => {
      renderer!.update(React.createElement(Harness, {
        hookOptions: {
          ...options,
          activeSession: undefined,
          activeWorkspace: makeWorkspace('session-a'),
          focusedSessionId: 'session-a',
        },
      }));
    });

    latestResult.handleFontSizeChangeForFocusedSession(19);
    assert.equal(pendingTransitions.length, 1);

    // Focus shifts to pane B before the transition callback runs.
    await act(async () => {
      renderer!.update(React.createElement(Harness, {
        hookOptions: {
          ...options,
          activeSession: undefined,
          activeWorkspace: makeWorkspace('session-b'),
          focusedSessionId: 'session-b',
        },
      }));
    });

    pendingTransitions.shift()!();
    assert.deepEqual(calls.updatedSessionFontSizes, [
      { sessionId: 'session-a', fontSize: 19 },
    ]);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
