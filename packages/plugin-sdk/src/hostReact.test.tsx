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
    assert.equal(messages[0].sequence, 1);
    assert.ok(messages[0].mutations.length > 0, 'first update must contain the atomic initial React tree without a blank frame');
    const first = messages[0]; assert.equal(first.kind, 'host-ui.update');
    const mountRootNode = (first.mutations[0] as unknown[])[2] as { children: Array<{ children: Array<{ id: string; element: string; attributes: Record<string, string> }> }> };
    const container = mountRootNode.children[0]; const input = container.children[0]; const button = container.children[1]; assert.equal(button.element, 'button');
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

test('hostReact widgets and extended surface events round-trip cleanly through hostDom', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });

  const { act } = await import('react');
  const { remoteId } = await import('@remote-dom/core/elements');
  const {
    registerHostReactView,
    usePluginShortcuts,
    PluginPopover,
    PluginCodeEditor,
    PluginDataGrid,
    PluginSplitPane,
    PluginErCanvas,
  } = await import('./hostReact.js');

  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };

  const received: Record<string, unknown> = {};
  const globalShortcuts: string[] = [];
  function IdeView() {
    usePluginShortcuts((sc) => { globalShortcuts.push(sc); });
    return (
      <div data-plugin-chrome="full-bleed">
        <button
          id="row-btn"
          onDoubleClick={(e) => { received.dblclick = { x: e.clientX, y: e.clientY }; }}
          onContextMenu={(e) => { received.contextmenu = { x: e.clientX, y: e.clientY }; }}
        >
          Row
        </button>
        <PluginPopover anchorX={40} anchorY={60} width={240} maxHeight={300} open onClose={() => { received.dismissed = true; }}>
          <span>Action</span>
        </PluginPopover>
        <PluginSplitPane direction="horizontal" initialSize={260} onResizeEnd={(d) => { received.resizeEnd = d; }}>
          <PluginCodeEditor value="SELECT 1;" language="sql" onExecute={(d) => { received.execute = d; }} onShortcut={(d) => { received.editorShortcut = d; }} />
          <PluginDataGrid
            columns={[{ name: 'id', primaryKey: true, foreignKey: { table: 'users', column: 'id' } }]}
            hiddenColumns={[]}
            rows={[{ id: 1 }]}
            editable
            onCellEdit={(d) => { received.cellEdit = d; }}
            onFkJump={(d) => { received.fkJump = d; }}
            onCellCopy={(d) => { received.cellCopy = d; }}
            onCellDoubleClick={(d) => { received.cellDoubleClick = d; }}
          />
        </PluginSplitPane>
        <PluginErCanvas
          tables={[{ name: 'users', columns: [{ name: 'id', type: 'int', isPk: true }] }]}
          relations={[]}
          onTableClick={(d) => { received.tableClick = d; }}
          onTableDoubleClick={(d) => { received.tableDoubleClick = d; }}
          onExportSvg={(d) => { received.exportSvg = d; }}
        />
      </div>
    );
  }

  const registration = registerHostReactView(views, 'com.example.ide', () => <IdeView />);
  try {
    await act(async () => {
      receive({ kind: 'host-ui.open', instanceId: 'ide-1' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const btn = document.getElementById('row-btn')!;
    const editorEl = document.querySelector('[data-plugin-widget="code-editor"]')!;
    const gridEl = document.querySelector('[data-plugin-widget="data-grid"]')!;
    const splitEl = document.querySelector('[data-plugin-widget="split-pane"]')!;
    const erEl = document.querySelector('[data-plugin-widget="er-canvas"]')!;
    const popoverEl = document.querySelector('[data-plugin-popover="true"]')!;

    assert.equal(popoverEl.getAttribute('data-plugin-anchor-x'), '40');
    assert.equal(popoverEl.getAttribute('data-plugin-anchor-y'), '60');
    assert.equal(popoverEl.getAttribute('data-plugin-popover-width'), '240');
    assert.equal(popoverEl.getAttribute('data-plugin-popover-max-height'), '300');

    await act(async () => {
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'dblclick', nodeId: remoteId(btn), x: 12, y: 34 } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'contextmenu', nodeId: remoteId(btn), x: 56, y: 78 } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'keydown', nodeId: remoteId(btn), key: 'k', metaKey: true } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(editorEl), widgetEvent: 'execute', detail: { value: 'SELECT 1;', selectedText: '', currentStatement: 'SELECT 1' } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(editorEl), widgetEvent: 'shortcut', detail: { shortcut: 'mod+s' } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(gridEl), widgetEvent: 'shortcut', detail: { shortcut: 'mod+z' } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(gridEl), widgetEvent: 'cellEdit', detail: { rowIndex: 0, colName: 'id', value: '2', isNull: false } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(gridEl), widgetEvent: 'fkJump', detail: { rowIndex: 0, colName: 'id', value: 1, targetTable: 'users', targetColumn: 'id' } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(gridEl), widgetEvent: 'cellCopy', detail: { text: '1', rowIndex: 0, colName: 'id', rowIndices: [0] } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(gridEl), widgetEvent: 'cellDoubleClick', detail: { rowIndex: 0, colName: 'id', value: 1 } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(splitEl), widgetEvent: 'resizeEnd', detail: { size: 320, collapsed: false } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(erEl), widgetEvent: 'tableClick', detail: { table: 'users' } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(erEl), widgetEvent: 'tableDoubleClick', detail: { table: 'users' } } });
      receive({ kind: 'host-ui.event', instanceId: 'ide-1', event: { type: 'widget', nodeId: remoteId(erEl), widgetEvent: 'exportSvg', detail: { svg: '<svg/>' } } });
    });

    assert.deepEqual(received.dblclick, { x: 12, y: 34 });
    assert.deepEqual(received.contextmenu, { x: 56, y: 78 });
    assert.deepEqual(received.execute, { value: 'SELECT 1;', selectedText: '', currentStatement: 'SELECT 1' });
    assert.deepEqual(received.editorShortcut, { shortcut: 'mod+s' });
    // editorEl consumed mod+s via onShortcut (must NOT double-fire usePluginShortcuts);
    // btn (Shadow DOM) and gridEl (no onShortcut) bubble to usePluginShortcuts once each.
    assert.deepEqual(globalShortcuts, ['mod+k', 'mod+z']);
    assert.deepEqual(received.cellEdit, { rowIndex: 0, colName: 'id', value: '2', isNull: false });
    assert.deepEqual(received.fkJump, { rowIndex: 0, colName: 'id', value: 1, targetTable: 'users', targetColumn: 'id' });
    assert.deepEqual(received.cellCopy, { text: '1', rowIndex: 0, colName: 'id', rowIndices: [0] });
    assert.deepEqual(received.cellDoubleClick, { rowIndex: 0, colName: 'id', value: 1 });
    assert.deepEqual(received.resizeEnd, { size: 320, collapsed: false });
    assert.deepEqual(received.tableClick, { table: 'users' });
    assert.deepEqual(received.tableDoubleClick, { table: 'users' });
    assert.deepEqual(received.exportSvg, { svg: '<svg/>' });
    await act(async () => { receive({ kind: 'host-ui.close', instanceId: 'ide-1' }); });
  } finally {
    await act(async () => { registration.dispose(); });
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    dom.window.close();
  }
});

test('registerHostReactView still completes initial loading for components that render null', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLFormElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  const { act } = await import('react');
  const { registerHostReactView } = await import('./hostReact.js');
  let receive: (value: JsonValue) => void = () => {};
  const messages: Array<Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>> = [];
  const views = {
    onDidReceiveMessage(_id: string, listener: (value: JsonValue) => void) { receive = listener; return { dispose() {} }; },
    postMessage(_id: string, value: JsonValue) { messages.push(value as unknown as Extract<HostDrawnViewMessage, { kind: 'host-ui.update' }>); },
    getState: async () => undefined,
    setState: async () => {},
  };
  const registration = registerHostReactView(views, 'com.example.empty', () => null, '.x{display:block}');
  try {
    await act(async () => { receive({ kind: 'host-ui.open', instanceId: 'empty-1' }); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(messages.length >= 1, 'empty component must still publish an initial update');
    assert.equal(messages[0].sequence, 1);
    assert.equal(messages[0].css, '.x{display:block}');
    await act(async () => { receive({ kind: 'host-ui.close', instanceId: 'empty-1' }); });
  } finally {
    await act(async () => { registration.dispose(); });
    for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    dom.window.close();
  }
});
