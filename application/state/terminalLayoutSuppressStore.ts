import { useSyncExternalStore } from 'react';

type Listener = () => void;

let suppressDepth = 0;
const listeners = new Set<Listener>();
let notifyRafId: number | null = null;

const scheduleFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb: () => void) => setTimeout(cb, 0) as unknown as number;

function scheduleEmit() {
  if (notifyRafId !== null) return;
  notifyRafId = scheduleFrame(() => {
    notifyRafId = null;
    listeners.forEach((listener) => listener());
  });
}

export const terminalLayoutSuppressStore = {
  getActive: () => suppressDepth > 0,

  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  begin: () => {
    suppressDepth += 1;
    scheduleEmit();
  },

  end: () => {
    const wasActive = suppressDepth > 0;
    suppressDepth = Math.max(0, suppressDepth - 1);
    if (wasActive) {
      scheduleEmit();
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
