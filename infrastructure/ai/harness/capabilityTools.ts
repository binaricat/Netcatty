import { tool } from 'ai';
import { z } from 'zod';
import type { ExecutorContext, NetcattyBridge } from '../cattyAgent/executor';
import type { TerminalContextReadRange } from '../../../domain/terminalContextRead';
import type { AIPermissionMode } from '../types';
import type { WebSearchConfig } from '../types';
import { isWebSearchReady } from '../types';
import {
  executeTerminalExecute,
  executeWorkspaceGetInfo,
  executeWorkspaceGetSessionInfo,
  executeWebSearch,
  executeUrlFetch,
  type ToolDeps,
  type ToolExecResult,
} from '../shared/toolExecutors';
import { reserveSessionSlot } from '../shared/sessionExecutionQueue';
import { fitTerminalExecuteResultForModel } from './terminalCompression';
import { fitLargeToolResultForModel } from './toolResultFitting';
import { redactSecretsForModel } from './modelSecretRedaction';
import {
  globalTerminalMonitorGuard,
  isStreamingMonitorCommand,
} from './terminalMonitorGuard';
import type { ToolOutputStore } from './toolOutputStore';
import { TOOL_OUTPUT_READ_MAX_CHARS } from './toolOutputStore';
import {
  buildTerminalWriteFingerprint,
  hashScopeKey,
  hashToolResult,
  previewToolResult,
  type ToolResultDedup,
} from './toolResultDedup';
import cattyToolSpecs from './generated/cattyToolSpecs.json';
import {
  cattyToolContextSchema,
  toolDepsFromContext,
  type CattyToolContext,
} from './cattyRuntimeContext';

type FieldShape = {
  type: string;
  optional?: boolean;
  description?: string;
};

type CattyToolSpec = {
  capabilityId: string;
  toolName: string;
  rpcMethod: string | null;
  localExecution?: boolean;
  description: string;
  inputShape: Record<string, FieldShape>;
  policy: {
    write: boolean;
    bypassesApproval: boolean;
  };
};

export type CattyToolsBundle = {
  tools: Record<string, ReturnType<typeof tool>>;
  toolsContext: Record<string, CattyToolContext>;
};

function buildZodObject(shape: Record<string, FieldShape>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const entries: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    let schema: z.ZodTypeAny = field.type === 'number' ? z.number() : z.string();
    if (field.description) {
      schema = schema.describe(field.description);
    }
    entries[key] = field.optional ? schema.optional() : schema;
  }
  return z.object(entries);
}

function unwrap<T>(r: ToolExecResult<T>): T | { error: string } {
  if (r.ok === false) return { error: r.error };
  return r.data;
}

async function invokeCapabilityRpc(
  bridge: NetcattyBridge & { aiCapability?: (method: string, args: Record<string, unknown>, sessionId?: string) => Promise<unknown> },
  rpcMethod: string,
  args: Record<string, unknown>,
  chatSessionId?: string,
): Promise<unknown> {
  if (bridge.aiCapability) {
    const result = await bridge.aiCapability(rpcMethod, args, chatSessionId);
    if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false) {
      return { error: (result as { error?: string }).error || 'Capability call failed.' };
    }
    return result;
  }
  if (!bridge.invoke) {
    throw new Error(`Capability RPC is not supported by the current bridge (missing invoke and aiCapability).`);
  }
  return await bridge.invoke(`netcatty:plugins:rpc`, {
    method: rpcMethod,
    args,
    chatSessionId,
  });
}

async function tryFetchHostEnvironment(
  bridge: NetcattyBridge,
  chatSessionId?: string,
): Promise<Record<string, unknown> | null> {
  if (!bridge.aiCapability || !chatSessionId) return null;
  try {
    const environment = await invokeCapabilityRpc(
      bridge,
      'netcatty/getContext',
      {},
      chatSessionId,
    );
    if (environment && typeof environment === 'object' && !('error' in environment)) {
      return environment as Record<string, unknown>;
    }
  } catch {
    // IPC failures must not block read-only harness tools.
  }
  return null;
}

