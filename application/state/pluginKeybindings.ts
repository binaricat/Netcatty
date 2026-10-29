export type PluginShortcutPlatform = 'mac' | 'windows' | 'linux';

const MODIFIER_ORDER = ['meta', 'ctrl', 'alt', 'shift'] as const;
const PRIMARY_MODIFIERS = new Set(['meta', 'ctrl']);
const NAMED_KEYS = new Map<string, string>([
  [' ', 'space'],
  ['spacebar', 'space'],
  ['space', 'space'],
  ['arrowdown', 'arrowdown'],
  ['down', 'arrowdown'],
  ['arrowleft', 'arrowleft'],
  ['left', 'arrowleft'],
  ['arrowright', 'arrowright'],
  ['right', 'arrowright'],
  ['arrowup', 'arrowup'],
  ['up', 'arrowup'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['del', 'delete'],
  ['end', 'end'],
  ['enter', 'enter'],
  ['return', 'enter'],
  ['escape', 'escape'],
  ['esc', 'escape'],
  ['home', 'home'],
  ['insert', 'insert'],
  ['minus', 'minus'],
  ['-', 'minus'],
  ['pagedown', 'pagedown'],
  ['pageup', 'pageup'],
  ['plus', 'plus'],
  ['+', 'plus'],
  ['tab', 'tab'],
]);
const PLUGIN_SHORTCUT_EDITABLE_SELECTOR = [
  '[data-plugin-editing]',
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role="textbox"]',
  '.monaco-editor',
  '.monaco-diff-editor',
  '.monaco-inputbox',
  '.monaco-menu-container',
].join(', ');

export function isPluginViewEditingTarget(node: EventTarget | null): boolean {
  return Boolean((node as Element | null)?.closest?.('[data-plugin-editing]'));
}

function hasEditableShortcutAncestor(node: unknown): boolean {
  const closest = (node as { closest?: (selector: string) => unknown } | null)?.closest;
  return typeof closest === 'function'
    && Boolean(closest.call(node, PLUGIN_SHORTCUT_EDITABLE_SELECTOR));
}

export function isPluginShortcutEditableEvent(event: {
  target: EventTarget | null;
  composedPath?: () => EventTarget[];
}): boolean {
  if (hasEditableShortcutAncestor(event.target)) return true;
  return event.composedPath?.().some(hasEditableShortcutAncestor) ?? false;
}

function normalizeModifier(token: string, platform: PluginShortcutPlatform): string | null {
  switch (token) {
    case 'commandorcontrol':
    case 'cmdorctrl':
    case 'mod':
      return platform === 'mac' ? 'meta' : 'ctrl';
    case 'command':
    case 'cmd':
    case 'meta':
      return 'meta';
    case 'control':
    case 'ctrl':
      return 'ctrl';
    case 'option':
    case 'alt':
      return 'alt';
    case 'shift':
      return 'shift';
    default:
      return null;
  }
}

function normalizeKey(token: string): string | null {
  const lower = token.toLowerCase();
  if (/^[a-z0-9]$/u.test(lower) || /^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(lower)) return lower;
  return NAMED_KEYS.get(lower) ?? null;
}

export function resolvePluginShortcutPlatform(platform: string): PluginShortcutPlatform {
  if (/Mac|iPhone|iPad/u.test(platform)) return 'mac';
  if (/Win/u.test(platform)) return 'windows';
  return 'linux';
}

export function normalizePluginShortcut(
  shortcut: string,
  platform: PluginShortcutPlatform,
): string | null {
  if (typeof shortcut !== 'string' || shortcut.length < 1 || shortcut.length > 128) return null;
  const tokens = shortcut.split('+').map((token) => token.trim());
  if (tokens.some((token) => token.length === 0) || tokens.length > 5) return null;
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const token of tokens) {
    const modifier = normalizeModifier(token.toLowerCase(), platform);
    if (modifier) {
      if (key || modifiers.has(modifier)
        || (PRIMARY_MODIFIERS.has(modifier)
          && [...modifiers].some((item) => PRIMARY_MODIFIERS.has(item)))) return null;
      modifiers.add(modifier);
      continue;
    }
    if (key) return null;
    key = normalizeKey(token);
    if (!key) return null;
  }
  if (!key) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

export function normalizePluginKeyboardEvent(event: Pick<KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { code?: string }): string | null {
  const codeKey = event.code?.match(/^Key([A-Z])$/u)?.[1]?.toLowerCase()
    ?? event.code?.match(/^Digit([0-9])$/u)?.[1]
    ?? null;
  const key = normalizeKey(event.key) ?? codeKey;
  if (!key) return null;
  return [
    event.metaKey ? 'meta' : '',
    event.ctrlKey ? 'ctrl' : '',
    event.altKey ? 'alt' : '',
    event.shiftKey ? 'shift' : '',
    key,
  ].filter(Boolean).join('+');
}
