import type { Snippet } from '@/domain/models';
import { isScriptSnippet, scriptContainsWriteOperations } from '@/domain/snippetScript.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';
import { STORAGE_KEY_AI_PERMISSION_MODE } from '@/infrastructure/config/storageKeys.ts';
import type { AIPermissionMode } from '@/infrastructure/ai/types.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';
import { publishScriptRunsSnapshot } from './scriptRunsStore.ts';

type RunsListener = (runs: ScriptRun[]) => void;

let runs: ScriptRun[] = [];
const runsListeners = new Set<RunsListener>();

function readPermissionMode(): AIPermissionMode {
  const stored = localStorageAdapter.readString(STORAGE_KEY_AI_PERMISSION_MODE);
  if (stored === 'observer' || stored === 'confirm' || stored === 'auto') return stored;
  return 'confirm';
}

export function subscribeScriptRuns(listener: RunsListener): () => void {
  runsListeners.add(listener);
  queueMicrotask(() => {
    if (runsListeners.has(listener)) {
      listener(runs);
    }
  });
  return () => runsListeners.delete(listener);
}

export function getScriptRuns(): readonly ScriptRun[] {
  return runs;
}

export function setScriptRuns(nextRuns: ScriptRun[]) {
  runs = nextRuns;
  // Keep the panel-facing store in lockstep so Scripts UI and overlays share one source.
  publishScriptRunsSnapshot(nextRuns);
  runsListeners.forEach((listener) => listener(runs));
}

/**
 * Chooses the single overlay worth showing while retaining dismissed history
 * so global run broadcasts cannot bring old completion banners back.
 */
export function selectScriptOverlayRun(
  allRuns: ScriptRun[],
  sessionId: string,
  dismissedRunIds: Set<string>,
): ScriptRun | undefined {
  const sessionRuns = allRuns.filter((run) => run.sessionId === sessionId);
  const activeRunIds = new Set(sessionRuns.map((run) => run.runId));
  for (const runId of dismissedRunIds) {
    if (!activeRunIds.has(runId)) dismissedRunIds.delete(runId);
  }

  const liveRun = sessionRuns.find((run) => run.status === 'running' || run.status === 'paused');
  if (liveRun) {
    for (const run of sessionRuns) {
      if (run.status === 'completed' || run.status === 'failed') {
        dismissedRunIds.add(run.runId);
      }
    }
    return liveRun;
  }

  const finishedRuns = sessionRuns
    .filter((run) => run.status === 'completed' || run.status === 'failed')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const latestRun = finishedRuns.find((run) => !dismissedRunIds.has(run.runId));
  if (!latestRun) return undefined;

  for (const run of finishedRuns) {
    if (run.runId !== latestRun.runId) dismissedRunIds.add(run.runId);
  }
  return latestRun;
}

export function getActiveScriptRunForSession(sessionId: string): ScriptRun | undefined {
  return runs.find((run) =>
    run.sessionId === sessionId && (run.status === 'running' || run.status === 'paused'),
  );
}

export async function runAutomationScript(params: {
  runId?: string;
  returnWhenQueued?: boolean;
  snippet: Snippet;
  sessionId: string;
  sessionIds?: string[];
  mode?: 'sequential' | 'parallel';
  sessionMeta?: {
    connected?: boolean;
    name?: string;
    hostname?: string;
    username?: string;
  };
  /** AI-initiated runs honor Observer. User runs are an explicit action and always execute. */
  initiatedBy?: 'user' | 'ai';
}): Promise<{ runId: string; runIds: string[] }> {
  const permissionMode = params.initiatedBy === 'ai' ? readPermissionMode() : 'auto';
  if (permissionMode === 'observer' && scriptContainsWriteOperations(params.snippet.command)) {
    throw new Error('Observer mode blocks scripts that write to the terminal.');
  }

  const bridge = netcattyBridge.get();
  if (!bridge?.scriptRun) {
    throw new Error('Script bridge unavailable');
  }
  return bridge.scriptRun({
    runId: params.runId,
    returnWhenQueued: params.returnWhenQueued,
    scriptId: params.snippet.id,
    scriptLabel: params.snippet.label,
    content: params.snippet.command,
    sessionId: params.sessionId,
    sessionIds: params.sessionIds,
    mode: params.mode,
    permissionMode,
    sessionMeta: params.sessionMeta,
  });
}

const TERMINAL_SCRIPT_STATUSES = new Set<ScriptRun['status']>(['completed', 'failed']);

