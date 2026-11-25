import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS,
  MAX_AI_TOOL_OUTPUT_MAX_CHARS,
  MIN_AI_TOOL_OUTPUT_MAX_CHARS,
} from '../../../../domain/aiToolOutputLimit';

const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/#/settings' });
for (const key of [
  'window',
  'document',
  'DocumentFragment',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'MutationObserver',
  'CustomEvent',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'getComputedStyle',
  'localStorage',
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('../../../../application/i18n/I18nProvider');
const { SafetySettings } = await import('./SafetySettings');

function Harness({
  initialLimit = DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS,
  onLimitChange,
}: {
  initialLimit?: number;
  onLimitChange: (value: number) => void;
}) {
  const [limit, setLimit] = useState(initialLimit);
  return (
    <I18nProvider locale="en">
      <SafetySettings
        globalPermissionMode="confirm"
        setGlobalPermissionMode={() => {}}
        commandBlocklist={[]}
        setCommandBlocklist={() => {}}
        commandTimeout={60}
        setCommandTimeout={() => {}}
        responseIdleTimeout={120}
        setResponseIdleTimeout={() => {}}
        maxIterations={20}
        setMaxIterations={() => {}}
        toolOutputMaxChars={limit}
        setToolOutputMaxChars={(next) => {
          setLimit(next);
          onLimitChange(next);
        }}
      />
    </I18nProvider>
  );
}

async function setInputValue(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

test('SafetySettings tool output limit input supports multi-digit typing, clamping on blur, and empty revert', async () => {
  const updates: number[] = [];
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Harness onLimitChange={(value) => updates.push(value)} />));
  try {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Built-in AI Tool Output Limit"]')!;
    assert.ok(input);
    assert.equal(input.value, String(DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS));

    // Typing a partial number below min does not prematurely jump to min.
    await setInputValue(input, '5');
    assert.equal(input.value, '5');
    assert.deepEqual(updates, []);

    // Completing an in-range number updates immediately.
    await setInputValue(input, '50000');
    assert.equal(input.value, '50000');
    assert.deepEqual(updates, [50_000]);

    // Typing above max clamps cleanly on blur.
    await act(async () => {
      input.focus();
    });
    await setInputValue(input, '999999');
    assert.equal(input.value, '999999');
    await act(async () => {
      input.blur();
    });
    assert.equal(input.value, String(MAX_AI_TOOL_OUTPUT_MAX_CHARS));
    assert.equal(updates.at(-1), MAX_AI_TOOL_OUTPUT_MAX_CHARS);

    // Typing below min clamps cleanly on blur.
    await act(async () => {
      input.focus();
    });
    await setInputValue(input, '100');
    await act(async () => {
      input.blur();
    });
    assert.equal(input.value, String(MIN_AI_TOOL_OUTPUT_MAX_CHARS));
    assert.equal(updates.at(-1), MIN_AI_TOOL_OUTPUT_MAX_CHARS);

    // Clearing the field and blurring restores the current valid value.
    await act(async () => {
      input.focus();
    });
    await setInputValue(input, '');
    await act(async () => {
      input.blur();
    });
    assert.equal(input.value, String(MIN_AI_TOOL_OUTPUT_MAX_CHARS));
  } finally {
    await act(async () => root.unmount());
  }
});
