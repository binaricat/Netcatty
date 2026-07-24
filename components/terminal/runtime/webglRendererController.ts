export interface WebglRendererAddon {
  onContextLoss(callback: () => void): unknown;
  dispose(): void;
}

export interface WebglRendererController<TAddon extends WebglRendererAddon> {
  ensure(): void;
  suspend(): void;
  dispose(): void;
  getAddon(): TAddon | null;
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
}

/** Owns WebGL addon recovery without depending on xterm or browser globals. */
export function createWebglRendererController<TAddon extends WebglRendererAddon>(
  options: WebglRendererControllerOptions<TAddon>,
): WebglRendererController<TAddon> {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
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
    let nextAddon: TAddon | null = null;
    try {
      nextAddon = options.createAddon();
      const ownedAddon = nextAddon;
      ownedAddon.onContextLoss(() => {
        if (addon !== ownedAddon || disposed) return;
        options.warn("[XTerm] WebGL context loss detected, rebuilding renderer");
        try {
          ownedAddon.dispose();
        } catch (error) {
          options.warn("[XTerm] Failed to dispose lost WebGL renderer", error);
        }
        addon = null;
        publishLoaded(false);
        options.repaint();

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
          if (disposed) return;
          ensure();
          options.repaint();
        }, recoveryDelayMs);
      });
      addon = ownedAddon;
      options.loadAddon(ownedAddon);
      publishLoaded(true);
    } catch (error) {
      try {
        nextAddon?.dispose();
      } catch {
        // Preserve the original load failure.
      }
      if (addon === nextAddon) addon = null;
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
    publishLoaded(false);
    if (!currentAddon) return;
    try {
      currentAddon.dispose();
    } catch (error) {
      options.warn("[XTerm] Failed to suspend WebGL renderer", error);
    }
  };

  return {
    ensure,
    suspend,
    dispose: () => {
      disposed = true;
      cancelRecovery();
      const currentAddon = addon;
      addon = null;
      publishLoaded(false);
      try {
        currentAddon?.dispose();
      } catch (error) {
        options.warn("[XTerm] webglAddon dispose failed", error);
      }
    },
    getAddon: () => addon,
  };
}
