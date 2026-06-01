import { KeyBinding, matchesKeyBinding } from '../../domain/models';

// Check if keyboard event matches our app-level shortcuts
// Returns the matched binding action or null
export const checkAppShortcut = (
  e: KeyboardEvent,
  keyBindings: KeyBinding[],
  isMac: boolean
): { action: string; binding: KeyBinding } | null => {
  for (const binding of keyBindings) {
    const keyStr = isMac ? binding.mac : binding.pc;
    if (matchesKeyBinding(e, keyStr, isMac)) {
      return { action: binding.action, binding };
    }
  }
  return null;
};

// Get list of key bindings that should be handled at app level (not by terminal)
export const getAppLevelActions = (): Set<string> => {
  return new Set([
    'switchToTab',
    'nextTab',
    'prevTab',
    'closeTab',
    'newTab',
    'openHosts',
    'openSftp',
    'quickSwitch',
    'newWorkspace',
    'commandPalette',
    'portForwarding',
    'snippets',
    'splitHorizontal',
    'splitVertical',
    'moveFocus',
    'broadcast',
    'openLocal',
    'openSettings',
  ]);
};

// Terminal-level actions that xterm should not intercept
export const getTerminalPassthroughActions = (): Set<string> => {
  return new Set([
    'copy',
    'paste',
    'pasteSelection',
    'selectAll',
    'clearBuffer',
    'searchTerminal',
    'increaseTerminalFontSize',
    'decreaseTerminalFontSize',
    'resetTerminalFontSize',
  ]);
};
