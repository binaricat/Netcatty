export type WindowCommandCloseIntent =
  | { kind: 'forwardShortcut' }
  | { kind: 'closeDialog' }
  | { kind: 'closeTab' }
  | { kind: 'closeLogView'; tabId: string }
  | { kind: 'closeWindow' };

type KeyBindingMatcher = (event: KeyboardEvent, binding: string, isMac: boolean) => boolean;

export function isPrimaryModifierWBinding(
  binding: string | null,
  matcher: KeyBindingMatcher,
  isMac: boolean,
): boolean {
  return Boolean(
    binding
    && matcher({
      key: 'w',
      code: 'KeyW',
      metaKey: isMac,
      ctrlKey: !isMac,
      altKey: false,
      shiftKey: false,
    } as KeyboardEvent, binding, isMac),
  );
}

interface ResolveWindowCommandCloseIntentInput {
  activeTabId: string | null;
  editorTabIds: string[];
  sessionIds: string[];
  workspaceIds: string[];
  logViewIds: string[];
  pluginViewTabIds?: string[];
  closeTabShortcutEnabled?: boolean;
  hasOpenDialog?: boolean;
}

export function resolveWindowCommandCloseIntent({
  activeTabId,
  editorTabIds,
  sessionIds,
  workspaceIds,
  logViewIds,
  pluginViewTabIds = [],
  closeTabShortcutEnabled = true,
  hasOpenDialog = false,
}: ResolveWindowCommandCloseIntentInput): WindowCommandCloseIntent {
  if (!closeTabShortcutEnabled) {
    return { kind: 'forwardShortcut' };
  }

  if (hasOpenDialog) {
    return { kind: 'closeDialog' };
  }

  if (!activeTabId) {
    return { kind: 'closeWindow' };
  }

  if (editorTabIds.includes(activeTabId) || pluginViewTabIds.includes(activeTabId)) {
    return { kind: 'closeTab' };
  }

  if (sessionIds.includes(activeTabId) || workspaceIds.includes(activeTabId)) {
    return { kind: 'closeTab' };
  }

  if (logViewIds.includes(activeTabId)) {
    return { kind: 'closeLogView', tabId: activeTabId };
  }

  if (activeTabId === 'vault' || activeTabId === 'sftp') {
    return { kind: 'closeWindow' };
  }

  return { kind: 'closeWindow' };
}
