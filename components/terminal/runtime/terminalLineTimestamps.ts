import type { Terminal as XTerm } from "@xterm/xterm";

import { shouldSkipTerminalLineTimestamps } from "./terminalOutputPressure";

export type TerminalLineTimestampSegment =
  | { kind: "data"; data: string }
  | { kind: "timestamp"; label: string };

export type TerminalLineTimestampSegmenter = {
  append: (data: string, timestampDate?: Date) => TerminalLineTimestampSegment[];
  reset: () => void;
  flushPendingEscapeSequence: () => string;
  setAlternateScreenActive: (active: boolean) => void;
};

type TerminalLineTimestampSegmenterOptions = {
  now?: () => Date;
  /** Optional label factory (used to intern same-second strings). */
  formatLabel?: (date: Date) => string;
};

type TimestampMarker = {
  line: number;
  isDisposed?: boolean;
  dispose?: () => void;
  onDispose?: (listener: () => void) => { dispose: () => void };
};

type TimestampEntry = {
  marker: TimestampMarker;
  label: string;
  disposeListener?: { dispose: () => void };
};

/**
 * Record/render separation: write path only appends ledger stamps (one per
 * second). Gutter paint maps ledger → visible rows without registerMarker.
 */
type TimestampLedgerEntry = {
  label: string;
  /** Floor(unixMs/1000); at most one ledger stamp per second. */
  secondKey: number;
  /** Absolute buffer line (baseY + cursorY style) at stamp time. */
  line: number;
};

type TimestampStore = {
  segmenter: TerminalLineTimestampSegmenter;
  /**
   * Legacy marker list (unused on the hot path). Kept so old helpers/tests that
   * still touch markers do not crash; production paint reads `ledger` only.
   */
  entries: TimestampEntry[];
  /**
   * Source of truth: per-second stamps with buffer line anchors.
   */
  ledger: TimestampLedgerEntry[];
  /** Last secondKey accepted (one stamp per second). */
  lastStampSecondKey: number | null;
  /** Last observed buffer.baseY for scrollback trim rebasing. */
  lastSeenBaseY: number | null;
  /** @deprecated materialize path removed; always false. */
  ledgerMaterialized: boolean;
  /**
   * Markers dropped from `entries` but not yet disposed. Drained with a per-pass
   * budget so rewrite storms do not O(n²)-freeze on xterm marker list splices.
   */
  orphanedMarkers: TimestampMarker[];
  listeners: Set<() => void>;
  timestampOnlyPrefix: string;
  /** Amortize prune cost across many registerMarker calls. */
  recordsSincePrune: number;
  /** Disposed markers since last compact (drives write-path cleanup). */
  disposedPendingCompact: number;
  /** Intern HH:MM:SS for the current wall-clock second. */
  labelCacheKey: number | null;
  labelCacheValue: string;
  /** Deferred fixed-size marker cleanup, one task at a time. */
  orphanDrainTimer?: ReturnType<typeof setTimeout>;
};

type XTermWithUnicodeService = XTerm & {
  _core?: {
    unicodeService?: {
      wcwidth?: (codePoint: number) => 0 | 1 | 2;
    };
  };
};

export type TerminalTimestampGutterEntry = {
  marker: { line: number; isDisposed?: boolean };
  label: string;
};

export type TerminalTimestampGutterRow = {
  row: number;
  label: string;
};

export type TerminalLineTimestampPerfStep =
  | {
    kind: "segment";
    durationMs: number;
    dataChars: number;
    segmentCount: number;
    dataSegmentCount: number;
    timestampSegmentCount: number;
    parsedChars: number;
  }
  | {
    kind: "batched-write";
    dataChars: number;
    timestamps: number;
    measureMs: number;
    writeCallbackMs: number;
    markerMs: number;
    rowOffset: number;
    columns: number;
  }
  | {
    kind: "segmented-write";
    dataChars: number;
    timestamps: number;
    writeCalls: number;
    writeChars: number;
    writeCallbackMs: number;
    totalMs: number;
  }
  | {
    kind: "fallback-write";
    dataChars: number;
    writeCallbackMs: number;
  };

export type TerminalLineTimestampDiagnostics = {
  onStep?: (step: TerminalLineTimestampPerfStep) => void;
};

export type TerminalLineTimestampWriteOptions = TerminalLineTimestampDiagnostics & {
  /** Wall-clock arrival time for this batch, preserved across delayed writes. */
  timestampDate?: Date;
  /**
   * Deprecated for recording: write path always maintains the per-second ledger
   * (record/render separation). Kept for call-site compatibility; ignored.
   */
  enabled?: boolean;
};

const stores = new WeakMap<XTerm, TimestampStore>();
/**
 * Target ceiling for retained timestamp entries. xterm updates every marker
 * whenever a scrollback row is trimmed, so matching a 100k-row scrollback makes
 * steady output progressively more expensive. Keep enough recent timestamp
 * history for normal navigation while bounding that per-line trim work.
 */
export const MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES = 4096;
/** Compact disposed holes at least this often during flood writes. */
const TIMESTAMP_PRUNE_EVERY_RECORDS = 256;
/** Max xterm marker.dispose() calls per prune/write pass (amortize O(n) splices). */
const TIMESTAMP_ORPHAN_DISPOSE_BUDGET = 64;

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export const formatTerminalLineTimestamp = (date: Date): string => (
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
);

