import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Snippet } from '@/domain/models';
import { snippetAppliesToOutputTrigger } from '@/domain/snippetTargets.ts';
import { isScriptSnippet } from '@/domain/snippetScript.ts';
import {
  createTerminalOutputTriggerFilter,
  getTerminalAlternateScreenAction,
} from '@/domain/terminalOutputTriggerFilter.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { getActiveScriptRunForSession } from '@/application/state/scriptAutomationCoordinator.ts';

const OUTPUT_TRIGGER_SCAN_DELAY_MS = 16;
const OUTPUT_TRIGGER_SCAN_CHUNK_BYTES = 32 * 1024;
const OUTPUT_TRIGGER_SCAN_BYTES_PER_FLUSH = 128 * 1024;
const OUTPUT_TRIGGER_SCAN_TIME_BUDGET_MS = 4;
const OUTPUT_TRIGGER_SCAN_OVERLAP_CHARS = 64;
const OUTPUT_TRIGGER_MAX_PENDING_SCAN_BYTES = 512 * 1024;
const OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS = 2048;

type OutputTriggerContext = {
  sessionId: string;
  hostId?: string;
  snippets: Snippet[];
  onRunScript: (snippet: Snippet, sessionId: string) => void | Promise<void>;
};

type DeferredOutputTriggerEvent =
  | { type: 'output'; chunk: string; meta?: OutputTriggerAppendMeta }
  | { type: 'dropped-output'; chunk: string; meta?: OutputTriggerAppendMeta }
  | { type: 'input-overflow'; droppedCounter: InputEchoLineCounter }
  | { type: 'input'; data: string };

type DeferredOutputTriggerEventProcessor = {
  enqueueOutput: (chunk: string, meta?: OutputTriggerAppendMeta) => void;
  enqueueInput: (data: string) => void;
  flush: () => void;
  reset: () => void;
  getPendingOutputBytes: () => number;
};

type OutputTriggerAppendMeta = {
  droppedOutputMayAffectTerminalState?: boolean;
  droppedOutputAlternateScreenAction?: 'enter' | 'leave';
};

type TerminalOutputTriggerFilterResult = ReturnType<
  ReturnType<typeof createTerminalOutputTriggerFilter>['processServerChunk']
>;

type DeferredOutputTriggerEventProcessorOptions = {
  processOutput: (chunk: string, meta?: OutputTriggerAppendMeta) => void;
  processDroppedOutput?: (chunk: string, meta?: OutputTriggerAppendMeta) => void;
  processDroppedOutputOverflow?: (overflow: {
    retainedPrefix: string;
    discardedSuffix: string;
  }) => void;
  processInput: (data: string) => void;
  processInputOverflow?: (lineCount: number) => void;
  schedule: (callback: () => void) => () => void;
  now?: () => number;
  maxOutputChunkBytes?: number;
  maxOutputBytesPerFlush?: number;
  maxFlushMs?: number;
  maxPendingOutputBytes?: number;
  maxPendingInputBytes?: number;
  pendingOutputOverlapChars?: number;
};

type DroppedOutputOverflowAlternateScreenInspection = {
  mayAffectAlternateScreen: boolean;
  mayAffectScanState: boolean;
  finalAction?: 'enter' | 'leave';
};

type OutputTriggerScanWindow = {
  text: string;
  minEndOffset: number;
  baseOffset: number;
};

type OutputTriggerScanBuffer = {
  append: (chunk: string) => OutputTriggerScanWindow;
  reset: () => void;
};

type InputEchoLineCounter = {
  lineCount: number;
  hasOpenLine: boolean;
  pendingCr: boolean;
  sawInput: boolean;
  startsWithLf: boolean;
};

function isSessionScriptRunActive(sessionId: string): boolean {
  return Boolean(getActiveScriptRunForSession(sessionId));
}

const ALTERNATE_SCREEN_MODE_PREFIXES = ['47', '1047', '1049'];
const ESC = String.fromCharCode(27);

