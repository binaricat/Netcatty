import Editor, { loader, type Monaco, type OnMount, useMonaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useClipboardBackend } from '@/application/state/useClipboardBackend';
import {
  buildMonacoPasteEdits,
  readClipboardTextWithFallbacks,
} from '@/infrastructure/monaco/monacoClipboardPaste';
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
  language: 'javascript' | 'python' | 'shell';
  /** Fill parent flex container (modal). Parent must have explicit height. */
  fill?: boolean;
  /** Fixed pixel height (sidebar). Ignored when fill is true. */
  height?: number;
  minimap?: boolean;
  /** Re-layout when container becomes visible (e.g. dialog open). */
  active?: boolean;
  /** Move keyboard focus into the editor after it mounts. */
  autoFocus?: boolean;
  /** Accessible name announced by screen readers. */
  ariaLabel?: string;
  /** Hint shown while the editor is empty. */
  placeholder?: string;
  /** Let Tab move to the next control instead of inserting indentation. */
  tabFocusMode?: boolean;
  /** Run the surrounding form's submit action for Cmd/Ctrl+Enter. */
  onSubmitShortcut?: () => void;
}

export interface ScriptCodeEditorHandle {
  focus: () => void;
}

export const ScriptCodeEditor = React.forwardRef<ScriptCodeEditorHandle, ScriptCodeEditorProps>(({
  value,
  onChange,
  language,
  fill = false,
  height = 240,
  minimap = false,
  active = true,
  autoFocus = false,
  ariaLabel,
  placeholder,
  tabFocusMode = false,
  onSubmitShortcut,
}, forwardedRef) => {
  const monaco = useMonaco();
  const themeName = useNetcattyMonacoTheme(monaco ?? undefined);
  const { readClipboardText: readClipboardTextFromBridge } = useClipboardBackend();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const onSubmitShortcutRef = useRef(onSubmitShortcut);
  onSubmitShortcutRef.current = onSubmitShortcut;
  const handlePasteRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useImperativeHandle(forwardedRef, () => ({
    focus: () => editorRef.current?.focus(),
  }), []);

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

  const handlePaste = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;

    const text = await readClipboardTextWithFallbacks({
      readNavigator: navigator.clipboard?.readText
        ? () => navigator.clipboard.readText()
        : undefined,
      readBridge: readClipboardTextFromBridge,
    });

    if (text === null) {
      // Clipboard read unavailable; fall back to Monaco's native paste.
      editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
      return;
    }
    if (!text) return;

    const selections = editor.getSelections();
    if (!selections || selections.length === 0) return;

    editor.executeEdits('netcatty-paste', buildMonacoPasteEdits(text, selections));
    editor.focus();
  }, [readClipboardTextFromBridge]);

  useEffect(() => {
    handlePasteRef.current = handlePaste;
  }, [handlePaste]);

  const handleMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor;
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = language === 'javascript'
      ? registerNctMonacoCompletionProvider(monacoInstance)
      : null;
    if (onSubmitShortcut) {
      editor.addCommand(
        monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter,
        () => onSubmitShortcutRef.current?.(),
      );
    }
    // Fallback paste path for Electron where Monaco clipboardPasteAction can fail.
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyV,
      () => {
        void handlePasteRef.current();
      },
    );
    requestAnimationFrame(() => editor.layout());
    if (autoFocus) editor.focus();
  }, [autoFocus, language, onSubmitShortcut]);

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
          // Prefer native context menu in Electron so right-click Paste uses OS clipboard path.
          contextmenu: false,
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
          ariaLabel,
          tabFocusMode,
        }}
      />
      {placeholder && !value ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-[52px] top-2 z-10 font-mono text-[13px] text-muted-foreground"
        >
          {placeholder}
        </span>
      ) : null}
    </div>
  );
});

ScriptCodeEditor.displayName = 'ScriptCodeEditor';
