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
import { shellQuote } from '../shellQuote';
import { limitConcurrency } from '../concurrency';
import { executeWebSearchProvider } from './webSearchProviders';

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/** Discriminated union returned by every shared executor. */
export type ToolExecResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Dependencies bundle
// ---------------------------------------------------------------------------

export interface ToolDeps {
  bridge: NetcattyBridge;
  context: ExecutorContext;
  commandBlocklist?: string[];
  permissionMode: AIPermissionMode;
  webSearchConfig?: WebSearchConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validSessionIds(ctx: ExecutorContext): Set<string> {
  return new Set(ctx.sessions.map(s => s.sessionId));
}

function validateSessionScope(ctx: ExecutorContext, sessionId: string): string | null {
  const ids = validSessionIds(ctx);
  if (!ids.has(sessionId)) {
    return `Session "${sessionId}" is not in the current scope. Available sessions: ${[...ids].join(', ')}`;
  }
  return null;
}

function isObserver(mode: AIPermissionMode): boolean {
  return mode === 'observer';
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

export async function executeTerminalExecute(
  deps: ToolDeps,
  args: { sessionId: string; command: string },
): Promise<ToolExecResult<{ stdout: string; stderr: string; exitCode: number }>> {
  const { bridge, context, commandBlocklist, permissionMode } = deps;
  const { sessionId, command } = args;

  if (!sessionId || !command) {
    return { ok: false, error: 'Missing sessionId or command' };
  }
  const scopeErr = validateSessionScope(context, sessionId);
  if (scopeErr) return { ok: false, error: scopeErr };
  if (isObserver(permissionMode)) {
    return { ok: false, error: 'Observer mode: command execution is disabled. Switch to Confirm or Auto mode to execute commands.' };
  }
  const safety = checkCommandSafety(command, commandBlocklist);
  if (safety.blocked) {
    return { ok: false, error: `Command blocked by safety policy. Matched pattern: ${safety.matchedPattern}` };
  }

  const result = await bridge.aiExec(sessionId, command);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Command failed' };
  }
  return {
    ok: true,
    data: {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode ?? -1,
    },
  };
}

export async function executeTerminalSendInput(
  deps: ToolDeps,
  args: { sessionId: string; input: string },
): Promise<ToolExecResult<{ sent: string }>> {
  const { bridge, context, commandBlocklist, permissionMode } = deps;
  const { sessionId, input } = args;

  if (!sessionId || !input) {
    return { ok: false, error: 'Missing sessionId or input' };
  }
  const scopeErr = validateSessionScope(context, sessionId);
  if (scopeErr) return { ok: false, error: scopeErr };
  if (isObserver(permissionMode)) {
    return { ok: false, error: 'Observer mode: terminal input is disabled. Switch to Confirm or Auto mode.' };
  }
  const safety = checkCommandSafety(input, commandBlocklist);
  if (safety.blocked) {
    return { ok: false, error: `Input blocked by safety policy. Matched pattern: ${safety.matchedPattern}` };
  }

  const result = await bridge.aiTerminalWrite(sessionId, input);
  if (!result.ok) {
    return { ok: false, error: result.error || 'Failed to send input' };
  }
  return { ok: true, data: { sent: input } };
}

export async function executeSftpListDirectory(
  deps: ToolDeps,
  args: { sessionId: string; path: string },
): Promise<ToolExecResult<{ files?: unknown; output?: string }>> {
  const { bridge, context } = deps;
  const { sessionId, path } = args;

  const scopeErr = validateSessionScope(context, sessionId);
  if (scopeErr) return { ok: false, error: scopeErr };

  const session = context.sessions.find(s => s.sessionId === sessionId);
  if (!session?.sftpId) {
    // Fallback: use terminal exec with ls
    const result = await bridge.aiExec(sessionId, `ls -la ${shellQuote(path)}`);
    if (!result.ok) {
      return { ok: false, error: result.error || 'Failed to list directory' };
    }
    return { ok: true, data: { output: result.stdout || '(empty directory)' } };
  }

  const files = await bridge.listSftp(session.sftpId, path);
  return { ok: true, data: { files } };
}

export async function executeSftpReadFile(
  deps: ToolDeps,
  args: { sessionId: string; path: string; maxBytes?: number },
): Promise<ToolExecResult<{ content: string }>> {
  const { bridge, context } = deps;
  const { sessionId, path } = args;

  if (!sessionId || !path) {
    return { ok: false, error: 'Missing sessionId or path' };
  }
  const scopeErr = validateSessionScope(context, sessionId);
  if (scopeErr) return { ok: false, error: scopeErr };

  const session = context.sessions.find(s => s.sessionId === sessionId);
  if (!session?.sftpId) {
    const clampedMaxBytes = Math.max(1, Math.min(10 * 1024 * 1024, Number(args.maxBytes) || 10000));
    const result = await bridge.aiExec(sessionId, `head -c ${clampedMaxBytes} ${shellQuote(path)}`);
    if (!result.ok) {
      return { ok: false, error: result.error || 'Failed to read file' };
    }
    return { ok: true, data: { content: result.stdout || '(empty file)' } };
  }

  let content = await bridge.readSftp(session.sftpId, path);
  const maxBytes = Math.max(1, Math.min(10 * 1024 * 1024, Number(args.maxBytes) || 10000));
  if (content && content.length > maxBytes) {
    content = content.slice(0, maxBytes);
  }
  return { ok: true, data: { content: content || '(empty file)' } };
}

export async function executeSftpWriteFile(
  deps: ToolDeps,
  args: { sessionId: string; path: string; content: string },
): Promise<ToolExecResult<{ written: string }>> {
  const { bridge, context, permissionMode } = deps;
  const { sessionId, path, content } = args;

  if (!sessionId || !path) {
    return { ok: false, error: 'Missing sessionId or path' };
  }
  const scopeErr = validateSessionScope(context, sessionId);
  if (scopeErr) return { ok: false, error: scopeErr };
  if (isObserver(permissionMode)) {
    return { ok: false, error: 'Observer mode: file writing is disabled. Switch to Confirm or Auto mode.' };
  }

  const session = context.sessions.find(s => s.sessionId === sessionId);
  if (!session?.sftpId) {
    // Fallback: base64 encoding to avoid heredoc injection
    const b64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(content)))
      : Buffer.from(content, 'utf-8').toString('base64');
    const result = await bridge.aiExec(
      sessionId,
      `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`,
    );
    if (!result.ok) {
      return { ok: false, error: result.error || 'Failed to write file' };
    }
    return { ok: true, data: { written: path } };
  }

  await bridge.writeSftp(session.sftpId, path, content);
  return { ok: true, data: { written: path } };
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
    connected: boolean;
  }>;
}> {
  const { context } = deps;
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
        connected: s.connected,
      })),
    },
  };
}

