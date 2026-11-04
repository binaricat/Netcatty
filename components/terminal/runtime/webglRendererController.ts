import type { WebglContextBudget, WebglContextBudgetMember } from "./webglContextBudget";

export interface WebglRendererAddon {
  onContextLoss(callback: () => void): unknown;
  dispose(): void;
}

export interface WebglRendererController<TAddon extends WebglRendererAddon> {
  ensure(): void;
  suspend(): void;
  dispose(): void;
  getAddon(): TAddon | null;
  /**
   * Re-read isVisible() after the pane is shown or hidden. Hidden panes do not
   * rebuild a lost renderer and can give theirs up to the context budget; the
   * reveal path's ensure() brings it back.
   */
  syncVisibility(): void;
}

interface WebglRendererControllerOptions<TAddon extends WebglRendererAddon> {
  enabled: boolean;
  createAddon: () => TAddon;
  loadAddon: (addon: TAddon) => void;
  repaint: () => void;
  setLoaded: (loaded: boolean) => void;
  warn: (message: string, error?: unknown) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  recoveryDelayMs?: number;
  recoveryWindowMs?: number;
  maxRecoveriesPerWindow?: number;
  /** Shared cap on live WebGL contexts. Omit to create renderers freely. */
  budget?: WebglContextBudget;
  /** Live pane visibility. Omit to treat the pane as always on screen. */
  isVisible?: () => boolean;
  /** Tear a renderer down. Defaults to addon.dispose(). */
  disposeAddon?: (addon: TAddon) => void;
}

/** Owns WebGL addon recovery without depending on xterm or browser globals. */
export function createWebglRendererController<TAddon extends WebglRendererAddon>(
  options: WebglRendererControllerOptions<TAddon>,
): WebglRendererController<TAddon> {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const recoveryDelayMs = options.recoveryDelayMs ?? 50;
  // Keep a wide enough window that periodic GPU context loss (commonly ~15s on
  // some Linux drivers/compositors) still accumulates and trips the breaker.
  // A 10s window aged those losses out, so WebGL kept dispose -> rebuild flashing.
  const recoveryWindowMs = options.recoveryWindowMs ?? 60_000;
  const maxRecoveriesPerWindow = options.maxRecoveriesPerWindow ?? 2;
  const contextLosses: number[] = [];
  let addon: TAddon | null = null;
  let loaded = false;
  let circuitBroken = false;
  let disposed = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenSince: number | null = null;
  const budget = options.budget;
  const disposeAddon = options.disposeAddon ?? ((target: TAddon) => target.dispose());

  // isVisible() is the source of truth; hiddenSince only remembers when the
  // pane was last seen. Re-reading it at every decision keeps a pane that is
  // on screen from being refused or released even if a sync was missed.
  const readVisibility = () => {
    if (!options.isVisible) return;
    if (options.isVisible()) hiddenSince = null;
    else hiddenSince ??= now();
  };
  readVisibility();

  const budgetMember: WebglContextBudgetMember = {
    getHiddenSince: () => {
      readVisibility();
      return hiddenSince;
    },
    release: () => suspend(),
  };

  const publishLoaded = (value: boolean) => {
    loaded = value;
    options.setLoaded(value);
  };

  const cancelRecovery = () => {
    if (recoveryTimer === null) return;
    clearTimer(recoveryTimer);
    recoveryTimer = null;
  };

  const ensure = () => {
    if (loaded || circuitBroken || disposed || !options.enabled) return;
    // A hidden pane past the budget keeps the DOM renderer until it is shown.
    if (budget && !budget.tryAcquire(budgetMember)) return;
    let nextAddon: TAddon | null = null;
    try {
      nextAddon = options.createAddon();
      const ownedAddon = nextAddon;
      ownedAddon.onContextLoss(() => {
        if (addon !== ownedAddon || disposed) return;
        readVisibility();
        const lostWhileHidden = hiddenSince !== null;
        options.warn(lostWhileHidden
          ? "[XTerm] WebGL context lost while hidden, rebuilding when shown"
          : "[XTerm] WebGL context loss detected, rebuilding renderer");
        try {
          disposeAddon(ownedAddon);
        } catch (error) {
          options.warn("[XTerm] Failed to dispose lost WebGL renderer", error);
        }
        addon = null;
        budget?.forget(budgetMember);
        publishLoaded(false);
        options.repaint();

        // A hidden pane draws nothing, so its rebuild waits for the reveal
        // path's ensure(). Rebuilding right away is what turned Chromium's
        // context cap into a loop: each new context evicted another hidden
        // one. Chromium evicts contexts that have not drawn lately, so these
        // losses say nothing about the driver and skip the breaker.
        if (lostWhileHidden) {
          cancelRecovery();
          return;
        }

        const lossTime = now();
        while (contextLosses.length > 0 && lossTime - contextLosses[0] > recoveryWindowMs) {
          contextLosses.shift();
        }
        contextLosses.push(lossTime);
        if (contextLosses.length > maxRecoveriesPerWindow) {
          circuitBroken = true;
          cancelRecovery();
          options.warn("[XTerm] Repeated WebGL context loss, staying on DOM renderer");
          return;
        }

        cancelRecovery();
        recoveryTimer = setTimer(() => {
          recoveryTimer = null;
          readVisibility();
          if (disposed || hiddenSince !== null) return;
          ensure();
          options.repaint();
        }, recoveryDelayMs);
      });
      addon = ownedAddon;
      options.loadAddon(ownedAddon);
      publishLoaded(true);
    } catch (error) {
      try {
        if (nextAddon) disposeAddon(nextAddon);
      } catch {
        // Preserve the original load failure.
      }
      if (addon === nextAddon) addon = null;
      budget?.forget(budgetMember);
      publishLoaded(false);
      options.warn(
        "[XTerm] WebGL addon failed, using DOM renderer. Error:",
        error instanceof Error ? error.message : error,
      );
    }
  };

  const suspend = () => {
    cancelRecovery();
    const currentAddon = addon;
    addon = null;
    budget?.forget(budgetMember);
    publishLoaded(false);
    if (!currentAddon) return;
    try {
      disposeAddon(currentAddon);
    } catch (error) {
      options.warn("[XTerm] Failed to suspend WebGL renderer", error);
    }
  };

  const syncVisibility = () => {
    if (disposed) return;
    const wasHidden = hiddenSince !== null;
    readVisibility();
    if (!wasHidden && hiddenSince !== null && addon) budget?.noteHidden(budgetMember);
  };

  return {
    ensure,
    suspend,
    dispose: () => {
      disposed = true;
      cancelRecovery();
      const currentAddon = addon;
      addon = null;
      budget?.forget(budgetMember);
      publishLoaded(false);
      try {
        if (currentAddon) disposeAddon(currentAddon);
      } catch (error) {
        options.warn("[XTerm] webglAddon dispose failed", error);
      }
    },
    getAddon: () => addon,
    syncVisibility,
  };
}
