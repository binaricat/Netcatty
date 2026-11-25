import type { MutableRefObject } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/xterm";

import { logger } from "../../lib/logger";
import type { TerminalHibernateWakePayload } from "../../domain/terminalHibernate";
import {
  createXTermRuntime,
  type CreateXTermRuntimeContext,
  type XTermRuntime,
} from "./runtime/createXTermRuntime";
import {
  appendTerminalReplayData,
  applyHibernateWakeToTerminal,
  nudgeAlternateScreenRedraw,
} from "./terminalHibernateRuntime";
import {
  applyTerminalKeywordHighlightRules,
  type AdditionalTerminalKeywordHighlightRule,
} from "./terminalKeywordHighlightRules";

export { applyTerminalKeywordHighlightRules } from "./terminalKeywordHighlightRules";

export type TerminalRuntimeRefs = {
  xtermRuntimeRef: MutableRefObject<XTermRuntime | null>;
  termRef: MutableRefObject<XTerm | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  searchAddonRef: MutableRefObject<SearchAddon | null>;
  hasRuntimeRef: MutableRefObject<boolean>;
};

export function assignTerminalRuntimeRefs(
  refs: TerminalRuntimeRefs,
  runtime: XTermRuntime,
): void {
  refs.xtermRuntimeRef.current = runtime;
  refs.termRef.current = runtime.term;
  refs.fitAddonRef.current = runtime.fitAddon;
  refs.serializeAddonRef.current = runtime.serializeAddon;
  refs.searchAddonRef.current = runtime.searchAddon;
  refs.hasRuntimeRef.current = true;
}

export type WakeTerminalFromHibernateOptions = {
  refs: TerminalRuntimeRefs;
  runtimeContext: Omit<CreateXTermRuntimeContext, "container" | "initiallyVisible" | "deferWebglUntilReplayComplete">;
  container: HTMLDivElement;
  getPayload: () => TerminalHibernateWakePayload;
  /**
   * Pause backend output and wait for in-flight chunks to drain into the
   * hibernate pending buffer before history replay. Returns true when the
   * drain succeeded (safe to detach the data listener). Returns false when
   * pause/drain was best-effort only; caller must keep a live uncapped
   * pending listener through history replay (#2762).
   */
  prepareWakeFlow?: () => Promise<boolean>;
  /**
   * Atomically read and clear hibernate pending output after the data listener
   * has been stopped (and preferably after prepareWakeFlow).
   */
  takePendingBuffer: () => string;
  /** Stop only the hibernate data listener so pending stops growing. */
  stopHibernateDataListener: () => void;
  /**
   * When prepareWakeFlow returns false, disable the 512 KiB pending cap so
   * ACKed bytes that arrive during history replay are not trimmed.
   */
  setHibernatePendingCapDisabled?: (disabled: boolean) => void;
  /**
   * Stop hibernate data+exit listeners and clear flow-ack state.
   * Must keep the backend paused until resumeAfterReattach runs.
   */
  stopHibernateListeners: () => void;
  /**
   * On a thrown/failed wake: dispose the partial xterm runtime and restore
   * hibernate listeners so output is ACKed again (never unpause without a
   * listener). `takenPending` is every byte already take-and-cleared during
   * this wake attempt; it must be restored because those bytes no longer
   * live in the pending ref and the partial xterm is disposed.
   */
  restoreAfterFailedWake?: (takenPending: string) => void;
  /** Resume backend output after the live display listener is attached. */
  resumeAfterReattach?: () => void;
  reattachSession: (term: XTerm) => void;
  safeFit: (options?: { force?: boolean; requireVisible?: boolean }) => void;
  resizeSession: () => void;
  forceSyncRenderAfterResize: (term: XTerm) => void;
  lastFittedSizeRef: MutableRefObject<{ width: number; height: number; dpr?: number } | null>;
  isBootActiveRef: MutableRefObject<boolean>;
  sessionId: string;
  updateStatus: (status: "connected") => void;
  /** When false, recreate xterm and replay output without reattaching or forcing connected status. */
  sessionConnected?: boolean;
  getSessionConnected?: () => boolean;
  replayChunkBytes?: number;
  additionalKeywordHighlightRules?: readonly AdditionalTerminalKeywordHighlightRule[];
};

