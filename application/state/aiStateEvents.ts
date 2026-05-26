/**
 * Same-window AI-state-changed event plumbing.
 *
 * `localStorage` writes only emit `storage` events in *other* windows; the
 * window doing the write never gets notified. That's a problem for code
 * that mutates AI storage outside of `useAIState`'s setters (e.g. sync
 * apply): without a manual nudge, mounted components keep showing stale
 * AI state until reload.
 *
 * Both the dispatcher and `useAIState`'s listener live here so non-React
 * call sites (sync, IPC handlers, etc.) can fire the event without
 * pulling in the hook.
 */

export const AI_STATE_CHANGED_EVENT = 'netcatty:ai-state-changed';

export function emitAIStateChanged(key: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ key: string }>(AI_STATE_CHANGED_EVENT, { detail: { key } }));
}