/**
 * Resolve how many line timestamps to retain for a terminal.
 * Prefer the live scrollback option so a smaller history trims timestamps too.
 * Capacity follows scrollback + viewport (+slack), bounded by the live-marker
 * target so very large histories do not make every trim progressively slower.
 */
export const resolveTerminalLineTimestampCapacity = (
  term: XTerm,
  fallback = MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
): number => {
  const options = (term as XTerm & { options?: { scrollback?: number } }).options;
  const scrollback = options?.scrollback;
  const rows = Number.isFinite(term.rows) && term.rows > 0 ? term.rows : 24;
  if (Number.isFinite(scrollback) && Number(scrollback) > 0) {
    return Math.min(
      MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
      Math.floor(Number(scrollback)) + rows + 64,
    );
  }
  return Math.min(MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES, fallback);
};

const isCsiFinalByte = (char: string): boolean => char >= "@" && char <= "~";
const STRING_TERMINATOR = "\u009c";

const readStringTerminatedSequence = (
  data: string,
  startIndex: number,
): { sequence: string; endIndex: number; complete: boolean } => {
  for (let index = startIndex + 2; index < data.length; index += 1) {
    if (data[index] === "\u0007" || data[index] === STRING_TERMINATOR) {
      return {
        sequence: data.slice(startIndex, index + 1),
        endIndex: index,
        complete: true,
      };
    }
    if (data[index] === "\x1b" && data[index + 1] === "\\") {
      return {
        sequence: data.slice(startIndex, index + 2),
        endIndex: index + 1,
        complete: true,
      };
    }
  }
  return {
    sequence: data.slice(startIndex),
    endIndex: data.length - 1,
    complete: false,
  };
};

const readEscapeSequence = (
  data: string,
  startIndex: number,
): { sequence: string; endIndex: number; complete: boolean } | null => {
  if (data[startIndex] !== "\x1b") return null;
  const next = data[startIndex + 1];
  if (!next) {
    return { sequence: "\x1b", endIndex: startIndex, complete: false };
  }

  if (next === "[") {
    for (let index = startIndex + 2; index < data.length; index += 1) {
      if (isCsiFinalByte(data[index])) {
        return {
          sequence: data.slice(startIndex, index + 1),
          endIndex: index,
          complete: true,
        };
      }
    }
    return {
      sequence: data.slice(startIndex),
      endIndex: data.length - 1,
      complete: false,
    };
  }

  if (next === "]") {
    return readStringTerminatedSequence(data, startIndex);
  }

  if (next === "P" || next === "^" || next === "_" || next === "X") {
    return readStringTerminatedSequence(data, startIndex);
  }

  return {
    sequence: data.slice(startIndex, startIndex + 2),
    endIndex: startIndex + 1,
    complete: true,
  };
};

const getCsiFinal = (sequence: string): string | null => {
  if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
  return sequence.at(-1) ?? null;
};

const getAlternateScreenAction = (sequence: string): "enter" | "leave" | null => {
  const final = getCsiFinal(sequence);
  if (final !== "h" && final !== "l") return null;

  const params = sequence.slice(2, -1);
  if (!params.startsWith("?")) return null;

  const modes = params
    .slice(1)
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);

  if (!modes.some((mode) => mode === 47 || mode === 1047 || mode === 1049)) {
    return null;
  }

  return final === "h" ? "enter" : "leave";
};

const getWraparoundAction = (sequence: string): boolean | null => {
  const final = getCsiFinal(sequence);
  if (final !== "h" && final !== "l") return null;

  const params = sequence.slice(2, -1);
  if (!params.startsWith("?")) return null;

  const modes = params
    .slice(1)
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);

  return modes.includes(7) ? final === "h" : null;
};

const isSgrSequence = (sequence: string): boolean =>
  getCsiFinal(sequence) === "m";

const isBulkMeasurableEscapeSequence = (sequence: string): boolean =>
  getAlternateScreenAction(sequence) === null
  && (getWraparoundAction(sequence) !== null || isSgrSequence(sequence));

const isPotentialAlternateScreenSequence = (sequence: string): boolean => {
  if (!sequence.startsWith("\x1b[?")) return false;

  const params = sequence.slice(3).split(";");
  const alternateScreenModes = ["47", "1047", "1049"];
  return params.some((part) => (
    part === ""
    || alternateScreenModes.some((mode) => mode.startsWith(part) || part.startsWith(mode))
  ));
};

const isPrintableOutput = (char: string): boolean => {
  if (char === "\t") return true;
  const code = char.codePointAt(0);
  return code !== undefined
    && code >= 0x20
    && code !== 0x7f
    && (code < 0x80 || code > 0x9f);
};

const pushDataSegment = (
  segments: TerminalLineTimestampSegment[],
  data: string,
) => {
  if (!data) return;
  const previous = segments.at(-1);
  if (previous?.kind === "data") {
    previous.data += data;
    return;
  }
  segments.push({ kind: "data", data });
};

/** Characters that can change segmenter state outside alternate screen. */
// eslint-disable-next-line no-control-regex
const SEGMENTER_BOUNDARY_SCAN = /[\u001b\n\r]/g;