function readCsiSequence(input: string, startIndex: number): { sequence: string; end: number } | null {
  if (input[startIndex] !== ESC || input[startIndex + 1] !== '[') return null;
  for (let index = startIndex + 2; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        sequence: input.slice(startIndex, index + 1),
        end: index + 1,
      };
    }
  }
  return null;
}

function isPotentialAlternateScreenCsiPrefix(sequence: string): boolean {
  if (!sequence.startsWith(`${ESC}[?`)) return false;
  const params = sequence.slice(3);
  if (!params) return true;
  return params
    .split(';')
    .some((part) => (
      part === ''
      || ALTERNATE_SCREEN_MODE_PREFIXES.some((mode) => (
        mode.startsWith(part) || part.startsWith(mode)
      ))
    ));
}

function inspectAlternateScreenActionsInWindow(
  text: string,
  discardedStart: number,
): DroppedOutputOverflowAlternateScreenInspection {
  let mayAffectAlternateScreen = false;
  let mayAffectScanState = false;
  let finalAction: 'enter' | 'leave' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ESC) continue;
    const sequence = readCsiSequence(text, index);
    if (sequence) {
      if (sequence.end <= discardedStart) {
        index = sequence.end - 1;
        continue;
      }
      if (index < discardedStart) {
        mayAffectScanState = true;
      }
      const action = getTerminalAlternateScreenAction(sequence.sequence);
      if (action) {
        mayAffectAlternateScreen = true;
        finalAction = action;
      }
      index = sequence.end - 1;
      continue;
    }
    if (text.length > discardedStart) {
      mayAffectScanState = true;
    }
    if (
      index < text.length
      && text.length > discardedStart
      && isPotentialAlternateScreenCsiPrefix(text.slice(index))
    ) {
      mayAffectAlternateScreen = true;
      finalAction = undefined;
    }
  }
  return { mayAffectAlternateScreen, mayAffectScanState, finalAction };
}

export function inspectDroppedOutputOverflowAlternateScreenState({
  retainedPrefix,
  discardedSuffix,
}: {
  retainedPrefix: string;
  discardedSuffix: string;
}): DroppedOutputOverflowAlternateScreenInspection {
  if (!discardedSuffix) return { mayAffectAlternateScreen: false, mayAffectScanState: false };
  const retainedTail = retainedPrefix.slice(-OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS);
  const lastRetainedEscape = retainedTail.lastIndexOf(ESC);
  const retainedContext = lastRetainedEscape >= 0 ? retainedTail.slice(lastRetainedEscape) : '';
  const discardedHead = discardedSuffix.slice(0, OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS);
  const headInspection = inspectAlternateScreenActionsInWindow(
    `${retainedContext}${discardedHead}`,
    retainedContext.length,
  );
  if (discardedSuffix.length <= OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS) {
    return headInspection;
  }
  const discardedTail = discardedSuffix.slice(-OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS);
  const tailInspection = inspectAlternateScreenActionsInWindow(discardedTail, 0);
  const hasUninspectedMiddle = discardedSuffix.length > OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS * 2;
  return {
    mayAffectAlternateScreen: (
      headInspection.mayAffectAlternateScreen
      || tailInspection.mayAffectAlternateScreen
      || (hasUninspectedMiddle && tailInspection.finalAction !== 'leave')
    ),
    mayAffectScanState: (
      headInspection.mayAffectScanState
      || tailInspection.mayAffectScanState
    ),
    finalAction: tailInspection.finalAction
      ?? (hasUninspectedMiddle || tailInspection.mayAffectAlternateScreen ? undefined : headInspection.finalAction),
  };
}

export function droppedOutputOverflowMayAffectAlternateScreenState(overflow: {
  retainedPrefix: string;
  discardedSuffix: string;
}): boolean {
  return inspectDroppedOutputOverflowAlternateScreenState(overflow).mayAffectAlternateScreen;
}

