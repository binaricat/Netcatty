export const KITTY_KEYBOARD_DISAMBIGUATE_ESC_CODES = 0b00001;
export const KITTY_KEYBOARD_REPORT_EVENT_TYPES = 0b00010;
export const KITTY_KEYBOARD_REPORT_ALTERNATE_KEYS = 0b00100;
export const KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES = 0b01000;
export const KITTY_KEYBOARD_REPORT_ASSOCIATED_TEXT = 0b10000;
export const KITTY_SUPPORTED_KEYBOARD_FLAGS =
  KITTY_KEYBOARD_DISAMBIGUATE_ESC_CODES |
  KITTY_KEYBOARD_REPORT_EVENT_TYPES |
  KITTY_KEYBOARD_REPORT_ALTERNATE_KEYS |
  KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES |
  KITTY_KEYBOARD_REPORT_ASSOCIATED_TEXT;

const MAX_KEYBOARD_MODE_STACK_DEPTH = 32;

export type KittyKeyboardModeState = {
  mainFlags: number;
  alternateFlags: number;
  mainStack: number[];
  alternateStack: number[];
  alternateScreenActive: boolean;
};

export type KittyKeyboardModeApplyMode = 1 | 2 | 3;

export type KittyKeyboardEvent = {
  type?: string;
  key: string;
  code?: string;
  location?: number;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  getModifierState?: (key: string) => boolean;
  /** Unmodified key in the active layout, supplied by KeyboardLayoutMap when available. */
  unshiftedKey?: string;
  /** The platform consumed Alt/Option to produce text rather than a shortcut modifier. */
  altKeyProducesText?: boolean;
  /** Legacy cursor-key mode used only for baseline fallback sequences. */
  applicationCursorMode?: boolean;
};

type KittyKeyDefinition =
  | { kind: "csi-u"; code: number }
  | { kind: "csi-letter"; code: string }
  | { kind: "ss3"; code: string; modifiedTildeCode?: number }
  | { kind: "csi-tilde"; code: number };

const FUNCTIONAL_CSI_U_CODES: Record<string, number> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
  MediaPlay: 57428,
  MediaPause: 57429,
  MediaPlayPause: 57430,
  MediaReverse: 57431,
  MediaStop: 57432,
  MediaFastForward: 57433,
  MediaRewind: 57434,
  MediaTrackNext: 57435,
  MediaTrackPrevious: 57436,
  MediaRecord: 57437,
  AudioVolumeDown: 57438,
  AudioVolumeUp: 57439,
  AudioVolumeMute: 57440,
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  HyperLeft: 57445,
  KittyMetaLeft: 57446,
  SuperLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
  HyperRight: 57451,
  KittyMetaRight: 57452,
  SuperRight: 57450,
  AltGraph: 57453,
  ISOLevel3Shift: 57453,
  ISOLevel5Shift: 57454,
};

const CSI_LETTER_KEYS: Record<string, string> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

const SS3_KEYS: Record<string, { code: string; modifiedTildeCode?: number }> = {
  F1: { code: "P" },
  F2: { code: "Q" },
  F3: { code: "R", modifiedTildeCode: 13 },
  F4: { code: "S" },
};

const CSI_TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

const PC101_BASE_KEYS: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
};