function applyToolDedup(
  toolName: string,
  fingerprint: string,
  result: unknown,
  dedup?: ToolResultDedup,
): unknown {
  if (!dedup) return result;
  const cached = dedup.check(fingerprint);
  if (cached) {
    return dedup.buildCachedNotice(cached);
  }
  dedup.remember(toolName, fingerprint, previewToolResult(result));
  return result;
}

function fitCapabilityResultForModel(
  result: unknown,
  spec: CattyToolSpec,
  chatSessionId?: string,
  toolOutputStore?: ToolOutputStore,
  args?: Record<string, unknown>,
  toolResultDedup?: ToolResultDedup,
): unknown {
  if (spec.capabilityId === 'harness.tool_output.read') {
    return result;
  }

  const resultRecord = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : undefined;
  const jobId = typeof args?.jobId === 'string'
    ? args.jobId
    : typeof resultRecord?.jobId === 'string' ? resultRecord.jobId : undefined;
  const terminalSessionId = typeof args?.sessionId === 'string'
    ? args.sessionId
    : typeof resultRecord?.sessionId === 'string'
      ? resultRecord.sessionId
      : jobId ? toolResultDedup?.terminalSessionForJob(jobId) : undefined;

  return fitLargeToolResultForModel({
    result,
    capabilityId: spec.capabilityId,
    chatSessionId,
    toolOutputStore,
    terminalSessionId,
    normalizeStrings: spec.capabilityId.startsWith('terminal.')
      || spec.capabilityId === 'harness.terminal.read_context',
  });
}

export function applyMonitorStopResult(
  poll: Record<string, unknown>,
  stopResult: unknown,
  suppressedCount: number,
): Record<string, unknown> {
  const stopFailed = Boolean(
    stopResult && typeof stopResult === 'object'
    && (
      (stopResult as { ok?: boolean }).ok === false
      || (
        typeof (stopResult as { error?: unknown }).error === 'string'
        && (stopResult as { error: string }).error.trim().length > 0
      )
    ),
  );
  return stopFailed
    ? {
        ...poll,
        output: `[automatic monitor stop failed after sustained overload; ${suppressedCount} batches were suppressed. The job may still be running; poll/stop it explicitly and narrow the command before continuing.]`,
      }
    : {
        ...poll,
        status: 'stopping',
        output: `[monitor stop requested after sustained overload; ${suppressedCount} batches were suppressed. Narrow the command with grep/awk before restarting it.]`,
      };
}

interface LocalExecutionContext {
  deps: ToolDeps;
  spec: CattyToolSpec;
  args: Record<string, unknown>;
  toolOutputStore?: ToolOutputStore;
  toolResultDedup?: ToolResultDedup;
  chatSessionId?: string;
}

