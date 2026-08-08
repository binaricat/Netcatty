import {
  mergePluginCompletionItems,
  normalizePluginCompletionResult,
} from '../../../domain/pluginTerminalProviders';
import type { PluginTerminalProviderRegistry } from '../../../application/state/pluginTerminalProviderRegistry';
import {
  getCompletions,
  type CompletionSuggestion,
} from './completionEngine';
import type { AutocompleteCwdSource } from './terminalAutocompleteLayout';
import type { AutocompleteHistoryScope, Snippet } from '../../../domain/models';

export interface TerminalCompletionProviderRequest {
  input: string;
  session: NetcattyTerminalSessionSnapshot;
  hostOs: 'linux' | 'windows' | 'macos';
  cwdSource?: AutocompleteCwdSource;
  snippets?: Snippet[];
  maximum: number;
  /** Which history pool built-in suggestions draw from. */
  historyScope?: AutocompleteHistoryScope;
  /** Internal end-to-end wait bound; tests may lower it deterministically. */
  pluginResponseTimeoutMs?: number;
  /** Host security/session cancellation propagated to the plugin bridge. */
  signal?: AbortSignal;
  /**
   * Forwarded to built-in getCompletions when a path listing finishes after the
   * soft budget (cache-bypassed relative SSH cwd).
   */
  onLatePathSuggestions?: (suggestions: CompletionSuggestion[]) => void;
}

const DEFAULT_PLUGIN_COMPLETION_RESPONSE_TIMEOUT_MS = 800;

type PluginCompletionResponse = Awaited<ReturnType<PluginTerminalProviderRegistry['request']>>;

function emptyPluginCompletionResponse(): PluginCompletionResponse {
  return { requestId: '', stale: false, results: Object.freeze([]) };
}

async function waitForPluginCompletionResponse(
  response: Promise<PluginCompletionResponse>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<PluginCompletionResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PluginCompletionResponse>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(emptyPluginCompletionResponse());
    }, timeoutMs);
  });
  try {
    return await Promise.race([response, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function provideTerminalCompletions(
  registry: PluginTerminalProviderRegistry | null,
  request: TerminalCompletionProviderRequest,
): Promise<CompletionSuggestion[]> {
  const builtInPromise = getCompletions(request.input, {
    hostId: request.session.hostId,
    os: request.hostOs,
    maxResults: request.maximum,
    sessionId: request.session.sessionId,
    protocol: request.session.protocol,
    cwd: request.session.cwd,
    cwdSource: request.cwdSource,
    snippets: request.snippets,
    historyScope: request.historyScope,
    onLatePathSuggestions: request.onLatePathSuggestions,
  });
  const pluginRequestController = new AbortController();
  const abortPluginRequest = () => pluginRequestController.abort();
  request.signal?.addEventListener('abort', abortPluginRequest, { once: true });
  if (request.signal?.aborted) pluginRequestController.abort();
  const pluginPromise = registry?.request({
    kind: 'terminal.completion',
    operation: 'provideCompletions',
    session: request.session,
    payload: {
      input: request.input,
      cursor: request.input.length,
      hostOs: request.hostOs,
      cwdSource: request.cwdSource ?? null,
      maximum: request.maximum,
    },
    deadlineMs: 750,
  }, { signal: pluginRequestController.signal }).catch(() => emptyPluginCompletionResponse())
    ?? Promise.resolve(emptyPluginCompletionResponse());
  const pluginResponseTimeoutMs = Number.isFinite(request.pluginResponseTimeoutMs)
    ? Math.max(1, Math.min(5_000, Math.trunc(request.pluginResponseTimeoutMs ?? 0)))
    : DEFAULT_PLUGIN_COMPLETION_RESPONSE_TIMEOUT_MS;
  let builtIn: CompletionSuggestion[];
  let pluginResponse: PluginCompletionResponse;
  try {
    [builtIn, pluginResponse] = await Promise.all([
      builtInPromise,
      waitForPluginCompletionResponse(
        pluginPromise,
        pluginResponseTimeoutMs,
        () => pluginRequestController.abort(),
      ),
    ]);
  } finally {
    request.signal?.removeEventListener('abort', abortPluginRequest);
  }
  if (request.signal?.aborted || pluginRequestController.signal.aborted || pluginResponse.stale) {
    return builtIn;
  }
  const pluginGroups = pluginResponse.results.map((result) => result.status === 'ok'
    ? normalizePluginCompletionResult(result.providerId, result.result)
    : Object.freeze([]));
  const pluginItems = mergePluginCompletionItems(pluginGroups, request.maximum);
  const combined: CompletionSuggestion[] = [
    ...builtIn,
    ...pluginItems.map((item) => ({
      text: item.text,
      displayText: item.displayText,
      ...(item.description === undefined ? {} : { description: item.description }),
      source: 'plugin' as const,
      score: item.score,
      providerId: item.providerId,
    })),
  ];
  const deduplicated = new Map<string, CompletionSuggestion>();
  for (const item of combined) {
    const existing = deduplicated.get(item.text);
    if (!existing
      || (existing.source === 'plugin' && item.source !== 'plugin')
      || (existing.source === item.source && item.score > existing.score)) {
      deduplicated.set(item.text, item);
    }
  }
  return [...deduplicated.values()]
    .sort((left, right) => right.score - left.score || left.text.localeCompare(right.text))
    .slice(0, request.maximum);
}