export function waitForScriptRun(
  runId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ScriptRun> {
  const existing = runs.find((entry) => entry.runId === runId);
  if (existing && TERMINAL_SCRIPT_STATUSES.has(existing.status)) {
    if (existing.status === 'completed') {
      return Promise.resolve(existing);
    }
    return Promise.reject(new Error(existing.error || 'Script failed'));
  }

  const timeoutMs = options.timeoutMs ?? 3_600_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      unsubscribe();
      options.signal?.removeEventListener('abort', onAbort);
      handler();
    };

    const onAbort = () => {
      finish(() => reject(new Error('Aborted')));
    };

    const settleRun = (run: ScriptRun | undefined) => {
      if (!run || !TERMINAL_SCRIPT_STATUSES.has(run.status)) return;
      if (run.status === 'completed') {
        finish(() => resolve(run));
        return;
      }
      finish(() => reject(new Error(run.error || 'Script failed')));
    };

    unsubscribe = subscribeScriptRuns((currentRuns) => {
      settleRun(currentRuns.find((entry) => entry.runId === runId));
    });

    timeoutId = setTimeout(() => {
      finish(() => reject(new Error('Script run timed out')));
    }, timeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runConnectScriptsSequential(params: {
  scripts: Snippet[];
  sessionId: string;
  signal?: AbortSignal;
  onCancelableRunChange?: (stopCurrentRun: (() => Promise<void>) | null) => void;
  onScriptStart?: (snippet: Snippet) => void;
  onScriptComplete?: (snippet: Snippet) => void;
  sessionMeta?: {
    connected?: boolean;
    name?: string;
    hostname?: string;
    username?: string;
  };
}): Promise<void> {
  const throwIfAborted = () => {
    if (params.signal?.aborted) {
      throw new DOMException('Connect script run cancelled', 'AbortError');
    }
  };

  for (const snippet of params.scripts) {
    throwIfAborted();
    const runId = crypto.randomUUID();
    let stopPromise: Promise<void> | undefined;
    let stopped = false;
    params.onScriptStart?.(snippet);
    const queueAccepted = runAutomationScript({
      runId,
      returnWhenQueued: true,
      snippet,
      sessionId: params.sessionId,
      sessionMeta: params.sessionMeta,
    });
    const stopThisRun = () => {
      if (stopPromise) return stopPromise;
      const attempt = queueAccepted.then(async () => {
        const result = await stopScriptRun(runId);
        if (!result.ok) {
          throw new Error(`Connect script run could not be stopped: ${runId}`);
        }
        stopped = true;
      });
      stopPromise = attempt;
      void attempt.catch(() => {
        if (stopPromise === attempt) stopPromise = undefined;
      });
      return attempt;
    };
    params.onCancelableRunChange?.(stopThisRun);
    const onAbort = () => {
      void stopThisRun().catch(() => {});
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await queueAccepted;
      throwIfAborted();
      await waitForScriptRun(runId, { signal: params.signal });
      params.onScriptComplete?.(snippet);
    } catch (err) {
      if (params.signal?.aborted) {
        await stopThisRun();
        throw new DOMException('Connect script run cancelled', 'AbortError');
      }
      throw err;
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
      if (!params.signal?.aborted || stopped) {
        params.onCancelableRunChange?.(null);
      }
    }
  }
}

export async function runSnippetOrScript(params: {
  snippet: Snippet;
  sessionId: string;
  runSnippetText: (
    command: string,
    noAutoRun?: boolean,
    options?: { multiLineRunMode?: Snippet["multiLineRunMode"] },
  ) => void;
  command: string;
}) {
  if (isScriptSnippet(params.snippet)) {
    await runAutomationScript({
      snippet: params.snippet,
      sessionId: params.sessionId,
    });
    return;
  }
  params.runSnippetText(params.command, params.snippet.noAutoRun, {
    multiLineRunMode: params.snippet.multiLineRunMode,
  });
}

export async function stopScriptRun(runId: string): Promise<{ ok: boolean }> {
  const result = await netcattyBridge.get()?.scriptStop?.(runId);
  return { ok: result?.ok !== false };
}

export async function pauseScriptRun(runId: string): Promise<{ ok: boolean }> {
  const result = await netcattyBridge.get()?.scriptPause?.(runId);
  return { ok: result?.ok !== false };
}

export async function resumeScriptRun(runId: string): Promise<{ ok: boolean }> {
  const result = await netcattyBridge.get()?.scriptResume?.(runId);
  return { ok: result?.ok !== false };
}