async function executeLocalCattyCapability(ctx: LocalExecutionContext): Promise<unknown> {
  const { deps, spec, args, toolOutputStore, toolResultDedup, chatSessionId } = ctx;
  const resolveContext = () => (typeof deps.context === 'function' ? deps.context() : deps.context);

  switch (spec.capabilityId) {
    case 'harness.tool_output.read': {
      const { handleId, mode, maxChars, offset, query } = args as {
        handleId: string;
        mode?: 'head' | 'tail' | 'full' | 'range' | 'search';
        maxChars?: number;
        offset?: number;
        query?: string;
      };
      if (!toolOutputStore || !chatSessionId) {
        return { error: 'Tool output store is unavailable.' };
      }
      const requestedChars = Math.min(
        TOOL_OUTPUT_READ_MAX_CHARS,
        typeof maxChars === 'number' && Number.isFinite(maxChars)
          ? Math.max(1, Math.floor(maxChars))
          : TOOL_OUTPUT_READ_MAX_CHARS,
      );
      const grantedChars = toolResultDedup
        ? toolResultDedup.takeBudget('tool-output-read', requestedChars, TOOL_OUTPUT_READ_MAX_CHARS * 2)
        : requestedChars;
      if (grantedChars <= 0) {
        return {
          error: `This turn has reached its ${TOOL_OUTPUT_READ_MAX_CHARS * 2}-character saved-output read budget. Continue in the next turn or narrow the search.`,
        };
      }
      const result = await toolOutputStore.readChunkAsync(
        { handleId, mode, maxChars: grantedChars, offset, query },
        chatSessionId,
      );
      if (result == null) {
        return { error: `Handle "${handleId}" was not found for this chat session.` };
      }
      return { ...result, content: redactSecretsForModel(result.content) };
    }
    case 'harness.workspace.get_info': {
      const scopeCtx = resolveContext();
      const fingerprint = toolResultDedup?.fingerprintFor(
        spec.toolName,
        hashScopeKey([chatSessionId, scopeCtx.workspaceId, String(scopeCtx.sessions?.length ?? 0)]),
      );
      const local = executeWorkspaceGetInfo(deps);
      if (local.ok === false) {
        return unwrap(local);
      }
      let merged: unknown = local.data;
      const environment = await tryFetchHostEnvironment(deps.bridge, chatSessionId);
      if (environment) {
        const hosts = Array.isArray(environment.hosts)
          ? (environment.hosts as Array<Record<string, unknown>>)
          : [];
        const hostBySessionId = new Map(hosts.map((host) => [String(host.sessionId), host]));
        merged = {
          ...local.data,
          sessions: local.data.sessions.map((session) => ({
            ...session,
            ...(hostBySessionId.get(session.sessionId) ?? {}),
          })),
          activePortForwardTunnels: environment.activePortForwardTunnels,
        };
      }
      if (fingerprint) {
        return applyToolDedup(spec.toolName, fingerprint, merged, toolResultDedup);
      }
      return merged;
    }
    case 'harness.workspace.get_session_info': {
      const { sessionId } = args as { sessionId: string };
      const local = executeWorkspaceGetSessionInfo(deps, { sessionId });
      if (local.ok === false) {
        return unwrap(local);
      }
      const environment = await tryFetchHostEnvironment(deps.bridge, chatSessionId);
      if (environment) {
        const hosts = Array.isArray(environment.hosts)
          ? (environment.hosts as Array<Record<string, unknown>>)
          : [];
        const match = hosts.find((host) => String(host.sessionId) === sessionId);
        if (match) {
          return { ...local.data, ...match };
        }
      }
      return local.data;
    }
    case 'harness.terminal.read_context': {
      const scopeCtx = resolveContext();
      const sessions = scopeCtx.sessions ?? [];
      const requestedSessionId = typeof args.sessionId === 'string' && args.sessionId.trim()
        ? args.sessionId.trim()
        : undefined;
      const sessionId = requestedSessionId
        ?? (sessions.length === 1 ? sessions[0].sessionId : undefined);

      if (!sessionId) {
        return {
          ok: false,
          error: 'sessionId is required because the current AI scope contains multiple terminal sessions.',
        };
      }

      const session = sessions.find((entry) => entry.sessionId === sessionId);
      if (!session) {
        return {
          ok: false,
          error: `Terminal session "${sessionId}" is not in the current AI scope.`,
        };
      }

      if (!scopeCtx.readTerminalContext) {
        return {
          ok: false,
          error: 'Terminal context reader is unavailable for this AI scope.',
        };
      }

      const result = await scopeCtx.readTerminalContext({
        sessionId,
        range: typeof args.range === 'string' ? args.range as TerminalContextReadRange : undefined,
        startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
        maxLines: typeof args.maxLines === 'number' ? args.maxLines : undefined,
      });
      if (result.ok === false) return result;
      const normalizedResult = result;
      const fingerprint = toolResultDedup?.fingerprintFor(
        spec.toolName,
        hashScopeKey([
          sessionId,
          String(normalizedResult.startLine),
          String(normalizedResult.endLine),
          normalizedResult.range,
          hashToolResult(normalizedResult.content),
        ]),
      );
      return fingerprint
        ? applyToolDedup(spec.toolName, fingerprint, normalizedResult, toolResultDedup)
        : normalizedResult;
    }
    case 'harness.web.search': {
      const { query, maxResults } = args as { query: string; maxResults?: number };
      return unwrap(await executeWebSearch(deps, { query, maxResults }));
    }
    case 'harness.url.fetch': {
      const { url, maxLength } = args as { url: string; maxLength?: number };
      const fingerprint = toolResultDedup?.fingerprintFor(spec.toolName, url);
      const raw = unwrap(await executeUrlFetch(deps, { url, maxLength }));
      if (fingerprint) {
        return applyToolDedup(spec.toolName, fingerprint, raw, toolResultDedup);
      }
      return raw;
    }
    default:
      return { error: `No local executor registered for "${spec.capabilityId}".` };
  }
}

