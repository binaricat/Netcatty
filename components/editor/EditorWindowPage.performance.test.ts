import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';

import * as i18n from '../../application/i18n/I18nProvider';
import * as editorTabs from '../../application/state/editorTabStore';
import * as editorClient from '../../application/state/editorWindowClient';
import * as editorRuntime from '../../application/state/useEditorWindow';
import * as windowControls from '../../application/state/useWindowControls';
import * as editorTabBar from './EditorWindowTabBar';
import type { TextEditorPaneProps } from './TextEditorPane';

// Run the actual page, pane hosts, runtime and store. Only Monaco's visual
// surface and the unrelated confirmation/toast chrome are replaced here.
// Counting the memoized pane boundary catches content updates leaking through
// the page root into every inactive editor, rather than testing a hand-written
// approximation of the subscription graph.
function loadPage(pane: React.ComponentType<TextEditorPaneProps>) {
  const source = readFileSync(new URL('./EditorWindowPage.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  } }).outputText;
  const require = createRequire(import.meta.url);
  const dependencies: Record<string, unknown> = {
    '../../application/i18n/I18nProvider': i18n,
    '../../application/state/editorTabStore': editorTabs,
    '../../application/state/editorWindowClient': editorClient,
    '../../application/state/useEditorWindow': editorRuntime,
    '../../application/state/useWindowControls': windowControls,
    '../ui/toast': { toast: { success() {}, error() {}, warning() {} } },
    './UnsavedChangesDialog': {
      UnsavedChangesProvider: ({ children }: { children: () => React.ReactNode }) => children(),
      promptUnsavedChanges: async () => 'cancel',
    },
    './EditorWindowTabBar': editorTabBar,
    './TextEditorPane': { TextEditorPane: pane },
  };
  const module = { exports: {} as { default: React.ComponentType<{ settings: unknown }> } };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => dependencies[id] ?? require(id), module, module.exports,
  );
  return module.exports.default;
}

const makeTab = (index: number): editorTabs.EditorTab => ({
  id: `performance-editor-${index}`,
  kind: 'editor',
  sessionId: 'fixture-session',
  sftpTabId: 'fixture-sftp',
  hostId: 'fixture-host',
  remotePath: `/file-${index}.txt`,
  fileName: `file-${index}.txt`,
  languageId: 'text',
  content: 'original',
  baselineContent: 'original',
  wordWrap: false,
  viewState: null,
  savingState: 'idle',
  saveError: null,
});

test('detached editor typing and tab switches leave unrelated editor panes untouched', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  const panes = new Map<string, TextEditorPaneProps>();
  const renders = new Map<string, number>();
  const titles: string[] = [];
  const saves: unknown[] = [];
  const docked: unknown[] = [];
  let activate: ((payload: { editorId: string }) => void) | undefined;
  let finishDock: ((result: { success: boolean }) => void) | undefined;
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {},
    netcatty: {
      windowIsMaximized: async () => false,
      setWindowTitle: async (title: string) => { titles.push(title); },
      onEditorWindowActivateTab: (callback: typeof activate) => { activate = callback; return () => { activate = undefined; }; },
      saveEditorWindowTab: async (snapshot: unknown) => { saves.push(snapshot); return { ok: true }; },
      dockEditorWindowTab: (snapshot: unknown) => {
        docked.push(snapshot);
        return new Promise<{ success: boolean }>((resolve) => { finishDock = resolve; });
      },
    },
  } });
  const Pane = React.memo((props: TextEditorPaneProps) => {
    const name = props.fileName.replace(/ \*$/, '');
    renders.set(name, (renders.get(name) ?? 0) + 1);
    panes.set(name, props);
    return React.createElement('div', { 'data-editor': name });
  });
  const Page = loadPage(Pane);
  const tabs = Array.from({ length: 10 }, (_, index) => makeTab(index));
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      for (const tab of tabs) editorTabs.editorTabStore._debugInsert(tab);
      renderer = create(React.createElement(i18n.I18nProvider, { locale: 'en-US', children: React.createElement(Page, { settings: { hotkeyScheme: 'mac', keyBindings: [] } }) }));
    });
    renders.clear();
    for (let index = 0; index < 20; index += 1) {
      await act(async () => panes.get('file-9.txt')!.onContentChange(`updated ${index}`, null));
    }
    assert.deepEqual(Object.fromEntries(renders), { 'file-9.txt': 20 });
    assert.equal(editorTabs.editorTabStore.getTab(tabs[9].id)?.content, 'updated 19');
    assert.equal(titles.at(-1), '* file-9.txt');

    renders.clear();
    for (let index = 0; index < 10; index += 1) {
      await act(async () => activate?.({ editorId: tabs[index].id }));
    }
    assert.equal([...renders.values()].reduce((sum, count) => sum + count, 0), 0);
    assert.equal(editorTabs.editorTabStore.getTab(tabs[9].id)?.content, 'updated 19');
    assert.equal(titles.at(-1), '* file-9.txt');

    await act(async () => { await panes.get('file-9.txt')!.onSave(); });
    assert.equal(saves.length, 1);
    assert.equal(editorTabs.editorTabStore.isDirty(tabs[9].id), false);
    assert.equal(titles.at(-1), 'file-9.txt');

    // Dock completion must not steal focus from a tab selected while the
    // acknowledgement was pending; stable callbacks read the latest selection.
    await act(async () => { void panes.get('file-9.txt')!.onDockToMain?.(); });
    assert.equal(docked.length, 1);
    await act(async () => activate?.({ editorId: tabs[0].id }));
    await act(async () => finishDock?.({ success: true }));
    assert.equal(editorTabs.editorTabStore.getTab(tabs[9].id), undefined);
    assert.equal(titles.at(-1), 'file-0.txt');

    await act(async () => panes.get('file-0.txt')!.onRequestClose?.());
    assert.equal(editorTabs.editorTabStore.getTab(tabs[0].id), undefined);
    assert.equal(titles.at(-1), 'file-8.txt');
  } finally {
    await act(async () => {
      renderer?.unmount();
      for (const tab of tabs) editorTabs.editorTabStore.close(tab.id);
    });
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
