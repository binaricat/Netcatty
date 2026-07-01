const MAX_PENDING_ECHO = 4096;
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

export type TerminalAlternateScreenAction = 'enter' | 'leave';

export type TerminalOutputChunkMeta = {
  rawLen: number;
  dropReason?:
    | 'empty-chunk'
    | 'awaiting-submitted-echo'
    | 'alternate-screen-active'
    | 'pending-escape'
    | 'user-echo-only'
    | 'control-only'
    | 'editing-input-line';
  submittedEchoLine?: string;
  submittedEchoCandidateLen: number;
  afterSubmittedLen: number;
  afterUserEchoLen: number;
  scannableLen: number;
  alternateScreenAction?: TerminalAlternateScreenAction;
};

export type TerminalOutputTriggerFilter = {
  noteUserInput: (data: string) => void;
  processServerChunk: (chunk: string) => {
    scannableText: string;
    alternateScreenActive: boolean;
    meta: TerminalOutputChunkMeta;
  };
  reset: () => void;
  resetInputState: () => void;
  resetPendingEscape: () => void;
  markInputEchoUncertain: (lineCount?: number) => void;
};

export function getTerminalAlternateScreenAction(sequence: string): TerminalAlternateScreenAction | null {
  if (!sequence.startsWith('\x1b[') || sequence.length < 3) return null;
  const final = sequence.at(-1);
  if (final !== 'h' && final !== 'l') return null;

  const params = sequence.slice(2, -1);
  if (!params.startsWith('?')) return null;

  const modes = params
    .slice(1)
    .split(';')
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);

  if (!modes.some((mode) => ALTERNATE_SCREEN_MODES.has(mode))) {
    return null;
  }

  return final === 'h' ? 'enter' : 'leave';
}

