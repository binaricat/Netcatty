/**
 * DOM KeyboardEvent -> X11 Keysym & QEMU Extended Key Event (XT scancode) mapper
 * for VNC / RFB sessions.
 *
 * Keysym references: X11 keysymdef.h & RFC 6143 (RFB Protocol).
 * QEMU XT keycode references: QEMU RFB Extended Key Event spec (normal Set 1
 * scancode 0x01..0x7F; extended 0xE0xx keys encoded as `0x80 | lowByte`).
 */

export const X11_KEYSYM = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Pause: 0xff13,
  Scroll_Lock: 0xff14,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  Print: 0xff61,
  Insert: 0xff63,
  Menu: 0xff67,
  Num_Lock: 0xff7f,
  KP_Enter: 0xff8d,
  KP_Multiply: 0xffaa,
  KP_Add: 0xffab,
  KP_Subtract: 0xffad,
  KP_Decimal: 0xffae,
  KP_Divide: 0xffaf,
  KP_0: 0xffb0,
  KP_1: 0xffb1,
  KP_2: 0xffb2,
  KP_3: 0xffb3,
  KP_4: 0xffb4,
  KP_5: 0xffb5,
  KP_6: 0xffb6,
  KP_7: 0xffb7,
  KP_8: 0xffb8,
  KP_9: 0xffb9,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Caps_Lock: 0xffe5,
  Meta_L: 0xffe7,
  Meta_R: 0xffe8,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
  Super_R: 0xffec,
  Delete: 0xffff,
  Space: 0x0020,
} as const;

const DOM_CODE_TO_SPECIAL_KEYSYM: Record<string, number> = {
  Backspace: X11_KEYSYM.BackSpace,
  Tab: X11_KEYSYM.Tab,
  Enter: X11_KEYSYM.Return,
  Escape: X11_KEYSYM.Escape,
  Pause: X11_KEYSYM.Pause,
  ScrollLock: X11_KEYSYM.Scroll_Lock,
  PrintScreen: X11_KEYSYM.Print,
  Insert: X11_KEYSYM.Insert,
  Delete: X11_KEYSYM.Delete,
  Home: X11_KEYSYM.Home,
  End: X11_KEYSYM.End,
  PageUp: X11_KEYSYM.Page_Up,
  PageDown: X11_KEYSYM.Page_Down,
  ArrowLeft: X11_KEYSYM.Left,
  ArrowUp: X11_KEYSYM.Up,
  ArrowRight: X11_KEYSYM.Right,
  ArrowDown: X11_KEYSYM.Down,
  ContextMenu: X11_KEYSYM.Menu,
  NumLock: X11_KEYSYM.Num_Lock,
  CapsLock: X11_KEYSYM.Caps_Lock,
  ShiftLeft: X11_KEYSYM.Shift_L,
  ShiftRight: X11_KEYSYM.Shift_R,
  ControlLeft: X11_KEYSYM.Control_L,
  ControlRight: X11_KEYSYM.Control_R,
  AltLeft: X11_KEYSYM.Alt_L,
  AltRight: X11_KEYSYM.Alt_R,
  MetaLeft: X11_KEYSYM.Super_L,
  MetaRight: X11_KEYSYM.Super_R,
  OSLeft: X11_KEYSYM.Super_L,
  OSRight: X11_KEYSYM.Super_R,
  NumpadEnter: X11_KEYSYM.KP_Enter,
  NumpadAdd: X11_KEYSYM.KP_Add,
  NumpadSubtract: X11_KEYSYM.KP_Subtract,
  NumpadMultiply: X11_KEYSYM.KP_Multiply,
  NumpadDivide: X11_KEYSYM.KP_Divide,
  NumpadDecimal: X11_KEYSYM.KP_Decimal,
  Numpad0: X11_KEYSYM.KP_0,
  Numpad1: X11_KEYSYM.KP_1,
  Numpad2: X11_KEYSYM.KP_2,
  Numpad3: X11_KEYSYM.KP_3,
  Numpad4: X11_KEYSYM.KP_4,
  Numpad5: X11_KEYSYM.KP_5,
  Numpad6: X11_KEYSYM.KP_6,
  Numpad7: X11_KEYSYM.KP_7,
  Numpad8: X11_KEYSYM.KP_8,
  Numpad9: X11_KEYSYM.KP_9,
  F1: X11_KEYSYM.F1,
  F2: X11_KEYSYM.F2,
  F3: X11_KEYSYM.F3,
  F4: X11_KEYSYM.F4,
  F5: X11_KEYSYM.F5,
  F6: X11_KEYSYM.F6,
  F7: X11_KEYSYM.F7,
  F8: X11_KEYSYM.F8,
  F9: X11_KEYSYM.F9,
  F10: X11_KEYSYM.F10,
  F11: X11_KEYSYM.F11,
  F12: X11_KEYSYM.F12,
};

