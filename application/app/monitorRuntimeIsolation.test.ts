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
  return vm.runInNewContext(`${code}; ${name}`, { React, ...bindings }) as React.ComponentType;
}

test('monitor controls update their runtime without rendering unrelated app siblings', async () => {
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  let updateMonitor: (() => void) | undefined;
  let runtimeRenders = 0;
  let sideEffectRenders = 0;
  let shellRenders = 0;
  const useMonitorRuntime = () => {
    const [, setVersion] = useState(0);
    updateMonitor = () => setVersion((version) => version + 1);
    runtimeRenders += 1;
  };
  const MonitorRuntimeHost = loadComponent('./MonitorRuntimeHost.tsx', 'MonitorRuntimeHost', { useMonitorRuntime });
  const App = loadComponent('../../App.tsx', 'App', {
    useMonitorRuntime,
    MonitorRuntimeHost,
    AppLocalStateProvider: ({ children }: { children: React.ReactNode }) => children,
    AppSideEffects: () => { sideEffectRenders += 1; return null; },
    MonitorHostKeyDialog: () => null,
    AppShell: React.memo(() => { shellRenders += 1; return null; }),
  });
  let renderer: ReturnType<typeof create> | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(App)); });
    const initialRuntimeRenders = runtimeRenders;
    const initialSideEffectRenders = sideEffectRenders;
    const initialShellRenders = shellRenders;
    for (let i = 0; i < 10; i += 1) {
      await act(async () => updateMonitor!());
    }
    assert.equal(runtimeRenders - initialRuntimeRenders, 10, 'monitor updates must still run');
    assert.equal(sideEffectRenders - initialSideEffectRenders, 0, 'monitor-only state must not render AppSideEffects');
    assert.equal(shellRenders - initialShellRenders, 0, 'monitor controls must leave the shell stable');
  } finally {
    await act(async () => renderer?.unmount());
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
