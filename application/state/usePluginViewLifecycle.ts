import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  isPluginShortcutEditableEvent,
  normalizePluginKeyboardEvent,
  normalizePluginShortcut,
  resolvePluginShortcutPlatform,
} from './pluginKeybindings';
import { PLUGIN_THEME_TOKEN_NAMES } from './pluginContributionEnvironment';
import { useActiveTabId } from './activeTabStore';
import {
  pluginViewTabStore,
  resolvePluginViewRequest,
  usePluginViewTabs,
} from './pluginViewTabStore';
import {
  reconcilePluginViewTabCatalog,
  resolvePluginViewSnapshotSelection,
  type PluginViewSnapshotSelection,
} from './pluginViewLifecycle';
import { pluginViewSessions } from './pluginViewSession';
import { usePluginContributions } from './usePluginContributions';

export const OPEN_PLUGIN_VIEW_EVENT = 'netcatty:open-plugin-view';

export interface OpenPluginViewDetail {
  viewId: string;
  context?: Record<string, unknown>;
}

export type ResolvedPluginView = {
  plugin: NetcattyPluginContributionSnapshot['plugins'][number];
  view: NetcattyPluginContributionSnapshot['plugins'][number]['views'][number];
};

const DEFAULT_VIEW_QUERY_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({
  'netcatty.surface': 'view',
});

export function hasPluginKeybindingContributions(
  snapshot: NetcattyPluginContributionSnapshot,
): boolean {
  return snapshot.plugins.some((plugin) => plugin.keybindings.length > 0);
}

export function requestOpenPluginView(detail: OpenPluginViewDetail) {
  window.dispatchEvent(new CustomEvent(OPEN_PLUGIN_VIEW_EVENT, { detail }));
}

