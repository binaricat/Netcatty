/**
 * Process-wide cap on live xterm WebGL contexts.
 *
 * Chromium keeps at most 16 WebGL contexts alive per renderer process and
 * force-loses the one that drew least recently once a new context pushes past
 * that. Unless hibernation is on, hidden terminal panes keep their WebGL
 * renderer, so a window with many terminal tabs used to cross the limit. Each
 * forced loss rebuilt a context, which pushed out another one, until the
 * recovery breaker parked those terminals on the DOM renderer for good.
 *
 * The budget stays below the browser limit by releasing the renderers of panes
 * that have been hidden for a while, least recently seen first. Visible panes
 * are never released and always get a context. A released pane builds a new
 * renderer when it is shown again. Below the cap nothing changes.
 */

export const MAX_ACTIVE_WEBGL_CONTEXTS = 12;

/**
 * Same window as the CSS-only tab reveal in useTerminalEffects, so quickly
 * flipping between tabs never tears down and rebuilds a renderer.
 */
export const MIN_HIDDEN_MS_BEFORE_WEBGL_RELEASE = 3_000;

export interface WebglContextBudgetMember {
  /** When the pane was hidden, or null while it is on screen. */
  getHiddenSince(): number | null;
  /** Drop the member's WebGL renderer. Must not acquire a context again. */
  release(): void;
}

export interface WebglContextBudget {
  /**
   * Reserve a context for a member about to create its renderer. Visible
   * members always get one; hidden members only while the budget has room.
   */
  tryAcquire(member: WebglContextBudgetMember): boolean;
  /** Give the slot back once the member's renderer is gone. Idempotent. */
  forget(member: WebglContextBudgetMember): void;
  /** A member holding a context was just hidden; release it later if over. */
  noteHidden(member: WebglContextBudgetMember): void;
  getActiveCount(): number;
}

interface WebglContextBudgetOptions {
  maxActiveContexts?: number;
  minHiddenMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createWebglContextBudget(
  options: WebglContextBudgetOptions = {},
): WebglContextBudget {
  const maxActive = options.maxActiveContexts ?? MAX_ACTIVE_WEBGL_CONTEXTS;
  const minHiddenMs = options.minHiddenMs ?? MIN_HIDDEN_MS_BEFORE_WEBGL_RELEASE;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const active = new Set<WebglContextBudgetMember>();
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let checkAt = Number.POSITIVE_INFINITY;

  const scheduleCheck = (at: number) => {
    if (checkTimer !== null) {
      if (checkAt <= at) return;
      clearTimer(checkTimer);
    }
    checkAt = at;
    checkTimer = setTimer(() => {
      checkTimer = null;
      checkAt = Number.POSITIVE_INFINITY;
      releaseOverflow();
    }, Math.max(0, at - now()));
  };

  const releaseOverflow = () => {
    if (active.size <= maxActive) return;
    const time = now();
    const releasable: Array<{ member: WebglContextBudgetMember; hiddenSince: number }> = [];
    let nextReleasableAt = Number.POSITIVE_INFINITY;
    for (const member of active) {
      const hiddenSince = member.getHiddenSince();
      if (hiddenSince === null) continue;
      const releasableAt = hiddenSince + minHiddenMs;
      if (releasableAt <= time) releasable.push({ member, hiddenSince });
      else nextReleasableAt = Math.min(nextReleasableAt, releasableAt);
    }
    releasable.sort((a, b) => a.hiddenSince - b.hiddenSince);
    for (const { member } of releasable) {
      if (active.size <= maxActive) break;
      active.delete(member);
      member.release();
    }
    if (active.size > maxActive && Number.isFinite(nextReleasableAt)) {
      scheduleCheck(nextReleasableAt);
    }
  };

  return {
    tryAcquire(member) {
      if (active.has(member)) return true;
      if (member.getHiddenSince() !== null && active.size >= maxActive) return false;
      active.add(member);
      releaseOverflow();
      return true;
    },
    forget(member) {
      active.delete(member);
    },
    noteHidden(member) {
      if (!active.has(member) || active.size <= maxActive) return;
      const hiddenSince = member.getHiddenSince();
      if (hiddenSince !== null) scheduleCheck(hiddenSince + minHiddenMs);
    },
    getActiveCount: () => active.size,
  };
}

let sharedBudget: WebglContextBudget | null = null;

/** The budget shared by every terminal in this renderer process. */
export function getSharedWebglContextBudget(): WebglContextBudget {
  sharedBudget ??= createWebglContextBudget();
  return sharedBudget;
}