/** Index of the next ESC/LF/CR at or after `from`, or `input.length`. */
const nextSegmenterBoundary = (input: string, from: number): number => {
  SEGMENTER_BOUNDARY_SCAN.lastIndex = from;
  const match = SEGMENTER_BOUNDARY_SCAN.exec(input);
  return match === null ? input.length : match.index;
};

export const createTerminalLineTimestampSegmenter = (
  options: TerminalLineTimestampSegmenterOptions = {},
): TerminalLineTimestampSegmenter => {
  const now = options.now ?? (() => new Date());
  const formatLabel = options.formatLabel ?? formatTerminalLineTimestamp;
  let atLineStart = true;
  let currentLineStamped = false;
  let pendingEscapeSequence = "";
  let suspendedForAlternateScreen = false;

  const resetLineState = () => {
    atLineStart = true;
    currentLineStamped = false;
  };

  const pushTimestampIfNeeded = (
    segments: TerminalLineTimestampSegment[],
    timestampDate?: Date,
  ) => {
    if (!atLineStart || currentLineStamped) return;
    currentLineStamped = true;
    atLineStart = false;
    segments.push({
      kind: "timestamp",
      label: formatLabel(timestampDate ?? now()),
    });
  };

  return {
    append(data: string, timestampDate?: Date) {
      const input = pendingEscapeSequence ? `${pendingEscapeSequence}${data}` : data;
      pendingEscapeSequence = "";
      const segments: TerminalLineTimestampSegment[] = [];

      for (let index = 0; index < input.length;) {
        const char = input[index];

        if (char === "\x1b") {
          const sequence = readEscapeSequence(input, index);
          if (sequence) {
            if (!sequence.complete) {
              pendingEscapeSequence = sequence.sequence;
              break;
            }
            const alternateScreenAction = getAlternateScreenAction(sequence.sequence);
            if (alternateScreenAction === "enter") {
              suspendedForAlternateScreen = true;
              resetLineState();
            } else if (alternateScreenAction === "leave") {
              suspendedForAlternateScreen = false;
              resetLineState();
            }
            pushDataSegment(segments, sequence.sequence);
            index = sequence.endIndex + 1;
            continue;
          }
        }

        if (suspendedForAlternateScreen) {
          // Nothing but an ESC sequence can change state while suspended;
          // hop to the next ESC and append the span in one slice.
          const nextEsc = input.indexOf("\x1b", index + 1);
          const end = nextEsc === -1 ? input.length : nextEsc;
          pushDataSegment(segments, input.slice(index, end));
          index = end;
          continue;
        }

        if (!isPrintableOutput(char)) {
          // Single control character (e.g. \n, \r, BEL, backspace).
          pushDataSegment(segments, char);
          if (char === "\n") {
            resetLineState();
          } else if (char === "\r") {
            atLineStart = true;
          }
          index += 1;
          continue;
        }

        // Printable character: stamp the line if needed, then hop to the next
        // state-changing character (ESC/LF/CR) and append the span in one
        // slice. Control chars inside the span (BEL, backspace, DEL, C1)
        // never change segmenter state, matching the per-char loop.
        pushTimestampIfNeeded(segments, timestampDate);
        atLineStart = false;
        const end = nextSegmenterBoundary(input, index + 1);
        pushDataSegment(segments, input.slice(index, end));
        index = end;
      }

      return segments;
    },
    reset() {
      resetLineState();
      pendingEscapeSequence = "";
      suspendedForAlternateScreen = false;
    },
    flushPendingEscapeSequence() {
      const sequence = pendingEscapeSequence;
      pendingEscapeSequence = "";
      return sequence;
    },
    setAlternateScreenActive(active: boolean) {
      suspendedForAlternateScreen = active;
      if (active) {
        resetLineState();
      }
    },
  };
};

const notifyTimestampStore = (store: TimestampStore) => {
  if (store.listeners.size === 0) return;
  for (const listener of store.listeners) {
    listener();
  }
};

const getTimestampStore = (term: XTerm): TimestampStore => {
  let store = stores.get(term);
  if (!store) {
    const created: TimestampStore = {
      // Placeholder; replaced immediately with an interning segmenter below.
      segmenter: createTerminalLineTimestampSegmenter(),
      entries: [],
      ledger: [],
      lastStampSecondKey: null,
      lastSeenBaseY: null,
      ledgerMaterialized: false,
      orphanedMarkers: [],
      listeners: new Set(),
      timestampOnlyPrefix: "",
      recordsSincePrune: 0,
      disposedPendingCompact: 0,
      labelCacheKey: null,
      labelCacheValue: "",
    };
    created.segmenter = createTerminalLineTimestampSegmenter({
      formatLabel: (date) => internTerminalLineTimestampLabel(created, date),
    });
    stores.set(term, created);
    store = created;
  }
  return store;
};

const secondKeyFromDate = (date: Date): number => Math.floor(date.getTime() / 1000);

const getAbsoluteCursorLine = (term: XTerm): number => {
  try {
    const active = term.buffer?.active as
      | { baseY?: number; cursorY?: number }
      | undefined;
    const baseY = typeof active?.baseY === "number" ? active.baseY : 0;
    const cursorY = typeof active?.cursorY === "number" ? active.cursorY : 0;
    return Math.max(0, baseY + cursorY);
  } catch {
    return 0;
  }
};

