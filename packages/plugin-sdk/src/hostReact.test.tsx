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

test('hostDom eliminates polling intervals and syncs async programmatic form-control mutations', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  const origInputValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value');
  const origInputChecked = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'checked');
  const origTextareaValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value');
  const origSelectValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value');
  const origOptionSelected = Object.getOwnPropertyDescriptor(dom.window.HTMLOptionElement.prototype, 'selected');

  const originalSetInterval = globalThis.setInterval;
  let intervalCalls = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    intervalCalls++;
    return originalSetInterval(...args);
  }) as typeof setInterval;

  const { act, useEffect, useState } = await import('react');
  const { registerHostReactView } = await import('./hostReact.js');
  const { registerHostDomView } = await import('./hostDom.js');

  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };

  function AsyncControls() {
    const [text, setText] = useState('init');
    const [checked, setChecked] = useState(false);
    const [notes, setNotes] = useState('start');
    const [choice, setChoice] = useState('a');
    useEffect(() => {
      const timer = setTimeout(() => {
        setText('async-value');
        setChecked(true);
        setNotes('async-notes');
        setChoice('b');
      }, 10);
      return () => clearTimeout(timer);
    }, []);
    return <div>
      <input type="text" value={text} onChange={(event) => setText(event.currentTarget.value)} />
      <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.currentTarget.checked)} />
      <textarea value={notes} onChange={(event) => setNotes(event.currentTarget.value)} />
      <select value={choice} onChange={(event) => setChoice(event.currentTarget.value)}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
    </div>;
  }

  let receiveSecond: (value: JsonValue) => void = () => {};
  const secondMessages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const secondViews = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receiveSecond = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { secondMessages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };
  let secondInput: HTMLInputElement | null = null;
  let secondOption: HTMLOptionElement | null = null;

  const registration = registerHostReactView(views, 'com.example.async', () => <AsyncControls />);
  const secondRegistration = registerHostDomView(secondViews, 'com.example.second', (container) => {
    secondInput = document.createElement('input');
    secondInput.value = 'v1';
    const select = document.createElement('select');
    select.multiple = true;
    secondOption = document.createElement('option');
    secondOption.value = 'opt1';
    select.appendChild(secondOption);
    container.appendChild(secondInput);
    container.appendChild(select);
  });

  try {
    await act(async () => {
      receive({ kind: 'host-ui.open', instanceId: 'async-1' });
      receiveSecond({ kind: 'host-ui.open', instanceId: 'second-1' });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    assert.equal(intervalCalls, 0, 'must not install a polling setInterval');
    const serialized = JSON.stringify(messages);
    assert.match(serialized, /"async-value"/, 'async controlled input.value must sync');
    assert.match(serialized, /"checked",""/, 'async controlled checkbox.checked must sync');
    assert.match(serialized, /"async-notes"/, 'async controlled textarea.value must sync');
    assert.match(serialized, /"value","b"/, 'async controlled select.value must sync');

    // Idle period must emit zero messages.
    const countAfterSync = messages.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(messages.length, countAfterSync, 'idle view must emit zero polling updates');

    // Closing the first view must keep prototype interception active for the second view.
    await act(async () => { receive({ kind: 'host-ui.close', instanceId: 'async-1' }); });
    const secondCountBefore = secondMessages.length;
    secondInput!.value = 'v2-after-close';
    secondOption!.selected = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(secondMessages.length > secondCountBefore, 'second view still receives programmatic updates');
    const secondPayload = JSON.stringify(secondMessages.slice(secondCountBefore));
    assert.match(secondPayload, /"v2-after-close"/);
    assert.match(secondPayload, /"selected",""/);

    // Closing the last view must restore original prototype property descriptors.
    receiveSecond({ kind: 'host-ui.close', instanceId: 'second-1' });
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set, origInputValue?.set);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'checked')?.set, origInputChecked?.set);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set, origTextareaValue?.set);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')?.set, origSelectValue?.set);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLOptionElement.prototype, 'selected')?.set, origOptionSelected?.set);
  } finally {
    globalThis.setInterval = originalSetInterval;
    registration.dispose();
    secondRegistration.dispose();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT'); dom.window.close();
  }
});

