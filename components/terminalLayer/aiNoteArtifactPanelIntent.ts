import type { SidePanelTab } from './TerminalLayerSupport';

export type AiNoteArtifactPanelIntent =
  | {
      kind: 'openNotesSidePanel';
      tabId: string;
      noteId: string;
      returnPanel: SidePanelTab | null;
    }
  | {
      kind: 'fallback';
      noteId: string;
    };

export function resolveAiNoteArtifactPanelIntent({
  activeTabId,
  currentPanel,
  noteId,
}: {
  activeTabId: string | null | undefined;
  currentPanel: SidePanelTab | null;
  noteId: string;
}): AiNoteArtifactPanelIntent {
  if (!activeTabId) {
    return { kind: 'fallback', noteId };
  }

  return {
    kind: 'openNotesSidePanel',
    tabId: activeTabId,
    noteId,
    returnPanel: currentPanel && currentPanel !== 'notes' ? currentPanel : null,
  };
}
