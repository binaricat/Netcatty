/**
 * Pure domain codec, validator, key mapper, high-risk chord detector, and
 * human-readable summarizer for AI Computer Use actions over VNC and RDP.
 *
 * Zero I/O, zero React/DOM imports.
 */

export const MAX_REMOTE_DESKTOP_ACTIONS_PER_CALL = 12;
export const MAX_REMOTE_DESKTOP_TYPE_TEXT_LENGTH = 2000;
export const MIN_REMOTE_DESKTOP_WAIT_MS = 50;
export const MAX_REMOTE_DESKTOP_WAIT_MS = 5000;
export const DEFAULT_REMOTE_DESKTOP_DRAG_STEPS = 10;
export const MIN_REMOTE_DESKTOP_DRAG_STEPS = 2;
export const MAX_REMOTE_DESKTOP_DRAG_STEPS = 40;
export const MAX_REMOTE_DESKTOP_SCROLL_DELTA = 2000;

export type RemoteDesktopMouseButton = 'left' | 'right' | 'middle';
export type RemoteDesktopDragButton = 'left' | 'right';
export type RemoteDesktopModifierKey = 'ctrl' | 'alt' | 'shift' | 'meta';

export interface RemoteDesktopClickAction {
  type: 'click';
  x: number;
  y: number;
  button?: RemoteDesktopMouseButton;
  clickCount?: 1 | 2 | 3;
  modifiers?: RemoteDesktopModifierKey[];
}

export interface RemoteDesktopMoveAction {
  type: 'move';
  x: number;
  y: number;
}

export interface RemoteDesktopDragAction {
  type: 'drag';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  button?: RemoteDesktopDragButton;
  steps?: number;
}

export interface RemoteDesktopScrollAction {
  type: 'scroll';
  x: number;
  y: number;
  deltaX?: number;
  deltaY?: number;
}

export interface RemoteDesktopTypeAction {
  type: 'type';
  text: string;
}

export interface RemoteDesktopKeyAction {
  type: 'key';
  key: string;
}

export interface RemoteDesktopWaitAction {
  type: 'wait';
  ms: number;
}

export type RemoteDesktopAction =
  | RemoteDesktopClickAction
  | RemoteDesktopMoveAction
  | RemoteDesktopDragAction
  | RemoteDesktopScrollAction
  | RemoteDesktopTypeAction
  | RemoteDesktopKeyAction
  | RemoteDesktopWaitAction;

export interface ParsedKeyChord {
  modifiers: RemoteDesktopModifierKey[];
  mainKey: string;
}

export interface HighRiskRemoteDesktopActionMatch {
  index: number;
  action: RemoteDesktopKeyAction;
  chord: string;
  reason: string;
}

export type ValidateRemoteDesktopActionsResult =
  | { ok: true; actions: RemoteDesktopAction[] }
  | { ok: false; error: string };

const CANONICAL_MODIFIER_ORDER: readonly RemoteDesktopModifierKey[] = [
  'ctrl',
  'alt',
  'shift',
  'meta',
];

const MODIFIER_ALIASES: Readonly<Record<string, RemoteDesktopModifierKey>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  controlleft: 'ctrl',
  controlright: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  altleft: 'alt',
  altright: 'alt',
  shift: 'shift',
  shiftleft: 'shift',
  shiftright: 'shift',
  meta: 'meta',
  win: 'meta',
  windows: 'meta',
  super: 'meta',
  cmd: 'meta',
  command: 'meta',
  os: 'meta',
  metaleft: 'meta',
  metaright: 'meta',
  osleft: 'meta',
  osright: 'meta',
};

const MODIFIER_DISPLAY_LABEL: Readonly<Record<RemoteDesktopModifierKey, string>> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
};

const SPECIAL_KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  return: 'Enter',
  ret: 'Enter',
  cr: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  bksp: 'Backspace',
  bs: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  spacebar: 'Space',
  arrowup: 'ArrowUp',
  up: 'ArrowUp',
  arrowdown: 'ArrowDown',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  left: 'ArrowLeft',
  arrowright: 'ArrowRight',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  page_up: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  pgdown: 'PageDown',
  page_down: 'PageDown',
  insert: 'Insert',
  ins: 'Insert',
  printscreen: 'PrintScreen',
  prtsc: 'PrintScreen',
  print: 'PrintScreen',
  sysrq: 'PrintScreen',
  pause: 'Pause',
  break: 'Pause',
  capslock: 'CapsLock',
  caps: 'CapsLock',
  numlock: 'NumLock',
  scrolllock: 'ScrollLock',
  contextmenu: 'ContextMenu',
  menu: 'ContextMenu',
  apps: 'ContextMenu',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
  plus: '+',
  minus: '-',
  equal: '=',
  equals: '=',
  comma: ',',
  period: '.',
  dot: '.',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  backquote: '`',
  bracketleft: '[',
  bracketright: ']',
};

