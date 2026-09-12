import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TerminalTheme } from '../../domain/models';
import {
  mergePluginDecorationRules,
  normalizePluginDecorationResult,
  normalizePluginThemeResult,
  type PluginTerminalDecorationRule,
  type PluginTerminalThemeColors,
} from '../../domain/pluginTerminalProviders';
import {
  getWindowPluginTerminalProviderRegistry,
  PluginTerminalProviderAvailability,
  type PluginTerminalProviderResponse,
} from './pluginTerminalProviderRegistry';

const ORDINARY_PROVIDER_KINDS = Object.freeze([
  'terminal.completion',
  'terminal.decoration',
  'terminal.link',
  'terminal.hover',
  'terminal.matcher',
  'terminal.semantic',
  'terminal.prompt',
  'terminal.background',
  'terminal.theme',
] as const satisfies readonly NetcattyTerminalProviderKind[]);
const PROVIDER_DEADLINE_MS = 1_500;
const PROVIDER_RESPONSE_TIMEOUT_MS = 1_800;

export type RequestPluginTerminalProviders = (
  kind: NetcattyTerminalProviderKind,
  operation: string,
  payload: Readonly<Record<string, unknown>>,
  deadlineMs: number,
  supersessionKey?: string,
  signal?: AbortSignal,
) => Promise<PluginTerminalProviderResponse>;

export interface PluginTerminalProviderRefreshMetadata {
  sessionId: string;
  hostId?: string;
  workspaceId?: string;
  protocol: string;
  status: NetcattyTerminalSessionSnapshot['status'];
  shellType?: NetcattyTerminalSessionSnapshot['shellType'];
  baseTheme: TerminalTheme;
}

interface UsePluginTerminalProvidersOptions extends PluginTerminalProviderRefreshMetadata {
  getSnapshotState(): Partial<NetcattyTerminalSessionSnapshot>;
}

export function toPluginTerminalTheme(theme: TerminalTheme) {
  // The preview plugin contract exposes the existing palette only. Keep the
  // host-only optional color out of its strictly validated request payload.
  const { foregroundIntense: _foregroundIntense, ...colors } = theme.colors;
  return { type: theme.type, colors };
}

export function mergePluginTerminalThemeColors(
  results: readonly PluginTerminalThemeColors[],
): PluginTerminalThemeColors {
  const merged: Record<string, string> = {};
  for (const result of results) {
    for (const [key, color] of Object.entries(result)) {
      if (!(key in merged) && color) merged[key] = color;
    }
  }
  return Object.freeze(merged) as PluginTerminalThemeColors;
}

export function resolvePluginTerminalTheme(
  baseTheme: TerminalTheme,
  themeColors: PluginTerminalThemeColors,
): TerminalTheme {
  if (Object.keys(themeColors).length === 0) return baseTheme;
  return {
    ...baseTheme,
    id: `${baseTheme.id}:plugin`,
    colors: { ...baseTheme.colors, ...themeColors },
  };
}