const DOM_KEY_TO_KEYSYM: Record<string, number> = {
  Backspace: X11_KEYSYM.BackSpace,
  Tab: X11_KEYSYM.Tab,
  Enter: X11_KEYSYM.Return,
  Escape: X11_KEYSYM.Escape,
  Pause: X11_KEYSYM.Pause,
  ScrollLock: X11_KEYSYM.Scroll_Lock,
  PrintScreen: X11_KEYSYM.Print,
  Insert: X11_KEYSYM.Insert,
  Delete: X11_KEYSYM.Delete,
  Home: X11_KEYSYM.Home,
  End: X11_KEYSYM.End,
  PageUp: X11_KEYSYM.Page_Up,
  PageDown: X11_KEYSYM.Page_Down,
  ArrowLeft: X11_KEYSYM.Left,
  ArrowUp: X11_KEYSYM.Up,
  ArrowRight: X11_KEYSYM.Right,
  ArrowDown: X11_KEYSYM.Down,
  ContextMenu: X11_KEYSYM.Menu,
  NumLock: X11_KEYSYM.Num_Lock,
  CapsLock: X11_KEYSYM.Caps_Lock,
  Shift: X11_KEYSYM.Shift_L,
  Control: X11_KEYSYM.Control_L,
  Alt: X11_KEYSYM.Alt_L,
  AltGraph: 0xfe03, // ISO_Level3_Shift
  Meta: X11_KEYSYM.Super_L,
  OS: X11_KEYSYM.Super_L,
  F1: X11_KEYSYM.F1,
  F2: X11_KEYSYM.F2,
  F3: X11_KEYSYM.F3,
  F4: X11_KEYSYM.F4,
  F5: X11_KEYSYM.F5,
  F6: X11_KEYSYM.F6,
  F7: X11_KEYSYM.F7,
  F8: X11_KEYSYM.F8,
  F9: X11_KEYSYM.F9,
  F10: X11_KEYSYM.F10,
  F11: X11_KEYSYM.F11,
  F12: X11_KEYSYM.F12,
};

/**
 * QEMU RFB Extended Key Event XT scancode table.
 * Standard Set 1 scancodes are `0x01..0x7F`; extended `0xE0` keys are encoded
 * as `0x80 | lowByte` (QEMU RFB extension specification).
 */
const DOM_CODE_TO_QEMU_KEYCODE: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  // Extended keys (0x80 | Set1 code)
  NumpadEnter: 0x80 | 0x1c,
  ControlRight: 0x80 | 0x1d,
  NumpadDivide: 0x80 | 0x35,
  PrintScreen: 0x80 | 0x37,
  AltRight: 0x80 | 0x38,
  Home: 0x80 | 0x47,
  ArrowUp: 0x80 | 0x48,
  PageUp: 0x80 | 0x49,
  ArrowLeft: 0x80 | 0x4b,
  ArrowRight: 0x80 | 0x4d,
  End: 0x80 | 0x4f,
  ArrowDown: 0x80 | 0x50,
  PageDown: 0x80 | 0x51,
  Insert: 0x80 | 0x52,
  Delete: 0x80 | 0x53,
  MetaLeft: 0x80 | 0x5b,
  OSLeft: 0x80 | 0x5b,
  MetaRight: 0x80 | 0x5c,
  OSRight: 0x80 | 0x5c,
  ContextMenu: 0x80 | 0x5d,
};

export interface VncKeyboardEventLike {
  key: string;
  code?: string;
  location?: number;
}

/**
 * Convert a single Unicode character (or codepoint) into an X11 Keysym.
 * Printable ASCII (0x20..0x7E) and Latin-1 (0xA0..0xFF) map directly;
 * higher Unicode codepoints use `0x01000000 | codepoint`.
 */
