import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeferredOutputTriggerEventProcessor,
  createOutputTriggerScanBuffer,
  droppedOutputOverflowMayAffectAlternateScreenState,
  findMatchEndingAfter,
  hasApplicableOutputTriggerSnippet,
  inspectDroppedOutputOverflowAlternateScreenState,
} from './useOutputTriggers.ts';
import { createTerminalOutputTriggerFilter } from '@/domain/terminalOutputTriggerFilter.ts';
import type { Snippet } from '@/domain/models';

test('findMatchEndingAfter skips stale overlap matches and finds current output', () => {
  const text = 'NETCATTY_TRIGGER_PROBE old\r\nprompt# NETCATTY_TRIGGER_PROBE: command not found\r\n';
  const minEndOffset = 'NETCATTY_TRIGGER_PROBE old\r\n'.length;
  const match = findMatchEndingAfter(text, 'NETCATTY_TRIGGER_PROBE', minEndOffset);
  assert.deepEqual(match, {
    value: 'NETCATTY_TRIGGER_PROBE',
    endOffset: 'NETCATTY_TRIGGER_PROBE old\r\nprompt# NETCATTY_TRIGGER_PROBE'.length,
  });
});

test('findMatchEndingAfter supports regex patterns', () => {
  const text = 'old done\r\nservice ready: 200\r\n';
  const minEndOffset = 'old done\r\n'.length;
  const match = findMatchEndingAfter(text, 'ready:\\s+\\d+', minEndOffset);
  assert.deepEqual(match, {
    value: 'ready: 200',
    endOffset: 'old done\r\nservice ready: 200'.length,
  });
});

test('findMatchEndingAfter returns null when matches are only stale', () => {
  const text = 'NETCATTY_TRIGGER_PROBE old\r\nnew output\r\n';
  const minEndOffset = 'NETCATTY_TRIGGER_PROBE old\r\n'.length;
  assert.equal(findMatchEndingAfter(text, 'NETCATTY_TRIGGER_PROBE', minEndOffset), null);
});

test('hasApplicableOutputTriggerSnippet ignores non-output-trigger snippets', () => {
  const snippets: Snippet[] = [
    {
      id: 'plain',
      label: 'Plain',
      command: 'echo hello',
      kind: 'snippet',
    },
    {
      id: 'manual-script',
      label: 'Manual',
      command: '',
      kind: 'script',
      trigger: 'manual',
      triggerPattern: 'READY',
    },
  ];

  assert.equal(hasApplicableOutputTriggerSnippet(snippets, 'host-a'), false);
});

test('hasApplicableOutputTriggerSnippet requires a runnable output trigger for this host', () => {
  const snippets: Snippet[] = [
    {
      id: 'wrong-host',
      label: 'Wrong host',
      command: '',
      kind: 'script',
      trigger: 'onOutput',
      triggerPattern: 'READY',
      targets: ['host-b'],
    },
    {
      id: 'missing-pattern',
      label: 'Missing pattern',
      command: '',
      kind: 'script',
      trigger: 'onOutput',
    },
  ];

  assert.equal(hasApplicableOutputTriggerSnippet(snippets, 'host-a'), false);

  snippets.push({
    id: 'right-host',
    label: 'Right host',
    command: '',
    kind: 'script',
    trigger: 'onOutput',
    triggerPattern: 'READY',
    targets: ['host-a'],
  });

  assert.equal(hasApplicableOutputTriggerSnippet(snippets, 'host-a'), true);
});

test('output trigger scan buffer consumes scanned content and only keeps overlap', () => {
  const buffer = createOutputTriggerScanBuffer(4);

  assert.deepEqual(buffer.append('abcdef'), {
    text: 'abcdef',
    minEndOffset: 0,
    baseOffset: 0,
  });

  assert.deepEqual(buffer.append('gh'), {
    text: 'cdefgh',
    minEndOffset: 4,
    baseOffset: 2,
  });
});

test('output trigger scan buffer scans all new large output instead of only the tail', () => {
  const buffer = createOutputTriggerScanBuffer(4);

  assert.deepEqual(buffer.append('abc'), {
    text: 'abc',
    minEndOffset: 0,
    baseOffset: 0,
  });

  assert.deepEqual(buffer.append('defghijkl'), {
    text: 'abcdefghijkl',
    minEndOffset: 3,
    baseOffset: 0,
  });
});

