import { compressVerboseText, truncateTextWithHeadAndTail } from '../requestPayloadCompression';
import type { ToolOutputStore } from './toolOutputStore';

export const MAX_LIVE_TERMINAL_STDOUT_CHARS = 24_000;
export const MAX_LIVE_TERMINAL_STDERR_CHARS = 12_000;

export interface TerminalExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  command?: string;
  sessionId?: string;
}

export interface TerminalOutputHandle {
  kind: 'terminal-output';
  sessionId: string;
  command?: string;
  totalStdoutChars: number;
  totalStderrChars: number;
  handleId?: string;
}

export interface FitTerminalExecuteResultOptions {
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
}

export function fitTerminalExecuteResultForModel(
  result: TerminalExecuteResult,
  options?: FitTerminalExecuteResultOptions,
): TerminalExecuteResult {
  const stdout = truncateTextWithHeadAndTail(
    compressVerboseText(result.stdout),
    MAX_LIVE_TERMINAL_STDOUT_CHARS,
  );
  const stderr = truncateTextWithHeadAndTail(
    compressVerboseText(result.stderr),
    MAX_LIVE_TERMINAL_STDERR_CHARS,
  );

  const fitted: TerminalExecuteResult = {
    ...result,
    stdout,
    stderr,
  };

  if (
    stdout.length < result.stdout.length
    || stderr.length < result.stderr.length
  ) {
    const fullContent = [
      result.command ? `command: ${result.command}` : '',
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n\n');

    let handleId: string | undefined;
    if (options?.toolOutputStore && options.chatSessionId && fullContent) {
      handleId = options.toolOutputStore.store({
        chatSessionId: options.chatSessionId,
        capabilityId: 'terminal.execute',
        sessionId: result.sessionId,
        content: fullContent,
      }).id;
    }

    const handle: TerminalOutputHandle = {
      kind: 'terminal-output',
      sessionId: result.sessionId ?? 'unknown',
      command: result.command,
      totalStdoutChars: result.stdout.length,
      totalStderrChars: result.stderr.length,
      handleId,
    };
    fitted.stdout = appendOutputHandleNotice(stdout, handle, 'stdout');
    if (result.stderr) {
      fitted.stderr = appendOutputHandleNotice(stderr, handle, 'stderr');
    }
  }

  return fitted;
}

function appendOutputHandleNotice(
  truncated: string,
  handle: TerminalOutputHandle,
  stream: 'stdout' | 'stderr',
): string {
  const totalChars = stream === 'stdout' ? handle.totalStdoutChars : handle.totalStderrChars;
  const handleSuffix = handle.handleId ? ` handleId=${handle.handleId}` : '';
  return `${truncated}\n\n[output handle: session=${handle.sessionId}${handle.command ? ` command=${handle.command}` : ''} ${stream}=${totalChars} chars truncated for model context${handleSuffix}]`;
}
