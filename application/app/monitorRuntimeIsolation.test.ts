import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import React, { useState } from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

function loadComponent(path: string, name: string, bindings: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  const code = ts.transpile(declaration.getText(ast).replace(/^export /, ''), {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  });
  // Extracting the function drops imports, so inject bare React hooks/APIs into the sandbox.
  return vm.runInNewContext(`${code}; ${name}`, {
    React,
    useState: React.useState,
    useEffect: React.useEffect,
    useLayoutEffect: React.useLayoutEffect,
    useMemo: React.useMemo,
    useCallback: React.useCallback,
    useRef: React.useRef,
    useReducer: React.useReducer,
    useContext: React.useContext,
    memo: React.memo,
    createElement: React.createElement,
    Fragment: React.Fragment,
    ...bindings,
  }) as React.ComponentType;
}

test('App no longer mounts retired built-in MonitorRuntimeHost or MonitorHostKeyDialog', async () => {
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let sideEffectRenders = 0;
  let shellRenders = 0;
  const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /MonitorRuntimeHost/, 'App must not mount retired MonitorRuntimeHost');
  assert.doesNotMatch(appSource, /MonitorHostKeyDialog/, 'App must not mount retired MonitorHostKeyDialog');

  const App = loadComponent('../../App.tsx', 'App', {
    performance: { mark: () => {} },
    AppLocalStateProvider: ({ children }: { children: React.ReactNode }) => children,
    AppSideEffects: () => { sideEffectRenders += 1; return null; },
    AppShell: React.memo(() => { shellRenders += 1; return null; }),
  });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    assert.equal(sideEffectRenders, 1);
    assert.equal(shellRenders, 1);
  } finally {
    await act(async () => renderer?.unmount());
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});

test('MonitorRuntimeHost keeps monitor runtime updates isolated from sibling components when mounted', async () => {
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let updateMonitor: (() => void) | undefined;
  let runtimeRenders = 0;
  let siblingRenders = 0;
  const useMonitorRuntime = () => {
    const [, setVersion] = useState(0);
    updateMonitor = () => setVersion((version) => version + 1);
    runtimeRenders += 1;
  };
  const MonitorRuntimeHost = loadComponent('./MonitorRuntimeHost.tsx', 'MonitorRuntimeHost', { useMonitorRuntime });
  const StableSibling = React.memo(() => { siblingRenders += 1; return null; });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      renderer = create(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(MonitorRuntimeHost),
          React.createElement(StableSibling),
        ),
      );
    });
    const initialRuntimeRenders = runtimeRenders;
    const initialSiblingRenders = siblingRenders;
    for (let i = 0; i < 10; i += 1) {
      await act(async () => updateMonitor!());
    }
    assert.equal(runtimeRenders - initialRuntimeRenders, 10, 'monitor updates must run inside MonitorRuntimeHost');
    assert.equal(siblingRenders - initialSiblingRenders, 0, 'monitor updates must not re-render siblings');
  } finally {
    await act(async () => renderer?.unmount());
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