export async function wakeTerminalFromHibernate(
  options: WakeTerminalFromHibernateOptions,
): Promise<boolean> {
  const {
    refs,
    runtimeContext,
    container,
    getPayload,
    prepareWakeFlow,
    takePendingBuffer,
    stopHibernateDataListener,
    setHibernatePendingCapDisabled,
    stopHibernateListeners,
    restoreAfterFailedWake,
    resumeAfterReattach,
    reattachSession,
    safeFit,
    resizeSession,
    forceSyncRenderAfterResize,
    lastFittedSizeRef,
    isBootActiveRef,
    sessionId,
    updateStatus,
    sessionConnected = true,
    getSessionConnected,
    replayChunkBytes = 16 * 1024,
    additionalKeywordHighlightRules = Object.freeze([]),
  } = options;

  if (refs.hasRuntimeRef.current) {
    return true;
  }

  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return;
    }
    window.setTimeout(resolve, 0);
  });

  isBootActiveRef.current = true;
  lastFittedSizeRef.current = null;

  const runtime = createXTermRuntime({
    ...runtimeContext,
    container,
    initiallyVisible: true,
    deferWebglUntilReplayComplete: true,
  });

  assignTerminalRuntimeRefs(refs, runtime);
  applyTerminalKeywordHighlightRules(
    runtime,
    runtimeContext.terminalSettingsRef,
    runtimeContext.host,
    additionalKeywordHighlightRules,
  );

  const term = runtime.term;
  // Pause first so in-flight output drains into pending via the still-live
  // hibernate listener, then detach that listener before capturing pending.
  // Full-history replay can take many frames; leaving the capped pending
  // buffer open (or leaving no display listener while flow is live) drops
  // ACKed bytes under sustained `cat` output (#2762).
  let didReattach = false;
  let wakeSucceeded = false;
  // Bytes take-and-cleared from the pending ref during this wake. On failure
  // they must be handed back: the partial xterm is disposed and the ref no
  // longer holds them.
  let takenPendingForRestore = "";
  const takeAndTrackPending = (): string => {
    const pending = takePendingBuffer();
    if (pending) takenPendingForRestore += pending;
    return pending;
  };
  try {
    const drainOk = (await prepareWakeFlow?.()) ?? true;
    if (drainOk) {
      stopHibernateDataListener();
    } else {
      // Drain timed out / unavailable: keep the hibernate data listener so
      // in-flight ACKed bytes still land in pending, but disable the 512 KiB
      // cap for the wake window so a busy `cat` cannot trim the front.
      setHibernatePendingCapDisabled?.(true);
    }
    const initialPayload = getPayload();
    const pendingAtApplyStart = takeAndTrackPending();
    const replayOptions = { chunkBytes: replayChunkBytes };
    let replayedPendingChars = pendingAtApplyStart.length;

    await applyHibernateWakeToTerminal(term, runtime, {
      ...initialPayload,
      pendingBuffer: pendingAtApplyStart,
    }, {
      replayOptions,
      deferWebgl: true,
    });
    runtime.cursorLineHighlighter.refresh({ force: true });

    // Stop the data listener before draining residual pending. Captures:
    // - exit "[session closed]" tails appended during history replay
    // - uncapped live arrivals when drainOk was false
    // Only the exit listener can still append after this point, so a short
    // until-empty loop is enough; the last take before teardown must be empty
    // after any awaited replay.
    stopHibernateDataListener();
    setHibernatePendingCapDisabled?.(false);
    for (;;) {
      const pendingTail = takeAndTrackPending();
      if (!pendingTail) break;
      await appendTerminalReplayData(term, pendingTail, replayOptions);
      replayedPendingChars += pendingTail.length;
    }

    // Recompute after drains so an exit during those awaits cannot leave
    // shouldReattach stale (would reattach a dead session as connected).
    const shouldReattach = sessionConnected && (getSessionConnected?.() ?? true);
    stopHibernateListeners();
    if (shouldReattach) {
      reattachSession(term);
      updateStatus("connected");
      didReattach = true;
    }

    runtime.ensureWebglRenderer();
    runtime.clearTextureAtlas();

    safeFit({ force: true });
    resizeSession();
    forceSyncRenderAfterResize(term);
    if (initialPayload.alternateScreen) {
      nudgeAlternateScreenRedraw(term);
    } else {
      term.scrollToBottom();
    }

    window.setTimeout(() => safeFit({ force: true }), 0);
    window.setTimeout(() => {
      safeFit({ force: true });
      forceSyncRenderAfterResize(term);
      if (initialPayload.alternateScreen) {
        nudgeAlternateScreenRedraw(term);
      }
    }, 100);
    window.setTimeout(() => {
      safeFit({ force: true });
      forceSyncRenderAfterResize(term);
      if (initialPayload.alternateScreen) {
        nudgeAlternateScreenRedraw(term);
      }
    }, 350);

    logger.info("[Terminal] Resumed from hibernate", {
      sessionId,
      snapshotChars: initialPayload.snapshot.length,
      viewportChars: initialPayload.viewportSnapshot?.length ?? initialPayload.snapshot.length,
      scrollbackChars: initialPayload.scrollbackSnapshot?.length ?? 0,
      pendingChars: replayedPendingChars,
      alternateScreen: initialPayload.alternateScreen,
    });
    wakeSucceeded = true;
    return true;
  } finally {
    setHibernatePendingCapDisabled?.(false);
    if (!wakeSucceeded) {
      // Dispose the partial runtime and restore hibernate listeners so a
      // failed wake never unpauses into a listener-less backlog gap, and so a
      // retry can re-enter wake (hasRuntimeRef stays false). Hand back every
      // take-and-cleared pending byte so it is not lost with the disposed term.
      restoreAfterFailedWake?.(takenPendingForRestore);
    } else if (didReattach) {
      resumeAfterReattach?.();
    }
    // Successful reconnect wakes (!didReattach) keep the pause until cleanupSession.
  }
}
