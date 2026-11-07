import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event'] as const) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
for (const [name, value] of Object.entries({ IS_REACT_ACT_ENVIRONMENT: true, fetch: () => { throw new Error('Network is forbidden in model discovery tests'); } })) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
after(() => {
  dom.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
const { I18nProvider } = await import('../../../../application/i18n/I18nProvider');
const { TooltipProvider } = await import('../../../ui/tooltip');
const { ModelSelector } = await import('./ModelSelector');

type Response = { ok: boolean; status?: number; data: string; error?: string };
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Props = React.ComponentProps<typeof ModelSelector>;
const baseProps: Props = {
  value: '', onChange: () => {}, baseURL: 'http://127.0.0.1:9217/v1',
  providerId: 'custom', style: 'openai', apiKey: 'SYNTHETIC_FIXTURE_KEY', customHeaders: {},
};
async function mount() {
  const requests: ({ url: string; method: string; body: string | undefined } & ReturnType<typeof deferred>)[] = [];
  const allowlistCalls: string[] = [];
  let overflow = false;
  Object.defineProperty(window, 'netcatty', { configurable: true, value: {
    aiAllowlistAddHost: async (baseURL: string) => { allowlistCalls.push(baseURL); return { ok: true }; },
    aiFetch: (url: string, method: string, _headers: unknown, body: string | undefined) => {
      // Hold instead of rejecting if a regression exceeds the budget, so even a
      // broken auto-fetch effect cannot create an uncontrolled test loop.
      if (requests.length >= 4) { overflow = true; return new Promise<Response>(() => {}); }
      const pending = deferred();
      requests.push({ url, method, body, ...pending });
      return pending.promise;
    },
  } });
  let renderer!: ReactTestRenderer;
  const view = (updates: Partial<Props> = {}) => <I18nProvider locale="en"><TooltipProvider>
    <ModelSelector {...baseProps} {...updates} />
  </TooltipProvider></I18nProvider>;
  await act(async () => { renderer = create(view()); });
  const input = () => renderer.root.findByType('input');
  const open = async () => { await act(async () => input().props.onFocus()); };
  const close = async () => { await act(async () => input().props.onBlur()); };
  const refresh = async () => {
    const button = renderer.root.findAllByType('button').find((node) => typeof node.props.onClick === 'function')!;
    await act(async () => button.props.onClick({ defaultPrevented: false }));
  };
  const markup = () => JSON.stringify(renderer.toJSON());
  return {
    requests, allowlistCalls, input, open, close, refresh, markup,
    update: async (updates: Partial<Props>) => { await act(async () => renderer.update(view(updates))); },
    assertBounded: () => assert.equal(overflow, false, 'mock request budget was not exceeded'),
    unmount: async () => { await act(async () => renderer.unmount()); },
  };
}
const notFound: Response = { ok: false, status: 404, data: '{"error":"fixture has no model-list route"}' };
const models = (id: string): Response => ({ ok: true, status: 200, data: JSON.stringify({ data: [{ id }] }) });

for (const failure of ['404', 'transport', 'invalid-json'] as const) {
  test(`model discovery ${failure} failure stays visible without auto-retry; Refresh retries once`, async () => {
    const h = await mount();
    const reject = (index: number) => {
      if (failure === 'transport') h.requests[index].reject(new Error('Synthetic model-list transport failure'));
      else h.requests[index].resolve(failure === '404' ? notFound : { ok: true, status: 200, data: '{not json' });
    };
    try {
      assert.equal(h.requests.length, 0);
      await h.open();
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].url, 'http://127.0.0.1:9217/v1/models');
      assert.equal(h.requests[0].method, 'GET');
      assert.equal(h.requests[0].body, undefined);
      await act(async () => reject(0));
      assert.equal(h.requests.length, 1, 'failure must settle instead of triggering the loading effect again');
      assert.match(h.markup(), /text-destructive/);
      assert.doesNotMatch(h.markup(), /Loading models/);
      await h.close();
      await h.open();
      await h.update({ customHeaders: {} });
      assert.equal(h.requests.length, 1, 'reopen or an equal-config render must not retry a failure');
      assert.match(h.markup(), /text-destructive/);
      await h.refresh();
      assert.equal(h.requests.length, 2);
      await act(async () => reject(1));
      assert.equal(h.requests.length, 2);
      assert.match(h.markup(), /text-destructive/);
      assert.equal(h.allowlistCalls.length, 2);
      h.assertBounded();
    } finally { await h.unmount(); }
  });
}

test('changing provider configuration clears a settled error and permits one fresh discovery', async () => {
  const h = await mount();
  try {
    await h.open();
    await act(async () => h.requests[0].resolve(notFound));
    assert.equal(h.requests.length, 1);
    await h.update({ baseURL: 'http://127.0.0.1:9217/second-provider/v1', providerId: 'openai' });
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].url, 'http://127.0.0.1:9217/second-provider/v1/models');
    await act(async () => h.requests[1].resolve(models('second-model')));
    assert.equal(h.requests.length, 2);
    assert.match(h.markup(), /second-model/);
    assert.doesNotMatch(h.markup(), /Failed to fetch models/);
    h.assertBounded();
  } finally { await h.unmount(); }
});

test('a provider switch ignores an older pending discovery failure', async () => {
  const h = await mount();
  try {
    await h.open();
    await h.update({ baseURL: 'http://127.0.0.1:9217/second-provider/v1' });
    assert.equal(h.requests.length, 2);
    await act(async () => h.requests[1].resolve(models('current-model')));
    await act(async () => h.requests[0].resolve(notFound));
    assert.equal(h.requests.length, 2);
    assert.match(h.markup(), /current-model/);
    assert.doesNotMatch(h.markup(), /Failed to fetch models/);
    h.assertBounded();
  } finally { await h.unmount(); }
});

test('successful discovery remains cached across reopen and manual model entry remains controlled', async () => {
  const h = await mount();
  try {
    await h.open();
    await act(async () => h.requests[0].resolve(models('listed-model')));
    await h.close();
    await h.open();
    assert.equal(h.requests.length, 1);
    assert.match(h.markup(), /listed-model/);
    const changed: string[] = [];
    await h.update({ onChange: (value) => { changed.push(value); } });
    await act(async () => h.input().props.onChange({ target: { value: 'manual-model' } }));
    await h.update({ value: changed[0] });
    assert.deepEqual(changed, ['manual-model']);
    assert.equal(h.input().props.value, 'manual-model');
    assert.equal(h.requests.length, 1);
    h.assertBounded();
  } finally { await h.unmount(); }
});

test('closing and unmounting with a pending discovery do not trigger another request', async () => {
  const h = await mount();
  try {
    await h.open();
    await h.close();
    await act(async () => h.requests[0].resolve(notFound));
    assert.equal(h.requests.length, 1);
    await h.refresh();
    assert.equal(h.requests.length, 2);
    h.assertBounded();
  } finally { await h.unmount(); }
  await act(async () => h.requests[1].resolve(notFound));
  assert.equal(h.requests.length, 2);
});