/**
 * PS/2 Set 1 scancodes matching `components/remoteDesktop/rdpScancodeMap.ts`
 * (IronRDP `DeviceEvent.keyPressed` / `keyReleased`).
 */
const RDP_SCANCODE_BY_CANONICAL_KEY: Readonly<Record<string, number>> = {
  Escape: 0x0001,
  '1': 0x0002,
  '2': 0x0003,
  '3': 0x0004,
  '4': 0x0005,
  '5': 0x0006,
  '6': 0x0007,
  '7': 0x0008,
  '8': 0x0009,
  '9': 0x000a,
  '0': 0x000b,
  '-': 0x000c,
  '_': 0x000c,
  '=': 0x000d,
  '+': 0x000d,
  Backspace: 0x000e,
  Tab: 0x000f,
  q: 0x0010,
  w: 0x0011,
  e: 0x0012,
  r: 0x0013,
  t: 0x0014,
  y: 0x0015,
  u: 0x0016,
  i: 0x0017,
  o: 0x0018,
  p: 0x0019,
  '[': 0x001a,
  '{': 0x001a,
  ']': 0x001b,
  '}': 0x001b,
  Enter: 0x001c,
  Ctrl: 0x001d,
  a: 0x001e,
  s: 0x001f,
  d: 0x0020,
  f: 0x0021,
  g: 0x0022,
  h: 0x0023,
  j: 0x0024,
  k: 0x0025,
  l: 0x0026,
  ';': 0x0027,
  ':': 0x0027,
  "'": 0x0028,
  '"': 0x0028,
  '`': 0x0029,
  '~': 0x0029,
  Shift: 0x002a,
  '\\': 0x002b,
  '|': 0x002b,
  z: 0x002c,
  x: 0x002d,
  c: 0x002e,
  v: 0x002f,
  b: 0x0030,
  n: 0x0031,
  m: 0x0032,
  ',': 0x0033,
  '<': 0x0033,
  '.': 0x0034,
  '>': 0x0034,
  '/': 0x0035,
  '?': 0x0035,
  Alt: 0x0038,
  Space: 0x0039,
  ' ': 0x0039,
  CapsLock: 0x003a,
  F1: 0x003b,
  F2: 0x003c,
  F3: 0x003d,
  F4: 0x003e,
  F5: 0x003f,
  F6: 0x0040,
  F7: 0x0041,
  F8: 0x0042,
  F9: 0x0043,
  F10: 0x0044,
  NumLock: 0x0045,
  ScrollLock: 0x0046,
  F11: 0x0057,
  F12: 0x0058,
  PrintScreen: 0xe037,
  Pause: 0xe11d,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  Meta: 0xe05b,
  ContextMenu: 0xe05d,
};

/**
 * X11 keysyms matching `components/remoteDesktop/vncKeymap.ts` (RFC 6143).
 */
const VNC_KEYSYM_BY_CANONICAL_KEY: Readonly<Record<string, number>> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Pause: 0xff13,
  ScrollLock: 0xff14,
  Escape: 0xff1b,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  PrintScreen: 0xff61,
  Insert: 0xff63,
  ContextMenu: 0xff67,
  NumLock: 0xff7f,
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
  Shift: 0xffe1,
  Ctrl: 0xffe3,
  CapsLock: 0xffe5,
  Alt: 0xffe9,
  Meta: 0xffeb,
  Delete: 0xffff,
  Space: 0x0020,
};

