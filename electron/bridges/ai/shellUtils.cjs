/**
 * Shell utility functions shared across AI bridge modules.
 *
 * Provides ANSI stripping, URL extraction, CLI resolution, path helpers,
 * stream chunk serialization, and cached shell environment resolution.
 */
"use strict";

const { execFile, execFileSync } = require("node:child_process");
const { existsSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

// ── ANSI / URL regexes ──

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const URL_CANDIDATE_REGEX = /https?:\/\/[^\s]+/g;
const WINDOWS_RUNNABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const MAX_PROMPT_TRACK_TAIL = 4096;

function execFileAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ── ANSI stripping ──

function stripAnsi(input) {
  return String(input || "").replace(ANSI_OSC_REGEX, "").replace(ANSI_ESCAPE_REGEX, "");
}

// ── Synthetic command echo ──
//
// The agent's typed command is not echoed by the PTY as-is (the wrapper
// line is filtered out in preload), so exec bridges emit a synthetic echo
// for the user to see. xterm.js treats a bare \n as "move down, keep
// column", which renders multi-line commands as a staircase. Normalize
// every line break to \r\n so each line starts at column 0.
function formatSyntheticEcho(command) {
  return `${String(command ?? "").replace(/\r?\n/g, "\r\n")}\r\n`;
}

// Default PowerShell prompt (e.g. `PS C:\Users\alice>`, `PS>`,
// `PS /home/alice>`). Anchored so command output that merely starts with
// `PS` (e.g. `PSO>`) doesn't match. The `\S` after `\s+` rejects literal
// `"PS >"` (which the default prompt never emits) so a script that prints
// such a line can't trick prompt-driven shell-kind selection.
const POWERSHELL_PROMPT_PATTERN = /^PS(?:\s+\S.*)?>$/;

// Default cmd.exe prompt (e.g. `C:\>`, `C:\Users\alice>`, `D:\data>`).
// Drive letter + optional path + `>`. Rejects `C: >` (space before `>`) and
// PowerShell's `PS C:\...>` (handled by POWERSHELL_PROMPT_PATTERN first).
const CMD_PROMPT_PATTERN = /^[A-Za-z]:(?:\\[^<>"|]*)?>$/;

// Classic `user@host:...$` / `user@host:...#` login prompt (bash/zsh in WSL,
// remote Linux, etc.). Intentionally narrow so custom / fish prompts do not
// flip a Windows DefaultShell soft hint.
const POSIX_PROMPT_PATTERN = /^[^\s@]+@[^\s:]+(?::[^\n\r]*)?[#$]$/;

// Interactive fish prints this banner when it starts with a default
// (English) greeting enabled — direct evidence that the *interactive* shell
// is fish, even when the login-shell probe (issue #1854) reported a POSIX
// login shell the user nested fish on top of (#3261). The greeting is
// optional: a disabled, customized, or localized `fish_greeting` never
// prints it, so this hint is only one detection path — the pty exec path
// additionally records the hint from fish's wrapper-rejection diagnostic
// (see looksLikeFishWrapperRejection, Codex P1 on #3262). The banner match
// is also validated against the launch context (see trackSessionIdlePrompt,
// Codex P2 on #3262).
const FISH_WELCOME_PATTERN = /Welcome to fish, the friendly interactive shell/;

// fish prints the greeting as the first line of output immediately after
// the echoed launch command (e.g. `user@host:~$ fish`) and before its first
// prompt. Only trust the banner when it follows that echoed launch: a POSIX
// command, log, or document that merely *prints* the banner text is not
// evidence of a shell transition (Codex P2 on #3262). The launch command may
// be decorated and must still match (Codex P2 on #3262): `exec fish`,
// an absolute path (`/usr/bin/fish`, `~/.local/bin/fish`), or trailing fish
// flags (`fish -l`, `fish --no-config`). Anchoring on a prompt character
// before the launch keeps nested launches working while rejecting arbitrary
// output that happens to mention the banner (`cat fish-notes.txt` still does
// not match: the text between the prompt character and `fish` is neither an
// `exec` prefix nor a `/`-terminated path). A login shell that *is* fish
// prints the banner with no preceding echo; those sessions are covered by
// the login-shell probe (#1854) or a confirmed shellKind, not by this hint.
const FISH_LAUNCH_ECHO_PATTERN =
  /[#$%>]\s*(?:exec\s+)?(?:[^\s#$%>]+\/)?fish(?:\s+-{1,2}[\w.-]+)*$/;
// The launch command part alone (used after the prompt prefix of the echoed
// launch line has been matched against the session's own idle prompt).
const FISH_LAUNCH_COMMAND_PATTERN =
  /^\s*(?:exec\s+)?(?:[^\s#$%>]+\/)?fish(?:\s+-{1,2}[\w.-]+)*$/;

function isDefaultPowerShellPromptLine(line) {
  return POWERSHELL_PROMPT_PATTERN.test(String(line || ""));
}

function isDefaultCmdPromptLine(line) {
  return CMD_PROMPT_PATTERN.test(String(line || "").replace(/\s+$/, ""));
}

function isDefaultPosixPromptLine(line) {
  return POSIX_PROMPT_PATTERN.test(String(line || "").replace(/\s+$/, ""));
}

function extractTrailingIdlePrompt(output) {
  // Treat `\r` as a line break, not as a stripped character: PSReadLine /
  // ConPTY repaints emit bare `\r` to redraw the current line, and we
  // want only the redrawn line to be considered, not the concatenation
  // of every overwritten frame.
  const normalized = stripAnsi(output).replace(/\r/g, "\n");
  if (!normalized || normalized.endsWith("\n")) return "";

  const lastLine = normalized.split("\n").pop() || "";
  const rightTrimmed = lastLine.replace(/\s+$/, "");
  if (!rightTrimmed) return "";

  if (isDefaultPowerShellPromptLine(rightTrimmed)) {
    return lastLine;
  }

  if (isDefaultPosixPromptLine(rightTrimmed)) {
    return lastLine;
  }

  if (isDefaultCmdPromptLine(rightTrimmed)) {
    return lastLine;
  }

  return "";
}

// bash and csh/tcsh print a banner to the terminal right before exiting due to
// the shell's TMOUT idle-timeout setting ("timed out waiting for input:
// auto-logout" / "auto-logout"). That exit is a clean shell exit — numeric
// code, no signal — so it is indistinguishable from a user-typed `exit` by
// exit code alone (verified: bash auto-logout exits 0). The banner is the only
// reliable discriminator, letting the SSH bridge keep the tab open for
// reconnect instead of auto-closing it (#1062, regression of #977).
const IDLE_AUTO_LOGOUT_PATTERN = /(?:timed out waiting for input:\s*)?auto-?logout$/i;

function looksLikeIdleAutoLogout(outputTail) {
  if (typeof outputTail !== "string" || !outputTail) return false;
  // The shell prints this banner on its own line as the very last thing before
  // it exits, so anchor on the final non-empty line rather than a loose
  // substring. Otherwise unrelated output that merely mentions "auto-logout"
  // (e.g. `grep auto-logout /etc/profile`) followed by an intentional `exit`
  // would be misclassified as a timeout and wrongly keep the tab open.
  const lines = stripAnsi(outputTail.slice(-512)).replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // Drop control bytes (e.g. the BEL bash rings before the banner) and trim.
    const line = lines[i].replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!line) continue;
    return IDLE_AUTO_LOGOUT_PATTERN.test(line);
  }
  return false;
}

// Enough carry to reassemble a banner split across PTY chunks, retain the
// launch-echo line that precedes it (validation context), and absorb ANSI
// sequences that stripAnsi removes before scanning.
const FISH_BANNER_CARRY_CHARS = FISH_WELCOME_PATTERN.source.length + 192;

// The line immediately before the banner must be the echoed launch command
// (`user@host:~$ fish`, `user@host% exec fish`, …). Shape alone is not enough
// (Codex P2 on #3262): output of `cat transcript.txt` can contain
// `user@other:~$ fish` followed by the banner text, so the echoed launch must
// also reuse the idle prompt this session itself printed last. A transcript
// copied from another host / a different prompt fails that comparison.
//
// Matching the prompt is still not proof of typed input (Codex P2 on #3262,
// second round): a transcript copied from the *same* host reuses the exact
// session prompt, so `user@host:~$ cat transcript.txt` emitting
// `user@host:~$ fish` + banner passes the prefix comparison. The launch line
// is only real terminal input when it is not itself the output of the
// preceding echoed command — so no echoed command (the session's idle prompt
// followed by a command) may appear between the launch echo and the start of
// the scan window. A one-line lookback is not enough (Codex P2 on #3262,
// third round): `user@host:~$ cat transcript.txt` → `Transcript follows:` →
// `user@host:~$ fish` + banner slips past it because the immediate
// predecessor is the header, not the echoed `cat` command. Scan back over
// prompt-less output lines to the command that produced them; an echoed
// session-prompt command there means the launch line is displayed output,
// while a bare idle prompt (or the start of the window — e.g. the launch
// echo continuing a prompt repainted across the chunk boundary) is a
// typed-input boundary and authenticates the launch. Trade-off: a real
// launch that follows a prompt-attached echoed command's output is no
// longer banner-detected; that is safe because the POSIX wrapper then fails
// into fish's wrapper-rejection diagnostic, which records the hint (see
// looksLikeFishWrapperRejection). When no recognized idle prompt has been
// observed yet there is nothing to compare against, so the shape-only check
// stands (a session with a custom prompt shape never records one;
// wrapper-rejection detection still covers fish).
function hasFishLaunchEchoBeforeBanner(scanText, matchIndex, session) {
  const before = scanText.slice(0, matchIndex).replace(/\r\n?/g, "\n");
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+$/, "");
    if (!line) continue;
    if (!FISH_LAUNCH_ECHO_PATTERN.test(line)) return false;
    const prompt = session && typeof session.lastIdlePrompt === "string"
      ? session.lastIdlePrompt.replace(/\s+$/, "")
      : "";
    if (!prompt) return true;
    // The prompt may be repainted after the chunk boundary (the banner-scan
    // carry re-attaches the previous chunk's trailing prompt), so match the
    // launch command after the *last* occurrence of the session's prompt.
    const promptIndex = line.lastIndexOf(prompt);
    if (promptIndex < 0) return false;
    if (!FISH_LAUNCH_COMMAND_PATTERN.test(line.slice(promptIndex + prompt.length))) {
      return false;
    }
    // Actual-input check: an echoed command reusing the session's idle
    // prompt anywhere between the launch line and the start of the scan
    // window means the launch line is that command's output (a displayed
    // transcript), not typed input. Anchored on the session's own prompt so
    // ordinary command output that merely contains `$`/`>` does not mask
    // real launches, and extended past single-line output so a header line
    // between the echoed command and the transcript's launch line cannot
    // hide the provenance (Codex P2 on #3262).
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j].replace(/\s+$/, "");
      if (!prev) continue;
      const prevPromptIndex = prev.lastIndexOf(prompt);
      if (prevPromptIndex < 0) continue;
      if (prev.slice(prevPromptIndex + prompt.length).trim()) {
        return false;
      }
      break;
    }
    return true;
  }
  return false;
}

// A recognized PowerShell/cmd/posix idle prompt after the banner means the
// fish session already ended (banner and parent prompt in one chunk, e.g.
// `user@host:~$ fish\nWelcome to fish…\nuser@host:~$ exit\nuser@host:~$`).
// The scan runs after prompt clearing, so without this check the scan would
// set the hint that the trailing prompt just cleared. Like the clearing path
// (hasFishExitEchoBeforePrompt), the recognized prompt only counts as exit
// evidence when an echoed exit command precedes it: a customized fish_prompt
// shaped like `user@host:~$` must not suppress the banner hint (Codex P1 on
// #3262).
function hasRecognizedIdlePromptAfterBanner(scanText, fromIndex) {
  const after = scanText.slice(fromIndex).replace(/\r\n?/g, "\n");
  const lines = after.split("\n");
  let prevNonEmpty = "";
  let prevPrevNonEmpty = "";
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed) continue;
    if (
      isDefaultPowerShellPromptLine(trimmed)
      || isDefaultPosixPromptLine(trimmed)
      || isDefaultCmdPromptLine(trimmed)
    ) {
      return isExitEchoLine(prevNonEmpty, prevPrevNonEmpty);
    }
    prevPrevNonEmpty = prevNonEmpty;
    prevNonEmpty = trimmed;
  }
  return false;
}

