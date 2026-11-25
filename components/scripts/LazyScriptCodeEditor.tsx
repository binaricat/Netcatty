import { Loader2 } from 'lucide-react';
import React, { Suspense } from 'react';
import type { ScriptCodeEditorHandle, ScriptCodeEditorProps } from './ScriptCodeEditor';

const ScriptCodeEditorImpl = React.lazy(() =>
  import('./ScriptCodeEditor').then((module) => ({ default: module.ScriptCodeEditor })),
);

/**
 * Lazy boundary for Monaco-backed ScriptCodeEditor so @monaco-editor/react
 * stays out of the startup bundle while QuickAddSnippetDialog and
 * QuickScriptEditorDialog remain mounted for global window events.
 */
export const LazyScriptCodeEditor = React.forwardRef<ScriptCodeEditorHandle, ScriptCodeEditorProps>(
  (props, ref) => (
    <Suspense
      fallback={
        <div
          className="flex h-full w-full items-center justify-center bg-background"
          style={props.fill ? undefined : { height: props.height ?? 200 }}
        >
          <Loader2 size={18} className="animate-spin text-muted-foreground" />
        </div>
      }
    >
      <ScriptCodeEditorImpl ref={ref} {...props} />
    </Suspense>
  ),
);

LazyScriptCodeEditor.displayName = 'LazyScriptCodeEditor';