test('hostDom maintains O(1) element index across recursive subtree additions and removals', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }

  const { remoteId } = await import('@remote-dom/core/elements');
  const { registerHostDomView } = await import('./hostDom.js');

  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };

  let clicks = 0;
  let rootRef: HTMLElement | null = null;
  let wrapper: HTMLDivElement | null = null;
  let nestedButton: HTMLButtonElement | null = null;

  const registration = registerHostDomView(views, 'com.example.index', (container) => {
    rootRef = container;
    wrapper = document.createElement('div');
    const section = document.createElement('section');
    nestedButton = document.createElement('button');
    nestedButton.textContent = 'Deep';
    nestedButton.addEventListener('click', () => { clicks++; });
    section.appendChild(nestedButton);
    wrapper.appendChild(section);
    container.appendChild(wrapper);
  });

  try {
    receive({ kind: 'host-ui.open', instanceId: 'idx-1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const buttonId = remoteId(nestedButton!);
    const origQsa = dom.window.Element.prototype.querySelectorAll;
    let qsaCallsDuringEvent = 0;
    dom.window.Element.prototype.querySelectorAll = function (selector: string) {
      qsaCallsDuringEvent++;
      return origQsa.call(this, selector);
    };
    try {
      receive({ kind: 'host-ui.event', instanceId: 'idx-1', event: { eventId: 1, type: 'click', nodeId: buttonId } });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      dom.window.Element.prototype.querySelectorAll = origQsa;
    }

    assert.equal(clicks, 1, 'deeply nested button must be found in O(1) map');
    assert.equal(qsaCallsDuringEvent, 0, 'sendEvent must not scan DOM with querySelectorAll');
    assert.equal(messages.at(-1)?.acknowledgedEvent, 1, 'eventId must be acknowledged');

    // Remove the outer wrapper; its nested descendants must be evicted from the map.
    rootRef!.removeChild(wrapper!);
    await new Promise((resolve) => setTimeout(resolve, 10));
    receive({ kind: 'host-ui.event', instanceId: 'idx-1', event: { eventId: 2, type: 'click', nodeId: buttonId } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(clicks, 1, 'removed nested button must no longer receive events');
    assert.equal(messages.at(-1)?.acknowledgedEvent, 2, 'eventId must still be acknowledged when target was removed');
  } finally {
    registration.dispose();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});

test('hostDom delivers structural insertion before control property updates in the same task', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }

  const { remoteId } = await import('@remote-dom/core/elements');
  const { registerHostDomView } = await import('./hostDom.js');

  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };

  let rootRef: HTMLElement | null = null;
  let existingInput: HTMLInputElement | null = null;

  const registration = registerHostDomView(views, 'com.example.order', (container) => {
    rootRef = container;
    existingInput = document.createElement('input');
    existingInput.value = 'initial';
    container.appendChild(existingInput);
  });

  try {
    receive({ kind: 'host-ui.open', instanceId: 'ord-1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const countBefore = messages.length;
    // Mutate an existing input first (scheduling a control flush), then append a new input
    // with a programmatic value in the same synchronous task.
    existingInput!.value = 'updated';
    const newInput = document.createElement('input');
    newInput.value = 'new';
    rootRef!.appendChild(newInput);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const newInputId = remoteId(newInput);
    const existingInputId = remoteId(existingInput!);
    const emittedMutations = messages.slice(countBefore).flatMap((m) => m.mutations as unknown[][]);

    const insertIndex = emittedMutations.findIndex(
      (record) => record[0] === 0 && typeof record[2] === 'object' && record[2] !== null && (record[2] as { id?: string }).id === newInputId,
    );
    const newPropIndex = emittedMutations.findIndex(
      (record) => record[0] === 3 && record[1] === newInputId && record[2] === 'value' && record[3] === 'new',
    );
    const existingPropIndex = emittedMutations.findIndex(
      (record) => record[0] === 3 && record[1] === existingInputId && record[2] === 'value' && record[3] === 'updated',
    );

    assert.notEqual(insertIndex, -1, 'new input structural insertion must be emitted');
    assert.notEqual(newPropIndex, -1, 'new input programmatic value must be emitted');
    assert.notEqual(existingPropIndex, -1, 'existing input updated value must be emitted');
    assert.ok(insertIndex < newPropIndex, `structural insertion (${insertIndex}) must precede control property update (${newPropIndex})`);
  } finally {
    registration.dispose();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});

test('hostDom syncs valueAsNumber, valueAsDate, stepUp, stepDown, and setRangeText mutations', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }

  const origValueAsNumber = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'valueAsNumber');
  const origValueAsDate = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'valueAsDate');
  const origStepUp = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'stepUp');
  const origStepDown = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'stepDown');
  const origInputSetRangeText = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'setRangeText');
  const origTextareaSetRangeText = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'setRangeText');

  const { registerHostDomView } = await import('./hostDom.js');

  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };

  let numberInput: HTMLInputElement | null = null;
  let dateInput: HTMLInputElement | null = null;
  let textInput: HTMLInputElement | null = null;
  let textarea: HTMLTextAreaElement | null = null;

  const registration = registerHostDomView(views, 'com.example.native-mutators', (container) => {
    numberInput = document.createElement('input');
    numberInput.type = 'number';
    numberInput.value = '10';
    dateInput = document.createElement('input');
    dateInput.type = 'date';
    textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.value = 'hello world';
    textarea = document.createElement('textarea');
    textarea.value = 'alpha beta';
    container.append(numberInput, dateInput, textInput, textarea);
  });

  try {
    receive({ kind: 'host-ui.open', instanceId: 'mut-1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    let before = messages.length;
    numberInput!.valueAsNumber = 42;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(JSON.stringify(messages.slice(before)), /"value","42"/, 'valueAsNumber must trigger sync');

    before = messages.length;
    numberInput!.stepUp();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(JSON.stringify(messages.slice(before)), /"value","43"/, 'stepUp must trigger sync');

    before = messages.length;
    numberInput!.stepDown(3);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(JSON.stringify(messages.slice(before)), /"value","40"/, 'stepDown must trigger sync');

    before = messages.length;
    dateInput!.valueAsDate = new Date(Date.UTC(2026, 4, 15));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(JSON.stringify(messages.slice(before)), /"value","2026-05-15"/, 'valueAsDate must trigger sync');

    before = messages.length;
    textInput!.setRangeText('catty', 6, 11);
    textarea!.setRangeText('gamma', 6, 10);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rangePayload = JSON.stringify(messages.slice(before));
    assert.match(rangePayload, /"value","hello catty"/, 'input.setRangeText must trigger sync');
    assert.match(rangePayload, /"value","alpha gamma"/, 'textarea.setRangeText must trigger sync');

    receive({ kind: 'host-ui.close', instanceId: 'mut-1' });
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'valueAsNumber')?.set, origValueAsNumber?.set);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'valueAsDate')?.set, origValueAsDate?.set);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'stepUp')?.value, origStepUp?.value);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'stepDown')?.value, origStepDown?.value);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'setRangeText')?.value, origInputSetRangeText?.value);
    assert.equal(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'setRangeText')?.value, origTextareaSetRangeText?.value);
  } finally {
    registration.dispose();
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
});
