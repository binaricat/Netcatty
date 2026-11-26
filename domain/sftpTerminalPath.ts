export type SftpTerminalShellKind = "posix" | "fish" | "unix-portable" | "powershell" | "cmd";

export type SftpTerminalPathContext = {
  sessionId?: string | null;
  sessionStatus?: string | null;
  sessionHostId?: string | null;
  sftpHostId?: string | null;
  sftpIsLocal?: boolean;
  protocol?: string | null;
  shellType?: string | null;
  hostOs?: string | null;
  promptText?: string | null;
  isNetworkDevice?: boolean;
  sessionHostname?: string | null;
  sessionUsername?: string | null;
  sessionPort?: number | null;
  sftpHostname?: string | null;
  sftpUsername?: string | null;
  sftpPort?: number | null;
};

const POSIX_SAFE_UNQUOTED_RE = /^[A-Za-z0-9._/@:+][A-Za-z0-9._/@:+-]*$/;
const WINDOWS_SAFE_UNQUOTED_RE = /^[A-Za-z0-9._\\/:+][A-Za-z0-9._\\/:+-]*$/;
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_OPENSSH_DRIVE_PATH_RE = /^\/[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\]+\\[^\\]+/;
// PowerShell prompt (e.g. `PS C:\Users\alice> `, `PS /home/alice> `, `(venv) PS C:\> `).
const POWERSHELL_PROMPT_RE = /^(?:\([^)]+\)\s+)*PS\s+(?:[A-Za-z]:[\\/]|\\\\|\/|~|\S+[^>]*)\s*>\s*$/;
// cmd.exe prompt (e.g. `C:\Users\alice>`, `D:\work>`).
const CMD_PROMPT_RE = /^[A-Za-z]:\\[^>]*>\s*$/;
// PowerShell treats curly single quotes (U+2018..U+201B) as string delimiters.
const POWERSHELL_SINGLE_QUOTE_RE = /['\u2018\u2019\u201A\u201B]/g;
const POWERSHELL_SINGLE_QUOTE_CHARS = new Set(["'", "\u2018", "\u2019", "\u201A", "\u201B"]);
const POWERSHELL_DOUBLE_QUOTE_CHARS = new Set(['"', "\u201C", "\u201D", "\u201E"]);
const CONTINUATION_PROMPT_WORD =
  "(?:[a-z]*quote|heredoc|cmdsubst|pipe|for|if|while|until|case|select|then|else|elif|cursh|subsh|brace|math|array|param|function|repeat|foreach|eval|and|or)";
const CONTINUATION_PROMPT_RE = new RegExp(
  `^(?:(?:${CONTINUATION_PROMPT_WORD}(?:\\s+${CONTINUATION_PROMPT_WORD})*)?>|>>?|More\\?)\\s*$`,
  "i",
);

/**
 * True when a string contains control bytes (C0, DEL, C1) or Unicode line
 * separators that an interactive PTY, readline, or shell could interpret as
 * keystrokes or command terminators even inside quotes.
 */
export function hasUnsafeTerminalControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (
      code <= 0x1f
      || (code >= 0x7f && code <= 0x9f)
      || code === 0x2028
      || code === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function isWindowsStylePath(path?: string | null): boolean {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) return false;
  return WINDOWS_DRIVE_PATH_RE.test(trimmed)
    || WINDOWS_OPENSSH_DRIVE_PATH_RE.test(trimmed)
    || WINDOWS_UNC_PATH_RE.test(trimmed);
}

/**
 * Normalize Windows OpenSSH SFTP drive paths (e.g. `/C:/Users/alice`) into
 * native drive-letter paths (`C:\Users\alice`) for PowerShell and cmd.exe.
 */
function normalizeWindowsShellPath(
  path: string,
  shellKind: "powershell" | "cmd",
): string {
  if (WINDOWS_OPENSSH_DRIVE_PATH_RE.test(path)) {
    return path.slice(1).replace(/\//g, "\\");
  }
  if (shellKind === "cmd" && WINDOWS_DRIVE_PATH_RE.test(path)) {
    return path.replace(/\//g, "\\");
  }
  return path;
}

/**
 * Map a terminal session's shellType, live prompt text, host OS, and path
 * shape to a concrete quoting dialect.
 *
 * When `shellType` is unset on a remote session:
 * - Recognizes PowerShell (`PS ...>`) and CMD (`C:\...>`) from the live prompt.
 * - Refuses (`null`) on Windows hosts or Windows drive/UNC paths when the
 *   active Windows shell dialect cannot be identified, avoiding incompatible
 *   POSIX quoting.
 * - Uses `"unix-portable"` on non-Windows hosts so quoting works identically
 *   across POSIX shells (sh/bash/zsh/dash/ksh) and fish, even for paths
 *   containing backslashes.
 */
export function resolveSftpTerminalShellKind(
  shellType?: string | null,
  options?: {
    promptText?: string | null;
    hostOs?: string | null;
    path?: string | null;
  },
): SftpTerminalShellKind | null {
  if (
    shellType === "posix"
    || shellType === "fish"
    || shellType === "powershell"
    || shellType === "cmd"
  ) {
    return shellType;
  }

  const prompt = options?.promptText?.trim() ?? "";
  if (prompt) {
    if (POWERSHELL_PROMPT_RE.test(prompt)) return "powershell";
    if (CMD_PROMPT_RE.test(prompt)) return "cmd";
  }

  const isWindowsHost = options?.hostOs?.trim().toLowerCase() === "windows";
  if (isWindowsHost || isWindowsStylePath(options?.path)) {
    return null;
  }

  return "unix-portable";
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteFishSingle(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Quote a path so it evaluates to the exact same literal string in both POSIX
 * shells (sh/bash/zsh/dash/ksh) and fish. Single quotes keep `$`, `` ` ``, `"`,
 * spaces, and globs literal, while `'` and `\` are emitted outside single
 * quotes as `\'` and `\\`, which both POSIX and fish unescape identically.
 */
function quoteUnixPortable(value: string): string {
  let out = "";
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      out += `'${buf}'`;
      buf = "";
    }
  };
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'") {
      flush();
      out += "\\'";
    } else if (ch === "\\") {
      flush();
      out += "\\\\";
    } else {
      buf += ch;
    }
  }
  flush();
  return out || "''";
}

function quoteUnixPath(
  value: string,
  shellKind: "posix" | "fish" | "unix-portable",
): string {
  if (shellKind === "fish") return quoteFishSingle(value);
  if (shellKind === "unix-portable") return quoteUnixPortable(value);
  return quotePosixSingle(value);
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(POWERSHELL_SINGLE_QUOTE_RE, "$&$&")}'`;
}