test('deferred output trigger processor schedules output instead of processing synchronously', () => {
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    processOutput: (chunk) => processed.push(chunk),
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('READY');

  assert.deepEqual(processed, []);
  assert.equal(scheduled.length, 1);

  scheduled.shift()?.();

  assert.deepEqual(processed, ['READY']);
});

test('deferred output trigger processor coalesces output while preserving input order', () => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    processOutput: (chunk) => events.push(`output:${chunk}`),
    processInput: (data) => events.push(`input:${data}`),
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('he');
  processor.enqueueOutput('llo');
  processor.enqueueInput('cmd');
  processor.enqueueOutput('world');

  scheduled.shift()?.();

  assert.deepEqual(events, ['output:hello', 'input:cmd', 'output:world']);
});

test('deferred output trigger processor splits large output and yields between flushes', () => {
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    processOutput: (chunk) => processed.push(chunk),
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('abcdefghijkl');

  scheduled.shift()?.();

  assert.deepEqual(processed, ['abcd', 'efgh']);
  assert.equal(scheduled.length, 1);

  scheduled.shift()?.();

  assert.deepEqual(processed, ['abcd', 'efgh', 'ijkl']);
});

test('deferred output trigger processor splits large input and yields between flushes', () => {
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    processOutput: () => {},
    processInput: (chunk) => processed.push(chunk),
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput('abcdefghijkl');

  scheduled.shift()?.();

  assert.deepEqual(processed, ['abcd', 'efgh']);
  assert.equal(scheduled.length, 1);

  scheduled.shift()?.();

  assert.deepEqual(processed, ['abcd', 'efgh', 'ijkl']);
});

test('deferred output trigger processor caps pending input and resets input state', () => {
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  let inputOverflows = 0;
  let inputOverflowLines = 0;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    maxPendingInputBytes: 8,
    processOutput: () => {},
    processInput: (chunk) => processed.push(chunk),
    processInputOverflow: (lineCount) => {
      inputOverflows += 1;
      inputOverflowLines += lineCount;
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput('abcdefghijkl');

  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.equal(inputOverflows, 1);
  assert.equal(inputOverflowLines, 1);

  assert.deepEqual(processed, ['efgh', 'ijkl']);
});

test('deferred output trigger processor reports dropped input echo line count', () => {
  const scheduled: Array<() => void> = [];
  const overflowLines: number[] = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 16,
    maxOutputBytesPerFlush: 32,
    maxPendingInputBytes: 5,
    processOutput: () => {},
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      overflowLines.push(lineCount);
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput('one\r\ntwo\nthree');
  processor.flush();

  assert.deepEqual(overflowLines, [3]);
});

test('deferred output trigger processor reports more than 1024 dropped input echo lines', () => {
  const scheduled: Array<() => void> = [];
  const overflowLines: number[] = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 16,
    maxOutputBytesPerFlush: 32,
    maxPendingInputBytes: 4,
    processOutput: () => {},
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      overflowLines.push(lineCount);
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput(`${'x\n'.repeat(1100)}tail`);
  processor.flush();

  assert.deepEqual(overflowLines, [1101]);
});

test('deferred output trigger processor includes retained input lines in overflow echo suppression', () => {
  const scheduled: Array<() => void> = [];
  const overflowLines: number[] = [];
  const retainedInput = 'READY c\nREADY d\n';
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 64,
    maxOutputBytesPerFlush: 128,
    maxPendingInputBytes: retainedInput.length,
    processOutput: () => {},
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      overflowLines.push(lineCount);
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput(`READY a\nREADY b\n${retainedInput}`);
  processor.flush();

  assert.deepEqual(overflowLines, [4]);
});

test('deferred output trigger processor accumulates repeated input overflows before flush', () => {
  const overflowLines: number[] = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxPendingInputBytes: 0,
    processOutput: () => {},
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      overflowLines.push(lineCount);
    },
    schedule: () => () => {},
  });

  processor.enqueueInput('one\ntwo\n');
  processor.enqueueInput('three\nfour\n');
  processor.flush();

  assert.deepEqual(overflowLines, [4]);
});

test('deferred output trigger processor counts input split across overflow boundary as one line', () => {
  const overflowLines: number[] = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxPendingInputBytes: 'def\n'.length,
    processOutput: () => {},
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      overflowLines.push(lineCount);
    },
    schedule: () => () => {},
  });

  processor.enqueueInput('abcdef\n');
  processor.flush();

  assert.deepEqual(overflowLines, [1]);
});

