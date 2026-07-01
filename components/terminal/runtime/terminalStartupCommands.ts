import type { Terminal as XTerm } from "@xterm/xterm";
import { normalizeLineEndings, wrapBracketedPaste } from "../../../lib/utils";
import { markPromptLineBreakCommandPending } from "./promptLineBreak";
import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";

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
  const command = ctx.startupCommand || (ctx.suppressHostStartupCommandRef?.current ? undefined : ctx.host.startupCommand);
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
): (() => void) | undefined => {
  const commandToRun = resolveStartupCommand(ctx, { consumeSuppressHostStartupCommand: true });
  if (!commandToRun || ctx.hasRunStartupCommandRef.current) return undefined;

  ctx.hasRunStartupCommandRef.current = true;
  const scheduledSessionId = id;
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  const delayMs = normalizeStartupCommandDelay(settings?.startupCommandDelayMs);

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const sessionIsCurrent = () =>
    !!ctx.sessionRef.current && ctx.sessionRef.current === scheduledSessionId;

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
    : (ctx.host.startupCommandRunMode ?? "paste");
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