export function createOutputTriggerScanBuffer(
  overlapChars = OUTPUT_TRIGGER_SCAN_OVERLAP_CHARS,
): OutputTriggerScanBuffer {
  let overlap = '';
  let consumedLength = 0;

  return {
    append(chunk: string) {
      const text = `${overlap}${chunk}`;
      const minEndOffset = overlap.length;
      const baseOffset = consumedLength - overlap.length;
      consumedLength += chunk.length;
      overlap = text.slice(-overlapChars);
      return { text, minEndOffset, baseOffset };
    },
    reset() {
      overlap = '';
      consumedLength = 0;
    },
  };
}

function createInputEchoLineCounter(): InputEchoLineCounter {
  return {
    lineCount: 0,
    hasOpenLine: false,
    pendingCr: false,
    sawInput: false,
    startsWithLf: false,
  };
}

function cloneInputEchoLineCounter(counter: InputEchoLineCounter): InputEchoLineCounter {
  return { ...counter };
}

function appendInputEchoLineCounter(counter: InputEchoLineCounter, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const wasEmpty = !counter.sawInput;
    counter.sawInput = true;
    if (wasEmpty && char === '\n') {
      counter.startsWithLf = true;
    }
    if (counter.pendingCr) {
      counter.pendingCr = false;
      if (char === '\n') {
        continue;
      }
    }
    if (char === '\r') {
      counter.lineCount += 1;
      counter.hasOpenLine = false;
      counter.pendingCr = true;
      continue;
    }
    if (char === '\n') {
      counter.lineCount += 1;
      counter.hasOpenLine = false;
      continue;
    }
    counter.hasOpenLine = true;
  }
}

function appendInputEchoCounterState(
  counter: InputEchoLineCounter,
  source: InputEchoLineCounter,
): void {
  if (!source.sawInput) return;
  if (!counter.sawInput) {
    Object.assign(counter, cloneInputEchoLineCounter(source));
    return;
  }
  const crlfBoundaryAdjustment = counter.pendingCr && source.startsWithLf ? 1 : 0;
  counter.lineCount += source.lineCount - crlfBoundaryAdjustment;
  counter.hasOpenLine = source.hasOpenLine;
  counter.pendingCr = source.pendingCr;
  counter.sawInput = true;
}

function getInputEchoLineCount(counter: InputEchoLineCounter): number {
  if (!counter.sawInput) return 0;
  return Math.max(1, counter.lineCount + (counter.hasOpenLine ? 1 : 0));
}

