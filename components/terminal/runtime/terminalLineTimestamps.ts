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

type TimestampStore = {
  segmenter: TerminalLineTimestampSegmenter;
  /**
   * Dense ring of live markers for hosts with line timestamps enabled.
   * Capacity is capped to scrollback so flood output cannot grow unboundedly.
   * When the host gutter is off we skip this store on the write path; recording
   * starts when the user turns timestamps on.
   */
  entries: TimestampEntry[];
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
   * When false, skip segmenter/marker work and write bytes only.
   * Defaults to true for direct unit-test callers; production passes the host
   * `showLineTimestamps` flag so disabled gutters stay off the hot path.
   */
  enabled?: boolean;
};

const stores = new WeakMap<XTerm, TimestampStore>();
const MIN_BATCHED_TIMESTAMP_DATA_SEGMENTS = 2;
const BULK_TIMESTAMP_BATCH_MIN_BYTES = 4096;
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
const compactDisposedMarkersOnly = (store: TimestampStore): void => {
  if (store.disposedPendingCompact <= 0) {
    // Still drop any disposed holes we notice, but skip the scan when we have
    // no dispose signals and the list is empty.
    if (store.entries.length === 0) return;
  }
  const entries = store.entries;
  let write = 0;
  for (let read = 0; read < entries.length; read += 1) {
    const entry = entries[read];
    if (entry.marker.isDisposed) {
      entry.disposeListener?.dispose();
      continue;
    }
    entries[write] = entry;
    write += 1;
  }
  entries.length = write;
  store.disposedPendingCompact = 0;
};

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
  store.orphanedMarkers = [];
  store.segmenter.reset();
  store.timestampOnlyPrefix = "";
  store.recordsSincePrune = 0;
  store.disposedPendingCompact = 0;
  store.labelCacheKey = null;
  store.labelCacheValue = "";
  notifyTimestampStore(store);
};

