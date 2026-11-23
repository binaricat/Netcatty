import type { Terminal as XTerm } from "@xterm/xterm";
import { normalizeLineEndings, wrapBracketedPaste } from "../../../lib/utils";
import { markPromptLineBreakCommandPending } from "./promptLineBreak";
import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";

/**
 * Host startup is scheduled only after the shell attaches. Restored SSH and
 * local panes boot from the session fallback first; vault hydration replaces
 * `hostRef` while that start is still in flight. The startup command may come
 * from the live host only when that object still describes this launch:
 * - SSH: same id, hostname, username, dial port (`port || 22`), and protocol.
 * - Local: same id, protocol `"local"`, shell, shell args, and start directory.
 * A saved host edited onto another endpoint or shell since the workspace was
 * saved keeps the snapshot, so its command is not typed into the old session.
 *
 * Serial and Telnet preflight stay on the snapshot so a command that appears
 * on `hostRef` during open is not typed into a saved username/password
 * exchange. A ref that only carries a write-path toggle (no id) is not a host
 * snapshot. A different host id is a later pane, not this launch, so keep the
 * snapshot.
 */
const prefersLiveStartupHost = (protocol: string | undefined): boolean =>
  protocol === "ssh" || protocol === "local" || protocol === undefined;

const sshDialPort = (port: number | undefined): number => port || 22;

const sameSshDialTarget = (
  dial: TerminalSessionStartersContext["host"],
  live: TerminalSessionStartersContext["host"],
): boolean => {
  if (live.hostname !== dial.hostname) return false;
  if ((live.username ?? "") !== (dial.username ?? "")) return false;
  if (sshDialPort(live.port) !== sshDialPort(dial.port)) return false;
  // A live protocol, when set, must still be the protocol this dial used.
  if (live.protocol !== undefined && live.protocol !== (dial.protocol || "ssh")) return false;
  return true;
};

