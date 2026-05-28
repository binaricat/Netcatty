// Keyboard Shortcuts / Hotkeys
export type HotkeyScheme = 'disabled' | 'mac' | 'pc';

export interface KeyBinding {
  id: string;
  action: string;
  label: string;
  mac: string; // e.g., '⌘+1', '⌘+⌥+arrows'
  pc: string; // e.g., 'Ctrl+1', 'Ctrl+Alt+arrows'
  category: 'tabs' | 'terminal' | 'navigation' | 'app' | 'sftp';
}

// User's custom key bindings - only stores overrides from defaults
export type CustomKeyBindings = Record<string, { mac?: string; pc?: string }>;

// Parse a key string like "⌘ + Shift + K" or "Ctrl + Alt + T" into normalized form
export const parseKeyCombo = (keyStr: string): { modifiers: string[]; key: string } | null => {
  if (!keyStr || keyStr === 'Disabled') return null;
  const parts = keyStr.split('+').map(p => p.trim());
  const key = parts.pop() || '';
  return { modifiers: parts, key };
};

const PHYSICAL_SHORTCUT_KEY_NAMES: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const physicalShortcutKeyName = (e: KeyboardEvent): string | null => {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return PHYSICAL_SHORTCUT_KEY_NAMES[code] ?? null;
};

const LATIN_SHORTCUT_KEY_PATTERN = /^\p{Script=Latin}$/u;
const ASCII_SHORTCUT_KEY_PATTERN = /^[A-Za-z]$/;
const PRINTABLE_NON_LETTER_SHORTCUT_KEY_PATTERN = /^[^\p{Letter}\p{Number}\s]$/u;

const shortcutEventKey = (e: KeyboardEvent): string => {
  const physicalKey = physicalShortcutKeyName(e);
  if (
    LATIN_SHORTCUT_KEY_PATTERN.test(e.key) ||
    PRINTABLE_NON_LETTER_SHORTCUT_KEY_PATTERN.test(e.key)
  ) {
    return e.key;
  }
  return physicalKey ?? e.key;
};

// Convert keyboard event to a key string
export const keyEventToString = (e: KeyboardEvent, isMac: boolean): string => {
  const parts: string[] = [];

  if (isMac) {
    if (e.metaKey) parts.push('⌘');
    if (e.ctrlKey) parts.push('⌃');
    if (e.altKey) parts.push('⌥');
    if (e.shiftKey) parts.push('Shift');
  } else {
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');
  }

  // Get the key name
  let keyName = shortcutEventKey(e);
  // Normalize special keys
  if (keyName === ' ') keyName = 'Space';
  else if (keyName === 'ArrowUp') keyName = '↑';
  else if (keyName === 'ArrowDown') keyName = '↓';
  else if (keyName === 'ArrowLeft') keyName = '←';
  else if (keyName === 'ArrowRight') keyName = '→';
  else if (keyName === 'Escape') keyName = 'Esc';
  else if (keyName === 'Backspace') keyName = '⌫';
  else if (keyName === 'Delete') keyName = 'Del';
  else if (keyName === 'Enter') keyName = '↵';
  else if (keyName === 'Tab') keyName = '⇥';
  else if (ASCII_SHORTCUT_KEY_PATTERN.test(keyName)) keyName = keyName.toUpperCase();

  // Don't include modifier keys themselves
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
    return parts.join(' + ');
  }

  parts.push(keyName);
  return parts.join(' + ');
};