/** Advance absolute line by hard newlines in a data span (pre-write estimate). */
const advanceAbsoluteLineByData = (line: number, data: string): number => {
  let next = line;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === "\n") next += 1;
  }
  return next;
};

const trimLedgerToCapacity = (
  store: TimestampStore,
  capacity: number,
): void => {
  if (capacity > 0 && store.ledger.length > capacity) {
    store.ledger.splice(0, store.ledger.length - capacity);
  }
};

/**
 * Accept at most one stamp per wall-clock second across ledger + markers.
 * Returns false when this second was already stamped.
 */
const tryBeginSecondStamp = (
  store: TimestampStore,
  secondKey: number,
): boolean => {
  if (store.lastStampSecondKey === secondKey) return false;
  store.lastStampSecondKey = secondKey;
  return true;
};

const pushLedgerStamp = (
  store: TimestampStore,
  label: string,
  secondKey: number,
  line: number,
  capacity: number,
): void => {
  store.ledger.push({ label, secondKey, line: Math.max(0, line) });
  trimLedgerToCapacity(store, capacity);
};

/**
 * When scrollback trims, xterm shifts absolute line indices down as baseY grows.
 * Rebase ledger anchors the same way markers would have been updated.
 */
const rebaseLedgerForScrollback = (term: XTerm, store: TimestampStore): void => {
  let baseY = 0;
  let bufferLength = 0;
  try {
    const active = term.buffer?.active as
      | { baseY?: number; length?: number }
      | undefined;
    baseY = typeof active?.baseY === "number" ? active.baseY : 0;
    bufferLength = typeof active?.length === "number" ? active.length : 0;
  } catch {
    return;
  }

  if (store.lastSeenBaseY !== null && baseY > store.lastSeenBaseY) {
    const delta = baseY - store.lastSeenBaseY;
    for (const entry of store.ledger) {
      entry.line -= delta;
    }
  }
  store.lastSeenBaseY = baseY;

  if (store.ledger.length === 0) return;
  let write = 0;
  for (let read = 0; read < store.ledger.length; read += 1) {
    const entry = store.ledger[read]!;
    if (entry.line < 0) continue;
    if (bufferLength > 0 && entry.line >= bufferLength) continue;
    store.ledger[write] = entry;
    write += 1;
  }
  store.ledger.length = write;
};

/** Test helper: per-second ledger depth. */
export const getTerminalLineTimestampLedgerCount = (term: XTerm): number =>
  getTimestampStore(term).ledger.length;

/** @deprecated No-op; paint reads the ledger directly. */
export const materializeTimestampLedgerToMarkers = (_term: XTerm): number => 0;

const internTerminalLineTimestampLabel = (
  store: TimestampStore,
  date: Date,
): string => {
  // Same wall-clock second → identical label; avoid allocating 50万× "12:34:56".
  const key = Math.floor(date.getTime() / 1000);
  if (store.labelCacheKey === key) {
    return store.labelCacheValue;
  }
  const label = formatTerminalLineTimestamp(date);
  store.labelCacheKey = key;
  store.labelCacheValue = label;
  return label;
};

const enqueueOrphanedMarker = (
  store: TimestampStore,
  marker: TimestampMarker,
): void => {
  if (marker.isDisposed) return;
  store.orphanedMarkers.push(marker);
};

/**
 * Dispose a bounded number of orphaned xterm markers. Full mass-dispose of
 * thousands of markers freezes (xterm splice is O(markers) each); amortizing
 * keeps rewrite/flood sessions responsive while still retiring superseded
 * markers that scrollback will never trim (e.g. DECSTBM row rewrites).
 */
function scheduleOrphanMarkerDrain(store: TimestampStore): void {
  if (store.orphanDrainTimer !== undefined || store.orphanedMarkers.length === 0) return;
  const timer = setTimeout(() => {
    if (store.orphanDrainTimer !== timer) return;
    store.orphanDrainTimer = undefined;
    drainOrphanedMarkers(store);
  }, 0);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  store.orphanDrainTimer = timer;
}

function drainOrphanedMarkers(
  store: TimestampStore,
  budget = TIMESTAMP_ORPHAN_DISPOSE_BUDGET,
): void {
  let remaining = Math.max(0, budget);
  while (remaining > 0 && store.orphanedMarkers.length > 0) {
    const marker = store.orphanedMarkers.pop();
    remaining -= 1;
    if (!marker || marker.isDisposed) continue;
    marker.dispose?.();
  }
  scheduleOrphanMarkerDrain(store);
}

/** Cheap pass for paint/write paths: drop disposed holes only (no dedupe / capacity). */

/**
 * Compact disposed markers, collapse rewritten lines to their latest label,
 * and enforce a hard capacity in linear passes.
 * Avoids the previous O(n) filter on *every* individual marker dispose during
 * scrollback trim (which turned seq 1 500000 into ~O(n²) main-thread work).
 */
