/**
 * Shared tool execution logic used by both the Catty Agent executor (switch/case)
 * and the Vercel AI SDK tool wrappers.
 *
 * Each function encapsulates the core business logic for a tool — validation,
 * safety checks, bridge calls, and result formatting — so callers only need to
 * adapt the return value to their own response shape.
 */

import type { NetcattyBridge, ExecutorContext } from '../cattyAgent/executor';
import type { AIPermissionMode, WebSearchConfig } from '../types';
import { checkCommandSafety } from '../cattyAgent/safety';
import { executeWebSearchProvider } from './webSearchProviders';

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/** Discriminated union returned by every shared executor. */
export type ToolExecResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface TerminalJobStartData {
  jobId: string;
  sessionId: string;
  command: string;
  status: string;
  startedAt: number;
  outputMode?: string;
  recommendedPollIntervalMs?: number;
}

export interface TerminalJobSnapshotData {
  jobId: string;
  sessionId: string;
  command: string;
  status: string;
  completed: boolean;
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  output: string;
  nextOffset: number;
  totalOutputChars: number;
  outputBaseOffset: number;
  outputTruncated: boolean;
  recommendedPollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Dependencies bundle
// ---------------------------------------------------------------------------

export interface ToolDeps {
  bridge: NetcattyBridge;
  context: ExecutorContext | (() => ExecutorContext);
  commandBlocklist?: string[];
  permissionMode: AIPermissionMode;
  webSearchConfig?: WebSearchConfig;
  chatSessionId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveContext(ctx: ToolDeps['context']): ExecutorContext {
  return typeof ctx === 'function' ? ctx() : ctx;
}

function validSessionIds(ctx: ToolDeps['context']): Set<string> {
  const resolved = resolveContext(ctx);
  return new Set(resolved.sessions.map(s => s.sessionId));
}

function scopedSessionIds(ctx: ToolDeps['context']): string[] {
  return [...validSessionIds(ctx)];
}

function validateSessionScope(ctx: ToolDeps['context'], sessionId: string): string | null {
  const ids = validSessionIds(ctx);
  if (!ids.has(sessionId)) {
    return `Session "${sessionId}" is not in the current scope. Available sessions: ${[...ids].join(', ')}`;
  }
  return null;
}

function isObserver(mode: AIPermissionMode): boolean {
  return mode === 'observer';
}

function getSessionExecutionContext(ctx: ToolDeps['context'], sessionId: string): {
  isNetworkDevice: boolean;
} {
  const resolved = resolveContext(ctx);
  const targetSession = resolved.sessions.find(s => s.sessionId === sessionId);
  const proto = targetSession?.protocol || '';
  const isSshOrSerial = proto === 'ssh' || proto === 'serial';
  return {
    isNetworkDevice: proto === 'serial' || (targetSession?.deviceType === 'network' && isSshOrSerial),
  };
}

function validateTerminalCommand(
  deps: ToolDeps,
  args: { sessionId: string; command: string },
): ToolExecResult<{ isNetworkDevice: boolean }> {
  const { context, commandBlocklist, permissionMode } = deps;
  const { sessionId, command } = args;

  if (!sessionId || !command) {
    return { ok: false, error: 'Missing sessionId or command' };
  }
  const scopeErr = validateSessionScope(context, sessionId);
  if (scopeErr) return { ok: false, error: scopeErr };
  if (isObserver(permissionMode)) {
    return { ok: false, error: 'Observer mode: command execution is disabled. Switch to Confirm or Auto mode to execute commands.' };
  }

  const executionContext = getSessionExecutionContext(context, sessionId);
  if (!executionContext.isNetworkDevice) {
    const safety = checkCommandSafety(command, commandBlocklist);
    if (safety.blocked) {
      return { ok: false, error: `Command blocked by safety policy. Matched pattern: ${safety.matchedPattern}` };
    }
  }
  return { ok: true, data: executionContext };
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

export async function executeTerminalExecute(
  deps: ToolDeps,
  args: { sessionId: string; command: string },
): Promise<ToolExecResult<{ stdout: string; stderr: string; exitCode: number | null }>> {
  const { bridge } = deps;
  const { sessionId, command } = args;
  const validated = validateTerminalCommand(deps, args);
  if (validated.ok === false) return validated;
  const { isNetworkDevice } = validated.data;

  const result = await bridge.aiExec(sessionId, command, deps.chatSessionId);
  // Real execution failures (timeout, disconnect, no stream) have an `error` field
  if (!result.ok && result.error) {
    const parts = [result.error];
    if (result.stdout) parts.push(`Partial output:\n${result.stdout}`);
    if (result.stderr) parts.push(`Stderr:\n${result.stderr}`);
    return { ok: false, error: parts.join('\n\n') };
  }
  // Command ran (even if exit code is non-zero) — always return stdout+exitCode for LLM to judge.
  // Network device / serial sessions return exitCode: null because vendor CLIs don't expose
  // exit codes. Preserve null so the model knows exit status is unavailable rather than
  // seeing a misleading 0 (success) or -1 (failure).
  return {
    ok: true,
    data: {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: isNetworkDevice ? (result.exitCode ?? null) : (result.exitCode ?? -1),
    },
  };
}

export async function executeTerminalStart(
  deps: ToolDeps,
  args: { sessionId: string; command: string },
): Promise<ToolExecResult<TerminalJobStartData>> {
  const { bridge } = deps;
  const { sessionId, command } = args;
  const validated = validateTerminalCommand(deps, args);
  if (validated.ok === false) return validated;

  if (!bridge.aiJobStart) {
    return { ok: false, error: 'terminal_start is not available on the Netcatty bridge' };
  }

  const result = await bridge.aiJobStart(
    sessionId,
    command,
    deps.chatSessionId,
    scopedSessionIds(deps.context),
  );
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to start background terminal job' };
  }
  if (!result.jobId || !result.sessionId || !result.command || !result.status || !result.startedAt) {
    return { ok: false, error: 'Background terminal job start returned an incomplete response' };
  }
  return {
    ok: true,
    data: {
      jobId: result.jobId,
      sessionId: result.sessionId,
      command: result.command,
      status: result.status,
      startedAt: result.startedAt,
      outputMode: result.outputMode,
      recommendedPollIntervalMs: result.recommendedPollIntervalMs,
    },
  };
}

function normalizeTerminalJobSnapshot(result: {
  ok: boolean;
  jobId?: string;
  sessionId?: string;
  command?: string;
  status?: string;
  completed?: boolean;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: number;
  updatedAt?: number;
  output?: string;
  nextOffset?: number;
  totalOutputChars?: number;
  outputBaseOffset?: number;
  outputTruncated?: boolean;
  recommendedPollIntervalMs?: number;
}): ToolExecResult<TerminalJobSnapshotData> {
  if (!result.ok) {
    return { ok: false, error: result.error || 'Background terminal job request failed' };
  }
  if (!result.jobId || !result.sessionId || !result.command || !result.status) {
    return { ok: false, error: 'Background terminal job returned an incomplete response' };
  }
  return {
    ok: true,
    data: {
      jobId: result.jobId,
      sessionId: result.sessionId,
      command: result.command,
      status: result.status,
      completed: Boolean(result.completed),
      exitCode: result.exitCode ?? null,
      error: result.error ?? null,
      startedAt: Number(result.startedAt) || 0,
      updatedAt: Number(result.updatedAt) || 0,
      output: result.output || '',
      nextOffset: Number(result.nextOffset) || 0,
      totalOutputChars: Number(result.totalOutputChars) || 0,
      outputBaseOffset: Number(result.outputBaseOffset) || 0,
      outputTruncated: Boolean(result.outputTruncated),
      recommendedPollIntervalMs: result.recommendedPollIntervalMs,
    },
  };
}

export async function executeTerminalPoll(
  deps: ToolDeps,
  args: { jobId: string; offset?: number },
): Promise<ToolExecResult<TerminalJobSnapshotData>> {
  if (!args.jobId) {
    return { ok: false, error: 'Missing jobId' };
  }
  if (!deps.bridge.aiJobPoll) {
    return { ok: false, error: 'terminal_poll is not available on the Netcatty bridge' };
  }
  const result = await deps.bridge.aiJobPoll(
    args.jobId,
    args.offset ?? 0,
    deps.chatSessionId,
    scopedSessionIds(deps.context),
  );
  return normalizeTerminalJobSnapshot(result);
}

export async function executeTerminalStop(
  deps: ToolDeps,
  args: { jobId: string },
): Promise<ToolExecResult<TerminalJobSnapshotData>> {
  if (!args.jobId) {
    return { ok: false, error: 'Missing jobId' };
  }
  if (!deps.bridge.aiJobStop) {
    return { ok: false, error: 'terminal_stop is not available on the Netcatty bridge' };
  }
  const result = await deps.bridge.aiJobStop(
    args.jobId,
    deps.chatSessionId,
    scopedSessionIds(deps.context),
  );
  return normalizeTerminalJobSnapshot(result);
}

export function executeWorkspaceGetInfo(
  deps: ToolDeps,
): ToolExecResult<{
  workspaceId: string | null;
  workspaceName: string | null;
  sessions: Array<{
    sessionId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    protocol?: string;
    shellType?: string;
    deviceType?: string;
    connected: boolean;
  }>;
}> {
  const context = resolveContext(deps.context);
  return {
    ok: true,
    data: {
      workspaceId: context.workspaceId || null,
      workspaceName: context.workspaceName || null,
      sessions: context.sessions.map(s => ({
        sessionId: s.sessionId,
        hostname: s.hostname,
        label: s.label,
        os: s.os,
        username: s.username,
        protocol: s.protocol,
        shellType: s.shellType,
        deviceType: s.deviceType,
        connected: s.connected,
      })),
    },
  };
}

export function executeWorkspaceGetSessionInfo(
  deps: ToolDeps,
  args: { sessionId: string },
): ToolExecResult<ExecutorContext['sessions'][number]> {
  const context = resolveContext(deps.context);
  const session = context.sessions.find(s => s.sessionId === args.sessionId);
  if (!session) {
    return { ok: false, error: `Session not found: ${args.sessionId}` };
  }
  return { ok: true, data: session };
}

// ---------------------------------------------------------------------------
// Web Search & URL Fetch (read-only, no permission check needed)
// ---------------------------------------------------------------------------

export async function executeWebSearch(
  deps: ToolDeps,
  args: { query: string; maxResults?: number },
): Promise<ToolExecResult<{ results: Array<{ title: string; url: string; content: string }> }>> {
  const { bridge, webSearchConfig } = deps;

  if (!webSearchConfig?.enabled) {
    return { ok: false, error: 'Web search is not enabled. Please configure a search provider in Settings → AI.' };
  }
  if (!args.query) {
    return { ok: false, error: 'Missing search query' };
  }

  try {
    const maxResults = Math.max(1, Math.min(20, args.maxResults ?? webSearchConfig.maxResults ?? 5));
    const results = await executeWebSearchProvider(bridge, webSearchConfig, args.query, maxResults);
    // Enforce maxResults after provider normalization (some providers ignore the limit)
    return { ok: true, data: { results: results.slice(0, maxResults) } };
  } catch (err) {
    return { ok: false, error: `Web search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

interface BridgeFetchResponse {
  ok: boolean;
  status?: number;
  data?: string;
  error?: string;
}

export async function executeUrlFetch(
  deps: ToolDeps,
  args: { url: string; maxLength?: number },
): Promise<ToolExecResult<{ url: string; content: string; status: number }>> {
  const { bridge } = deps;
  const { url } = args;

  if (!url || !url.startsWith('https://')) {
    return { ok: false, error: 'Invalid URL. Must start with https://' };
  }

  const aiFetch = (bridge as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>).aiFetch;
  if (!aiFetch) {
    return { ok: false, error: 'aiFetch is not available on the bridge' };
  }

  try {
    // skipHostCheck=true, followRedirects=true: url_fetch targets user-provided URLs
    const resp = await aiFetch(url, 'GET', {
      'User-Agent': 'Netcatty-AI/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    }, undefined, undefined, true, true) as BridgeFetchResponse;

    if (!resp.ok) {
      return { ok: false, error: resp.error || `HTTP ${resp.status}` };
    }

    const maxLength = Math.max(1, Math.min(200000, args.maxLength ?? 50000));
    let content = resp.data || '';
    if (content.length > maxLength) {
      content = content.slice(0, maxLength) + '\n\n[Content truncated]';
    }

    return { ok: true, data: { url, content, status: resp.status || 200 } };
  } catch (err) {
    return { ok: false, error: `URL fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
