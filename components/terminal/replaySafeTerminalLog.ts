type CsiSequence = {
  raw: string;
  end: number;
  final: string;
  params: string;
};

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\x9c";
const CSI = "\x9b";
const MAX_PENDING_ESCAPE_CHARS = 4096;

type ControlStringMode = "osc" | "string";

export interface ReplaySafeTerminalLogSanitizer {
  append(input: string): string;
  finish(): string;
}

const isCsiFinal = (ch: string): boolean => ch >= "@" && ch <= "~";

const readCsiSequence = (input: string, index: number): CsiSequence | null => {
  const isEscCsi = input[index] === ESC && input[index + 1] === "[";
  const isC1Csi = input[index] === CSI;
  if (!isEscCsi && !isC1Csi) return null;

  const paramsStart = isEscCsi ? index + 2 : index + 1;
  for (let i = paramsStart; i < input.length; i += 1) {
    if (isCsiFinal(input[i])) {
      return {
        raw: input.slice(index, i + 1),
        end: i + 1,
        final: input[i],
        params: input.slice(paramsStart, i),
      };
    }
  }

  return null;
};

const startsCsiSequence = (input: string, index: number): boolean =>
  (input[index] === ESC && input[index + 1] === "[") || input[index] === CSI;

const isEscControlStringIntroducer = (ch: string): boolean =>
  ch === "]" || ch === "P" || ch === "_" || ch === "^" || ch === "X";

const isC1ControlStringIntroducer = (ch: string): boolean =>
  ch === "\x90" || ch === "\x98" || ch === "\x9d" || ch === "\x9e" || ch === "\x9f";

const getControlStringStart = (
  input: string,
  index: number,
): { mode: ControlStringMode; dataStart: number } | null => {
  const ch = input[index];

  if (ch === ESC) {
    const introducer = input[index + 1];
    if (!isEscControlStringIntroducer(introducer)) return null;
    return {
      mode: introducer === "]" ? "osc" : "string",
      dataStart: index + 2,
    };
  }

  if (isC1ControlStringIntroducer(ch)) {
    return {
      mode: ch === "\x9d" ? "osc" : "string",
      dataStart: index + 1,
    };
  }

  return null;
};

const parseCsiParams = (params: string): Array<number | undefined> => {
  const parameterBytes = params.replace(/[?><=]/g, "").replace(/[ -/]+$/g, "");
  if (!parameterBytes) return [];
  return parameterBytes.split(";").map((part) => {
    if (!part) return undefined;
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : undefined;
  });
};

const normalizedPosition = (value: number | undefined): number => Math.max(1, value ?? 1);

const isCursorHomeSequence = (sequence: CsiSequence): boolean => {
  if (sequence.final !== "H" && sequence.final !== "f") return false;
  const values = parseCsiParams(sequence.params);
  return normalizedPosition(values[0]) === 1 && normalizedPosition(values[1]) === 1;
};

const isCursorMovementSequence = (sequence: CsiSequence): boolean =>
  sequence.final === "A"
  || sequence.final === "B"
  || sequence.final === "C"
  || sequence.final === "D"
  || sequence.final === "E"
  || sequence.final === "F"
  || sequence.final === "H"
  || sequence.final === "f"
  || sequence.final === "G"
  || sequence.final === "`"
  || sequence.final === "d"
  || sequence.final === "a"
  || sequence.final === "e";

const isCursorStateSequence = (sequence: CsiSequence): boolean =>
  sequence.final === "s"
  || sequence.final === "u"
  || (
    (sequence.final === "h" || sequence.final === "l")
    && sequence.params.includes("?")
    && parseCsiParams(sequence.params).includes(1048)
  );

const isUnsafeCursorReplaySequence = (sequence: CsiSequence): boolean =>
  isCursorMovementSequence(sequence) || isCursorStateSequence(sequence);

const getEraseDisplayMode = (sequence: CsiSequence): number | null => {
  if (sequence.final !== "J") return null;
  const values = parseCsiParams(sequence.params);
  return values[0] ?? 0;
};

const isEraseSequence = (sequence: CsiSequence): boolean =>
  sequence.final === "J" || sequence.final === "K" || sequence.final === "X";

const isSafePendingAfterCursorHomeSequence = (sequence: CsiSequence): boolean =>
  !isUnsafeCursorReplaySequence(sequence) && !isEraseSequence(sequence);

