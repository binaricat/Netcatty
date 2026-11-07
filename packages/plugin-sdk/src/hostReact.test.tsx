import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue, HostDrawnViewMessage } from '@netcatty/plugin-contract';
import { JSDOM } from 'jsdom';

test('ordinary React view renders data updates and responds to its own forwarded clicks', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const { default: React, act, useState } = await import('react');
  const { registerHostReactView } = await import('./hostReact.js');
  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = { onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); }, getState: async () => undefined, setState: async () => {} };
  let submissions = 0; let selected: string[] = [];
  function Example() {
    const [count, setCount] = useState(0); const [name, setName] = useState('');
    return <div>
      <input value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <button className="my-button" onClick={() => setCount(value => value + 1)}>Count {count} {name}</button>
      <form onSubmit={event => { event.preventDefault(); submissions++; }}>
        <button type="submit">Submit</button>
        <select multiple onChange={event => { selected = [...event.currentTarget.selectedOptions].map(option => option.value); }}>
          <option value="a">A</option><option value="b">B</option><option value="c">C</option>
        </select>
      </form>
    </div>;
  }
  const registration = registerHostReactView(views, 'com.example.view', () => <Example />, '.my-button{display:grid}');
  try {
    await act(async () => { receive({ kind: 'host-ui.open', instanceId: 'i1' }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(messages[0].sequence, 1); assert.deepEqual(messages[0].mutations, []);
    const first = messages.at(-1)!; assert.equal(first.kind, 'host-ui.update'); assert.ok(first.sequence >= 2);
    const container = (first.mutations[0] as unknown[])[2] as { children: Array<{ id: string; element: string; attributes: Record<string, string> }> }; const input = container.children[0]; const button = container.children[1]; assert.equal(button.element, 'button');
    await act(async () => { receive({ kind: 'host-ui.event', instanceId: 'i1', event: { type: 'input', nodeId: input.id, value: 'Catty' } }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.match(JSON.stringify(messages.at(-1)), /Catty/); assert.equal(button.attributes.class, 'my-button');
    await act(async () => { receive({ kind: 'host-ui.event', instanceId: 'i1', event: { type: 'click', nodeId: button.id } }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.match(JSON.stringify(messages.at(-1)), /"1"/); assert.ok(messages.at(-1)!.sequence >= 2);
    const form = container.children[2] as unknown as { id: string; children: Array<{ id: string }> };
    await act(async () => {
      receive({ kind: 'host-ui.event', instanceId: 'i1', event: { type: 'click', nodeId: form.children[0].id } });
      receive({ kind: 'host-ui.event', instanceId: 'i1', event: { type: 'submit', nodeId: form.id } });
      receive({ kind: 'host-ui.event', instanceId: 'i1', event: { type: 'change', nodeId: form.children[1].id, values: ['a', 'c'] } });
    });
    assert.equal(submissions, 1, 'forwarded click and host submit must not submit twice');
    assert.deepEqual(selected, ['a', 'c'], 'multiple selection reaches ordinary React handlers');
    await act(async () => { receive({ kind: 'host-ui.close', instanceId: 'i1' }); });
    assert.equal(document.querySelector('button'), null);
  } finally {
    registration.dispose();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); dom.window.close();
  }
});
