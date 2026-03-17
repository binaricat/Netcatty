import { tool } from 'ai';
import { z } from 'zod';
import type { NetcattyBridge, ExecutorContext } from '../cattyAgent/executor';
import type { AIPermissionMode } from '../types';
import type { WebSearchConfig } from '../types';
import { isWebSearchReady } from '../types';
import {
  executeTerminalExecute,
  executeTerminalSendInput,
  executeSftpListDirectory,
  executeSftpReadFile,
  executeSftpWriteFile,
  executeWorkspaceGetInfo,
  executeWorkspaceGetSessionInfo,
  executeWebSearch,
  executeUrlFetch,
  type ToolDeps,
  type ToolExecResult,
} from '../shared/toolExecutors';

/** Unwrap a shared ToolExecResult into the shape expected by Vercel AI SDK tool results. */
function unwrap<T>(r: ToolExecResult<T>): T | { error: string } {
  if (r.ok === false) return { error: r.error };
  return r.data;
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
  context: ExecutorContext,
  commandBlocklist?: string[],
  permissionMode: AIPermissionMode = 'confirm',
  webSearchConfig?: WebSearchConfig,
) {
  const writeToolNeedsApproval = permissionMode === 'confirm';
  const deps: ToolDeps = { bridge, context, commandBlocklist, permissionMode, webSearchConfig };

  return {
    terminal_execute: tool({
      description:
        'Execute a shell command on a remote host via the specified terminal session. ' +
        "The command runs in the session's shell and output is returned when complete.",
      inputSchema: z.object({
        sessionId: z.string().describe('The terminal session ID to execute the command on.'),
        command: z.string().describe('The shell command to execute on the remote host.'),
      }),
      needsApproval: writeToolNeedsApproval,
      execute: async ({ sessionId, command }) => {
        return unwrap(await executeTerminalExecute(deps, { sessionId, command }));
      },
    }),

    terminal_send_input: tool({
      description:
        'Send raw input to a terminal session. Use this for interactive programs that ' +
        'require input such as y/n prompts, passwords, ctrl+c (\\x03), ctrl+d (\\x04), ' +
        'or any other keyboard input. This tool only sends input; it does not return ' +
        'the updated terminal output. For normal shell commands, use terminal_execute instead.',
      inputSchema: z.object({
        sessionId: z.string().describe('The terminal session ID to send input to.'),
        input: z
          .string()
          .describe(
            'The raw input string to send. Use escape sequences for special keys ' +
              '(e.g. "\\x03" for ctrl+c, "\\n" for enter).',
          ),
      }),
      needsApproval: writeToolNeedsApproval,
      execute: async ({ sessionId, input }) => {
        return unwrap(await executeTerminalSendInput(deps, { sessionId, input }));
      },
    }),

    sftp_list_directory: tool({
      description:
        'List the contents of a directory on the remote host via SFTP. Returns file names, ' +
        'sizes, types, and modification timestamps.',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID for the SFTP connection.'),
        path: z.string().describe('The absolute path of the remote directory to list.'),
      }),
      execute: async ({ sessionId, path }) => {
        return unwrap(await executeSftpListDirectory(deps, { sessionId, path }));
      },
    }),

    sftp_read_file: tool({
      description:
        'Read the content of a file on the remote host via SFTP. Returns the file content ' +
        'as text, truncated to maxBytes if the file is large.',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID for the SFTP connection.'),
        path: z.string().describe('The absolute path of the remote file to read.'),
        maxBytes: z
          .number()
          .optional()
          .default(10000)
          .describe('Maximum number of bytes to read from the file. Defaults to 10000.'),
      }),
      execute: async ({ sessionId, path, maxBytes }) => {
        return unwrap(await executeSftpReadFile(deps, { sessionId, path, maxBytes }));
      },
    }),

    sftp_write_file: tool({
      description:
        'Write content to a file on the remote host via SFTP. Creates the file if it does ' +
        'not exist, or overwrites it if it does.',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID for the SFTP connection.'),
        path: z.string().describe('The absolute path of the remote file to write.'),
        content: z.string().describe('The text content to write to the file.'),
      }),
      needsApproval: writeToolNeedsApproval,
      execute: async ({ sessionId, path, content }) => {
        return unwrap(await executeSftpWriteFile(deps, { sessionId, path, content }));
      },
    }),

    workspace_get_info: tool({
      description:
        'Get information about the current workspace, including all configured hosts ' +
        'and their connection status. No parameters required.',
      inputSchema: z.object({}),
      execute: async () => {
        return unwrap(executeWorkspaceGetInfo(deps));
      },
    }),

    workspace_get_session_info: tool({
      description:
        'Get detailed information about a specific terminal or SFTP session, including ' +
        'the host it is connected to, connection status, and session metadata.',
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
