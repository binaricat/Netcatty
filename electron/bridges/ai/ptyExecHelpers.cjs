"use strict";

const { StringDecoder } = require("node:string_decoder");
const iconv = require("iconv-lite");
const { stripAnsi, isDefaultPowerShellPromptLine } = require("./shellUtils.cjs");
const { classifyLocalShellType } = require("../../../lib/localShell.cjs");

// Build a stateful decoder for a full exec call. Serial data events can
// split multi-byte characters across chunks (very common on GBK/GB18030
// consoles), and a stateless iconv.decode per chunk would emit
// replacement bytes for the leading half. StringDecoder and
// iconv.getDecoder both preserve partial-byte state across write() calls
// and flush any trailing bytes on end(), which is what we need.
function createStatefulDecoder(encoding) {
  const enc = encoding || "utf8";
  if (Buffer.isEncoding(enc)) {
    return new StringDecoder(enc);
  }
  try {
    return iconv.getDecoder(enc);
  } catch {
    return new StringDecoder("utf8");
  }
}

function detectShellKind(shellPath, platform = process.platform) {
  return classifyLocalShellType(shellPath, platform);
}

function subscribeToPtyData(ptyStream, onData) {
  if (typeof ptyStream?.onData === "function") {
    const disposable = ptyStream.onData((data) => onData(data));
    return () => {
      try {
        disposable?.dispose?.();
      } catch {
        // Ignore cleanup failures
      }
    };
  }

  if (typeof ptyStream?.on === "function" && typeof ptyStream?.removeListener === "function") {
    ptyStream.on("data", onData);
    return () => {
      try {
        ptyStream.removeListener("data", onData);
      } catch {
        // Ignore cleanup failures
      }
    };
  }

  throw new Error("PTY stream does not support data subscriptions");
}

function hasExpectedPromptSuffix(text, expectedPrompt) {
  if (!expectedPrompt) return false;
  const normalizedText = stripAnsi(String(text || "")).replace(/\r/g, "");
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  return !!normalizedPrompt && normalizedText.endsWith(normalizedPrompt);
}

function escapePosixSingleQuoted(text) {
  return String(text || "").replace(/'/g, "'\\''");
}

function escapePowerShellSingleQuoted(text) {
  return String(text || "").replace(/'/g, "''");
}

function escapeFishSingleQuoted(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeCmdForNestedShell(text) {
  return String(text || "").replace(/"/g, '""').replace(/%/g, "%%");
}

const POSIX_WRAPPER_HELPER_NAMES = new Set([
  "[",
  "alias",
  "builtin",
  "command",
  "eval",
  "exit",
  "functions",
  "printf",
  "test",
  "trap",
  "true",
  "type",
  "typeset",
  "unset",
]);

const POSIX_NOUNSET_SAFE_VARIABLES = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "SHLVL",
  "TERM",
  "TMPDIR",
  "USER",
]);

function tokenizePosixCommand(command) {
  const tokens = [];
  const text = String(command || "");
  let word = "";
  let quote = null;

  const pushWord = () => {
    if (!word) return;
    tokens.push({ type: "word", value: word });
    word = "";
  };
  const pushOp = (value) => {
    pushWord();
    tokens.push({ type: "op", value });
  };
  const readDollarParen = (startIndex) => {
    let value = "$(";
    let depth = 1;
    let nestedQuote = null;
    for (let i = startIndex + 2; i < text.length; i += 1) {
      const ch = text[i];
      value += ch;
      if (nestedQuote === "'") {
        if (ch === "'") nestedQuote = null;
        continue;
      }
      if (nestedQuote === "\"" || nestedQuote === "`") {
        if (ch === "\\") {
          if (i + 1 < text.length) value += text[++i];
          continue;
        }
        if (ch === nestedQuote) nestedQuote = null;
        continue;
      }
      if (ch === "'" || ch === "\"" || ch === "`") {
        nestedQuote = ch;
        continue;
      }
      if (ch === "\\") {
        if (i + 1 < text.length) value += text[++i];
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) return { value, endIndex: i };
      }
    }
    return null;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === "ansi-single") {
      if (ch === "\\") {
        if (i + 1 < text.length) word += text[++i];
        continue;
      }
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\") {
        if (i + 1 < text.length) word += text[++i];
        continue;
      }
      if (ch === "\"") quote = null;
      else word += ch;
      continue;
    }
    if (quote === "`") {
      if (ch === "\\") {
        if (i + 1 < text.length) word += text[++i];
        continue;
      }
      if (ch === "`") {
        word += ch;
        quote = null;
      }
      else word += ch;
      continue;
    }

    if (ch === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const result = readDollarParen(i);
      if (result) {
        word += result.value;
        i = result.endIndex;
        continue;
      }
    }
    if (ch === "$" && text[i + 1] === "'") {
      quote = "ansi-single";
      i += 1;
      continue;
    }
    if (ch === "`") {
      word += ch;
      quote = ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < text.length) word += text[++i];
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      pushOp(";");
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    if (ch === "&" && /[<>]$/.test(word) && /[0-9-]/.test(text[i + 1] || "")) {
      word += ch;
      continue;
    }
    if (";|&(){}".includes(ch)) {
      const next = text[i + 1];
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || (ch === ";" && next === ";")) {
        pushOp(ch + next);
        i += 1;
      } else {
        pushOp(ch);
      }
      continue;
    }
    word += ch;
  }
  pushWord();
  return tokens;
}