function normalizeSingleKeyToken(rawToken: string): string | null {
  if (rawToken === ' ') return 'Space';
  const trimmed = rawToken.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Support DOM code forms such as KeyA, Digit1
  if (/^key[a-z]$/.test(lower)) {
    return lower.slice(3);
  }
  if (/^digit[0-9]$/.test(lower)) {
    return lower.slice(5);
  }

  if (lower in SPECIAL_KEY_ALIASES) {
    return SPECIAL_KEY_ALIASES[lower];
  }

  if (lower in MODIFIER_ALIASES) {
    return MODIFIER_DISPLAY_LABEL[MODIFIER_ALIASES[lower]];
  }

  // Single printable character (ASCII letter normalized to lowercase for chords,
  // digits & punctuation preserved)
  const chars = Array.from(trimmed);
  if (chars.length === 1) {
    const ch = chars[0];
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp >= 0x20 && cp <= 0x7e) {
      return /[A-Z]/.test(ch) ? ch.toLowerCase() : ch;
    }
    if (cp !== undefined && ((cp >= 0xa0 && cp <= 0xff) || (cp > 0xff && cp <= 0x10ffff))) {
      return ch;
    }
  }

  return null;
}

/**
 * Parse a key or chord specification such as `"Enter"`, `"Ctrl+C"`,
 * `"Ctrl+Shift+Esc"`, `"Win+R"`, `"Alt+F4"`, or `"Ctrl++"`.
 * Returns `null` if malformed or contains an unrecognized key name.
 */
export function parseKeyChord(keySpec: string): ParsedKeyChord | null {
  if (typeof keySpec !== 'string') return null;
  if (keySpec === ' ') {
    return { modifiers: [], mainKey: 'Space' };
  }
  const trimmed = keySpec.trim();
  if (!trimmed) return null;
  if (trimmed === '+') {
    return { modifiers: [], mainKey: '+' };
  }

  // Handle trailing `++` meaning modifier + literal `+` key (e.g. `Ctrl++`).
  const endsWithLiteralPlus = trimmed.endsWith('++');
  const splitSource = endsWithLiteralPlus ? trimmed.slice(0, -1) : trimmed;
  const rawParts = splitSource.split('+');
  if (endsWithLiteralPlus) {
    rawParts[rawParts.length - 1] = '+';
  }

  const parts = rawParts.map((part) => (part === ' ' ? ' ' : part.trim()));
  if (parts.some((part) => part.length === 0)) {
    return null;
  }

  if (parts.length === 1) {
    const mainKey = normalizeSingleKeyToken(parts[0]);
    if (!mainKey) return null;
    return { modifiers: [], mainKey };
  }

  const modSet = new Set<RemoteDesktopModifierKey>();
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = MODIFIER_ALIASES[parts[i].toLowerCase()];
    if (!mod) {
      return null;
    }
    modSet.add(mod);
  }

  const lastPart = parts[parts.length - 1];
  const mainKey = normalizeSingleKeyToken(lastPart);
  if (!mainKey) return null;

  // Reject duplicate modifier used both as modifier and standalone mainKey (e.g. "Ctrl+Ctrl").
  const lastAsMod = MODIFIER_ALIASES[lastPart.toLowerCase()];
  if (lastAsMod && modSet.has(lastAsMod)) {
    return null;
  }

  const modifiers = CANONICAL_MODIFIER_ORDER.filter((m) => modSet.has(m));
  return { modifiers, mainKey };
}

/**
 * Format a parsed key chord into canonical display form (e.g. `"Ctrl+Shift+Escape"`, `"Meta+R"`, `"Enter"`).
 */
export function formatParsedKeyChord(chord: ParsedKeyChord): string {
  const modLabels = chord.modifiers.map((m) => MODIFIER_DISPLAY_LABEL[m]);
  const mainLabel = chord.mainKey.length === 1 && /[a-z]/.test(chord.mainKey) && chord.modifiers.length > 0
    ? chord.mainKey.toUpperCase()
    : chord.mainKey;
  return [...modLabels, mainLabel].join('+');
}

/**
 * Resolve a single key name (e.g. `"Enter"`, `"Ctrl"`, `"ArrowUp"`, `"c"`, `"F4"`)
 * to its PS/2 Set 1 scancode for IronRDP `DeviceEvent.keyPressed` / `keyReleased`.
 */
export function resolveKeyToRdpScancode(keyName: string): number | null {
  if (typeof keyName !== 'string' || !keyName) return null;
  const canonical = normalizeSingleKeyToken(keyName);
  if (!canonical) return null;
  const scancode = RDP_SCANCODE_BY_CANONICAL_KEY[canonical];
  return typeof scancode === 'number' ? scancode : null;
}

/**
 * Resolve a key chord string (e.g. `"Ctrl+Alt+Del"`) to ordered RDP scancodes
 * (modifiers first, main key last).
 */
