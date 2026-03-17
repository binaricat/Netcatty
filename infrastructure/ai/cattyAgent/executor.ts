import type { ToolCall, ToolResult, AIPermissionMode, WebSearchConfig } from '../types';
import {
  executeTerminalExecute,
  executeWorkspaceGetInfo,
  executeWorkspaceGetSessionInfo,
  executeWebSearch,
  executeUrlFetch,
  type ToolDeps,
  type ToolExecResult,
} from '../shared/toolExecutors';

/**
 * Bridge interface for Catty Agent to interact with the Electron main process.
 * This mirrors the AI-related subset of window.netcatty from electron/preload.cjs.
 */
export interface NetcattyBridge {
  aiExec(
    sessionId: string,
    command: string,
  ): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
  }>;
}

// Workspace context provided to the executor
export interface ExecutorContext {
  // Available sessions in scope
  sessions: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    connected: boolean;
  }>;
  // Workspace info
  workspaceId?: string;
  workspaceName?: string;
}

/** Convert a shared ToolExecResult into the executor's ToolResult format. */
function toToolResult(toolCallId: string, r: ToolExecResult): ToolResult {
  if (r.ok === false) {
    return { toolCallId, content: r.error, isError: true };
  }
  // For terminal_execute, format as the legacy STDOUT/STDERR/exitCode text block
  if (
    typeof r.data === 'object' &&
    r.data !== null &&
    'stdout' in r.data &&
    'stderr' in r.data &&
    'exitCode' in r.data
  ) {
    const d = r.data as { stdout: string; stderr: string; exitCode: number };
    const output = [
      d.stdout ? `STDOUT:\n${d.stdout}` : '',
      d.stderr ? `STDERR:\n${d.stderr}` : '',
      `Exit code: ${d.exitCode === -1 ? 'unknown' : d.exitCode}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { toolCallId, content: output || 'Command completed (no output)' };
  }
  // Default: JSON-serialize the data
  return { toolCallId, content: JSON.stringify(r.data, null, 2) };
}

/**
 * Create a tool executor function for the Catty Agent.
 * This bridges tool calls to the netcatty Electron IPC layer.
 */
export function createToolExecutor(
  bridge: NetcattyBridge | undefined,
  context: ExecutorContext,
  commandBlocklist?: string[],
  permissionMode: AIPermissionMode = 'confirm',
  webSearchConfig?: WebSearchConfig,
): (toolCall: ToolCall) => Promise<ToolResult> {
  return async (toolCall: ToolCall): Promise<ToolResult> => {
    if (!bridge) {
      return {
        toolCallId: toolCall.id,
        content: 'Netcatty bridge is not available',
        isError: true,
      };
    }

    const deps: ToolDeps = { bridge, context, commandBlocklist, permissionMode, webSearchConfig };
    const args = toolCall.arguments;

    try {
      switch (toolCall.name) {
        case 'terminal_execute': {
          const r = await executeTerminalExecute(deps, {
            sessionId: String(args.sessionId || ''),
            command: String(args.command || ''),
          });
          return toToolResult(toolCall.id, r);
        }

        case 'workspace_get_info': {
          const r = executeWorkspaceGetInfo(deps);
          return toToolResult(toolCall.id, r);
        }

        case 'workspace_get_session_info': {
          const r = executeWorkspaceGetSessionInfo(deps, {
            sessionId: String(args.sessionId || ''),
          });
          return toToolResult(toolCall.id, r);
        }

        case 'web_search': {
          const r = await executeWebSearch(deps, {
            query: String(args.query || ''),
            maxResults: Number(args.maxResults) || 5,
          });
          return toToolResult(toolCall.id, r);
        }

        case 'url_fetch': {
          const r = await executeUrlFetch(deps, {
            url: String(args.url || ''),
            maxLength: Number(args.maxLength) || 50000,
          });
          return toToolResult(toolCall.id, r);
        }

        default:
          return {
            toolCallId: toolCall.id,
            content: `Unknown tool: ${toolCall.name}`,
            isError: true,
          };
      }
    } catch (err) {
      return {
        toolCallId: toolCall.id,
        content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  };
}
