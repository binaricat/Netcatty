/** DOM marker for the App Lock overlay root (`data-app-lock-overlay`). */
export const APP_LOCK_OVERLAY_SELECTOR = "[data-app-lock-overlay]";

/**
 * True when the App Lock overlay is currently mounted.
 * Window/document capture key handlers that register before the overlay must
 * consult this so password keystrokes cannot mutate app state behind the lock.
 */
export function isAppLockOverlayActive(
  doc: Document | null | undefined = typeof document !== "undefined" ? document : null,
): boolean {
  return Boolean(doc?.querySelector(APP_LOCK_OVERLAY_SELECTOR));
}
