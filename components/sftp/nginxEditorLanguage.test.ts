import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import type { TextEditorPaneProps } from '../editor/TextEditorPane';
import type { SftpStateApi } from '../../application/state/useSftpState';
import { editorTabStore } from '../../application/state/editorTabStore';
import { activeTabStore } from '../../application/state/activeTabStore';
import { useSftpViewFileOps } from './hooks/useSftpViewFileOps';

// Keep the real modal state/save flow; replace only Monaco and visual chrome.
function loadModal(pane: React.ComponentType<TextEditorPaneProps>) {
  const url = new URL('../TextEditorModal.tsx', import.meta.url);
  const compiled = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const require = createRequire(url);
  const passthrough = ({ children }: { children: React.ReactNode }) => children;
  const replacements: Record<string, unknown> = {
    './editor/TextEditorPane': { TextEditorPane: pane },
    './ui/dialog': { Dialog: passthrough, DialogContent: passthrough, DialogTitle: passthrough },
    './ui/toast': { toast: { success() {}, error() {} } },
    '../application/state/windowInputFocus': { scheduleWindowInputFocus() {} },
  };
  const module = { exports: {} as { default: React.ComponentType<Record<string, unknown>> } };
  new Function('require', 'module', 'exports', compiled)(
    (id: string) => replacements[id] ?? require(id), module, module.exports,
  );
  return module.exports.default;
}

test('SFTP modal uses full paths, preserves manual selection and saves exact content', async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousActiveTab = activeTabStore.getActiveTabId();
  const detached: Array<{ languageId: string; content: string; remotePath: string }> = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout, clearTimeout,
    netcatty: { openEditorWindow: async (snapshot: typeof detached[number]) => {
      detached.push(snapshot);
      return { success: true };
    } },
  } });
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let paneProps: TextEditorPaneProps | undefined;
  const Modal = loadModal((props) => { paneProps = props; return null; });
  let ops: ReturnType<typeof useSftpViewFileOps> | undefined;
  const original = '# fixture\r\nserver { proxy_pass http://$host; }\r\n';
  const writes: unknown[][] = [];
  const connection = { id: 'nginx-fixture', hostId: 'nginx-host', currentPath: '/etc/nginx/conf.d' };
  const sftpRef = { current: {
    leftPane: { id: 'nginx-pane', connection }, rightPane: { id: 'nginx-pane', connection },
    joinPath: (parent: string, name: string) => `${parent}/${name}`,
    readTextFile: async () => original,
    writeTextFile: async (...args: unknown[]) => { writes.push(args); },
  } as unknown as SftpStateApi };
  function Probe() {
    ops = useSftpViewFileOps({
      sftpRef, behaviorRef: { current: '' }, autoSyncRef: { current: false },
      getOpenerForFileRef: { current: () => null }, setOpenerForExtension() {}, t: (key) => key,
    });
    return ops.showTextEditor ? React.createElement(Modal, {
      open: true, onClose() {}, fileName: ops.textEditorTarget!.file.name,
      filePath: ops.textEditorTarget!.fullPath, initialContent: ops.textEditorContent,
      onSave: ops.handleSaveTextFile, editorWordWrap: false, onToggleWordWrap() {},
      hotkeyScheme: 'pc', keyBindings: [], onPromoteToTab: ops.onPromoteToTab,
    }) : null;
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const file = { name: 'site.conf', size: original.length, type: 'file' as const, lastModified: 0, sizeFormatted: '', lastModifiedFormatted: '' };
    await act(async () => { await ops!.onEditFileLeft(file); });
    assert.equal(paneProps!.languageId, 'nginx');
    assert.equal(paneProps!.fileName, 'site.conf');
    // Keep the modal mounted: basename and content stay identical, only path changes.
    await act(async () => { await ops!.onEditFileLeft(file, '/etc/other/site.conf'); });
    assert.equal(paneProps!.languageId, 'ini');
    await act(async () => { await ops!.onEditFileLeft(file, '/etc/nginx/conf.d/site.conf'); });
    assert.equal(paneProps!.languageId, 'nginx');
    await act(async () => { paneProps!.onLanguageChange('ini'); });
    await act(async () => { paneProps!.onSave(); });
    assert.deepEqual(writes, [['left', '/etc/nginx/conf.d/site.conf', original]]);
    await act(async () => { paneProps!.onPromoteToTab!(); });
    let tab = editorTabStore.getTabs().find(({ sessionId }) => sessionId === connection.id);
    assert.equal(tab?.languageId, 'ini', 'promotion preserves a manual override');
    assert.equal(tab?.content, original);
    editorTabStore.close(tab!.id);

    // A generic config can still be switched to Nginx manually.
    await act(async () => { await ops!.onEditFileLeft(file, '/etc/other/site.conf'); });
    assert.equal(paneProps!.languageId, 'ini');
    await act(async () => { paneProps!.onLanguageChange('nginx'); });
    assert.equal(paneProps!.languageId, 'nginx', 'arbitrary config supports manual Nginx selection');
    await act(async () => { paneProps!.onPromoteToTab!(); });
    tab = editorTabStore.getTabs().find(({ sessionId }) => sessionId === connection.id);
    assert.equal(tab?.languageId, 'nginx');

    // Legacy snapshots without language still infer from the full target path.
    await act(async () => { await ops!.onEditFileLeft(file, '/etc/nginx/conf.d/fallback.conf'); });
    await act(async () => { ops!.onPromoteToTab({ fileName: file.name, content: original,
      baselineContent: original, languageId: '', wordWrap: false, viewState: null }); });
    assert.equal(editorTabStore.getTabs().find(({ remotePath }) => remotePath.endsWith('/fallback.conf'))?.languageId, 'nginx');
    await act(async () => { await ops!.onEditFileLeft(file, '/etc/nginx/sites-enabled/example.com'); });
    await act(async () => { ops!.onPopOut({ fileName: file.name, content: original,
      baselineContent: original, languageId: '', wordWrap: false, viewState: null }); });
    assert.equal(detached.at(-1)?.languageId, 'nginx', 'pop-out fallback also uses the full path');
    assert.equal(detached.at(-1)?.remotePath, '/etc/nginx/sites-enabled/example.com');
    assert.equal(detached.at(-1)?.content, original);
  } finally {
    await act(async () => { renderer?.unmount(); });
    for (const tab of editorTabStore.getTabs().filter(({ sessionId }) => sessionId === connection.id)) editorTabStore.close(tab.id);
    activeTabStore.setActiveTabId(previousActiveTab);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('the SFTP overlay forwards path context to the lazy modal', () => {
  const overlay = readFileSync(new URL('./SftpOverlays.tsx', import.meta.url), 'utf8');
  assert.match(overlay, /<LazyTextEditorModal[\s\S]*?filePath=\{textEditorTarget\?\.fullPath\}/);
  const pane = readFileSync(new URL('../editor/TextEditorPane.tsx', import.meta.url), 'utf8');
  assert.match(pane, /beforeMount=\{registerNginxLanguage\}/);
});
