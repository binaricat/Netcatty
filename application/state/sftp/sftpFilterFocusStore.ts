type SftpFilterFocusListener = () => void;

const listenersByPaneId = new Map<string, Set<SftpFilterFocusListener>>();

export const sftpFilterFocusStore = {
  request(paneId: string): void {
    listenersByPaneId.get(paneId)?.forEach((listener) => listener());
  },

  subscribe(paneId: string, listener: SftpFilterFocusListener): () => void {
    const listeners = listenersByPaneId.get(paneId) ?? new Set<SftpFilterFocusListener>();
    listeners.add(listener);
    listenersByPaneId.set(paneId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        listenersByPaneId.delete(paneId);
      }
    };
  },
};