const pruneDisposedEntries = (
  store: TimestampStore,
  capacity = MAX_TERMINAL_LINE_TIMESTAMP_ENTRIES,
): void => {
  const entries = store.entries;
  let write = 0;
  for (let read = 0; read < entries.length; read += 1) {
    const entry = entries[read];
    if (entry.marker.isDisposed) continue;
    entries[write] = entry;
    write += 1;
  }
  entries.length = write;

  // Cursor-up / reposition can append many live markers on the same buffer
  // line. Keep only the latest label per line so the capacity budget tracks
  // unique visible history instead of rewrite noise.
  if (entries.length > 1) {
    const kept: TimestampEntry[] = [];
    const seenLines = new Set<number>();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const line = entry.marker.line;
      if (seenLines.has(line)) {
        enqueueOrphanedMarker(store, entry.marker);
        continue;
      }
      seenLines.add(line);
      kept.push(entry);
    }
    kept.reverse();
    store.entries = kept;
  }

  const live = store.entries;
  if (capacity > 0 && live.length > capacity) {
    const drop = live.length - capacity;
    for (let index = 0; index < drop; index += 1) {
      enqueueOrphanedMarker(store, live[index].marker);
    }
    live.splice(0, drop);
  }
  drainOrphanedMarkers(store);
  store.recordsSincePrune = 0;
};

const maybePruneTimestampEntries = (
  term: XTerm,
  store: TimestampStore,
  force = false,
  recordsAdded = 1,
): void => {
  const capacity = resolveTerminalLineTimestampCapacity(term);
  store.recordsSincePrune += Math.max(0, recordsAdded);
  if (
    force
    || store.recordsSincePrune >= TIMESTAMP_PRUNE_EVERY_RECORDS
    || store.entries.length > capacity * 1.25
  ) {
    pruneDisposedEntries(store, capacity);
  }
};

const resetTimestampStore = (store: TimestampStore) => {
  if (store.orphanDrainTimer !== undefined) {
    clearTimeout(store.orphanDrainTimer);
    store.orphanDrainTimer = undefined;
  }
  for (const entry of store.entries) {
    entry.disposeListener?.dispose();
    entry.marker.dispose?.();
  }
  for (const marker of store.orphanedMarkers) {
    if (!marker.isDisposed) marker.dispose?.();
  }
  store.entries = [];
  store.ledger = [];
  store.lastStampSecondKey = null;
  store.lastSeenBaseY = null;
  store.ledgerMaterialized = false;
  store.orphanedMarkers = [];
  store.segmenter.reset();
  store.timestampOnlyPrefix = "";
  store.recordsSincePrune = 0;
  store.disposedPendingCompact = 0;
  store.labelCacheKey = null;
  store.labelCacheValue = "";
  notifyTimestampStore(store);
};

const _recordTerminalLineTimestamp = (
  term: XTerm,
  store: TimestampStore,
  label: string,
  notify = true,
  cursorYOffset = 0,
  options: { skipPrune?: boolean } = {},
): boolean => {
  // Gutter-on path: per-line markers for accurate paint. The gutter-off path
  // uses a per-second ledger instead (see writeTerminalDataWithSecondLedgerOnly).
  const registerMarker = (term as XTerm & { registerMarker?: (offset: number) => TimestampMarker | undefined }).registerMarker;
  const marker = registerMarker?.call(term, cursorYOffset);
  if (!marker) return false;

  // Lightweight dispose signal only — never filter(entries) per dispose.
  // Compaction happens in bulk on write/paint via compactDisposedMarkersOnly.
  const entry: TimestampEntry = { marker, label };
  entry.disposeListener = marker.onDispose?.(() => {
    store.disposedPendingCompact += 1;
    entry.disposeListener?.dispose();
    entry.disposeListener = undefined;
  });
  store.entries.push(entry);
  store.ledgerMaterialized = true;
  if (!options.skipPrune) {
    maybePruneTimestampEntries(term, store);
  }
  if (notify) {
    notifyTimestampStore(store);
  }
  return true;
};

/** Test/diagnostics helper: live entry count after optional prune. */
export const getTerminalLineTimestampEntryCount = (
  term: XTerm,
  options: { prune?: boolean } = {},
): number => {
  const store = getTimestampStore(term);
  if (options.prune !== false) {
    pruneDisposedEntries(store, resolveTerminalLineTimestampCapacity(term));
  }
  return store.entries.length;
};

const _countLineFeeds = (data: string): number => {
  let count = 0;
  for (const char of data) {
    if (char === "\n") count += 1;
  }
  return count;
};

const _getTerminalColumnCount = (term: XTerm): number => {
  const columns = (term as XTerm & { cols?: number }).cols;
  return Number.isFinite(columns) && Number(columns) > 0
    ? Math.floor(Number(columns))
    : Number.POSITIVE_INFINITY;
};

const _getTerminalCursorColumn = (term: XTerm): number => {
  const cursorX = ((term.buffer?.active as { cursorX?: number } | undefined)?.cursorX);
  return Number.isFinite(cursorX) && Number(cursorX) >= 0
    ? Math.floor(Number(cursorX))
    : 0;
};

const _getTerminalWraparoundMode = (term: XTerm): boolean => (
  ((term as XTerm & { modes?: { wraparoundMode?: boolean } }).modes?.wraparoundMode) !== false
);

/**
 * True when DECSTBM (or equivalent) leaves a partial scrolling region.
 * Bulk row-offset measurement assumes full-buffer advancement; inside a
 * region, newlines recycle rows and measured offsets would invent fake
 * history and evict still-valid scrollback timestamps.
 */