function resolveSessionQueueKey(
  spec: CattyToolSpec,
  args: Record<string, unknown>,
  chatSessionId?: string,
): string | null {
  if (spec.capabilityId.startsWith('harness.') && !spec.policy.write) {
    return null;
  }

  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
  if (sessionId) {
    return `${chatSessionId ?? 'global'}:${sessionId}`;
  }
  return `${chatSessionId ?? 'global'}:${spec.toolName}`;
}

export function resolveSessionQueueKeyForTests(
  spec: Pick<CattyToolSpec, 'capabilityId' | 'toolName' | 'policy'>,
  args: Record<string, unknown>,
  chatSessionId?: string,
): string | null {
  return resolveSessionQueueKey(spec as CattyToolSpec, args, chatSessionId);
}

function createCatalogTool(spec: CattyToolSpec) {
  const inputSchema = buildZodObject(spec.inputShape);

  return tool({
    description: spec.description,
    inputSchema,
    contextSchema: cattyToolContextSchema,
    execute: async (args, { toolCallId: _toolCallId, abortSignal, context }) => {
      const toolContext = context as CattyToolContext;
      const deps = toolDepsFromContext(toolContext);
      const { toolOutputStore, toolResultDedup } = toolContext;

      const queueKey = resolveSessionQueueKey(
        spec,
        args as Record<string, unknown>,
        deps.chatSessionId,
      );
      const slot = queueKey ? reserveSessionSlot(queueKey) : null;

      try {
        const result = await (async () => {
        if (abortSignal?.aborted) {
          return { error: 'Tool call cancelled before it could start.' };
        }

        await slot?.ready;

        if (spec.capabilityId === 'terminal.execute') {
          const { sessionId: sid, command } = args as { sessionId: string; command: string };
          const writeFingerprint = buildTerminalWriteFingerprint(
            'terminal_execute',
            deps.chatSessionId,
            { sessionId: sid, command },
          );
          const replay = writeFingerprint
            ? toolResultDedup?.replayCompletedWrite(writeFingerprint)
            : undefined;
          if (replay !== undefined) {
            return {
              ...(typeof replay === 'object' && replay !== null ? replay : { result: replay }),
              replayedCompletedResult: true,
              note: 'The command already executed before request compaction; its recorded result was replayed and the command was not executed again.',
            };
          }
          const cancelOnAbort = () => {
            if (deps.chatSessionId) {
              void deps.bridge.aiCattyCancelExec?.(deps.chatSessionId);
            }
          };
          abortSignal?.addEventListener('abort', cancelOnAbort, { once: true });
          try {
            const result = await executeTerminalExecute(deps, { sessionId: sid, command });
            if (result.ok === false) {
              if (!result.data) return unwrap(result);
              const fittedFailure = {
                error: fitLargeToolResultForModel({
                  result: result.error,
                  capabilityId: 'terminal.execute.error',
                  chatSessionId: deps.chatSessionId,
                  toolOutputStore,
                  terminalSessionId: sid,
                  normalizeStrings: true,
                }),
                ...fitTerminalExecuteResultForModel({
                  ...result.data,
                  command,
                  sessionId: sid,
                }, {
                  chatSessionId: deps.chatSessionId,
                  toolOutputStore,
                }),
              };
              if (writeFingerprint) toolResultDedup?.rememberCompletedWrite(writeFingerprint, fittedFailure);
              return fittedFailure;
            }
            const fitted = fitTerminalExecuteResultForModel({
              ...result.data,
              command,
              sessionId: sid,
            }, {
              chatSessionId: deps.chatSessionId,
              toolOutputStore,
            });
            if (writeFingerprint) toolResultDedup?.rememberCompletedWrite(writeFingerprint, fitted);
            return fitted;
          } finally {
            abortSignal?.removeEventListener('abort', cancelOnAbort);
          }
        }

        if (spec.localExecution || spec.capabilityId.startsWith('harness.')) {
          const result = await executeLocalCattyCapability({
            deps,
            spec,
            args: args as Record<string, unknown>,
            toolOutputStore,
            toolResultDedup,
            chatSessionId: deps.chatSessionId,
          });
          return fitCapabilityResultForModel(
            result,
            spec,
            deps.chatSessionId,
            toolOutputStore,
            args as Record<string, unknown>,
            toolResultDedup,
          );
        }

        if (!spec.rpcMethod) {
          return { error: `Capability "${spec.capabilityId}" has no RPC binding.` };
        }

        const terminalStartFingerprint = spec.capabilityId === 'terminal.start'
          ? buildTerminalWriteFingerprint(
              'terminal_start',
              deps.chatSessionId,
              args as { sessionId?: unknown; command?: unknown },
            )
          : undefined;
        const terminalStartReplay = terminalStartFingerprint
          ? toolResultDedup?.replayCompletedWrite(terminalStartFingerprint)
          : undefined;
        if (terminalStartReplay !== undefined) {
          return {
            ...(typeof terminalStartReplay === 'object' && terminalStartReplay !== null
              ? terminalStartReplay
              : { result: terminalStartReplay }),
            replayedCompletedResult: true,
            note: 'The background command already started before request compaction; its recorded job was replayed and no second job was created.',
          };
        }

        let raw = await invokeCapabilityRpc(
          deps.bridge,
          spec.rpcMethod,
          args as Record<string, unknown>,
          deps.chatSessionId,
        );
        if (
          spec.capabilityId === 'terminal.start'
          && raw && typeof raw === 'object'
          && typeof (raw as { jobId?: unknown }).jobId === 'string'
          && typeof (args as { sessionId?: unknown }).sessionId === 'string'
        ) {
          toolResultDedup?.rememberTerminalJobSession(
            (raw as { jobId: string }).jobId,
            (args as { sessionId: string }).sessionId,
          );
        }

        if (
          spec.capabilityId === 'terminal.poll'
          && raw
          && typeof raw === 'object'
          && (raw as { ok?: boolean }).ok !== false
        ) {
          let poll = raw as Record<string, unknown>;
          const monitorKey = `${deps.chatSessionId ?? 'global'}:${String(poll.jobId ?? args.jobId ?? '')}`;
          if (
            isStreamingMonitorCommand(poll.command)
            && typeof poll.output === 'string'
            && poll.output.trim().length > 0
          ) {
            const guarded = globalTerminalMonitorGuard.process(monitorKey, poll.output);
            if (guarded.action === 'stop') {
              const stopResult = await invokeCapabilityRpc(
                deps.bridge,
                'netcatty/jobStop',
                { jobId: poll.jobId ?? args.jobId },
                deps.chatSessionId,
              );
              poll = applyMonitorStopResult(poll, stopResult, guarded.suppressedCount);
            } else if (guarded.action === 'suppress') {
              poll = {
                ...poll,
                output: `[monitor batch suppressed by rate limit; suppressed=${guarded.suppressedCount}]`,
              };
            } else {
              let output = guarded.content;
              if (guarded.sourceTruncated && toolOutputStore && deps.chatSessionId) {
                const jobId = String(poll.jobId ?? args.jobId ?? '');
                const handle = toolOutputStore.store({
                  chatSessionId: deps.chatSessionId,
                  capabilityId: 'terminal.poll.monitor-batch',
                  content: poll.output,
                  sessionId: jobId ? toolResultDedup?.terminalSessionForJob(jobId) : undefined,
                });
                output += [
                  '',
                  `[monitor batch archived before shortening: rawChars=${poll.output.length} handleId=${handle.id}]`,
                  'Use tool_output_read with this handleId to search/read omitted details; the terminal nextOffset already advances past the raw batch.',
                  'This saved output is available only until the app closes. Read this handle before closing the app.',
                ].join('\n');
              }
              poll = { ...poll, output };
            }
          }
          if (poll.status !== 'running' && poll.status !== 'stopping') {
            globalTerminalMonitorGuard.clear(monitorKey);
          }
          raw = poll;
          const fingerprint = toolResultDedup?.fingerprintFor(
            spec.toolName,
            hashScopeKey([
              String(poll.jobId ?? args.jobId ?? ''),
              String(poll.outputBaseOffset ?? ''),
              String(poll.nextOffset ?? ''),
              String(poll.status ?? ''),
              hashToolResult(poll.output ?? ''),
            ]),
          );
          if (fingerprint) {
            return fitCapabilityResultForModel(
              applyToolDedup(spec.toolName, fingerprint, poll, toolResultDedup),
              spec,
              deps.chatSessionId,
              toolOutputStore,
              args as Record<string, unknown>,
              toolResultDedup,
            );
          }
        }

        if (spec.toolName === 'get_environment' || spec.capabilityId === 'session.environment') {
          const ctx = typeof deps.context === 'function' ? deps.context() : deps.context;
          const fingerprint = toolResultDedup?.fingerprintFor(
            spec.toolName,
            hashScopeKey([deps.chatSessionId, ctx.workspaceId, String(ctx.sessions?.length ?? 0)]),
          );
          if (fingerprint) {
            return fitCapabilityResultForModel(
              applyToolDedup(spec.toolName, fingerprint, raw, toolResultDedup),
              spec,
              deps.chatSessionId,
              toolOutputStore,
              args as Record<string, unknown>,
              toolResultDedup,
            );
          }
        }

        if (spec.capabilityId.includes('sftp') && spec.capabilityId.includes('read')) {
          const { sessionId: sid, path } = args as { sessionId?: string; path?: string };
          const fingerprint = toolResultDedup?.fingerprintFor(
            spec.toolName,
            hashScopeKey([sid, path]),
          );
          if (fingerprint) {
            return fitCapabilityResultForModel(
              applyToolDedup(spec.toolName, fingerprint, raw, toolResultDedup),
              spec,
              deps.chatSessionId,
              toolOutputStore,
              args as Record<string, unknown>,
              toolResultDedup,
            );
          }

          if (
            raw
            && typeof raw === 'object'
            && 'content' in raw
            && toolOutputStore
            && deps.chatSessionId
          ) {
            const content = String((raw as { content?: string }).content ?? '');
            const MAX_LIVE_SFTP_READ_CHARS = 24_000;
            if (content.length > MAX_LIVE_SFTP_READ_CHARS) {
              const handle = toolOutputStore.store({
                chatSessionId: deps.chatSessionId,
                capabilityId: spec.capabilityId,
                content,
                sessionId: sid,
              });
              return {
                ok: true,
                path: (raw as { path?: string }).path ?? path,
                preview: handle.preview,
                totalChars: handle.totalChars,
                handleId: handle.id,
                note: 'Full file content is available only until the app closes. Use tool_output_read now.',
              };
            }
          }
        }

        const fittedRaw = fitCapabilityResultForModel(
          raw,
          spec,
          deps.chatSessionId,
          toolOutputStore,
          args as Record<string, unknown>,
          toolResultDedup,
        );
        if (
          terminalStartFingerprint
          && raw && typeof raw === 'object'
          && (raw as { ok?: boolean }).ok !== false
          && typeof (raw as { jobId?: unknown }).jobId === 'string'
        ) {
          toolResultDedup?.rememberCompletedWrite(terminalStartFingerprint, fittedRaw);
        }
        return fittedRaw;
        })();
        if (toolOutputStore && deps.chatSessionId) {
          await toolOutputStore.flush(deps.chatSessionId);
          return toolOutputStore.resolveRestartPersistenceNotices(result, deps.chatSessionId);
        }
        return result;
      } finally {
        slot?.release();
      }
    },
  });
}

