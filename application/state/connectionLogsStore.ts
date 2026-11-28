import { useSyncExternalStore } from 'react';

import type { ConnectionLog } from '../../domain/models';

type Listener = () => void;

export type ConnectionLogsSnapshot = {
  connectionLogs: readonly ConnectionLog[];
};

export type ConnectionLogsActions = {
  updateConnectionLog: (id: string, updates: Partial<ConnectionLog>) => void | Promise<unknown>;
  toggleConnectionLogSaved: (id: string) => void;
  deleteConnectionLog: (id: string) => void;
  clearUnsavedConnectionLogs: () => void;
};

const EMPTY_CONNECTION_LOGS: readonly ConnectionLog[] = Object.freeze([]);

export const EMPTY_CONNECTION_LOGS_SNAPSHOT: ConnectionLogsSnapshot = Object.freeze({
  connectionLogs: EMPTY_CONNECTION_LOGS,
});

/**
 * External store for connection logs so the Vault logs section and log-view
 * replays can subscribe without keeping logs in the App domain bags. Every
 * session start/exit appends a log, which would otherwise rebuild the whole
 * shell.
 */
class ConnectionLogsStore {
  private snapshot: ConnectionLogsSnapshot = EMPTY_CONNECTION_LOGS_SNAPSHOT;
  private actions: ConnectionLogsActions | null = null;
  private listeners = new Set<Listener>();
  private actionListeners = new Set<Listener>();

  getSnapshot = (): ConnectionLogsSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSnapshot(next: ConnectionLogsSnapshot): void {
    if (this.snapshot.connectionLogs === next.connectionLogs) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  getActions = (): ConnectionLogsActions | null => this.actions;

  subscribeActions = (listener: Listener): (() => void) => {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  };

  setActions(next: ConnectionLogsActions | null): void {
    if (this.actions === next) return;
    this.actions = next;
    for (const listener of this.actionListeners) {
      listener();
    }
  }
}

export const connectionLogsStore = new ConnectionLogsStore();

export function publishConnectionLogsSnapshot(
  snapshot: ConnectionLogsSnapshot,
): void {
  connectionLogsStore.setSnapshot(snapshot);
}

export function getConnectionLogsSnapshot(): ConnectionLogsSnapshot {
  return connectionLogsStore.getSnapshot();
}

export function subscribeConnectionLogs(listener: Listener): () => void {
  return connectionLogsStore.subscribe(listener);
}

export function getEmptyConnectionLogsSnapshot(): ConnectionLogsSnapshot {
  return EMPTY_CONNECTION_LOGS_SNAPSHOT;
}

export function registerConnectionLogsActions(
  actions: ConnectionLogsActions | null,
): void {
  connectionLogsStore.setActions(actions);
}

export function getConnectionLogsActions(): ConnectionLogsActions | null {
  return connectionLogsStore.getActions();
}

export function subscribeConnectionLogsActions(listener: Listener): () => void {
  return connectionLogsStore.subscribeActions(listener);
}

const noopUpdateConnectionLog: ConnectionLogsActions['updateConnectionLog'] = () => {};
const noopToggleConnectionLogSaved: ConnectionLogsActions['toggleConnectionLogSaved'] = () => {};
const noopDeleteConnectionLog: ConnectionLogsActions['deleteConnectionLog'] = () => {};
const noopClearUnsavedConnectionLogs: ConnectionLogsActions['clearUnsavedConnectionLogs'] = () => {};

/** Subscribe to the connection log catalog plus its vault mutation actions. */
export function useConnectionLogsStore(): {
  connectionLogs: ConnectionLog[];
  updateConnectionLog: ConnectionLogsActions['updateConnectionLog'];
  toggleConnectionLogSaved: ConnectionLogsActions['toggleConnectionLogSaved'];
  deleteConnectionLog: ConnectionLogsActions['deleteConnectionLog'];
  clearUnsavedConnectionLogs: ConnectionLogsActions['clearUnsavedConnectionLogs'];
} {
  const snapshot = useSyncExternalStore(
    subscribeConnectionLogs,
    getConnectionLogsSnapshot,
    getConnectionLogsSnapshot,
  );
  const actions = useSyncExternalStore(
    subscribeConnectionLogsActions,
    getConnectionLogsActions,
    getConnectionLogsActions,
  );
  return {
    connectionLogs: snapshot.connectionLogs as ConnectionLog[],
    updateConnectionLog: actions?.updateConnectionLog ?? noopUpdateConnectionLog,
    toggleConnectionLogSaved: actions?.toggleConnectionLogSaved ?? noopToggleConnectionLogSaved,
    deleteConnectionLog: actions?.deleteConnectionLog ?? noopDeleteConnectionLog,
    clearUnsavedConnectionLogs: actions?.clearUnsavedConnectionLogs ?? noopClearUnsavedConnectionLogs,
  };
}
