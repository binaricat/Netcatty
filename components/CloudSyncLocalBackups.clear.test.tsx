import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { I18nProvider } from '../application/i18n/I18nProvider';
import { loadLocaleMessages } from '../application/i18n/messages';
import { createDomRenderer, dispatchDomEvent, flushEffects, installDomEnvironment, runWithAct } from './test-support/renderReactDom';

test('backup cleanup confirms, preserves data on cancel, refreshes after retry and explains decrypt failures', async () => {
  await loadLocaleMessages('zh-CN');
  const dom = installDomEnvironment();
  const globals = {
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    NodeFilter: dom.window.NodeFilter,
    HTMLInputElement: dom.window.HTMLInputElement,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  Object.defineProperty(dom.window.navigator, 'locks', { configurable: true, value: {
    request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}),
  } });
  const { LocalBackupsPanel } = await import('./cloud-sync/CloudSyncLocalBackupsPanel');
  const { toast } = await import('./ui/toast');
  const renderer = await createDomRenderer(dom.document);
  const notices: string[] = [];
  const success = toast.success;
  const error = toast.error;
  toast.success = (message) => { notices.push(`success:${message}`); };
  toast.error = (message) => { notices.push(`error:${message}`); };
  let calls = 0;
  let fail = true;
  let hasBackup = true;
  let finish: (() => void) | undefined;
  let finishProbe: ((result: { encryptionAvailable: boolean }) => void) | undefined;
  Object.defineProperty(dom.window, 'netcatty', { configurable: true, value: {
    // Cleanup must remain available even when encrypted backups cannot be read.
    getVaultBackupCapabilities: () => new Promise((resolve) => { finishProbe = resolve; }),
    listVaultBackups: async () => hasBackup ? [{
      id: 'fixture', createdAt: 1, reason: 'before_restore', fingerprint: 'fixture',
      preview: { hostCount: 1, keyCount: 0, snippetCount: 0, noteCount: 0, identityCount: 0, portForwardingRuleCount: 0 },
    }] : [],
    readVaultBackup: async () => {
      throw new Error("Error invoking remote method 'netcatty:vaultBackups:read': Error: VAULT_BACKUP_DECRYPT_FAILED");
    },
    clearVaultBackups: async () => {
      calls += 1;
      if (fail) throw new Error('access denied');
      await new Promise<void>((resolve) => { finish = resolve; });
      hasBackup = false;
      return { deletedCount: 1 };
    },
  } });
  const click = async (node: Element) => {
    await dispatchDomEvent(node, new dom.window.MouseEvent('click', { bubbles: true }));
    await flushEffects();
  };
  const button = (text: string, scope: ParentNode = dom.document) => {
    const node = [...scope.querySelectorAll('button')].find((el) => el.textContent === text);
    assert.ok(node, `button ${text}`);
    return node as HTMLButtonElement;
  };
  try {
    await renderer.render(<I18nProvider locale="en"><LocalBackupsPanel onApplyPayload={() => { throw new Error('must not restore'); }} /></I18nProvider>);
    await flushEffects();
    assert.match(dom.document.body.textContent ?? '', /This folder alone is not a complete, portable backup/);
    assert.match(dom.document.body.textContent ?? '', /Deleting or wiping the app profile \(userData\)/);
    assert.doesNotMatch(dom.document.body.textContent ?? '', /Master key required/);
    assert.equal([...dom.document.querySelectorAll('button')].some((el) => el.textContent === 'Restore'), false);
    await runWithAct(async () => { finishProbe?.({ encryptionAvailable: false }); });
    await flushEffects();
    assert.doesNotMatch(dom.document.body.textContent ?? '', /Master key required/);
    assert.equal([...dom.document.querySelectorAll('button')].some((el) => el.textContent === 'Restore'), false);
    await click(button('Clear all backups'));
    let dialog = dom.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /current hosts, saved credentials and cloud copies will remain/);
    await click(button('Cancel', dialog));
    assert.equal(calls, 0);
    assert.equal(hasBackup, true);
    await click(button('Clear all backups'));
    dialog = dom.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    await click(button('Clear all backups', dialog));
    assert.equal(calls, 1);
    assert.match(notices[0], /^error:/);
    assert.equal(hasBackup, true);
    dialog = dom.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    fail = false;
    await click(button('Clear all backups', dialog));
    assert.equal(calls, 2);
    assert.equal(button('Clear all backups', dialog).disabled, true);
    assert.equal(button('Cancel', dialog).disabled, true);
    assert.equal(notices.length, 1);
    await runWithAct(async () => { finish?.(); });
    await flushEffects();
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.match(dom.document.body.textContent ?? '', /No local backups yet/);
    assert.match(notices[1], /^success:/);

    hasBackup = true;
    await renderer.render(<I18nProvider locale="zh-CN"><LocalBackupsPanel key="restore" onApplyPayload={() => { throw new Error('must not apply unreadable backup'); }} /></I18nProvider>);
    await runWithAct(async () => { finishProbe?.({ encryptionAvailable: true }); });
    await flushEffects();
    assert.match(dom.document.body.textContent ?? '', /仅复制此文件夹并不构成完整、可迁移的备份/);
    await click(button('恢复'));
    dialog = dom.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    await click(button('恢复', dialog));
    assert.match(notices[2], /当前应用配置无法解密此备份/);
    assert.match(notices[2], /可能是加密密钥丢失、应用配置已更改，或备份已损坏/);
    assert.doesNotMatch(notices[2], /VAULT_BACKUP_DECRYPT_FAILED|decryptString/);
  } finally {
    toast.success = success;
    toast.error = error;
    await renderer.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.cleanup();
  }
});