test('deferred output trigger processor resets input overflow accounting after flush', () => {
  const scheduled: Array<() => void> = [];
  const overflowLines: number[] = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxPendingInputBytes: 0,
    processOutput: () => {},
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      overflowLines.push(lineCount);
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput('one\ntwo\n');
  scheduled.shift()?.();
  processor.enqueueInput('three\n');
  scheduled.shift()?.();

  assert.deepEqual(overflowLines, [2, 1]);
});

test('deferred output trigger processor preserves output before later input overflow', () => {
  const processed: string[] = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxPendingInputBytes: 0,
    processOutput: (chunk) => {
      processed.push(`output:${chunk}`);
    },
    processInput: () => {},
    processInputOverflow: (lineCount) => {
      processed.push(`overflow:${lineCount}`);
    },
    schedule: () => () => {},
  });

  processor.enqueueOutput('READY\n');
  processor.enqueueInput('abcdef\n');
  processor.flush();

  assert.deepEqual(processed, ['output:READY\n', 'overflow:1']);
});

test('deferred output trigger processor suppresses retained multi-line input echo after overflow', () => {
  const scheduled: Array<() => void> = [];
  const filter = createTerminalOutputTriggerFilter();
  const retainedInput = 'READY c\nREADY d\n';
  const fullInput = `READY a\nREADY b\n${retainedInput}`;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 64,
    maxOutputBytesPerFlush: 128,
    maxPendingInputBytes: retainedInput.length,
    processOutput: () => {},
    processInput: (chunk) => {
      filter.noteUserInput(chunk);
    },
    processInputOverflow: (lineCount) => {
      filter.markInputEchoUncertain(lineCount);
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueInput(fullInput);
  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  const result = filter.processServerChunk(`${fullInput}server READY\n`);
  assert.equal(result.scannableText, 'server READY\n');
});

test('deferred output trigger processor keeps pending scan output bounded', () => {
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 64,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 4,
    processOutput: (chunk) => processed.push(chunk),
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('x'.repeat(80));
  processor.enqueueOutput('READY');

  assert.equal(processor.getPendingOutputBytes(), 12);

  scheduled.shift()?.();

  assert.equal(processed.join('').length, 12);
  assert.equal(processed.join('').endsWith('READY'), true);
});

test('deferred output trigger processor defers dropped output maintenance work', () => {
  const dropped: string[] = [];
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (chunk) => dropped.push(chunk),
    processOutput: (chunk) => processed.push(chunk),
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('x'.repeat(40));
  processor.enqueueOutput('READY');

  assert.deepEqual(dropped, []);
  assert.deepEqual(processed, []);

  scheduled.shift()?.();

  assert.equal(dropped.join('').length, 8);
  assert.deepEqual(processed, []);
  assert.equal(scheduled.length, 1);
});

test('deferred output trigger processor applies output metadata in queue order', () => {
  const scanned: string[] = [];
  const scheduled: Array<() => void> = [];
  let suppressed = false;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 64,
    maxOutputBytesPerFlush: 64,
    processOutput: (chunk, meta) => {
      if (meta?.droppedOutputMayAffectTerminalState) {
        suppressed = true;
      }
      if (!suppressed) {
        scanned.push(chunk);
      }
    },
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('READY');
  processor.enqueueOutput('AFTER_DROP', { droppedOutputMayAffectTerminalState: true });

  scheduled.shift()?.();

  assert.deepEqual(scanned, ['READY']);
});

test('deferred output trigger processor preserves metadata when trimmed output is fully dropped', () => {
  const scanned: string[] = [];
  const scheduled: Array<() => void> = [];
  let suppressed = false;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 64,
    maxOutputBytesPerFlush: 64,
    maxPendingOutputBytes: 5,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (_chunk, meta) => {
      if (meta?.droppedOutputMayAffectTerminalState) {
        suppressed = true;
      }
    },
    processOutput: (chunk) => {
      if (!suppressed) {
        scanned.push(chunk);
      }
    },
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('DROP', { droppedOutputMayAffectTerminalState: true });
  processor.enqueueOutput('READY');

  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.deepEqual(scanned, []);
});

test('deferred output trigger processor caps dropped maintenance before retained output', () => {
  const dropped: string[] = [];
  const processed: string[] = [];
  const scheduled: Array<() => void> = [];
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (chunk) => dropped.push(chunk),
    processOutput: (chunk) => processed.push(chunk),
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('x'.repeat(200));
  processor.enqueueOutput('READY');

  scheduled.shift()?.();
  assert.equal(dropped.join('').length, 8);
  assert.deepEqual(processed, []);

  scheduled.shift()?.();
  assert.equal(processed.join('').endsWith('READY'), true);
});

test('deferred output trigger processor inspects dropped overflow with retained context', () => {
  let mayAffectAlternateScreen = false;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputBytesPerFlush: 5,
    maxPendingOutputBytes: 0,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: () => {},
    processDroppedOutputOverflow: (overflow) => {
      mayAffectAlternateScreen ||= droppedOutputOverflowMayAffectAlternateScreenState(overflow);
    },
    processOutput: () => {},
    processInput: () => {},
    schedule: () => () => {},
  });

  processor.enqueueOutput('\x1b[?10');
  processor.enqueueOutput('49hREADY');

  assert.equal(mayAffectAlternateScreen, true);
});

