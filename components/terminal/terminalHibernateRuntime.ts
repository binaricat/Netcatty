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
  compressedSnapshot?: Uint8Array | null;
  viewportSnapshot: string;
  scrollbackSnapshot: string;
  contextSnapshot?: string;
  contextViewportSnapshot?: string;
  contextScrollbackSnapshot?: string;
  alternateScreen: boolean;
};

const HIBERNATE_COMPRESS_MIN_CHARS = 4_096;

export async function compressHibernateSnapshot(text: string): Promise<Uint8Array | null> {
  if (
    !text
    || text.length < HIBERNATE_COMPRESS_MIN_CHARS
    || typeof CompressionStream === "undefined"
  ) {
    return null;
  }
  try {
    const encoded = new TextEncoder().encode(text);
    const stream = new Blob([encoded]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null;
  }
}

export async function decompressHibernateSnapshot(data: Uint8Array): Promise<string> {
  if (!data || data.byteLength === 0 || typeof DecompressionStream === "undefined") {
    return "";
  }
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buffer);
  } catch {
    return "";
  }
}

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
  options: { preferWasm?: boolean; prepare?: () => Promise<void> } = {},
): Promise<TerminalHibernateSnapshot> {
  await options.prepare?.();
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

    const snapshot = capHibernateBufferByLines(
      await serializeWithOptions(term, serializeAddon, {
        excludeAltBuffer,
        excludeModes,
      }, preferWasm),
      TERMINAL_HIBERNATE_SNAPSHOT_MAX_LINES,
    );

    // Avoid serializing and retaining a duplicate copy of the entire scrollback
    // when the coherent full snapshot already succeeded. Only fall back to a
    // ranged scrollback slice when full serialization returned empty.
    let scrollbackSnapshot = "";
    if (!snapshot && viewportStart > 0) {
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

    const compressedSnapshot = await compressHibernateSnapshot(snapshot);

    return {
      snapshot,
      compressedSnapshot,
      viewportSnapshot,
      scrollbackSnapshot,
      ...context,
      alternateScreen: false,
    };
  } catch {
    return {
      snapshot: "",
      compressedSnapshot: null,
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

/**
 * Resolve the pre-pending history bytes to replay on hibernate wake.
 * Prefer the coherent full snapshot: SerializeAddon range slices omit a
 * trailing newline at the boundary, so concatenating scrollback+viewport can
 * merge the seam lines. Fall back to scrollback -> viewport when snapshot is
 * empty (still never viewport-first -- that evicts newest rows under a finite
 * scrollback cap; #2762).
 */
export function resolveHibernateWakeHistory(payload: TerminalHibernateWakePayload): string {
  if (payload.snapshot) return payload.snapshot;
  const viewport = payload.viewportSnapshot ?? "";
  const scrollback = payload.scrollbackSnapshot ?? "";
  if (!scrollback) return viewport;
  if (!viewport) return scrollback;
  if (/\r?\n$/.test(scrollback)) return `${scrollback}${viewport}`;
  return `${scrollback}\r\n${viewport}`;
}

export async function resolveHibernateWakeHistoryAsync(
  payload: TerminalHibernateWakePayload,
): Promise<string> {
  if (payload.snapshot) return payload.snapshot;
  if (payload.compressedSnapshot && payload.compressedSnapshot.byteLength > 0) {
    const decompressed = await decompressHibernateSnapshot(payload.compressedSnapshot);
    if (decompressed) return decompressed;
  }
  return resolveHibernateWakeHistory(payload);
}

export async function applyHibernateWakeToTerminal(
  term: XTerm,
  runtime: XTermRuntime,
  payload: TerminalHibernateWakePayload,
  options: ApplyHibernateWakeOptions = {},
): Promise<void> {
  const replayOptions = options.replayOptions;
  const history = await resolveHibernateWakeHistoryAsync(payload);

  // Chunked writes already yield to the event loop for large buffers. Do not
  // idle-append older scrollback after the viewport: under a finite xterm
  // scrollback cap that trims the just-restored newest rows (#2762).
  await writeTerminalReplaySequence(
    term,
    [history, payload.pendingBuffer],
    replayOptions,
  );

  if (!options.deferWebgl) {
    runtime.ensureWebglRenderer();
    runtime.clearTextureAtlas();
  }

  if (payload.alternateScreen) {
    refreshTerminalViewport(term);
  }
}

export function nudgeAlternateScreenRedraw(term: XTerm): void {
  // A same-size resize does not notify the PTY, but xterm still synchronously
  // drains its private parser buffer before returning. During a large TUI frame
  // that can interrupt the normal write callback and strand renderer flow.
  // Public refresh is sufficient to repaint the already-parsed viewport.
  refreshTerminalViewport(term);
}

export function buildHibernateWakePayload(
  snapshot: TerminalHibernateSnapshot,
  pendingBuffer: string,
): TerminalHibernateWakePayload {
  return {
    snapshot: snapshot.snapshot,
    compressedSnapshot: snapshot.compressedSnapshot ?? null,
    viewportSnapshot: snapshot.viewportSnapshot,
    scrollbackSnapshot: snapshot.scrollbackSnapshot,
    pendingBuffer,
    alternateScreen: snapshot.alternateScreen,
  };
}
