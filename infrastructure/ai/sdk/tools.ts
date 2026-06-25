import { tool } from 'ai';
import { z } from 'zod';
import type { NetcattyBridge } from '../cattyAgent/executor';
import type { AIPermissionMode } from '../types';
import type { WebSearchConfig } from '../types';
import { isWebSearchReady } from '../types';
import {
  executeTerminalExecute,
  executeTerminalPoll,
  executeTerminalStart,
  executeTerminalStop,
  executeWorkspaceGetInfo,
  executeWorkspaceGetSessionInfo,
  executeWebSearch,
  executeUrlFetch,
  type ToolDeps,
  type ToolExecResult,
} from '../shared/toolExecutors';
import { requestApproval } from '../shared/approvalGate';
import { reserveSessionSlot } from '../shared/sessionExecutionQueue';
import { truncateTextWithHeadAndTail } from '../requestPayloadCompression';

const MAX_LIVE_TERMINAL_STDOUT_CHARS = 24_000;
const MAX_LIVE_TERMINAL_STDERR_CHARS = 12_000;
const MAX_LIVE_TERMINAL_JOB_OUTPUT_CHARS = 24_000;

/** Unwrap a shared ToolExecResult into the shape expected by Vercel AI SDK tool results. */
function unwrap<T>(r: ToolExecResult<T>): T | { error: string } {
  if (r.ok === false) return { error: r.error };
  return r.data;
}

export function fitTerminalExecuteResultForModel(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): { stdout: string; stderr: string; exitCode: number | null } {
  return {
    ...result,
    stdout: truncateTextWithHeadAndTail(result.stdout, MAX_LIVE_TERMINAL_STDOUT_CHARS),
    stderr: truncateTextWithHeadAndTail(result.stderr, MAX_LIVE_TERMINAL_STDERR_CHARS),
  };
}

export function fitTerminalJobResultForModel<T extends { output: string }>(result: T): T {
  return {
    ...result,
    output: truncateTextWithHeadAndTail(result.output, MAX_LIVE_TERMINAL_JOB_OUTPUT_CHARS),
  };
}

/**
 * Create Catty Agent tools using the Vercel AI SDK `tool()` helper with zod schemas.
 *
 * @param bridge  - The Electron IPC bridge for executing operations
 * @param context - Workspace/session context available to the agent
 * @param commandBlocklist - Optional command blocklist patterns for safety checks
 * @param permissionMode - Permission mode for tool execution gating
 */
