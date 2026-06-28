import type { Snippet } from '@/domain/models';
import { isScriptSnippet, scriptContainsWriteOperations } from '@/domain/snippetScript.ts';
import { localStorageAdapter } from '@/infrastructure/persistence/localStorageAdapter.ts';
import { STORAGE_KEY_AI_PERMISSION_MODE } from '@/infrastructure/config/storageKeys.ts';
import type { AIPermissionMode } from '@/infrastructure/ai/types.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import type { ScriptRun } from '@/types/global/netcatty-bridge-script.d.ts';

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
  listener(runs);
  return () => runsListeners.delete(listener);
}

export function setScriptRuns(nextRuns: ScriptRun[]) {
  runs = nextRuns;
  runsListeners.forEach((listener) => listener(runs));
}

export function getActiveScriptRunForSession(sessionId: string): ScriptRun | undefined {
  return runs.find((run) =>
    run.sessionId === sessionId && (run.status === 'running' || run.status === 'paused'),
  );
}

export async function runAutomationScript(params: {
  snippet: Snippet;
  sessionId: string;
  sessionIds?: string[];
  mode?: 'sequential' | 'parallel';
  sessionMeta?: {
    connected?: boolean;
    hostname?: string;
    username?: string;
  };
}): Promise<{ runId: string; runIds: string[] }> {
  const permissionMode = readPermissionMode();
  if (permissionMode === 'observer' && scriptContainsWriteOperations(params.snippet.command)) {
    throw new Error('Observer mode blocks scripts that write to the terminal.');
  }

  const bridge = netcattyBridge.get();
  if (!bridge?.scriptRun) {
    throw new Error('Script bridge unavailable');
  }
  return bridge.scriptRun({
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
  const timeoutMs = options.timeoutMs ?? 3_600_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

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

    const unsubscribe = subscribeScriptRuns((currentRuns) => {
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
  onScriptStart?: (snippet: Snippet) => void;
  onScriptComplete?: (snippet: Snippet) => void;
  sessionMeta?: {
    connected?: boolean;
    hostname?: string;
    username?: string;
  };
}): Promise<void> {
  for (const snippet of params.scripts) {
    if (params.signal?.aborted) {
      throw new Error('Aborted');
    }
    params.onScriptStart?.(snippet);
    const { runId } = await runAutomationScript({
      snippet,
      sessionId: params.sessionId,
      sessionMeta: params.sessionMeta,
    });
    await waitForScriptRun(runId, { signal: params.signal });
    params.onScriptComplete?.(snippet);
  }
}

export async function runSnippetOrScript(params: {
  snippet: Snippet;
  sessionId: string;
  runSnippetText: (command: string, noAutoRun?: boolean) => void;
  command: string;
}) {
  if (isScriptSnippet(params.snippet)) {
    await runAutomationScript({
      snippet: params.snippet,
      sessionId: params.sessionId,
    });
    return;
  }
  params.runSnippetText(params.command, params.snippet.noAutoRun);
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
