export type SftpTerminalShellKind = "posix" | "fish" | "powershell" | "cmd";

export type SftpTerminalPathContext = {
  sessionId?: string | null;
  sessionStatus?: string | null;
  sessionHostId?: string | null;
  sftpHostId?: string | null;
  sftpIsLocal?: boolean;
  protocol?: string | null;
  shellType?: string | null;
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
const WINDOWS_UNC_PATH_RE = /^\\\\[^\\]+\\[^\\]+/;
// PowerShell treats curly single quotes (U+2018..U+201B) as string delimiters.
const POWERSHELL_SINGLE_QUOTE_RE = /['\u2018\u2019\u201A\u201B]/g;
const POWERSHELL_SINGLE_QUOTE_CHARS = new Set(["'", "\u2018", "\u2019", "\u201A", "\u201B"]);
const POWERSHELL_DOUBLE_QUOTE_CHARS = new Set(['"', "\u201C", "\u201D", "\u201E"]);
const CONTINUATION_PROMPT_RE =
  /^(?:(?:[a-z]*quote|heredoc|cmdsubst|pipe|for|if|while|until|case|select|then|else|elif|cursh|subsh|brace|math|array|param)?>|>>?)\s*$/i;

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

/** Map a terminal session's shellType to a concrete quoting dialect. */
export function resolveSftpTerminalShellKind(
  shellType?: string | null,
): SftpTerminalShellKind {
  if (shellType === "fish" || shellType === "powershell" || shellType === "cmd") {
    return shellType;
  }
  return "posix";
}

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteFishSingle(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(POWERSHELL_SINGLE_QUOTE_RE, "$&$&")}'`;
}

function isPosixCdPathEligible(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (WINDOWS_DRIVE_PATH_RE.test(trimmed)) return false;
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
    if (WINDOWS_SAFE_UNQUOTED_RE.test(path)) return path;
    return quotePowerShellSingle(path);
  }

  if (shellKind === "cmd") {
    // Interactive cmd.exe expands %VAR% and delayed !VAR! inside double quotes,
    // and double quotes cannot be safely escaped without risking command breakout.
    if (path.includes('"') || path.includes("%") || path.includes("!")) return null;
    if (WINDOWS_SAFE_UNQUOTED_RE.test(path)) return path;
    return `"${path}"`;
  }

  if (POSIX_SAFE_UNQUOTED_RE.test(path)) return path;
  return shellKind === "fish" ? quoteFishSingle(path) : quotePosixSingle(path);
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
    if (!isPowerShellCdPathEligible(dirPath)) return null;
    if (dirPath === "~") return "cd ~";
    return `cd -LiteralPath ${quotePowerShellSingle(dirPath)}`;
  }

  if (shellKind === "cmd") {
    if (!isCmdCdPathEligible(dirPath)) return null;
    if (dirPath.includes('"') || dirPath.includes("%") || dirPath.includes("!")) return null;
    return `cd /d "${dirPath}"`;
  }

  if (!isPosixCdPathEligible(dirPath)) return null;
  if (dirPath === "~") return "cd -- ~";
  if (dirPath.startsWith("~/")) {
    const suffix = dirPath.slice(2);
    if (!suffix) return "cd -- ~";
    const quotedSuffix = shellKind === "fish" ? quoteFishSingle(suffix) : quotePosixSingle(suffix);
    return `cd -- ~/${quotedSuffix}`;
  }
  const quotedDir = shellKind === "fish" ? quoteFishSingle(dirPath) : quotePosixSingle(dirPath);
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

function isPosixDraftSafeForPathInsertion(draft: string): boolean {
  type Context = "single" | "ansiSingle" | "double" | "backtick" | "cmdsubst";
  const stack: Context[] = [];

  for (let i = 0; i < draft.length; i += 1) {
    const ch = draft[i];
    const top = stack[stack.length - 1];

    if (top === "single") {
      if (ch === "'") stack.pop();
      continue;
    }

    if (top === "ansiSingle") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "'") stack.pop();
      continue;
    }

    if (top === "double") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "$" && draft[i + 1] === "(") {
        stack.push("cmdsubst");
        i += 1;
        continue;
      }
      if (ch === "`") {
        stack.push("backtick");
        continue;
      }
      if (ch === '"') stack.pop();
      continue;
    }

    if (top === "backtick") {
      if (ch === "\\") {
        if (i + 1 >= draft.length) return false;
        i += 1;
        continue;
      }
      if (ch === "`") stack.pop();
      continue;
    }

    // Outside quotes (top === undefined or top === "cmdsubst")
    if (ch === "\\") {
      if (i + 1 >= draft.length) return false;
      i += 1;
      continue;
    }
    if (ch === "$" && draft[i + 1] === "'") {
      stack.push("ansiSingle");
      i += 1;
      continue;
    }
    if (ch === "$" && draft[i + 1] === "(") {
      stack.push("cmdsubst");
      i += 1;
      continue;
    }
    if (ch === "'") {
      stack.push("single");
      continue;
    }
    if (ch === '"') {
      stack.push("double");
      continue;
    }
    if (ch === "`") {
      stack.push("backtick");
      continue;
    }
    if (ch === ")" && top === "cmdsubst") {
      stack.pop();
    }
  }

  const top = stack[stack.length - 1];
  return top === undefined || top === "cmdsubst";
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

/** Build the PTY write payload for inserting a quoted path into the paired terminal. */
export function resolveInsertSftpPathInTerminalAction(
  options: SftpTerminalPathContext & { path?: string | null },
): { sessionId: string; data: string; shellKind: SftpTerminalShellKind } | null {
  if (!canSendSftpPathToTerminal(options) || !options.sessionId) return null;
  const shellKind = resolveSftpTerminalShellKind(options.shellType);
  const data = formatSftpPathForTerminalInsert(options.path, shellKind);
  if (!data) return null;
  return { sessionId: options.sessionId, data, shellKind };
}

/** Build the PTY write payload for changing directory in the paired terminal. */
export function resolveCdSftpPathInTerminalAction(
  options: SftpTerminalPathContext & { path?: string | null },
): { sessionId: string; data: string } | null {
  if (!canSendSftpPathToTerminal(options) || !options.sessionId) return null;
  const shellKind = resolveSftpTerminalShellKind(options.shellType);
  const command = formatSftpCdCommand(options.path, shellKind);
  if (!command) return null;
  return { sessionId: options.sessionId, data: `${command}\r` };
}
