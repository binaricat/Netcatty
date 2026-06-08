export type TerminalOutputTimestampPrefixer = {
  append: (data: string) => string;
  reset: () => void;
  setAlternateScreenActive: (active: boolean) => void;
};

type TerminalOutputTimestampPrefixerOptions = {
  now?: () => Date;
};

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export const formatTerminalOutputTimestamp = (date: Date, restoreSequence = ""): string => (
  `\x1b[2;90m[${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}] \x1b[22;39m${restoreSequence}`
);

/**
 * Strips timestamp prefixes from terminal output selection text.
 * Timestamps injected by {@link formatTerminalOutputTimestamp} appear as
 * `[HH:MM:SS] ` at the start of lines in the buffer, so this regex removes
 * them from copied text. Only strips at line boundaries so in-line content
 * that happens to match the pattern is left intact.
 */
export const stripTerminalOutputTimestamps = (text: string): string =>
  text.replace(/^\[\d{2}:\d{2}:\d{2}\] /gm, "");

const isCsiFinalByte = (char: string): boolean => char >= "@" && char <= "~";

const readEscapeSequence = (
  data: string,
  startIndex: number,
): { sequence: string; endIndex: number; complete: boolean; isColorSequence: boolean } | null => {
  if (data[startIndex] !== "\x1b") return null;
  const next = data[startIndex + 1];
  if (!next) {
    return { sequence: "\x1b", endIndex: startIndex, complete: false, isColorSequence: false };
  }

  if (next === "[") {
    for (let index = startIndex + 2; index < data.length; index += 1) {
      if (isCsiFinalByte(data[index])) {
        return {
          sequence: data.slice(startIndex, index + 1),
          endIndex: index,
          complete: true,
          isColorSequence: data[index] === "m",
        };
      }
    }
    return {
      sequence: data.slice(startIndex),
      endIndex: data.length - 1,
      complete: false,
      isColorSequence: false,
    };
  }

  if (next === "]") {
    for (let index = startIndex + 2; index < data.length; index += 1) {
      if (data[index] === "\u0007") {
        return {
          sequence: data.slice(startIndex, index + 1),
          endIndex: index,
          complete: true,
          isColorSequence: false,
        };
      }
      if (data[index] === "\x1b" && data[index + 1] === "\\") {
        return {
          sequence: data.slice(startIndex, index + 2),
          endIndex: index + 1,
          complete: true,
          isColorSequence: false,
        };
      }
    }
    return {
      sequence: data.slice(startIndex),
      endIndex: data.length - 1,
      complete: false,
      isColorSequence: false,
    };
  }

  if (next === "P" || next === "^" || next === "_" || next === "X") {
    for (let index = startIndex + 2; index < data.length; index += 1) {
      if (data[index] === "\x1b" && data[index + 1] === "\\") {
        return {
          sequence: data.slice(startIndex, index + 2),
          endIndex: index + 1,
          complete: true,
          isColorSequence: false,
        };
      }
    }
    return {
      sequence: data.slice(startIndex),
      endIndex: data.length - 1,
      complete: false,
      isColorSequence: false,
    };
  }

  return {
    sequence: data.slice(startIndex, startIndex + 2),
    endIndex: startIndex + 1,
    complete: true,
    isColorSequence: false,
  };
};

const getCsiFinal = (sequence: string): string | null => {
  if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
  return sequence.at(-1) ?? null;
};

const getCsiParams = (sequence: string): string => sequence.slice(2, -1);