export const hasPartialScrollingRegion = (term: XTerm): boolean => {
  const core = (term as XTerm & {
    _core?: { buffer?: { scrollTop?: number; scrollBottom?: number } };
  })._core;
  const scrollTop = core?.buffer?.scrollTop;
  const scrollBottom = core?.buffer?.scrollBottom;
  const rows = Number.isFinite(term.rows) && term.rows > 0 ? term.rows : 0;
  if (
    !Number.isFinite(scrollTop)
    || !Number.isFinite(scrollBottom)
    || rows <= 0
  ) {
    return false;
  }
  return Number(scrollTop) > 0 || Number(scrollBottom) < rows - 1;
};

const isUnsafeGraphemeSequenceCodePoint = (codePoint: number): boolean => (
  codePoint === 0x200d
  || codePoint === 0x20e3
  || (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)
  || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
  || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  || (codePoint >= 0xe0020 && codePoint <= 0xe007f)
  || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
);

const isUnsafeFormatCodePoint = (codePoint: number): boolean => (
  (codePoint >= 0x200b && codePoint <= 0x200f)
  || (codePoint >= 0x202a && codePoint <= 0x202e)
  || (codePoint >= 0x2060 && codePoint <= 0x206f)
  || codePoint === 0xfeff
  || (codePoint >= 0xfff9 && codePoint <= 0xfffb)
);

const unicodeMarkPattern = /\p{Mark}/u;

const isHangulJamoCodePoint = (codePoint: number): boolean => (
  (codePoint >= 0x1100 && codePoint <= 0x11ff)
  || (codePoint >= 0xa960 && codePoint <= 0xa97f)
  || (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
);

const isContextSensitiveGraphemeCodePoint = (codePoint: number): boolean => (
  unicodeMarkPattern.test(String.fromCodePoint(codePoint))
  || isHangulJamoCodePoint(codePoint)
);

const getCodePointCellWidth = (term: XTerm, codePoint: number): 0 | 1 | 2 | null => {
  if (codePoint < 0x80) return 1;
  const unicodeService = (term as XTermWithUnicodeService)._core?.unicodeService;
  if (typeof unicodeService?.wcwidth !== "function") return null;
  try {
    const width = unicodeService.wcwidth(codePoint);
    return width === 0 || width === 1 || width === 2 ? width : null;
  } catch {
    return null;
  }
};

type MeasuredTerminalRows = {
  rowOffset: number;
  column: number;
  wraparoundMode: boolean;
};

const advanceMeasuredColumns = (
  column: number,
  rowOffset: number,
  columns: number,
  width: number,
  wraparoundMode: boolean,
): { column: number; rowOffset: number } => {
  if (!Number.isFinite(columns)) {
    return { column, rowOffset };
  }
  if (!wraparoundMode) {
    return {
      column: Math.min(columns, column + width),
      rowOffset,
    };
  }
  let nextRowOffset = rowOffset;
  let nextColumn = column;
  if (nextColumn + width > columns) {
    nextRowOffset += 1;
    nextColumn = 0;
  }
  nextColumn += width;
  while (nextColumn > columns) {
    nextRowOffset += 1;
    nextColumn -= columns;
  }
  return { column: nextColumn, rowOffset: nextRowOffset };
};

const advanceMeasuredTab = (
  column: number,
  columns: number,
): number => {
  if (!Number.isFinite(columns) || column >= columns) {
    return column;
  }
  const tabStopWidth = 8;
  const nextTabStop = column + (tabStopWidth - (column % tabStopWidth));
  return Math.min(nextTabStop, columns - 1);
};

/**
 * Fast gate for flood output like `seq`: printable ASCII + CR/LF/TAB/BS only.
 * Avoids escape parsing and unicode width lookups entirely.
 */
export const isSimpleAsciiControlText = (data: string): boolean => {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x09 || code === 0x08) continue;
    if (code >= 0x20 && code <= 0x7e) continue;
    return false;
  }
  return true;
};

const measureSimpleAsciiRows = (
  data: string,
  startColumn: number,
  columns: number,
  startWraparoundMode: boolean,
): MeasuredTerminalRows => {
  let rowOffset = 0;
  let column = startColumn;
  const wraparoundMode = startWraparoundMode;

  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code === 0x0a) {
      rowOffset += 1;
      if (Number.isFinite(columns) && column >= columns) {
        column = columns - 1;
      }
      continue;
    }
    if (code === 0x0d) {
      column = 0;
      continue;
    }
    if (code === 0x08) {
      column = Math.max(0, column - 1);
      continue;
    }
    if (code === 0x09) {
      column = advanceMeasuredTab(column, columns);
      continue;
    }
    // Printable ASCII is always width 1.
    ({ column, rowOffset } = advanceMeasuredColumns(
      column,
      rowOffset,
      columns,
      1,
      wraparoundMode,
    ));
  }

  return { rowOffset, column, wraparoundMode };
};

/**
 * Validate + measure visual rows in a single pass.
 * Returns null when the chunk contains sequences we cannot bulk-measure safely
 * (caller falls back to line-feed counting / segmented writes).
 */
/** Test-only: counts tryMeasureVisualRows invocations on the shipped path. */
let visualRowMeasureCountForTests = 0;
export const getVisualRowMeasureCountForTests = (): number => visualRowMeasureCountForTests;
export const resetVisualRowMeasureCountForTests = (): void => {
  visualRowMeasureCountForTests = 0;
};

