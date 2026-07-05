import type { Terminal as XTerm } from "@xterm/xterm";

export type TerminalLineTimestampSegment =
  | { kind: "data"; data: string }
  | { kind: "timestamp"; label: string };

export type TerminalLineTimestampSegmenter = {
  append: (data: string) => TerminalLineTimestampSegment[];
  reset: () => void;
  flushPendingEscapeSequence: () => string;
  setAlternateScreenActive: (active: boolean) => void;
};

type TerminalLineTimestampSegmenterOptions = {
  now?: () => Date;
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
  entries: TimestampEntry[];
  listeners: Set<() => void>;
  timestampOnlyPrefix: string;
};

export type TerminalTimestampGutterEntry = {
  marker: { line: number; isDisposed?: boolean };
  label: string;
};

export type TerminalTimestampGutterRow = {
  row: number;
  label: string;
};

const stores = new WeakMap<XTerm, TimestampStore>();
const MAX_SEGMENTED_TIMESTAMP_WRITES = 64;

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export const formatTerminalLineTimestamp = (date: Date): string => (
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
);

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
  let atLineStart = true;
  let currentLineStamped = false;
  let pendingEscapeSequence = "";
  let suspendedForAlternateScreen = false;

  const resetLineState = () => {
    atLineStart = true;
    currentLineStamped = false;
  };

  const pushTimestampIfNeeded = (segments: TerminalLineTimestampSegment[]) => {
    if (!atLineStart || currentLineStamped) return;
    currentLineStamped = true;
    atLineStart = false;
    segments.push({
      kind: "timestamp",
      label: formatTerminalLineTimestamp(now()),
    });
  };

  return {
    append(data: string) {
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
        pushTimestampIfNeeded(segments);
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
  for (const listener of store.listeners) {
    listener();
  }
};

const getTimestampStore = (term: XTerm): TimestampStore => {
  let store = stores.get(term);
  if (!store) {
    store = {
      segmenter: createTerminalLineTimestampSegmenter(),
      entries: [],
      listeners: new Set(),
      timestampOnlyPrefix: "",
    };
    stores.set(term, store);
  }
  return store;
};

const pruneDisposedEntries = (store: TimestampStore) => {
  store.entries = store.entries.filter((entry) => !entry.marker.isDisposed);
};

const resetTimestampStore = (store: TimestampStore) => {
  for (const entry of store.entries) {
    entry.disposeListener?.dispose();
    entry.marker.dispose?.();
  }
  store.entries = [];
  store.segmenter.reset();
  store.timestampOnlyPrefix = "";
  notifyTimestampStore(store);
};

const recordTerminalLineTimestamp = (
  term: XTerm,
  store: TimestampStore,
  label: string,
  notify = true,
  cursorYOffset = 0,
): boolean => {
  const registerMarker = (term as XTerm & { registerMarker?: (offset: number) => TimestampMarker | undefined }).registerMarker;
  const marker = registerMarker?.call(term, cursorYOffset);
  if (!marker) return false;

  const entry: TimestampEntry = { marker, label };
  entry.disposeListener = marker.onDispose?.(() => {
    store.entries = store.entries.filter((candidate) => candidate !== entry);
    entry.disposeListener?.dispose();
    notifyTimestampStore(store);
  });
  store.entries.push(entry);
  if (notify) {
    notifyTimestampStore(store);
  }
  return true;
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

const canMeasureVisualRows = (data: string): boolean => {
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) > 0x7f) return false;
  }
  return true;
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

const measureTerminalRows = (
  data: string,
  startColumn: number,
  columns: number,
  startWraparoundMode: boolean,
): { rowOffset: number; column: number; wraparoundMode: boolean } => {
  let rowOffset = 0;
  let column = startColumn;
  let wraparoundMode = startWraparoundMode;

  for (let index = 0; index < data.length; index += 1) {
    const sequence = readEscapeSequence(data, index);
    if (sequence?.complete) {
      wraparoundMode = getWraparoundAction(sequence.sequence) ?? wraparoundMode;
      index = sequence.endIndex;
      continue;
    }

    const char = data[index];
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
    if (char < " " || char === "\u007f") {
      continue;
    }
    ({ column, rowOffset } = advanceMeasuredColumns(column, rowOffset, columns, 1, wraparoundMode));
  }

  return { rowOffset, column, wraparoundMode };
};