export async function waitForProviderResponse(
  providerRequest: Promise<PluginTerminalProviderResponse>,
  controller: AbortController,
  timeoutMs = PROVIDER_RESPONSE_TIMEOUT_MS,
): Promise<PluginTerminalProviderResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      providerRequest,
      new Promise<PluginTerminalProviderResponse>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(Object.freeze({ requestId: '', stale: true, results: Object.freeze([]) }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function applyCurrentProviderResponse(
  providerResponse: Promise<PluginTerminalProviderResponse>,
  isCurrent: () => boolean,
  apply: (response: PluginTerminalProviderResponse) => void,
  clear: () => void,
): Promise<void> {
  try {
    const response = await providerResponse;
    if (!isCurrent()) return;
    if (response.stale) {
      clear();
      return;
    }
    apply(response);
  } catch {
    if (isCurrent()) clear();
  }
}

export function isPluginTerminalProviderRefreshCurrent(
  initial: PluginTerminalProviderRefreshMetadata,
  current: PluginTerminalProviderRefreshMetadata,
): boolean {
  return current.status === 'connected'
    && current.sessionId === initial.sessionId
    && current.hostId === initial.hostId
    && current.workspaceId === initial.workspaceId
    && current.protocol === initial.protocol
    && current.shellType === initial.shellType
    && current.baseTheme === initial.baseTheme;
}

export function usePluginTerminalProviders(options: UsePluginTerminalProvidersOptions) {
  const registry = getWindowPluginTerminalProviderRegistry();
  const metadataRef = useRef(options);
  metadataRef.current = options;
  const availabilityRef = useRef(new PluginTerminalProviderAvailability());
  const [providerRevision, setProviderRevision] = useState(0);
  const [decorationRules, setDecorationRules] = useState<readonly PluginTerminalDecorationRule[]>(Object.freeze([]));
  const [themeColors, setThemeColors] = useState<PluginTerminalThemeColors>(Object.freeze({}));
  const refreshGenerationRef = useRef(0);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const request = useCallback<RequestPluginTerminalProviders>(async (
    kind,
    operation,
    payload,
    deadlineMs,
    supersessionKey,
    signal,
  ) => {
    if (!registry) return Object.freeze({ requestId: '', stale: false, results: Object.freeze([]) });
    const metadata = metadataRef.current;
    return registry.request({
      kind,
      operation,
      session: {
        sessionId: metadata.sessionId,
        ...(metadata.hostId ? { hostId: metadata.hostId } : {}),
        ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
        protocol: metadata.protocol,
        status: metadata.status,
        ...(metadata.shellType ? { shellType: metadata.shellType } : {}),
        ...metadata.getSnapshotState(),
      },
      payload,
      deadlineMs,
      supersessionKey,
    }, { signal });
  }, [registry]);

  const hasProvider = useCallback(
    (kind: NetcattyTerminalProviderKind) => availabilityRef.current.has(kind),
    [],
  );

  const refreshAvailability = useCallback(async () => {
    return availabilityRef.current.refresh(registry, ORDINARY_PROVIDER_KINDS);
  }, [registry]);

  const refreshProviderOutputs = useCallback(async (reason: string) => {
    const generation = ++refreshGenerationRef.current;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const metadata = metadataRef.current;
    if (!registry || metadata.status !== 'connected') {
      setDecorationRules(Object.freeze([]));
      setThemeColors(Object.freeze({}));
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      return;
    }
    const tasks: Promise<void>[] = [];
    const isCurrent = () => {
      const current = metadataRef.current;
      return generation === refreshGenerationRef.current
        && isPluginTerminalProviderRefreshCurrent(metadata, current);
    };
    if (hasProvider('terminal.decoration')) {
      tasks.push(applyCurrentProviderResponse(waitForProviderResponse(
        request('terminal.decoration', 'provideDecorations', { reason }, PROVIDER_DEADLINE_MS, undefined, controller.signal),
        controller,
      ), isCurrent,
        (response) => {
          setDecorationRules(mergePluginDecorationRules(response.results.map((result) => result.status === 'ok'
            ? normalizePluginDecorationResult(result.providerId, result.result)
            : Object.freeze([]))));
        },
        () => setDecorationRules(Object.freeze([]))));
    } else {
      setDecorationRules(Object.freeze([]));
    }
    if (hasProvider('terminal.theme')) {
      tasks.push(applyCurrentProviderResponse(waitForProviderResponse(request('terminal.theme', 'provideTheme', {
        reason,
        currentTheme: toPluginTerminalTheme(metadata.baseTheme),
      }, PROVIDER_DEADLINE_MS, undefined, controller.signal), controller), isCurrent,
        (response) => {
          setThemeColors(mergePluginTerminalThemeColors(response.results.map((result) => result.status === 'ok'
            ? normalizePluginThemeResult(result.providerId, result.result)
            : Object.freeze({}))));
        },
        () => setThemeColors(Object.freeze({}))));
    } else {
      setThemeColors(Object.freeze({}));
    }
    try {
      await Promise.all(tasks);
    } finally {
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
    }
  }, [hasProvider, registry, request]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (!await refreshAvailability() || !active) return;
      setProviderRevision((value) => value + 1);
    };
    void refresh();
    const subscription = registry?.onDidChangeProviders(() => { void refresh(); });
    return () => {
      active = false;
      subscription?.();
      refreshGenerationRef.current += 1;
      refreshAbortRef.current?.abort();
    };
  }, [refreshAvailability, registry]);

  useEffect(() => {
    void refreshProviderOutputs('session-state');
  }, [
    options.status,
    options.baseTheme,
    options.sessionId,
    options.hostId,
    options.workspaceId,
    options.protocol,
    options.shellType,
    providerRevision,
    refreshProviderOutputs,
  ]);

  const resolvedTheme = useMemo(
    () => resolvePluginTerminalTheme(options.baseTheme, themeColors),
    [options.baseTheme, themeColors],
  );

  return useMemo(() => ({
    decorationRules,
    hasProvider,
    providerRevision,
    refreshProviderOutputs,
    request,
    resolvedTheme,
  }), [decorationRules, hasProvider, providerRevision, refreshProviderOutputs, request, resolvedTheme]);
}
