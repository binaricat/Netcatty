import React, { Suspense } from 'react';
import { prewarmHostDrawnPluginView } from '../../application/state/pluginViewSessionRegistry';
import type { PluginHostDrawnPageProps } from './PluginHostDrawnPage';

let preloadPromise: Promise<unknown> | null = null;
const loadPluginHostDrawnPage = () => {
  preloadPromise ??= import('./PluginHostDrawnPage').then((module) => ({ default: module.PluginHostDrawnPage }));
  return preloadPromise as Promise<{ default: typeof import('./PluginHostDrawnPage').PluginHostDrawnPage }>;
};

export function preloadPluginHostDrawnPage(): void {
  void loadPluginHostDrawnPage().catch(() => { preloadPromise = null; });
}

export function prewarmPluginView(viewId?: string): void {
  preloadPluginHostDrawnPage();
  if (viewId) prewarmHostDrawnPluginView(viewId);
}

const PluginHostDrawnPageImpl = React.lazy(loadPluginHostDrawnPage);

export function PluginViewLoadingSurface({ slot, loadingLabel }: { slot: string; loadingLabel: string }) {
  return (
    <div
      data-plugin-view-slot={slot}
      role="status"
      aria-live="polite"
      className="flex h-full min-h-0 w-full flex-1 flex-col gap-3 bg-background p-4 text-sm text-muted-foreground"
    >
      <div className="flex items-center gap-2.5">
        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70" aria-hidden="true" />
        <span className="text-xs font-medium text-muted-foreground">{loadingLabel}</span>
      </div>
      <div className="flex min-h-0 flex-1 gap-3 opacity-60" aria-hidden="true">
        <div className="hidden w-52 shrink-0 flex-col gap-2 rounded-lg border border-border/40 bg-muted/20 p-3 sm:flex">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted/60" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-muted/40" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted/40" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 rounded-lg border border-border/40 bg-muted/10 p-3">
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted/50" />
          <div className="h-24 w-full animate-pulse rounded bg-muted/30" />
          <div className="min-h-0 flex-1 animate-pulse rounded bg-muted/20" />
        </div>
      </div>
    </div>
  );
}

/**
 * Lazy boundary for host-drawn plugin views so css-tree, mdn-data, and
 * @remote-dom/core stay out of the startup entry bundle until a plugin view
 * actually opens.
 */
export function LazyPluginHostDrawnPage(props: PluginHostDrawnPageProps) {
  const slot = props.slot.split(':')[0];
  return (
    <Suspense
      fallback={
        props.active ? (
          <PluginViewLoadingSurface slot={slot} loadingLabel={props.loadingLabel} />
        ) : null
      }
    >
      <PluginHostDrawnPageImpl {...props} />
    </Suspense>
  );
}