function isPosixCdPathEligible(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (WINDOWS_DRIVE_PATH_RE.test(trimmed) || WINDOWS_OPENSSH_DRIVE_PATH_RE.test(trimmed)) {
    return false;
  }
  return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/");
}

function isPowerShellCdPathEligible(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return WINDOWS_DRIVE_PATH_RE.test(trimmed)
    || WINDOWS_UNC_PATH_RE.test(trimmed)
    || trimmed.startsWith("/")
    || trimmed === "~"
    || trimmed.startsWith("~/")
    || trimmed.startsWith("~\\");
}

function isCmdCdPathEligible(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return WINDOWS_DRIVE_PATH_RE.test(trimmed);
}

/**
 * Quote a filesystem path for safe insertion into an interactive shell line.
 * Returns null if the path is blank, contains control characters, or contains
 * shell-unquotable expansion characters (e.g. `"`, `%`, `!` in interactive cmd.exe).
 */
export function quoteSftpPathForShell(
  path: string | null | undefined,
  shellKind: SftpTerminalShellKind = "posix",
): string | null {
  if (!path || !path.trim()) return null;
  if (hasUnsafeTerminalControlChars(path)) return null;

  if (shellKind === "powershell") {
    const normalized = normalizeWindowsShellPath(path, "powershell");
    if (WINDOWS_SAFE_UNQUOTED_RE.test(normalized)) return normalized;
    return quotePowerShellSingle(normalized);
  }

  if (shellKind === "cmd") {
    const normalized = normalizeWindowsShellPath(path, "cmd");
    // Interactive cmd.exe expands %VAR% and delayed !VAR! inside double quotes,
    // and double quotes cannot be safely escaped without risking command breakout.
    if (normalized.includes('"') || normalized.includes("%") || normalized.includes("!")) return null;
    if (WINDOWS_SAFE_UNQUOTED_RE.test(normalized)) return normalized;
    return `"${normalized}"`;
  }

  if (POSIX_SAFE_UNQUOTED_RE.test(path)) return path;
  return quoteUnixPath(path, shellKind);
}

