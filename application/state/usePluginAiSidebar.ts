import { useCallback, useEffect, useMemo, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import type {
  PluginAISidebarContextSnapshot,
  PluginAISidebarToolSpec,
  PluginAISidebarTurnContext,
} from '../../infrastructure/ai/pluginAiSidebarTypes';

const WIDTH_STORAGE_KEY = 'netcatty:plugin-ai-sidebar-width';
export const DEFAULT_PLUGIN_AI_SIDEBAR_WIDTH = 400;
export const MIN_PLUGIN_AI_SIDEBAR_WIDTH = 320;
export const MAX_PLUGIN_AI_SIDEBAR_WIDTH = 680;

export function readPluginAiSidebarWidth(): number {
  const parsed = localStorageAdapter.readNumber(WIDTH_STORAGE_KEY);
  if (
    typeof parsed === 'number'
    && Number.isFinite(parsed)
    && parsed >= MIN_PLUGIN_AI_SIDEBAR_WIDTH
    && parsed <= MAX_PLUGIN_AI_SIDEBAR_WIDTH
  ) {
    return Math.round(parsed);
  }
  return DEFAULT_PLUGIN_AI_SIDEBAR_WIDTH;
}

export function writePluginAiSidebarWidth(width: number): void {
  const clamped = Math.max(
    MIN_PLUGIN_AI_SIDEBAR_WIDTH,
    Math.min(MAX_PLUGIN_AI_SIDEBAR_WIDTH, Math.round(width)),
  );
  localStorageAdapter.writeNumber(WIDTH_STORAGE_KEY, clamped);
}

const EMPTY_STATE: NetcattyPluginAiSidebarState = Object.freeze({
  contexts: Object.freeze([]),
  tools: Object.freeze([]),
});

export interface PendingPluginSidebarPrompt {
  readonly id: number;
  readonly prompt: string;
  readonly autoSend?: boolean;
}

let nextPromptSeq = 1;

export function usePluginAiSidebarForView(options: {
  pluginId: string;
  pluginName: string;
  viewId: string;
  enabled?: boolean;
  onCommand?: (command: NetcattyPluginAiSidebarCommand) => void;
}) {
  const { pluginId, pluginName, viewId, enabled = true, onCommand } = options;
  const [state, setState] = useState<NetcattyPluginAiSidebarState>(EMPTY_STATE);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY_STATE);
      return;
    }
    const bridge = netcattyBridge.get();
    if (!bridge?.getPluginAiSidebarState && !bridge?.onPluginAiSidebarStateChanged) {
      setState(EMPTY_STATE);
      return;
    }
    let active = true;
    let receivedPush = false;
    const unsubscribeState = bridge.onPluginAiSidebarStateChanged?.((next) => {
      if (!active) return;
      receivedPush = true;
      setState(next ?? EMPTY_STATE);
    });
    void bridge.getPluginAiSidebarState?.().then((next) => {
      if (!active || receivedPush) return;
      setState(next ?? EMPTY_STATE);
    }).catch(() => {
      if (!active || receivedPush) return;
      setState(EMPTY_STATE);
    });
    return () => {
      active = false;
      unsubscribeState?.();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !onCommand) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.onPluginAiSidebarCommand) return;
    return bridge.onPluginAiSidebarCommand((command) => {
      if (!command || command.pluginId !== pluginId) return;
      if (command.viewId && command.viewId !== viewId) return;
      onCommand(command);
    });
  }, [enabled, onCommand, pluginId, viewId]);

  const contextSnapshot: PluginAISidebarContextSnapshot | null = useMemo(() => {
    const match = state.contexts.find(
      (entry) => entry.pluginId === pluginId && entry.viewId === viewId,
    );
    return match ?? null;
  }, [pluginId, state.contexts, viewId]);

  const tools: readonly PluginAISidebarToolSpec[] = useMemo(() => (
    state.tools.filter(
      (tool) => tool.pluginId === pluginId && (!tool.viewId || tool.viewId === viewId),
    )
  ), [pluginId, state.tools, viewId]);

  const turnContext: PluginAISidebarTurnContext | null = useMemo(() => {
    if (!contextSnapshot && tools.length === 0) return null;
    return {
      pluginId,
      pluginName: contextSnapshot?.pluginName || pluginName,
      viewId,
      ...(contextSnapshot?.title ? { title: contextSnapshot.title } : {}),
      ...(contextSnapshot?.subtitle ? { subtitle: contextSnapshot.subtitle } : {}),
      ...(contextSnapshot?.summary ? { summary: contextSnapshot.summary } : {}),
      tools,
    };
  }, [contextSnapshot, pluginId, pluginName, tools, viewId]);

  const suggestedPrompts = contextSnapshot?.suggestedPrompts;

  const createPendingPrompt = useCallback(
    (prompt: string, autoSend?: boolean): PendingPluginSidebarPrompt => ({
      id: nextPromptSeq++,
      prompt,
      autoSend,
    }),
    [],
  );

  return {
    contextSnapshot,
    tools,
    turnContext,
    suggestedPrompts,
    createPendingPrompt,
  };
}