export function unicodeCharToVncKeysym(char: string): number | null {
  if (!char) return null;
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return null;
  if (char === '\n' || char === '\r') return X11_KEYSYM.Return;
  if (char === '\t') return X11_KEYSYM.Tab;
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  if (codePoint > 0xff && codePoint <= 0x10ffff) {
    return (0x01000000 | codePoint) >>> 0;
  }
  return null;
}

/**
 * Map a DOM KeyboardEvent to an X11 Keysym.
 * Returns `null` for dead/unidentified/IME-process keys.
 */
export function domEventToVncKeysym(event: VncKeyboardEventLike): number | null {
  const { key, code, location } = event;
  if (!key || key === 'Unidentified' || key === 'Process' || key === 'Dead') {
    return null;
  }

  // Distinguish left/right modifiers & numpad keys via code first
  if (code && code in DOM_CODE_TO_SPECIAL_KEYSYM) {
    // Only use Numpad* keysyms when key isn't a nav key from NumLock-off
    if (!code.startsWith('Numpad') || key.length === 1 || key === 'Enter') {
      return DOM_CODE_TO_SPECIAL_KEYSYM[code];
    }
  }

  // Fallback for right-side modifiers when code is omitted
  if (location === 2) {
    if (key === 'Shift') return X11_KEYSYM.Shift_R;
    if (key === 'Control') return X11_KEYSYM.Control_R;
    if (key === 'Alt') return X11_KEYSYM.Alt_R;
    if (key === 'Meta' || key === 'OS') return X11_KEYSYM.Super_R;
  }

  if (key in DOM_KEY_TO_KEYSYM) {
    return DOM_KEY_TO_KEYSYM[key];
  }

  // Single printable character (including surrogate pairs)
  const chars = Array.from(key);
  if (chars.length === 1) {
    return unicodeCharToVncKeysym(chars[0]);
  }

  return null;
}

/**
 * Map DOM `KeyboardEvent.code` to a QEMU RFB Extended Key Event XT scancode.
 */
export function domCodeToQemuKeycode(code: string | undefined): number | null {
  if (!code) return null;
  return DOM_CODE_TO_QEMU_KEYCODE[code] ?? null;
}

/**
 * Convert an arbitrary text string (e.g. clipboard contents) into a sequence of
 * X11 keysyms for "Type Clipboard as Keystrokes".
 * Normalizes CRLF -> CR (Return) and skips non-printable control characters.
 */
export function textToVncKeysymSequence(text: string): number[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const keysyms: number[] = [];
  for (const ch of normalized) {
    const sym = unicodeCharToVncKeysym(ch);
    if (sym !== null) {
      keysyms.push(sym);
    }
  }
  return keysyms;
}

export type RemoteDesktopSpecialKeyId =
  | 'ctrl-alt-del'
  | 'win'
  | 'alt-tab'
  | 'alt-f4'
  | 'ctrl-shift-esc'
  | 'cmd-space'
  | 'ctrl-alt-f1'
  | 'ctrl-alt-f2'
  | 'ctrl-alt-f3'
  | 'ctrl-alt-f4'
  | 'ctrl-alt-f5'
  | 'ctrl-alt-f6'
  | 'ctrl-alt-f7';

export const VNC_SPECIAL_CHORDS: Record<RemoteDesktopSpecialKeyId, readonly number[]> = {
  'ctrl-alt-del': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.Delete],
  win: [X11_KEYSYM.Super_L],
  'alt-tab': [X11_KEYSYM.Alt_L, X11_KEYSYM.Tab],
  'alt-f4': [X11_KEYSYM.Alt_L, X11_KEYSYM.F4],
  'ctrl-shift-esc': [X11_KEYSYM.Control_L, X11_KEYSYM.Shift_L, X11_KEYSYM.Escape],
  'cmd-space': [X11_KEYSYM.Super_L, X11_KEYSYM.Space],
  'ctrl-alt-f1': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F1],
  'ctrl-alt-f2': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F2],
  'ctrl-alt-f3': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F3],
  'ctrl-alt-f4': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F4],
  'ctrl-alt-f5': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F5],
  'ctrl-alt-f6': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F6],
  'ctrl-alt-f7': [X11_KEYSYM.Control_L, X11_KEYSYM.Alt_L, X11_KEYSYM.F7],
};
