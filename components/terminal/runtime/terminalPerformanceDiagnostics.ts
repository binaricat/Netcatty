import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";

export type TerminalOutputPerfMeta = {
  id: string;
  emittedAt: number;
  chars: number;
  lineFeeds: number;
};

export type TerminalOutputPerfTrace = {
  id: string;
  sessionId?: string;
  startedAt: number;
  rendererReceivedAt: number;
  ingressBytes: number;
  inputChars: number;
  inputLineFeeds: number;
  backend?: TerminalOutputPerfMeta;
};

type TerminalOutputPerfMetaCarrier = {
  terminalPerf?: TerminalOutputPerfMeta;
};

const DEBUG_KEYS = [
  "NETCATTY_TERMINAL_PERF_DEBUG",
  "NETCATTY_TERMINAL_DEBUG",
];
const PERF_LOG_PREFIX = "[Netcatty Terminal Perf]";
const LOCAL_STORAGE_DEBUG_CACHE_TTL_MS = 1000;

let localStorageDebugCache = false;
let localStorageDebugCacheAt = 0;

const countLineFeeds = (data: string): number => {
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === "\n") count += 1;
  }
  return count;
};

const safeJson = (value: unknown): string => JSON.stringify(value, (_key, nested) => {
  if (typeof nested === "bigint") return nested.toString();
  if (typeof nested === "function") return "[function]";
  return nested;
});

const sendRendererDiagnostic = (
  message: string,
  payload: Record<string, unknown>,
): void => {
  try {
    const logDiagnostic = netcattyBridge.get()?.logDiagnostic;
    if (typeof logDiagnostic !== "function") return;
    void logDiagnostic({
      source: "terminal-perf",
      message,
      extra: payload,
    }).catch(() => undefined);
  } catch {
    // Diagnostics must never affect terminal output.
  }
};

const readLocalStorageDebugEnabled = (): boolean => {
  try {
    return DEBUG_KEYS.some((key) => window.localStorage?.getItem(key) === "1");
  } catch {
    return false;
  }
};

const isLocalStorageDebugEnabled = (): boolean => {
  const now = Date.now();
  if (now - localStorageDebugCacheAt > LOCAL_STORAGE_DEBUG_CACHE_TTL_MS) {
    localStorageDebugCache = readLocalStorageDebugEnabled();
    localStorageDebugCacheAt = now;
  }
  return localStorageDebugCache;
};

export const isTerminalPerformanceDebugEnabled = (
  meta?: TerminalOutputPerfMetaCarrier,
): boolean => Boolean(meta?.terminalPerf) || isLocalStorageDebugEnabled();

export const createTerminalOutputPerfTrace = ({
  sessionId,
  data,
  ingressBytes,
  meta,
}: {
  sessionId?: string;
  data: string;
  ingressBytes: number;
  meta?: TerminalOutputPerfMetaCarrier;
}): TerminalOutputPerfTrace | null => {
  if (!isTerminalPerformanceDebugEnabled(meta)) return null;
  const now = performance.now();
  return {
    id: meta?.terminalPerf?.id ?? `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    startedAt: now,
    rendererReceivedAt: Date.now(),
    ingressBytes,
    inputChars: data.length,
    inputLineFeeds: countLineFeeds(data),
    backend: meta?.terminalPerf,
  };
};

export const logTerminalOutputPerf = (
  event: string,
  trace: TerminalOutputPerfTrace | null | undefined,
  details: Record<string, unknown> = {},
): void => {
  if (!trace && !isLocalStorageDebugEnabled()) return;
  const now = performance.now();
  const backendToRendererMs = trace?.backend?.emittedAt
    ? trace.rendererReceivedAt - trace.backend.emittedAt
    : undefined;
  const payload = {
    event,
    id: trace?.id,
    sessionId: trace?.sessionId,
    at: Date.now(),
    elapsedMs: trace ? Number((now - trace.startedAt).toFixed(1)) : undefined,
    backendToRendererMs,
    ingressBytes: trace?.ingressBytes,
    inputChars: trace?.inputChars,
    inputLineFeeds: trace?.inputLineFeeds,
    backendChars: trace?.backend?.chars,
    backendLineFeeds: trace?.backend?.lineFeeds,
    ...details,
  };
  try {
    const message = `${PERF_LOG_PREFIX} ${safeJson(payload)}`;
    console.info(message);
    sendRendererDiagnostic(message, payload);
  } catch {
    // Diagnostics must never affect terminal output.
  }
};