const getAlternateScreenAction = (sequence: string): "enter" | "leave" | null => {
  const final = getCsiFinal(sequence);
  if (final !== "h" && final !== "l") return null;

  const params = getCsiParams(sequence);
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

const parseSgrParams = (sequence: string): number[] => {
  if (getCsiFinal(sequence) !== "m") return [];
  const params = getCsiParams(sequence);
  if (params === "") return [0];
  return params.split(";").map((part) => {
    if (part === "") return 0;
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
};

const isPrintableOutput = (char: string): boolean => {
  if (char === "\t") return true;
  const code = char.codePointAt(0);
  return code !== undefined && code >= 0x20 && code !== 0x7f;
};

export const createTerminalOutputTimestampPrefixer = (
  options: TerminalOutputTimestampPrefixerOptions = {},
): TerminalOutputTimestampPrefixer => {
  const now = options.now ?? (() => new Date());
  let atLineStart = true;
  let currentLinePrefixed = false;
  let pendingEscapeSequence = "";
  let suspendedForAlternateScreen = false;
  const activeStyleFlags = new Set<number>();
  let activeForeground: number[] = [];
  let activeBackground: number[] = [];

  const restoreActiveSgr = () => {
    const orderedFlags = [1, 2, 3, 4, 7, 9].filter((code) => activeStyleFlags.has(code));
    const codes = [...orderedFlags, ...activeForeground, ...activeBackground];
    return codes.length ? `\x1b[${codes.join(";")}m` : "";
  };

  const setFlag = (code: number) => {
    activeStyleFlags.add(code);
  };

  const applySgrSequence = (sequence: string) => {
    const codes = parseSgrParams(sequence);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] ?? 0;
      if (code === 0) {
        activeStyleFlags.clear();
        activeForeground = [];
        activeBackground = [];
      } else if (code === 1 || code === 2 || code === 3 || code === 4 || code === 7 || code === 9) {
        setFlag(code);
      } else if (code === 21) {
        activeStyleFlags.delete(1);
      } else if (code === 22) {
        activeStyleFlags.delete(1);
        activeStyleFlags.delete(2);
      } else if (code === 23) {
        activeStyleFlags.delete(3);
      } else if (code === 24) {
        activeStyleFlags.delete(4);
      } else if (code === 27) {
        activeStyleFlags.delete(7);
      } else if (code === 29) {
        activeStyleFlags.delete(9);
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        activeForeground = [code];
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        activeBackground = [code];
      } else if (code === 39) {
        activeForeground = [];
      } else if (code === 49) {
        activeBackground = [];
      } else if (code === 38 && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
        activeForeground = [38, 5, codes[index + 2]];
        index += 2;
      } else if (
        code === 38 &&
        codes[index + 1] === 2 &&
        codes[index + 2] !== undefined &&
        codes[index + 3] !== undefined &&
        codes[index + 4] !== undefined
      ) {
        activeForeground = [38, 2, codes[index + 2], codes[index + 3], codes[index + 4]];
        index += 4;
      } else if (code === 48 && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
        activeBackground = [48, 5, codes[index + 2]];
        index += 2;
      } else if (
        code === 48 &&
        codes[index + 1] === 2 &&
        codes[index + 2] !== undefined &&
        codes[index + 3] !== undefined &&
        codes[index + 4] !== undefined
      ) {
        activeBackground = [48, 2, codes[index + 2], codes[index + 3], codes[index + 4]];
        index += 4;
      }
    }
  };

  const prefixIfNeeded = () => {
    if (!atLineStart || currentLinePrefixed) return "";
    currentLinePrefixed = true;
    atLineStart = false;
    return formatTerminalOutputTimestamp(now(), restoreActiveSgr());
  };

  const resetLineState = () => {
    atLineStart = true;
    currentLinePrefixed = false;
  };

  return {
    append(data: string) {
      const input = pendingEscapeSequence ? `${pendingEscapeSequence}${data}` : data;
      pendingEscapeSequence = "";
      let output = "";

      for (let index = 0; index < input.length; index += 1) {
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
              output += sequence.sequence;
              suspendedForAlternateScreen = true;
              resetLineState();
              index = sequence.endIndex;
              continue;
            }
            if (alternateScreenAction === "leave") {
              output += sequence.sequence;
              suspendedForAlternateScreen = false;
              resetLineState();
              index = sequence.endIndex;
              continue;
            }
            if (suspendedForAlternateScreen) {
              output += sequence.sequence;
              index = sequence.endIndex;
              continue;
            }
            if (sequence.isColorSequence) {
              output += sequence.sequence;
              applySgrSequence(sequence.sequence);
            } else {
              output += sequence.sequence;
            }
            index = sequence.endIndex;
            continue;
          }
        }

        if (suspendedForAlternateScreen) {
          output += char;
          continue;
        }

        if (isPrintableOutput(char)) {
          output += prefixIfNeeded();
        }
        output += char;

        if (char === "\n") {
          resetLineState();
        } else if (char === "\r") {
          atLineStart = true;
        } else if (isPrintableOutput(char)) {
          atLineStart = false;
        }
      }

      return output;
    },
    reset() {
      resetLineState();
      pendingEscapeSequence = "";
      suspendedForAlternateScreen = false;
      activeStyleFlags.clear();
      activeForeground = [];
      activeBackground = [];
    },
    setAlternateScreenActive(active: boolean) {
      suspendedForAlternateScreen = active;
      if (active) {
        resetLineState();
      }
    },
  };
};
