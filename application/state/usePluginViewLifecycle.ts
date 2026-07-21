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
  PluginViewLifecycleController,
  reconcilePluginViewTabCatalog,
  resolvePluginViewSnapshotSelection,
  type HostedPluginViewState,
  type PluginViewSnapshotSelection,
} from './pluginViewLifecycle';
import {
  canRetainPluginViewInScope,
  resolvePluginRetainedViewKey,
  resolvePluginViewWindowScope,
} from './pluginViewScopes';
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
    () => effectiveRequested?.context ?? { 'netcatty.surface': 'view' },
    [effectiveRequested?.context],
  );
  const viewQueryContextKey = useMemo(() => JSON.stringify(viewQueryContext), [viewQueryContext]);
  const contributions = usePluginContributions({ locale, context: keybindingContext });
  const viewContributions = usePluginContributions({ locale, context: viewQueryContext });
  const {
    snapshot,
    executeCommand,
    openView,
    closeView,
    setViewBounds,
    setViewVisibility,
    setEnvironment,
    onViewClosed,
  } = contributions;
  const [instance, setInstance] = useState<HostedPluginViewState | null>(null);
  const lifecycleRef = useRef(new PluginViewLifecycleController<HostedPluginViewState>());
  const closeViewRef = useRef(closeView);
  const mountRef = useRef<HTMLDivElement>(null);
  const resolvedActiveView = useMemo(() => viewContributions.snapshot.plugins
    .flatMap((plugin) => plugin.views.map((view) => ({ plugin, view })))
    .find(({ view }) => view.id === effectiveRequested?.viewId && view.visible) ?? null,
  [effectiveRequested?.viewId, viewContributions.snapshot.plugins]);
  const stableActiveViewRef = useRef<PluginViewSnapshotSelection<ResolvedPluginView> | null>(null);
  const activeView = resolvePluginViewSnapshotSelection({
    resolved: resolvedActiveView,
    previous: stableActiveViewRef.current,
    loading: viewContributions.loading,
    requestedViewId: effectiveRequested?.viewId,
    contextKey: viewQueryContextKey,
  });
  const activeViewId = activeView?.view.id;
  const viewScopeId = typeof window === 'undefined'
    ? 'window:server'
    : resolvePluginViewWindowScope(window.location);
  const retainedViewKey = activeViewId
    ? resolvePluginRetainedViewKey(activeViewId, viewScopeId)
    : null;

  useEffect(() => { closeViewRef.current = closeView; }, [closeView]);

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

  useEffect(() => onViewClosed((event) => {
    const next = lifecycleRef.current.handleHostClose(event.instanceId);
    if (next.matchedCurrent) {
      setInstance(null);
      setRequested(null);
    }
    if (next.closedTabId) pluginViewTabStore.close(next.closedTabId);
  }), [onViewClosed]);

  useEffect(() => pluginViewTabStore.onDidClose(({ tab }) => {
    const next = lifecycleRef.current.handleTabClose(tab.id);
    if (next.matchedCurrent) {
      setInstance(null);
      setRequested(null);
    }
    for (const instanceId of next.instanceIds) {
      void closeViewRef.current(instanceId).catch(() => {});
    }
  }), []);

  useEffect(() => {
    const bindings = snapshot.plugins.flatMap((plugin) => plugin.keybindings)
      .filter((binding) => binding.enabled)
      .sort((left, right) => `${left.command}:${left.key}`.localeCompare(`${right.command}:${right.key}`));
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
      void executeCommand(binding.command, binding.args, keybindingContext);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [executeCommand, keybindingContext, snapshot.plugins]);

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

  const hideOrClose = useCallback(async (current: HostedPluginViewState) => {
    if (!current.retainContextWhenHidden) {
      await closeView(current.id);
      return;
    }
    const key = resolvePluginRetainedViewKey(current.viewId, current.scopeId);
    lifecycleRef.current.retain(key, current);
    try {
      await setViewVisibility(current.id, false);
    } catch {
      lifecycleRef.current.removeRetained(key);
      await closeView(current.id);
    }
  }, [closeView, setViewVisibility]);

  const close = useCallback(async () => {
    lifecycleRef.current.markViewClosed(retainedViewKey);
    const current = lifecycleRef.current.takeCurrent();
    setInstance(null);
    setRequested(null);
    if (current) await closeView(current.id);
  }, [closeView, retainedViewKey]);

  useEffect(() => {
    const removed = lifecycleRef.current.removeRetainedWhere(
      (retained) => !canRetainPluginViewInScope(retained.scopeId, viewScopeId),
    );
    for (const retained of removed) void closeView(retained.id).catch(() => {});
  }, [closeView, viewScopeId]);

  useEffect(() => {
    if (!instance) return;
    if (effectiveRequested?.viewId === instance.viewId
      && activeViewId === instance.viewId
      && instance.scopeId === viewScopeId) return;
    lifecycleRef.current.takeCurrent();
    setInstance(null);
    if (canRetainPluginViewInScope(instance.scopeId, viewScopeId)) {
      void hideOrClose(instance);
    } else {
      void closeView(instance.id).catch(() => {});
    }
  }, [activeViewId, closeView, effectiveRequested?.viewId, hideOrClose, instance, viewScopeId]);

  useEffect(() => {
    if (!activeViewId || !retainedViewKey || !mountRef.current || instance) return;
    let cancelled = false;
    const openingTabId = activePluginTab?.id;
    const openingToken = lifecycleRef.current.beginOpen({
      viewKey: retainedViewKey,
      tabId: openingTabId,
      label: activePluginTab?.id ?? activeViewId,
    });
    const bounds = mountRef.current.getBoundingClientRect();
    const nextBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    void (async () => {
      let opened = lifecycleRef.current.takeRetained(retainedViewKey);
      if (opened) {
        try {
          await setViewBounds(opened.id, nextBounds);
          await setViewVisibility(opened.id, true);
        } catch {
          try { await closeView(opened.id); } catch { /* best-effort cleanup after restore failure */ }
          opened = null;
        }
      }
      if (!opened) {
        const result = await openView({
          viewId: activeViewId,
          scopeId: viewScopeId,
          bounds: nextBounds,
          context: effectiveRequested?.context,
        });
        opened = {
          id: result.instanceId,
          viewId: activeViewId,
          scopeId: viewScopeId,
          retainContextWhenHidden: activeView.view.retainContextWhenHidden === true,
          ...(activePluginTab ? { tabId: activePluginTab.id } : {}),
        };
      }
      if (lifecycleRef.current.consumeHostClose(opened.id)) {
        throw new Error('Plugin view closed while its open response was in flight');
      }
      if (lifecycleRef.current.shouldCloseOpen(openingToken)) {
        await closeView(opened.id);
        return;
      }
      if (cancelled) {
        await hideOrClose(opened);
        return;
      }
      lifecycleRef.current.setCurrent(opened);
      setInstance(opened);
    })().catch(() => {
      if (cancelled) return;
      if (activePluginTab) pluginViewTabStore.close(activePluginTab.id);
      else setRequested(null);
    }).finally(() => {
      lifecycleRef.current.finishOpen({
        token: openingToken,
        viewKey: retainedViewKey,
        tabId: openingTabId,
      });
    });
    return () => { cancelled = true; };
  }, [
    activePluginTab,
    activeView?.view.retainContextWhenHidden,
    activeViewId,
    closeView,
    effectiveRequested?.context,
    hideOrClose,
    instance,
    openView,
    retainedViewKey,
    setViewBounds,
    setViewVisibility,
    viewScopeId,
  ]);

  useEffect(() => {
    if (!instance || !mountRef.current) return;
    const update = () => {
      const bounds = mountRef.current?.getBoundingClientRect();
      if (!bounds) return;
      void setViewBounds(instance.id, {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(mountRef.current);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [instance, setViewBounds]);

  useEffect(() => {
    if (!contributions.available) return;
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const forcedColorsQuery = window.matchMedia('(forced-colors: active)');
    const contrastQuery = window.matchMedia('(prefers-contrast: more)');
    let frame = 0;
    const publish = () => {
      frame = 0;
      const styles = suppliedThemeTokens ? null : getComputedStyle(document.documentElement);
      const themeTokens = suppliedThemeTokens ?? Object.fromEntries(PLUGIN_THEME_TOKEN_NAMES
        .map((name) => [name, styles?.getPropertyValue(name).trim() ?? '']));
      void setEnvironment({
        locale,
        theme,
        reducedMotion: reducedMotionQuery.matches,
        highContrast: forcedColorsQuery.matches || contrastQuery.matches,
        themeTokens,
      }).catch(() => {});
    };
    const schedulePublish = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(publish);
    };
    const queries = [reducedMotionQuery, forcedColorsQuery, contrastQuery];
    for (const query of queries) query.addEventListener?.('change', schedulePublish);
    const observer = new MutationObserver(schedulePublish);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    publish();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const query of queries) query.removeEventListener?.('change', schedulePublish);
    };
  }, [contributions.available, locale, setEnvironment, suppliedThemeTokens, theme]);

  useEffect(() => () => {
    const views = lifecycleRef.current.drain();
    const ids = new Set(views.map((view) => view.id));
    for (const id of ids) void closeViewRef.current(id);
  }, []);

  return {
    activeView,
    close,
    effectiveRequested,
    mountRef,
  };
}
