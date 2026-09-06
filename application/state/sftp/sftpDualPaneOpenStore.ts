import { activeTabStore } from "../activeTabStore";

export type DualPaneSftpRequest = {
  hostId: string;
  seq: number;
};

type Listener = (request: DualPaneSftpRequest) => void;

const listeners = new Set<Listener>();
let pending: DualPaneSftpRequest | null = null;
let seq = 0;

export function requestOpenDualPaneSftp(hostId: string): DualPaneSftpRequest {
  const request: DualPaneSftpRequest = { hostId, seq: ++seq };
  if (listeners.size > 0) {
    pending = null;
    for (const listener of listeners) listener(request);
  } else {
    pending = request;
  }
  if (typeof globalThis.window !== "undefined") {
    activeTabStore.setActiveTabId("sftp");
  }
  return request;
}

export function consumePendingDualPaneSftpRequest(): DualPaneSftpRequest | null {
  const current = pending;
  pending = null;
  return current;
}

export function subscribeDualPaneSftpOpen(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetDualPaneSftpOpenStore() {
  pending = null;
  listeners.clear();
  seq = 0;
}
