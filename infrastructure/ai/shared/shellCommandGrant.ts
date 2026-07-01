import { bashArityPrefix } from './bashArity';

/** Commands whose always-allow patterns are skipped (OpenCode shell.ts CWD set). */
const CWD_COMMANDS = new Set([
  'cd',
  'chdir',
  'popd',
  'pushd',
  'push-location',
  'set-location',
]);

export function unquoteShellToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

export function tokenizeShellCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map(unquoteShellToken);
}

type HereDocTerminator = {
  text: string;
  stripLeadingTabs: boolean;
};

function lastNonWhitespaceChar(value: string): string | undefined {
  return value.match(/\S(?=\s*$)/)?.[0];
}

function readArithmeticExpansionEnd(segment: string, startIndex: number): number | null {
  if (segment[startIndex] !== '$' || segment[startIndex + 1] !== '(' || segment[startIndex + 2] !== '(') {
    return null;
  }

  let depth = 1;
  let quote: '"' | "'" | '`' | null = null;

  for (let index = startIndex + 3; index < segment.length; index += 1) {
    const char = segment[index]!;
    const next = segment[index + 1];

    if (quote) {
      if (char === '\\' && quote !== "'" && next) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '\\' && next) {
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      if (depth === 1 && next === ')') return index + 2;
      if (depth > 1) depth -= 1;
    }
  }

  return segment.length;
}

function hasExecutableShellExpansion(segment: string): boolean {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    const next = segment[index + 1];

    if (quote) {
      if (char === '\\' && quote === '"' && next) {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && char === '$' && next === '(') return true;
      if (quote === '"' && char === '`') return true;
      continue;
    }

    if (char === '\\' && next) {
      index += 1;
      continue;
    }

    if (char === "'") {
      quote = char;
      continue;
    }

    if (char === '"') {
      quote = char;
      continue;
    }

    if (char === '`') return true;
    if (char === '$' && next === '(') return true;
    if ((char === '<' || char === '>') && next === '(') return true;
  }

  return false;
}

function readEscapeDigits(
  value: string,
  startIndex: number,
  maxLength: number,
  pattern: RegExp,
): { digits: string; endIndex: number } | null {
  let endIndex = startIndex;
  while (
    endIndex < value.length
    && endIndex < startIndex + maxLength
    && pattern.test(value[endIndex]!)
  ) {
    endIndex += 1;
  }

  if (endIndex === startIndex) return null;
  return { digits: value.slice(startIndex, endIndex), endIndex: endIndex - 1 };
}

function codePointToString(codePoint: number): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return '';
  }
}

function readAnsiCEscape(value: string, backslashIndex: number): { text: string; endIndex: number } {
  const escapeIndex = backslashIndex + 1;
  const char = value[escapeIndex];
  if (!char) return { text: '\\', endIndex: backslashIndex };

  const simpleEscapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    e: '\x1B',
    E: '\x1B',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  };

  const simple = simpleEscapes[char];
  if (simple !== undefined) return { text: simple, endIndex: escapeIndex };

  if (char === 'x') {
    const digits = readEscapeDigits(value, escapeIndex + 1, 2, /[0-9a-fA-F]/);
    if (!digits) return { text: '\\x', endIndex: escapeIndex };
    return {
      text: codePointToString(Number.parseInt(digits.digits, 16)),
      endIndex: digits.endIndex,
    };
  }

  if (char === 'u' || char === 'U') {
    const digits = readEscapeDigits(value, escapeIndex + 1, char === 'u' ? 4 : 8, /[0-9a-fA-F]/);
    if (!digits) return { text: `\\${char}`, endIndex: escapeIndex };
    return {
      text: codePointToString(Number.parseInt(digits.digits, 16)),
      endIndex: digits.endIndex,
    };
  }

  if (/[0-7]/.test(char)) {
    const digits = readEscapeDigits(value, escapeIndex, 3, /[0-7]/)!;
    return {
      text: codePointToString(Number.parseInt(digits.digits, 8)),
      endIndex: digits.endIndex,
    };
  }

  return { text: `\\${char}`, endIndex: escapeIndex };
}

function readHereDocDelimiterWord(
  segment: string,
  startIndex: number,
): { text: string; endIndex: number } | null {
  let index = startIndex;
  while (index < segment.length && /\s/.test(segment[index]!)) index += 1;

  let text = '';
  let quote: '"' | "'" | '`' | null = null;
  let ansiQuote = false;

  for (; index < segment.length; index += 1) {
    const char = segment[index]!;
    const next = segment[index + 1];

    if (quote) {
      if (ansiQuote && char === '\\') {
        const escape = readAnsiCEscape(segment, index);
        text += escape.text;
        index = escape.endIndex;
        continue;
      }
      if (char === '\\' && quote !== "'" && next) {
        text += next;
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        ansiQuote = false;
        continue;
      }
      text += char;
      continue;
    }

    if (/\s/.test(char) || char === ';' || char === '|' || char === '&') break;

    if (char === '\\' && next) {
      text += next;
      index += 1;
      continue;
    }

    if (char === '$' && (next === "'" || next === '"')) {
      quote = next;
      ansiQuote = next === "'";
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      ansiQuote = false;
      continue;
    }

    text += char;
  }

  return text ? { text, endIndex: index } : null;
}

