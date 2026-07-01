import type { MutableRefObject, RefObject } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/xterm";

import type { Host, TerminalSettings } from "../../types";
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

export function applyTerminalKeywordHighlightRules(
  runtime: XTermRuntime,
  terminalSettingsRef: RefObject<TerminalSettings | undefined>,
  host: Host,
): void {
  const globalRules = terminalSettingsRef.current?.keywordHighlightRules ?? [];
  const hostRules = host?.keywordHighlightRules ?? [];
  const globalEnabled = terminalSettingsRef.current?.keywordHighlightEnabled ?? false;
  const hostEnabled = host?.keywordHighlightEnabled;
  const effectiveGlobalEnabled = globalEnabled;
  const effectiveHostEnabled = hostEnabled ?? false;
  const mergedRules = [
    ...(effectiveGlobalEnabled ? globalRules : []),
    ...(effectiveHostEnabled ? hostRules : []),
  ];
  const isEnabled = effectiveGlobalEnabled || effectiveHostEnabled;
  runtime.keywordHighlighter.setRules(mergedRules, isEnabled);
}

export type WakeTerminalFromHibernateOptions = {
  refs: TerminalRuntimeRefs;
  runtimeContext: Omit<CreateXTermRuntimeContext, "container" | "initiallyVisible" | "deferWebglUntilReplayComplete">;
  container: HTMLDivElement;
  getPayload: () => TerminalHibernateWakePayload;
  /** Stop hibernate IPC listeners before reading the final replay payload. */
  stopHibernateListeners: () => void;
  reattachSession: (term: XTerm) => void;
  safeFit: (options?: { force?: boolean; requireVisible?: boolean }) => void;
  resizeSession: () => void;
  forceSyncRenderAfterResize: (term: XTerm) => void;
  lastFittedSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  isBootActiveRef: MutableRefObject<boolean>;
  sessionId: string;
  updateStatus: (status: "connected") => void;
  /** When false, recreate xterm and replay output without reattaching or forcing connected status. */
  sessionConnected?: boolean;
  getSessionConnected?: () => boolean;
  replayChunkBytes?: number;
};

export async function wakeTerminalFromHibernate(
  options: WakeTerminalFromHibernateOptions,
): Promise<boolean> {
  const {
    refs,
    runtimeContext,
    container,
    getPayload,
    stopHibernateListeners,
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
  applyTerminalKeywordHighlightRules(runtime, runtimeContext.terminalSettingsRef, runtimeContext.host);

  const term = runtime.term;
  const initialPayload = getPayload();
  const pendingAtApplyStart = initialPayload.pendingBuffer;
  const replayOptions = { chunkBytes: replayChunkBytes };

  await applyHibernateWakeToTerminal(term, runtime, initialPayload, {
    replayOptions,
    deferWebgl: true,
  });

  let replayedPendingLength = pendingAtApplyStart.length;
  for (let drainPass = 0; drainPass < 16; drainPass += 1) {
    const pending = getPayload().pendingBuffer;
    if (pending.length <= replayedPendingLength) break;
    await appendTerminalReplayData(
      term,
      pending.slice(replayedPendingLength),
      replayOptions,
    );
    replayedPendingLength = pending.length;
  }
  const finalPending = getPayload().pendingBuffer;
  if (finalPending.length > replayedPendingLength) {
    await appendTerminalReplayData(
      term,
      finalPending.slice(replayedPendingLength),
      replayOptions,
    );
    replayedPendingLength = finalPending.length;
  }

  stopHibernateListeners();
  const shouldReattach = sessionConnected && (getSessionConnected?.() ?? true);
  if (shouldReattach) {
    reattachSession(term);
    updateStatus("connected");
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
    pendingChars: replayedPendingLength,
    alternateScreen: initialPayload.alternateScreen,
  });
  return true;
}