test('deferred output trigger processor does not carry dropped context across real output', () => {
  const scheduled: Array<() => void> = [];
  let mayAffectAlternateScreen = false;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 8,
    maxOutputBytesPerFlush: 3,
    maxPendingOutputBytes: 1,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: () => {},
    processDroppedOutputOverflow: (overflow) => {
      mayAffectAlternateScreen ||= droppedOutputOverflowMayAffectAlternateScreenState(overflow);
    },
    processOutput: () => {},
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('\x1b[?Z');
  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }
  processor.enqueueOutput('1049hREADY');

  assert.equal(mayAffectAlternateScreen, false);
});

test('deferred output trigger processor suppresses retained scans after dropped maintenance overflow', () => {
  const scannable: string[] = [];
  const scheduled: Array<() => void> = [];
  const filter = createTerminalOutputTriggerFilter();
  let suppressScan = false;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (chunk) => {
      filter.processServerChunk(chunk);
    },
    processDroppedOutputOverflow: (overflow) => {
      if (droppedOutputOverflowMayAffectAlternateScreenState(overflow)) {
        suppressScan = true;
      }
    },
    processOutput: (chunk) => {
      const result = filter.processServerChunk(chunk);
      if (!suppressScan && result.scannableText && !result.alternateScreenActive) {
        scannable.push(result.scannableText);
      }
    },
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput(`${'x'.repeat(40)}\x1b[?1049h${'y'.repeat(40)}`);
  processor.enqueueOutput('READY');

  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.equal(suppressScan, true);
  assert.deepEqual(scannable, []);
});

test('deferred output trigger processor can recover from dropped split alternate-screen leave', () => {
  const scannable: string[] = [];
  const scheduled: Array<() => void> = [];
  const filter = createTerminalOutputTriggerFilter();
  const recoveryFilter = createTerminalOutputTriggerFilter();
  let suppressScan = true;
  const maybeRecover = (chunk: string) => {
    const recovery = recoveryFilter.processServerChunk(chunk);
    if (recovery.meta.alternateScreenAction === 'leave' && !recovery.alternateScreenActive) {
      suppressScan = false;
      recoveryFilter.reset();
      return true;
    }
    return false;
  };
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 16,
    maxOutputBytesPerFlush: 16,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (chunk) => {
      filter.processServerChunk(chunk);
      if (suppressScan) {
        maybeRecover(chunk);
      }
    },
    processOutput: (chunk) => {
      const result = filter.processServerChunk(chunk);
      if (suppressScan) {
        maybeRecover(chunk);
        return;
      }
      if (result.scannableText && !result.alternateScreenActive) {
        scannable.push(result.scannableText);
      }
    },
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('\x1b[?10');
  processor.enqueueOutput('49lREADY');

  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.equal(suppressScan, false);
  assert.deepEqual(scannable, []);

  processor.enqueueOutput('NEXT');
  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.deepEqual(scannable, ['NEXT']);
});

test('deferred output trigger processor keeps scanning after plain dropped maintenance overflow', () => {
  const scannable: string[] = [];
  const scheduled: Array<() => void> = [];
  const filter = createTerminalOutputTriggerFilter();
  let suppressScan = false;
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 8,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (chunk) => {
      filter.processServerChunk(chunk);
    },
    processDroppedOutputOverflow: (overflow) => {
      if (droppedOutputOverflowMayAffectAlternateScreenState(overflow)) {
        suppressScan = true;
      }
    },
    processOutput: (chunk) => {
      const result = filter.processServerChunk(chunk);
      if (!suppressScan && result.scannableText && !result.alternateScreenActive) {
        scannable.push(result.scannableText);
      }
    },
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput('x'.repeat(200));
  processor.enqueueOutput('READY');

  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.equal(suppressScan, false);
  assert.equal(scannable.join('').endsWith('READY'), true);
});

