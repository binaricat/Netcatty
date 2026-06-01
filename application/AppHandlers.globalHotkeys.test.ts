import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGlobalHotkeyKeyDownImpl } from './app/AppHandlers.ts';
import { matchesKeyBinding } from '../domain/models.ts';
import { DEFAULT_KEY_BINDINGS } from '../domain/models/keyBindings.ts';

class FakeHTMLElement {
  tagName = 'TEXTAREA';
  isContentEditable = false;
  classList = {
    contains: (className: string) => className === 'xterm-helper-textarea',
  };

  closest(selector: string): FakeHTMLElement | null {
    return selector.includes('xterm') ? this : null;
  }

  hasAttribute(name: string): boolean {
    return name === 'data-session-id';
  }
}

const previousHTMLElement = globalThis.HTMLElement;
globalThis.HTMLElement = FakeHTMLElement as unknown as typeof HTMLElement;

test.after(() => {
  globalThis.HTMLElement = previousHTMLElement;
});

test('global hotkey handler lets terminal font size shortcuts reach xterm', () => {
  const target = new FakeHTMLElement();
  const handledActions: string[] = [];
  let prevented = false;
  let stopped = false;
  const event = {
    key: '=',
    code: 'Equal',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    composedPath: () => [target],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as KeyboardEvent;

  handleGlobalHotkeyKeyDownImpl(
    () => ({
      HOTKEY_DEBUG: false,
      closeTabKeyStr: 'Ctrl + W',
      executeHotkeyAction: (action: string) => {
        handledActions.push(action);
      },
      hotkeyScheme: 'pc',
      keyBindings: DEFAULT_KEY_BINDINGS,
      matchesKeyBinding,
    }),
    event,
  );

  assert.deepEqual(handledActions, []);
  assert.equal(prevented, false);
  assert.equal(stopped, false);
});
