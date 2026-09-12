import type { Terminal as XTerm } from "@xterm/xterm";

import type { KittyKeyboardEvent } from "./kittyKeyboardProtocol";

export const dispatchWin32InputModeEvent = (
  term: Pick<XTerm, "textarea">,
  event: KittyKeyboardEvent,
): boolean => {
  const textarea = term.textarea;
  const KeyboardEventConstructor = textarea?.ownerDocument.defaultView?.KeyboardEvent;
  if (!textarea || !KeyboardEventConstructor) return false;

  const syntheticEvent = new KeyboardEventConstructor(event.type ?? "keydown", {
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    isComposing: event.isComposing,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    bubbles: true,
    cancelable: true,
  });
  if (event.keyCode !== undefined && syntheticEvent.keyCode !== event.keyCode) {
    Object.defineProperty(syntheticEvent, "keyCode", { value: event.keyCode });
  }
  if (event.getModifierState) {
    Object.defineProperty(syntheticEvent, "getModifierState", {
      value: (key: string) => event.getModifierState?.(key) === true,
    });
  }

  // xterm's internal CoreBrowserTerminal focuses its textarea for key-up
  // events. A broadcast is transport, not user focus navigation, so suppress
  // that synchronous DOM focus side effect while the target encodes the event.
  const ownFocus = Object.getOwnPropertyDescriptor(textarea, "focus");
  Object.defineProperty(textarea, "focus", {
    value: () => undefined,
    configurable: true,
  });
  try {
    textarea.dispatchEvent(syntheticEvent);
  } finally {
    if (ownFocus) Object.defineProperty(textarea, "focus", ownFocus);
    else delete (textarea as HTMLTextAreaElement & { focus?: () => void }).focus;
  }
  return true;
};