function extractHereDocTerminators(segment: string): HereDocTerminator[] {
  const terminators: HereDocTerminator[] = [];
  let quote: '"' | "'" | '`' | null = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    const next = segment[index + 1];

    if (quote) {
      if (char === '\\' && quote !== "'" && next) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    const arithmeticEnd = readArithmeticExpansionEnd(segment, index);
    if (arithmeticEnd !== null) {
      index = arithmeticEnd - 1;
      continue;
    }

    if (char === '\\' && next) {
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char !== '<' || next !== '<') continue;
    if (segment[index + 2] === '<') {
      index += 2;
      continue;
    }

    const stripLeadingTabs = segment[index + 2] === '-';
    const delimiterStart = index + (stripLeadingTabs ? 3 : 2);
    const delimiter = readHereDocDelimiterWord(segment, delimiterStart);
    if (!delimiter) continue;
    terminators.push({ text: delimiter.text, stripLeadingTabs });
    index = delimiter.endIndex - 1;
  }

  return terminators;
}

function skipHereDocBodies(
  command: string,
  startIndex: number,
  terminators: HereDocTerminator[],
): number {
  let cursor = startIndex;

  for (const terminator of terminators) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf('\n', cursor);
      const end = lineEnd === -1 ? command.length : lineEnd;
      const rawLine = command.slice(cursor, end);
      const line = terminator.stripLeadingTabs ? rawLine.replace(/^\t+/, '') : rawLine;
      cursor = lineEnd === -1 ? command.length : lineEnd + 1;

      if (line === terminator.text) break;
    }
  }

  return cursor;
}

export function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  let inComment = false;
  let lineHereDocTerminators: HereDocTerminator[] = [];

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };

  const flushCommandSegment = () => {
    lineHereDocTerminators.push(...extractHereDocTerminators(current));
    flush();
  };

  const finishLine = (bodyStartIndex: number): number => {
    flushCommandSegment();
    const hereDocTerminators = lineHereDocTerminators;
    lineHereDocTerminators = [];
    if (hereDocTerminators.length === 0) return bodyStartIndex;
    return skipHereDocBodies(command, bodyStartIndex, hereDocTerminators);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (inComment) {
      if (char === '\n') {
        inComment = false;
        index = finishLine(index + 1) - 1;
      }
      continue;
    }

    if (quote) {
      current += char;
      if (char === '\\' && quote !== "'" && next) {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '\\' && next === '\n') {
      index += 1;
      continue;
    }

    if (char === '\\' && next) {
      current += char + next;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    const arithmeticEnd = readArithmeticExpansionEnd(command, index);
    if (arithmeticEnd !== null) {
      current += command.slice(index, arithmeticEnd);
      index = arithmeticEnd - 1;
      continue;
    }

    if (char === '#') {
      const previous = current[current.length - 1];
      if (!previous || /\s/.test(previous)) {
        inComment = true;
        continue;
      }
    }

    if (char === '\n') {
      index = finishLine(index + 1) - 1;
      continue;
    }

    if (char === ';') {
      flushCommandSegment();
      continue;
    }

    if (char === '&' && next === '&') {
      flushCommandSegment();
      index += 1;
      continue;
    }

    if (char === '|' && next === '|') {
      flushCommandSegment();
      index += 1;
      continue;
    }

    if (char === '&') {
      const previous = lastNonWhitespaceChar(current);
      if (next === '>' || previous === '>' || previous === '<') {
        current += char;
        continue;
      }
      flushCommandSegment();
      continue;
    }

    if (char === '|') {
      flushCommandSegment();
      if (next === '&') index += 1;
      continue;
    }

    current += char;
  }

  flush();
  return segments;
}

export function extractGrantableShellCommandSegments(command: string): string[] {
  return splitShellCommandSegments(command).filter((segment) => {
    const tokens = tokenizeShellCommand(segment);
    const cmd = tokens[0]?.toLowerCase();
    return tokens.length > 0 && !(cmd && CWD_COMMANDS.has(cmd) && !hasExecutableShellExpansion(segment));
  });
}

/**
 * OpenCode always-allow patterns: BashArity.prefix(tokens) + " *"
 * @see packages/opencode/src/tool/shell.ts collect()
 */
export function buildAlwaysAllowCommandPatterns(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) return [];

  const patterns = new Set<string>();
  const segments = extractGrantableShellCommandSegments(trimmed);

  for (const segment of segments) {
    const tokens = tokenizeShellCommand(segment);
    const prefix = bashArityPrefix(tokens);
    if (prefix.length === 0) continue;
    patterns.add(`${prefix.join(' ')} *`);
  }

  return [...patterns];
}