export function resolveChordToRdpScancodes(keySpec: string): number[] | null {
  const parsed = parseKeyChord(keySpec);
  if (!parsed) return null;
  const scancodes: number[] = [];
  for (const mod of parsed.modifiers) {
    const code = resolveKeyToRdpScancode(mod);
    if (code === null) return null;
    scancodes.push(code);
  }
  const mainCode = resolveKeyToRdpScancode(parsed.mainKey);
  if (mainCode === null) return null;
  scancodes.push(mainCode);
  return scancodes;
}

/**
 * Resolve a single key name (e.g. `"Enter"`, `"Ctrl"`, `"ArrowUp"`, `"c"`, `"F4"`)
 * to its X11 Keysym for VNC / RFB `KeyEvent`.
 */
export function resolveKeyToVncKeysym(keyName: string): number | null {
  if (typeof keyName !== 'string' || !keyName) return null;
  // Preserve uppercase single ASCII letters if caller explicitly passes one.
  if (keyName.length === 1) {
    const cp = keyName.codePointAt(0);
    if (cp !== undefined) {
      if (keyName === ' ') return VNC_KEYSYM_BY_CANONICAL_KEY.Space;
      if (cp >= 0x20 && cp <= 0x7e) return cp;
      if (cp >= 0xa0 && cp <= 0xff) return cp;
      if (cp > 0xff && cp <= 0x10ffff) return (0x01000000 | cp) >>> 0;
    }
  }

  const canonical = normalizeSingleKeyToken(keyName);
  if (!canonical) return null;
  if (canonical in VNC_KEYSYM_BY_CANONICAL_KEY) {
    return VNC_KEYSYM_BY_CANONICAL_KEY[canonical];
  }
  const chars = Array.from(canonical);
  if (chars.length === 1) {
    const cp = chars[0].codePointAt(0);
    if (cp !== undefined) {
      if (cp >= 0x20 && cp <= 0x7e) return cp;
      if (cp >= 0xa0 && cp <= 0xff) return cp;
      if (cp > 0xff && cp <= 0x10ffff) return (0x01000000 | cp) >>> 0;
    }
  }
  return null;
}

/**
 * Resolve a key chord string (e.g. `"Ctrl+Alt+Del"`) to ordered X11 keysyms
 * (modifiers first, main key last).
 */
export function resolveChordToVncKeysyms(keySpec: string): number[] | null {
  const parsed = parseKeyChord(keySpec);
  if (!parsed) return null;
  const keysyms: number[] = [];
  for (const mod of parsed.modifiers) {
    const sym = resolveKeyToVncKeysym(mod);
    if (sym === null) return null;
    keysyms.push(sym);
  }
  const mainSym = resolveKeyToVncKeysym(parsed.mainKey);
  if (mainSym === null) return null;
  keysyms.push(mainSym);
  return keysyms;
}

/**
 * Convert a normalized `0..1000` permille coordinate into a clamped framebuffer pixel coordinate.
 */
export function permilleToFramebufferCoord(permille: number, dimension: number): number {
  if (!Number.isFinite(dimension) || dimension <= 0) return 0;
  const clamped = Math.max(0, Math.min(1000, Number.isFinite(permille) ? permille : 0));
  const maxIndex = Math.max(0, Math.round(dimension) - 1);
  return Math.max(0, Math.min(maxIndex, Math.round((clamped / 1000) * maxIndex)));
}

function validatePermilleCoord(value: unknown, fieldName: string, actionIndex: number): number | { error: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `Action #${actionIndex + 1}: "${fieldName}" must be a finite number in 0..1000.` };
  }
  if (value < 0 || value > 1000) {
    return { error: `Action #${actionIndex + 1}: "${fieldName}" (${value}) must be between 0 and 1000.` };
  }
  return Math.round(value);
}

function normalizeModifiersList(
  raw: unknown,
  actionIndex: number,
): { modifiers?: RemoteDesktopModifierKey[] } | { error: string } {
  if (raw === undefined) return { modifiers: undefined };
  if (!Array.isArray(raw)) {
    return { error: `Action #${actionIndex + 1}: "modifiers" must be an array of ctrl/alt/shift/meta.` };
  }
  const modSet = new Set<RemoteDesktopModifierKey>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { error: `Action #${actionIndex + 1}: each modifier must be a string (ctrl, alt, shift, meta).` };
    }
    const normalized = MODIFIER_ALIASES[entry.trim().toLowerCase()];
    if (!normalized) {
      return { error: `Action #${actionIndex + 1}: unsupported modifier "${entry}".` };
    }
    modSet.add(normalized);
  }
  const ordered = CANONICAL_MODIFIER_ORDER.filter((m) => modSet.has(m));
  return { modifiers: ordered.length > 0 ? ordered : undefined };
}

