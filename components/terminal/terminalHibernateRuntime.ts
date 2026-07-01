import type { Terminal as XTerm } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

import {
  capHibernateBuffer,
  capHibernateBufferByLines,
  TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES,
  type TerminalHibernateWakePayload,
} from "../../domain/terminalHibernate";
import type { XTermRuntime } from "./runtime/createXTermRuntime";
import { readActiveTerminalBufferTextRange } from "./terminalContextBuffer";
import { serializeTerminalBuffer } from "./terminalSerialize";
import {
  writeTerminalPayloadChunked,
  writeTerminalReplaySequence,
  type TerminalReplayOptions,
} from "./terminalReplay";

export function isTerminalAlternateScreenActive(term: XTerm): boolean {
  return (term.buffer.active as { type?: string }).type === "alternate";
}

export function resolveHibernateSerializeOptions(term: XTerm): {
  excludeAltBuffer: boolean;
  excludeModes: boolean;
  alternateScreen: boolean;
} {
  const alternateScreen = isTerminalAlternateScreenActive(term);
  return {
    excludeAltBuffer: !alternateScreen,
    excludeModes: !alternateScreen,
    alternateScreen,
  };
}

export type TerminalHibernateSnapshot = {
  snapshot: string;
  viewportSnapshot: string;
  scrollbackSnapshot: string;
  contextSnapshot?: string;
  contextViewportSnapshot?: string;
  contextScrollbackSnapshot?: string;
  alternateScreen: boolean;
};

function resolveActiveBufferLength(term: XTerm): number {
  return term.buffer.active.length;
}

async function serializeWithOptions(
  term: XTerm,
  serializeAddon: SerializeAddon,
  options: Record<string, unknown>,
  preferWasm: boolean,
): Promise<string> {
  try {
    return await serializeTerminalBuffer({
      term,
      serializeAddon,
      options,
      preferWasm,
    });
  } catch {
    return "";
  }
}

export async function serializeTerminalForHibernate(
  term: XTerm,
  serializeAddon: SerializeAddon,
  options: { preferWasm?: boolean } = {},
): Promise<TerminalHibernateSnapshot> {
  const { excludeAltBuffer, excludeModes, alternateScreen } = resolveHibernateSerializeOptions(term);
  const preferWasm = options.preferWasm === true;
  const rows = Math.max(1, term.rows);
  const bufferLength = resolveActiveBufferLength(term);

  try {
    if (alternateScreen) {
      const endRow = Math.max(0, rows - 1);
      const viewportSnapshot = capHibernateBufferByLines(
        await serializeWithOptions(term, serializeAddon, {
          excludeAltBuffer: false,
          excludeModes: false,
          range: { start: 0, end: endRow },
        }, preferWasm),
        rows,
      );
      const contextViewportSnapshot = readActiveTerminalBufferTextRange(term, {
        startLine: 0,
        endLine: endRow,
      });
      return {
        snapshot: viewportSnapshot,
        viewportSnapshot,
        scrollbackSnapshot: "",
        contextSnapshot: contextViewportSnapshot,
        contextViewportSnapshot,
        contextScrollbackSnapshot: "",
        alternateScreen: true,
      };
    }

    const viewportStart = Math.max(0, bufferLength - rows);
    const viewportEnd = Math.max(0, bufferLength - 1);
    const viewportSnapshot = await serializeWithOptions(term, serializeAddon, {
      excludeAltBuffer,
      excludeModes,
      range: { start: viewportStart, end: viewportEnd },
    }, preferWasm);
    const contextViewportSnapshot = readActiveTerminalBufferTextRange(term, {
      startLine: viewportStart,
      endLine: viewportEnd,
    });

    let scrollbackSnapshot = "";
    let contextScrollbackSnapshot = "";
    if (viewportStart > 0) {
      const scrollbackStart = Math.max(0, viewportStart - TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES);
      scrollbackSnapshot = capHibernateBufferByLines(
        await serializeWithOptions(term, serializeAddon, {
          excludeAltBuffer,
          excludeModes,
          range: { start: scrollbackStart, end: viewportStart - 1 },
        }, preferWasm),
        TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES,
      );
      contextScrollbackSnapshot = readActiveTerminalBufferTextRange(term, {
        startLine: scrollbackStart,
        endLine: viewportStart - 1,
      });
    }

    const snapshot = capHibernateBufferByLines(
      await serializeWithOptions(term, serializeAddon, {
        excludeAltBuffer,
        excludeModes,
      }, preferWasm),
      TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES,
    );

    return {
      snapshot,
      viewportSnapshot,
      scrollbackSnapshot,
      contextSnapshot: [contextScrollbackSnapshot, contextViewportSnapshot].filter(Boolean).join("\n"),
      contextViewportSnapshot,
      contextScrollbackSnapshot,
      alternateScreen: false,
    };
  } catch {
    return {
      snapshot: "",
      viewportSnapshot: "",
      scrollbackSnapshot: "",
      alternateScreen: isTerminalAlternateScreenActive(term),
    };
  }
}

export function appendHibernatePendingBuffer(current: string, chunk: string): string {
  return capHibernateBuffer(current + chunk);
}

export function refreshTerminalViewport(term: XTerm): void {
  const endRow = term.rows - 1;
  if (endRow < 0) return;
  term.refresh(0, endRow);
}

export async function appendTerminalReplayData(
  term: XTerm,
  data: string,
  replayOptions?: TerminalReplayOptions,
): Promise<void> {
  return writeTerminalPayloadChunked(term, data, replayOptions);
}

export type ApplyHibernateWakeOptions = {
  replayOptions?: TerminalReplayOptions;
  deferWebgl?: boolean;
};

const scheduleIdle = (callback: () => void): void => {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => callback(), { timeout: 500 });
    return;
  }
  setTimeout(callback, 0);
};

export async function applyHibernateWakeToTerminal(
  term: XTerm,
  runtime: XTermRuntime,
  payload: TerminalHibernateWakePayload,
  options: ApplyHibernateWakeOptions = {},
): Promise<void> {
  const replayOptions = options.replayOptions;
  const viewport = payload.viewportSnapshot ?? payload.snapshot;
  const scrollback = payload.scrollbackSnapshot ?? "";

  await writeTerminalReplaySequence(term, [viewport, payload.pendingBuffer], replayOptions);

  if (!options.deferWebgl) {
    runtime.ensureWebglRenderer();
    runtime.clearTextureAtlas();
  }

  if (payload.alternateScreen) {
    refreshTerminalViewport(term);
  }

  if (scrollback) {
    scheduleIdle(() => {
      void writeTerminalPayloadChunked(term, scrollback, replayOptions);
    });
  }
}

export function nudgeAlternateScreenRedraw(term: XTerm): void {
  refreshTerminalViewport(term);
  const cols = term.cols;
  const rows = term.rows;
  if (cols > 0 && rows > 0) {
    // Many full-screen TUIs (htop, vim) repaint on a size "change" even when dimensions match.
    term.resize(cols, rows);
    refreshTerminalViewport(term);
  }
}

export function buildHibernateWakePayload(
  snapshot: TerminalHibernateSnapshot,
  pendingBuffer: string,
): TerminalHibernateWakePayload {
  return {
    snapshot: snapshot.snapshot,
    viewportSnapshot: snapshot.viewportSnapshot,
    scrollbackSnapshot: snapshot.scrollbackSnapshot,
    pendingBuffer,
    alternateScreen: snapshot.alternateScreen,
  };
}
