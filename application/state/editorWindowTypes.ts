export type EditorTabPlacement = "tab" | "window";

export interface EditorWindowTabSnapshot {
  editorId: string;
  sessionId: string;
  sftpTabId: string;
  hostId: string;
  hostLabel?: string;
  remotePath: string;
  fileName: string;
  languageId: string;
  content: string;
  baselineContent: string;
  wordWrap: boolean;
  viewState: unknown;
}

export interface EditorWindowSaveRequest {
  requestId: string;
  editorId: string;
  sessionId: string;
  sftpTabId: string;
  hostId: string;
  remotePath: string;
  content: string;
}

export interface EditorWindowSaveResult {
  requestId: string;
  ok: boolean;
  liveConnectionId?: string;
  error?: string;
}

export interface EditorWindowCloseTabsRequest {
  requestId: string;
  editorIds: string[];
  force?: boolean;
}

export interface EditorWindowCloseTabsResult {
  requestId: string;
  cancelled: boolean;
  closedIds: string[];
}