const sameLocalShellArgs = (
  left: string[] | undefined,
  right: string[] | undefined,
): boolean => {
  const normalizedLeft = left?.length ? left : undefined;
  const normalizedRight = right?.length ? right : undefined;
  if (!normalizedLeft && !normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight || normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((arg, index) => arg === normalizedRight[index]);
};

const sameLocalLaunchTarget = (
  dial: TerminalSessionStartersContext["host"],
  live: TerminalSessionStartersContext["host"],
): boolean => {
  if (live.protocol !== "local") return false;
  if ((live.localShell ?? "") !== (dial.localShell ?? "")) return false;
  if (!sameLocalShellArgs(dial.localShellArgs, live.localShellArgs)) return false;
  if ((live.localStartDir || "~") !== (dial.localStartDir || "~")) return false;
  return true;
};

const resolveStartupHost = (
  ctx: TerminalSessionStartersContext,
): TerminalSessionStartersContext["host"] => {
  const live = ctx.hostRef?.current;
  if (
    prefersLiveStartupHost(ctx.host.protocol)
    && live
    && live.id === ctx.host.id
    && (ctx.host.protocol === "local"
      ? sameLocalLaunchTarget(ctx.host, live)
      : sameSshDialTarget(ctx.host, live))
  ) {
    return live;
  }
  return ctx.host;
};

const STARTUP_COMMAND_DEFAULT_DELAY_MS = 600;
const STARTUP_COMMAND_MAX_DELAY_MS = 10000;

/**
 * Split a (possibly multi-line) startup command into non-empty lines, dropping
 * blank/whitespace-only lines but preserving each line's content verbatim — so
 * a single-line command stays byte-identical to what the user typed (e.g. a
 * leading space for `HISTCONTROL=ignorespace` is kept). Trailing `\r` from
 * CRLF input is normalized away.
 */
export function splitStartupCommandLines(commandText: string): string[] {
  return String(commandText || "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

/** Clamp a configured startup-command delay; fall back to the default when unset/invalid. */
export function normalizeStartupCommandDelay(raw: number | undefined): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : STARTUP_COMMAND_DEFAULT_DELAY_MS;
  return Math.max(0, Math.min(STARTUP_COMMAND_MAX_DELAY_MS, value));
}

const buildStartupPasteInput = (term: XTerm, commandText: string): string => {
  let data = normalizeLineEndings(commandText);
  if (data.includes("\n") && term.modes?.bracketedPasteMode && !term.options?.ignoreBracketedPasteMode) {
    data = wrapBracketedPaste(data);
  }
  return `${data}\r`;
};

export const resolveStartupCommand = (
  ctx: TerminalSessionStartersContext,
  options?: { consumeSuppressHostStartupCommand?: boolean },
): string | undefined => {
  const command = ctx.startupCommand || (ctx.suppressHostStartupCommandRef?.current ? undefined : resolveStartupHost(ctx).startupCommand);
  if (options?.consumeSuppressHostStartupCommand && ctx.suppressHostStartupCommandRef) {
    ctx.suppressHostStartupCommandRef.current = false;
  }
  return command;
};

export const scheduleStartupCommand = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  onSettled?: () => void,
  isCurrentAttempt?: () => boolean,
): (() => void) | undefined => {
  if (isCurrentAttempt && !isCurrentAttempt()) return undefined;
  const commandToRun = resolveStartupCommand(ctx, { consumeSuppressHostStartupCommand: true });
  if (!commandToRun || ctx.hasRunStartupCommandRef.current) return undefined;

  ctx.hasRunStartupCommandRef.current = true;
  const scheduledSessionId = id;
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  const delayMs = normalizeStartupCommandDelay(settings?.startupCommandDelayMs);

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const sessionIsCurrent = () =>
    !!ctx.sessionRef.current && ctx.sessionRef.current === scheduledSessionId
    && (!isCurrentAttempt || isCurrentAttempt());

  // noAutoRun (snippet "type but don't execute"): type the command as-is, no
  // Enter and no line-splitting — unchanged behavior.
  if (ctx.noAutoRun) {
    timeoutId = setTimeout(() => {
      if (cancelled) return;
      if (!sessionIsCurrent()) {
        onSettled?.();
        return;
      }
      ctx.terminalBackend.writeToSession(ctx.sessionRef.current, commandToRun, { automated: true });
      if (ctx.host.protocol === "serial" && !ctx.serialConfig?.lineMode) {
        ctx.recordSerialSnippetInput?.(commandToRun);
      }
      onSettled?.();
    }, delayMs);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }

  const lines = splitStartupCommandLines(commandToRun);
  if (lines.length === 0) {
    onSettled?.();
    return undefined;
  }

  const runMode = ctx.startupCommand
    ? (ctx.multiLineRunMode ?? "paste")
    : (resolveStartupHost(ctx).startupCommandRunMode ?? "paste");
  if (runMode === "paste") {
    timeoutId = setTimeout(() => {
      if (cancelled) return;
      if (!sessionIsCurrent()) {
        onSettled?.();
        return;
      }
      ctx.terminalBackend.writeToSession(
        ctx.sessionRef.current,
        buildStartupPasteInput(term, commandToRun),
        { automated: true },
      );
      for (const line of lines) {
        markPromptLineBreakCommandPending(ctx.promptLineBreakStateRef, term, line);
        ctx.onCommandExecuted?.(line, ctx.host.id, ctx.host.label, ctx.sessionId);
      }
      onSettled?.();
    }, delayMs);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }

  // Line-by-line mode: wait before each line so prompt-driven sessions can
  // react between steps.
  let index = 0;
  const runNext = () => {
    if (cancelled) return;
    if (!sessionIsCurrent()) {
      onSettled?.();
      return;
    }
    const line = lines[index];
    ctx.terminalBackend.writeToSession(ctx.sessionRef.current, `${line}\r`, { automated: true });
    markPromptLineBreakCommandPending(ctx.promptLineBreakStateRef, term, line);
    ctx.onCommandExecuted?.(line, ctx.host.id, ctx.host.label, ctx.sessionId);
    index += 1;
    if (index < lines.length) {
      timeoutId = setTimeout(runNext, delayMs);
    } else {
      onSettled?.();
    }
  };

  timeoutId = setTimeout(runNext, delayMs);
  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
};