export function createDeferredOutputTriggerEventProcessor({
  processOutput,
  processDroppedOutput,
  processDroppedOutputOverflow,
  processInput,
  processInputOverflow,
  schedule,
  now = () => performance.now(),
  maxOutputChunkBytes = OUTPUT_TRIGGER_SCAN_CHUNK_BYTES,
  maxOutputBytesPerFlush = OUTPUT_TRIGGER_SCAN_BYTES_PER_FLUSH,
  maxFlushMs = OUTPUT_TRIGGER_SCAN_TIME_BUDGET_MS,
  maxPendingOutputBytes = OUTPUT_TRIGGER_MAX_PENDING_SCAN_BYTES,
  maxPendingInputBytes = OUTPUT_TRIGGER_MAX_PENDING_SCAN_BYTES,
  pendingOutputOverlapChars = OUTPUT_TRIGGER_SCAN_OVERLAP_CHARS,
}: DeferredOutputTriggerEventProcessorOptions): DeferredOutputTriggerEventProcessor {
  const events: DeferredOutputTriggerEvent[] = [];
  let cancelScheduledFlush: (() => void) | null = null;
  let pendingOutputBytes = 0;
  let pendingDroppedOutputBytes = 0;
  let pendingInputBytes = 0;
  let droppedOutputContextTail = '';
  const maxDroppedOutputBytes = Math.max(0, maxOutputBytesPerFlush);

  const scheduleFlush = () => {
    if (cancelScheduledFlush) return;
    cancelScheduledFlush = schedule(() => {
      cancelScheduledFlush = null;
      processor.flush();
    });
  };

  const trimPendingOutput = () => {
    const maxPendingBytes = Math.max(0, maxPendingOutputBytes);
    const overlapBytes = Math.max(0, pendingOutputOverlapChars);
    const maxRetainedBytes = maxPendingBytes + overlapBytes;
    if (pendingOutputBytes <= maxRetainedBytes) return;

    const takeDroppedMaintenanceChunk = (chunk: string) => {
      if (!processDroppedOutput || !chunk) return '';
      const availableBytes = Math.max(0, maxDroppedOutputBytes - pendingDroppedOutputBytes);
      if (availableBytes <= 0) {
        processDroppedOutputOverflow?.({
          retainedPrefix: droppedOutputContextTail,
          discardedSuffix: chunk,
        });
        return '';
      }
      const retained = chunk.length > availableBytes ? chunk.slice(0, availableBytes) : chunk;
      if (retained.length < chunk.length) {
        processDroppedOutputOverflow?.({
          retainedPrefix: `${droppedOutputContextTail}${retained}`,
          discardedSuffix: chunk.slice(retained.length),
        });
      }
      droppedOutputContextTail = `${droppedOutputContextTail}${retained}`.slice(
        -OUTPUT_TRIGGER_DROPPED_OVERFLOW_SCAN_WINDOW_CHARS,
      );
      pendingDroppedOutputBytes += retained.length;
      return retained;
    };

    let bytesToDrop = pendingOutputBytes - maxRetainedBytes;
    for (let index = 0; index < events.length && bytesToDrop > 0; index += 1) {
      const event = events[index];
      if (event.type === 'input' || event.type === 'input-overflow') {
        continue;
      }
      if (event.type === 'dropped-output') continue;
      if (event.chunk.length <= bytesToDrop) {
        bytesToDrop -= event.chunk.length;
        pendingOutputBytes -= event.chunk.length;
        const droppedMeta = event.meta;
        const droppedChunk = takeDroppedMaintenanceChunk(event.chunk);
        if (droppedChunk || droppedMeta) {
          events[index] = droppedMeta
            ? { type: 'dropped-output', chunk: droppedChunk, meta: droppedMeta }
            : { type: 'dropped-output', chunk: droppedChunk };
        } else {
          events.splice(index, 1);
          index -= 1;
        }
        continue;
      }
      const droppedChunk = event.chunk.slice(0, bytesToDrop);
      event.chunk = event.chunk.slice(bytesToDrop);
      pendingOutputBytes -= bytesToDrop;
      const droppedMeta = event.meta;
      event.meta = undefined;
      const retainedDroppedChunk = takeDroppedMaintenanceChunk(droppedChunk);
      if (retainedDroppedChunk || droppedMeta) {
        events.splice(index, 0, droppedMeta
          ? { type: 'dropped-output', chunk: retainedDroppedChunk, meta: droppedMeta }
          : { type: 'dropped-output', chunk: retainedDroppedChunk });
      }
      bytesToDrop = 0;
    }
  };

  const trimPendingInput = () => {
    const maxPendingBytes = Math.max(0, maxPendingInputBytes);
    if (pendingInputBytes <= maxPendingBytes) return;

    let bytesToDrop = pendingInputBytes - maxPendingBytes;
    const nextEvents: DeferredOutputTriggerEvent[] = [];
    const appendOverflowEvent = (droppedCounter: InputEchoLineCounter) => {
      if (!droppedCounter.sawInput) return;
      const previousEvent = nextEvents.at(-1);
      if (previousEvent?.type === 'input-overflow') {
        appendInputEchoCounterState(previousEvent.droppedCounter, droppedCounter);
        return;
      }
      nextEvents.push({ type: 'input-overflow', droppedCounter });
    };

    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.type !== 'input') {
        nextEvents.push(event);
        continue;
      }

      const droppedCounter = createInputEchoLineCounter();
      const retainedChunks: string[] = [];
      for (; index < events.length; index += 1) {
        const inputEvent = events[index];
        if (inputEvent.type !== 'input') {
          index -= 1;
          break;
        }
        if (bytesToDrop <= 0) {
          retainedChunks.push(inputEvent.data);
          continue;
        }
        if (inputEvent.data.length <= bytesToDrop) {
          bytesToDrop -= inputEvent.data.length;
          pendingInputBytes -= inputEvent.data.length;
          appendInputEchoLineCounter(droppedCounter, inputEvent.data);
          continue;
        }
        const droppedInputChunk = inputEvent.data.slice(0, bytesToDrop);
        const retainedInputChunk = inputEvent.data.slice(bytesToDrop);
        pendingInputBytes -= bytesToDrop;
        appendInputEchoLineCounter(droppedCounter, droppedInputChunk);
        retainedChunks.push(retainedInputChunk);
        bytesToDrop = 0;
      }

      appendOverflowEvent(droppedCounter);
      if (retainedChunks.length > 0) {
        nextEvents.push({ type: 'input', data: retainedChunks.join('') });
      }
    }
    events.splice(0, events.length, ...nextEvents);
  };

  const processor: DeferredOutputTriggerEventProcessor = {
    enqueueOutput(chunk: string, meta?: OutputTriggerAppendMeta) {
      if (!chunk) return;
      const lastEvent = events.at(-1);
      if (
        lastEvent?.type === 'output'
        && !lastEvent.meta
        && !meta
        && lastEvent.chunk.length + chunk.length <= maxOutputBytesPerFlush
      ) {
        lastEvent.chunk += chunk;
      } else {
        events.push(meta ? { type: 'output', chunk, meta } : { type: 'output', chunk });
      }
      pendingOutputBytes += chunk.length;
      trimPendingOutput();
      scheduleFlush();
    },
    enqueueInput(data: string) {
      if (!data) return;
      const lastEvent = events.at(-1);
      if (lastEvent?.type === 'input') {
        lastEvent.data += data;
      } else {
        events.push({ type: 'input', data });
      }
      pendingInputBytes += data.length;
      trimPendingInput();
      scheduleFlush();
    },
    flush() {
      const startedAt = now();
      let processedOutputBytes = 0;

      while (events.length > 0) {
        const event = events[0];
        if (event.type === 'input') {
          droppedOutputContextTail = '';
          const chunk = event.data.slice(0, maxOutputChunkBytes);
          event.data = event.data.slice(chunk.length);
          if (!event.data) {
            events.shift();
          }
          pendingInputBytes = Math.max(0, pendingInputBytes - chunk.length);
          processedOutputBytes += chunk.length;
          processInput(chunk);
        } else if (event.type === 'input-overflow') {
          const inputCounter = cloneInputEchoLineCounter(event.droppedCounter);
          events.shift();
          for (const pendingEvent of events) {
            if (pendingEvent.type !== 'input') break;
            appendInputEchoLineCounter(inputCounter, pendingEvent.data);
          }
          processInputOverflow?.(getInputEchoLineCount(inputCounter));
        } else if (event.type === 'dropped-output') {
          const chunk = event.chunk.slice(0, maxOutputChunkBytes);
          event.chunk = event.chunk.slice(chunk.length);
          const meta = event.meta;
          event.meta = undefined;
          if (!event.chunk) {
            events.shift();
          }
          pendingDroppedOutputBytes = Math.max(0, pendingDroppedOutputBytes - chunk.length);
          processedOutputBytes += chunk.length;
          processDroppedOutput?.(chunk, meta);
        } else {
          droppedOutputContextTail = '';
          const chunk = event.chunk.slice(0, maxOutputChunkBytes);
          event.chunk = event.chunk.slice(chunk.length);
          pendingOutputBytes -= chunk.length;
          if (!event.chunk) {
            events.shift();
          }
          processedOutputBytes += chunk.length;
          const meta = event.meta;
          event.meta = undefined;
          processOutput(chunk, meta);
        }

        if (
          events.length > 0
          && (
            processedOutputBytes >= maxOutputBytesPerFlush
            || now() - startedAt >= maxFlushMs
          )
        ) {
          scheduleFlush();
          return;
        }
      }
    },
    reset() {
      events.splice(0, events.length);
      pendingOutputBytes = 0;
      pendingDroppedOutputBytes = 0;
      pendingInputBytes = 0;
      droppedOutputContextTail = '';
      cancelScheduledFlush?.();
      cancelScheduledFlush = null;
    },
    getPendingOutputBytes() {
      return pendingOutputBytes;
    },
  };

  return processor;
}

