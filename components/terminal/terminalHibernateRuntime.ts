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

type MutableValue<T> = { current: T };

export function applyAuthoritativeHibernateSnapshot(
  refs: {
    snapshot: MutableValue<string>;
    viewportSnapshot: MutableValue<string>;
    scrollbackSnapshot: MutableValue<string>;
    contextSnapshot: MutableValue<string>;
    contextViewportSnapshot: MutableValue<string>;
    contextScrollbackSnapshot: MutableValue<string>;
    pendingBuffer: MutableValue<string>;
    alternateScreen: MutableValue<boolean>;
  },
  snapshot: string,
  context: TerminalHibernateContextSnapshot,
): void {
  refs.snapshot.current = snapshot;
  refs.viewportSnapshot.current = snapshot;
  refs.scrollbackSnapshot.current = "";
  refs.contextSnapshot.current = context.contextSnapshot;
  refs.contextViewportSnapshot.current = context.contextViewportSnapshot;
  refs.contextScrollbackSnapshot.current = context.contextScrollbackSnapshot;
  refs.pendingBuffer.current = "";
  refs.alternateScreen.current = context.alternateScreen;
}

export type TerminalHibernateContextSnapshot = Required<Pick<
  TerminalHibernateSnapshot,
  "contextSnapshot" | "contextViewportSnapshot" | "contextScrollbackSnapshot" | "alternateScreen"
>>;

export function resolveTerminalSnapshotCapture(
  serialized: unknown,
  context: TerminalHibernateContextSnapshot,
): { snapshot: string; context: TerminalHibernateContextSnapshot } {
  if (typeof serialized === "string") return { snapshot: serialized, context };
  const plainText = context.alternateScreen
    ? context.contextViewportSnapshot
    : context.contextSnapshot;
  const replayText = plainText.replace(/\r?\n/g, "\r\n");
  return {
    snapshot: context.alternateScreen
      ? `\x1b[?1049h\x1b[H${replayText}`
      : replayText,
    context,
  };
}

function isEmptyTerminalContext(text: string): boolean {
  return text.split("\n").every((line) => line.length === 0);
}

export function readTerminalHibernateContext(
  term: XTerm,
): TerminalHibernateContextSnapshot {
  const rows = Math.max(1, term.rows);
  const bufferLength = resolveActiveBufferLength(term);

  if (isTerminalAlternateScreenActive(term)) {
    const contextViewportSnapshot = readActiveTerminalBufferTextRange(term, {
      startLine: 0,
      endLine: Math.max(0, rows - 1),
    });
    const empty = isEmptyTerminalContext(contextViewportSnapshot);
    return {
      contextSnapshot: empty ? "" : contextViewportSnapshot,
      contextViewportSnapshot: empty ? "" : contextViewportSnapshot,
      contextScrollbackSnapshot: "",
      alternateScreen: true,
    };
  }

  const activeBuffer = term.buffer.active as typeof term.buffer.active & { viewportY?: number };
  const bottomViewportStart = Math.max(0, bufferLength - rows);
  const viewportStart = Math.min(
    bottomViewportStart,
    Math.max(0, activeBuffer.viewportY ?? bottomViewportStart),
  );
  const viewportEnd = bufferLength > 0
    ? Math.min(bufferLength - 1, viewportStart + rows - 1)
    : -1;
  const contextViewportSnapshot = readActiveTerminalBufferTextRange(term, {
    startLine: viewportStart,
    endLine: viewportEnd,
  });
  const contextStart = Math.min(
    viewportStart,
    Math.max(0, bufferLength - TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES),
  );
  const contextEnd = bufferLength > 0
    ? Math.min(
      bufferLength - 1,
      Math.max(viewportEnd, contextStart + TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES - 1),
    )
    : -1;
  const contextScrollbackSnapshot = viewportStart > 0
    ? readActiveTerminalBufferTextRange(term, {
      startLine: contextStart,
      endLine: viewportStart - 1,
    })
    : "";
  const contextSnapshot = readActiveTerminalBufferTextRange(term, {
    startLine: contextStart,
    endLine: contextEnd,
  });
  if (isEmptyTerminalContext(contextSnapshot)) {
    return {
      contextSnapshot: "",
      contextViewportSnapshot: "",
      contextScrollbackSnapshot: "",
      alternateScreen: false,
    };
  }
  return {
    contextSnapshot,
    contextViewportSnapshot,
    contextScrollbackSnapshot,
    alternateScreen: false,
  };
}

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
  let context: TerminalHibernateContextSnapshot = {
    contextSnapshot: "",
    contextViewportSnapshot: "",
    contextScrollbackSnapshot: "",
    alternateScreen,
  };
  try {
    context = readTerminalHibernateContext(term);
  } catch {
    // A transient buffer read failure must not prevent visual snapshot capture.
  }

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
      return {
        snapshot: viewportSnapshot,
        viewportSnapshot,
        scrollbackSnapshot: "",
        ...context,
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
    let scrollbackSnapshot = "";
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
      ...context,
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