function validateSingleAction(raw: unknown, index: number): { action: RemoteDesktopAction } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `Action #${index + 1} must be an object.` };
  }
  const record = raw as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';

  switch (type) {
    case 'click': {
      const x = validatePermilleCoord(record.x, 'x', index);
      if (typeof x !== 'number') return x;
      const y = validatePermilleCoord(record.y, 'y', index);
      if (typeof y !== 'number') return y;

      let button: RemoteDesktopMouseButton = 'left';
      if (record.button !== undefined) {
        const b = typeof record.button === 'string' ? record.button.trim().toLowerCase() : '';
        if (b !== 'left' && b !== 'right' && b !== 'middle') {
          return { error: `Action #${index + 1}: click "button" must be "left", "right", or "middle".` };
        }
        button = b;
      }

      let clickCount: 1 | 2 | 3 = 1;
      if (record.clickCount !== undefined) {
        if (record.clickCount !== 1 && record.clickCount !== 2 && record.clickCount !== 3) {
          return { error: `Action #${index + 1}: click "clickCount" must be 1, 2, or 3.` };
        }
        clickCount = record.clickCount;
      }

      const modifiersResult = normalizeModifiersList(record.modifiers, index);
      if ('error' in modifiersResult) return modifiersResult;

      return {
        action: {
          type: 'click',
          x,
          y,
          button,
          clickCount,
          ...(modifiersResult.modifiers ? { modifiers: modifiersResult.modifiers } : {}),
        },
      };
    }

    case 'move': {
      const x = validatePermilleCoord(record.x, 'x', index);
      if (typeof x !== 'number') return x;
      const y = validatePermilleCoord(record.y, 'y', index);
      if (typeof y !== 'number') return y;
      return { action: { type: 'move', x, y } };
    }

    case 'drag': {
      const fromX = validatePermilleCoord(record.fromX, 'fromX', index);
      if (typeof fromX !== 'number') return fromX;
      const fromY = validatePermilleCoord(record.fromY, 'fromY', index);
      if (typeof fromY !== 'number') return fromY;
      const toX = validatePermilleCoord(record.toX, 'toX', index);
      if (typeof toX !== 'number') return toX;
      const toY = validatePermilleCoord(record.toY, 'toY', index);
      if (typeof toY !== 'number') return toY;

      let button: RemoteDesktopDragButton = 'left';
      if (record.button !== undefined) {
        const b = typeof record.button === 'string' ? record.button.trim().toLowerCase() : '';
        if (b !== 'left' && b !== 'right') {
          return { error: `Action #${index + 1}: drag "button" must be "left" or "right".` };
        }
        button = b;
      }

      let steps = DEFAULT_REMOTE_DESKTOP_DRAG_STEPS;
      if (record.steps !== undefined) {
        if (typeof record.steps !== 'number' || !Number.isFinite(record.steps) || record.steps <= 0) {
          return { error: `Action #${index + 1}: drag "steps" must be a positive finite number.` };
        }
        steps = Math.max(
          MIN_REMOTE_DESKTOP_DRAG_STEPS,
          Math.min(MAX_REMOTE_DESKTOP_DRAG_STEPS, Math.round(record.steps)),
        );
      }

      return {
        action: {
          type: 'drag',
          fromX,
          fromY,
          toX,
          toY,
          button,
          steps,
        },
      };
    }

    case 'scroll': {
      const x = validatePermilleCoord(record.x, 'x', index);
      if (typeof x !== 'number') return x;
      const y = validatePermilleCoord(record.y, 'y', index);
      if (typeof y !== 'number') return y;

      const rawDx = record.deltaX;
      const rawDy = record.deltaY;
      if (rawDx !== undefined && (typeof rawDx !== 'number' || !Number.isFinite(rawDx))) {
        return { error: `Action #${index + 1}: scroll "deltaX" must be a finite number.` };
      }
      if (rawDy !== undefined && (typeof rawDy !== 'number' || !Number.isFinite(rawDy))) {
        return { error: `Action #${index + 1}: scroll "deltaY" must be a finite number.` };
      }

      const deltaX = typeof rawDx === 'number'
        ? Math.max(-MAX_REMOTE_DESKTOP_SCROLL_DELTA, Math.min(MAX_REMOTE_DESKTOP_SCROLL_DELTA, Math.round(rawDx)))
        : 0;
      const deltaY = typeof rawDy === 'number'
        ? Math.max(-MAX_REMOTE_DESKTOP_SCROLL_DELTA, Math.min(MAX_REMOTE_DESKTOP_SCROLL_DELTA, Math.round(rawDy)))
        : 0;

      if (deltaX === 0 && deltaY === 0) {
        return { error: `Action #${index + 1}: scroll requires a non-zero "deltaX" or "deltaY".` };
      }

      return {
        action: {
          type: 'scroll',
          x,
          y,
          deltaX,
          deltaY,
        },
      };
    }

    case 'type': {
      if (typeof record.text !== 'string' || record.text.length === 0) {
        return { error: `Action #${index + 1}: type "text" must be a non-empty string.` };
      }
      if (record.text.length > MAX_REMOTE_DESKTOP_TYPE_TEXT_LENGTH) {
        return {
          error: `Action #${index + 1}: type "text" exceeds maximum length of ${MAX_REMOTE_DESKTOP_TYPE_TEXT_LENGTH} characters.`,
        };
      }
      return { action: { type: 'type', text: record.text } };
    }

    case 'key': {
      if (typeof record.key !== 'string' || !record.key) {
        return { error: `Action #${index + 1}: key "key" must be a non-empty string.` };
      }
      const parsed = parseKeyChord(record.key);
      if (!parsed) {
        return { error: `Action #${index + 1}: unrecognized key or chord "${record.key}".` };
      }
      return {
        action: {
          type: 'key',
          key: formatParsedKeyChord(parsed),
        },
      };
    }

    case 'wait': {
      if (typeof record.ms !== 'number' || !Number.isFinite(record.ms) || record.ms < 0) {
        return { error: `Action #${index + 1}: wait "ms" must be a non-negative finite number.` };
      }
      const clampedMs = Math.max(
        MIN_REMOTE_DESKTOP_WAIT_MS,
        Math.min(MAX_REMOTE_DESKTOP_WAIT_MS, Math.round(record.ms)),
      );
      return { action: { type: 'wait', ms: clampedMs } };
    }

    default:
      return {
        error: `Action #${index + 1}: unsupported action type "${String(record.type ?? '')}". Allowed types: click, move, drag, scroll, type, key, wait.`,
      };
  }
}