export function buildCattyToolContext(input: {
  bridge: NetcattyBridge;
  context: ToolDeps['context'];
  commandBlocklist?: string[];
  permissionMode: AIPermissionMode;
  webSearchConfig?: WebSearchConfig;
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  toolResultDedup?: ToolResultDedup;
}): CattyToolContext {
  return {
    bridge: input.bridge,
    chatSessionId: input.chatSessionId,
    permissionMode: input.permissionMode,
    commandBlocklist: input.commandBlocklist,
    webSearchConfig: input.webSearchConfig,
    getExecutorContext: typeof input.context === 'function'
      ? input.context as () => ExecutorContext
      : () => input.context as ExecutorContext,
    toolOutputStore: input.toolOutputStore,
    toolResultDedup: input.toolResultDedup,
  };
}

export function createCattyToolsFromCatalog(
  bridge: NetcattyBridge,
  context: ToolDeps['context'],
  commandBlocklist?: string[],
  permissionMode: AIPermissionMode = 'confirm',
  webSearchConfig?: WebSearchConfig,
  chatSessionId?: string,
  toolOutputStore?: ToolOutputStore,
  toolResultDedup?: ToolResultDedup,
): CattyToolsBundle {
  const sharedContext = buildCattyToolContext({
    bridge,
    context,
    commandBlocklist,
    permissionMode,
    webSearchConfig,
    chatSessionId,
    toolOutputStore,
    toolResultDedup,
  });

  const catalogTools: Record<string, ReturnType<typeof tool>> = {};
  const toolsContext: Record<string, CattyToolContext> = {};

  for (const rawSpec of cattyToolSpecs as CattyToolSpec[]) {
    if (rawSpec.capabilityId === 'harness.web.search' && !isWebSearchReady(webSearchConfig)) {
      continue;
    }
    catalogTools[rawSpec.toolName] = createCatalogTool(rawSpec);
    toolsContext[rawSpec.toolName] = sharedContext;
  }

  return { tools: catalogTools, toolsContext };
}

/** Test helper: attach shared context when calling tool.execute directly. */
export function withCattyToolContext<T extends { execute: (...args: never[]) => unknown }>(
  toolInstance: T,
  context: CattyToolContext,
  toolCallId = 'test-call',
): T {
  const original = toolInstance.execute.bind(toolInstance);
  return {
    ...toolInstance,
    execute: (input: Parameters<T['execute']>[0], options?: Partial<Parameters<T['execute']>[1]>) =>
      original(input, {
        toolCallId,
        messages: [],
        ...options,
        context,
      } as Parameters<T['execute']>[1]),
  } as T;
}

export { tryFetchHostEnvironment };