function isAssignmentWord(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isRedirectionWord(word) {
  return /^\d*(?:<>|>>|>\||<&|>&|[<>])/.test(word);
}

function redirectionConsumesNextWord(word) {
  return /^\d*(?:<>|>>|>\||<&|>&|[<>])$/.test(word);
}

function commandBasename(word) {
  return String(word || "").split("/").pop();
}

function isCommandPrefixWord(word) {
  const base = commandBasename(word);
  return word === "!" || base === "time" || base === "command" || base === "builtin" || base === "nice" || base === "nohup" || base === "coproc" || base === "repeat" || base === "noglob" || base === "nocorrect" || base === "-" || base === "timeout" || base === "sudo" || base === "doas" || base === "stdbuf" || base === "setsid" || base === "flock";
}

function isUnsafeKillTarget(word) {
  if (word === "$$" || word.includes("$") || word.includes("`") || word.includes("$(")) return true;
  return /^[+-]?0+$/.test(word);
}

function hasUnsafeKillTarget(words) {
  let signalOptionConsumed = false;
  let afterDoubleDash = false;

  for (const word of words) {
    if (!afterDoubleDash && word === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (
      !afterDoubleDash
      && !signalOptionConsumed
      && (/^-[A-Za-z][A-Za-z0-9_-]*$/.test(word) || /^-\d+$/.test(word))
    ) {
      signalOptionConsumed = true;
      continue;
    }
    if (isUnsafeKillTarget(word) || /^-\d+$/.test(word)) return true;
  }

  return false;
}

function isShellCommand(word) {
  return new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"]).has(commandBasename(word));
}

function isScriptInterpreterCommand(word) {
  return /^(?:python(?:[0-9]+(?:\.[0-9]+)*)?|perl(?:[0-9]+(?:\.[0-9]+)*)?|ruby(?:[0-9]+(?:\.[0-9]+)*)?|node(?:js|[0-9]+(?:\.[0-9]+)*)?|php(?:[0-9]+(?:\.[0-9]+)*)?|awk|gawk|mawk|nawk)$/.test(commandBasename(word));
}

function extractShellCommandString(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--") return null;
    if (!word.startsWith("-") || word === "-") return null;
    if (word.slice(1).includes("c")) return words[i + 1] || "";
    if (word === "-O" || word === "-o" || word === "--option") {
      i += 1;
    }
  }
  return null;
}

function hasExpandableDoubleDollarWord(words) {
  return words.some((word) => String(word || "").includes("$$"));
}

function hasDangerousScriptKill(words) {
  return words.some((word) => {
    const text = String(word || "");
    return (
      /(?:^|[^A-Za-z0-9_])(?:os\.)?kill\s*\(\s*[+-]?0(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])(?:os\.)?kill\s*\(\s*(?:os\.)?getppid\s*\(/.test(text)
      || /(?:^|[^A-Za-z0-9_])(?:os\.)?kill\s*\(\s*(?:os\.)?getpgrp\s*\(/.test(text)
      || /(?:^|[^A-Za-z0-9_])killpg\s*\(/.test(text)
      || /(?:^|[^A-Za-z0-9_])process\.kill\s*\(\s*[+-]?0(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])process\.kill\s*\(\s*process\.ppid(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])Process\.kill\s*\(\s*[^,]+,\s*[+-]?0(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])Process\.kill\s*\(\s*[^,]+,\s*(?:Process\.)?ppid(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])Process\.kill\s*\(\s*[^,]+,\s*(?:Process\.)?getpgrp(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])kill\s+[^;&|]*[, ]\s*[+-]?0(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])kill\s+[^;&|]*[, ]\s*(?:getppid|ppid)(?:\D|$)/.test(text)
      || /(?:^|[^A-Za-z0-9_])kill\s+[^;&|]*[, ]\s*(?:getpgrp|pgrp)(?:\D|$)/.test(text)
    );
  });
}

function hasDangerousRunnerKill(tokens, depth = 0) {
  const words = tokens.filter((token) => token.type === "word").map((token) => token.value);

  for (let i = 0; i < words.length; i += 1) {
    const word = commandBasename(words[i]);
    if (word !== "xargs" && word !== "parallel" && word !== "find") continue;

    for (let j = i + 1; j < words.length; j += 1) {
      if (commandBasename(words[j]) !== "kill") continue;
      const killArgs = words.slice(j + 1);
      if (word === "xargs" || word === "parallel") return true;
      if (hasUnsafeKillTarget(killArgs)) return true;
    }

    if (depth >= 24) continue;
    for (let j = i + 1; j < words.length; j += 1) {
      const candidate = words[j];
      if (!isShellCommand(candidate)) continue;
      const shellCommandString = extractShellCommandString(words.slice(j + 1));
      if (shellCommandString === null) continue;
      const nested = analyzePosixCommand(shellCommandString, depth + 1);
      if (nested.blockUnsafe) return true;
    }
  }

  return false;
}

function isFunctionName(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) && ![
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "function",
  ].includes(word);
}

function functionBodyStartIndex(tokens, index) {
  const token = tokens[index];
  if (!token || token.type !== "word") return -1;

  const isFunctionBodyStart = (candidate) => (
    candidate?.type === "op" && (candidate.value === "{" || candidate.value === "(")
  );

  if (
    token.value === "function"
    && tokens[index + 1]?.type === "word"
    && isFunctionName(tokens[index + 1].value)
  ) {
    let cursor = index + 2;
    if (tokens[cursor]?.type === "op" && tokens[cursor].value === "(" && tokens[cursor + 1]?.type === "op" && tokens[cursor + 1].value === ")") {
      cursor += 2;
    }
    return isFunctionBodyStart(tokens[cursor]) ? cursor : -1;
  }

  if (
    isFunctionName(token.value)
    && tokens[index + 1]?.type === "op"
    && tokens[index + 1].value === "("
    && tokens[index + 2]?.type === "op"
    && tokens[index + 2].value === ")"
    && isFunctionBodyStart(tokens[index + 3])
  ) {
    return index + 3;
  }

  return -1;
}

function functionDefinitionAt(tokens, index) {
  const token = tokens[index];
  const bodyStart = functionBodyStartIndex(tokens, index);
  if (bodyStart === -1) return null;
  return {
    name: token.value === "function" ? tokens[index + 1]?.value : token.value,
    bodyStart,
  };
}

function skipFunctionBody(tokens, bodyStartIndex) {
  const opener = tokens[bodyStartIndex]?.value;
  const closer = opener === "{" ? "}" : ")";
  let depth = 0;
  for (let i = bodyStartIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type !== "op") continue;
    if (token.value === opener) depth += 1;
    if (token.value === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return bodyStartIndex;
}

function tokensToCommand(tokens) {
  return tokens.map((token) => token.value).join(" ");
}

function commandWordsBeforeOperator(tokens, startIndex) {
  const words = [];
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "op") break;
    if (token.type === "word") words.push(token.value);
  }
  return words;
}

function isCommandPositionResetWord(word) {
  return ["if", "while", "until", "then", "do", "else", "elif"].includes(word);
}

function isShellReservedWord(word) {
  return [
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "in",
    "function",
  ].includes(word);
}

function skipPrefixOptionWords(tokens, index, prefixWord) {
  let cursor = index;
  let lookupOnly = false;

  const nextWord = () => tokens[cursor + 1]?.type === "word" ? tokens[cursor + 1].value : null;
  const consumeNext = () => {
    cursor += 1;
  };

  const prefixBase = commandBasename(prefixWord);

  if (prefixBase === "time") {
    while (nextWord() && /^-[A-Za-z]+$/.test(nextWord())) consumeNext();
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "command") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (!word.startsWith("-") || word === "-") break;
      if (word.includes("v") || word.includes("V")) lookupOnly = true;
      consumeNext();
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "builtin") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "nice") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (word === "-n") {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (/^-n.+/.test(word) || /^-[+-]?\d+$/.test(word)) {
        consumeNext();
        continue;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "nohup") {
    if (nextWord() === "--") consumeNext();
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "coproc") {
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "repeat") {
    if (nextWord() && /^\d+$/.test(nextWord())) consumeNext();
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "timeout") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (word === "-s" || word === "--signal" || word === "-k" || word === "--kill-after") {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (
        word.startsWith("--signal=")
        || word.startsWith("--kill-after=")
        || word === "-v"
        || word === "--verbose"
        || word === "--foreground"
        || word === "--preserve-status"
      ) {
        consumeNext();
        continue;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    if (nextWord()) consumeNext();
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "sudo") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (["-A", "-b", "-E", "-e", "-H", "-h", "-K", "-k", "-n", "-S", "-s", "-V", "-v"].includes(word)) {
        consumeNext();
        continue;
      }
      if (["-C", "-c", "-D", "-g", "-p", "-R", "-r", "-t", "-U", "-u"].includes(word)) {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (/^-[A-Za-z].+/.test(word) || word.startsWith("--")) {
        consumeNext();
        continue;
      }
      break;
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "doas") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (word === "-n" || word === "-s") {
        consumeNext();
        continue;
      }
      if (word === "-u" || word === "-C") {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "stdbuf") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (word === "-i" || word === "-o" || word === "-e") {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (/^-(?:i|o|e).+/.test(word) || word.startsWith("--input=") || word.startsWith("--output=") || word.startsWith("--error=")) {
        consumeNext();
        continue;
      }
      if (word === "--input" || word === "--output" || word === "--error") {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "setsid") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    return { index: cursor, lookupOnly };
  }

  if (prefixBase === "flock") {
    while (nextWord()) {
      const word = nextWord();
      if (word === "--") {
        consumeNext();
        break;
      }
      if (["-c", "-E", "-F", "-o", "-s", "-x", "-n", "-u", "-w"].includes(word)) {
        consumeNext();
        if (word === "-c" || word === "-E" || word === "-w") {
          if (nextWord()) consumeNext();
        }
        continue;
      }
      if (word.startsWith("--command=") || word.startsWith("--conflict-exit-code=") || word.startsWith("--timeout=")) {
        consumeNext();
        continue;
      }
      if (word === "--command" || word === "--conflict-exit-code" || word === "--timeout") {
        consumeNext();
        if (nextWord()) consumeNext();
        continue;
      }
      if (!word.startsWith("-") || word === "-") break;
      consumeNext();
    }
    if (nextWord()) consumeNext();
    return { index: cursor, lookupOnly };
  }

  return { index: cursor, lookupOnly };
}

function parseEnvInvocation(words) {
  let commandIndex = -1;
  let blockUnsafe = false;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "-") {
      continue;
    }
    if (word === "--") {
      commandIndex = i + 1 < words.length ? i + 1 : -1;
      break;
    }
    if (word === "-S" || word.startsWith("-S") || /^-[A-Za-z]*S/.test(word) || word === "--split-string" || word.startsWith("--split-string=")) {
      blockUnsafe = true;
      continue;
    }
    if (word === "-u" || word === "-C" || word === "-P" || word === "--unset" || word === "--chdir") {
      i += 1;
      continue;
    }
    if (word.startsWith("--unset=") || word.startsWith("--chdir=") || /^-[uCP].+/.test(word)) {
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      continue;
    }
    if (isAssignmentWord(word)) {
      continue;
    }
    commandIndex = i;
    break;
  }

  return {
    blockUnsafe,
    command: commandIndex === -1 ? "" : words[commandIndex],
    args: commandIndex === -1 ? [] : words.slice(commandIndex + 1),
  };
}

function extractFlockCommandString(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--") continue;
    if (word === "-c" || word === "--command") return words[i + 1] || "";
    if (word.startsWith("--command=")) return word.slice("--command=".length);
    if (word === "-E" || word === "-w" || word === "--conflict-exit-code" || word === "--timeout") {
      i += 1;
      continue;
    }
    if (word.startsWith("--conflict-exit-code=") || word.startsWith("--timeout=")) continue;
    if (word.startsWith("-") && word !== "-") continue;
    break;
  }
  return null;
}

function topLevelCommandHasSeparator(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const bodyStart = functionBodyStartIndex(tokens, i);
    if (bodyStart !== -1) {
      i = skipFunctionBody(tokens, bodyStart);
      continue;
    }
    const token = tokens[i];
    if (token.type === "op" && [";", ";;", "&&", "||", "|"].includes(token.value)) return true;
  }
  return false;
}

function normalizeTrapSignal(signal) {
  const normalized = String(signal || "").toUpperCase().replace(/^SIG/, "");
  if (normalized === "2") return "INT";
  return normalized;
}

function looksLikeTrapSignal(word) {
  const normalized = normalizeTrapSignal(word);
  return new Set([
    "0",
    "EXIT",
    "HUP",
    "INT",
    "QUIT",
    "ILL",
    "ABRT",
    "FPE",
    "KILL",
    "SEGV",
    "PIPE",
    "ALRM",
    "TERM",
    "USR1",
    "USR2",
    "CHLD",
    "CONT",
    "STOP",
    "TSTP",
    "TTIN",
    "TTOU",
    "DEBUG",
    "ERR",
    "ZERR",
  ]).has(normalized) || /^\d+$/.test(String(word || ""));
}