/**
 * Validate and normalize an action batch (JSON string or array) of 1..12 actions.
 */
export function validateAndNormalizeRemoteDesktopActions(
  raw: unknown,
): ValidateRemoteDesktopActionsResult {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, error: 'actions must be a non-empty JSON array of 1-12 actions.' };
    }
    try {
      list = JSON.parse(trimmed);
    } catch (err) {
      return {
        ok: false,
        error: `actions must be valid JSON: ${err instanceof Error ? err.message : 'parse error'}.`,
      };
    }
  }

  if (!Array.isArray(list)) {
    return { ok: false, error: 'actions must be an array of 1-12 action objects.' };
  }
  if (list.length === 0) {
    return { ok: false, error: 'actions must contain at least 1 action.' };
  }
  if (list.length > MAX_REMOTE_DESKTOP_ACTIONS_PER_CALL) {
    return {
      ok: false,
      error: `Too many actions (${list.length}). Maximum is ${MAX_REMOTE_DESKTOP_ACTIONS_PER_CALL} actions per call.`,
    };
  }

  const normalized: RemoteDesktopAction[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const validated = validateSingleAction(list[i], i);
    if ('error' in validated) {
      return { ok: false, error: validated.error };
    }
    normalized.push(validated.action);
  }

  return { ok: true, actions: normalized };
}

