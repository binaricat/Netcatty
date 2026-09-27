import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import type { Identity } from '../../types';
import type { Host } from '../../types';
import type { PendingAuth } from './runtime/createTerminalSessionStarters';

test('saved password identity retries with its username and supports both submit paths', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost',
  });
  const { window } = dom;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const installGlobal = (key: string, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement',
    'HTMLTextAreaElement', 'Element', 'SVGElement', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'DOMRect', 'Event', 'KeyboardEvent',
    'MouseEvent', 'PointerEvent',
  ]) {
    installGlobal(key, key === 'window' ? window : window[key as keyof typeof window]);
  }
  installGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  installGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  installGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  installGlobal('ResizeObserver', ResizeObserverStub);
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('../../application/i18n/I18nProvider.tsx');
  const { TerminalAuthDialog } = await import('./TerminalAuthDialog.tsx');
  const { useTerminalAuthState } = await import('./hooks/useTerminalAuthState.ts');
  const identities: Identity[] = [
    { id: 'saved', label: 'Password B', username: 'deploy', authMethod: 'password', password: 'saved-secret', created: 0 },
    { id: 'unusable', label: 'Unreadable', username: 'root', authMethod: 'password', password: 'enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==', created: 1 },
  ];
  const host: Host = {
    id: 'host', label: 'Host', hostname: 'localhost', port: 22, username: 'root',
    identityId: 'old', authMethod: 'password', password: 'wrong', tags: [], os: 'linux',
  };
  const submissions: Array<{ username?: string; password?: string; save?: boolean }> = [];
  const savedHosts: Host[] = [];
  const logs: string[][] = [];
  const Form = () => {
    const pendingAuthRef = React.useRef<PendingAuth>(null);
    const termRef = React.useRef({ clear() {} } as never);
    const auth = useTerminalAuthState({
      host, identities, pendingAuthRef, termRef,
      onUpdateHost: (updated) => savedHosts.push(updated),
      onStartSession: () => submissions.push({
        username: pendingAuthRef.current?.username,
        password: pendingAuthRef.current?.password,
        save: pendingAuthRef.current?.savedToHost,
      }),
      setStatus: () => {}, setProgressLogs: (next) => {
        logs.push(typeof next === 'function' ? next([]) : next);
      },
    });
    return <TerminalAuthDialog
      authMethod={auth.authMethod} setAuthMethod={auth.setAuthMethod}
      authUsername={auth.authUsername} setAuthUsername={auth.setAuthUsername}
      authPassword={auth.authPassword} setAuthPassword={auth.setAuthPassword}
      selectedIdentityId={auth.selectedIdentityId} onSelectIdentity={auth.selectIdentity}
      authKeyId={auth.authKeyId} setAuthKeyId={auth.setAuthKeyId}
      authPassphrase={auth.authPassphrase} setAuthPassphrase={auth.setAuthPassphrase}
      showAuthPassphrase={auth.showAuthPassphrase} setShowAuthPassphrase={auth.setShowAuthPassphrase}
      showAuthPassword={auth.showAuthPassword} setShowAuthPassword={auth.setShowAuthPassword}
      authRetryMessage="Authentication failed" keys={[]} identities={identities}
      onSubmit={() => auth.submit({ saveToHost: true })}
      onSubmitWithoutSave={() => auth.submit({ saveToHost: false })}
      onCancel={() => {}} isValid={auth.isValid}
    />;
  };
  const root = createRoot(window.document.getElementById('root')!);
  const button = (label: string) => (Array.from(window.document.querySelectorAll('button')) as HTMLButtonElement[])
    .find(item => item.textContent?.includes(label));
  try {
    await act(async () => root.render(<I18nProvider locale="en"><Form /></I18nProvider>));
    assert.ok(button('Use saved identity'));
    await act(async () => button('Use saved identity')!.click());
    assert.ok(button('Password B'));
    assert.equal(button('Unreadable'), undefined);
    await act(async () => button('Password B')!.click());
    assert.equal((window.document.getElementById('auth-username') as HTMLInputElement).value, 'deploy');
    assert.equal((window.document.getElementById('auth-password') as HTMLInputElement).value, '');
    assert.equal(window.document.body.textContent?.includes('saved-secret'), false);
    assert.equal(window.document.querySelector<HTMLInputElement>('#auth-password')?.outerHTML.includes('saved-secret'), false);
    assert.equal((window.document.querySelector('#auth-password + button') as HTMLButtonElement).disabled, true);
    await act(async () => button('Continue')!.click());
    assert.deepEqual(submissions.at(-1), { username: 'deploy', password: 'saved-secret', save: false });
    assert.equal(savedHosts.length, 0);
    await act(async () => window.document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    await act(async () => button('Continue & Save')!.click());
    assert.deepEqual(submissions.at(-1), { username: 'deploy', password: 'saved-secret', save: true });
    assert.equal(savedHosts.at(-1)?.identityId, 'saved');
    assert.equal(savedHosts.at(-1)?.password, undefined);
    assert.equal(savedHosts.at(-1)?.savePassword, true);
    assert.equal(logs.flat().some((line) => line.includes('saved-secret')), false);
    const passwordInput = window.document.getElementById('auth-password') as HTMLInputElement;
    const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setInputValue);
    await act(async () => {
      setInputValue.call(passwordInput, 'manual-secret');
      passwordInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.ok(button('Use saved identity'), 'manual edit must clear the saved identity label');
    await act(async () => button('Continue')!.click());
    assert.deepEqual(submissions.at(-1), { username: 'deploy', password: 'manual-secret', save: false });
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