function parseTrapInvocation(words) {
  const args = [];
  let queryOnly = false;

  for (const word of words) {
    if (word === "--") continue;
    if (args.length === 0 && (word === "-p" || word === "-l" || word === "--print")) {
      queryOnly = true;
      continue;
    }
    args.push(word);
  }

  if (queryOnly) {
  return {
      queryOnly: true,
      handler: "",
      signals: args.filter(looksLikeTrapSignal).map(normalizeTrapSignal),
    };
  }

  if (args.length > 0 && args.every(looksLikeTrapSignal)) {
    return {
      queryOnly: false,
      handler: "-",
      signals: args.map(normalizeTrapSignal),
    };
  }

  return {
    queryOnly: false,
    handler: args[0] || "",
    signals: args.slice(1).map(normalizeTrapSignal),
  };
}

function isUnsafeTrapHandler(handler, depth) {
  const text = String(handler || "");
  const handlerRisk = analyzePosixCommand(text, depth + 1);
  return (
    handlerRisk.blockUnsafe
    || /(^|[^A-Za-z0-9_./-])(exit|logout|exec|return|eval)($|[^A-Za-z0-9_./-])/.test(text)
    || /(^|[^A-Za-z0-9_./-])kill([^;&|]*)(\$\$|[+]?0+|-[0-9]+)($|[^A-Za-z0-9_./-])/.test(text)
    || /(^|[^A-Za-z0-9_./-])set[ \t].*(-[A-Za-z]*[eu]|-o[ \t]+(?:err_?exit|errexit|nounset|unset))($|[^A-Za-z0-9_./-])/i.test(text)
    || /(^|[^A-Za-z0-9_./-])setopt[ \t].*(err_?exit|errexit|nounset|unset)($|[^A-Za-z0-9_./-])/i.test(text)
  );
}

function posixCommandNeedsIntTrapBypass(tokens) {
  let startOfCommand = true;
  const hasSeparator = topLevelCommandHasSeparator(tokens);
  const intTrapFunctions = new Set();

  for (let i = 0; i < tokens.length; i += 1) {
    const bodyStart = functionBodyStartIndex(tokens, i);
    if (bodyStart !== -1) {
      const definition = functionDefinitionAt(tokens, i);
      if (definition) {
        const bodyEnd = skipFunctionBody(tokens, definition.bodyStart);
        const bodyTokens = tokens.slice(definition.bodyStart + 1, bodyEnd);
        if (posixCommandNeedsIntTrapBypass(bodyTokens)) {
          intTrapFunctions.add(definition.name);
        }
        i = bodyEnd;
        startOfCommand = false;
        continue;
      }
      i = skipFunctionBody(tokens, bodyStart);
      startOfCommand = false;
      continue;
    }
    const token = tokens[i];
    if (token.type === "op") {
      startOfCommand = true;
      continue;
    }
    if (token.type !== "word") continue;
    if (isCommandPositionResetWord(token.value)) {
      startOfCommand = true;
      continue;
    }
    if (!startOfCommand) continue;
    if (isAssignmentWord(token.value)) continue;
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      startOfCommand = !prefix.lookupOnly;
      continue;
    }
    if (intTrapFunctions.has(token.value)) return true;
    if (token.value !== "trap") {
      startOfCommand = false;
      continue;
    }

    const trap = parseTrapInvocation(commandWordsBeforeOperator(tokens, i + 1));
    if (!trap.queryOnly && trap.signals.some((signal) => signal === "INT")) return true;
    if (trap.queryOnly && !hasSeparator && (trap.signals.length === 0 || trap.signals.some((signal) => signal === "INT"))) return true;
    if (!trap.queryOnly && !hasSeparator && !trap.handler && trap.signals.length === 0) return true;
    startOfCommand = false;
  }

  return false;
}

function posixCommandHasTrapQuery(tokens) {
  let startOfCommand = true;

  for (let i = 0; i < tokens.length; i += 1) {
    const bodyStart = functionBodyStartIndex(tokens, i);
    if (bodyStart !== -1) {
      i = skipFunctionBody(tokens, bodyStart);
      startOfCommand = false;
      continue;
    }
    const token = tokens[i];
    if (token.type === "op") {
      startOfCommand = true;
      continue;
    }
    if (token.type !== "word") continue;
    if (isCommandPositionResetWord(token.value)) {
      startOfCommand = true;
      continue;
    }
    if (!startOfCommand) continue;
    if (isAssignmentWord(token.value)) continue;
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      startOfCommand = !prefix.lookupOnly;
      continue;
    }
    if (token.value !== "trap") {
      startOfCommand = false;
      continue;
    }

    const trap = parseTrapInvocation(commandWordsBeforeOperator(tokens, i + 1));
    if (trap.queryOnly) return true;
    startOfCommand = false;
  }

  return false;
}

function firstCommandWord(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "op") continue;
    if (token.type !== "word") continue;
    if (isAssignmentWord(token.value)) continue;
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      continue;
    }
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    return token.value;
  }
  return "";
}

function firstCommandIndex(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "op") continue;
    if (token.type !== "word") continue;
    if (isAssignmentWord(token.value)) continue;
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      continue;
    }
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

function isStatePreservingCommandWord(word) {
  return new Set([
    "cd",
    "pushd",
    "popd",
    "dirs",
    "export",
    "alias",
    "unalias",
    "unset",
    "readonly",
    "set",
    "setopt",
    "unsetopt",
    "shopt",
    "trap",
    ".",
    "source",
    "umask",
    "ulimit",
    "read",
    "typeset",
    "declare",
  ]).has(commandBasename(word));
}

function escapePosixSingleQuotedWord(word) {
  return escapePosixSingleQuoted(word || "");
}

function isStatePreservingPosixCommand(tokens) {
  let startOfCommand = true;

  for (let i = 0; i < tokens.length; i += 1) {
    const bodyStart = functionBodyStartIndex(tokens, i);
    if (bodyStart !== -1) {
      if (startOfCommand && functionDefinitionAt(tokens, i)) return true;
      i = skipFunctionBody(tokens, bodyStart);
      startOfCommand = false;
      continue;
    }
    const token = tokens[i];
    if (token.type === "op") {
      startOfCommand = true;
      continue;
    }
    if (token.type !== "word") continue;
    if (isCommandPositionResetWord(token.value)) {
      startOfCommand = true;
      continue;
    }
    if (!startOfCommand) continue;
    if (isAssignmentWord(token.value)) continue;
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      startOfCommand = !prefix.lookupOnly;
      continue;
    }
    if (isStatePreservingCommandWord(token.value)) return true;
    startOfCommand = false;
  }

  return false;
}

function extractCommandSubstitutions(command) {
  const text = String(command || "");
  const substitutions = [];
  let quote = null;

  const readBacktick = (startIndex) => {
    let value = "";
    for (let i = startIndex + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "\\") {
        if (i + 1 < text.length) value += text[++i];
        continue;
      }
      if (ch === "`") return { value, endIndex: i };
      value += ch;
    }
    return null;
  };

  const readDollarParen = (startIndex) => {
    let value = "";
    let depth = 1;
    let nestedQuote = null;
    for (let i = startIndex + 2; i < text.length; i += 1) {
      const ch = text[i];
      if (nestedQuote === "'") {
        if (ch === "'") nestedQuote = null;
        value += ch;
        continue;
      }
      if (nestedQuote === "\"" || nestedQuote === "`") {
        if (ch === "\\") {
          value += ch;
          if (i + 1 < text.length) value += text[++i];
          continue;
        }
        if (ch === nestedQuote) nestedQuote = null;
        value += ch;
        continue;
      }
      if (ch === "'" || ch === "\"" || ch === "`") {
        nestedQuote = ch;
        value += ch;
        continue;
      }
      if (ch === "\\") {
        value += ch;
        if (i + 1 < text.length) value += text[++i];
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) return { value, endIndex: i };
      }
      value += ch;
    }
    return null;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "ansi-single") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "\"") {
        quote = null;
        continue;
      }
    }

    if (!quote && ch === "$" && text[i + 1] === "'") {
      quote = "ansi-single";
      i += 1;
      continue;
    }
    if (!quote && ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === "\"") {
      quote = quote === "\"" ? null : "\"";
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") {
      const result = readBacktick(i);
      if (result) {
        substitutions.push(result.value);
        i = result.endIndex;
      }
      continue;
    }
    if (ch === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      const result = readDollarParen(i);
      if (result) {
        substitutions.push(result.value);
        i = result.endIndex;
      }
    }
  }

  return substitutions;
}

function normalizeShellOptionName(word) {
  return String(word || "").toLowerCase().replace(/[-_]/g, "");
}

function isErrexitOptionName(word) {
  return normalizeShellOptionName(word) === "errexit";
}

function isNounsetOptionName(word) {
  const normalized = normalizeShellOptionName(word);
  return normalized === "nounset" || normalized === "unset";
}

function hasShortShellOption(word, option) {
  return new RegExp(`^-[^-]*${option}`).test(String(word || ""));
}

function readShellVariableName(text, startIndex) {
  const match = String(text || "").slice(startIndex).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return match ? match[0] : "";
}

function isNounsetSafeShellVariable(name) {
  return POSIX_NOUNSET_SAFE_VARIABLES.has(name) || /^LC_[A-Za-z0-9_]+$/.test(name);
}

