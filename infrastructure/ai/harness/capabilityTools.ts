import { tool } from 'ai';
import { z } from 'zod';
import type { NetcattyBridge } from '../cattyAgent/executor';
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
import type { ToolOutputStore } from './toolOutputStore';
import {
  hashScopeKey,
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
  bridge: NetcattyBridge,
  rpcMethod: string,
  params: Record<string, unknown>,
  chatSessionId?: string,
): Promise<unknown> {
  if (!bridge.aiCapability) {
    return { error: 'Capability bridge is unavailable in this environment.' };
  }
  const result = await bridge.aiCapability(rpcMethod, params, chatSessionId);
  if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok === false) {
    return { error: (result as { error?: string }).error || 'Capability call failed.' };
  }
  return result;
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
): unknown {
  if (spec.capabilityId === 'harness.tool_output.read') {
    return result;
  }

  return fitLargeToolResultForModel({
    result,
    capabilityId: spec.capabilityId,
    chatSessionId,
    toolOutputStore,
  });
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
      const { handleId, mode, maxChars } = args as {
        handleId: string;
        mode?: 'head' | 'tail' | 'full';
        maxChars?: number;
      };
      if (!toolOutputStore || !chatSessionId) {
        return { error: 'Tool output store is unavailable.' };
      }
      const content = toolOutputStore.read({ handleId, mode, maxChars }, chatSessionId);
      if (content == null) {
        return { error: `Handle "${handleId}" was not found for this chat session.` };
      }
      return { handleId, mode: mode ?? 'head', content };
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

      return scopeCtx.readTerminalContext({
        sessionId,
        range: typeof args.range === 'string' ? args.range as TerminalContextReadRange : undefined,
        startLine: typeof args.startLine === 'number' ? args.startLine : undefined,
        maxLines: typeof args.maxLines === 'number' ? args.maxLines : undefined,
      });
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
        if (abortSignal?.aborted) {
          return { error: 'Tool call cancelled before it could start.' };
        }

        await slot?.ready;

        if (spec.capabilityId === 'terminal.execute') {
          const { sessionId: sid, command } = args as { sessionId: string; command: string };
          const cancelOnAbort = () => {
            if (deps.chatSessionId) {
              void deps.bridge.aiCattyCancelExec?.(deps.chatSessionId);
            }
          };
          abortSignal?.addEventListener('abort', cancelOnAbort, { once: true });
          try {
            const result = await executeTerminalExecute(deps, { sessionId: sid, command });
            if (result.ok === false) return unwrap(result);
            return fitTerminalExecuteResultForModel({
              ...result.data,
              command,
              sessionId: sid,
            }, {
              chatSessionId: deps.chatSessionId,
              toolOutputStore,
            });
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
          return fitCapabilityResultForModel(result, spec, deps.chatSessionId, toolOutputStore);
        }

        if (!spec.rpcMethod) {
          return { error: `Capability "${spec.capabilityId}" has no RPC binding.` };
        }

        const raw = await invokeCapabilityRpc(
          deps.bridge,
          spec.rpcMethod,
          args as Record<string, unknown>,
          deps.chatSessionId,
        );

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
                note: 'Full file content stored. Use tool_output_read with this handleId to read more.',
              };
            }
          }
        }

        return fitCapabilityResultForModel(raw, spec, deps.chatSessionId, toolOutputStore);
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
      ? input.context
      : () => input.context,
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