function classifyHighRiskKeyChord(keySpec: string): { chord: string; reason: string } | null {
  const parsed = parseKeyChord(keySpec);
  if (!parsed) return null;
  const mods = new Set(parsed.modifiers);
  const main = parsed.mainKey;
  const formatted = formatParsedKeyChord(parsed);

  // Ctrl+Alt+Del (Windows SAS / reboot)
  if (mods.has('ctrl') && mods.has('alt') && !mods.has('shift') && !mods.has('meta') && main === 'Delete') {
    return { chord: formatted, reason: 'System attention / security screen chord (Ctrl+Alt+Delete)' };
  }
  // Ctrl+Alt+End (nested RDP SAS)
  if (mods.has('ctrl') && mods.has('alt') && !mods.has('shift') && !mods.has('meta') && main === 'End') {
    return { chord: formatted, reason: 'Nested RDP security attention chord (Ctrl+Alt+End)' };
  }
  // Ctrl+Alt+Backspace (X11 kill display server)
  if (mods.has('ctrl') && mods.has('alt') && main === 'Backspace') {
    return { chord: formatted, reason: 'X11 display server termination chord (Ctrl+Alt+Backspace)' };
  }
  // Ctrl+Alt+F1..F7 (Linux virtual console switch)
  if (mods.has('ctrl') && mods.has('alt') && /^F[1-7]$/.test(main)) {
    return { chord: formatted, reason: `Virtual terminal switch chord (${formatted})` };
  }
  // Alt+F4 (close window / Windows shutdown dialog)
  if (mods.has('alt') && !mods.has('ctrl') && !mods.has('meta') && main === 'F4') {
    return { chord: formatted, reason: 'Close active window / shutdown dialog chord (Alt+F4)' };
  }
  // Ctrl+Shift+Esc (Windows Task Manager)
  if (mods.has('ctrl') && mods.has('shift') && !mods.has('alt') && !mods.has('meta') && main === 'Escape') {
    return { chord: formatted, reason: 'Task Manager system chord (Ctrl+Shift+Escape)' };
  }
  // Win+R / Meta+R (Windows Run dialog)
  if (mods.has('meta') && !mods.has('ctrl') && !mods.has('alt') && main === 'r') {
    return { chord: formatted, reason: 'Windows Run command launcher chord (Win+R)' };
  }
  // Win+L / Meta+L (Lock screen)
  if (mods.has('meta') && !mods.has('ctrl') && !mods.has('alt') && main === 'l') {
    return { chord: formatted, reason: 'Workstation lock screen chord (Win+L)' };
  }
  // Win+X / Meta+X (Windows Power User / admin menu)
  if (mods.has('meta') && !mods.has('ctrl') && !mods.has('alt') && main === 'x') {
    return { chord: formatted, reason: 'Windows administrative Power User menu chord (Win+X)' };
  }
  // Cmd+Q / Meta+Q (macOS Quit application)
  if (mods.has('meta') && !mods.has('ctrl') && !mods.has('alt') && main === 'q') {
    return { chord: formatted, reason: 'Application quit chord (Cmd+Q / Meta+Q)' };
  }
  // Alt+PrintScreen / Ctrl+Alt+PrintScreen (Linux SysRq)
  if (mods.has('alt') && main === 'PrintScreen') {
    return { chord: formatted, reason: 'System request / SysRq chord' };
  }

  return null;
}

/**
 * Returns true if the given remote desktop action is a high-risk OS-level chord
 * requiring explicit fresh confirmation even in `auto` permission mode.
 */
export function isHighRiskRemoteDesktopAction(action: RemoteDesktopAction): boolean {
  if (action.type !== 'key') return false;
  return classifyHighRiskKeyChord(action.key) !== null;
}

/**
 * Inspect a normalized action list and return all high-risk OS-level actions.
 */
export function findHighRiskRemoteDesktopActions(
  actions: readonly RemoteDesktopAction[],
): HighRiskRemoteDesktopActionMatch[] {
  const matches: HighRiskRemoteDesktopActionMatch[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (action.type !== 'key') continue;
    const hit = classifyHighRiskKeyChord(action.key);
    if (hit) {
      matches.push({
        index: i,
        action,
        chord: hit.chord,
        reason: hit.reason,
      });
    }
  }
  return matches;
}

/**
 * Best-effort high-risk inspection directly on raw tool input (`{ actions }` or
 * an actions array/JSON string) for approval gates running before `execute()`.
 */