function hasPotentialNounsetExpansion(command) {
  const text = String(command || "");
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "ansi-single") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "\"") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "\"") {
        quote = null;
        continue;
      }
    }
    if (quote === "`") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "`") quote = null;
      continue;
    }

    if (!quote && ch === "$" && text[i + 1] === "'") {
      quote = "ansi-single";
      i += 1;
      continue;
    }
    if (!quote && ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === "\"") {
      quote = quote === "\"" ? null : "\"";
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") {
      quote = "`";
      continue;
    }
    if (ch !== "$") continue;
    if (text[i + 1] === "(") continue;
    if (/[0-9]/.test(text[i + 1] || "")) return true;
    if (/[A-Za-z_]/.test(text[i + 1] || "")) {
      const name = readShellVariableName(text, i + 1);
      if (!isNounsetSafeShellVariable(name)) return true;
      i += name.length;
      continue;
    }
    if (text[i + 1] === "{" && /[0-9]/.test(text[i + 2] || "")) return true;
    if (text[i + 1] === "{" && /[A-Za-z_]/.test(text[i + 2] || "")) {
      const name = readShellVariableName(text, i + 2);
      const suffix = text[i + 2 + name.length];
      const next = text[i + 3 + name.length];
      if (
        (suffix === ":" && ["-", "=", "+"].includes(next))
        || ["-", "=", "+"].includes(suffix)
      ) {
        i += name.length + 2;
        continue;
      }
      if (!isNounsetSafeShellVariable(name)) return true;
      i += name.length + 2;
    }
  }

  return false;
}

function isRelativeSourcePath(path) {
  const text = String(path || "");
  return !!text && !text.startsWith("/") && !text.startsWith("~/");
}

function isDisableShellOptionWord(word, option) {
  return new RegExp(`^[+][^+]*${option}`).test(String(word || ""));
}

function isEnableShellOptionWord(word, option) {
  return new RegExp(`^-[^-]*${option}`).test(String(word || ""));
}

function commandFinalShellOptionState(tokens, option, longNames) {
  let startOfCommand = true;
  let state = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const bodyStart = functionBodyStartIndex(tokens, i);
    if (bodyStart !== -1) {
      i = skipFunctionBody(tokens, bodyStart);
      startOfCommand = false;
      continue;
    }
    const token = tokens[i];
    if (token.type === "op") {
      startOfCommand = true;
      continue;
    }
    if (token.type !== "word") continue;
    if (isCommandPositionResetWord(token.value)) {
      startOfCommand = true;
      continue;
    }
    if (!startOfCommand) continue;
    if (isAssignmentWord(token.value)) continue;
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      startOfCommand = !prefix.lookupOnly;
      continue;
    }
    if (token.value !== "set") {
      startOfCommand = false;
      continue;
    }
    const words = commandWordsBeforeOperator(tokens, i + 1);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (isDisableShellOptionWord(word, option)) {
        state = "disabled";
      } else if (isEnableShellOptionWord(word, option)) {
        state = "enabled";
      } else if (word === "+o" && longNames.some((name) => normalizeShellOptionName(words[index + 1]) === name)) {
        state = "disabled";
        index += 1;
      } else if (word === "-o" && longNames.some((name) => normalizeShellOptionName(words[index + 1]) === name)) {
        state = "enabled";
        index += 1;
      }
    }
    startOfCommand = false;
  }
  return state;
}

function commandHasErrexitSensitiveWord(tokens) {
  let startOfCommand = true;

  for (let i = 0; i < tokens.length; i += 1) {
    const bodyStart = functionBodyStartIndex(tokens, i);
    if (bodyStart !== -1) {
      i = skipFunctionBody(tokens, bodyStart);
      startOfCommand = false;
      continue;
    }
    const token = tokens[i];
    if (token.type === "op") {
      if (token.value === "|") return true;
      startOfCommand = true;
      continue;
    }
    if (token.type !== "word") continue;
    if (isCommandPositionResetWord(token.value)) {
      startOfCommand = true;
      continue;
    }
    if (!startOfCommand) continue;
    if (isAssignmentWord(token.value)) continue;
    if (isRedirectionWord(token.value)) {
      if (redirectionConsumesNextWord(token.value)) i += 1;
      continue;
    }
    if (isCommandPrefixWord(token.value)) {
      const prefix = skipPrefixOptionWords(tokens, i, token.value);
      i = prefix.index;
      startOfCommand = !prefix.lookupOnly;
      continue;
    }
    if (!isShellReservedWord(token.value) && !isStatePreservingCommandWord(token.value)) return true;
    if (["false", "grep", "test", "[", "[["].includes(commandBasename(token.value))) return true;
    if (token.value.includes("/") || token.value.startsWith("$") || token.value.includes("`") || token.value.includes("$(")) return true;
    startOfCommand = false;
  }

  return false;
}

function commandNeedsTemporaryIntTrap(command, tokens) {
  if (posixCommandNeedsIntTrapBypass(tokens)) return false;
  return /\bsleep\b/.test(String(command || ""));
}

