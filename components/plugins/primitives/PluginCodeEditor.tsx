import { Loader2 } from 'lucide-react';
import React, { Suspense, lazy } from 'react';
import { LazyLoadBoundary } from '../../ui/lazy-load-boundary';
import type { PluginCodeEditorWidgetProps, PluginWidgetEventCallback } from './types';

const LazyPluginCodeEditorInner = lazy(() => import('./PluginCodeEditorInner'));

export interface PluginCodeEditorProps extends PluginCodeEditorWidgetProps {
  onWidgetEvent: PluginWidgetEventCallback;
}

export function PluginCodeEditor(props: PluginCodeEditorProps) {
  return (
    <LazyLoadBoundary
      name="Plugin SQL Editor"
      fallback={<div className="flex h-full w-full items-center justify-center p-4 text-xs text-destructive">Unable to load code editor.</div>}
    >
      <Suspense
        fallback={(
          <div className="flex h-full w-full items-center justify-center bg-background text-muted-foreground">
            <Loader2 size={18} className="animate-spin" />
          </div>
        )}
      >
        <LazyPluginCodeEditorInner {...props} />
      </Suspense>
    </LazyLoadBoundary>
  );
}
