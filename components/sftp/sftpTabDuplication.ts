import type { SftpPane } from "../../application/state/sftp/types";

export type SftpTabDuplicateMode = "defaultPath" | "currentPath";

export type SftpTabDuplicateRequest =
  | { kind: "local"; path?: string }
  | { kind: "remote"; hostId: string; path?: string };

export const SFTP_TAB_DUPLICATE_MENU_ITEMS: ReadonlyArray<{
  mode: SftpTabDuplicateMode;
  labelKey: "sftp.tabs.copyDefaultPath" | "sftp.tabs.copyCurrentPath";
}> = Object.freeze([
  { mode: "defaultPath", labelKey: "sftp.tabs.copyDefaultPath" },
  { mode: "currentPath", labelKey: "sftp.tabs.copyCurrentPath" },
]);

export function canDuplicateSftpTab(
  tab: Pick<SftpPane, "connection"> | { canDuplicate?: boolean } | null | undefined,
  hasDuplicateHandler: boolean,
): boolean {
  if (!hasDuplicateHandler || !tab) return false;
  if ("connection" in tab) return tab.connection?.status === "connected";
  return !!tab.canDuplicate;
}

export function isSftpTabKeyboardContextMenuShortcut(
  key: string,
  shiftKey = false,
): boolean {
  return key === "ContextMenu" || (shiftKey && key === "F10");
}

export function isSftpTabKeyboardSelectShortcut(key: string): boolean {
  return key === "Enter" || key === " ";
}

export function shouldHandleSftpTabKeyboardEvent(
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean {
  return target === currentTarget;
}

export function getSftpTabDuplicateRequest(
  pane: Pick<SftpPane, "connection"> | null | undefined,
  mode: SftpTabDuplicateMode,
): SftpTabDuplicateRequest | null {
  const connection = pane?.connection;
  if (!connection || connection.status !== "connected") {
    return null;
  }

  const path = mode === "currentPath" && connection.currentPath
    ? { path: connection.currentPath }
    : {};

  if (connection.isLocal) {
    return {
      kind: "local",
      ...path,
    };
  }

  if (!connection.hostId) {
    return null;
  }

  return {
    kind: "remote",
    hostId: connection.hostId,
    ...path,
  };
}