const getAlternateScreenMode = (sequence: CsiSequence): "enter" | "exit" | null => {
  if (sequence.final !== "h" && sequence.final !== "l") return null;
  if (!sequence.params.includes("?")) return null;
  const isAlternateScreen = parseCsiParams(sequence.params).some((value) =>
    value === 47 || value === 1047 || value === 1049,
  );
  if (!isAlternateScreen) return null;
  return sequence.final === "h" ? "enter" : "exit";
};

const isC1SingleCharCursorControl = (ch: string): boolean =>
  ch === "\x84" || ch === "\x85" || ch === "\x8d";

const isEscSingleCharCursorControl = (ch: string): boolean =>
  ch === "D" || ch === "E" || ch === "M";

class ReplaySafeTerminalLogSanitizerImpl implements ReplaySafeTerminalLogSanitizer {
  private pendingInput = "";
  private pendingCursorHome = "";
  private pendingAfterCursorHome = "";
  private replaySafePendingAfterCursorHome = "";
  private pendingAfterCursorHomeOverflowed = false;
  private controlStringMode: ControlStringMode | null = null;
  private controlStringEscPending = false;
  private discardingCsi = false;
  private inClearCluster = false;
  private protectingClearedHistory = false;
  private hasOutput = false;
  private lastOutputChar = "";

  append(input: string): string {
    let output = "";
    const data = this.pendingInput + input;
    this.pendingInput = "";

    const appendOutput = (next: string) => {
      if (!next) return;
      output += next;
      this.hasOutput = true;
      this.lastOutputChar = next[next.length - 1];
    };

    const flushPendingCursorHome = () => {
      if (!this.pendingCursorHome) return;
      if (this.protectingClearedHistory) {
        appendOutput(this.replaySafePendingAfterCursorHome);
      } else {
        appendOutput(this.pendingCursorHome);
        appendOutput(this.pendingAfterCursorHome);
      }
      this.pendingCursorHome = "";
      this.pendingAfterCursorHome = "";
      this.replaySafePendingAfterCursorHome = "";
      this.pendingAfterCursorHomeOverflowed = false;
    };

    const emitClearSeparator = (preservePendingControls: boolean) => {
      const preservedControls = preservePendingControls ? this.replaySafePendingAfterCursorHome : "";
      this.pendingCursorHome = "";
      this.pendingAfterCursorHome = "";
      this.replaySafePendingAfterCursorHome = "";
      this.pendingAfterCursorHomeOverflowed = false;
      if (!this.inClearCluster && this.hasOutput) {
        appendOutput(/[\r\n]$/.test(this.lastOutputChar) ? "\r\n" : "\r\n\r\n");
      }
      appendOutput(preservedControls);
      this.inClearCluster = true;
      this.protectingClearedHistory = true;
    };

    for (let i = 0; i < data.length;) {
      if (this.discardingCsi) {
        i = this.consumeDiscardedCsi(data, i);
        continue;
      }

      if (this.controlStringMode) {
        i = this.consumeControlString(data, i);
        continue;
      }

      const controlStringStart = getControlStringStart(data, i);
      if (controlStringStart) {
        this.controlStringMode = controlStringStart.mode;
        this.controlStringEscPending = false;
        i = controlStringStart.dataStart;
        continue;
      }

      const sequence = readCsiSequence(data, i);

      if (!sequence && startsCsiSequence(data, i)) {
        this.setPendingEscapeInput(data.slice(i));
        break;
      }

      if (sequence) {
        const alternateScreenMode = getAlternateScreenMode(sequence);
        if (alternateScreenMode) {
          if (alternateScreenMode === "enter") {
            emitClearSeparator(false);
          }
          i = sequence.end;
          continue;
        }

        if (isCursorHomeSequence(sequence)) {
          if (!this.inClearCluster) {
            if (!this.pendingCursorHome) {
              flushPendingCursorHome();
            }
            this.pendingCursorHome = sequence.raw;
          }
          i = sequence.end;
          continue;
        }

        if (this.protectingClearedHistory && isUnsafeCursorReplaySequence(sequence)) {
          i = sequence.end;
          continue;
        }

        const eraseMode = getEraseDisplayMode(sequence);
        if (eraseMode !== null) {
          if (eraseMode === 3) {
            emitClearSeparator(false);
          } else if (eraseMode === 1) {
            emitClearSeparator(false);
          } else if (eraseMode === 2 || (eraseMode === 0 && this.pendingCursorHome)) {
            emitClearSeparator(true);
          } else {
            flushPendingCursorHome();
            appendOutput(sequence.raw);
            this.inClearCluster = false;
          }
          i = sequence.end;
          continue;
        }

        if (this.pendingCursorHome) {
          this.appendPendingAfterCursorHome(sequence);
          i = sequence.end;
          continue;
        }

        const preserveClearCluster = this.inClearCluster;
        flushPendingCursorHome();
        appendOutput(sequence.raw);
        this.inClearCluster = preserveClearCluster;
        i = sequence.end;
        continue;
      }

      if (this.protectingClearedHistory && isC1SingleCharCursorControl(data[i])) {
        i += 1;
        continue;
      }

      if (data[i] === ESC) {
        if (i + 1 >= data.length) {
          this.setPendingEscapeInput(data.slice(i));
          break;
        }

        if (data[i + 1] === "c") {
          emitClearSeparator(false);
          i += 2;
          continue;
        }

        if (this.protectingClearedHistory && (data[i + 1] === "7" || data[i + 1] === "8")) {
          i += 2;
          continue;
        }

        if (this.protectingClearedHistory && isEscSingleCharCursorControl(data[i + 1])) {
          i += 2;
          continue;
        }
      }

      flushPendingCursorHome();
      appendOutput(data[i]);
      this.inClearCluster = false;
      i += 1;
    }

    return output;
  }