test('dropped output overflow detection ignores color sequences but catches alternate screen candidates', () => {
  assert.equal(droppedOutputOverflowMayAffectAlternateScreenState({
    retainedPrefix: 'plain',
    discardedSuffix: '\x1b[31mcolored text',
  }), false);
  assert.equal(droppedOutputOverflowMayAffectAlternateScreenState({
    retainedPrefix: '\x1b[?10',
    discardedSuffix: '49hmore output',
  }), true);
  assert.equal(droppedOutputOverflowMayAffectAlternateScreenState({
    retainedPrefix: 'plain',
    discardedSuffix: '\x1b[?1;1049l',
  }), true);
  assert.equal(droppedOutputOverflowMayAffectAlternateScreenState({
    retainedPrefix: `before\x1b[?1;2;3;4;5;6;7;8;9;10`,
    discardedSuffix: ';1049hafter',
  }), true);
  assert.deepEqual(inspectDroppedOutputOverflowAlternateScreenState({
    retainedPrefix: '\x1b[?1049h',
    discardedSuffix: `${'x'.repeat(5000)}\x1b[?1;1049l`,
  }), {
    mayAffectAlternateScreen: true,
    mayAffectScanState: false,
    finalAction: 'leave',
  });
  assert.deepEqual(inspectDroppedOutputOverflowAlternateScreenState({
    retainedPrefix: 'plain',
    discardedSuffix: `${'x'.repeat(3000)}\x1b[?1049h${'y'.repeat(3000)}`,
  }), {
    mayAffectAlternateScreen: true,
    mayAffectScanState: false,
    finalAction: undefined,
  });
  assert.deepEqual(inspectDroppedOutputOverflowAlternateScreenState({
    retainedPrefix: 'plain',
    discardedSuffix: `\x1b[?1049l${'x'.repeat(3000)}\x1b[?1049h${'y'.repeat(3000)}`,
  }), {
    mayAffectAlternateScreen: true,
    mayAffectScanState: false,
    finalAction: undefined,
  });
  assert.deepEqual(inspectDroppedOutputOverflowAlternateScreenState({
    retainedPrefix: 'plain',
    discardedSuffix: `${'x'.repeat(5000)}\x1b[?1049lplain\x1b[?10`,
  }), {
    mayAffectAlternateScreen: true,
    mayAffectScanState: true,
    finalAction: undefined,
  });
  assert.deepEqual(inspectDroppedOutputOverflowAlternateScreenState({
    retainedPrefix: 'plain',
    discardedSuffix: `\x1b[?1049l${'x'.repeat(2500)}\x1b[?10`,
  }), {
    mayAffectAlternateScreen: true,
    mayAffectScanState: true,
    finalAction: undefined,
  });
  assert.deepEqual(inspectDroppedOutputOverflowAlternateScreenState({
    retainedPrefix: '\x1b[31',
    discardedSuffix: 'mREADY',
  }), {
    mayAffectAlternateScreen: false,
    mayAffectScanState: true,
    finalAction: undefined,
  });
});

test('deferred output trigger processor preserves filter state for trimmed output', () => {
  const scannable: string[] = [];
  const scheduled: Array<() => void> = [];
  const filter = createTerminalOutputTriggerFilter();
  const processor = createDeferredOutputTriggerEventProcessor({
    maxOutputChunkBytes: 4,
    maxOutputBytesPerFlush: 64,
    maxPendingOutputBytes: 8,
    pendingOutputOverlapChars: 0,
    processDroppedOutput: (chunk) => {
      filter.processServerChunk(chunk);
    },
    processOutput: (chunk) => {
      const result = filter.processServerChunk(chunk);
      if (result.scannableText && !result.alternateScreenActive) {
        scannable.push(result.scannableText);
      }
    },
    processInput: () => {},
    schedule: (callback) => {
      scheduled.push(callback);
      return () => {};
    },
  });

  processor.enqueueOutput(`\x1b[?1049h${'x'.repeat(80)}`);
  processor.enqueueOutput('READY');

  assert.equal(processor.getPendingOutputBytes(), 8);

  while (scheduled.length > 0) {
    scheduled.shift()?.();
  }

  assert.deepEqual(scannable, []);
});
