import React, { Suspense } from 'react';
import type { PluginHostDrawnPageProps } from './PluginHostDrawnPage';

const PluginHostDrawnPageImpl = React.lazy(() =>
  import('./PluginHostDrawnPage').then((module) => ({ default: module.PluginHostDrawnPage })),
);

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