  finish(): string {
    this.pendingInput = "";
    this.controlStringMode = null;
    this.controlStringEscPending = false;
    this.discardingCsi = false;

    let output = "";
    if (this.pendingCursorHome) {
      output = this.pendingCursorHome + this.pendingAfterCursorHome;
      this.hasOutput = true;
      this.lastOutputChar = output[output.length - 1];
      this.pendingCursorHome = "";
      this.pendingAfterCursorHome = "";
      this.replaySafePendingAfterCursorHome = "";
      this.pendingAfterCursorHomeOverflowed = false;
    }
    return output;
  }

  private appendPendingAfterCursorHome(sequence: CsiSequence): void {
    if (this.pendingAfterCursorHomeOverflowed) return;

    const nextLength = this.pendingAfterCursorHome.length + sequence.raw.length;
    if (nextLength > MAX_PENDING_ESCAPE_CHARS) {
      this.pendingAfterCursorHome = "";
      this.replaySafePendingAfterCursorHome = "";
      this.pendingAfterCursorHomeOverflowed = true;
      return;
    }

    this.pendingAfterCursorHome += sequence.raw;
    if (isSafePendingAfterCursorHomeSequence(sequence)) {
      this.replaySafePendingAfterCursorHome += sequence.raw;
    }
  }

  private setPendingEscapeInput(input: string): void {
    if (input.length > MAX_PENDING_ESCAPE_CHARS) {
      this.pendingInput = "";
      this.discardingCsi = true;
      return;
    }
    this.pendingInput = input;
  }

  private consumeDiscardedCsi(input: string, index: number): number {
    for (let i = index; i < input.length; i += 1) {
      if (isCsiFinal(input[i])) {
        this.discardingCsi = false;
        return i + 1;
      }
    }

    return input.length;
  }

  private consumeControlString(input: string, index: number): number {
    let i = index;

    if (this.controlStringEscPending) {
      if (input[i] === "\\") {
        this.controlStringMode = null;
        this.controlStringEscPending = false;
        return i + 1;
      }
      this.controlStringEscPending = false;
    }

    for (; i < input.length; i += 1) {
      if (this.controlStringMode === "osc" && input[i] === BEL) {
        this.controlStringMode = null;
        return i + 1;
      }
      if (input[i] === ST) {
        this.controlStringMode = null;
        return i + 1;
      }
      if (input[i] === ESC) {
        if (i + 1 >= input.length) {
          this.controlStringEscPending = true;
          return input.length;
        }
        if (input[i + 1] === "\\") {
          this.controlStringMode = null;
          return i + 2;
        }
      }
    }

    return input.length;
  }
}

export const createReplaySafeTerminalLogSanitizer = (): ReplaySafeTerminalLogSanitizer =>
  new ReplaySafeTerminalLogSanitizerImpl();

/**
 * Convert terminal output into a form that can be replayed in LogView without
 * allowing shell `clear` / ED2 / ED3 controls to wipe earlier log history.
 */
export function createReplaySafeTerminalLog(input: string): string {
  const sanitizer = createReplaySafeTerminalLogSanitizer();
  return sanitizer.append(input) + sanitizer.finish();
}
