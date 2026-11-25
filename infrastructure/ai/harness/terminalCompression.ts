import { compressVerboseText, truncateTextWithHeadAndTail } from '../requestPayloadCompression';
import type { ToolOutputStore } from './toolOutputStore';
import { redactSecretsForModel } from './modelSecretRedaction';
import {
  normalizeAiToolOutputMaxChars,
  resolveTerminalStderrMaxChars,
} from '../../../domain/aiToolOutputLimit';

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
  restartPersistenceAvailable?: boolean;
}

export interface FitTerminalExecuteResultOptions {
  chatSessionId?: string;
  toolOutputStore?: ToolOutputStore;
  maxOutputChars?: number;
  maxStdoutChars?: number;
  maxStderrChars?: number;
}

export function fitTerminalExecuteResultForModel(
  result: TerminalExecuteResult,
  options?: FitTerminalExecuteResultOptions,
): TerminalExecuteResult {
  const maxStdoutChars = options?.maxStdoutChars
    ?? (options?.maxOutputChars != null
      ? normalizeAiToolOutputMaxChars(options.maxOutputChars)
      : MAX_LIVE_TERMINAL_STDOUT_CHARS);
  const maxStderrChars = options?.maxStderrChars
    ?? (options?.maxOutputChars != null
      ? resolveTerminalStderrMaxChars(options.maxOutputChars)
      : MAX_LIVE_TERMINAL_STDERR_CHARS);

  const stdout = truncateTextWithHeadAndTail(
    redactSecretsForModel(compressVerboseText(result.stdout), options?.chatSessionId),
    maxStdoutChars,
  );
  const stderr = truncateTextWithHeadAndTail(
    redactSecretsForModel(compressVerboseText(result.stderr), options?.chatSessionId),
    maxStderrChars,
  );

  const fitted: TerminalExecuteResult = {
    ...result,
    command: result.command ? redactSecretsForModel(result.command, options?.chatSessionId) : result.command,
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
      command: result.command ? redactSecretsForModel(result.command, options?.chatSessionId) : result.command,
      totalStdoutChars: result.stdout.length,
      totalStderrChars: result.stderr.length,
      handleId,
      restartPersistenceAvailable: false,
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
  const restartSuffix = handle.handleId && handle.restartPersistenceAvailable === false
    ? ' restartPersistence=unavailable (read before closing the app)'
    : '';
  return `${truncated}\n\n[output handle: session=${handle.sessionId}${handle.command ? ` command=${handle.command}` : ''} ${stream}=${totalChars} chars truncated for model context${handleSuffix}${restartSuffix}]`;
}
