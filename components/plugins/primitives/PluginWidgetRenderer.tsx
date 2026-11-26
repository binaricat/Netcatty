import React, { useMemo } from 'react';
import { LazyLoadBoundary } from '../../ui/lazy-load-boundary';
import { PluginCodeEditor } from './PluginCodeEditor';
import { PluginDataGrid } from './PluginDataGrid';
import { PluginErCanvas } from './PluginErCanvas';
import type {
  PluginCodeEditorWidgetProps,
  PluginDataGridWidgetProps,
  PluginErCanvasWidgetProps,
  PluginWidgetEventCallback,
} from './types';

export type SlottedWidgetKind = 'code-editor' | 'data-grid' | 'er-canvas';

export function parseWidgetPropsJson<T extends object>(raw: string | undefined): T {
  if (!raw) return {} as T;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
    // Policy already validates widget props; fall back to empty props defensively.
  }
  return {} as T;
}

export function PluginSlottedWidget({
  kind,
  rawProps,
  onWidgetEvent,
}: {
  kind: SlottedWidgetKind;
  rawProps: string | undefined;
  onWidgetEvent: PluginWidgetEventCallback;
}) {
  const parsedProps = useMemo(() => parseWidgetPropsJson<Record<string, unknown>>(rawProps), [rawProps]);

  return (
    <LazyLoadBoundary
      name={`Plugin ${kind}`}
      fallback={<div className="flex h-full w-full items-center justify-center p-4 text-xs text-destructive">Unable to render plugin widget.</div>}
    >
      {kind === 'code-editor' && (
        <PluginCodeEditor {...(parsedProps as PluginCodeEditorWidgetProps)} onWidgetEvent={onWidgetEvent} />
      )}
      {kind === 'data-grid' && (
        <PluginDataGrid {...(parsedProps as PluginDataGridWidgetProps)} onWidgetEvent={onWidgetEvent} />
      )}
      {kind === 'er-canvas' && (
        <PluginErCanvas {...(parsedProps as PluginErCanvasWidgetProps)} onWidgetEvent={onWidgetEvent} />
      )}
    </LazyLoadBoundary>
  );
}
