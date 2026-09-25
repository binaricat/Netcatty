import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import type { Identity } from '../../types';

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
  const identities: Identity[] = [
    { id: 'saved', label: 'Password B', username: 'deploy', authMethod: 'password', password: 'saved-secret', created: 0 },
    { id: 'unusable', label: 'Unreadable', username: 'root', authMethod: 'password', password: 'enc:v1:djEwdGVzdAAAAAAAAAAAAAAAAA==', created: 1 },
  ];
  const submissions: Array<{ username: string; password: string; save: boolean }> = [];
  const Form = () => {
    const [username, setUsername] = React.useState('root');
    const [password, setPassword] = React.useState('');
    const submit = (save: boolean) => submissions.push({ username, password, save });
    return <TerminalAuthDialog
      authMethod="password" setAuthMethod={() => {}}
      authUsername={username} setAuthUsername={setUsername}
      authPassword={password} setAuthPassword={setPassword}
      authKeyId={null} setAuthKeyId={() => {}}
      authPassphrase="" setAuthPassphrase={() => {}}
      showAuthPassphrase={false} setShowAuthPassphrase={() => {}}
      showAuthPassword={false} setShowAuthPassword={() => {}}
      authRetryMessage="Authentication failed" keys={[]} identities={identities}
      onSubmit={() => submit(true)} onSubmitWithoutSave={() => submit(false)}
      onCancel={() => {}} isValid={Boolean(username.trim() && password)}
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
    assert.equal((window.document.getElementById('auth-password') as HTMLInputElement).value, 'saved-secret');
    await act(async () => button('Continue')!.click());
    assert.deepEqual(submissions.at(-1), { username: 'deploy', password: 'saved-secret', save: false });
    await act(async () => window.document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    await act(async () => button('Continue & Save')!.click());
    assert.deepEqual(submissions.at(-1), { username: 'deploy', password: 'saved-secret', save: true });
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