export function executeWorkspaceGetSessionInfo(
  deps: ToolDeps,
  args: { sessionId: string },
): ToolExecResult<ExecutorContext['sessions'][number]> {
  const { context } = deps;
  const session = context.sessions.find(s => s.sessionId === args.sessionId);
  if (!session) {
    return { ok: false, error: `Session not found: ${args.sessionId}` };
  }
  return { ok: true, data: session };
}

export async function executeMultiHostExecute(
  deps: ToolDeps,
  args: {
    sessionIds: string[];
    command: string;
    mode?: string;
    stopOnError?: boolean;
  },
): Promise<ToolExecResult<{ results: Record<string, { ok: boolean; output: string }> }>> {
  const { bridge, context, commandBlocklist, permissionMode } = deps;
  const { sessionIds, command, mode = 'parallel', stopOnError = false } = args;

  if (sessionIds.length === 0 || !command) {
    return { ok: false, error: 'Missing sessionIds or command' };
  }

  const currentValidIds = validSessionIds(context);
  const outOfScope = sessionIds.filter(sid => !currentValidIds.has(sid));
  if (outOfScope.length > 0) {
    return {
      ok: false,
      error: `Sessions not in current scope: ${outOfScope.join(', ')}. Available sessions: ${[...currentValidIds].join(', ')}`,
    };
  }
  if (isObserver(permissionMode)) {
    return { ok: false, error: 'Observer mode: command execution is disabled. Switch to Confirm or Auto mode.' };
  }
  const safety = checkCommandSafety(command, commandBlocklist);
  if (safety.blocked) {
    return { ok: false, error: `Command blocked by safety policy. Matched pattern: ${safety.matchedPattern}` };
  }

  const results: Record<string, { ok: boolean; output: string }> = {};

  if (mode === 'sequential') {
    for (const sid of sessionIds) {
      const session = context.sessions.find(s => s.sessionId === sid);
      const label = session?.label || sid;
      const result = await bridge.aiExec(sid, command);
      results[label] = {
        ok: result.ok,
        output: result.ok
          ? result.stdout || '(no output)'
          : `Error: ${result.error || result.stderr || 'Failed'}`,
      };
      if (!result.ok && stopOnError) break;
    }
  } else {
    const tasks = sessionIds.map((sid) => () => {
      const session = context.sessions.find(s => s.sessionId === sid);
      const label = session?.label || sid;
      return bridge.aiExec(sid, command).then(result => ({
        label,
        ok: result.ok,
        output: result.ok
          ? result.stdout || '(no output)'
          : `Error: ${result.error || result.stderr || 'Failed'}`,
      }));
    });
    const resolved = await limitConcurrency(tasks, 10);
    for (const r of resolved) {
      results[r.label] = { ok: r.ok, output: r.output };
    }
  }

  return { ok: true, data: { results } };
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