const writeBatchedTimestampSegments = (
  term: XTerm,
  store: TimestampStore,
  data: string,
  segments: TerminalLineTimestampSegment[],
  done: () => void,
): void => {
  const timestamps: Array<{ label: string; rowOffset: number }> = [];
  const columns = getTerminalColumnCount(term);
  let column = getTerminalCursorColumn(term);
  let wraparoundMode = getTerminalWraparoundMode(term);
  let rowOffset = 0;

  for (const segment of segments) {
    if (segment.kind === "timestamp") {
      timestamps.push({ label: segment.label, rowOffset });
      continue;
    }
    const measured = Number.isFinite(columns) && canMeasureVisualRows(segment.data)
      ? measureTerminalRows(segment.data, column, columns, wraparoundMode)
      : { rowOffset: countLineFeeds(segment.data), column, wraparoundMode };
    rowOffset += measured.rowOffset;
    column = measured.column;
    wraparoundMode = measured.wraparoundMode;
  }

  term.write(data, () => {
    let timestampRecorded = false;
    for (const timestamp of timestamps) {
      timestampRecorded = recordTerminalLineTimestamp(
        term,
        store,
        timestamp.label,
        false,
        timestamp.rowOffset - rowOffset,
      ) || timestampRecorded;
    }
    if (timestampRecorded) {
      notifyTimestampStore(store);
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

  const labelByLine = new Map<number, string>();
  for (const entry of entries) {
    if (entry.marker.isDisposed) continue;
    const line = entry.marker.line;
    if (line < firstRelevantLine || line > viewportEnd) continue;
    labelByLine.set(line, entry.label);
  }

  const rowLabels = new Map<number, string>();
  for (let row = 0; row < rows; row += 1) {
    const line = viewportY + row;
    const directLabel = labelByLine.get(line);
    if (directLabel) {
      rowLabels.set(row, directLabel);
      continue;
    }

    const sourceLine = wrappedSourceLineByRow.get(row);
    if (sourceLine === undefined) continue;
    const wrappedLabel = labelByLine.get(sourceLine);
    if (wrappedLabel) {
      rowLabels.set(row, wrappedLabel);
    }
  }

  return [...rowLabels.entries()]
    .sort(([a], [b]) => a - b)
    .map(([row, label]) => ({ row, label }));
};

export const getVisibleTerminalLineTimestampRows = (
  term: XTerm,
): TerminalTimestampGutterRow[] => {
  if ((term.buffer.active as { type?: string }).type === "alternate") {
    return [];
  }
  const store = getTimestampStore(term);
  pruneDisposedEntries(store);
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
) => {
  const registerMarker = (term as XTerm & { registerMarker?: unknown }).registerMarker;
  if (typeof registerMarker !== "function") {
    term.write(data, done);
    return;
  }

  const store = getTimestampStore(term);
  store.segmenter.setAlternateScreenActive(
    ((term.buffer?.active as { type?: string } | undefined)?.type) === "alternate",
  );
  const timestampOnlyPrefix = store.timestampOnlyPrefix;
  store.timestampOnlyPrefix = "";
  const dataForTimestamps = `${timestampOnlyPrefix}${data}`;
  const segments = store.segmenter.append(dataForTimestamps);
  const parsedData = segments
    .filter((segment): segment is { kind: "data"; data: string } => segment.kind === "data")
    .map((segment) => segment.data)
    .join("");
  const dataSegmentCount = segments.reduce((count, segment) => (
    segment.kind === "data" && segment.data ? count + 1 : count
  ), 0);
  if (
    timestampOnlyPrefix.length === 0
    && parsedData === dataForTimestamps
    && dataSegmentCount > MAX_SEGMENTED_TIMESTAMP_WRITES
  ) {
    writeBatchedTimestampSegments(term, store, data, segments, done);
    return;
  }
  const writeSegments = (
    onComplete: () => void,
    skipLeadingDataLength = 0,
  ) => {
    let index = 0;
    let remainingSkipLength = skipLeadingDataLength;
    let timestampRecorded = false;

    const complete = () => {
      if (timestampRecorded) {
        notifyTimestampStore(store);
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

      term.write(segmentData, writeNext);
    };

    writeNext();
  };

  if (parsedData !== dataForTimestamps) {
    const pendingEscapeSequence = store.segmenter.flushPendingEscapeSequence();
    if (isPotentialAlternateScreenSequence(pendingEscapeSequence)) {
      store.timestampOnlyPrefix = pendingEscapeSequence;
    }
    if (!parsedData || !dataForTimestamps.startsWith(parsedData)) {
      term.write(data, done);
      return;
    }

    const parsedCurrentDataLength = Math.max(0, parsedData.length - timestampOnlyPrefix.length);
    writeSegments(
      () => term.write(data.slice(parsedCurrentDataLength), done),
      timestampOnlyPrefix.length,
    );
    return;
  }
  writeSegments(done, timestampOnlyPrefix.length);
};