// Check if a keyboard event matches a key binding string
export const matchesKeyBinding = (e: KeyboardEvent, keyStr: string, isMac: boolean): boolean => {
  if (!keyStr || keyStr === 'Disabled') return false;

  // Handle range patterns like "[1...9]"
  if (keyStr.includes('[1...9]')) {
    const basePattern = keyStr.replace('[1...9]', '');
    const key = physicalShortcutKeyName(e) ?? shortcutEventKey(e);
    if (!/^[1-9]$/.test(key)) return false;
    // Check modifiers match the base pattern
    const testStr = basePattern + key;
    const physicalDigitEvent = {
      key,
      code: e.code,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
    } as KeyboardEvent;
    return matchesKeyBinding(physicalDigitEvent, testStr.trim(), isMac);
  }

  // Handle arrow key patterns like "arrows"
  if (keyStr.includes('arrows')) {
    const basePattern = keyStr.replace('arrows', '');
    const key = e.key;
    // Check if it's an arrow key
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
    // Map arrow key to symbol for matching
    const arrowSymbol = key === 'ArrowUp' ? '↑'
      : key === 'ArrowDown' ? '↓'
        : key === 'ArrowLeft' ? '←'
          : '→';
    // Check modifiers match the base pattern
    const testStr = basePattern + arrowSymbol;
    return matchesKeyBinding(e, testStr.trim(), isMac);
  }

  const parsed = parseKeyCombo(keyStr);
  if (!parsed) return false;

  const { modifiers, key } = parsed;

  const hasMacModifiers = modifiers.some((modifier) => ['⌘', '⌃', '⌥'].includes(modifier));
  const hasPcModifiers = modifiers.some((modifier) => ['Ctrl', 'Alt', 'Win'].includes(modifier));
  if ((!isMac && hasMacModifiers) || (isMac && hasPcModifiers)) {
    return false;
  }

  // Check modifiers
  if (isMac) {
    const needMeta = modifiers.includes('⌘');
    const needCtrl = modifiers.includes('⌃');
    const needAlt = modifiers.includes('⌥');
    const needShift = modifiers.includes('Shift');

    if (e.metaKey !== needMeta) return false;
    if (e.ctrlKey !== needCtrl) return false;
    if (e.altKey !== needAlt) return false;
    if (e.shiftKey !== needShift) return false;
  } else {
    const needCtrl = modifiers.includes('Ctrl');
    const needAlt = modifiers.includes('Alt');
    const needShift = modifiers.includes('Shift');
    const needMeta = modifiers.includes('Win');

    if (e.ctrlKey !== needCtrl) return false;
    if (e.altKey !== needAlt) return false;
    if (e.shiftKey !== needShift) return false;
    if (e.metaKey !== needMeta) return false;
  }

  const normalizeKey = (rawKey: string): string => {
    let normalizedKey = rawKey;
    if (normalizedKey === ' ') normalizedKey = 'Space';
    else if (normalizedKey === 'ArrowUp') normalizedKey = '↑';
    else if (normalizedKey === 'ArrowDown') normalizedKey = '↓';
    else if (normalizedKey === 'ArrowLeft') normalizedKey = '←';
    else if (normalizedKey === 'ArrowRight') normalizedKey = '→';
    else if (normalizedKey === 'Escape') normalizedKey = 'Esc';
    else if (normalizedKey === 'Backspace') normalizedKey = '⌫';
    else if (normalizedKey === 'Delete') normalizedKey = 'Del';
    else if (normalizedKey === '[') normalizedKey = '[';
    else if (normalizedKey === ']') normalizedKey = ']';
    else if (normalizedKey === 'Del') normalizedKey = 'Del';
    return normalizedKey;
  };

  const eventKey = normalizeKey(shortcutEventKey(e));
  const parsedKey = normalizeKey(key);

  return eventKey.toLowerCase() === parsedKey.toLowerCase();
};

