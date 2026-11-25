import { useSyncExternalStore } from 'react';
import { createListenerRegistry } from './createExternalStore';

let suppressDepth = 0;
const registry = createListenerRegistry();

export const terminalLayoutSuppressStore = {
  getActive: () => suppressDepth > 0,

  subscribe: registry.subscribe,

  begin: () => {
    suppressDepth += 1;
    registry.scheduleNotify();
  },

  end: () => {
    const wasActive = suppressDepth > 0;
    suppressDepth = Math.max(0, suppressDepth - 1);
    if (wasActive) {
      registry.scheduleNotify();
    }
  },
};

export function useTerminalLayoutSuppressActive(): boolean {
  return useSyncExternalStore(
    terminalLayoutSuppressStore.subscribe,
    terminalLayoutSuppressStore.getActive,
    terminalLayoutSuppressStore.getActive,
  );
}