export function findMatchEndingAfter(text: string, pattern: string, minEndOffset: number): { value: string; endOffset: number } | null {
  const source = new RegExp(pattern);
  for (let startOffset = 0; startOffset <= text.length;) {
    const match = source.exec(text.slice(startOffset));
    if (!match || match.index === undefined) return null;
    const absoluteStart = startOffset + match.index;
    const absoluteEnd = absoluteStart + match[0].length;
    if (absoluteEnd > minEndOffset) {
      return { value: match[0], endOffset: absoluteEnd };
    }
    startOffset = Math.max(absoluteStart + 1, absoluteEnd);
  }
  return null;
}

export function hasApplicableOutputTriggerSnippet(snippets: Snippet[], hostId?: string): boolean {
  return snippets.some((snippet) => (
    isScriptSnippet(snippet)
    && snippet.trigger === 'onOutput'
    && Boolean(snippet.triggerPattern)
    && Boolean(snippet.id)
    && snippetAppliesToOutputTrigger(snippet, hostId)
  ));
}

export function useOutputTriggers({
  sessionId,
  hostId,
  snippets,
  onRunScript,
}: OutputTriggerContext) {
  const launchingRef = useRef(false);
  const lastTriggerMatchEndRef = useRef(new Map<string, number>());
  const serverOutputFilterRef = useRef(createTerminalOutputTriggerFilter());
  const outputTriggerSuppressionRecoveryFilterRef = useRef(createTerminalOutputTriggerFilter());
  const scanBufferRef = useRef(createOutputTriggerScanBuffer());
  const outputTriggerScanSuppressedRef = useRef(false);
  const pendingDroppedOverflowFinalActionRef = useRef<'leave' | null>(null);
  const pendingDroppedOverflowScanStateResetRef = useRef(false);
  const hasOutputTriggers = useMemo(
    () => hasApplicableOutputTriggerSnippet(snippets, hostId),
    [hostId, snippets],
  );

  const scanOutput = useCallback((scannableText: string) => {
    if (!hasOutputTriggers || !scannableText) {
      return;
    }

    const scanWindow = scanBufferRef.current.append(scannableText);
    if (isSessionScriptRunActive(sessionId) || launchingRef.current) {
      return;
    }

    for (const snippet of snippets) {
      if (isSessionScriptRunActive(sessionId) || launchingRef.current) {
        return;
      }
      if (!isScriptSnippet(snippet) || snippet.trigger !== 'onOutput' || !snippet.triggerPattern || !snippet.id) {
        continue;
      }
      if (!snippetAppliesToOutputTrigger(snippet, hostId)) continue;
      try {
        const matched = findMatchEndingAfter(scanWindow.text, snippet.triggerPattern, scanWindow.minEndOffset);
        if (!matched) {
          continue;
        }
        const matchEnd = scanWindow.baseOffset + matched.endOffset;
        const lastMatchEnd = lastTriggerMatchEndRef.current.get(snippet.id) ?? -1;
        if (matchEnd <= lastMatchEnd) {
          continue;
        }
        const matchedSnippetId = snippet.id;
        launchingRef.current = true;
        lastTriggerMatchEndRef.current.set(matchedSnippetId, matchEnd);
        void Promise.resolve(onRunScript(snippet, sessionId))
          .catch(() => {
            // Failed starts can retry on the next matching output chunk.
          })
          .finally(() => {
            launchingRef.current = false;
          });
        return;
      } catch {
        // ignore invalid regex
      }
    }
  }, [hasOutputTriggers, hostId, onRunScript, sessionId, snippets]);

  const scanOutputRef = useRef(scanOutput);
  scanOutputRef.current = scanOutput;

  const resetTriggerScanState = useCallback(() => {
    scanBufferRef.current.reset();
    lastTriggerMatchEndRef.current = new Map();
  }, []);

  const restoreOutputTriggerScanAfterDroppedLeave = useCallback((resetServerFilter = true) => {
    pendingDroppedOverflowFinalActionRef.current = null;
    if (resetServerFilter) {
      serverOutputFilterRef.current.reset();
    }
    outputTriggerSuppressionRecoveryFilterRef.current.reset();
    outputTriggerScanSuppressedRef.current = false;
    resetTriggerScanState();
  }, [resetTriggerScanState]);

  const applyPendingDroppedOverflowFinalAction = useCallback(() => {
    if (pendingDroppedOverflowFinalActionRef.current !== 'leave') {
      return;
    }
    restoreOutputTriggerScanAfterDroppedLeave();
  }, [restoreOutputTriggerScanAfterDroppedLeave]);

  const applyPendingDroppedOverflowScanStateReset = useCallback(() => {
    if (!pendingDroppedOverflowScanStateResetRef.current) {
      return;
    }
    pendingDroppedOverflowScanStateResetRef.current = false;
    serverOutputFilterRef.current.resetPendingEscape();
    outputTriggerSuppressionRecoveryFilterRef.current.resetPendingEscape();
  }, []);

  const suppressOutputTriggerScanAfterDroppedTerminalState = useCallback(() => {
    resetTriggerScanState();
    outputTriggerScanSuppressedRef.current = true;
    outputTriggerSuppressionRecoveryFilterRef.current.reset();
  }, [resetTriggerScanState]);

  const applyOutputTriggerMeta = useCallback((meta?: OutputTriggerAppendMeta) => {
    if (!meta) return;
    if (meta.droppedOutputAlternateScreenAction === 'leave') {
      restoreOutputTriggerScanAfterDroppedLeave();
      return;
    }
    if (meta.droppedOutputAlternateScreenAction === 'enter' || meta.droppedOutputMayAffectTerminalState) {
      pendingDroppedOverflowFinalActionRef.current = null;
      suppressOutputTriggerScanAfterDroppedTerminalState();
    }
  }, [restoreOutputTriggerScanAfterDroppedLeave, suppressOutputTriggerScanAfterDroppedTerminalState]);

  const recoverOutputTriggerScanIfLeave = useCallback((
    result: TerminalOutputTriggerFilterResult,
    resetServerFilter = true,
  ) => {
    if (result.meta.alternateScreenAction !== 'leave' || result.alternateScreenActive) {
      return false;
    }
    restoreOutputTriggerScanAfterDroppedLeave(resetServerFilter);
    return true;
  }, [restoreOutputTriggerScanAfterDroppedLeave]);

  const processOutputTriggerOutput = useCallback((chunk: string, meta?: OutputTriggerAppendMeta) => {
    applyOutputTriggerMeta(meta);
    applyPendingDroppedOverflowFinalAction();
    applyPendingDroppedOverflowScanStateReset();
    const { scannableText, alternateScreenActive } = serverOutputFilterRef.current.processServerChunk(chunk);
    if (outputTriggerScanSuppressedRef.current) {
      const recovery = outputTriggerSuppressionRecoveryFilterRef.current.processServerChunk(chunk);
      recoverOutputTriggerScanIfLeave(recovery, false);
      return;
    }
    if (!scannableText || alternateScreenActive) {
      return;
    }
    scanOutputRef.current(scannableText);
  }, [
    applyOutputTriggerMeta,
    applyPendingDroppedOverflowFinalAction,
    applyPendingDroppedOverflowScanStateReset,
    recoverOutputTriggerScanIfLeave,
  ]);

  const processDroppedOutputTriggerOutput = useCallback((chunk: string, meta?: OutputTriggerAppendMeta) => {
    applyOutputTriggerMeta(meta);
    resetTriggerScanState();
    if (!chunk) return;
    serverOutputFilterRef.current.processServerChunk(chunk);
    if (outputTriggerScanSuppressedRef.current) {
      const recovery = outputTriggerSuppressionRecoveryFilterRef.current.processServerChunk(chunk);
      recoverOutputTriggerScanIfLeave(recovery, false);
    }
  }, [applyOutputTriggerMeta, recoverOutputTriggerScanIfLeave, resetTriggerScanState]);

  const processOutputTriggerInput = useCallback((data: string) => {
    serverOutputFilterRef.current.noteUserInput(data);
  }, []);

  const suppressOutputTriggerScanAfterDroppedOverflow = useCallback((overflow: {
    retainedPrefix: string;
    discardedSuffix: string;
  }) => {
    resetTriggerScanState();
    const inspection = inspectDroppedOutputOverflowAlternateScreenState(overflow);
    if (inspection.mayAffectScanState) {
      pendingDroppedOverflowScanStateResetRef.current = true;
    }
    if (!inspection.mayAffectAlternateScreen) {
      return;
    }
    if (inspection.finalAction === 'leave') {
      pendingDroppedOverflowFinalActionRef.current = 'leave';
      outputTriggerScanSuppressedRef.current = false;
      outputTriggerSuppressionRecoveryFilterRef.current.reset();
      return;
    }
    pendingDroppedOverflowFinalActionRef.current = null;
    outputTriggerScanSuppressedRef.current = true;
    outputTriggerSuppressionRecoveryFilterRef.current.reset();
  }, [resetTriggerScanState]);

  const outputTriggerEventProcessor = useMemo(() => createDeferredOutputTriggerEventProcessor({
    processOutput: processOutputTriggerOutput,
    processDroppedOutput: processDroppedOutputTriggerOutput,
    processDroppedOutputOverflow: suppressOutputTriggerScanAfterDroppedOverflow,
    processInput: processOutputTriggerInput,
    processInputOverflow: (lineCount) => {
      serverOutputFilterRef.current.markInputEchoUncertain(lineCount);
      outputTriggerSuppressionRecoveryFilterRef.current.markInputEchoUncertain(lineCount);
      resetTriggerScanState();
    },
    schedule: (callback) => {
      const timer = globalThis.setTimeout(callback, OUTPUT_TRIGGER_SCAN_DELAY_MS);
      return () => globalThis.clearTimeout(timer);
    },
  }), [
    processDroppedOutputTriggerOutput,
    processOutputTriggerInput,
    processOutputTriggerOutput,
    resetTriggerScanState,
    suppressOutputTriggerScanAfterDroppedOverflow,
  ]);

  const appendOutput = useCallback((chunk: string, meta?: OutputTriggerAppendMeta) => {
    if (!hasOutputTriggers || !chunk) return;
    outputTriggerEventProcessor.enqueueOutput(chunk, meta);
  }, [hasOutputTriggers, outputTriggerEventProcessor]);

  const noteUserInput = useCallback((data: string) => {
    if (!hasOutputTriggers || !data) return;
    outputTriggerEventProcessor.enqueueInput(data);
  }, [hasOutputTriggers, outputTriggerEventProcessor]);

  useEffect(() => {
    outputTriggerEventProcessor.reset();
    scanBufferRef.current.reset();
    launchingRef.current = false;
    lastTriggerMatchEndRef.current = new Map();
    serverOutputFilterRef.current.reset();
    outputTriggerSuppressionRecoveryFilterRef.current.reset();
    outputTriggerScanSuppressedRef.current = false;
    pendingDroppedOverflowFinalActionRef.current = null;
    pendingDroppedOverflowScanStateResetRef.current = false;
  }, [sessionId, hostId, hasOutputTriggers, outputTriggerEventProcessor]);

  useEffect(() => () => {
    outputTriggerEventProcessor.reset();
  }, [outputTriggerEventProcessor]);

  return { appendOutput, noteUserInput };
}

export function setupScriptBridgeListeners(
  getSnapshot: (sessionId: string) => ReturnType<typeof import('@/infrastructure/scripts/screenSnapshotRegistry.ts').captureScreenSnapshot>,
) {
  const disposers: Array<() => void> = [];

  disposers.push(
    netcattyBridge.get()?.onScriptScreenSnapshotRequest?.(({ requestId, sessionId }) => {
      const snapshot = getSnapshot(sessionId);
      void netcattyBridge.get()?.scriptScreenSnapshotResponse?.(requestId, snapshot);
    }) ?? (() => {}),
  );

  return () => {
    disposers.forEach((dispose) => dispose());
  };
}