const MODIFIER_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "OS", "Super", "Hyper",
  "AltGraph", "ISOLevel3Shift", "ISOLevel5Shift",
]);
const LOCK_KEYS = new Set(["CapsLock", "NumLock", "ScrollLock"]);
const NON_TEXT_DOM_KEYS = new Set(["Dead", "Process", "Unidentified", "Compose"]);
const LEGACY_C0_KEYS = new Set(["Enter", "Tab", "Backspace"]);
const LEGACY_NAMED_DATA_KEYS = new Set([
  "Escape", "Enter", "Tab", "Backspace", "Insert", "Delete", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "ContextMenu",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const sanitizeFlags = (flags: number): number => {
  if (!Number.isFinite(flags)) return 0;
  return Math.max(0, Math.floor(flags)) & KITTY_SUPPORTED_KEYBOARD_FLAGS;
};

const clampPositiveInteger = (value: number, fallback: number): number => {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

export const createKittyKeyboardModeState = (): KittyKeyboardModeState => ({
  mainFlags: 0,
  alternateFlags: 0,
  mainStack: [],
  alternateStack: [],
  alternateScreenActive: false,
});

export const createKittyKeyboardSessionStateStore = () => {
  const states = new WeakMap<object, KittyKeyboardModeState>();
  return {
    resolve(owner: object, preserveExisting: boolean): KittyKeyboardModeState {
      const existing = states.get(owner);
      if (existing && preserveExisting) return existing;
      const created = createKittyKeyboardModeState();
      states.set(owner, created);
      return created;
    },
    reset(owner: object): void {
      const existing = states.get(owner);
      if (existing) resetKittyKeyboardModeState(existing);
    },
  };
};

export const resetKittyKeyboardModeState = (state: KittyKeyboardModeState): void => {
  state.mainFlags = 0;
  state.alternateFlags = 0;
  state.mainStack.length = 0;
  state.alternateStack.length = 0;
  state.alternateScreenActive = false;
};

export const snapshotKittyKeyboardModeState = (
  state: KittyKeyboardModeState,
): KittyKeyboardModeState => ({
  mainFlags: sanitizeFlags(state.mainFlags),
  alternateFlags: sanitizeFlags(state.alternateFlags),
  mainStack: state.mainStack.slice(-MAX_KEYBOARD_MODE_STACK_DEPTH).map(sanitizeFlags),
  alternateStack: state.alternateStack.slice(-MAX_KEYBOARD_MODE_STACK_DEPTH).map(sanitizeFlags),
  alternateScreenActive: state.alternateScreenActive === true,
});

export const restoreKittyKeyboardModeState = (
  state: KittyKeyboardModeState,
  snapshot: KittyKeyboardModeState,
): void => {
  const restored = snapshotKittyKeyboardModeState(snapshot);
  state.mainFlags = restored.mainFlags;
  state.alternateFlags = restored.alternateFlags;
  state.mainStack.splice(0, state.mainStack.length, ...restored.mainStack);
  state.alternateStack.splice(0, state.alternateStack.length, ...restored.alternateStack);
  state.alternateScreenActive = restored.alternateScreenActive;
};

export const getKittyKeyboardModeFlags = (state: KittyKeyboardModeState): number => {
  return state.alternateScreenActive ? state.alternateFlags : state.mainFlags;
};

export const isKittyKeyboardModeActive = (state: KittyKeyboardModeState): boolean => (
  getKittyKeyboardModeFlags(state) !== 0
);

const isPhysicalDeadAltShortcut = (event: KittyKeyboardEvent): boolean => (
  event.key === "Dead" &&
  event.altKey === true &&
  !modifierState(event, "AltGraph") &&
  event.altKeyProducesText !== true &&
  event.code !== undefined &&
  (
    /^Key[A-Z]$/.test(event.code) ||
    /^Digit[0-9]$/.test(event.code) ||
    PC101_BASE_KEYS[event.code] !== undefined
  )
);

export const shouldDeferKittyKeyEvent = (event: KittyKeyboardEvent): boolean => (
  event.isComposing === true ||
  event.keyCode === 229 ||
  (NON_TEXT_DOM_KEYS.has(event.key) && !isPhysicalDeadAltShortcut(event))
);

export const shouldMarkKittyTextInputEvent = (
  event: Pick<InputEvent, "data" | "inputType">,
): boolean => event.inputType === "insertText" && Boolean(event.data);

export const shouldTreatKittyAltAsText = (
  event: Pick<KittyKeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey">,
  isMac: boolean,
  altAsMeta: boolean,
): boolean => (
  isMac &&
  !altAsMeta &&
  event.altKey === true &&
  event.ctrlKey !== true &&
  event.metaKey !== true &&
  (event.key === "Dead" || Array.from(event.key).length === 1)
);

export const shouldExpectLegacyKeyboardData = (event: KittyKeyboardEvent): boolean => (
  event.metaKey !== true &&
  (Array.from(event.key).length === 1 || LEGACY_NAMED_DATA_KEYS.has(event.key))
);

const legacyControlCharacterForAscii = (character: string): string | null => {
  if (/^[a-zA-Z]$/.test(character)) {
    return String.fromCharCode(character.toLowerCase().charCodeAt(0) - 96);
  }
  const mappings: Record<string, string> = {
    " ": "\0",
    "/": "\u001f",
    "2": "\0",
    "3": "\u001b",
    "4": "\u001c",
    "5": "\u001d",
    "6": "\u001e",
    "7": "\u001f",
    "8": "\u007f",
    "?": "\u007f",
    "@": "\0",
    "[": "\u001b",
    "\\": "\u001c",
    "]": "\u001d",
    "^": "\u001e",
    "_": "\u001f",
  };
  return mappings[character] ?? null;
};

const asciiCharacter = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const points = Array.from(value);
  const codePoint = points.length === 1 ? points[0].codePointAt(0) : undefined;
  return codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e
    ? points[0]
    : null;
};

const activeOrBaseLegacyAscii = (event: KittyKeyboardEvent): string | null => (
  asciiCharacter(event.key) ?? asciiCharacter(getBaseLayoutCharacter(event))
);

const legacyControlCharacterForEvent = (event: KittyKeyboardEvent): string | null => {
  const active = asciiCharacter(event.key);
  if (active !== null) {
    if (event.shiftKey && /^[A-Z]$/.test(active)) return null;
    return legacyControlCharacterForAscii(active);
  }
  const base = asciiCharacter(getBaseLayoutCharacter(event));
  return base === null ? null : legacyControlCharacterForAscii(base);
};

const legacyCtrlAsciiPassthroughCharacter = (event: KittyKeyboardEvent): string | null => {
  if (
    !event.ctrlKey ||
    event.shiftKey ||
    event.metaKey ||
    modifierState(event, "AltGraph") ||
    legacyControlCharacterForEvent(event) !== null
  ) return null;
  return activeOrBaseLegacyAscii(event);
};

const isLegacyCtrlAsciiPassthrough = (event: KittyKeyboardEvent): boolean => (
  legacyCtrlAsciiPassthroughCharacter(event) !== null
);

const hasLayoutSpecificLegacyCtrlMapping = (event: KittyKeyboardEvent): boolean => {
  if (
    !event.ctrlKey ||
    event.shiftKey ||
    event.metaKey ||
    event.altKeyProducesText ||
    modifierState(event, "AltGraph") ||
    modifierState(event, "Hyper") ||
    modifierState(event, "KittyMeta")
  ) return false;
  const active = asciiCharacter(event.key);
  const base = asciiCharacter(getBaseLayoutCharacter(event));
  return active !== null &&
    (base === null || active !== base) &&
    legacyControlCharacterForAscii(active) !== null;
};

export const encodeLegacyKeyboardEvent = (
  event: KittyKeyboardEvent,
  applicationCursorMode = false,
  includeLocks = false,
): string | null => {
  if (event.type === "keyup" || event.type === "keypress" || shouldDeferKittyKeyEvent(event)) {
    return null;
  }

  const legacyModifier =
    (event.shiftKey ? 1 : 0) |
    (event.altKey && !event.altKeyProducesText ? 2 : 0) |
    (event.ctrlKey ? 4 : 0) |
    (event.metaKey ? 8 : 0) |
    (modifierState(event, "Hyper") ? 16 : 0) |
    (modifierState(event, "KittyMeta") ? 32 : 0) |
    (includeLocks && modifierState(event, "CapsLock") ? 64 : 0) |
    (includeLocks && modifierState(event, "NumLock") ? 128 : 0);
  const modifiedCsi = (body: string, final: string) => (
    `\u001b[${body};${legacyModifier + 1}${final}`
  );
  const cursorKey = (final: string) => {
    if (legacyModifier) return modifiedCsi("1", final);
    return applicationCursorMode ? `\u001bO${final}` : `\u001b[${final}`;
  };

  const cursorFinals: Record<string, string> = {
    ArrowUp: "A",
    ArrowDown: "B",
    ArrowRight: "C",
    ArrowLeft: "D",
    Home: "H",
    End: "F",
  };
  if (cursorFinals[event.key]) return cursorKey(cursorFinals[event.key]);
  if (event.key === "Clear" && event.code === "Numpad5") {
    if (legacyModifier) return modifiedCsi("1", "E");
    return applicationCursorMode ? "\u001bOE" : "\u001b[E";
  }

  if (event.key === "Escape") return event.altKey ? "\u001b\u001b" : "\u001b";
  if (event.key === "Enter") return event.altKey ? "\u001b\r" : "\r";
  if (event.key === "Tab") {
    const value = event.shiftKey ? "\u001b[Z" : "\t";
    return event.altKey && !event.altKeyProducesText ? `\u001b${value}` : value;
  }
  if (event.key === "Backspace") {
    const value = event.ctrlKey ? "\b" : "\u007f";
    return event.altKey ? `\u001b${value}` : value;
  }

  const tildeCodes: Record<string, number> = {
    ContextMenu: 29,
    Insert: 2,
    Delete: 3,
    PageUp: 5,
    PageDown: 6,
    F5: 15,
    F6: 17,
    F7: 18,
    F8: 19,
    F9: 20,
    F10: 21,
    F11: 23,
    F12: 24,
  };
  const tildeCode = tildeCodes[event.key];
  if (tildeCode !== undefined) {
    return legacyModifier
      ? modifiedCsi(String(tildeCode), "~")
      : `\u001b[${tildeCode}~`;
  }

  const fMatch = /^F([1-4])$/.exec(event.key);
  if (fMatch) {
    const number = Number(fMatch[1]);
    if (number === 3 && legacyModifier) return modifiedCsi("13", "~");
    const final = "PQRS"[number - 1];
    return legacyModifier ? modifiedCsi("1", final) : `\u001bO${final}`;
  }

  if (
    event.ctrlKey &&
    !event.metaKey &&
    !modifierState(event, "AltGraph") &&
    (!event.shiftKey || (event.altKey && !event.altKeyProducesText))
  ) {
    const control = legacyControlCharacterForEvent(event);
    if (control !== null) {
      return event.altKey && !event.altKeyProducesText ? `\u001b${control}` : control;
    }
    const passthrough = legacyCtrlAsciiPassthroughCharacter(event);
    if (passthrough !== null) {
      return event.altKey && !event.altKeyProducesText ? `\u001b${passthrough}` : passthrough;
    }
  }

  if (event.ctrlKey && event.shiftKey) {
    if (event.code === "Space") return "\0";
    if (event.code === "Minus") return "\u001f";
    if (event.code === "Digit2") return "\0";
    if (event.code === "Digit6") return "\u001e";
  }

  if (Array.from(event.key).length === 1 && !event.ctrlKey && !event.metaKey) {
    if (event.altKey && !event.altKeyProducesText) return `\u001b${event.key}`;
    return event.key;
  }
  return null;
};

export const setKittyKeyboardAlternateScreenActive = (
  state: KittyKeyboardModeState,
  active: boolean,
): void => {
  state.alternateScreenActive = active;
};

export const setKittyKeyboardModeFlags = (
  state: KittyKeyboardModeState,
  flags: number,
  mode: KittyKeyboardModeApplyMode = 1,
): number => {
  const sanitized = sanitizeFlags(flags);
  const current = getKittyKeyboardModeFlags(state);

  let next = current;
  switch (mode) {
    case 1:
      next = sanitized;
      break;
    case 2:
      next = current | sanitized;
      break;
    case 3:
      next = current & ~sanitized;
      break;
  }

  if (state.alternateScreenActive) state.alternateFlags = next;
  else state.mainFlags = next;
  return next;
};

export const pushKittyKeyboardModeFlags = (
  state: KittyKeyboardModeState,
  flags = 0,
): number => {
  const stack = state.alternateScreenActive ? state.alternateStack : state.mainStack;
  stack.push(getKittyKeyboardModeFlags(state));
  if (stack.length > MAX_KEYBOARD_MODE_STACK_DEPTH) stack.shift();
  return setKittyKeyboardModeFlags(state, flags, 1);
};

export const popKittyKeyboardModeFlags = (
  state: KittyKeyboardModeState,
  count = 1,
): number => {
  const stack = state.alternateScreenActive ? state.alternateStack : state.mainStack;
  const total = clampPositiveInteger(count, 1);
  let next = getKittyKeyboardModeFlags(state);

  for (let i = 0; i < total; i += 1) {
    next = stack.pop() ?? 0;
  }

  if (state.alternateScreenActive) state.alternateFlags = next;
  else state.mainFlags = next;
  return next;
};

export const buildKittyKeyboardModeQueryResponse = (
  state: KittyKeyboardModeState,
): string => `\u001b[?${getKittyKeyboardModeFlags(state)}u`;

const modifierState = (event: KittyKeyboardEvent, key: string): boolean => {
  try {
    return event.getModifierState?.(key) === true;
  } catch {
    return false;
  }
};

const getKittyModifierValue = (
  event: KittyKeyboardEvent,
  includeLocks = true,
): number => {
  let bits = 0;
  const altGraph = modifierState(event, "AltGraph");
  if (event.shiftKey) bits |= 0b00000001;
  if (event.altKey && !altGraph && !event.altKeyProducesText) bits |= 0b00000010;
  if (event.ctrlKey && !altGraph) bits |= 0b00000100;
  if (event.metaKey) bits |= 0b00001000;
  if (modifierState(event, "Hyper")) bits |= 0b00010000;
  // Chromium reserves getModifierState("Meta") for the platform Super key.
  // Keep a distinct non-standard name so synthetic/native integrations can
  // still represent Kitty's separate Meta bit without double-counting Super.
  if (modifierState(event, "KittyMeta")) bits |= 0b00100000;
  if (includeLocks && modifierState(event, "CapsLock")) bits |= 0b01000000;
  if (includeLocks && modifierState(event, "NumLock")) bits |= 0b10000000;
  return bits + 1;
};

const getEventType = (event: KittyKeyboardEvent): 1 | 2 | 3 => {
  if (event.type === "keyup") return 3;
  return event.repeat ? 2 : 1;
};

const numpadKeyDefinition = (event: KittyKeyboardEvent): KittyKeyDefinition | null => {
  const code = event.code ?? "";
  if (!code.startsWith("Numpad")) return null;

  const navigationCodes: Record<string, number> = {
    Insert: 57425,
    Delete: 57426,
    ArrowLeft: 57417,
    ArrowRight: 57418,
    ArrowUp: 57419,
    ArrowDown: 57420,
    PageUp: 57421,
    PageDown: 57422,
    Home: 57423,
    End: 57424,
  };
  if (navigationCodes[event.key] !== undefined) {
    return { kind: "csi-u", code: navigationCodes[event.key] };
  }

  const suffix = code.slice("Numpad".length);
  if (event.key === "Clear") return { kind: "csi-tilde", code: 57427 };
  if (/^[0-9]$/.test(suffix)) {
    return { kind: "csi-u", code: 57399 + Number(suffix) };
  }
  const operationCodes: Record<string, number> = {
    Decimal: 57409,
    Divide: 57410,
    Multiply: 57411,
    Subtract: 57412,
    Add: 57413,
    Enter: 57414,
    Equal: 57415,
    Comma: 57416,
    Separator: 57416,
  };
  const mapped = operationCodes[suffix];
  return mapped === undefined ? null : { kind: "csi-u", code: mapped };
};

const getKeyDefinition = (
  event: KittyKeyboardEvent,
  includeNumpad = true,
): KittyKeyDefinition | null => {
  if (includeNumpad) {
    const numpad = numpadKeyDefinition(event);
    if (numpad) return numpad;
  }

  const functionalCode = FUNCTIONAL_CSI_U_CODES[event.key];
  if (functionalCode !== undefined) return { kind: "csi-u", code: functionalCode };

  const modifierCode = event.code ? FUNCTIONAL_CSI_U_CODES[event.code] : undefined;
  if (modifierCode !== undefined) return { kind: "csi-u", code: modifierCode };

  const fMatch = /^F(\d+)$/.exec(event.key);
  if (fMatch) {
    const number = Number(fMatch[1]);
    if (number >= 13 && number <= 35) {
      return { kind: "csi-u", code: 57363 + number };
    }
  }

  const letter = CSI_LETTER_KEYS[event.key];
  if (letter) return { kind: "csi-letter", code: letter };
  const ss3 = SS3_KEYS[event.key];
  if (ss3) return { kind: "ss3", ...ss3 };
  const tilde = CSI_TILDE_KEYS[event.key];
  if (tilde !== undefined) return { kind: "csi-tilde", code: tilde };
  return null;
};

const getBaseLayoutCharacter = (event: KittyKeyboardEvent): string | null => {
  const code = event.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return PC101_BASE_KEYS[code] ?? null;
};

const getUnicodeKeyCode = (event: KittyKeyboardEvent): number | null => {
  const base = getBaseLayoutCharacter(event);
  if (event.unshiftedKey && Array.from(event.unshiftedKey).length === 1) {
    const unshifted = event.unshiftedKey.toLocaleLowerCase();
    if (Array.from(unshifted).length === 1) return unshifted.codePointAt(0) ?? null;
  }
  if (Array.from(event.key).length === 1) {
    const value = event.key.codePointAt(0) ?? null;
    if (value !== null && value >= 65 && value <= 90) return value + 32;
    if (event.shiftKey && base && !/\p{L}/u.test(event.key)) {
      return base.codePointAt(0) ?? null;
    }
    const lower = event.key.toLocaleLowerCase();
    if (Array.from(lower).length === 1) return lower.codePointAt(0) ?? value;
    return value;
  }
  return base?.codePointAt(0) ?? null;
};

const textCodePoints = (text: string): number[] => (
  Array.from(text, (character) => character.codePointAt(0)!)
    .filter((code) => code >= 0x20 && !(code >= 0x7f && code <= 0x9f))
);

const associatedTextForEvent = (
  event: KittyKeyboardEvent,
  functional: boolean,
): number[] => {
  if (
    event.type === "keyup" ||
    (event.ctrlKey && !modifierState(event, "AltGraph")) ||
    event.metaKey ||
    modifierState(event, "Hyper") ||
    modifierState(event, "KittyMeta") ||
    MODIFIER_KEYS.has(event.key) ||
    NON_TEXT_DOM_KEYS.has(event.key) ||
    (functional && (
      event.code?.startsWith("Numpad") !== true ||
      Array.from(event.key).length !== 1
    ))
  ) return [];
  return textCodePoints(event.key);
};

const alternateKeySuffix = (
  event: KittyKeyboardEvent,
  flags: number,
  functional: boolean,
  keyCode: number,
): string => {
  if (!(flags & KITTY_KEYBOARD_REPORT_ALTERNATE_KEYS) || functional) return "";
  const base = getBaseLayoutCharacter(event)?.codePointAt(0);
  const shifted = event.shiftKey && Array.from(event.key).length === 1
    ? event.key.codePointAt(0)
    : undefined;
  const alternateShifted = shifted !== keyCode ? shifted : undefined;
  const alternateBase = base !== keyCode ? base : undefined;
  if (alternateShifted !== undefined && alternateBase !== undefined) {
    return `:${alternateShifted}:${alternateBase}`;
  }
  if (alternateShifted !== undefined) return `:${alternateShifted}`;
  if (alternateBase !== undefined) return `::${alternateBase}`;
  return "";
};

const encodeCsiU = (
  event: KittyKeyboardEvent,
  keyCode: number,
  flags: number,
  functional: boolean,
): string => {
  const eventType = getEventType(event);
  const reportAll = (flags & KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES) !== 0;
  const modifiers = getKittyModifierValue(event, flags !== 0);
  const reportEvents = (flags & KITTY_KEYBOARD_REPORT_EVENT_TYPES) !== 0;
  const text = reportAll &&
    (flags & KITTY_KEYBOARD_REPORT_ASSOCIATED_TEXT)
    ? associatedTextForEvent(event, functional)
    : [];

  let sequence = `\u001b[${keyCode}${alternateKeySuffix(event, flags, functional, keyCode)}`;
  const includeEvent = reportEvents && eventType !== 1;
  if (modifiers !== 1 || includeEvent || text.length > 0) {
    sequence += `;${modifiers === 1 && !includeEvent && text.length > 0 ? "" : modifiers}`;
    if (includeEvent) sequence += `:${eventType}`;
  }
  if (text.length > 0) sequence += `;${text.join(":")}`;
  return `${sequence}u`;
};

const encodeLegacyFunctional = (
  definition: Exclude<KittyKeyDefinition, { kind: "csi-u" }>,
  modifiers: number,
  eventType: 1 | 2 | 3,
  reportEvents: boolean,
  legacyMode: boolean,
  applicationCursorMode: boolean,
): string => {
  const eventSuffix = reportEvents && eventType !== 1 ? `:${eventType}` : "";
  const modifierField = modifiers !== 1 || eventSuffix ? `;${modifiers}${eventSuffix}` : "";
  if (definition.kind === "csi-letter") {
    if (modifierField) return `\u001b[1${modifierField}${definition.code}`;
    return `\u001b${legacyMode && applicationCursorMode ? "O" : "["}${definition.code}`;
  }
  if (definition.kind === "ss3") {
    if (definition.modifiedTildeCode !== undefined && (modifierField || !legacyMode)) {
      return `\u001b[${definition.modifiedTildeCode}${modifierField}~`;
    }
    return modifierField
      ? `\u001b[1${modifierField}${definition.code}`
      : `\u001b${legacyMode ? "O" : "["}${definition.code}`;
  }
  return `\u001b[${definition.code}${modifierField}~`;
};

const shouldDisambiguateTextKey = (event: KittyKeyboardEvent): boolean => {
  if (isPhysicalDeadAltShortcut(event)) return true;
  if (event.key === "Escape") return true;
  if (Array.from(event.key).length !== 1) return false;
  if (modifierState(event, "AltGraph") || event.altKeyProducesText) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  return false;
};

export const shouldEncodeKittyCompositionText = (state: KittyKeyboardModeState): boolean => {
  const flags = getKittyKeyboardModeFlags(state);
  return (flags & KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES) !== 0;
};

export const encodeKittyCompositionText = (
  state: KittyKeyboardModeState,
  text: string,
): string | null => {
  const flags = getKittyKeyboardModeFlags(state);
  if (!(flags & KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES)) return null;
  if (!(flags & KITTY_KEYBOARD_REPORT_ASSOCIATED_TEXT)) return "\u001b[0u";
  const points = textCodePoints(text);
  return points.length > 0 ? `\u001b[0;;${points.join(":")}u` : null;
};

export const encodeKittyKeyEvent = (
  state: KittyKeyboardModeState,
  event: KittyKeyboardEvent,
): string | null => {
  const flags = getKittyKeyboardModeFlags(state);
  if (event.type === "keypress" || shouldDeferKittyKeyEvent(event)) {
    return null;
  }

  const eventType = getEventType(event);
  const reportEvents = (flags & KITTY_KEYBOARD_REPORT_EVENT_TYPES) !== 0;
  const reportAll = (flags & KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES) !== 0;
  const disambiguate = (flags & KITTY_KEYBOARD_DISAMBIGUATE_ESC_CODES) !== 0;
  const baselineMode = (
    flags & (
      KITTY_KEYBOARD_DISAMBIGUATE_ESC_CODES |
      KITTY_KEYBOARD_REPORT_EVENT_TYPES |
      KITTY_KEYBOARD_REPORT_ALL_KEYS_AS_ESC_CODES
    )
  ) === 0;
  const isNumpad = event.code?.startsWith("Numpad") === true;
  const altGraph = modifierState(event, "AltGraph");
  const textProducingNumpad =
    isNumpad &&
    Array.from(event.key).length === 1 &&
    (!event.ctrlKey || altGraph) &&
    !event.metaKey &&
    !modifierState(event, "Hyper") &&
    !modifierState(event, "KittyMeta") &&
    (!event.altKey || altGraph || event.altKeyProducesText);
  const numpadBegin = event.key === "Clear" && event.code === "Numpad5";
  const definition: KittyKeyDefinition | null =
    numpadBegin && reportEvents && !disambiguate && !reportAll
      ? { kind: "csi-letter", code: "E" }
      : getKeyDefinition(
          event,
          !isNumpad || reportAll || (disambiguate && !textProducingNumpad),
        );
  const modifierOrLock = MODIFIER_KEYS.has(event.key) || LOCK_KEYS.has(event.key);
  const hasLockModifier =
    getKittyModifierValue(event) !== getKittyModifierValue(event, false);
  const unicodeKeyCode = definition === null ? getUnicodeKeyCode(event) : null;
  const alternateNonTextEvent =
    unicodeKeyCode !== null &&
    !altGraph &&
    !event.altKeyProducesText &&
    (
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      modifierState(event, "Hyper") ||
      modifierState(event, "KittyMeta")
    ) &&
    alternateKeySuffix(event, flags, false, unicodeKeyCode) !== "";

  const legacyPressMode =
    (baselineMode && eventType !== 3) ||
    (reportEvents && eventType === 1 && !disambiguate && !reportAll);
  if (
    legacyPressMode &&
    !alternateNonTextEvent &&
    !(flags !== 0 && hasLockModifier) &&
    hasLayoutSpecificLegacyCtrlMapping(event)
  ) {
    return encodeLegacyKeyboardEvent(event, event.applicationCursorMode, flags !== 0);
  }

  if (
    (baselineMode || (reportEvents && eventType === 1 && !disambiguate && !reportAll)) &&
    !alternateNonTextEvent &&
    !(flags !== 0 && hasLockModifier) &&
    isLegacyCtrlAsciiPassthrough(event)
  ) {
    return encodeLegacyKeyboardEvent(event, event.applicationCursorMode);
  }

  if (
    baselineMode &&
    !alternateNonTextEvent &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !(flags !== 0 && hasLockModifier) &&
    !modifierState(event, "Hyper") &&
    !modifierState(event, "KittyMeta")
  ) {
    const legacyControl = encodeLegacyKeyboardEvent(event, event.applicationCursorMode);
    if (legacyControl !== null) return legacyControl;
  }
  if (
    flags === KITTY_KEYBOARD_REPORT_EVENT_TYPES &&
    eventType === 1 &&
    event.key === " " &&
    event.code === "Space" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !hasLockModifier &&
    !modifierState(event, "Hyper") &&
    !modifierState(event, "KittyMeta")
  ) {
    return encodeLegacyKeyboardEvent(event, event.applicationCursorMode, flags !== 0);
  }
  if (
    baselineMode &&
    eventType !== 3 &&
    (event.key === "ContextMenu" || numpadBegin)
  ) {
    return encodeLegacyKeyboardEvent(event, event.applicationCursorMode, flags !== 0);
  }

  const hasLegacyFunctionalModifier = getKittyModifierValue(event, false) !== 1;
  if (
    baselineMode &&
    eventType !== 3 &&
    definition !== null &&
    definition.kind !== "csi-u" &&
    hasLegacyFunctionalModifier
  ) {
    return encodeLegacyKeyboardEvent(event, event.applicationCursorMode, flags !== 0);
  }

  const legacyC0Special =
    event.key === "Escape" ||
    LEGACY_C0_KEYS.has(event.key) ||
    (event.key === " " && event.code === "Space");
  const lockSensitiveSpace =
    flags !== 0 &&
    hasLockModifier &&
    event.key === " " &&
    event.code === "Space";
  const supportedLegacyC0Modifiers =
    !event.metaKey &&
    !modifierState(event, "Hyper") &&
    !modifierState(event, "KittyMeta") &&
    !modifierState(event, "AltGraph") &&
    !(event.ctrlKey && event.altKey && event.shiftKey);
  if (
    baselineMode &&
    eventType !== 3 &&
    legacyC0Special &&
    !lockSensitiveSpace &&
    supportedLegacyC0Modifiers &&
    (event.ctrlKey || event.altKey || event.shiftKey)
  ) {
    return encodeLegacyKeyboardEvent(event, event.applicationCursorMode);
  }

  // Even before an application opts into enhancement flags, Kitty's baseline
  // protocol uses CSI-u when legacy encoding would lose Shift or a modifier
  // that has no historical terminal representation.
  const baselineDisambiguatedTextEvent =
    alternateNonTextEvent || (
      Array.from(event.key).length === 1 &&
      (
        (
          event.ctrlKey === true &&
          event.shiftKey === true &&
          !altGraph &&
          !event.altKeyProducesText
        ) ||
        (
          (event.ctrlKey === true || event.altKey === true) &&
          activeOrBaseLegacyAscii(event) === null
        ) ||
        event.metaKey === true ||
        modifierState(event, "Hyper") ||
        modifierState(event, "KittyMeta")
      )
    ) || (
      legacyC0Special &&
      hasLegacyFunctionalModifier &&
      !supportedLegacyC0Modifiers
    ) || (
      flags !== 0 &&
      hasLockModifier &&
      Array.from(event.key).length === 1 &&
      !modifierState(event, "AltGraph") &&
      !event.altKeyProducesText &&
      (
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        modifierState(event, "Hyper") ||
        modifierState(event, "KittyMeta")
      )
    );
  const baselineFunctionalEvent =
    baselineMode &&
    eventType !== 3 &&
    definition?.kind === "csi-u" &&
    event.key !== "Escape" &&
    !LEGACY_C0_KEYS.has(event.key) &&
    !modifierOrLock;
  const enhancedLockFunctionalEvent =
    flags !== 0 && definition !== null && hasLockModifier;
  if (
    baselineMode &&
    !baselineDisambiguatedTextEvent &&
    !baselineFunctionalEvent &&
    !enhancedLockFunctionalEvent
  ) return null;
  if (eventType === 3 && !reportEvents) return null;

  // This intentionally matches Kitty's reference encoder: with flag 0b10,
  // printable press/repeat events can still travel through the text path, but
  // their release has no text payload and is reported as a CSI-u event. Flag
  // 0b1000 additionally moves the printable press/repeat events to CSI-u.
  const reportableTextEvent =
    reportEvents && eventType === 3 && !LEGACY_C0_KEYS.has(event.key);
  const disambiguatedTextEvent = baselineDisambiguatedTextEvent || (
    shouldDisambiguateTextKey(event) && (
      disambiguate || (reportEvents && eventType !== 1)
    )
  ) || reportableTextEvent;
  if (modifierOrLock && !reportAll) return null;
  if (eventType === 3 && LEGACY_C0_KEYS.has(event.key) && !reportAll) return null;
  if (eventType === 3 && !definition && !reportAll && !disambiguatedTextEvent) return null;

  if (definition && definition.kind !== "csi-u") {
    if (
      eventType === 1 &&
      !reportAll &&
      !disambiguate &&
      !reportEvents &&
      !baselineFunctionalEvent &&
      !hasLockModifier
    ) return null;
    return encodeLegacyFunctional(
      definition,
      getKittyModifierValue(event),
      eventType,
      reportEvents,
      baselineMode,
      event.applicationCursorMode === true,
    );
  }

  const keyCode = definition?.kind === "csi-u" ? definition.code : (
    unicodeKeyCode ?? getUnicodeKeyCode(event)
  );
  if (keyCode === null || keyCode === undefined) return null;

  if (reportAll) return encodeCsiU(event, keyCode, flags, definition !== null);

  if (
    definition?.kind === "csi-u" &&
    LEGACY_C0_KEYS.has(event.key) &&
    getKittyModifierValue(event, false) !== 1 &&
    (disambiguate || reportEvents)
  ) {
    return encodeCsiU(event, keyCode, flags, true);
  }

  if (definition?.kind === "csi-u" && event.key === "Escape") {
    if (
      disambiguate ||
      (reportEvents && (
        eventType !== 1 ||
        getKittyModifierValue(event) !== 1
      ))
    ) {
      return encodeCsiU(event, keyCode, flags, true);
    }
    return null;
  }

  if (
    definition?.kind === "csi-u" &&
    !LEGACY_C0_KEYS.has(event.key) &&
    (disambiguate || reportEvents || baselineFunctionalEvent)
  ) {
    return encodeCsiU(event, keyCode, flags, true);
  }

  if (disambiguatedTextEvent) {
    return encodeCsiU(event, keyCode, flags, false);
  }

  if (eventType === 3) return encodeCsiU(event, keyCode, flags, definition !== null);
  return null;
};

export const shouldTrackKittyKeyRelease = (
  state: KittyKeyboardModeState,
  event: KittyKeyboardEvent,
): boolean => encodeKittyKeyEvent(state, {
  ...event,
  type: "keyup",
  repeat: false,
}) !== null;

// Compatibility export for callers/tests introduced with the original partial implementation.
export const encodeKittyControlKey = encodeKittyKeyEvent;