export function createCattyTools(
  bridge: NetcattyBridge,
  context: ToolDeps['context'],
  commandBlocklist?: string[],
  permissionMode: AIPermissionMode = 'confirm',
  webSearchConfig?: WebSearchConfig,
  chatSessionId?: string,
) {
  const deps: ToolDeps = { bridge, context, commandBlocklist, permissionMode, webSearchConfig, chatSessionId };

  return {
    terminal_execute: tool({
      description:
        'Execute a short shell command on the specified terminal session and wait for completion. ' +
        "Use terminal_start for builds, watch commands, log-following, or commands likely to run longer than about 60 seconds.",
      inputSchema: z.object({
        sessionId: z.string().describe('The terminal session ID to execute the command on.'),
        command: z.string().describe('The shell command to execute in the target session.'),
      }),
      // No needsApproval — approval is handled inside execute via the approval gate.
      execute: async ({ sessionId, command }, { toolCallId, abortSignal }) => {
        // Snap our place in the per-session execution queue *first*,
        // synchronously, so the eventual command-run order matches the
        // LLM's tool_use emission order regardless of how long each
        // call's approval prompt takes to settle. Vercel AI SDK
        // dispatches every tool_use block in a turn through
        // `Promise.all(...)`, so the three executes for "A then B then
        // C" all start at the same instant; if we deferred slot
        // reservation until after approval, B's approval could land
        // first and run B before A. Reserving up front fixes that.
        //
        // The bridge-side mutex (mcpServerBridge.reserveSessionExecution)
        // stays as defense-in-depth for non-LLM IPC paths
        // (terminal_start, MCP, etc.) — this queue just keeps the
        // renderer-side LLM path from racing into it.
        const queueKey = `${chatSessionId ?? 'global'}:${sessionId}`;
        const slot = reserveSessionSlot(queueKey);
        try {
          // In confirm mode, await user approval. Approvals run *while*
          // the slot is held but before the serialized work, so multiple
          // parallel tool_use blocks each surface their own approval
          // card immediately and the user can approve/deny in any
          // order — the queue still drains in reservation order.
          if (permissionMode === 'confirm') {
            const approved = await requestApproval(toolCallId, 'terminal_execute', { sessionId, command }, chatSessionId);
            if (!approved) {
              return { error: 'User denied command execution.' };
            }
          }
          if (abortSignal?.aborted) {
            return { error: 'Command cancelled before it could start.' };
          }
          await slot.ready;
          if (abortSignal?.aborted) {
            return { error: 'Command cancelled before it could start.' };
          }
          // There's a tiny race between this check and the main-process
          // `mcpServerBridge.reserveSessionExecution` registering the new
          // exec into the cancellation tracker: `handleStop` issues a
          // cancel IPC and the user's abort signal fires, but if our
          // `aiExec` IPC was already in transit, the cancel may run
          // before the exec has registered — and find nothing to
          // cancel. Re-issue the cancel from the abort listener so a
          // duplicate `aiCattyCancelExec` lands once the registration
          // is complete. The cancel is idempotent (it only acts on
          // entries it finds in `activePtyExecs`), so issuing twice is
          // harmless.
          const cancelOnAbort = () => {
            if (chatSessionId) {
              void bridge.aiCattyCancelExec?.(chatSessionId);
            }
          };
          abortSignal?.addEventListener('abort', cancelOnAbort, { once: true });
          try {
            const result = await executeTerminalExecute(deps, { sessionId, command });
            if (result.ok === false) return unwrap(result);
            return fitTerminalExecuteResultForModel(result.data);
          } finally {
            abortSignal?.removeEventListener('abort', cancelOnAbort);
          }
        } finally {
          slot.release();
        }
      },
    }),

    terminal_start: tool({
      description:
        'Start a long-running command on the specified terminal session without waiting for completion. ' +
        'Use this for builds, scans, watch commands, log-following, or anything likely to stream output for an extended period. ' +
        'After starting, use terminal_poll with the returned jobId and nextOffset values, and use terminal_stop to interrupt it.',
      inputSchema: z.object({
        sessionId: z.string().describe('The terminal session ID to execute the long-running command on.'),
        command: z.string().describe('The shell command to start in the target session.'),
      }),
      execute: async ({ sessionId, command }, { toolCallId, abortSignal }) => {
        const queueKey = `${chatSessionId ?? 'global'}:${sessionId}`;
        const slot = reserveSessionSlot(queueKey);
        try {
          if (permissionMode === 'confirm') {
            const approved = await requestApproval(toolCallId, 'terminal_start', { sessionId, command }, chatSessionId);
            if (!approved) {
              return { error: 'User denied command execution.' };
            }
          }
          if (abortSignal?.aborted) {
            return { error: 'Command cancelled before it could start.' };
          }
          await slot.ready;
          if (abortSignal?.aborted) {
            return { error: 'Command cancelled before it could start.' };
          }
          return unwrap(await executeTerminalStart(deps, { sessionId, command }));
        } finally {
          slot.release();
        }
      },
    }),

    terminal_poll: tool({
      description:
        'Poll a long-running terminal job that was started with terminal_start. ' +
        'Returns incremental output since the provided offset plus status, completion, nextOffset, and truncation metadata. ' +
        'Do not poll aggressively; normally wait roughly 30 seconds between polls unless the output justifies checking sooner.',
      inputSchema: z.object({
        jobId: z.string().describe('The background job ID returned by terminal_start.'),
        offset: z
          .number()
          .optional()
          .default(0)
          .describe('The output offset to resume from. Use the previous terminal_poll nextOffset value.'),
      }),
      execute: async ({ jobId, offset }) => {
        const result = await executeTerminalPoll(deps, { jobId, offset });
        if (result.ok === false) return unwrap(result);
        return fitTerminalJobResultForModel(result.data);
      },
    }),

    terminal_stop: tool({
      description:
        'Stop a long-running terminal job that was started with terminal_start. ' +
        'This sends an interrupt to the visible terminal job and returns the latest job state and output.',
      inputSchema: z.object({
        jobId: z.string().describe('The background job ID returned by terminal_start.'),
      }),
      execute: async ({ jobId }) => {
        const result = await executeTerminalStop(deps, { jobId });
        if (result.ok === false) return unwrap(result);
        return fitTerminalJobResultForModel(result.data);
      },
    }),

    workspace_get_info: tool({
      description:
        'Get information about the current workspace, including all terminal sessions ' +
        'and their connection status. No parameters required.',
      inputSchema: z.object({}),
      execute: async () => {
        return unwrap(executeWorkspaceGetInfo(deps));
      },
    }),

    workspace_get_session_info: tool({
      description:
        'Get detailed information about a specific terminal or SFTP session, including ' +
        'its connection status, protocol, shell hints, and session metadata.',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to get information about.'),
      }),
      execute: async ({ sessionId }) => {
        return unwrap(executeWorkspaceGetSessionInfo(deps, { sessionId }));
      },
    }),

    // -- Web Search (conditional on fully configured webSearchConfig) --
    ...(isWebSearchReady(webSearchConfig) ? {
      web_search: tool({
        description:
          'Search the web for current information. Use this when the user asks about recent events, ' +
          'news, or facts you are unsure about. Returns a list of search results with titles, URLs, and content snippets.',
        inputSchema: z.object({
          query: z.string().describe('The search query to look up on the web.'),
          maxResults: z
            .number()
            .optional()
            .describe('Maximum number of search results to return. If omitted, uses the configured default.'),
        }),
        execute: async ({ query, maxResults }) => {
          return unwrap(await executeWebSearch(deps, { query, maxResults }));
        },
      }),
    } : {}),

    // -- URL Fetch (always available, read-only like sftp_read_file) --
    url_fetch: tool({
      description:
        'Fetch and read the content of a web URL. Use this when the user provides a URL and wants ' +
        'you to read or summarize its content. Returns the page content as text.',
      inputSchema: z.object({
        url: z.string().describe('The HTTPS URL to fetch. Must start with https://.'),
        maxLength: z
          .number()
          .optional()
          .default(50000)
          .describe('Maximum number of characters to return. Defaults to 50000.'),
      }),
      execute: async ({ url, maxLength }) => {
        return unwrap(await executeUrlFetch(deps, { url, maxLength }));
      },
    }),
  };
}
