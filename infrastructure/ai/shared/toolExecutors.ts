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
import { checkCommandSafety, checkCommandSafetyCommonOnly } from '../cattyAgent/safety';
import { executeWebSearchProvider } from './webSearchProviders';

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/** Discriminated union returned by every shared executor. */
export type ToolExecResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; data?: T; code?: string };

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

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

export async function executeTerminalExecute(
  deps: ToolDeps,
  args: { sessionId: string; command: string },
): Promise<ToolExecResult<{ stdout: string; stderr: string; exitCode: number | null }>> {
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
  // Shell blocklist is meaningless on network device CLIs (e.g. "shutdown"
  // disables an interface on Cisco). Skip for serial and network device sessions.
  // The bridge layer (handleExec / netcatty:ai:exec) also has its own session-aware check.
  const resolved = resolveContext(context);
  const targetSession = resolved.sessions.find(s => s.sessionId === sessionId);
  const proto = targetSession?.protocol || '';
  const isSshOrSerial = proto === 'ssh' || proto === 'serial';
  const isNetworkDevice = proto === 'serial' || (targetSession?.deviceType === 'network' && isSshOrSerial);
  if (!isNetworkDevice) {
    // Remote renderer metadata often has no shell type until the main/worker
    // process probes the live session. Pre-filter user/common rules here and
    // defer shell-specific defaults to that authoritative live check.
    const safety = targetSession?.shellType
      ? checkCommandSafety(command, commandBlocklist, targetSession.shellType)
      : checkCommandSafetyCommonOnly(command, commandBlocklist);
    if (safety.blocked) {
      return { ok: false, error: `Command blocked by safety policy. Matched pattern: ${safety.matchedPattern}` };
    }
  }

  const result = await bridge.aiExec(sessionId, command, deps.chatSessionId);
  // Real execution failures (timeout, disconnect, no stream) have an `error` field.
  // Propagate `code` so consumers can distinguish an actionable, non-terminal
  // SHELL_READINESS_UNKNOWN from a fatal error (#4195).
  if (!result.ok && result.error) {
    return {
      ok: false,
      error: result.error,
      code: result.code,
      data: {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: isNetworkDevice ? (result.exitCode ?? null) : (result.exitCode ?? -1),
      },
    };
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

export interface VendorAssistantAnswer {
  ok: boolean;
  vendor: string;
  name: string;
  status: string;
  text: string;
  url: string;
  elapsedMs: number;
  error: string | null;
  /** Set when the vendor declined to answer and web results were substituted. */
  fallback?: 'web_search';
  sources?: Array<{ title: string; url: string }>;
}

// Vendor assistants sometimes hand the question off to a human and return no
// answer at all. Those statuses are safe to backfill with an ordinary web
// search so the agent still has something grounded to work from.
const VENDOR_FALLBACK_STATUSES = new Set(['no_answer']);

function formatWebFallback(
  vendorName: string,
  question: string,
  results: Array<{ title: string; url: string; content: string }>,
): { text: string; sources: Array<{ title: string; url: string }> } {
  const body = results
    .map((result, index) => {
      const snippet = result.content.replace(/\s+/g, ' ').trim().slice(0, 400);
      return `${index + 1}. ${result.title}\n   ${result.url}\n   ${snippet}`;
    })
    .join('\n\n');
  return {
    text: `${vendorName} handed this question to a human agent and returned no answer, so these web search results are provided instead:\n\n${body}`,
    sources: results.map(result => ({ title: result.title, url: result.url })),
  };
}

function vendorBridgeCall<T>(bridge: ToolDeps['bridge'], method: string, args: unknown[]): Promise<T> | null {
  const fn = (bridge as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> | undefined)?.[method];
  if (typeof fn !== 'function') return null;
  return fn.apply(bridge, args) as Promise<T>;
}

export async function executeVendorAssistantAsk(
  deps: ToolDeps,
  args: { vendor: string; question: string; timeoutMs?: number },
): Promise<ToolExecResult<VendorAssistantAnswer>> {
  const bridge = deps.bridge as unknown as Record<string, unknown>;
  const call = vendorBridgeCall<VendorAssistantAnswer>(bridge as never, 'aiVendorAssistantAsk', [
    args.vendor,
    args.question,
    args.timeoutMs,
  ]);
  if (!call) {
    return { ok: false, error: 'Vendor assistant is not available in this build' };
  }
  if (!args.vendor?.trim()) return { ok: false, error: 'Missing vendor key' };
  if (!args.question?.trim()) return { ok: false, error: 'Missing question' };

  try {
    const answer = await call;
    if (!answer || typeof answer !== 'object') {
      return { ok: false, error: 'Vendor assistant returned no response' };
    }
    if (answer.ok && answer.text?.trim()) {
      return { ok: true, data: answer };
    }

    // A vendor-side hand-off leaves the agent with nothing, so transparently
    // replace it with web results instead of failing the whole call.
    if (VENDOR_FALLBACK_STATUSES.has(String(answer.status))) {
      const search = await executeWebSearch(deps, { query: args.question });
      // The result is a discriminated union, but the boolean-literal narrowing
      // is not reliable across the async boundary, so read the message once.
      const searchError = (search as { error?: string }).error;
      let why = 'no web results';
      if (!search.ok) why = searchError || 'search failed';
      if (!search.ok || search.data.results.length === 0) {
        return {
          ok: false,
          error: `${answer.name || args.vendor} did not answer (${answer.status || 'error'}): ${answer.error || answer.status}. Web search fallback also failed: ${why}`,
        };
      }
      const fallback = formatWebFallback(answer.name || args.vendor, args.question, search.data.results);
      return {
        ok: true,
        data: {
          ...answer,
          text: fallback.text,
          fallback: 'web_search',
          sources: fallback.sources,
        },
      };
    }

    const reason = answer.error || answer.status || 'unknown error';
    return {
      ok: false,
      error: `${answer.name || args.vendor} did not answer (${answer.status || 'error'}): ${reason}`,
    };
  } catch (err) {
    return { ok: false, error: `Vendor assistant failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function executeVendorAssistantList(
  deps: ToolDeps,
): Promise<ToolExecResult<{ vendors: Array<{ key: string; name: string; login: string }> }>> {
  const call = vendorBridgeCall<{ ok: boolean; vendors?: Array<{ key: string; name: string; login: string }>; error?: string }>(
    deps.bridge as never,
    'aiVendorAssistantStatus',
    [],
  );
  if (!call) {
    return { ok: false, error: 'Vendor assistant is not available in this build' };
  }
  try {
    const status = await call;
    if (!status?.ok) {
      return { ok: false, error: status?.error || 'Vendor assistant status is unavailable' };
    }
    return { ok: true, data: { vendors: status.vendors ?? [] } };
  } catch (err) {
    return { ok: false, error: `Vendor assistant status failed: ${err instanceof Error ? err.message : String(err)}` };
  }
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