function analyzePosixCommand(command, depth = 0) {
  const tokens = tokenizePosixCommand(command);
  const commandWord = firstCommandWord(tokens);
  const skipTemporaryIntTrap = posixCommandNeedsIntTrapBypass(tokens);
  let startOfCommand = true;
  let risky = false;
  let blockUnsafe = false;
  let bypassRuntimeCheck = false;
  let cwdMayHaveChanged = false;
  const sourceCheckPaths = new Set();
  const functionCheckWords = new Set();
  const riskyFunctions = new Map();
  const riskyAliases = new Map();

  if (hasDangerousRunnerKill(tokens, depth)) {
    blockUnsafe = true;
  }
  if (tokens.some((token) => token.type === "word" && isAssignmentWord(token.value) && token.value.includes("__NCMCP"))) {
    blockUnsafe = true;
  }

  if (depth < 24) {
    for (const substitution of extractCommandSubstitutions(command)) {
      const nested = analyzePosixCommand(substitution, depth + 1);
      if (nested.blockUnsafe) blockUnsafe = true;
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.type === "op") {
      startOfCommand = true;
      bypassRuntimeCheck = false;
      continue;
    }
    if (token.type !== "word") continue;

    const word = token.value;
    if (isCommandPositionResetWord(word)) {
      startOfCommand = true;
      bypassRuntimeCheck = false;
      continue;
    }
    if (!startOfCommand) continue;
    if (isAssignmentWord(word)) continue;
    if (isRedirectionWord(word)) {
      if (redirectionConsumesNextWord(word)) i += 1;
      startOfCommand = true;
      continue;
    }
    if (word === "!") {
      startOfCommand = true;
      continue;
    }

    const functionDefinition = functionDefinitionAt(tokens, i);
    if (functionDefinition) {
      const bodyEnd = skipFunctionBody(tokens, functionDefinition.bodyStart);
      const bodyTokens = tokens.slice(functionDefinition.bodyStart + 1, bodyEnd);
      const body = analyzePosixCommand(tokensToCommand(bodyTokens), depth + 1);
      if (POSIX_WRAPPER_HELPER_NAMES.has(functionDefinition.name)) {
        risky = true;
      }
      if (/^TRAP(?:DEBUG|ZERR)$/.test(functionDefinition.name) && (body.blockUnsafe || body.isolate)) {
        blockUnsafe = true;
      }
      if (body.blockUnsafe || body.isolate) {
        riskyFunctions.set(functionDefinition.name, body);
      }
      i = bodyEnd;
      startOfCommand = false;
      continue;
    }

    if (
      isCommandPrefixWord(word)
      && !word.includes("/")
      && !word.startsWith("$")
      && word !== "!"
      && word !== "-"
    ) {
      functionCheckWords.add(commandBasename(word));
    }
    if (riskyFunctions.has(word)) {
      const functionRisk = riskyFunctions.get(word);
      if (functionRisk.blockUnsafe) blockUnsafe = true;
      if (functionRisk.isolate) risky = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (riskyAliases.has(word)) {
      const aliasRisk = riskyAliases.get(word);
      if (aliasRisk.blockUnsafe || aliasRisk.isolate) blockUnsafe = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (commandBasename(word) === "flock") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      const flockCommandString = extractFlockCommandString(words);
      if (flockCommandString !== null) {
        const nested = analyzePosixCommand(flockCommandString, depth + 1);
        if (nested.blockUnsafe) blockUnsafe = true;
      }
    }
    if (isCommandPrefixWord(word)) {
      const prefix = skipPrefixOptionWords(tokens, i, word);
      i = prefix.index;
      startOfCommand = !prefix.lookupOnly;
      bypassRuntimeCheck = (word === "command" || word === "builtin") && !prefix.lookupOnly;
      continue;
    }

    if (word.startsWith("__NCMCP") || word.includes("/__NCMCP")) {
      blockUnsafe = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word.startsWith("$") || word.includes("`") || word.includes("$(")) {
      blockUnsafe = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (!bypassRuntimeCheck && !isShellReservedWord(word) && !word.includes("/") && !word.startsWith("$")) {
      functionCheckWords.add(word);
    }
    if (word === "eval") {
      blockUnsafe = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "alias") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      for (const entry of words) {
        const match = entry.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const aliasRisk = analyzePosixCommand(match[2], depth + 1);
        if (aliasRisk.blockUnsafe || aliasRisk.isolate) {
          riskyAliases.set(match[1], aliasRisk);
        }
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "." || word === "source") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      const sourcePath = words[0] || "";
      if (
        sourcePath
        && !sourcePath.includes("$")
        && !sourcePath.includes("`")
        && !sourcePath.includes("$(")
        && !(cwdMayHaveChanged && isRelativeSourcePath(sourcePath))
      ) {
        sourceCheckPaths.add(sourcePath);
      } else {
        blockUnsafe = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (commandBasename(word) === "env") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      const env = parseEnvInvocation(words);
      const envCommand = env.command;
      const envArgs = env.args;
      if (env.blockUnsafe) {
        blockUnsafe = true;
      }
      if (
        commandBasename(envCommand) === "kill"
        && hasUnsafeKillTarget(envArgs)
      ) {
        blockUnsafe = true;
      }
      if (isShellCommand(envCommand)) {
        const shellCommandString = extractShellCommandString(envArgs);
        if (shellCommandString !== null) {
          const nested = analyzePosixCommand(shellCommandString, depth + 1);
          if (nested.blockUnsafe) blockUnsafe = true;
        }
      }
      if (isScriptInterpreterCommand(envCommand) && hasExpandableDoubleDollarWord(envArgs)) {
        blockUnsafe = true;
      }
      if (isScriptInterpreterCommand(envCommand) && hasDangerousScriptKill(envArgs)) {
        blockUnsafe = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "cd" || word === "pushd" || word === "popd") {
      cwdMayHaveChanged = true;
    }
    if (isShellCommand(word)) {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      const shellCommandString = extractShellCommandString(words);
      if (shellCommandString !== null) {
        const nested = analyzePosixCommand(shellCommandString, depth + 1);
        if (nested.blockUnsafe) blockUnsafe = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (isScriptInterpreterCommand(word)) {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      if (hasExpandableDoubleDollarWord(words)) {
        blockUnsafe = true;
      }
      if (hasDangerousScriptKill(words)) {
        blockUnsafe = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "setopt") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      if (words.some((entry) => entry.includes("$") || isErrexitOptionName(entry) || isNounsetOptionName(entry))) {
        risky = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "emulate") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      if (words.some((entry, index) => (
        entry.includes("$")
        || isErrexitOptionName(entry)
        || isNounsetOptionName(entry)
        || ((entry === "-o" || entry === "--option") && (isErrexitOptionName(words[index + 1]) || isNounsetOptionName(words[index + 1])))
      ))) {
        risky = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "trap") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      const trap = parseTrapInvocation(words);
      if (!trap.queryOnly && trap.signals.length > 0) {
        const handler = trap.handler || "";
        if (handler === "-" && trap.signals.some((signal) => signal === "INT") && topLevelCommandHasSeparator(tokens)) {
          blockUnsafe = true;
        } else if (handler !== "-" && handler !== ":" && handler !== "true" && handler !== "") {
          if (isUnsafeTrapHandler(handler, depth)) {
            blockUnsafe = true;
          }
        }
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "set") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      if (words.some((entry, index) => (
        entry.includes("$")
        || hasShortShellOption(entry, "e")
        || hasShortShellOption(entry, "u")
        || (entry === "-o" && (isErrexitOptionName(words[index + 1]) || isNounsetOptionName(words[index + 1])))
      ))) {
        risky = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (word === "exit" || word === "logout" || word === "exec" || word === "return") {
      risky = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (commandBasename(word) === "kill") {
      const words = commandWordsBeforeOperator(tokens, i + 1);
      if (hasUnsafeKillTarget(words)) {
        blockUnsafe = true;
      }
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (riskyFunctions.has(word)) {
      const functionRisk = riskyFunctions.get(word);
      if (functionRisk.blockUnsafe) blockUnsafe = true;
      if (functionRisk.isolate) risky = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    if (riskyAliases.has(word)) {
      const aliasRisk = riskyAliases.get(word);
      if (aliasRisk.blockUnsafe || aliasRisk.isolate) blockUnsafe = true;
      startOfCommand = false;
      bypassRuntimeCheck = false;
      continue;
    }
    startOfCommand = false;
    bypassRuntimeCheck = false;
  }

  const errexitState = commandFinalShellOptionState(tokens, "e", ["errexit"]);
  const nounsetState = commandFinalShellOptionState(tokens, "u", ["nounset", "unset"]);
  const disablesErrexit = errexitState === "disabled";
  const disablesNounset = nounsetState === "disabled";

  return {
    blockUnsafe,
    isolate: risky || posixCommandHasTrapQuery(tokens),
    isolateOnErrexit: !disablesErrexit && topLevelCommandHasSeparator(tokens) && commandHasErrexitSensitiveWord(tokens),
    isolateOnNounset: hasPotentialNounsetExpansion(command),
    disablesErrexit,
    disablesNounset,
    skipTemporaryIntTrap,
    installTemporaryIntTrap: commandNeedsTemporaryIntTrap(command, tokens),
    functionCheckWords: [...functionCheckWords],
    sourceCheckPaths: [...sourceCheckPaths],
  };
}

// Matches PowerShell's default prompt only (e.g. `PS C:\Users\alice>`,
// `PS>`). Custom prompt functions (oh-my-posh, starship, PSReadLine themes
// that emit `❯`/`λ`/etc.) intentionally fall through — we'd rather miss
// the override than wrap a fish/zsh prompt as PowerShell. Pattern lives
// in shellUtils.cjs so prompt extraction and wrapper selection share one
// source of truth.
function isPowerShellPrompt(prompt) {
  // Treat `\r` as a line break too so a PSReadLine/ConPTY redraw like
  // `PS C:\old>\rPS C:\new>` is matched against the redrawn last line,
  // not the doubled string.
  const lastLine = stripAnsi(String(prompt || ""))
    .replace(/\r/g, "\n")
    .split("\n")
    .pop()
    .replace(/\s+$/, "");
  return isDefaultPowerShellPromptLine(lastLine);
}

// Prompt-driven override is intentionally narrow: only flip to PowerShell
// when the session has no confirmed shell type. This keeps the issue #841
// fix working (SSH/Telnet sessions never set shellKind — see
// sshBridge.cjs:1265) while preventing a malicious remote process from
// spoofing a `PS ...>` line on a real bash/zsh/fish/cmd session to coerce
// a single mis-wrapped command.
//
// Universe of shellKind values (see lib/localShell.cjs:23-33 and
// terminalBridge.cjs:368, :932, :1074):
//   "posix" | "powershell" | "cmd" | "fish" | "unknown" | "raw" | "" | undefined
// Excluded on purpose:
//   - "posix" / "fish" / "cmd": confirmed POSIX-family or cmd.exe — never override.
//   - "powershell": already correct; no override needed (would be a no-op).
//   - "raw": serial / network device — execViaRawPty bypasses buildWrappedCommand.
const SHELL_KINDS_OPEN_TO_PROMPT_OVERRIDE = new Set([
  "",
  "unknown",
]);

function resolveEffectiveShellKind(shellKind, expectedPrompt) {
  const baseKind = shellKind || "";
  if (
    SHELL_KINDS_OPEN_TO_PROMPT_OVERRIDE.has(baseKind) &&
    isPowerShellPrompt(expectedPrompt)
  ) {
    return "powershell";
  }
  return baseKind || "posix";
}

function buildWrappedCommand(command, shellKind, marker) {
  switch (shellKind) {
    case "powershell": {
      const psPager = "$env:PAGER='cat'; $env:SYSTEMD_PAGER=''; $env:GIT_PAGER='cat'; $env:LESS=''; ";
      const psEscaped = escapePowerShellSingleQuoted(command);
      return (
        `$${marker}=0; $${marker}_cmd='${psEscaped}'; & { Write-Output '${marker}_S'; ${psPager}$LASTEXITCODE=$null; try { Invoke-Expression $${marker}_cmd; $${marker}_rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } } catch { $${marker}_rc = 1 }; Write-Output "${marker}_E:$${marker}_rc" }\r\n`
      );
    }

    case "cmd": {
      const cmdEscaped = escapeCmdForNestedShell(command);
      return (
        `set "${marker}=0" & set "${marker}_CMD=${cmdEscaped}" & (echo ${marker}_S & set "PAGER=cat" & set "SYSTEMD_PAGER=" & set "GIT_PAGER=cat" & set "LESS=" & call cmd /d /s /c "%${marker}_CMD%" & call echo ${marker}_E:^%errorlevel^%)\r\n`
      );
    }

    case "fish":
      // Leading space: see the comment in the POSIX branch below. Fish
      // does not skip leading-space commands by default, but users can
      // define a `fish_should_add_to_history` function that filters them
      // — this prefix is what lets that opt-in actually take effect.
      return (
        ` set ${marker} 0; function __ncmcp_int --on-signal INT; printf '%s\\n' '${marker}_E:130'; functions -e __ncmcp_int; end; ` +
        `set -l ${marker}_cmd '${escapeFishSingleQuoted(command)}'; ` +
        `begin; set -gx PAGER cat; set -gx SYSTEMD_PAGER ''; set -gx GIT_PAGER cat; set -gx LESS ''; ` +
        `printf '%s\\n' '${marker}_S'; eval \$${marker}_cmd; set __NCMCP_rc $status; ` +
        `functions -e __ncmcp_int; printf '%s\\n' '${marker}_E:'\$__NCMCP_rc; end\n`
      );

    case "posix":
    default: {
      // Single-line compound command with early marker.
      //
      // Layout: __NCMCP_xxx=0; { ... MARKER_S; command; MARKER_E; }
      //
      // Key design decisions:
      //
      // 1) __NCMCP_xxx=0 at the VERY START ensures the PTY echo line
      //    contains __NCMCP_ in its first few bytes. This is critical:
      //    preload.cjs filters chunks by buffering incomplete lines that
      //    contain __NCMCP_. Without this prefix, the first chunk of a
      //    long echo line might not contain the marker and would leak
      //    through to the terminal as garbage.
      //
      // 2) Normal commands still run in the active shell so state changes like
      //    `cd` and `export` keep affecting the visible terminal. Commands
      //    that can exit the shell (`set -e`, `exit`, `exec`, ...) run in a
      //    subshell of the current shell so the wrapper can emit the end marker.
      //
      // 3) Single-line { ... } is parsed fully before execution, so SIGINT
      //    cannot cause bash to flush the end marker from the input buffer.
      //    When no user INT trap exists, a temporary trap prevents the shell
      //    from aborting the compound command. Existing or newly-set traps are
      //    left alone.
      const noPager = "PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= ";
      const temporaryIntTrap = "__NCMCP_int_seen=1";
      const restoreIntTrap = `if "$__NCMCP_t" "$__NCMCP_set_int_trap" = 1; then if "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then command builtin trap - INT; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then builtin trap - INT; else \\trap - INT; fi; fi`;
      const escaped = escapePosixSingleQuoted(command);
      const analysis = analyzePosixCommand(command);
      const blockUnsafe = analysis.blockUnsafe ? "1" : "0";
      const isolate = analysis.isolate ? "1" : "0";
      const isolateOnErrexit = analysis.isolateOnErrexit ? "1" : "0";
      const isolateOnNounset = analysis.isolateOnNounset ? "1" : "0";
      const disablesErrexit = analysis.disablesErrexit ? "1" : "0";
      const disablesNounset = analysis.disablesNounset ? "1" : "0";
      const skipTemporaryIntTrap = analysis.skipTemporaryIntTrap || !analysis.installTemporaryIntTrap ? "1" : "0";
      const functionCheckWords = escapePosixSingleQuotedWord(analysis.functionCheckWords.join("\n"));
      const sourceCheckPaths = escapePosixSingleQuotedWord(analysis.sourceCheckPaths.join("\n"));
      const needsRuntimeInspection = true;
      const runtimeInspection = needsRuntimeInspection ? "1" : "0";
      const safeSourceBareAtom = "[^[:space:];&|`$()'\"]+";
      const safeSourceVarAtom = "[$][A-Za-z_][A-Za-z0-9_]*|[$][{][A-Za-z_][A-Za-z0-9_]*[}]";
      const safeSourceSingleQuotedAtom = "'[^`$;&|()]*'";
      const safeSourceDoubleQuotedAtom = `"([^"\`;&|()]|${safeSourceVarAtom})*"`;
      const safeSourceValue = `(${safeSourceBareAtom}|${safeSourceVarAtom}|${safeSourceSingleQuotedAtom}|${safeSourceDoubleQuotedAtom})*`;
      const safeSourcePattern = [
        "^[[:space:]]*(#.*)?$",
        `^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=${safeSourceValue}[[:space:]]*$`,
        `^[[:space:]]*export[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=${safeSourceValue}[[:space:]]*$`,
        "^[[:space:]]*(unset|unalias)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*[[:space:]]*$",
        "^[[:space:]]*alias[[:space:]]+[A-Za-z_][A-Za-z0-9_]*='[^`$;&|()]*'[[:space:]]*$",
        `^[[:space:]]*readonly[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=${safeSourceValue}[[:space:]]*$`,
        "^[[:space:]]*(setopt|unsetopt)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*[[:space:]]*$",
      ].join("|");
      const safeSourcePatternWord = escapePosixSingleQuotedWord(safeSourcePattern);
      const dangerousSourcePattern = "(^|[^A-Za-z0-9_./-])(exit|logout|exec|return|kill|eval|source|set[[:space:]].*(-[A-Za-z]*[eu]|-o[[:space:]]+(err_?exit|errexit|nounset|unset))|setopt[[:space:]].*(err_?exit|errexit|nounset|unset))($|[^A-Za-z0-9_./-])|\\$\\$|`|\\$[(]";
      const dangerousDefinitionPattern = "(^|[^A-Za-z0-9_./-])(exit|logout|exec|eval|source|set[[:space:]].*(-[A-Za-z]*[eu]|-o[[:space:]]+(err_?exit|errexit|nounset|unset))|setopt[[:space:]].*(err_?exit|errexit|nounset|unset))($|[^A-Za-z0-9_./-])|`|\\$[(]";
      const dangerousDefinitionKillOption = "(-s|--signal|-n)[[:space:]]+[^[:space:]]+|--signal=[^[:space:]]+|-[A-Za-z][A-Za-z0-9_-]*|-[0-9]+|--";
      const dangerousDefinitionKillTarget = "\\$\\$|[+]?0+|-[0-9]+";
      const dangerousDefinitionKillVariableTarget = "[\"']?[$][{]?[A-Za-z_][A-Za-z0-9_]*[}]?[\"']?";
      const dangerousDefinitionKillPattern = `(^|[^A-Za-z0-9_.-])([./A-Za-z0-9_-]*/)*kill([[:space:]]+(${dangerousDefinitionKillOption}))*[[:space:]]+(${dangerousDefinitionKillTarget})($|[^A-Za-z0-9_./-])`;
      const dangerousDefinitionKillVariablePattern = `(^|[^A-Za-z0-9_.-])([./A-Za-z0-9_-]*/)*kill([[:space:]]+(${dangerousDefinitionKillOption}))*[[:space:]]+(${dangerousDefinitionKillVariableTarget})($|[^A-Za-z0-9_./-])`;
      const dangerousDefinitionKillAssignmentPattern = "(^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=[[:space:]]*(\\$\\$|[+]?0+|-[0-9]+)($|[^A-Za-z0-9_])";
      const intTrapDefinitionPattern = "(^|[^A-Za-z0-9_./-])trap([^;&|]*[[:space:]])(INT|SIGINT|2)($|[^A-Za-z0-9_./-])";
      const dangerousSourcePatternWord = escapePosixSingleQuotedWord(dangerousSourcePattern);
      const dangerousDefinitionPatternWord = escapePosixSingleQuotedWord(dangerousDefinitionPattern);
      const dangerousDefinitionKillPatternWord = escapePosixSingleQuotedWord(dangerousDefinitionKillPattern);
      const dangerousDefinitionKillVariablePatternWord = escapePosixSingleQuotedWord(dangerousDefinitionKillVariablePattern);
      const dangerousDefinitionKillAssignmentPatternWord = escapePosixSingleQuotedWord(dangerousDefinitionKillAssignmentPattern);
      const intTrapDefinitionPatternWord = escapePosixSingleQuotedWord(intTrapDefinitionPattern);
      const runtimeHelpers = `__NCMCP_use_builtin=0; __NCMCP_bash_builtin_direct=0; __NCMCP_zsh_builtin_safe=0; __NCMCP_bash_plain_cleanup=0; __NCMCP_shell_functions=; __NCMCP_command_is_function=0; __NCMCP_builtin_is_function=0; __NCMCP_t=/bin/test; __NCMCP_printf=; if "$__NCMCP_t" -x /usr/bin/printf; then __NCMCP_printf=/usr/bin/printf; elif "$__NCMCP_t" -x /bin/printf; then __NCMCP_printf=/bin/printf; fi; __NCMCP_p(){ if "$__NCMCP_t" -n "$__NCMCP_printf"; then "$__NCMCP_printf" "$@"; else \\printf "$@"; fi; }; __NCMCP_unset(){ if "$__NCMCP_t" -n "\${BASH_VERSION-}"; then if "$__NCMCP_t" "$__NCMCP_bash_plain_cleanup" = 1; then unset "$@"; elif "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then builtin unset "$@"; else command builtin unset "$@"; fi; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then builtin unset "$@"; else unset "$@"; fi; }; __NCMCP_unset_f(){ if "$__NCMCP_t" -n "\${BASH_VERSION-}"; then if "$__NCMCP_t" "$__NCMCP_bash_plain_cleanup" = 1; then unset -f "$@"; elif "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then builtin unset -f "$@"; else command builtin unset -f "$@"; fi; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then builtin unset -f "$@"; else unset -f "$@"; fi; }; if "$__NCMCP_t" -x /usr/bin/grep; then __NCMCP_grep=/usr/bin/grep; elif "$__NCMCP_t" -x /bin/grep; then __NCMCP_grep=/bin/grep; else __NCMCP_grep=; fi; if "$__NCMCP_t" -n "\${ZSH_VERSION-}"; then __NCMCP_builtin_probe=$(\\type builtin 2>/dev/null || :); if "$__NCMCP_t" -n "$__NCMCP_grep" && __NCMCP_p '%s\\n' "$__NCMCP_builtin_probe" | "$__NCMCP_grep" -Eiq 'builtin' && ! __NCMCP_p '%s\\n' "$__NCMCP_builtin_probe" | "$__NCMCP_grep" -Eiq 'function|not found'; then __NCMCP_zsh_builtin_safe=1; else ${marker}_blocked=1; fi; fi; if "$__NCMCP_t" "$${marker}_runtime_inspection" = 1; then if "$__NCMCP_t" -n "\${BASH_VERSION-}"; then __NCMCP_shell_functions=$(set 2>/dev/null || :); if "$__NCMCP_t" -n "$__NCMCP_grep" && __NCMCP_p '%s\\n' "$__NCMCP_shell_functions" | "$__NCMCP_grep" -Eq '^command[[:space:]]*[(][)]'; then __NCMCP_command_is_function=1; fi; if "$__NCMCP_t" -n "$__NCMCP_grep" && __NCMCP_p '%s\\n' "$__NCMCP_shell_functions" | "$__NCMCP_grep" -Eq '^builtin[[:space:]]*[(][)]'; then __NCMCP_builtin_is_function=1; fi; if "$__NCMCP_t" "$__NCMCP_command_is_function" = 1 && "$__NCMCP_t" "$__NCMCP_builtin_is_function" = 1; then __NCMCP_bash_plain_cleanup=1; ${marker}_blocked=1; elif "$__NCMCP_t" "$__NCMCP_command_is_function" = 1; then __NCMCP_bash_builtin_direct=1; elif "$__NCMCP_t" "$__NCMCP_builtin_is_function" = 1; then __NCMCP_use_builtin=1; else __NCMCP_builtin_probe=$(command builtin type builtin 2>/dev/null || :); if "$__NCMCP_t" -n "$__NCMCP_grep" && __NCMCP_p '%s\\n' "$__NCMCP_builtin_probe" | "$__NCMCP_grep" -Eiq 'builtin' && ! __NCMCP_p '%s\\n' "$__NCMCP_builtin_probe" | "$__NCMCP_grep" -Eiq 'function|not found'; then __NCMCP_use_builtin=1; fi; fi; fi; if "$__NCMCP_t" "$__NCMCP_use_builtin" != 1; then if "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then __NCMCP_type_probe=$(builtin type type 2>/dev/null || :); __NCMCP_command_probe=$(builtin type command 2>/dev/null || :); elif "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then __NCMCP_type_probe=$(builtin type type 2>/dev/null || :); __NCMCP_command_probe="command is a shell builtin"; else __NCMCP_type_probe=$(\\type type 2>/dev/null || :); __NCMCP_command_probe=$(\\type command 2>/dev/null || :); fi; if "$__NCMCP_t" -z "$__NCMCP_type_probe" || "$__NCMCP_t" -z "$__NCMCP_command_probe" || { "$__NCMCP_t" -n "$__NCMCP_grep" && __NCMCP_p '%s\\n%s\\n' "$__NCMCP_type_probe" "$__NCMCP_command_probe" | "$__NCMCP_grep" -Eiq 'function'; }; then ${marker}_blocked=1; fi; fi; if "$__NCMCP_t" "$${marker}_skip_int_trap" != 1 && "$__NCMCP_t" "$__NCMCP_use_builtin" != 1; then if "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1 || "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then __NCMCP_trap_probe=$(builtin type trap 2>/dev/null || :); else __NCMCP_trap_probe=$(\\type trap 2>/dev/null || :); fi; if "$__NCMCP_t" -z "$__NCMCP_trap_probe" || { "$__NCMCP_t" -n "$__NCMCP_grep" && __NCMCP_p '%s\\n' "$__NCMCP_trap_probe" | "$__NCMCP_grep" -Eiq 'function|not found'; }; then ${marker}_skip_int_trap=1; fi; fi; fi`;
      const sourceCheck = `__NCMCP_safe_source_pattern='${safeSourcePatternWord}'; __NCMCP_dangerous_source_pattern='${dangerousSourcePatternWord}'; __NCMCP_dangerous_kill_pattern='${dangerousDefinitionKillPatternWord}'; __NCMCP_dangerous_kill_variable_pattern='${dangerousDefinitionKillVariablePatternWord}'; __NCMCP_dangerous_kill_assignment_pattern='${dangerousDefinitionKillAssignmentPatternWord}'; __NCMCP_source_blocked=$(__NCMCP_p '%s\\n' "$${marker}_source_paths" | while IFS= read -r __NCMCP_source; do if "$__NCMCP_t" -z "$__NCMCP_source"; then continue; fi; if "$__NCMCP_t" "\${__NCMCP_source#~/}" != "$__NCMCP_source"; then __NCMCP_source="$HOME/\${__NCMCP_source#~/}"; fi; if "$__NCMCP_t" -z "$__NCMCP_grep" || ! "$__NCMCP_t" -r "$__NCMCP_source" || "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_source_pattern" "$__NCMCP_source" || "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_pattern" "$__NCMCP_source" || { "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_assignment_pattern" "$__NCMCP_source" && "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_variable_pattern" "$__NCMCP_source"; } || "$__NCMCP_grep" -Evq "$__NCMCP_safe_source_pattern" "$__NCMCP_source"; then __NCMCP_p '1\\n'; fi; done); if "$__NCMCP_t" "\${__NCMCP_source_blocked#*1}" != "$__NCMCP_source_blocked"; then ${marker}_blocked=1; fi`;
      const functionCheck = `__NCMCP_dangerous_def_pattern='${dangerousDefinitionPatternWord}'; __NCMCP_dangerous_kill_pattern='${dangerousDefinitionKillPatternWord}'; __NCMCP_dangerous_kill_variable_pattern='${dangerousDefinitionKillVariablePatternWord}'; __NCMCP_dangerous_kill_assignment_pattern='${dangerousDefinitionKillAssignmentPatternWord}'; __NCMCP_int_trap_def_pattern='${intTrapDefinitionPatternWord}'; __NCMCP_function_blocked=$(__NCMCP_p '%s\\n' "$${marker}_check_words" | while IFS= read -r __NCMCP_word; do if "$__NCMCP_t" -z "$__NCMCP_word"; then continue; fi; if "$__NCMCP_t" -z "$__NCMCP_grep"; then __NCMCP_p '1\\n'; continue; fi; if "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then __NCMCP_type=$(command builtin type "$__NCMCP_word" 2>/dev/null); elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1 || "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then __NCMCP_type=$(builtin type "$__NCMCP_word" 2>/dev/null); else __NCMCP_type=$(\\type "$__NCMCP_word" 2>/dev/null); fi; if __NCMCP_p '%s\\n' "$__NCMCP_type" | "$__NCMCP_grep" -Eiq 'autoload|undefined shell function'; then __NCMCP_p '1\\n'; elif __NCMCP_p '%s\\n' "$__NCMCP_type" | "$__NCMCP_grep" -Eiq ' alias|aliased '; then if "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then __NCMCP_def=$(command builtin alias "$__NCMCP_word" 2>/dev/null); elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1 || "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then __NCMCP_def=$(builtin alias "$__NCMCP_word" 2>/dev/null); else __NCMCP_def=$(\\alias "$__NCMCP_word" 2>/dev/null); fi; if __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_def_pattern" || __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_pattern" || { __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_assignment_pattern" && __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_variable_pattern"; }; then __NCMCP_p '1\\n'; fi; if __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_int_trap_def_pattern"; then __NCMCP_p 'T\\n'; fi; elif __NCMCP_p '%s\\n' "$__NCMCP_type" | "$__NCMCP_grep" -Eiq ' function|shell function'; then if "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then __NCMCP_def=$( { command builtin type "$__NCMCP_word"; command builtin typeset -f "$__NCMCP_word"; command builtin functions "$__NCMCP_word"; } 2>/dev/null ); elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1 || "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then __NCMCP_def=$( { builtin type "$__NCMCP_word"; builtin typeset -f "$__NCMCP_word"; builtin functions "$__NCMCP_word"; } 2>/dev/null ); else __NCMCP_def=$( { \\type "$__NCMCP_word"; \\typeset -f "$__NCMCP_word"; \\functions "$__NCMCP_word"; } 2>/dev/null ); fi; if __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_def_pattern" || __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_pattern" || { __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_assignment_pattern" && __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_dangerous_kill_variable_pattern"; }; then __NCMCP_p '1\\n'; fi; if __NCMCP_p '%s\\n' "$__NCMCP_def" | "$__NCMCP_grep" -Eiq "$__NCMCP_int_trap_def_pattern"; then __NCMCP_p 'T\\n'; fi; fi; done); if "$__NCMCP_t" "\${__NCMCP_function_blocked#*1}" != "$__NCMCP_function_blocked"; then ${marker}_blocked=1; fi; if "$__NCMCP_t" "\${__NCMCP_function_blocked#*T}" != "$__NCMCP_function_blocked" && "$__NCMCP_t" "$__NCMCP_set_int_trap" = 1; then if "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then command builtin trap - INT; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then builtin trap - INT; else \\trap - INT; fi; __NCMCP_set_int_trap=0; fi`;
      const cleanupVariables = `__NCMCP_use_builtin __NCMCP_shell_functions __NCMCP_command_is_function __NCMCP_builtin_is_function __NCMCP_printf __NCMCP_grep __NCMCP_builtin_probe __NCMCP_type_probe __NCMCP_command_probe __NCMCP_trap_probe __NCMCP_safe_source_pattern __NCMCP_dangerous_source_pattern __NCMCP_source_blocked __NCMCP_source __NCMCP_dangerous_def_pattern __NCMCP_dangerous_kill_pattern __NCMCP_dangerous_kill_variable_pattern __NCMCP_dangerous_kill_assignment_pattern __NCMCP_int_trap_def_pattern __NCMCP_function_blocked __NCMCP_word __NCMCP_type __NCMCP_def __NCMCP_set_int_trap __NCMCP_int_seen __NCMCP_rc __NCMCP_status ${marker} ${marker}_cmd ${marker}_blocked ${marker}_isolate ${marker}_isolate_on_errexit ${marker}_isolate_on_nounset ${marker}_disables_errexit ${marker}_disables_nounset ${marker}_errexit ${marker}_nounset ${marker}_skip_int_trap ${marker}_runtime_inspection ${marker}_check_words ${marker}_source_paths ${marker}_flags ${marker}_traps`;
      const cleanupCoreVariables = "__NCMCP_bash_builtin_direct __NCMCP_zsh_builtin_safe __NCMCP_bash_plain_cleanup __NCMCP_t";
      const cleanupRuntime = `__NCMCP_unset ${cleanupVariables} 2>/dev/null; __NCMCP_unset_f __NCMCP_p __NCMCP_unset __NCMCP_unset_f 2>/dev/null; if "$__NCMCP_t" -n "\${BASH_VERSION-}"; then if "$__NCMCP_t" "$__NCMCP_bash_plain_cleanup" = 1; then unset ${cleanupCoreVariables} 2>/dev/null; elif "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then builtin unset ${cleanupCoreVariables} 2>/dev/null; else command builtin unset ${cleanupCoreVariables} 2>/dev/null; fi; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then builtin unset ${cleanupCoreVariables} 2>/dev/null; else unset ${cleanupCoreVariables} 2>/dev/null; fi`;
      // Leading single space: lets bash/zsh skip recording this command
      // in history when the user already has HISTCONTROL=ignorespace
      // (bash) or HIST_IGNORE_SPACE (zsh) configured — Debian/Ubuntu and
      // most Oh-My-Zsh setups have this on by default; CentOS/RHEL users
      // can opt in by adding `HISTCONTROL=ignoreboth` to ~/.bashrc.
      // Without that config the prefix is harmless; it just doesn't
      // suppress history recording.
      return (
        ` ${marker}=0; ${marker}_cmd='${escaped}'; ${marker}_blocked=${blockUnsafe}; ${marker}_isolate=${isolate}; ${marker}_isolate_on_errexit=${isolateOnErrexit}; ${marker}_isolate_on_nounset=${isolateOnNounset}; ${marker}_disables_errexit=${disablesErrexit}; ${marker}_disables_nounset=${disablesNounset}; ${marker}_errexit=0; ${marker}_nounset=0; ${marker}_skip_int_trap=${skipTemporaryIntTrap}; ${marker}_runtime_inspection=${runtimeInspection}; ${marker}_check_words='${functionCheckWords}'; ${marker}_source_paths='${sourceCheckPaths}'; ${marker}_flags=$-; ${runtimeHelpers}; if "$__NCMCP_t" "$${marker}_skip_int_trap" = 1; then ${marker}_traps=; elif "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then ${marker}_traps=$(command builtin trap); elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then ${marker}_traps=$(builtin trap); else ${marker}_traps=$(\\trap); fi; { __NCMCP_p '%s\\n' '${marker}_S'; __NCMCP_set_int_trap=0; case "$${marker}_skip_int_trap:$${marker}_traps" in 1:*|*:*" INT"*|*:*" SIGINT"*) ;; *) __NCMCP_set_int_trap=1; if "$__NCMCP_t" "$__NCMCP_use_builtin" = 1; then command builtin trap '${temporaryIntTrap}' INT; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then builtin trap '${temporaryIntTrap}' INT; else \\trap '${temporaryIntTrap}' INT; fi ;; esac; case "$${marker}_flags" in *e*) set +e; if "$__NCMCP_t" "$${marker}_isolate_on_errexit" = 1; then ${marker}_isolate=1; ${marker}_errexit=1; fi ;; esac; case "$${marker}_flags" in *u*) set +u; if "$__NCMCP_t" "$${marker}_isolate_on_nounset" = 1; then ${marker}_isolate=1; ${marker}_nounset=1; fi ;; esac; ${sourceCheck}; ${functionCheck}; if "$__NCMCP_t" "$${marker}_blocked" = 1; then __NCMCP_p '%s\\n' 'Blocked unsafe shell-terminating command'; __NCMCP_rc=126; elif "$__NCMCP_t" "$${marker}_isolate" = 1; then ( if "$__NCMCP_t" "$${marker}_errexit" = 1; then set -e; fi; if "$__NCMCP_t" "$${marker}_nounset" = 1; then set -u; fi; if "$__NCMCP_t" -n "\${BASH_VERSION-}"; then if "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then ${noPager}builtin eval "$${marker}_cmd"; else ${noPager}command builtin eval "$${marker}_cmd"; fi; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then ${noPager}builtin eval "$${marker}_cmd"; else ${noPager}eval "$${marker}_cmd"; fi ); __NCMCP_rc=$?; else if "$__NCMCP_t" -n "\${BASH_VERSION-}"; then if "$__NCMCP_t" "$__NCMCP_bash_builtin_direct" = 1; then ${noPager}builtin eval "$${marker}_cmd"; else ${noPager}command builtin eval "$${marker}_cmd"; fi; elif "$__NCMCP_t" "$__NCMCP_zsh_builtin_safe" = 1; then ${noPager}builtin eval "$${marker}_cmd"; else ${noPager}eval "$${marker}_cmd"; fi; __NCMCP_rc=$?; fi; __NCMCP_status=$__NCMCP_rc; __NCMCP_p '\\n%s\\n' '${marker}_E:'\"$__NCMCP_status\"; ${restoreIntTrap}; case "$${marker}_flags:$${marker}_disables_nounset" in *u*:0) set -u ;; esac; case "$${marker}_flags:$${marker}_disables_errexit" in *e*:0) set -e; ${cleanupRuntime} ;; *) ${cleanupRuntime} ;; esac; }\n`
      );
    }
  }
}

function findEndMarker(outputText, marker) {
  const endPattern = marker + "_E:";
  let searchFrom = 0;
  while (searchFrom < outputText.length) {
    const endIdx = outputText.indexOf(endPattern, searchFrom);
    if (endIdx === -1) return null;

    // Accept if at start of output, or preceded by \n or \r (line boundary)
    if (endIdx === 0 || outputText[endIdx - 1] === "\n" || outputText[endIdx - 1] === "\r") {
      const afterEnd = outputText.slice(endIdx + endPattern.length);
      const codeMatch = afterEnd.match(/^(\d+)/);
      const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : null;
      if (exitCode !== null) {
        return { endIdx, exitCode };
      }
    }
    searchFrom = endIdx + 1;
  }
  return null;
}

function normalizePtyOutput(stdout, {
  stripMarkers = false,
  expectedPrompt = "",
  trimOutput = true,
  stripPrompt = true,
  markerToStrip = null,
} = {}) {
  let cleaned = stripAnsi(stdout || "").replace(/\r/g, "");
  if (stripMarkers) {
    // Prefer the job-specific marker so user output that contains "__NCMCP_"
    // (e.g. printf '__NCMCP_demo\n') is preserved.
    const pattern = markerToStrip
      ? new RegExp(`^[^\r\n]*${markerToStrip}[^\r\n]*[\r\n]*`, "gm")
      : /^[^\r\n]*__NCMCP_[^\r\n]*[\r\n]*/gm;
    cleaned = cleaned.replace(pattern, "");
  }
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  if (stripPrompt && normalizedPrompt && cleaned.endsWith(normalizedPrompt)) {
    cleaned = cleaned.slice(0, cleaned.length - normalizedPrompt.length);
  }
  return trimOutput ? cleaned.trim() : cleaned;
}

function appendBoundedOutput(current, chunk, maxBufferedChars) {
  const combined = `${current || ""}${chunk || ""}`;
  const limit = Number.isFinite(maxBufferedChars) ? Math.max(0, Math.floor(maxBufferedChars)) : 0;
  if (limit <= 0 || combined.length <= limit) {
    return { text: combined, dropped: 0 };
  }
  const dropped = combined.length - limit;
  return {
    text: combined.slice(dropped),
    dropped,
  };
}

function consumeVisibleText(carry, chunk) {
  const input = `${carry || ""}${chunk || ""}`;
  if (!input) {
    return { visibleText: "", carry: "" };
  }

  let visibleText = "";
  let index = 0;

  while (index < input.length) {
    const ch = input[index];

    if (ch === "\r") {
      // Preserve \r so consumers / serializers can collapse progress-bar
      // redraws to the latest frame. \r\n becomes a single \n.
      if (input[index + 1] === "\n") {
        visibleText += "\n";
        index += 2;
        continue;
      }
      visibleText += "\r";
      index += 1;
      continue;
    }

    if (ch !== "\u001b") {
      visibleText += ch;
      index += 1;
      continue;
    }

    if (index + 1 >= input.length) {
      break;
    }

    const next = input[index + 1];

    if (next === "[") {
      let cursor = index + 2;
      let complete = false;
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
          index = cursor + 1;
          complete = true;
          break;
        }
        cursor += 1;
      }
      if (!complete) break;
      continue;
    }

    if (next === "]") {
      let cursor = index + 2;
      let complete = false;
      while (cursor < input.length) {
        const oscChar = input[cursor];
        if (oscChar === "\u0007") {
          index = cursor + 1;
          complete = true;
          break;
        }
        if (oscChar === "\u001b") {
          if (cursor + 1 >= input.length) break;
          if (input[cursor + 1] === "\\") {
            index = cursor + 2;
            complete = true;
            break;
          }
        }
        cursor += 1;
      }
      if (!complete) break;
      continue;
    }

    visibleText += ch;
    index += 1;
  }

  return {
    visibleText,
    carry: input.slice(index),
  };
}

module.exports = {
  createStatefulDecoder,
  detectShellKind,
  subscribeToPtyData,
  hasExpectedPromptSuffix,
  resolveEffectiveShellKind,
  buildWrappedCommand,
  findEndMarker,
  normalizePtyOutput,
  appendBoundedOutput,
  consumeVisibleText,
  stripAnsi,
};