/**
 * Format an SFTP file or directory path for inserting at the cursor in an
 * interactive terminal (quoted as needed, followed by a trailing space, no CR/LF).
 */
export function formatSftpPathForTerminalInsert(
  path: string | null | undefined,
  shellKind: SftpTerminalShellKind = "posix",
): string | null {
  const quoted = quoteSftpPathForShell(path, shellKind);
  if (!quoted) return null;
  return `${quoted} `;
}

/**
 * Format a safe interactive `cd` command (without trailing CR) for the target shell.
 */
export function formatSftpCdCommand(
  dirPath: string | null | undefined,
  shellKind: SftpTerminalShellKind = "posix",
): string | null {
  if (!dirPath || !dirPath.trim()) return null;
  if (hasUnsafeTerminalControlChars(dirPath)) return null;

  if (shellKind === "powershell") {
    const normalized = normalizeWindowsShellPath(dirPath, "powershell");
    if (!isPowerShellCdPathEligible(normalized)) return null;
    if (normalized === "~") return "cd ~";
    return `cd -LiteralPath ${quotePowerShellSingle(normalized)}`;
  }

  if (shellKind === "cmd") {
    const normalized = normalizeWindowsShellPath(dirPath, "cmd");
    if (!isCmdCdPathEligible(normalized)) return null;
    if (normalized.includes('"') || normalized.includes("%") || normalized.includes("!")) return null;
    return `cd /d "${normalized}"`;
  }

  if (!isPosixCdPathEligible(dirPath)) return null;
  if (dirPath === "~") return "cd -- ~";
  if (dirPath.startsWith("~/")) {
    const suffix = dirPath.slice(2);
    if (!suffix) return "cd -- ~";
    const quotedSuffix = quoteUnixPath(suffix, shellKind);
    return `cd -- ~/${quotedSuffix}`;
  }
  const quotedDir = quoteUnixPath(dirPath, shellKind);
  return `cd -- ${quotedDir}`;
}

function remoteEndpointsMatch(options: SftpTerminalPathContext): boolean {
  if (!options.sessionHostname || !options.sftpHostname) return true;
  return options.sessionHostname === options.sftpHostname
    && (options.sessionPort ?? 22) === (options.sftpPort ?? 22)
    && (options.sessionUsername || "root") === (options.sftpUsername || "root");
}

/**
 * Whether an SFTP side panel is paired with a connected terminal session on the
 * same host/endpoint where paths may be inserted or `cd`'d into.
 */
export function canSendSftpPathToTerminal(
  options: SftpTerminalPathContext,
): boolean {
  if (!options.sessionId || options.sessionStatus !== "connected") return false;
  if (options.isNetworkDevice) return false;

  const protocol = options.protocol ?? "ssh";
  if (protocol === "telnet" || protocol === "serial") return false;

  if (options.sftpIsLocal) {
    return protocol === "local";
  }

  if (!options.sftpHostId || !options.sessionHostId) return false;
  if (options.sftpHostId !== options.sessionHostId) return false;
  if (!remoteEndpointsMatch(options)) return false;

  return protocol === "ssh"
    || protocol === "mosh"
    || protocol === "et"
    || protocol === "local";
}

const POSIX_IDENTIFIER_CHAR_RE = /[A-Za-z0-9_]/;
const POSIX_LET_COMMAND_RE = /^\s*let(?:\s+|$)/;
const POSIX_DOUBLE_BRACKET_ARITH_OP_RE = /(?:^|\s)-(?:eq|ne|lt|le|gt|ge)\s+\S*$/;