export const tryMeasureVisualRows = (
  term: XTerm,
  data: string,
  startColumn: number,
  columns: number,
  startWraparoundMode: boolean,
): MeasuredTerminalRows | null => {
  visualRowMeasureCountForTests += 1;
  if (isSimpleAsciiControlText(data)) {
    return measureSimpleAsciiRows(data, startColumn, columns, startWraparoundMode);
  }

  let rowOffset = 0;
  let column = startColumn;
  let wraparoundMode = startWraparoundMode;

  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === "\x1b") {
      const sequence = readEscapeSequence(data, index);
      if (!sequence?.complete || !isBulkMeasurableEscapeSequence(sequence.sequence)) {
        return null;
      }
      wraparoundMode = getWraparoundAction(sequence.sequence) ?? wraparoundMode;
      index = sequence.endIndex;
      continue;
    }

    if (char === "\n") {
      rowOffset += 1;
      if (Number.isFinite(columns) && column >= columns) {
        column = columns - 1;
      }
      continue;
    }
    if (char === "\r") {
      column = 0;
      continue;
    }
    if (char === "\b") {
      column = Math.max(0, column - 1);
      continue;
    }
    if (char === "\t") {
      column = advanceMeasuredTab(column, columns);
      continue;
    }

    const codePoint = data.codePointAt(index);
    if (codePoint === undefined) return null;
    if (
      codePoint < 0x20
      || codePoint === 0x7f
      || (codePoint >= 0x80 && codePoint <= 0x9f)
      || isUnsafeGraphemeSequenceCodePoint(codePoint)
      || isUnsafeFormatCodePoint(codePoint)
      || isContextSensitiveGraphemeCodePoint(codePoint)
    ) {
      return null;
    }
    const width = getCodePointCellWidth(term, codePoint);
    if (width === null) return null;
    ({ column, rowOffset } = advanceMeasuredColumns(
      column,
      rowOffset,
      columns,
      width,
      wraparoundMode,
    ));
    if (codePoint > 0xffff) {
      index += 1;
    }
  }

  return { rowOffset, column, wraparoundMode };
};


export const resetTerminalLineTimestamps = (term: XTerm) => {
  resetTimestampStore(getTimestampStore(term));
};

export const onTerminalLineTimestampsChange = (
  term: XTerm,
  listener: () => void,
) => {
  const store = getTimestampStore(term);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
};

/**
 * Paint helper from marker entries (legacy). Prefer ledger-based paint.
 */
export const resolveTerminalTimestampGutterRows = ({
  viewportY,
  rows,
  entries,
  isWrappedLine,
}: {
  viewportY: number;
  rows: number;
  entries: readonly TerminalTimestampGutterEntry[];
  isWrappedLine?: (line: number) => boolean;
}): TerminalTimestampGutterRow[] => {
  const viewportEnd = viewportY + rows - 1;
  let firstRelevantLine = viewportY;
  const wrappedSourceLineByRow = new Map<number, number>();

  if (isWrappedLine) {
    for (let row = 0; row < rows; row += 1) {
      const line = viewportY + row;
      if (!isWrappedLine(line)) continue;
      let sourceLine = line;
      while (sourceLine > 0 && isWrappedLine(sourceLine)) {
        sourceLine -= 1;
      }
      wrappedSourceLineByRow.set(row, sourceLine);
      firstRelevantLine = Math.min(firstRelevantLine, sourceLine);
    }
  }

  const labelByLine = new Map<number, string>();
  for (const entry of entries) {
    if (entry.marker.isDisposed) continue;
    const line = entry.marker.line;
    if (line < firstRelevantLine || line > viewportEnd) continue;
    labelByLine.set(line, entry.label);
  }

  const visible: TerminalTimestampGutterRow[] = [];
  for (let row = 0; row < rows; row += 1) {
    const line = viewportY + row;
    const directLabel = labelByLine.get(line);
    if (directLabel) {
      visible.push({ row, label: directLabel });
      continue;
    }

    const sourceLine = wrappedSourceLineByRow.get(row);
    if (sourceLine === undefined) continue;
    const wrappedLabel = labelByLine.get(sourceLine);
    if (wrappedLabel) {
      visible.push({ row, label: wrappedLabel });
    }
  }

  return visible;
};

/**
 * Render gutter rows from the per-second ledger (no xterm markers).
 * Each visible line uses the latest stamp with stamp.line <= line so blank
 * gaps between stamps (and soft-wrap continuations) fill with the previous time.
 */
