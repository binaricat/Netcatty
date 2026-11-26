import React, { Suspense } from 'react';
import type { PluginHostDrawnPageProps } from './PluginHostDrawnPage';

let preloadPromise: Promise<unknown> | null = null;
const loadPluginHostDrawnPage = () => {
  preloadPromise ??= import('./PluginHostDrawnPage').then((module) => ({ default: module.PluginHostDrawnPage }));
  return preloadPromise as Promise<{ default: typeof import('./PluginHostDrawnPage').PluginHostDrawnPage }>;
};

export function preloadPluginHostDrawnPage(): void {
  void loadPluginHostDrawnPage().catch(() => { preloadPromise = null; });
}

const PluginHostDrawnPageImpl = React.lazy(loadPluginHostDrawnPage);

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
          <p data-plugin-view-slot={slot} role="status" className="p-4 text-sm text-muted-foreground">
            {props.loadingLabel}
          </p>
        ) : null
      }
    >
      <PluginHostDrawnPageImpl {...props} />
    </Suspense>
  );
}