// The last two non-empty lines before the trailing prompt. Used as exit
// evidence (and its context) for hasFishExitEchoBeforePrompt below.
function lastTwoNonEmptyLinesBefore(text, endOffset) {
  const lines = String(text || "").slice(0, endOffset).split("\n");
  let last = "";
  let preceding = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+$/, "");
    if (!line) continue;
    if (!last) {
      last = line;
      continue;
    }
    preceding = line;
    break;
  }
  return [last, preceding];
}

// A customized `fish_prompt` can look exactly like the parent POSIX prompt
// (`user@host:~$`), so a recognized idle prompt's *shape* alone cannot tell
// "still inside nested fish" from "back in the parent shell" (Codex P1 on
// #3262). The visible evidence that the nested fish process actually ended
// is the echoed exit command — the user typed `exit` (or `logout`) and the
// PTY echoed it right before the parent prompt reappeared (`user@host:~$
// exit` / a bare `exit` line). Only such an echo justifies clearing the live
// fish hint; an idle prompt with no exit echo leaves the hint alone, and a
// real shell change without one (e.g. Ctrl+D) is still recovered by the pty
// exec fallback that invalidates the hint when a fish-wrapped command's
// start marker never arrives (clearLiveShellKind via onLiveShellKindInvalidated).
// A bare `exit` / `logout` line is only input echo when the line before it is
// a bare idle prompt (prompt repaint puts the typed command on a separate
// line after a \r redraw): command *output* also prints exit-looking lines —
// a prompt-attached one (`printf 'user@host:~$ exit\n'`) directly follows the
// echoed command line, while a multi-line command (`printf 'done\nexit\n'`)
// leaves the bare `exit` after an arbitrary output line. In both cases the
// predecessor is command output, never the idle prompt the user was typing
// at, so "not itself an echoed command" is not enough to authenticate the
// echo (Codex P2 on #3262).
const PROMPT_WITH_COMMAND_PATTERN = /[#$%>]\s*\S/;

// A line that ends in a prompt character with nothing typed after it — the
// idle prompt itself, possibly split from the typed command by a repaint.
const BARE_IDLE_PROMPT_PATTERN = /[#$%>]\s*$/;

function isExitEchoLine(line, precedingLine) {
  const trimmed = String(line || "").replace(/\s+$/, "");
  if (!trimmed) return false;
  // Bare `exit` / `logout` echoed on its own line (prompt repaint may put
  // the typed command on a separate line after a \r redraw). The line before
  // it must be a bare idle prompt: multi-line command output can end in a
  // bare `exit` line whose predecessor is arbitrary output (`done`), which
  // no single-line shape check can distinguish from typed input (Codex P2
  // on #3262).
  if (/^(?:exit|logout)$/i.test(trimmed)) {
    return BARE_IDLE_PROMPT_PATTERN.test(String(precedingLine || "").replace(/\s+$/, ""));
  }
  // …or typed after a prompt character: `user@host:~$ exit`. Output can also
  // print a prompt-shaped exit line (`printf 'user@host:~$ exit\n'`), so the
  // same input-echo validation applies: it is only evidence when the line
  // before it is not itself an echoed command (Codex P2 on #3262).
  if (/[#$%>]\s*(?:exit|logout)\s*$/i.test(trimmed)) {
    return !PROMPT_WITH_COMMAND_PATTERN.test(String(precedingLine || ""));
  }
  return false;
}

function hasFishExitEchoBeforePrompt(normalizedTail, prompt) {
  if (!normalizedTail || !prompt || !normalizedTail.endsWith(prompt)) return false;
  const [last, preceding] = lastTwoNonEmptyLinesBefore(
    normalizedTail,
    normalizedTail.length - prompt.length,
  );
  return isExitEchoLine(last, preceding);
}

function trackSessionIdlePrompt(session, chunk) {
  if (!session || typeof chunk !== "string" || !chunk) return "";

  const nextTail = `${session._promptTrackTail || ""}${chunk}`.slice(-MAX_PROMPT_TRACK_TAIL);
  session._promptTrackTail = nextTail;
  const strippedChunk = stripAnsi(chunk);

  const prompt = extractTrailingIdlePrompt(nextTail);
  if (prompt) {
    session.lastIdlePrompt = prompt;
    session.lastIdlePromptAt = Date.now();
    // A recognized PowerShell/cmd/posix idle prompt *after* the fish banner
    // *plus exit evidence* means the interactive shell is no longer fish
    // (e.g. the user typed `exit` in a nested fish back to bash/zsh). Clear
    // the live hint so wrapper selection falls back to shellKind / login
    // hint. Fish's own default prompt ends with `>` and never matches the
    // recognized shapes, but a *customized* fish_prompt can be shaped like a
    // POSIX prompt (`user@host:~$`) — for those, prompt shape alone is not
    // evidence fish exited, so the hint is only cleared when the echoed exit
    // command precedes the prompt (Codex P1 on #3262). A custom parent
    // prompt (Starship, oh-my-posh, …) is not recognized here either; the
    // pty exec path additionally invalidates the hint via clearLiveShellKind
    // when a fish-wrapped command's start marker never arrives (Codex P1 on
    // #3262).
    if (session._liveShellKind) {
      const normalizedTail = stripAnsi(nextTail).replace(/\r/g, "\n");
      if (hasFishExitEchoBeforePrompt(normalizedTail, stripAnsi(prompt))) {
        clearLiveShellKind(session);
      }
    }
  }

  // Detect against a small carry of the previous chunk plus the current
  // chunk, not the chunk alone: PTY data-event boundaries are arbitrary and
  // the banner can be split across two events ("Welcome to fish, the
  // friendly " + "interactive shell") (Codex P2 on #3262). Only text after
  // the last match is carried forward, so the same banner is never
  // re-scanned — re-scanning the full rolling tail would resurrect a hint
  // that a recognized parent prompt just cleared. The match itself must
  // look like a real fish launch: preceded by the echoed launch command and
  // not already followed by a recognized parent prompt in the same text.
  const bannerScanText = `${session._fishBannerScanCarry || ""}${strippedChunk}`;
  const bannerMatch = FISH_WELCOME_PATTERN.exec(bannerScanText);
  if (
    bannerMatch
    && hasFishLaunchEchoBeforeBanner(bannerScanText, bannerMatch.index, session)
    && !hasRecognizedIdlePromptAfterBanner(bannerScanText, bannerMatch.index + bannerMatch[0].length)
  ) {
    session._liveShellKind = "fish";
    session._liveShellKindAt = Date.now();
  }
  session._fishBannerScanCarry = bannerMatch
    ? bannerScanText
      .slice(bannerMatch.index + bannerMatch[0].length)
      .slice(-FISH_BANNER_CARRY_CHARS)
    : bannerScanText.slice(-FISH_BANNER_CARRY_CHARS);

  return prompt;
}

// Clear the live (banner-detected) shell-kind hint. Exported so the pty exec
// handlers can invalidate the hint when a fish-wrapped command fails to start
// (start marker never arrived) — the fallback expiry for parent shells whose
// idle prompt is not one of the three recognized shapes.
function clearLiveShellKind(session) {
  if (!session || typeof session !== "object") return;
  session._liveShellKind = "";
  session._liveShellKindAt = 0;
}

// fish rejects a POSIX wrapper (`__NCMCP_x=0; …`) before its first prompt
// with a `fish: …` diagnostic (e.g. "Unsupported use of '='" or
// "Unknown command: …"). The `fish: ` prefix is fish's program-name prefix
// on the PTY and is not localized, so it is greeting-independent evidence
// that the interactive shell is fish (Codex P1 on #3262: the welcome banner
// is optional — a disabled, customized, or localized `fish_greeting` never
// prints it, leaving the live hint unset and the POSIX wrapper failing into
// the startup timeout on every command).
const FISH_REJECTION_PATTERN = /(?:^|\n)\s*fish: /;

function looksLikeFishWrapperRejection(output) {
  const stripped = stripAnsi(String(output || "")).replace(/\r/g, "\n");
  return FISH_REJECTION_PATTERN.test(stripped);
}

// A fish-wrapped command typed into a *non-fish* interactive shell fails
// before its start marker with that shell's program-name diagnostic prefix
// (e.g. `bash: syntax error near unexpected token`, `zsh: parse error near …`).
// The prefix is not localized, so it is evidence the interactive shell is not
// fish. Used to gate invalidation of the live fish hint on a pre-start
// timeout: a foreground child (vim, ssh, a REPL) owning the PTY also blocks
// the start marker, but produces no such diagnostic — in that case the live
// hint is still correct and must be kept (Codex P2 on #3262).
const NON_FISH_SHELL_REJECTION_PATTERN = /(?:^|\n)\s*-?(?:bash|zsh|sh|dash|ksh|mksh|ash|csh|tcsh): /;

function looksLikeNonFishShellRejection(output) {
  const stripped = stripAnsi(String(output || "")).replace(/\r/g, "\n");
  return NON_FISH_SHELL_REJECTION_PATTERN.test(stripped);
}

// Record the live fish hint (companion to clearLiveShellKind). Called by the
// pty exec handlers when fish rejects the POSIX wrapper so the *next*
// command uses the fish wrapper instead of reproducing the timeout.
function setLiveShellKindFish(session) {
  if (!session || typeof session !== "object") return;
  session._liveShellKind = "fish";
  session._liveShellKindAt = Date.now();
}

// Return `session.lastIdlePrompt` only if the PTY's recent rolling tail
// still ends with it. The cached prompt is updated only when
// extractTrailingIdlePrompt recognizes a known shape (PowerShell, cmd.exe,
// or `user@host[:path][#$]`); a remote shell switch into another shell, an
// oh-my-posh / starship / custom PS1, or any unrecognized prompt would
// otherwise leave a stale value behind, which `resolveEffectiveShellKind`
// would then keep using to coerce future commands into a PowerShell
// wrapper. By re-checking the live tail we self-correct: if the visible
// last line no longer matches the cached prompt, the prompt is treated
// as expired and downstream wrapper selection / suffix matching falls
// back to `shellKind` alone.
function getFreshIdlePrompt(session) {
  if (!session) return "";
  const cached = session.lastIdlePrompt;
  if (!cached) return "";

  const tail = session._promptTrackTail;
  if (typeof tail !== "string" || !tail) return "";

  const normalizedTail = stripAnsi(tail).replace(/\r/g, "\n");
  const normalizedCached = stripAnsi(cached).replace(/\r/g, "\n");
  if (!normalizedCached) return "";

  return normalizedTail.endsWith(normalizedCached) ? cached : "";
}

// ── URL helpers ──

function isLocalhostHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

function extractFirstNonLocalhostUrl(output) {
  const { URL } = require("node:url");
  const matches = stripAnsi(output).match(URL_CANDIDATE_REGEX);
  if (!matches) return null;

  for (const match of matches) {
    try {
      const parsedUrl = new URL(match.trim().replace(/[),.;!?]+$/, ""));
      if (!isLocalhostHostname(parsedUrl.hostname)) {
        return parsedUrl.toString();
      }
    } catch {
      // Ignore invalid URL candidates.
    }
  }

  return null;
}

// ── CLI / path helpers ──

function normalizeCliPathForPlatform(filePath) {
  const normalized = String(filePath || "").trim();
  if (!normalized) return null;

  if (process.platform !== "win32") {
    // Reject directories (e.g. /Applications/Codex.app) — must be a file
    try {
      if (existsSync(normalized) && statSync(normalized).isFile()) return normalized;
    } catch { /* stat failed */ }
    return null;
  }

  const ext = path.extname(normalized).toLowerCase();
  if (ext) {
    return existsSync(normalized) ? normalized : null;
  }

  // Windows npm globals often contain both a POSIX shim (`codex`) and the
  // actual runnable wrapper (`codex.cmd`). Prefer the wrapper when present.
  for (const suffix of WINDOWS_RUNNABLE_EXTENSIONS) {
    const candidate = `${normalized}${suffix}`;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return existsSync(normalized) ? normalized : null;
}

function shouldUseShellForCommand(command) {
  if (process.platform !== "win32") return false;
  const normalized = String(command || "").trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

function quoteWindowsShellArg(value) {
  const arg = String(value ?? "");
  if (!arg) return "\"\"";
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function buildWindowsShellCommandLine(command, args) {
  return [command, ...(args || [])].map(quoteWindowsShellArg).join(" ");
}

function resolveWindowsShimToNativeExe(command, platform = process.platform) {
  if (platform !== "win32") return null;
  const normalized = String(command || "").trim();
  if (!normalized) return null;
  const ext = path.extname(normalized).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return null;
  if (!existsSync(normalized)) return null;
  try {
    const contents = readFileSync(normalized, "utf8");
    const shimDir = path.dirname(normalized);
    // Match patterns like: "%~dp0\..\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
    // or: "%~dp0\..\@openai\codex\bin\codex.exe"
    const exeRefs = [...contents.matchAll(/"%~dp0\\([^"]+\.exe)"/gi)];
    for (const [, relativePath] of exeRefs) {
      const candidate = path.resolve(shimDir, relativePath.replace(/\\/g, "/"));
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function prepareCommandForSpawn(command, args, options = {}) {
  const spawnArgs = Array.isArray(args) ? args : [];
  if (!shouldUseShellForCommand(command)) {
    return { command, args: spawnArgs, shell: false };
  }

  // Cursor's Windows installer .cmd launches node.exe + index.js. Unwrapping
  // to the first quoted .exe would drop the script and run node with CLI args.
  if (options.unwrapNativeExe !== false) {
    const nativeExePath = resolveWindowsShimToNativeExe(command);
    if (nativeExePath) {
      return { command: nativeExePath, args: spawnArgs, shell: false };
    }
  }

  return {
    command: buildWindowsShellCommandLine(command, spawnArgs),
    args: [],
    shell: true,
  };
}

function resolveClaudeCodeExecutableForSdk(claudeExecutablePath, platform = process.platform) {
  const normalized = String(claudeExecutablePath || "").trim();
  if (!normalized) return null;
  if (platform !== "win32") return normalized;

  const ext = path.extname(normalized).toLowerCase();
  if (ext && ext !== ".cmd" && ext !== ".bat") return normalized;

  const baseDir = path.dirname(normalized);
  const packageCliPath = path.join(baseDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
  if (existsSync(packageCliPath)) {
    return packageCliPath;
  }

  // Native binary check: Claude Code >= 2.1.169 ships as native exe with no cli.js
  const nativeExeCandidates = [
    path.join(baseDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(baseDir, "..", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  ];
  for (const exePath of nativeExeCandidates) {
    if (existsSync(exePath)) return exePath;
  }

  const shimCandidates = [normalized];
  if (!ext) {
    shimCandidates.push(`${normalized}.cmd`, `${normalized}.bat`);
  }

  for (const shimPath of shimCandidates) {
    try {
      if (!existsSync(shimPath)) continue;
      const contents = readFileSync(shimPath, "utf8");
      if (!/node_modules[\\/]+@anthropic-ai[\\/]+claude-code[\\/]+cli\.js/i.test(contents)) {
        continue;
      }
      if (existsSync(packageCliPath)) {
        return packageCliPath;
      }
    } catch {
      // Fall back to the original executable path below.
    }
  }

  return normalized;
}

function normalizeClaudeCodeExecutableEnvForSdk(env, platform = process.platform) {
  if (!env?.CLAUDE_CODE_EXECUTABLE) return env;
  const resolved = resolveClaudeCodeExecutableForSdk(env.CLAUDE_CODE_EXECUTABLE, platform);
  if (!resolved || resolved === env.CLAUDE_CODE_EXECUTABLE) return env;
  return {
    ...env,
    CLAUDE_CODE_EXECUTABLE: resolved,
  };
}

const CODEX_WIN32_PLATFORM_PACKAGES = {
  x64: { triple: "x86_64-pc-windows-msvc", package: "@openai/codex-win32-x64" },
  arm64: { triple: "aarch64-pc-windows-msvc", package: "@openai/codex-win32-arm64" },
};

function resolveCodexNativeExecutableWin32(moduleSearchDirs, arch = process.arch) {
  const archKey = arch === "arm64" ? "arm64" : "x64";
  const { triple, package: platformPackage } = CODEX_WIN32_PLATFORM_PACKAGES[archKey];

  for (const dir of moduleSearchDirs) {
    if (!dir) continue;
    const candidates = [
      path.join(dir, "node_modules", platformPackage, "vendor", triple, "bin", "codex.exe"),
      path.join(dir, "node_modules", platformPackage, "vendor", triple, "codex", "codex.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function getNvmdHomeFromShimDir(shimDir) {
  const normalized = String(shimDir || "").trim();
  if (!normalized) return null;
  if (path.basename(normalized).toLowerCase() !== "bin") return null;
  const home = path.dirname(normalized);
  // nvm-desktop / nvmd-command layout: $NVMD_HOME/{bin,versions,default,packages.json}
  if (
    existsSync(path.join(home, "versions")) ||
    existsSync(path.join(home, "packages.json")) ||
    existsSync(path.join(home, "default"))
  ) {
    return home;
  }
  return null;
}

function readNvmdDefaultVersion(nvmdHome) {
  try {
    const raw = readFileSync(path.join(nvmdHome, "default"), "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function readNvmdPackageVersions(nvmdHome, packageBinName) {
  try {
    const raw = readFileSync(path.join(nvmdHome, "packages.json"), "utf8");
    const data = JSON.parse(raw);
    const versions = data && data[packageBinName];
    if (!Array.isArray(versions)) return [];
    return versions.map((v) => String(v || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function getNvmdVersionsDirectory(nvmdHome) {
  try {
    const raw = readFileSync(path.join(nvmdHome, "setting.json"), "utf8");
    const data = JSON.parse(raw);
    const custom = data && typeof data.directory === "string" ? data.directory.trim() : "";
    if (custom) return custom;
  } catch {
    // Fall back to the default versions/ directory.
  }
  return path.join(nvmdHome, "versions");
}

function getNvmdCodexVersionRoots(nvmdHome) {
  if (!nvmdHome) return [];
  const versionsDir = getNvmdVersionsDirectory(nvmdHome);
  const candidates = [
    ...readNvmdPackageVersions(nvmdHome, "codex").reverse(),
    readNvmdDefaultVersion(nvmdHome),
  ].filter(Boolean);

  const roots = [];
  const seen = new Set();
  for (const version of candidates) {
    const root = path.join(versionsDir, version);
    if (seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

function getCodexNativeSearchDirsForShim(shimDir) {
  const dirs = [shimDir];
  const parentDir = path.dirname(shimDir);
  if (
    path.basename(shimDir).toLowerCase() === ".bin" &&
    path.basename(parentDir).toLowerCase() === "node_modules"
  ) {
    dirs.push(path.dirname(parentDir));
  }
  dirs.push(path.join(shimDir, "node_modules", "@openai", "codex"));

  // nvm-desktop installs global CLIs under $NVMD_HOME/versions/<ver>/, while
  // $NVMD_HOME/bin/codex{.cmd,.exe} are only nvmd router shims. Expand search
  // into the active/recorded Node version roots so the SDK can spawn the real
  // native codex.exe (codexPathOverride) instead of falling back to bundled
  // optional deps that Netcatty deliberately does not ship.
  const nvmdHome = getNvmdHomeFromShimDir(shimDir);
  for (const versionRoot of getNvmdCodexVersionRoots(nvmdHome)) {
    dirs.push(versionRoot);
    dirs.push(path.join(versionRoot, "node_modules", "@openai", "codex"));
  }
  return dirs;
}

function getCodexNativePathDirsWin32(nativeExecutablePath) {
  const normalized = String(nativeExecutablePath || "").trim();
  if (!normalized || path.basename(normalized).toLowerCase() !== "codex.exe") {
    return [];
  }

  const executableDir = path.dirname(normalized);
  const packageRoot = path.dirname(executableDir);
  const dirs = [];
  if (path.basename(executableDir).toLowerCase() === "bin") {
    dirs.push(path.join(packageRoot, "codex-path"));
  } else if (path.basename(executableDir).toLowerCase() === "codex") {
    dirs.push(path.join(packageRoot, "path"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

function getPathEnvKey(env, platform = process.platform) {
  if (platform !== "win32") return "PATH";
  const keys = Object.keys(env || {}).filter((key) => key.toLowerCase() === "path");
  return keys.includes("Path") ? "Path" : keys.at(-1) || "PATH";
}

function addCodexExecutableEnvForSdk(env, codexExecutablePath, platform = process.platform) {
  if (platform !== "win32" || !codexExecutablePath) return env;
  const pathDirs = getCodexNativePathDirsWin32(codexExecutablePath);
  if (pathDirs.length === 0) return env;

  const nextEnv = { ...(env || {}) };
  const pathKey = getPathEnvKey(nextEnv, platform);
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === "path" && key !== pathKey) {
      delete nextEnv[key];
    }
  }
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const existingEntries = String(nextEnv[pathKey] || "")
    .split(delimiter)
    .filter((entry) => entry && !pathDirs.includes(entry));
  nextEnv[pathKey] = [...pathDirs, ...existingEntries].join(delimiter);
  return nextEnv;
}

function resolveCodexExecutableForSdk(codexExecutablePath, platform = process.platform) {
  const normalized = String(codexExecutablePath || "").trim();
  if (!normalized) return null;
  if (platform !== "win32") return normalized;

  const ext = path.extname(normalized).toLowerCase();
  const baseDir = path.dirname(normalized);
  const moduleSearchDirs = getCodexNativeSearchDirsForShim(baseDir);
  const nvmdHome = getNvmdHomeFromShimDir(baseDir);

  // nvmd's Windows package shim is a copy of nvmd.exe named codex.exe. Prefer
  // the real native binary under versions/<ver>/ when that layout is present.
  if (ext === ".exe") {
    if (nvmdHome) {
      const nativeExe = resolveCodexNativeExecutableWin32(moduleSearchDirs);
      if (nativeExe) return nativeExe;
    }
    return normalized;
  }

  if (ext === ".js" && /[\\/]codex\.js$/i.test(normalized)) {
    const codexPackageRoot = path.dirname(path.dirname(normalized));
    const globalPrefix = path.resolve(codexPackageRoot, "..", "..", "..");
    const nativeExe = resolveCodexNativeExecutableWin32([
      globalPrefix,
      codexPackageRoot,
      ...moduleSearchDirs,
    ]);
    if (nativeExe) return nativeExe;
  }

  if (ext && ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") {
    return normalized;
  }

  const nativeExe = resolveCodexNativeExecutableWin32(moduleSearchDirs);
  if (nativeExe) return nativeExe;

  const shimCandidates = [normalized];
  if (!ext) {
    shimCandidates.push(`${normalized}.cmd`, `${normalized}.bat`);
  }

  for (const shimPath of shimCandidates) {
    try {
      if (!existsSync(shimPath)) continue;
      const contents = readFileSync(shimPath, "utf8");
      if (!/@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(contents)) {
        continue;
      }
      const resolved = resolveCodexNativeExecutableWin32(moduleSearchDirs);
      if (resolved) return resolved;
    } catch {
      // Fall back to the original executable path below.
    }
  }

  return ext === ".cmd" || ext === ".bat" || ext === ".ps1" ? null : normalized;
}

function resolveCodebuddyExecutableForSdk(codebuddyExecutablePath, platform = process.platform) {
  const normalized = String(codebuddyExecutablePath || "").trim();
  if (!normalized) return null;
  if (platform !== "win32") return normalized;

  const ext = path.extname(normalized).toLowerCase();
  // A native exe or an explicit .js entry can be launched by the Agent SDK as-is.
  if (ext === ".exe" || ext === ".js") return normalized;
  // Any other concrete, non-shim extension: leave it untouched.
  if (ext && ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") return normalized;

  // Windows npm globals expose `codebuddy.cmd` / `codebuddy.ps1` shims (and an
  // extensionless POSIX shim). The Agent SDK launches the CLI through `node`
  // (electron-as-node in a packaged app), which cannot parse a batch/POSIX shim
  // as JavaScript — the spawned process exits immediately and the SDK surfaces
  // "CLI process stdout closed unexpectedly". Resolve the shim to the package's
  // real `bin/codebuddy` JS entry so the SDK runs it exactly as on macOS/Linux.
  const baseDir = path.dirname(normalized);
  const packageRoots = [
    path.join(baseDir, "node_modules", "@tencent-ai", "codebuddy-code"),
    path.join(baseDir, "..", "node_modules", "@tencent-ai", "codebuddy-code"),
  ];
  for (const root of packageRoots) {
    const binJs = path.join(root, "bin", "codebuddy");
    if (existsSync(binJs)) return binJs;
  }

  // Fall back to parsing the shim for the bin/codebuddy path it references.
  const shimCandidates = [normalized];
  if (!ext) shimCandidates.push(`${normalized}.cmd`, `${normalized}.bat`);
  for (const shimPath of shimCandidates) {
    try {
      if (!existsSync(shimPath)) continue;
      const contents = readFileSync(shimPath, "utf8");
      const match = contents.match(/([^"\s]*codebuddy-code[\\/]bin[\\/]codebuddy)/i);
      if (match) {
        const ref = match[1].replace(/^%~dp0[\\/]?/i, "").replace(/[\\/]+/g, path.sep);
        const binJs = path.isAbsolute(ref) ? ref : path.resolve(path.dirname(shimPath), ref);
        if (existsSync(binJs)) return binJs;
      }
    } catch {
      // Try the next shim candidate.
    }
  }

  // Could not locate the JS entry — return null so the caller falls back to the
  // SDK's bundled CLI rather than handing `node` an unrunnable shim.
  return ext === ".cmd" || ext === ".bat" || ext === ".ps1" ? null : normalized;
}

function resolveSdkBinPath(command, shellEnv, platform = process.platform) {
  const raw = resolveCliFromPath(command, shellEnv);
  if (!raw) return null;
  if (platform !== "win32") return raw;
  if (command === "codex") {
    return resolveCodexExecutableForSdk(raw, platform);
  }
  if (command === "claude") {
    return resolveClaudeCodeExecutableForSdk(raw, platform);
  }
  return raw;
}

async function resolveSdkBinPathAsync(command, shellEnv, platform = process.platform) {
  const raw = await resolveCliFromPathAsync(command, shellEnv);
  if (!raw) return null;
  if (platform !== "win32") return raw;
  if (command === "codex") {
    return resolveCodexExecutableForSdk(raw, platform);
  }
  if (command === "claude") {
    return resolveClaudeCodeExecutableForSdk(raw, platform);
  }
  return raw;
}

function resolveCliFromPath(command, shellEnv) {
  // Validate command: only allow valid binary names (alphanumeric, hyphens, underscores, dots)
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    return null;
  }

  if (shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const resolved = execFileSync(whichCmd, [command], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
        env: shellEnv,
      }).trim();
      for (const candidate of resolved.split(/\r?\n/)) {
        const normalized = normalizeCliPathForPlatform(candidate);
        if (normalized) return normalized;
      }
    } catch {
      // Not found on PATH
    }
  }
  return null;
}

async function resolveCliFromPathAsync(command, shellEnv) {
  // Validate command: only allow valid binary names (alphanumeric, hyphens, underscores, dots)
  if (!command || !/^[a-zA-Z0-9._-]+$/.test(command)) {
    return null;
  }

  if (shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const { stdout } = await execFileAsync(whichCmd, [command], {
        encoding: "utf8",
        timeout: 3000,
        env: shellEnv,
      });
      const resolved = String(stdout || "").trim();
      for (const candidate of resolved.split(/\r?\n/)) {
        const normalized = normalizeCliPathForPlatform(candidate);
        if (normalized) return normalized;
      }
    } catch {
      // Not found on PATH
    }
  }
  return null;
}

function toUnpackedAsarPath(filePath) {
  const unpackedPath = filePath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (unpackedPath !== filePath && existsSync(unpackedPath)) {
    return unpackedPath;
  }
  return filePath;
}

function isPlausibleCliVersionOutput(value) {
  const line = stripAnsi(String(value || "")).trim().split(/\r?\n/)[0]?.trim() || "";
  if (!line) return false;
  if (/^(?:file|node):\/\//i.test(line)) return false;
  if (/^\s*at\s+/i.test(line)) return false;
  if (/\b(?:Error|TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+)\b/.test(line)) return false;
  return /(?:^|[^\d])v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?(?:$|[^\d])/.test(line);
}

// ── Shell environment (cached) ──

let _cachedShellEnv = null;
let _shellEnvPromise = null;
let _shellEnvGeneration = 0;

/**
 * Run the user's login shell once to print its PATH. Used as a fallback when
 * the main `-ilc env` capture in getShellEnv fails (layer-0 fix-path).
 */
function defaultRunLoginShellPath() {
  let shell = process.env.SHELL || "/bin/zsh";
  if (!path.isAbsolute(shell) || !existsSync(shell)) {
    shell = "/bin/zsh";
  }
  return execFileSync(shell, ["-ilc", 'echo -n "$PATH"'], {
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, HOME: process.env.HOME || "" },
  });
}

async function defaultRunLoginShellPathAsync() {
  let shell = process.env.SHELL || "/bin/zsh";
  if (!path.isAbsolute(shell) || !existsSync(shell)) {
    shell = "/bin/zsh";
  }
  const { stdout } = await execFileAsync(shell, ["-ilc", 'echo -n "$PATH"'], {
    encoding: "utf8",
    timeout: 4000,
    env: { ...process.env, HOME: process.env.HOME || "" },
  });
  return stdout;
}

/**
 * Union a login-shell PATH ahead of basePath and de-duplicate, so a GUI launch
 * (Finder/Dock) with a stripped PATH still discovers user-installed CLIs.
 * Returns basePath unchanged on win32 or if the login-shell probe fails.
 */
function mergeLoginShellPath({
  basePath,
  runLoginShellPath = defaultRunLoginShellPath,
  platform = process.platform,
  delimiter = path.delimiter,
}) {
  if (platform === "win32") return basePath;
  let shellPath = "";
  try {
    shellPath = String(runLoginShellPath() || "").trim();
  } catch {
    return basePath;
  }
  if (!shellPath) return basePath;
  const seen = new Set();
  const out = [];
  for (const part of [...shellPath.split(delimiter), ...String(basePath || "").split(delimiter)]) {
    const p = part.trim();
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out.join(delimiter);
}

// ── Windows live PATH refresh ──
//
// A GUI-launched Electron process freezes process.env at launch. When a CLI is
// installed *after* Netcatty starts (its installer appends to the user/system
// PATH in the registry), a freshly opened cmd/PowerShell sees it but Netcatty
// does not — and clicking "Refresh" can't help, because process.env never
// changes for the life of the process. So on Windows we re-read the authoritative
// PATH from the registry (the value a brand-new shell would inherit) and merge it
// with the in-process PATH. This mirrors the login-shell PATH probe used on
// macOS/Linux and fixes CLIs (e.g. CodeBuddy) that "work in cmd" but don't scan.

function parseRegQueryPath(stdout) {
  // `reg query` prints e.g.: "    Path    REG_EXPAND_SZ    C:\\a;C:\\b"
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*\S)\s*$/i);
    if (match) return match[1];
  }
  return "";
}

function expandWindowsEnvRefs(value, env = process.env) {
  return String(value || "").replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === String(name).toLowerCase());
    return key && typeof env[key] === "string" ? env[key] : whole;
  });
}

function mergeWindowsPath(...pathStrings) {
  const seen = new Set();
  const out = [];
  for (const str of pathStrings) {
    for (const part of String(str || "").split(";")) {
      const trimmed = part.trim().replace(/^"|"$/g, "");
      if (!trimmed) continue;
      const dedupeKey = trimmed.toLowerCase().replace(/[\\/]+$/, "");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push(trimmed);
    }
  }
  return out.join(";");
}

function getWindowsKnownCliPathDirs(env = process.env) {
  const dirs = [];
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "npm"));
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, "pnpm"));
    dirs.push(path.join(env.LOCALAPPDATA, "Yarn", "bin"));
  }
  return dirs.filter((dir) => existsSync(dir));
}

async function readWindowsRegistryPath({ exec = execFileAsync, env = process.env } = {}) {
  const hives = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const parts = [];
  for (const hive of hives) {
    try {
      const { stdout } = await exec("reg", ["query", hive, "/v", "Path"], {
        encoding: "utf8",
        timeout: 3000,
      });
      const raw = parseRegQueryPath(stdout);
      if (raw) parts.push(expandWindowsEnvRefs(raw, env));
    } catch {
      // Hive unreadable / value missing — skip and rely on other sources.
    }
  }
  return parts.join(";");
}

async function getShellEnv() {
  if (_cachedShellEnv) return _cachedShellEnv;
  if (_shellEnvPromise) return _shellEnvPromise;

  const generation = _shellEnvGeneration;
  _shellEnvPromise = (async () => {
    const home = process.env.HOME || "";
    const extraPaths = [
      `${home}/.local/bin`,
      `${home}/.npm-global/bin`,
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ];

    if (process.platform === "win32") {
      // Re-read the live PATH from the registry so CLIs installed after launch
      // (e.g. CodeBuddy) are discoverable without restarting Netcatty, then fold
      // in well-known npm/pnpm/yarn global bin dirs as a belt-and-suspenders.
      let registryPath = "";
      try {
        registryPath = await readWindowsRegistryPath();
      } catch {
        registryPath = "";
      }
      const knownDirs = getWindowsKnownCliPathDirs().join(path.delimiter);
      const nextEnv = {
        ...process.env,
        PATH: mergeWindowsPath(registryPath, knownDirs, process.env.PATH || ""),
      };
      if (generation === _shellEnvGeneration) {
        _cachedShellEnv = nextEnv;
      }
      return nextEnv;
    }

    // On macOS/Linux, spawn a login shell to capture the real environment.
    try {
      let shell = process.env.SHELL || "/bin/zsh";
      if (!path.isAbsolute(shell) || !existsSync(shell)) {
        shell = "/bin/zsh";
      }
      const { stdout: envOutput } = await execFileAsync(shell, ['-ilc', 'env'], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, HOME: home },
      });
      const envMap = {};
      for (const line of envOutput.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          envMap[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      const shellPath = envMap.PATH || "";
      const mergedPath = [...extraPaths, shellPath, process.env.PATH || ""].join(path.delimiter);
      // Layer-0 fix-path: front-load + de-duplicate the login-shell PATH we just
      // captured (reuse the `-ilc env` result above — no second shell spawn).
      const nextEnv = {
        ...envMap,
        ...process.env,
        PATH: mergeLoginShellPath({ basePath: mergedPath, runLoginShellPath: () => shellPath }),
      };
      if (generation === _shellEnvGeneration) {
        _cachedShellEnv = nextEnv;
      }
      return nextEnv;
    } catch {
      // `-ilc env` failed — try a lighter login-shell PATH probe as a fallback so
      // GUI-launch PATH stripping still doesn't break CLI discovery (layer-0).
      const basePath = [...extraPaths, process.env.PATH || ""].join(path.delimiter);
      let loginShellPath = "";
      try {
        loginShellPath = await defaultRunLoginShellPathAsync();
      } catch {
        loginShellPath = "";
      }
      const nextEnv = {
        ...process.env,
        PATH: mergeLoginShellPath({
          basePath,
          runLoginShellPath: () => loginShellPath,
        }),
      };
      if (generation === _shellEnvGeneration) {
        _cachedShellEnv = nextEnv;
      }
      return nextEnv;
    }
  })().finally(() => {
    if (generation === _shellEnvGeneration) {
      _shellEnvPromise = null;
    }
  });

  return _shellEnvPromise;
}

/**
 * Drop the shell-env cache so the next getShellEnv() call re-spawns the
 * login shell. Useful when the user has just exported a new variable in
 * their rc file and clicks "Refresh Status" without restarting the app.
 */
function invalidateShellEnvCache() {
  _shellEnvGeneration += 1;
  _cachedShellEnv = null;
  _shellEnvPromise = null;
}

module.exports = {
  stripAnsi,
  formatSyntheticEcho,
  extractTrailingIdlePrompt,
  getFreshIdlePrompt,
  isDefaultPowerShellPromptLine,
  isDefaultCmdPromptLine,
  isDefaultPosixPromptLine,
  trackSessionIdlePrompt,
  clearLiveShellKind,
  looksLikeFishWrapperRejection,
  looksLikeNonFishShellRejection,
  setLiveShellKindFish,
  looksLikeIdleAutoLogout,
  isLocalhostHostname,
  extractFirstNonLocalhostUrl,
  normalizeCliPathForPlatform,
  shouldUseShellForCommand,
  quoteWindowsShellArg,
  buildWindowsShellCommandLine,
  prepareCommandForSpawn,
  resolveWindowsShimToNativeExe,
  resolveClaudeCodeExecutableForSdk,
  normalizeClaudeCodeExecutableEnvForSdk,
  resolveCodexExecutableForSdk,
  addCodexExecutableEnvForSdk,
  resolveCodebuddyExecutableForSdk,
  resolveSdkBinPath,
  resolveSdkBinPathAsync,
  resolveCliFromPath,
  resolveCliFromPathAsync,
  toUnpackedAsarPath,
  isPlausibleCliVersionOutput,
  mergeLoginShellPath,
  parseRegQueryPath,
  expandWindowsEnvRefs,
  mergeWindowsPath,
  readWindowsRegistryPath,
  getShellEnv,
  invalidateShellEnvCache,
};
