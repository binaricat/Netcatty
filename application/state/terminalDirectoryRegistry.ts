import type { TerminalDirectoryController } from './terminalDirectoryController';

const sessions = new Map<string, TerminalDirectoryController>();
const consumers = new Map<string, number>();
const listeners = new Set<() => void>();
export const subscribeTerminalDirectories = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getTerminalDirectory = (id: string) => sessions.get(id) ?? null;
export function registerTerminalDirectory(id: string, controller: TerminalDirectoryController) {
  sessions.set(id, controller);
  listeners.forEach(listener => listener());
  return () => {
    controller.dispose();
    if (sessions.get(id) !== controller) return;
    sessions.delete(id);
    listeners.forEach(listener => listener());
  };
}
export function observeTerminalDirectory(id: string) {
  consumers.set(id, (consumers.get(id) ?? 0) + 1);
  return () => {
    const next = (consumers.get(id) ?? 1) - 1;
    if (next) consumers.set(id, next); else consumers.delete(id);
  };
}
/** Called by the existing command completion path, only while chips are visible. */
export function refreshObservedTerminalDirectory(id: string) {
  if (consumers.has(id)) void sessions.get(id)?.refresh().catch(() => {});
}
