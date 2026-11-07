import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';

test('host dialog drives choice/input/copy and a single scoped clipboard share using real service action tokens', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../application/i18n/I18nProvider');
  const { PluginHostInteractionHost } = await import('./plugins/PluginHostInteractionHost');
  const { PluginHostInteractionService, assertInteractionRequest } = await import('../electron/plugins/hostInteractionService.cjs');
  const { getTerminalPaneRenderSnapshot, parseTerminalPaneRenderSnapshot, resolveTerminalPaneInputProps } = await import('./terminalPaneVisibility');
  const { createPluginTerminalSelectionSource } = await import('../application/state/usePluginTerminalSelection');
  const { registerTerminalSelectionSource } = await import('../infrastructure/plugins/terminalSelectionRegistry');
  const { privateOwner, LOCAL_SOURCE } = await import('../electron/plugins/sourceIdentity.cjs');
  let selectionReads = 0;
  let selectionText = 'synthetic terminal selection\nsecond line';
  let listener: ((event: unknown) => void) | null = null;
  let reads = 0;
  const writes: string[] = [];
  const audits: unknown[] = [];
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send(_channel: string, payload: unknown) { listener?.(payload); } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const terminalManager = { getPluginSessionBinding: (id: string, owner: number) => id === 'terminal-a' && owner === 7 ? { epoch: 'worker-a', generation: 1 } : null };
  const service = new PluginHostInteractionService({
    getWindow: () => owner, isLocked: () => false,
    permissionEngine: { onDidRevoke() { return { dispose() {} }; } },
    getTerminalWorkerManager: () => terminalManager,
    database: { privateOwner: (id: string) => privateOwner(LOCAL_SOURCE, id), publicPluginId: () => 'com.example.synthetic', recordSecurityAudit(...args: unknown[]) { audits.push(args); } },
    quotaManager: { chargeBytes() {} },
    clipboard: { readText() { reads++; return 'synthetic private text'; }, writeText(value: string) { writes.push(value); } },
  });
  Object.assign(dom.window, { netcatty: {
    async setPluginTerminalTarget(target: unknown) { return service.setTerminalTarget(sender, target); },
    onPluginInteraction(callback: (event: unknown) => void) { listener = callback; return () => { listener = null; }; },
    async setPluginInteractionReady(ready: boolean) { return service.setReady(sender, ready); },
    async respondPluginInteraction(response: unknown) { return service.respond(sender, response); },
  } });
  const context = { pluginId: 'com.example.synthetic', pluginVersion: '1.0.0', runtimeId: 'runtime-synthetic', manifest: { features: { required: ['terminal.selection-sharing', 'terminal.input-drafts'] } }, signal: new AbortController().signal, async assertActive() {} };
  const root = createRoot(document.getElementById('root')!);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === text)!;
  const click = async (element: HTMLElement) => { assert.ok(element); await act(async () => { element.click(); await settle(); }); };
  const begin = async (params: unknown) => {
    let promise!: Promise<unknown>;
    await act(async () => { promise = service.request(assertInteractionRequest(params), context); void promise.catch(() => {}); await settle(); });
    return { promise };
  };
  try {
    await act(async () => root.render(<I18nProvider locale="en"><PluginHostInteractionHost /></I18nProvider>));
    const choice = await begin({ kind: 'quickPick', title: 'Synthetic choice', items: [{ id: 'compose', label: 'Compose' }] });
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /com.example.synthetic/);
    assert.equal(button('Continue').disabled, true);
    await click(document.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await click(button('Continue'));
    assert.deepEqual(await choice.promise, { cancelled: false, value: 'compose' });
    await assert.rejects(begin({ kind: 'input', title: 'Invalid hidden newline', initialValue: 'first\nsecond' }), /invalid/);
    assert.equal(document.querySelector('[role="dialog"]'), null, 'invalid initial text never creates a misleading single-line dialog');
    const input = await begin({ kind: 'input', title: 'Synthetic input', initialValue: 'synthetic output' });
    assert.equal(document.querySelector<HTMLInputElement>('input')?.value, 'synthetic output');
    await click(button('Continue'));
    assert.deepEqual(await input.promise, { cancelled: false, value: 'synthetic output' });
    const copy = await begin({ kind: 'clipboard.write', title: 'Copy result', text: 'synthetic output' });
    assert.deepEqual(writes, []);
    assert.equal(document.querySelector('textarea')?.value, 'synthetic output');
    await click(button('Copy to clipboard'));
    assert.deepEqual(await copy.promise, { cancelled: false, value: true });
    assert.deepEqual(writes, ['synthetic output']);
    const share = await begin({ kind: 'clipboard.read', title: 'Share clipboard' });
    assert.equal(reads, 1);
    assert.equal(document.querySelector('textarea')?.value, 'synthetic private text');
    await click(button('Share with plugin'));
    assert.deepEqual(await share.promise, { cancelled: false, value: 'synthetic private text' });
    assert.equal(JSON.stringify(audits).includes('synthetic private text'), false);
    const terminalElement = document.createElement('div'); document.body.append(terminalElement);
    const terminal = { cols: 80, element: terminalElement,
      getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }),
      getSelection() { selectionReads++; return selectionText; },
    } as unknown as import('@xterm/xterm').Terminal;
    const inputProps = resolveTerminalPaneInputProps(parseTerminalPaneRenderSnapshot(getTerminalPaneRenderSnapshot({
      activeTabId: 'terminal-a', sessionId: 'terminal-a', workspaceById: new Map(), isTerminalLayerVisible: true,
    })));
    assert.equal(inputProps.isFocused, false);
    const selectionState = { term: terminal, sessionId: 'terminal-a', bootEpoch: 1, visible: inputProps.isVisible, isFocusedPane: inputProps.isFocusedPane, connected: true, sensitive: false, normalize: false, label: 'Synthetic selected terminal' };
    const cleanupSelection = registerTerminalSelectionSource('terminal-a', createPluginTerminalSelectionSource(() => selectionState, 'renderer-a'));
    try {
      const noShare = await begin({ kind: 'terminal.selection.read', title: 'Synthetic terminal share' });
      assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /passwords, tokens/);
      assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Synthetic selected terminal/);
      await click(button('Cancel'));
      assert.deepEqual(await noShare.promise, { cancelled: true });
      assert.equal(selectionReads, 1);
      const selected = await begin({ kind: 'terminal.selection.read', title: 'Synthetic terminal share' });
      assert.equal(selectionReads, 2);
      assert.equal(document.querySelector('textarea')?.value, selectionText);
      selectionText = 'changed after preview';
      await click(button('Share with plugin'));
      const result = await selected.promise as { cancelled: false; value: { text: string; handle: string } };
      assert.equal(result.value.text, 'synthetic terminal selection\nsecond line');
      assert.equal(selectionReads, 2);
      const draft = await begin({ kind: 'terminal.input.propose', handle: result.value.handle, title: 'Synthetic editable review', text: 'first\nsecond\r\u0003\u001b[31m\u0000' });
      assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /sends no terminal input or Enter/);
      const textarea = document.querySelector('textarea')!;
      assert.equal(textarea.readOnly, false);
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'edited synthetic draft\nnext line');
        textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        textarea.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settle();
      });
      assert.equal(textarea.value, 'edited synthetic draft\nnext line');
      assert.equal(service.pending.size, 1, 'Enter in the editable review does not submit or dispatch');
      assert.match(document.querySelector('pre')?.textContent ?? '', /edited synthetic draft/);
      assert.deepEqual(writes, ['synthetic output']);
      await click(button('Close draft'));
      assert.deepEqual(await draft.promise, { cancelled: false, value: true });
      assert.deepEqual(writes, ['synthetic output']);
      selectionState.visible = false;
      const hidden = await begin({ kind: 'terminal.selection.read', title: 'Hidden terminal' });
      assert.deepEqual(await hidden.promise, { cancelled: true });
      assert.equal(selectionReads, 2);
      assert.equal(document.querySelector('[role="dialog"]'), null);
    } finally { cleanupSelection(); terminalElement.remove(); }
    const cancelled = await begin({ kind: 'clipboard.write', title: 'Cancelled copy', text: 'must not copy' });
    await click(button('Cancel'));
    assert.deepEqual(await cancelled.promise, { cancelled: true });
    assert.deepEqual(writes, ['synthetic output']);
    assert.equal(service.pending.size, 0);
  } finally {
    await act(async () => { root.unmount(); await settle(); }); service.shutdown(); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
