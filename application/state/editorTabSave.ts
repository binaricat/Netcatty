import { editorSftpWrite, type EditorSftpWrite } from "./editorSftpBridge";
import { editorTabStore, type EditorTabId, type EditorTabStore } from "./editorTabStore";
import {
  createTextEditorSaveCoordinator,
  type TextEditorSaveCoordinator,
} from "./textEditorSaveCoordinator";

interface EditorTabSaveServiceDeps {
  store: EditorTabStore;
  write: EditorSftpWrite;
}

export interface EditorTabSaveService {
  saveTab(id: EditorTabId, contentOverride?: string): Promise<boolean>;
  releaseTab(id: EditorTabId): void;
}

const formatSaveError = (error: unknown): string =>
  error instanceof Error ? error.message : "Save failed";

export const createEditorTabSaveService = ({
  store,
  write,
}: EditorTabSaveServiceDeps): EditorTabSaveService => {
  const coordinators = new Map<EditorTabId, TextEditorSaveCoordinator>();

  const getCoordinator = (id: EditorTabId): TextEditorSaveCoordinator => {
    const existing = coordinators.get(id);
    if (existing) return existing;

    const coordinator = createTextEditorSaveCoordinator({
      onSave: async (content) => {
        const tab = store.getTab(id);
        if (!tab) throw new Error("Editor tab closed before save completed");
        await write(tab.sessionId, tab.hostId, tab.remotePath, content);
      },
      onSaveStart: () => {
        store.setSavingState(id, "saving");
      },
      onSaveSuccess: (content) => {
        store.markSaved(id, content);
      },
      onSaveError: (error) => {
        store.setSavingState(id, "error", formatSaveError(error));
      },
    });

    coordinators.set(id, coordinator);
    return coordinator;
  };

  return {
    saveTab: async (id, contentOverride) => {
      const tab = store.getTab(id);
      if (!tab) return false;
      return getCoordinator(id).save(contentOverride ?? tab.content);
    },
    releaseTab: (id) => {
      const coordinator = coordinators.get(id);
      coordinator?.reset();
      coordinators.delete(id);
    },
  };
};

const editorTabSaveService = createEditorTabSaveService({
  store: editorTabStore,
  write: editorSftpWrite,
});

export const saveEditorTab = editorTabSaveService.saveTab;
export const releaseEditorTabSaveCoordinator = editorTabSaveService.releaseTab;