function readCsiSequence(input: string, startIndex: number): { sequence: string; end: number } | null {
  if (input[startIndex] !== '\x1b' || input[startIndex + 1] !== '[') return null;
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

/** OSC: ESC ] payload BEL (0x07) or ST (ESC \\). */
function readOscSequence(input: string, startIndex: number): { sequence: string; end: number } | null {
  if (input[startIndex] !== '\x1b' || input[startIndex + 1] !== ']') return null;
  for (let index = startIndex + 2; index < input.length; index += 1) {
    if (input[index] === '\x07') {
      return {
        sequence: input.slice(startIndex, index + 1),
        end: index + 1,
      };
    }
    if (input[index] === '\x1b' && input[index + 1] === '\\') {
      return {
        sequence: input.slice(startIndex, index + 2),
        end: index + 2,
      };
    }
  }
  return null;
}

function readEscapeSequence(input: string, startIndex: number): { sequence: string; end: number } | null {
  if (input[startIndex] !== '\x1b') return null;
  if (startIndex + 1 >= input.length) return null;

  const next = input[startIndex + 1];
  if (next === '[') return readCsiSequence(input, startIndex);
  if (next === ']') return readOscSequence(input, startIndex);

  const nextCode = next.charCodeAt(0);
  if (nextCode >= 0x40 && nextCode <= 0x7e) {
    return {
      sequence: input.slice(startIndex, startIndex + 2),
      end: startIndex + 2,
    };
  }

  return null;
}

function stripUserEcho(pendingEcho: string, chunk: string): { pendingEcho: string; filtered: string } {
  if (!pendingEcho || !chunk) {
    return { pendingEcho, filtered: chunk };
  }

  let echoIndex = 0;
  let chunkIndex = 0;
  let matchedPrintable = 0;

  while (echoIndex < pendingEcho.length && chunkIndex < chunk.length) {
    if (chunk[chunkIndex] === '\x1b') {
      const sequence = readEscapeSequence(chunk, chunkIndex);
      if (!sequence) break;
      chunkIndex = sequence.end;
      continue;
    }

    if (pendingEcho[echoIndex] === chunk[chunkIndex]) {
      echoIndex += 1;
      chunkIndex += 1;
      matchedPrintable += 1;
      continue;
    }
    break;
  }

  if (matchedPrintable > 0) {
    return {
      pendingEcho: pendingEcho.slice(echoIndex),
      filtered: chunk.slice(chunkIndex),
    };
  }

  return {
    pendingEcho: '',
    filtered: chunk,
  };
}

function isPrintableInput(char: string): boolean {
  const code = char.codePointAt(0);
  return code !== undefined && code >= 0x20 && code !== 0x7f;
}

function applyInputToLine(line: string, data: string): { line: string; submittedLine: string | null } {
  let nextLine = line;
  let submittedLine: string | null = null;
  for (const char of stripInputControlWrappers(data)) {
    if (char === '\r' || char === '\n') {
      submittedLine = nextLine;
      nextLine = '';
      continue;
    }
    if (char === '\x7f' || char === '\b') {
      nextLine = nextLine.slice(0, -1);
      continue;
    }
    if (isPrintableInput(char)) {
      nextLine += char;
    }
  }
  return { line: nextLine, submittedLine };
}

function consumeSuppressedEchoLines(
  input: string,
  lineCount: number,
  pendingLf: boolean,
  onEscapeSequence?: (sequence: string) => void,
): {
  input: string;
  lineCount: number;
  pendingLf: boolean;
  pendingEscape?: string;
} {
  let index = 0;
  let remainingLines = lineCount;
  let nextPendingLf = false;

  if (pendingLf && input[index] === '\n') {
    index += 1;
  }

  while (remainingLines > 0 && index < input.length) {
    const char = input[index];
    if (char === '\x1b') {
      const sequence = readEscapeSequence(input, index);
      if (sequence) {
        onEscapeSequence?.(sequence.sequence);
        index = sequence.end;
        continue;
      }
      return {
        input: '',
        lineCount: remainingLines,
        pendingLf: nextPendingLf,
        pendingEscape: input.slice(index),
      };
    }
    if (char === '\r') {
      remainingLines -= 1;
      index += 1;
      if (input[index] === '\n') {
        index += 1;
      } else if (index === input.length) {
        nextPendingLf = true;
      }
      continue;
    }
    if (char === '\n') {
      remainingLines -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }

  return {
    input: input.slice(index),
    lineCount: remainingLines,
    pendingLf: nextPendingLf,
  };
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function stripInputControlWrappers(data: string): string {
  return data.split(BRACKETED_PASTE_START).join('').split(BRACKETED_PASTE_END).join('');
}

function appendPendingEcho(pendingEcho: string, data: string): string {
  let next = pendingEcho;
  let index = 0;
  const sanitized = stripInputControlWrappers(data);
  while (index < sanitized.length) {
    const char = sanitized[index];
    if (char === '\r' || char === '\n') {
      index += 1;
      continue;
    }
    if (char === '\x1b') {
      const sequence = readEscapeSequence(sanitized, index);
      if (sequence) {
        index = sequence.end;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '\x7f') {
      next = next.slice(0, -1);
      index += 1;
      continue;
    }
    if (char === '\x08') {
      next += char;
      index += 1;
      continue;
    }
    if (isPrintableInput(char)) {
      next += char;
      index += 1;
      continue;
    }
    index += 1;
  }
  return next.slice(-MAX_PENDING_ECHO);
}

function stripSubmittedLineEcho(
  submittedLine: string | null,
  candidate: string,
  chunk: string,
): { submittedLine: string | null; candidate: string; filtered: string } {
  if (submittedLine === null || submittedLine.length === 0) {
    return { submittedLine: null, candidate: '', filtered: chunk };
  }

  const nextCandidate = candidate + chunk;
  const echoVariants = [
    `${submittedLine}\r\n`,
    `${submittedLine}\n`,
    `${submittedLine}\r`,
  ];
  const fullEcho = echoVariants.find((variant) => nextCandidate.startsWith(variant));
  if (fullEcho) {
    return {
      submittedLine: null,
      candidate: '',
      filtered: nextCandidate.slice(fullEcho.length),
    };
  }

  if (echoVariants.some((variant) => variant.startsWith(nextCandidate))) {
    return { submittedLine, candidate: nextCandidate, filtered: '' };
  }

  return {
    submittedLine: null,
    candidate: '',
    filtered: nextCandidate,
  };
}

export function createTerminalOutputTriggerFilter(): TerminalOutputTriggerFilter {
  let pendingEcho = '';
  let currentInputLine = '';
  let currentInputLineOverflowed = false;
  let submittedEchoLine: string | null = null;
  let submittedEchoCandidate = '';
  let alternateScreenActive = false;
  let pendingEscape = '';
  let inputEchoSuppressLines = 0;
  let inputEchoSuppressPendingLf = false;

  const resetInputState = () => {
    pendingEcho = '';
    currentInputLine = '';
    currentInputLineOverflowed = false;
    submittedEchoLine = null;
    submittedEchoCandidate = '';
  };

  const markInputEchoUncertain = (lineCount = 1) => {
    resetInputState();
    inputEchoSuppressPendingLf = false;
    inputEchoSuppressLines = Math.max(inputEchoSuppressLines, Math.max(1, lineCount));
  };

  const reset = () => {
    resetInputState();
    alternateScreenActive = false;
    pendingEscape = '';
    inputEchoSuppressLines = 0;
    inputEchoSuppressPendingLf = false;
  };

  const resetPendingEscape = () => {
    pendingEscape = '';
  };

  const noteUserInput = (data: string) => {
    if (!data) return;
    const inputState = applyInputToLine(currentInputLine, data);
    const inputLineOverflowed = currentInputLineOverflowed || inputState.line.length > MAX_PENDING_ECHO;
    currentInputLine = inputState.line.slice(-MAX_PENDING_ECHO);
    if (inputState.submittedLine !== null) {
      if (inputLineOverflowed || inputState.submittedLine.length > MAX_PENDING_ECHO) {
        markInputEchoUncertain();
      } else {
        submittedEchoLine = inputState.submittedLine;
        submittedEchoCandidate = '';
        pendingEcho = '';
      }
      return;
    }
    currentInputLineOverflowed = inputLineOverflowed;
    pendingEcho = appendPendingEcho(pendingEcho, data);
  };

  const processServerChunk = (chunk: string) => {
    let input = pendingEscape ? `${pendingEscape}${chunk}` : chunk;
    pendingEscape = '';
    let alternateScreenAction: TerminalAlternateScreenAction | undefined;

    const noteAlternateScreenSequence = (sequence: string) => {
      if (!sequence.startsWith('\x1b[')) return;
      const action = getTerminalAlternateScreenAction(sequence);
      if (action === 'enter') {
        alternateScreenActive = true;
        pendingEcho = '';
        alternateScreenAction = action;
      } else if (action === 'leave') {
        alternateScreenActive = false;
        pendingEcho = '';
        alternateScreenAction = action;
      }
    };

    if (inputEchoSuppressLines > 0 || inputEchoSuppressPendingLf) {
      const suppressed = consumeSuppressedEchoLines(
        input,
        inputEchoSuppressLines,
      inputEchoSuppressPendingLf,
      noteAlternateScreenSequence,
      );
      input = suppressed.input;
      inputEchoSuppressLines = suppressed.lineCount;
      inputEchoSuppressPendingLf = suppressed.pendingLf;
      pendingEscape = suppressed.pendingEscape ?? '';
      if (!input) {
        return {
          scannableText: '',
          alternateScreenActive,
          meta: {
            rawLen: chunk.length,
            dropReason: 'awaiting-submitted-echo',
            submittedEchoLine: undefined,
            submittedEchoCandidateLen: 0,
            afterSubmittedLen: 0,
            afterUserEchoLen: 0,
            scannableLen: 0,
            alternateScreenAction,
          },
        };
      }
      if (inputEchoSuppressLines > 0) {
        return {
          scannableText: '',
          alternateScreenActive,
          meta: {
            rawLen: chunk.length,
            dropReason: 'awaiting-submitted-echo',
            submittedEchoLine: undefined,
            submittedEchoCandidateLen: 0,
            afterSubmittedLen: 0,
            afterUserEchoLen: 0,
            scannableLen: 0,
            alternateScreenAction,
          },
        };
      }
    }

    const submitted = stripSubmittedLineEcho(submittedEchoLine, submittedEchoCandidate, input);
    submittedEchoLine = submitted.submittedLine;
    submittedEchoCandidate = submitted.candidate;
    if (!submitted.filtered) {
      return {
        scannableText: '',
        alternateScreenActive,
        meta: {
          rawLen: chunk.length,
          dropReason: chunk.length === 0
            ? 'empty-chunk'
            : 'awaiting-submitted-echo',
          submittedEchoLine: submittedEchoLine ?? undefined,
          submittedEchoCandidateLen: submittedEchoCandidate.length,
          afterSubmittedLen: 0,
          afterUserEchoLen: 0,
          scannableLen: 0,
        },
      };
    }

    const { pendingEcho: nextPendingEcho, filtered } = stripUserEcho(pendingEcho, submitted.filtered);
    pendingEcho = nextPendingEcho;

    let scannableText = '';
    let hitPendingEscape = false;
    for (let index = 0; index < filtered.length; index += 1) {
      if (filtered[index] !== '\x1b') {
        if (!alternateScreenActive) {
          scannableText += filtered[index];
        }
        continue;
      }

      const sequence = readEscapeSequence(filtered, index);
      if (!sequence) {
        pendingEscape = filtered.slice(index);
        hitPendingEscape = true;
        break;
      }

      noteAlternateScreenSequence(sequence.sequence);

      index = sequence.end - 1;
    }

    let dropReason: TerminalOutputChunkMeta['dropReason'];
    if (currentInputLine.length > 0) {
      scannableText = '';
      dropReason = 'editing-input-line';
    } else if (!scannableText) {
      if (hitPendingEscape) {
        dropReason = 'pending-escape';
      } else if (alternateScreenActive) {
        dropReason = 'alternate-screen-active';
      } else if (filtered.length === 0) {
        dropReason = 'user-echo-only';
      } else {
        dropReason = 'control-only';
      }
    }

    return {
      scannableText,
      alternateScreenActive,
      meta: {
        rawLen: chunk.length,
        dropReason,
        submittedEchoLine: submittedEchoLine ?? undefined,
        submittedEchoCandidateLen: submittedEchoCandidate.length,
        afterSubmittedLen: submitted.filtered.length,
        afterUserEchoLen: filtered.length,
        scannableLen: scannableText.length,
        alternateScreenAction,
      },
    };
  };

  return {
    noteUserInput,
    processServerChunk,
    reset,
    resetInputState,
    resetPendingEscape,
    markInputEchoUncertain,
  };
}