const recordTerminalLineTimestamp = (
  term: XTerm,
  store: TimestampStore,
  label: string,
  notify = true,
  cursorYOffset = 0,
  options: { skipPrune?: boolean } = {},
): boolean => {
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

const countLineFeeds = (data: string): number => {
  let count = 0;
  for (const char of data) {
    if (char === "\n") count += 1;
  }
  return count;
};

const getTerminalColumnCount = (term: XTerm): number => {
  const columns = (term as XTerm & { cols?: number }).cols;
  return Number.isFinite(columns) && Number(columns) > 0
    ? Math.floor(Number(columns))
    : Number.POSITIVE_INFINITY;
};

const getTerminalCursorColumn = (term: XTerm): number => {
  const cursorX = ((term.buffer?.active as { cursorX?: number } | undefined)?.cursorX);
  return Number.isFinite(cursorX) && Number(cursorX) >= 0
    ? Math.floor(Number(cursorX))
    : 0;
};

const getTerminalWraparoundMode = (term: XTerm): boolean => (
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

/**
 * True when `data` can be bulk-measured without a full width walk.
 * Avoids calling tryMeasureVisualRows at the batch gate (that used to double
 * measure: once with fake geometry at the gate, again per segment for offsets).
 */
export const canBulkMeasureTerminalData = (term: XTerm, data: string): boolean => {
  if (isSimpleAsciiControlText(data)) return true;
  // Real geometry validity check only when non-ASCII/CSI is present — still a
  // single measure later in writeBatchedTimestampSegments for marker offsets.
  return tryMeasureVisualRows(
    term,
    data,
    0,
    Number.POSITIVE_INFINITY,
    true,
  ) !== null;
};

const writeBatchedTimestampSegments = (
  term: XTerm,
  store: TimestampStore,
  data: string,
  segments: TerminalLineTimestampSegment[],
  done: () => void,
  diagnostics?: TerminalLineTimestampDiagnostics,
  /**
   * Optional pre-measured full-batch geometry when the batch is a single data
   * segment equal to `data` (reuses the gate measure; no second walk).
   */
  premeasuredFullBatch?: MeasuredTerminalRows | null,
): void => {
  const timestamps: Array<{ label: string; rowOffset: number }> = [];
  const columns = getTerminalColumnCount(term);
  let column = getTerminalCursorColumn(term);
  let wraparoundMode = getTerminalWraparoundMode(term);
  let rowOffset = 0;
  const shouldMeasureDiagnostics = Boolean(diagnostics);
  const measureStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;

  const dataSegments = segments.filter(
    (segment): segment is { kind: "data"; data: string } => segment.kind === "data",
  );
  const canReuseFullBatchMeasure = Boolean(
    premeasuredFullBatch
    && dataSegments.length === 1
    && dataSegments[0]!.data === data
  );

  for (const segment of segments) {
    if (segment.kind === "timestamp") {
      timestamps.push({ label: segment.label, rowOffset });
      continue;
    }
    const measured = (
      canReuseFullBatchMeasure && segment.data === data
        ? premeasuredFullBatch!
        : tryMeasureVisualRows(
          term,
          segment.data,
          column,
          columns,
          wraparoundMode,
        )
    ) ?? {
      // Unmeasurable chunk: preserve prior column/wrap state and count hard newlines only.
      rowOffset: countLineFeeds(segment.data),
      column,
      wraparoundMode,
    };
    rowOffset += measured.rowOffset;
    column = measured.column;
    wraparoundMode = measured.wraparoundMode;
  }
  const measureMs = shouldMeasureDiagnostics ? performance.now() - measureStartedAt : 0;

  const writeStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;
  term.write(data, () => {
    const writeCallbackMs = shouldMeasureDiagnostics ? performance.now() - writeStartedAt : 0;
    const markerStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;
    const capacity = resolveTerminalLineTimestampCapacity(term);
    // Only register markers that land in the retained visual-row window.
    // Slice by timestamp count is wrong for soft-wrapped floods (many stamps
    // can map outside the buffer while fewer visual rows remain). Prefer the
    // last `capacity` visual rows by measured rowOffset.
    const minRowOffset = Math.max(0, rowOffset - capacity + 1);
    let timestampsToRecord = timestamps.filter(
      (timestamp) => timestamp.rowOffset >= minRowOffset,
    );
    if (timestampsToRecord.length > capacity) {
      timestampsToRecord = timestampsToRecord.slice(
        timestampsToRecord.length - capacity,
      );
    }
    let timestampRecorded = false;
    for (const timestamp of timestampsToRecord) {
      timestampRecorded = recordTerminalLineTimestamp(
        term,
        store,
        timestamp.label,
        false,
        timestamp.rowOffset - rowOffset,
        { skipPrune: true },
      ) || timestampRecorded;
    }
    // Amortize small batches. A forced full-store scan on every 2–8 line
    // hidden drain grows with retained history and recreates the CPU climb this
    // path is meant to avoid. Large batches still cross the record threshold.
    maybePruneTimestampEntries(term, store, false, timestampsToRecord.length);
    if (timestampRecorded) {
      notifyTimestampStore(store);
    }
    if (diagnostics) {
      diagnostics.onStep?.({
        kind: "batched-write",
        dataChars: data.length,
        timestamps: timestamps.length,
        measureMs,
        writeCallbackMs,
        markerMs: performance.now() - markerStartedAt,
        rowOffset,
        columns,
      });
    }
    done();
  });
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

  // Full scan (not binary search): cursor-up / reposition writes can append a
  // newer marker on an earlier buffer line, so entries are not always sorted by
  // marker.line. Later entries win for the same line.
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

export const getVisibleTerminalLineTimestampRows = (
  term: XTerm,
): TerminalTimestampGutterRow[] => {
  if ((term.buffer.active as { type?: string }).type === "alternate") {
    return [];
  }
  const store = getTimestampStore(term);
  // Paint path: only drop disposed holes. Full dedupe/capacity runs on write.
  compactDisposedMarkersOnly(store);
  return resolveTerminalTimestampGutterRows({
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
    entries: store.entries,
    isWrappedLine: (line) => term.buffer.active.getLine(line)?.isWrapped === true,
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

  // Host gutter off: skip segmenter/store/markers entirely (plain write).
  if (options?.enabled === false) {
    writeFallbackOnly(data, done);
    return;
  }

  const registerMarker = (term as XTerm & { registerMarker?: unknown }).registerMarker;
  if (typeof registerMarker !== "function") {
    writeFallbackOnly(data, done);
    return;
  }

  // Only skip markers under true flood / long-line pressure — not merely
  // "scrollback full + multi-line" (that would drop timestamps for docker ps
  // after a prior seq). Product semantics: each line can show a gutter stamp.
  if (shouldSkipTerminalLineTimestamps(term)) {
    const store = getTimestampStore(term);
    store.segmenter.setAlternateScreenActive(
      ((term.buffer?.active as { type?: string } | undefined)?.type) === "alternate",
    );
    store.segmenter.reset();
    store.timestampOnlyPrefix = "";
    writeFallbackOnly(data, done);
    return;
  }

  const store = getTimestampStore(term);
  // Clears / scrollback wipes dispose markers without new stamps. Compact only
  // when dispose signals arrived — not on every tiny write against a full store.
  if (store.disposedPendingCompact > 0) {
    compactDisposedMarkersOnly(store);
  }
  store.segmenter.setAlternateScreenActive(
    ((term.buffer?.active as { type?: string } | undefined)?.type) === "alternate",
  );
  const timestampOnlyPrefix = store.timestampOnlyPrefix;
  store.timestampOnlyPrefix = "";
  const dataForTimestamps = `${timestampOnlyPrefix}${data}`;
  const segmentStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;
  const segments = store.segmenter.append(dataForTimestamps, options?.timestampDate);
  const parsedData = segments
    .filter((segment): segment is { kind: "data"; data: string } => segment.kind === "data")
    .map((segment) => segment.data)
    .join("");
  const dataSegmentCount = segments.reduce((count, segment) => (
    segment.kind === "data" && segment.data ? count + 1 : count
  ), 0);
  if (diagnostics) {
    diagnostics.onStep?.({
      kind: "segment",
      durationMs: performance.now() - segmentStartedAt,
      dataChars: data.length,
      segmentCount: segments.length,
      dataSegmentCount,
      timestampSegmentCount: segments.length - dataSegmentCount,
      parsedChars: parsedData.length,
    });
  }
  const writeFallbackData = writeFallbackOnly;
  if (
    timestampOnlyPrefix.length === 0
    && parsedData === dataForTimestamps
    && !hasPartialScrollingRegion(term)
    && (
      dataSegmentCount >= MIN_BATCHED_TIMESTAMP_DATA_SEGMENTS
      || data.length >= BULK_TIMESTAMP_BATCH_MIN_BYTES
    )
    // Tab stops, delayed wrap around backspaces, and ANSI newline mode depend
    // on live xterm parser state. Keep those writes on the ordered segmented
    // path where marker positions come from xterm after each write.
    && !data.includes("\t")
    && !data.includes("\b")
    && (term as XTerm & { options?: { convertEol?: boolean } }).options?.convertEol !== true
  ) {
    // Prefer a single geometry walk per bytes measured:
    // - one data segment: measure with real cursor/cols once, reuse in writeBatched
    // - multi-segment / simple ASCII: validate (if needed) then measure each
    //   segment once inside writeBatched (no second full-batch measure for reuse)
    const isSimpleAscii = isSimpleAsciiControlText(data);
    if (!isSimpleAscii && dataSegmentCount === 1) {
      const premeasuredFullBatch = tryMeasureVisualRows(
        term,
        data,
        getTerminalCursorColumn(term),
        getTerminalColumnCount(term),
        getTerminalWraparoundMode(term),
      );
      if (premeasuredFullBatch !== null) {
        writeBatchedTimestampSegments(
          term,
          store,
          data,
          segments,
          done,
          diagnostics,
          premeasuredFullBatch,
        );
        return;
      }
      // Unmeasurable single segment → segmented writes below.
    } else if (isSimpleAscii || canBulkMeasureTerminalData(term, data)) {
      writeBatchedTimestampSegments(
        term,
        store,
        data,
        segments,
        done,
        diagnostics,
        null,
      );
      return;
    }
  }
  const writeSegments = (
    onComplete: () => void,
    skipLeadingDataLength = 0,
  ) => {
    let index = 0;
    let remainingSkipLength = skipLeadingDataLength;
    let timestampRecorded = false;
    let timestampCount = 0;
    let writeCalls = 0;
    let writeChars = 0;
    let writeCallbackMs = 0;
    const startedAt = shouldMeasureDiagnostics ? performance.now() : 0;

    const complete = () => {
      if (timestampRecorded) {
        notifyTimestampStore(store);
      }
      if (diagnostics) {
        diagnostics.onStep?.({
          kind: "segmented-write",
          dataChars: data.length,
          timestamps: timestampCount,
          writeCalls,
          writeChars,
          writeCallbackMs,
          totalMs: performance.now() - startedAt,
        });
      }
      onComplete();
    };

    const writeNext = () => {
      const segment = segments[index];
      index += 1;

      if (!segment) {
        complete();
        return;
      }

      if (segment.kind === "timestamp") {
        timestampCount += 1;
        timestampRecorded = recordTerminalLineTimestamp(term, store, segment.label, false)
          || timestampRecorded;
        writeNext();
        return;
      }

      let segmentData = segment.data;
      if (remainingSkipLength > 0) {
        const skippedLength = Math.min(remainingSkipLength, segmentData.length);
        segmentData = segmentData.slice(skippedLength);
        remainingSkipLength -= skippedLength;
      }

      if (!segmentData) {
        writeNext();
        return;
      }

      const writeStartedAt = shouldMeasureDiagnostics ? performance.now() : 0;
      term.write(segmentData, () => {
        writeCalls += 1;
        writeChars += segmentData.length;
        if (shouldMeasureDiagnostics) {
          writeCallbackMs += performance.now() - writeStartedAt;
        }
        writeNext();
      });
    };

    writeNext();
  };

  if (parsedData !== dataForTimestamps) {
    const pendingEscapeSequence = store.segmenter.flushPendingEscapeSequence();
    if (isPotentialAlternateScreenSequence(pendingEscapeSequence)) {
      store.timestampOnlyPrefix = pendingEscapeSequence;
    }
    if (!parsedData || !dataForTimestamps.startsWith(parsedData)) {
      writeFallbackData(data, done);
      return;
    }

    const parsedCurrentDataLength = Math.max(0, parsedData.length - timestampOnlyPrefix.length);
    const trailingData = data.slice(parsedCurrentDataLength);
    writeSegments(
      () => writeFallbackData(trailingData, done),
      timestampOnlyPrefix.length,
    );
    return;
  }
  writeSegments(done, timestampOnlyPrefix.length);
};
