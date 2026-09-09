/**
 * Maps live SFTP connection ids to the top-level tab that owns the panel
 * hosting them (a terminal/workspace tab for SftpSidePanel instances).
 *
 * Editor tabs record the SFTP `connection.id` as their `sessionId` — not the
 * owning terminal session id — so batch-close logic that wants to keep an
 * editor's owning tab open after a cancelled dirty-save prompt must resolve
 * the owner through this registry instead of comparing `editorTab.sessionId`
 * against terminal session ids.
 *
 * Each mounted SftpSidePanel registers a resolver that reports the connection
 * ids it currently owns plus its host tab id; the top-level SftpView either
 * registers nothing (its owner is not a closable terminal tab) or registers
 * with a non-terminal owner id that simply never matches.
 */
export interface EditorSftpOwnerSnapshot {
  connectionIds: readonly string[];
  ownerTabId: string | null;
}

type EditorSftpOwnerResolver = () => EditorSftpOwnerSnapshot;

const resolvers = new Set<EditorSftpOwnerResolver>();

export const registerEditorSftpOwnerResolver = (resolver: EditorSftpOwnerResolver): (() => void) => {
  resolvers.add(resolver);
  return () => {
    resolvers.delete(resolver);
  };
};

export const findEditorSftpOwnerTabId = (connectionId: string | undefined): string | null => {
  if (!connectionId) return null;
  for (const resolve of resolvers) {
    const snapshot = resolve();
    if (snapshot.ownerTabId && snapshot.connectionIds.includes(connectionId)) {
      return snapshot.ownerTabId;
    }
  }
  return null;
};