function isPosixDraftSafeForPathInsertion(draft: string): boolean {
  type Frame =
    | { kind: "single" }
    | { kind: "ansiSingle" }
    | { kind: "double" }
    | { kind: "backtick" }
    | { kind: "cmdsubst"; parenDepth: number; segmentStart: number }
    | { kind: "arith"; parenDepth: number }
    | { kind: "arithBracket"; bracketDepth: number }
    | { kind: "param" }
    | { kind: "subscript"; bracketDepth: number }
    | { kind: "doubleBracket"; startIdx: number };

  const stack: Frame[] = [];
  let rootSegmentStart = 0;

  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft[i];
    const top = stack[stack.length - 1];

    if (top?.kind === "single") {
      if (ch === "'") stack.pop();
      continue;
    }

    if (top?.kind === "ansiSingle") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "'") stack.pop();
      continue;
    }

    if (top?.kind === "double") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(" && draft[i + 2] === "(") {
        stack.push({ kind: "arith", parenDepth: 0 });
        i += 2;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(") {
        stack.push({ kind: "cmdsubst", parenDepth: 0, segmentStart: i + 2 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "[") {
        stack.push({ kind: "arithBracket", bracketDepth: 0 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "{") {
        stack.push({ kind: "param" });
        i += 1;
        continue;
      }
      if (ch === "`") {
        stack.push({ kind: "backtick" });
        continue;
      }
      if (ch === '"') stack.pop();
      continue;
    }

    if (top?.kind === "backtick") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "`") stack.pop();
      continue;
    }

    if (top?.kind === "arith") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(" && draft[i + 2] === "(") {
        stack.push({ kind: "arith", parenDepth: 0 });
        i += 2;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(") {
        stack.push({ kind: "cmdsubst", parenDepth: 0, segmentStart: i + 2 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "[") {
        stack.push({ kind: "arithBracket", bracketDepth: 0 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "{") {
        stack.push({ kind: "param" });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "'") {
        stack.push({ kind: "ansiSingle" });
        i += 1;
        continue;
      }
      if (ch === "'") {
        stack.push({ kind: "single" });
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "double" });
        continue;
      }
      if (ch === "`") {
        stack.push({ kind: "backtick" });
        continue;
      }
      if (ch === "(") {
        top.parenDepth += 1;
        continue;
      }
      if (ch === ")") {
        if (top.parenDepth > 0) {
          top.parenDepth -= 1;
          continue;
        }
        if (draft[i + 1] === ")") {
          stack.pop();
          i += 1;
        }
      }
      continue;
    }

    if (top?.kind === "arithBracket") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "'") {
        stack.push({ kind: "ansiSingle" });
        i += 1;
        continue;
      }
      if (ch === "'") {
        stack.push({ kind: "single" });
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "double" });
        continue;
      }
      if (ch === "`") {
        stack.push({ kind: "backtick" });
        continue;
      }
      if (ch === "[") {
        top.bracketDepth += 1;
        continue;
      }
      if (ch === "]") {
        if (top.bracketDepth > 0) {
          top.bracketDepth -= 1;
        } else {
          stack.pop();
        }
      }
      continue;
    }

    if (top?.kind === "param") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "'") {
        stack.push({ kind: "ansiSingle" });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(" && draft[i + 2] === "(") {
        stack.push({ kind: "arith", parenDepth: 0 });
        i += 2;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(") {
        stack.push({ kind: "cmdsubst", parenDepth: 0, segmentStart: i + 2 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "[") {
        stack.push({ kind: "arithBracket", bracketDepth: 0 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "{") {
        stack.push({ kind: "param" });
        i += 1;
        continue;
      }
      if (ch === "'") {
        stack.push({ kind: "single" });
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "double" });
        continue;
      }
      if (ch === "`") {
        stack.push({ kind: "backtick" });
        continue;
      }
      if (ch === "}") {
        stack.pop();
      }
      continue;
    }

    if (top?.kind === "subscript") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "'") {
        stack.push({ kind: "ansiSingle" });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(" && draft[i + 2] === "(") {
        stack.push({ kind: "arith", parenDepth: 0 });
        i += 2;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(") {
        stack.push({ kind: "cmdsubst", parenDepth: 0, segmentStart: i + 2 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "[") {
        stack.push({ kind: "arithBracket", bracketDepth: 0 });
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "{") {
        stack.push({ kind: "param" });
        i += 1;
        continue;
      }
      if (ch === "'") {
        stack.push({ kind: "single" });
        continue;
      }
      if (ch === '"') {
        stack.push({ kind: "double" });
        continue;
      }
      if (ch === "`") {
        stack.push({ kind: "backtick" });
        continue;
      }
      if (ch === "[") {
        top.bracketDepth += 1;
        continue;
      }
      if (ch === "]") {
        if (top.bracketDepth > 0) {
          top.bracketDepth -= 1;
        } else {
          stack.pop();
        }
      }
      continue;
    }

    // Outside quotes (top === undefined, "cmdsubst", or "doubleBracket")
    if (ch === "\\") {
      if (i + 1 >= draft.length) return false;
      i += 1;
      continue;
    }
    if (ch === "$" && i === draft.length - 1) {
      // A trailing unescaped `$` would fuse with an inserted `'...'` into
      // POSIX/Bash/Zsh ANSI-C `$'...'`, where `\'` escapes quotes.
      return false;
    }
    if (ch === "$" && draft[i + 1] === "'") {
      stack.push({ kind: "ansiSingle" });
      i += 1;
      continue;
    }
    if (ch === "$" && draft[i + 1] === "(" && draft[i + 2] === "(") {
      stack.push({ kind: "arith", parenDepth: 0 });
      i += 2;
      continue;
    }
    if (ch === "$" && draft[i + 1] === "(") {
      stack.push({ kind: "cmdsubst", parenDepth: 0, segmentStart: i + 2 });
      i += 1;
      continue;
    }
    if (ch === "$" && draft[i + 1] === "[") {
      stack.push({ kind: "arithBracket", bracketDepth: 0 });
      i += 1;
      continue;
    }
    if (ch === "$" && draft[i + 1] === "{") {
      stack.push({ kind: "param" });
      i += 1;
      continue;
    }
    if (ch === "(" && draft[i + 1] === "(") {
      stack.push({ kind: "arith", parenDepth: 0 });
      i += 1;
      continue;
    }
    if (
      ch === "["
      && draft[i + 1] === "["
      && (i === 0 || /[\s;|&(\n]/.test(draft[i - 1]))
      && (i + 2 >= draft.length || /\s/.test(draft[i + 2]))
    ) {
      stack.push({ kind: "doubleBracket", startIdx: i + 2 });
      i += 1;
      continue;
    }
    if (
      top?.kind === "doubleBracket"
      && ch === "]"
      && draft[i + 1] === "]"
    ) {
      stack.pop();
      i += 1;
      continue;
    }
    if (ch === "[" && i > 0 && POSIX_IDENTIFIER_CHAR_RE.test(draft[i - 1])) {
      // Array element subscript (e.g. `a[`, `unset arr[`, `declare a[`) is
      // evaluated in arithmetic context by Bash/Zsh where single quotes do not
      // suppress `$(...)` expansion.
      stack.push({ kind: "subscript", bracketDepth: 0 });
      continue;
    }
    if (ch === "'") {
      stack.push({ kind: "single" });
      continue;
    }
    if (ch === '"') {
      stack.push({ kind: "double" });
      continue;
    }
    if (ch === "`") {
      stack.push({ kind: "backtick" });
      continue;
    }
    if (ch === "(" && top?.kind === "cmdsubst") {
      top.parenDepth += 1;
      top.segmentStart = i + 1;
      continue;
    }
    if (ch === ")" && top?.kind === "cmdsubst") {
      if (top.parenDepth > 0) {
        top.parenDepth -= 1;
      } else {
        stack.pop();
      }
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "(") {
      if (top?.kind === "cmdsubst") {
        top.segmentStart = i + 1;
      } else if (top === undefined) {
        rootSegmentStart = i + 1;
      }
    }
  }

  // Reject if any enclosing frame is an arithmetic, parameter-expansion, or
  // array-subscript context (even when nested inside `$(...)`, whose output
  // would still be re-evaluated by the enclosing arithmetic expression).
  if (
    stack.some(
      (frame) =>
        frame.kind === "arith"
        || frame.kind === "arithBracket"
        || frame.kind === "param"
        || frame.kind === "subscript",
    )
  ) {
    return false;
  }

  const top = stack[stack.length - 1];
  if (top?.kind === "doubleBracket") {
    const tail = draft.slice(top.startIdx);
    if (POSIX_DOUBLE_BRACKET_ARITH_OP_RE.test(tail)) {
      return false;
    }
    return true;
  }
  if (top !== undefined && top.kind !== "cmdsubst") {
    return false;
  }

  // Bash/Zsh `let` evaluates all arguments as arithmetic expressions.
  const segmentStart = top?.kind === "cmdsubst" ? top.segmentStart : rootSegmentStart;
  const activeSegment = draft.slice(segmentStart);
  if (POSIX_LET_COMMAND_RE.test(activeSegment)) {
    return false;
  }

  return true;
}

function isFishDraftSafeForPathInsertion(draft: string): boolean {
  let mode: "none" | "single" | "double" = "none";

  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft[i];
    if (ch === "\\") {
      if (i + 1 >= draft.length) return false;
      i += 1;
      continue;
    }
    if (mode === "none") {
      if (ch === "$" && i === draft.length - 1) return false;
      if (ch === "'") mode = "single";
      else if (ch === '"') mode = "double";
    } else if (mode === "single") {
      if (ch === "'") mode = "none";
    } else if (ch === '"') {
      mode = "none";
    }
  }

  return mode === "none";
}

function isPowerShellDraftSafeForPathInsertion(draft: string): boolean {
  type Context = "single" | "double" | "cmdsubst";
  const stack: Context[] = [];

  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft[i];
    const top = stack[stack.length - 1];

    if (top === "single") {
      if (POWERSHELL_SINGLE_QUOTE_CHARS.has(ch)) {
        if (i + 1 < draft.length && POWERSHELL_SINGLE_QUOTE_CHARS.has(draft[i + 1])) {
          i += 1;
        } else {
          stack.pop();
        }
      }
      continue;
    }

    if (top === "double") {
      if (ch === "`") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(") {
        stack.push("cmdsubst");
        i += 1;
        continue;
      }
      if (POWERSHELL_DOUBLE_QUOTE_CHARS.has(ch)) {
        if (i + 1 < draft.length && POWERSHELL_DOUBLE_QUOTE_CHARS.has(draft[i + 1])) {
          i += 1;
        } else {
          stack.pop();
        }
      }
      continue;
    }

    // Outside quotes (top === undefined or top === "cmdsubst")
    if (ch === "`") {
      if (i + 1 >= draft.length) return false;
      i += 1;
      continue;
    }
    if (ch === "@" && i === draft.length - 1) {
      // A trailing `@` would fuse with an inserted `'...'` into a PowerShell here-string (`@'`).
      return false;
    }
    if (ch === "$" && draft[i + 1] === "(") {
      stack.push("cmdsubst");
      i += 1;
      continue;
    }
    if (POWERSHELL_SINGLE_QUOTE_CHARS.has(ch)) {
      stack.push("single");
      continue;
    }
    if (POWERSHELL_DOUBLE_QUOTE_CHARS.has(ch)) {
      stack.push("double");
      continue;
    }
    if (ch === ")" && top === "cmdsubst") {
      stack.pop();
    }
  }

  const top = stack[stack.length - 1];
  return top === undefined || top === "cmdsubst";
}

function isCmdDraftSafeForPathInsertion(draft: string): boolean {
  let inDouble = false;

  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft[i];
    if (!inDouble) {
      if (ch === "^") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = true;
    } else if (ch === '"') {
      inDouble = false;
    }
  }

  return !inDouble;
}

/**
 * True when the command draft before the cursor is outside any open quote,
 * backtick substitution, or trailing escape character, so inserting a
 * standalone shell-quoted path cannot break out of or interpolate inside quotes.
 */
export function isShellDraftSafeForPathInsertion(
  draft: string,
  shellKind: SftpTerminalShellKind = "posix",
): boolean {
  if (!draft) return true;
  if (shellKind === "fish") return isFishDraftSafeForPathInsertion(draft);
  if (shellKind === "unix-portable") {
    return isPosixDraftSafeForPathInsertion(draft) && isFishDraftSafeForPathInsertion(draft);
  }
  if (shellKind === "powershell") return isPowerShellDraftSafeForPathInsertion(draft);
  if (shellKind === "cmd") return isCmdDraftSafeForPathInsertion(draft);
  return isPosixDraftSafeForPathInsertion(draft);
}

/** True when a shell prompt is a secondary/continuation prompt (e.g. PS2 `>`, `dquote>`). */
export function isTerminalContinuationPrompt(promptText: string): boolean {
  return CONTINUATION_PROMPT_RE.test(promptText.trim());
}

/**
 * Validate the live terminal prompt + draft text (combining screen prefix up to
 * the cursor and any un-echoed typed buffer) before inserting a quoted path.
 */
export function isTerminalDraftContextSafeForPathInsertion(options: {
  promptText?: string;
  userInput: string;
  pendingTypedInput?: string;
  shellKind?: SftpTerminalShellKind;
}): boolean {
  if (options.promptText && isTerminalContinuationPrompt(options.promptText)) {
    return false;
  }
  const shellKind = options.shellKind ?? "posix";
  const userInput = options.userInput;
  const pending = options.pendingTypedInput ?? "";

  if (!pending) {
    return isShellDraftSafeForPathInsertion(userInput, shellKind);
  }
  if (userInput.endsWith(pending)) {
    return isShellDraftSafeForPathInsertion(userInput, shellKind);
  }
  if (pending.startsWith(userInput)) {
    return isShellDraftSafeForPathInsertion(pending, shellKind);
  }
  return (
    isShellDraftSafeForPathInsertion(userInput, shellKind)
    && isShellDraftSafeForPathInsertion(pending, shellKind)
  );
}

/**
 * Validate the live terminal prompt + draft text before automatically
 * submitting a `cd` command. Rejects secondary/continuation prompts (such as
 * PS2 `>` or `dquote>`) where the shell is still reading an unterminated quote
 * or compound command, as well as any non-empty draft input.
 */
export function isTerminalDraftContextSafeForCd(options: {
  promptText?: string;
  userInput: string;
  pendingTypedInput?: string;
}): boolean {
  if (options.promptText && isTerminalContinuationPrompt(options.promptText)) {
    return false;
  }
  if (options.userInput.trim().length > 0) return false;
  if ((options.pendingTypedInput ?? "").trim().length > 0) return false;
  return true;
}

/** Build the PTY write payload for inserting a quoted path into the paired terminal. */
export function resolveInsertSftpPathInTerminalAction(
  options: SftpTerminalPathContext & { path?: string | null },
): { sessionId: string; data: string; shellKind: SftpTerminalShellKind } | null {
  if (!canSendSftpPathToTerminal(options) || !options.sessionId) return null;
  const shellKind = resolveSftpTerminalShellKind(options.shellType, {
    promptText: options.promptText,
    hostOs: options.hostOs,
    path: options.path,
  });
  if (!shellKind) return null;
  const data = formatSftpPathForTerminalInsert(options.path, shellKind);
  if (!data) return null;
  return { sessionId: options.sessionId, data, shellKind };
}

/** Build the PTY write payload for changing directory in the paired terminal. */
export function resolveCdSftpPathInTerminalAction(
  options: SftpTerminalPathContext & { path?: string | null },
): { sessionId: string; data: string } | null {
  if (!canSendSftpPathToTerminal(options) || !options.sessionId) return null;
  const shellKind = resolveSftpTerminalShellKind(options.shellType, {
    promptText: options.promptText,
    hostOs: options.hostOs,
    path: options.path,
  });
  if (!shellKind) return null;
  const command = formatSftpCdCommand(options.path, shellKind);
  if (!command) return null;
  return { sessionId: options.sessionId, data: `${command}\r` };
}
