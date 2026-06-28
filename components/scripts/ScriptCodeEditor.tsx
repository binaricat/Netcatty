import Editor, { loader, type Monaco, type OnMount, useMonaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useRef } from 'react';
import { useNetcattyMonacoTheme } from '@/infrastructure/monaco/useNetcattyMonacoTheme';
import { registerNctMonacoCompletionProvider } from '@/infrastructure/scripts/nctMonacoCompletion.ts';

const viteEnv = import.meta.env ?? { BASE_URL: '/' };
const monacoBasePath = viteEnv.DEV
  ? './node_modules/monaco-editor/min/vs'
  : `${viteEnv.BASE_URL}monaco/vs`;
loader.config({ paths: { vs: monacoBasePath } });

export interface ScriptCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: 'javascript' | 'python';
  /** Fill parent flex container (modal). Parent must have explicit height. */
  fill?: boolean;
  /** Fixed pixel height (sidebar). Ignored when fill is true. */
  height?: number;
  minimap?: boolean;
  /** Re-layout when container becomes visible (e.g. dialog open). */
  active?: boolean;
}

export const ScriptCodeEditor: React.FC<ScriptCodeEditorProps> = ({
  value,
  onChange,
  language,
  fill = false,
  height = 240,
  minimap = false,
  active = true,
}) => {
  const monaco = useMonaco();
  const themeName = useNetcattyMonacoTheme(monaco ?? undefined);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);

  useEffect(() => () => {
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = null;
  }, []);

  useEffect(() => {
    if (!active || !editorRef.current) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.layout();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, fill, height]);

  const handleMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = registerNctMonacoCompletionProvider(monacoInstance);
    requestAnimationFrame(() => editor.layout());
  }, []);

  const editorHeight = fill ? '100%' : `${height}px`;

  return (
    <div className={fill ? 'h-full min-h-0 relative' : 'relative'} style={fill ? undefined : { height }}>
      <Editor
        height={editorHeight}
        language={language}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        onMount={handleMount}
        theme={themeName}
        loading={(
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        )}
        options={{
          minimap: { enabled: minimap },
          fontSize: 13,
          lineNumbers: 'on',
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          folding: true,
          renderLineHighlight: 'line',
          padding: { top: 8, bottom: 8 },
          bracketPairColorization: { enabled: true },
        }}
      />
    </div>
  );
};