export function usePluginViewLifecycle({
  locale,
  theme,
  suppliedThemeTokens,
  keybindingContext,
}: {
  locale: string;
  theme: string;
  suppliedThemeTokens?: Record<string, string>;
  keybindingContext: Record<string, unknown>;
}) {
  const [requested, setRequested] = useState<OpenPluginViewDetail | null>(null);
  const activeTabId = useActiveTabId();
  const pluginViewTabs = usePluginViewTabs();
  const activePluginTab = pluginViewTabs.find((tab) => tab.id === activeTabId) ?? null;
  const effectiveRequested = resolvePluginViewRequest(requested, activePluginTab);
  const viewQueryContext = useMemo(
    () => effectiveRequested?.context ?? DEFAULT_VIEW_QUERY_CONTEXT,
    [effectiveRequested?.context],
  );
  const viewQueryContextKey = useMemo(() => JSON.stringify(viewQueryContext), [viewQueryContext]);
  const keybindingQuery = useMemo(
    () => ({ locale, context: keybindingContext }),
    [locale, keybindingContext],
  );
  const viewQuery = useMemo(
    () => ({ locale, context: viewQueryContext }),
    [locale, viewQueryContext],
  );
  const contributions = usePluginContributions(keybindingQuery, {
    isContextSensitive: hasPluginKeybindingContributions,
  });
  const viewContributions = usePluginContributions(viewQuery);
  const {
    snapshot,
    executeCommand,
    setEnvironment,
  } = contributions;
  const resolvedActiveView = useMemo(() => viewContributions.snapshot.plugins
    .flatMap((plugin) => plugin.views.map((view) => ({ plugin, view })))
    .find(({ view }) => view.id === effectiveRequested?.viewId && view.visible && !['vault-page', 'terminal-sidebar'].includes(view.location)) ?? null,
  [effectiveRequested?.viewId, viewContributions.snapshot.plugins]);
  const stableActiveViewRef = useRef<PluginViewSnapshotSelection<ResolvedPluginView> | null>(null);
  const activeView = resolvePluginViewSnapshotSelection({
    resolved: resolvedActiveView,
    previous: stableActiveViewRef.current,
    loading: viewContributions.loading,
    requestedViewId: effectiveRequested?.viewId,
    contextKey: viewQueryContextKey,
  });
  useEffect(() => {
    if (viewContributions.loading) return;
    stableActiveViewRef.current = resolvedActiveView && effectiveRequested?.viewId
      ? {
          requestViewId: effectiveRequested.viewId,
          contextKey: viewQueryContextKey,
          value: resolvedActiveView,
        }
      : null;
  }, [effectiveRequested?.viewId, resolvedActiveView, viewContributions.loading, viewQueryContextKey]);

  const keybindingContextRef = useRef(keybindingContext);
  keybindingContextRef.current = keybindingContext;

  useEffect(() => {
    const bindings = snapshot.plugins.flatMap((plugin) => plugin.keybindings)
      .filter((binding) => binding.enabled)
      .sort((left, right) => `${left.command}:${left.key}`.localeCompare(`${right.command}:${right.key}`));
    if (bindings.length === 0) return;
    const platformKey = resolvePluginShortcutPlatform(navigator.platform);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isPluginShortcutEditableEvent(event)) return;
      const pressed = normalizePluginKeyboardEvent(event);
      if (!pressed) return;
      const binding = bindings.find((candidate) => {
        const declared = candidate[platformKey] ?? candidate.key;
        return normalizePluginShortcut(declared, platformKey) === pressed;
      });
      if (!binding) return;
      event.preventDefault();
      void executeCommand(binding.command, binding.args, keybindingContextRef.current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [executeCommand, snapshot.plugins]);

  useEffect(() => {
    const listener = (event: Event) => setRequested((event as CustomEvent<OpenPluginViewDetail>).detail);
    window.addEventListener(OPEN_PLUGIN_VIEW_EVENT, listener);
    return () => window.removeEventListener(OPEN_PLUGIN_VIEW_EVENT, listener);
  }, []);

  useEffect(() => {
    reconcilePluginViewTabCatalog({
      loading: contributions.loading,
      plugins: contributions.snapshot.plugins,
      store: pluginViewTabStore,
    });
  }, [contributions.loading, contributions.snapshot.plugins]);

  useEffect(() => {
    if (!requested || activeView?.view.location !== 'tab') return;
    pluginViewTabStore.open({
      pluginId: activeView.plugin.id,
      pluginName: activeView.plugin.displayName,
      viewId: activeView.view.id,
      title: activeView.view.title,
      icon: activeView.view.icon,
      context: requested.context,
    });
    setRequested(null);
  }, [activeView, requested]);

  useEffect(() => {
    const stop = pluginViewTabStore.onDidClose(({ tab }) => pluginViewSessions.closeView(tab.viewId));
    return () => { stop(); };
  }, []);

  const close = useCallback(async () => {
    setRequested(null);
    if (activeView) pluginViewSessions.closeView(activeView.view.id);
    // An overlay can be requested while a different plugin tab stays active.
    // Dismissing that overlay must not close the tab underneath it.
    if (activeView?.view.location === 'tab' && activePluginTab?.viewId === activeView.view.id) {
      pluginViewTabStore.close(activePluginTab.id);
    }
  }, [activePluginTab, activeView]);

  const runtimeAvailable = contributions.available;
  const environmentStateRef = useRef({
    locale,
    theme,
    suppliedThemeTokens,
    setEnvironment,
  });
  environmentStateRef.current = {
    locale,
    theme,
    suppliedThemeTokens,
    setEnvironment,
  };
  const environmentPublisherRef = useRef<{ publish: () => void } | null>(null);

  useEffect(() => {
    if (!runtimeAvailable) {
      environmentPublisherRef.current = null;
      return;
    }
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forcedColorsQuery = window.matchMedia('(forced-colors: active)');
    const contrastQuery = window.matchMedia('(prefers-contrast: more)');
    let frame = 0;
    const cancelPendingPublish = () => {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    const publish = () => {
      cancelPendingPublish();
      const current = environmentStateRef.current;
      const styles = current.suppliedThemeTokens ? null : getComputedStyle(document.documentElement);
      const themeTokens = current.suppliedThemeTokens ?? Object.fromEntries(PLUGIN_THEME_TOKEN_NAMES
        .map((name) => [name, styles?.getPropertyValue(name).trim() ?? '']));
      void current.setEnvironment({
        locale: current.locale,
        theme: current.theme,
        reducedMotion: reducedMotionQuery.matches,
        highContrast: forcedColorsQuery.matches || contrastQuery.matches,
        themeTokens,
      }).catch(() => {});
    };
    const schedulePublish = () => {
      cancelPendingPublish();
      frame = requestAnimationFrame(() => {
        frame = 0;
        publish();
      });
    };
    environmentPublisherRef.current = { publish };
    const queries = [reducedMotionQuery, forcedColorsQuery, contrastQuery];
    for (const query of queries) query.addEventListener?.('change', schedulePublish);
    const observer = new MutationObserver(schedulePublish);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      environmentPublisherRef.current = null;
      cancelPendingPublish();
      observer.disconnect();
      for (const query of queries) query.removeEventListener?.('change', schedulePublish);
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    if (!runtimeAvailable) return;
    environmentPublisherRef.current?.publish();
  }, [runtimeAvailable, locale, setEnvironment, suppliedThemeTokens, theme]);

  return {
    activeView,
    close,
    effectiveRequested,
    viewQueryContext,
  };
}
