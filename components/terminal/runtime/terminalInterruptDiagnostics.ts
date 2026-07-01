import type { TerminalInputPrioritySnapshot } from "./terminalOutputPipeline";

const DEBUG_KEYS = [
  "NETCATTY_CTRL_C_DEBUG",
  "NETCATTY_TERMINAL_DEBUG",
];

function isDebugEnabled(): boolean {
  try {
    return DEBUG_KEYS.some((key) => window.localStorage?.getItem(key) === "1");
  } catch {
    return false;
  }
}

function randomTraceSuffix(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export function createTerminalInterruptTrace(options: {
  sessionId: string;
  rendererKeyAt: number;
  status: string;
  hasSelection: boolean;
  priority?: TerminalInputPrioritySnapshot;
}): NetcattyTerminalInterruptTrace {
  const debug = isDebugEnabled();
  return {
    debug,
    traceId: `ctrlc-${Date.now().toString(36)}-${randomTraceSuffix()}`,
    source: "renderer-xterm-keydown",
    sessionId: options.sessionId,
    rendererKeyAt: options.rendererKeyAt,
    rendererSendAt: Date.now(),
    rendererStatus: options.status,
    rendererHasSelection: options.hasSelection,
    rendererPriority: options.priority,
  };
}

export function logTerminalInterruptTrace(
  event: string,
  trace: NetcattyTerminalInterruptTrace | undefined,
  details: Record<string, unknown> = {},
): void {
  if (!trace?.debug) return;
  const now = Date.now();
  try {
    console.info("[Netcatty Ctrl+C]", {
      event,
      traceId: trace.traceId,
      sessionId: trace.sessionId,
      at: now,
      deltaFromKeyMs: Number.isFinite(trace.rendererKeyAt) ? now - trace.rendererKeyAt : undefined,
      ...details,
    });
  } catch {
    // Diagnostic logging must never affect terminal input.
  }
}
