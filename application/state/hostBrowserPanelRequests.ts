import type { Host } from '../../domain/models';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export type HostBrowserPanelRequest = { host: Host; sessionId?: string; url?: string };
type Listener = (request: HostBrowserPanelRequest) => void;
const listeners = new Set<Listener>();
let pending: HostBrowserPanelRequest | null = null;
let unsubscribeNative: (() => void) | undefined;

export function requestHostBrowserPanel(request: HostBrowserPanelRequest): void {
  if (!listeners.size) {
    const forward = netcattyBridge.get()?.requestHostBrowserPanel;
    if (forward) {
      void forward(request).catch(() => { pending = request; });
    } else pending = request;
    return;
  }
  for (const listener of listeners) listener(request);
}

export function subscribeHostBrowserPanelRequests(listener: Listener): () => void {
  listeners.add(listener);
  if (!unsubscribeNative) unsubscribeNative = netcattyBridge.get()?.onHostBrowserPanelRequest?.((request) => {
    for (const current of listeners) current(request);
  });
  if (pending) {
    const request = pending;
    pending = null;
    listener(request);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { unsubscribeNative?.(); unsubscribeNative = undefined; }
  };
}