export function findHighRiskRemoteDesktopActionsFromInput(
  input: unknown,
): HighRiskRemoteDesktopActionMatch[] {
  if (!input) return [];
  const rawActions = typeof input === 'object' && !Array.isArray(input) && 'actions' in input
    ? (input as { actions?: unknown }).actions
    : input;
  const parsed = validateAndNormalizeRemoteDesktopActions(rawActions);
  if (parsed.ok) {
    return findHighRiskRemoteDesktopActions(parsed.actions);
  }
  // Fallback: even if one sibling action is malformed, scan raw array items for high-risk key specs.
  let list: unknown = rawActions;
  if (typeof rawActions === 'string') {
    try {
      list = JSON.parse(rawActions);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const matches: HighRiskRemoteDesktopActionMatch[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      if (typeof rec.type === 'string' && rec.type.trim().toLowerCase() === 'key' && typeof rec.key === 'string') {
        const hit = classifyHighRiskKeyChord(rec.key);
        if (hit) {
          matches.push({
            index: i,
            action: { type: 'key', key: hit.chord },
            chord: hit.chord,
            reason: hit.reason,
          });
        }
      }
    }
  }
  return matches;
}

const KNOWN_SECRET_PATTERNS: readonly RegExp[] = [
  /^(?:sk-|pk_(?:live|test)_|ghp_|gho_|ghu_|github_pat_|glpat-|xox[baprs]-|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/,
  /^(?:Bearer|Basic)\s+\S{8,}/i,
  /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:^|[\s&;])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/i,
];

/**
 * Heuristic detector for typed text that looks like a password, API key, or bearer token.
 */
export function looksLikeRemoteDesktopSecret(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  for (const pattern of KNOWN_SECRET_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  // Single opaque high-entropy token (no whitespace, not a URL or file path, >= 16 chars)
  if (
    trimmed.length >= 16
    && !/\s/.test(trimmed)
    && !/^https?:\/\//i.test(trimmed)
    && !trimmed.startsWith('/')
    && !/^[A-Za-z]:\\/.test(trimmed)
    && !trimmed.startsWith('--')
  ) {
    const hasLower = /[a-z]/.test(trimmed);
    const hasUpper = /[A-Z]/.test(trimmed);
    const hasDigit = /[0-9]/.test(trimmed);
    const hasSymbol = /[^A-Za-z0-9]/.test(trimmed);
    const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
    if (classes >= 3) {
      return true;
    }
  }
  return false;
}

/**
 * Return a copy of actions with sensitive `type` text replaced by `[REDACTED]`
 * for safe persistence in local audit logs.
 */
export function sanitizeRemoteDesktopActionsForAudit(
  actions: readonly RemoteDesktopAction[],
): RemoteDesktopAction[] {
  return actions.map((action) => {
    if (action.type === 'type' && looksLikeRemoteDesktopSecret(action.text)) {
      return { type: 'type', text: '[REDACTED]' };
    }
    return { ...action };
  });
}

function summarizeSingleAction(
  action: RemoteDesktopAction,
  redactSecrets: boolean,
): string {
  switch (action.type) {
    case 'click': {
      const prefix = action.button === 'right'
        ? 'Right-click'
        : action.button === 'middle'
          ? 'Middle-click'
          : action.clickCount === 2
            ? 'Double-click'
            : action.clickCount === 3
              ? 'Triple-click'
              : 'Click';
      const modSuffix = action.modifiers && action.modifiers.length > 0
        ? ` [${action.modifiers.map((m) => MODIFIER_DISPLAY_LABEL[m]).join('+')}]`
        : '';
      return `${prefix} (${action.x}, ${action.y})${modSuffix}`;
    }
    case 'move':
      return `Move (${action.x}, ${action.y})`;
    case 'drag':
      return `Drag (${action.fromX}, ${action.fromY}) -> (${action.toX}, ${action.toY})`;
    case 'scroll': {
      const dy = action.deltaY ?? 0;
      const dx = action.deltaX ?? 0;
      const dir = dy > 0 ? 'down' : dy < 0 ? 'up' : dx > 0 ? 'right' : 'left';
      return `Scroll ${dir} (${action.x}, ${action.y})`;
    }
    case 'type': {
      if (redactSecrets && looksLikeRemoteDesktopSecret(action.text)) {
        return 'Type "[REDACTED]"';
      }
      const singleLine = action.text.replace(/\r?\n/g, '\\n');
      const truncated = singleLine.length > 40 ? `${singleLine.slice(0, 37)}...` : singleLine;
      return `Type "${truncated}"`;
    }
    case 'key':
      return `Press ${action.key}`;
    case 'wait':
      return `Wait ${action.ms}ms`;
  }
}

/**
 * Produce a concise human-readable summary of a remote desktop action batch.
 * Secret-like `type` text is redacted by default (`redactSecrets: true`).
 */
export function summarizeRemoteDesktopActions(
  actions: readonly RemoteDesktopAction[],
  options?: { redactSecrets?: boolean },
): string {
  if (!actions || actions.length === 0) return '';
  const redactSecrets = options?.redactSecrets !== false;
  return actions.map((action) => summarizeSingleAction(action, redactSecrets)).join(' -> ');
}
