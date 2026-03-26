import { useCallback, useEffect, useRef } from 'react';
import { KeyBinding, matchesKeyBinding } from '../../domain/models';

interface HotkeyActions {
  // Tab management
  switchToTab: (tabIndex: number) => void;
  nextTab: () => void;
  prevTab: () => void;
  closeTab: () => void;
  newTab: () => void;
  
  // Navigation
  openHosts: () => void;
  openSftp: () => void;
  quickSwitch: () => void;
  commandPalette: () => void;
  portForwarding: () => void;
  snippets: () => void;
  
  // Terminal actions (handled per-terminal)
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  clearBuffer: () => void;
  searchTerminal: () => void;
  
  // Workspace/split actions
  splitHorizontal: () => void;
  splitVertical: () => void;
  moveFocus: (direction: 'up' | 'down' | 'left' | 'right') => void;
  
  // App features
  broadcast: () => void;
  openLocal: () => void;
}

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
    'commandPalette',
    'portForwarding',
    'snippets',
    'splitHorizontal',
    'splitVertical',
    'moveFocus',
    'broadcast',
    'openLocal',
  ]);
};

// Terminal-level actions that xterm should not intercept
export const getTerminalPassthroughActions = (): Set<string> => {
  return new Set([
    'copy',
    'paste',
    'selectAll',
    'clearBuffer',
    'searchTerminal',
  ]);
};

interface UseGlobalHotkeysOptions {
  hotkeyScheme: 'disabled' | 'mac' | 'pc';
  keyBindings: KeyBinding[];
  actions: Partial<HotkeyActions>;
  orderedTabs: string[];
  sessions: { id: string }[];
  workspaces: { id: string }[];
  isSettingsOpen?: boolean;
}

export const useGlobalHotkeys = ({
  hotkeyScheme,
  keyBindings,
  actions,
  orderedTabs,
  sessions,
  workspaces,
  isSettingsOpen = false,
}: UseGlobalHotkeysOptions) => {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const orderedTabsRef = useRef(orderedTabs);
  orderedTabsRef.current = orderedTabs;

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  const handleGlobalKeyDown = useCallback((e: KeyboardEvent) => {
    if (hotkeyScheme === 'disabled') return;
    if (isSettingsOpen) return; // Don't handle hotkeys when settings is open

    const isMac = hotkeyScheme === 'mac';
    const appLevelActions = getAppLevelActions();

    // Check if this is an app-level shortcut
    const matched = checkAppShortcut(e, keyBindings, isMac);
    if (!matched) return;

    const { action, binding: _binding } = matched;

    // Only handle app-level actions here
    // Terminal-level actions are handled by the terminal itself
    if (!appLevelActions.has(action)) return;

    e.preventDefault();
    e.stopPropagation();

    const currentActions = actionsRef.current;
    switch (action) {
      case 'switchToTab': {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 9) {
          currentActions.switchToTab?.(num);
        }
        break;
      }
      case 'nextTab':
        currentActions.nextTab?.();
        break;
      case 'prevTab':
        currentActions.prevTab?.();
        break;
      case 'closeTab':
        currentActions.closeTab?.();
        break;
      case 'newTab':
        currentActions.newTab?.();
        break;
      case 'openHosts':
        currentActions.openHosts?.();
        break;
      case 'openSftp':
        currentActions.openSftp?.();
        break;
      case 'openLocal':
        currentActions.openLocal?.();
        break;
      case 'quickSwitch':
        currentActions.quickSwitch?.();
        break;
      case 'commandPalette':
        currentActions.commandPalette?.();
        break;
      case 'portForwarding':
        currentActions.portForwarding?.();
        break;
      case 'snippets':
        currentActions.snippets?.();
        break;
      case 'splitHorizontal':
        currentActions.splitHorizontal?.();
        break;
      case 'splitVertical':
        currentActions.splitVertical?.();
        break;
      case 'moveFocus': {
        // Determine direction from arrow key
        const key = e.key;
        if (key === 'ArrowUp') currentActions.moveFocus?.('up');
        else if (key === 'ArrowDown') currentActions.moveFocus?.('down');
        else if (key === 'ArrowLeft') currentActions.moveFocus?.('left');
        else if (key === 'ArrowRight') currentActions.moveFocus?.('right');
        break;
      }
      case 'broadcast':
        currentActions.broadcast?.();
        break;
    }
  }, [hotkeyScheme, keyBindings, isSettingsOpen]);

  useEffect(() => {
    // Use capture phase to intercept before xterm
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [handleGlobalKeyDown]);
};

// Helper to create key event handler for xterm's attachCustomKeyEventHandler
// Returns false to let xterm handle the key, true to prevent xterm from handling
export const createXtermKeyHandler = (
  keyBindings: KeyBinding[],
  isMac: boolean,
  onTerminalAction?: (action: string, e: KeyboardEvent) => void
) => {
  const appLevelActions = getAppLevelActions();
  const terminalActions = getTerminalPassthroughActions();

  return (e: KeyboardEvent): boolean => {
    const matched = checkAppShortcut(e, keyBindings, isMac);
    if (!matched) return true; // Let xterm handle it

    const { action } = matched;

    // App-level actions: prevent xterm from handling, let global handler take over
    if (appLevelActions.has(action)) {
      return false; // Don't let xterm handle, will bubble to global handler
    }

    // Terminal-level actions: handle here and prevent default
    if (terminalActions.has(action)) {
      e.preventDefault();
      e.stopPropagation();
      onTerminalAction?.(action, e);
      return false;
    }

    return true; // Let xterm handle other keys
  };
};