export const DEFAULT_KEY_BINDINGS: KeyBinding[] = [
  // Tab Management
  { id: 'switch-tab-1-9', action: 'switchToTab', label: 'Switch to Tab [1...9]', mac: '⌘ + [1...9]', pc: 'Ctrl + [1...9]', category: 'tabs' },
  { id: 'next-tab', action: 'nextTab', label: 'Next Tab', mac: '⌘ + Shift + ]', pc: 'Ctrl + Tab', category: 'tabs' },
  { id: 'prev-tab', action: 'prevTab', label: 'Previous Tab', mac: '⌘ + Shift + [', pc: 'Ctrl + Shift + Tab', category: 'tabs' },
  { id: 'close-tab', action: 'closeTab', label: 'Close Tab', mac: '⌘ + W', pc: 'Ctrl + W', category: 'tabs' },
  { id: 'new-tab', action: 'newTab', label: 'New Local Tab', mac: '⌘ + T', pc: 'Ctrl + T', category: 'tabs' },

  // Terminal Operations
  { id: 'copy', action: 'copy', label: 'Copy from Terminal', mac: '⌘ + C', pc: 'Ctrl + Shift + C', category: 'terminal' },
  { id: 'paste', action: 'paste', label: 'Paste to Terminal', mac: '⌘ + V', pc: 'Ctrl + Shift + V', category: 'terminal' },
  { id: 'paste-selection', action: 'pasteSelection', label: 'Paste Selection to Terminal', mac: '⌘ + Shift + X', pc: 'Ctrl + Shift + X', category: 'terminal' },
  { id: 'select-all', action: 'selectAll', label: 'Select All in Terminal', mac: '⌘ + A', pc: 'Ctrl + Shift + A', category: 'terminal' },
  { id: 'clear-buffer', action: 'clearBuffer', label: 'Clear Terminal Buffer', mac: '⌘ + ⌃ + K', pc: 'Ctrl + Shift + K', category: 'terminal' },
  { id: 'search-terminal', action: 'searchTerminal', label: 'Open Terminal Search', mac: '⌘ + F', pc: 'Ctrl + F', category: 'terminal' },

  // Navigation / Split View
  { id: 'move-focus', action: 'moveFocus', label: 'Move focus between Split View panes', mac: '⌘ + ⌥ + arrows', pc: 'Ctrl + Alt + arrows', category: 'navigation' },
  { id: 'split-horizontal', action: 'splitHorizontal', label: 'Split Horizontal', mac: '⌘ + D', pc: 'Ctrl + Shift + D', category: 'navigation' },
  { id: 'split-vertical', action: 'splitVertical', label: 'Split Vertical', mac: '⌘ + Shift + D', pc: 'Ctrl + Shift + E', category: 'navigation' },

  // App Features
  { id: 'open-hosts', action: 'openHosts', label: 'Open Hosts Page', mac: 'Disabled', pc: 'Disabled', category: 'app' },
  { id: 'open-local', action: 'openLocal', label: 'Open Local Terminal', mac: '⌘ + L', pc: 'Ctrl + L', category: 'app' },
  { id: 'open-sftp', action: 'openSftp', label: 'Open SFTP', mac: '⌘ + Shift + O', pc: 'Ctrl + Shift + O', category: 'app' },
  { id: 'port-forwarding', action: 'portForwarding', label: 'Open Port Forwarding', mac: '⌘ + P', pc: 'Ctrl + P', category: 'app' },
  { id: 'command-palette', action: 'commandPalette', label: 'Open Command Palette', mac: '⌘ + K', pc: 'Ctrl + K', category: 'app' },
  { id: 'quick-switch', action: 'quickSwitch', label: 'Quick Switch', mac: '⌘ + J', pc: 'Ctrl + J', category: 'app' },
  { id: 'new-workspace', action: 'newWorkspace', label: 'New Workspace', mac: '⌘ + Shift + J', pc: 'Ctrl + Shift + J', category: 'app' },
  { id: 'snippets', action: 'snippets', label: 'Open Snippets', mac: '⌘ + Shift + S', pc: 'Ctrl + Shift + S', category: 'app' },
  { id: 'broadcast', action: 'broadcast', label: 'Switch the Broadcast Mode', mac: '⌘ + B', pc: 'Ctrl + B', category: 'app' },
  { id: 'toggle-side-panel', action: 'toggleSidePanel', label: 'Toggle Side Panel', mac: '⌘ + \\', pc: 'Ctrl + \\', category: 'app' },
  { id: 'open-settings', action: 'openSettings', label: 'Open Settings', mac: '⌘ + ,', pc: 'Ctrl + ,', category: 'app' },

  // SFTP Operations
  { id: 'sftp-copy', action: 'sftpCopy', label: 'Copy Files', mac: '⌘ + C', pc: 'Ctrl + C', category: 'sftp' },
  { id: 'sftp-cut', action: 'sftpCut', label: 'Cut Files', mac: '⌘ + X', pc: 'Ctrl + X', category: 'sftp' },
  { id: 'sftp-paste', action: 'sftpPaste', label: 'Paste Files', mac: '⌘ + V', pc: 'Ctrl + V', category: 'sftp' },
  { id: 'sftp-select-all', action: 'sftpSelectAll', label: 'Select All Files', mac: '⌘ + A', pc: 'Ctrl + A', category: 'sftp' },
  { id: 'sftp-rename', action: 'sftpRename', label: 'Rename File', mac: 'F2', pc: 'F2', category: 'sftp' },
  { id: 'sftp-delete', action: 'sftpDelete', label: 'Delete Files', mac: '⌘ + ⌫', pc: 'Delete', category: 'sftp' },
  { id: 'sftp-refresh', action: 'sftpRefresh', label: 'Refresh', mac: '⌘ + R', pc: 'F5', category: 'sftp' },
  { id: 'sftp-new-folder', action: 'sftpNewFolder', label: 'New Folder', mac: '⌘ + Shift + N', pc: 'Ctrl + Shift + N', category: 'sftp' },
  { id: 'sftp-open', action: 'sftpOpen', label: 'Open File / Enter Directory', mac: 'Enter', pc: 'Enter', category: 'sftp' },
  { id: 'sftp-go-parent', action: 'sftpGoParent', label: 'Go to Parent Directory', mac: '⌫', pc: 'Backspace', category: 'sftp' },
  { id: 'sftp-navigate-to', action: 'sftpNavigateTo', label: 'Navigate to Selected Directory', mac: '⌘ + Enter', pc: 'Ctrl + Enter', category: 'sftp' },
];
