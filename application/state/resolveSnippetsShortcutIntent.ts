export type SnippetsShortcutIntent =
  | { kind: 'toggleTerminalScripts' }
  | { kind: 'openVaultSnippets' };

export type ScriptsSidePanelShortcutIntent =
  | { kind: 'closeTerminalSidePanel' }
  | { kind: 'openTerminalScripts' };

export interface ResolveSnippetsShortcutIntentInput {
  activeTabId: string | null;
  sessionForTab: { id: string } | null;
  workspaceForTab: { id: string } | null;
  terminalScriptsToggleAvailable?: boolean;
}

export function resolveSnippetsShortcutIntent(
  input: ResolveSnippetsShortcutIntentInput,
): SnippetsShortcutIntent {
  const {
    activeTabId,
    sessionForTab,
    workspaceForTab,
    terminalScriptsToggleAvailable = true,
  } = input;
  if (!activeTabId) return { kind: 'openVaultSnippets' };

  if ((sessionForTab || workspaceForTab) && terminalScriptsToggleAvailable) {
    return { kind: 'toggleTerminalScripts' };
  }

  return { kind: 'openVaultSnippets' };
}

export function resolveScriptsSidePanelShortcutIntent(
  activePanel: string | null,
): ScriptsSidePanelShortcutIntent {
  if (activePanel === 'scripts') {
    return { kind: 'closeTerminalSidePanel' };
  }

  return { kind: 'openTerminalScripts' };
}
