import type { TerminalDirectoryController } from './terminalDirectoryController';

const sessions = new Map<string, TerminalDirectoryController>();
const consumers = new Map<string, number>();
const scheduledRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
const OUTPUT_SETTLE_MS = 150;

function cancelScheduledRefresh(id: string) {
  const timer = scheduledRefreshes.get(id);
  if (timer !== undefined) clearTimeout(timer);
  scheduledRefreshes.delete(id);
}
const listeners = new Set<() => void>();
export const subscribeTerminalDirectories = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getTerminalDirectory = (id: string) => sessions.get(id) ?? null;
export function registerTerminalDirectory(id: string, controller: TerminalDirectoryController) {
  cancelScheduledRefresh(id);
  sessions.set(id, controller);
  listeners.forEach(listener => listener());
  return () => {
    controller.dispose();
    if (sessions.get(id) !== controller) return;
    cancelScheduledRefresh(id);
    sessions.delete(id);
    listeners.forEach(listener => listener());
  };
}
export function observeTerminalDirectory(id: string) {
  consumers.set(id, (consumers.get(id) ?? 0) + 1);
  return () => {
    const next = (consumers.get(id) ?? 1) - 1;
    if (next) consumers.set(id, next);
    else { consumers.delete(id); cancelScheduledRefresh(id); }
  };
}
/** Called by the existing command completion path, only while chips are visible. */
export function refreshObservedTerminalDirectory(id: string) {
  cancelScheduledRefresh(id);
  if (consumers.has(id)) void sessions.get(id)?.refresh().catch(() => {});
}

/**
 * Shells with custom prompts may emit neither OSC 7/133 nor a trusted command
 * completion. Debounce actual output/submission activity instead of polling or
 * interpreting `cd` text. This only reads the bound shell's real cwd.
 */
export function scheduleObservedTerminalDirectoryRefresh(id: string) {
  if (!consumers.has(id) || !sessions.has(id)) return;
  cancelScheduledRefresh(id);
  scheduledRefreshes.set(id, setTimeout(() => {
    scheduledRefreshes.delete(id);
    refreshObservedTerminalDirectory(id);
  }, OUTPUT_SETTLE_MS));
}