export const resolveTerminalTimestampGutterRowsFromLedger = ({
  viewportY,
  rows,
  ledger,
  isWrappedLine,
  /** When set, do not paint past the last buffer line (avoids filling empty viewport). */
  bufferLength,
}: {
  viewportY: number;
  rows: number;
  ledger: readonly TimestampLedgerEntry[];
  isWrappedLine?: (line: number) => boolean;
  bufferLength?: number;
}): TerminalTimestampGutterRow[] => {
  if (ledger.length === 0 || rows <= 0) return [];

  const stamps = ledger
    .filter((entry) => entry.line >= 0)
    .slice()
    .sort((left, right) => left.line - right.line || left.secondKey - right.secondKey);

  const labelAtOrBefore = (line: number): string | undefined => {
    let label: string | undefined;
    for (const stamp of stamps) {
      if (stamp.line > line) break;
      label = stamp.label;
    }
    return label;
  };

  const resolveSourceLine = (line: number): number => {
    if (!isWrappedLine?.(line)) return line;
    let sourceLine = line;
    while (sourceLine > 0 && isWrappedLine(sourceLine)) {
      sourceLine -= 1;
    }
    return sourceLine;
  };

  const lastBufferLine = typeof bufferLength === "number" && bufferLength > 0
    ? bufferLength - 1
    : Number.POSITIVE_INFINITY;

  const visible: TerminalTimestampGutterRow[] = [];
  for (let row = 0; row < rows; row += 1) {
    const line = viewportY + row;
    if (line > lastBufferLine) break;
    const sourceLine = resolveSourceLine(line);
    const label = labelAtOrBefore(sourceLine);
    if (label) {
      visible.push({ row, label });
    }
  }
  return visible;
};

export const getVisibleTerminalLineTimestampRows = (
  term: XTerm,
): TerminalTimestampGutterRow[] => {
  if ((term.buffer.active as { type?: string }).type === "alternate") {
    return [];
  }
  const store = getTimestampStore(term);
  rebaseLedgerForScrollback(term, store);
  let bufferLength = 0;
  try {
    const active = term.buffer?.active as { length?: number } | undefined;
    bufferLength = typeof active?.length === "number" ? active.length : 0;
  } catch {
    bufferLength = 0;
  }
  return resolveTerminalTimestampGutterRowsFromLedger({
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
    ledger: store.ledger,
    isWrappedLine: (line) => term.buffer.active.getLine(line)?.isWrapped === true,
    bufferLength,
  });
};

/**
 * Record path: one term.write + per-second ledger updates (no registerMarker).
 */
const writeTerminalDataWithSecondLedger = (
  term: XTerm,
  data: string,
  done: () => void,
  options?: TerminalLineTimestampWriteOptions,
  diagnostics?: TerminalLineTimestampDiagnostics,
  shouldMeasureDiagnostics = false,
): void => {
  const store = getTimestampStore(term);

  store.segmenter.setAlternateScreenActive(
    ((term.buffer?.active as { type?: string } | undefined)?.type) === "alternate",
  );
  const timestampOnlyPrefix = store.timestampOnlyPrefix;
  store.timestampOnlyPrefix = "";
  const dataForTimestamps = `${timestampOnlyPrefix}${data}`;
  const stampDate = options?.timestampDate ?? new Date();
  const segments = store.segmenter.append(dataForTimestamps, stampDate);

  const pendingEscapeSequence = store.segmenter.flushPendingEscapeSequence();
  if (isPotentialAlternateScreenSequence(pendingEscapeSequence)) {
    store.timestampOnlyPrefix = pendingEscapeSequence;
  }

  let absoluteLine = getAbsoluteCursorLine(term);
  const capacity = resolveTerminalLineTimestampCapacity(term);
  let ledgerChanged = false;
  for (const segment of segments) {
    if (segment.kind === "timestamp") {
      const secondKey = store.labelCacheKey ?? secondKeyFromDate(stampDate);
      if (tryBeginSecondStamp(store, secondKey)) {
        pushLedgerStamp(store, segment.label, secondKey, absoluteLine, capacity);
        ledgerChanged = true;
      }
      continue;
    }
    absoluteLine = advanceAbsoluteLineByData(absoluteLine, segment.data);
  }

  const writeStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;
  term.write(data, () => {
    rebaseLedgerForScrollback(term, store);
    if (ledgerChanged) {
      notifyTimestampStore(store);
    }
    if (diagnostics) {
      diagnostics.onStep?.({
        kind: "fallback-write",
        dataChars: data.length,
        writeCallbackMs: performance.now() - writeStartedAt,
      });
    }
    done();
  });
};

export const writeTerminalDataWithLineTimestamps = (
  term: XTerm,
  data: string,
  done: () => void,
  options?: TerminalLineTimestampWriteOptions,
) => {
  const diagnostics = options?.onStep ? options : undefined;
  const shouldMeasureDiagnostics = Boolean(diagnostics);
  const writeFallbackOnly = (fallbackData: string, onComplete: () => void): void => {
    const writeStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;
    term.write(fallbackData, () => {
      if (diagnostics) {
        diagnostics.onStep?.({
          kind: "fallback-write",
          dataChars: fallbackData.length,
          writeCallbackMs: performance.now() - writeStartedAt,
        });
      }
      onComplete();
    });
  };

  // True flood: skip ledger work entirely (same product rule as before).
  if (shouldSkipTerminalLineTimestamps(term)) {
    const store = getTimestampStore(term);
    store.segmenter.setAlternateScreenActive(
      ((term.buffer?.active as { type?: string } | undefined)?.type) === "alternate",
    );
    store.segmenter.reset();
    store.timestampOnlyPrefix = "";
    store.lastStampSecondKey = null;
    writeFallbackOnly(data, done);
    return;
  }

  // Record/render separation: always maintain the per-second ledger; gutter
  // paint reads ledger only (no xterm markers on the write path).
  writeTerminalDataWithSecondLedger(
    term,
    data,
    done,
    options,
    diagnostics,
    shouldMeasureDiagnostics,
  );
};
