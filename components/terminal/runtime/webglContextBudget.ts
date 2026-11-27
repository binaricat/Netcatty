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
 * are never released, but new ones stay on DOM when visible holders fill the
 * cap. Recently hidden holders may temporarily exceed the cap during tab flips.
 * A released pane can rebuild when shown if the budget permits.
 */

export const MAX_ACTIVE_WEBGL_CONTEXTS = 12;

/**
 * Same window as the CSS-only tab reveal in useTerminalEffects, so quickly
 * flipping between tabs never tears down and rebuilds a renderer.
 */
export const MIN_HIDDEN_MS_BEFORE_WEBGL_RELEASE = 3_000;

/**
 * Keep at most one most-recently-hidden terminal WebGL context warm so rapid
 * Ctrl-Tab / back-and-forth switches stay instant while older hidden tabs
 * release their GPU surfaces and glyph atlases after the idle grace window.
 */
export const MAX_HIDDEN_WEBGL_CONTEXTS = 1;
export const HIDDEN_WEBGL_IDLE_RELEASE_MS = 15_000;

export interface WebglContextBudgetMember {
  /** When the pane was hidden, or null while it is on screen. */
  getHiddenSince(): number | null;
  /** Drop the member's WebGL renderer. Must not acquire a context again. */
  release(): void;
}

export interface WebglContextBudget {
  /**
   * Reserve a context if the budget has room. Visible members may replace
   * hidden holders, allowing a temporary overshoot until their grace expires.
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
  /** Optional cap on retained hidden contexts (oldest released after hiddenIdleReleaseMs). */
  maxHiddenContexts?: number;
  hiddenIdleReleaseMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createWebglContextBudget(
  options: WebglContextBudgetOptions = {},
): WebglContextBudget {
  const maxActive = options.maxActiveContexts ?? MAX_ACTIVE_WEBGL_CONTEXTS;
  const minHiddenMs = options.minHiddenMs ?? MIN_HIDDEN_MS_BEFORE_WEBGL_RELEASE;
  const maxHidden = options.maxHiddenContexts ?? Number.POSITIVE_INFINITY;
  const hiddenIdleMs = options.hiddenIdleReleaseMs ?? HIDDEN_WEBGL_IDLE_RELEASE_MS;
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
    const time = now();
    const hiddenMembers: Array<{ member: WebglContextBudgetMember; hiddenSince: number }> = [];
    for (const member of active) {
      const hiddenSince = member.getHiddenSince();
      if (hiddenSince !== null) hiddenMembers.push({ member, hiddenSince });
    }
    if (hiddenMembers.length === 0) return;
    hiddenMembers.sort((a, b) => a.hiddenSince - b.hiddenSince);

    let nextReleasableAt = Number.POSITIVE_INFINITY;

    // 1. Enforce total active cap (uses shorter minHiddenMs grace).
    if (active.size > maxActive) {
      for (const entry of hiddenMembers) {
        if (active.size <= maxActive) break;
        const releasableAt = entry.hiddenSince + minHiddenMs;
        if (releasableAt <= time) {
          active.delete(entry.member);
          entry.member.release();
        } else {
          nextReleasableAt = Math.min(nextReleasableAt, releasableAt);
        }
      }
    }

    // 2. Enforce idle hidden cap (keeps newest `maxHidden` MRU hidden tabs warm
    // and releases older hidden tabs once they stay hidden for `hiddenIdleMs`).
    if (Number.isFinite(maxHidden)) {
      const remainingHidden = hiddenMembers.filter((entry) => active.has(entry.member));
      const excessHidden = remainingHidden.length - maxHidden;
      for (let i = 0; i < excessHidden; i += 1) {
        const entry = remainingHidden[i];
        const releasableAt = entry.hiddenSince + hiddenIdleMs;
        if (releasableAt <= time) {
          active.delete(entry.member);
          entry.member.release();
        } else {
          nextReleasableAt = Math.min(nextReleasableAt, releasableAt);
        }
      }
    }

    if (Number.isFinite(nextReleasableAt)) {
      scheduleCheck(nextReleasableAt);
    }
  };

  return {
    tryAcquire(member) {
      if (active.has(member)) return true;
      if (active.size >= maxActive) {
        if (member.getHiddenSince() !== null) return false;
        const visibleCount = [...active].filter((holder) => holder.getHiddenSince() === null).length;
        if (visibleCount >= maxActive) return false;
      }
      active.add(member);
      releaseOverflow();
      return true;
    },
    forget(member) {
      active.delete(member);
    },
    noteHidden(member) {
      if (!active.has(member)) return;
      const hiddenSince = member.getHiddenSince();
      if (hiddenSince === null) return;
      if (active.size > maxActive) {
        scheduleCheck(hiddenSince + minHiddenMs);
        return;
      }
      if (Number.isFinite(maxHidden)) {
        releaseOverflow();
      }
    },
    getActiveCount: () => active.size,
  };
}

let sharedBudget: WebglContextBudget | null = null;

/** The budget shared by every terminal in this renderer process. */
export function getSharedWebglContextBudget(): WebglContextBudget {
  sharedBudget ??= createWebglContextBudget({
    maxActiveContexts: MAX_ACTIVE_WEBGL_CONTEXTS,
    minHiddenMs: MIN_HIDDEN_MS_BEFORE_WEBGL_RELEASE,
    maxHiddenContexts: MAX_HIDDEN_WEBGL_CONTEXTS,
    hiddenIdleReleaseMs: HIDDEN_WEBGL_IDLE_RELEASE_MS,
  });
  return sharedBudget;
}
