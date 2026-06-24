import type { TerminalSession, Workspace } from "../../domain/models";
import {
  buildSessionRestorePayload,
  sanitizeSessionRestorePayload,
  type SessionRestorePayload,
} from "../../domain/sessionRestore";

export type InitialRestoredSessionState = {
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  activeTabId: string;
};

export function createInitialRestoredSessionState({
  restoreEnabled,
  payload,
}: {
  restoreEnabled: boolean;
  payload: SessionRestorePayload | null;
}): InitialRestoredSessionState {
  if (!restoreEnabled || !payload) {
    return {
      sessions: [],
      workspaces: [],
      tabOrder: [],
      activeTabId: "vault",
    };
  }

  const sanitized = sanitizeSessionRestorePayload(payload);
  return {
    sessions: sanitized.sessions,
    workspaces: sanitized.workspaces,
    tabOrder: sanitized.tabOrder,
    activeTabId: sanitized.activeTabId,
  };
}

export function shouldPersistSessionRestoreState(
  sessions: readonly TerminalSession[],
  workspaces: readonly Workspace[],
  tabOrder: readonly string[],
): boolean {
  return sessions.length > 0 || workspaces.length > 0 || tabOrder.length > 0;
}

export function buildPersistableSessionRestorePayload({
  sessions,
  workspaces,
  tabOrder,
  activeTabId,
  now,
}: {
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  activeTabId: string;
  now?: number;
}): SessionRestorePayload | null {
  if (!shouldPersistSessionRestoreState(sessions, workspaces, tabOrder)) return null;
  return buildSessionRestorePayload({
    sessions,
    workspaces,
    tabOrder,
    activeTabId,
    now,
  });
}

export function buildAndWriteSessionRestorePayload({
  restoreEnabled = true,
  clearOnEmpty = false,
  sessions,
  workspaces,
  tabOrder,
  activeTabId,
  now,
  storage,
}: {
  restoreEnabled?: boolean;
  clearOnEmpty?: boolean;
  sessions: TerminalSession[];
  workspaces: Workspace[];
  tabOrder: string[];
  activeTabId: string;
  now?: number;
  storage: {
    write(payload: SessionRestorePayload): boolean;
    clear(): void;
  };
}): boolean {
  if (!restoreEnabled) {
    storage.clear();
    return false;
  }
  const payload = buildPersistableSessionRestorePayload({
    sessions,
    workspaces,
    tabOrder,
    activeTabId,
    now,
  });
  if (!payload) {
    if (clearOnEmpty) {
      storage.clear();
    }
    return false;
  }
  return storage.write(payload);
}

export function mergeSessionRestoreCwd(
  payload: SessionRestorePayload,
  sessionId: string,
  cwd: string | null,
): SessionRestorePayload {
  return sanitizeSessionRestorePayload({
    ...payload,
    sessions: payload.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const { lastCwd: _lastCwd, ...rest } = session;
      return cwd ? { ...rest, lastCwd: cwd } : rest;
    }),
  });
}

export function updateRestoredSessionStatusState<T extends Pick<TerminalSession, "id" | "status" | "restoreState">>(
  sessions: readonly T[],
  sessionId: string,
  status: TerminalSession["status"],
): T[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const shouldClearRestoreState = status === "connecting" || status === "connected";
    if (session.status === status && (!shouldClearRestoreState || session.restoreState === undefined)) {
      return session;
    }
    changed = true;
    if (!shouldClearRestoreState) return { ...session, status };
    const { restoreState: _restoreState, ...rest } = session;
    return { ...rest, status } as T;
  });
  return changed ? next : sessions as T[];
}
