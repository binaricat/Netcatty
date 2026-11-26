import Editor, { loader, type Monaco, type OnMount, useMonaco } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import React, { useCallback, useEffect, useId, useRef } from 'react';
import { useClipboardBackend } from '@/application/state/useClipboardBackend';
import {
  buildMonacoPasteEdits,
  pasteForMonacoEditorCommand,
  readClipboardTextWithFallbacks,
} from '@/infrastructure/monaco/monacoClipboardPaste';
import { useNetcattyMonacoTheme } from '@/infrastructure/monaco/useNetcattyMonacoTheme';
import { extractCurrentSqlStatement, extractSqlTableAliases } from './sqlStatement';
import type {
  PluginCodeEditorCompletionSchema,
  PluginCodeEditorDiagnostic,
  PluginCodeEditorWidgetProps,
  PluginWidgetEventCallback,
} from './types';

const viteEnv = (import.meta.env ?? { BASE_URL: '/', DEV: false }) as { BASE_URL?: string; DEV?: boolean };
const monacoBasePath = viteEnv.DEV
  ? './node_modules/monaco-editor/min/vs'
  : `${viteEnv.BASE_URL ?? '/'}monaco/vs`;
loader.config({ paths: { vs: monacoBasePath } });

const DEFAULT_SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'INDEX', 'VIEW', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'INNER JOIN', 'FULL OUTER JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT',
  'OFFSET', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL',
  'BETWEEN', 'LIKE', 'ILIKE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL',
  'WITH', 'EXPLAIN', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'RETURNING', 'PRIMARY KEY',
  'FOREIGN KEY', 'REFERENCES', 'DEFAULT', 'CASCADE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
];

const SEVERITY_MAP: Record<NonNullable<PluginCodeEditorDiagnostic['severity']>, number> = {
  hint: 1,
  info: 2,
  warning: 4,
  error: 8,
};

export interface PluginCodeEditorInnerProps extends PluginCodeEditorWidgetProps {
  onWidgetEvent: PluginWidgetEventCallback;
}

export default function PluginCodeEditorInner({
  value = '',
  language = 'sql',
  readOnly = false,
  placeholder,
  lineNumbers = 'on',
  minimap = false,
  wordWrap = 'off',
  completionSchema,
  diagnostics,
  height = '100%',
  onWidgetEvent,
}: PluginCodeEditorInnerProps) {
  const monaco = useMonaco();
  const themeName = useNetcattyMonacoTheme(monaco ?? undefined);
  const { readClipboardText: readClipboardTextFromBridge } = useClipboardBackend();
  const editorId = useId();
  const modelPath = `inmemory://netcatty-plugin-editor/${editorId.replace(/[^a-zA-Z0-9_-]/g, '_')}.${language}`;

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const disposablesRef = useRef<Array<{ dispose(): void }>>([]);
  const onWidgetEventRef = useRef(onWidgetEvent);
  onWidgetEventRef.current = onWidgetEvent;
  const schemaRef = useRef<PluginCodeEditorCompletionSchema | undefined>(completionSchema);
  schemaRef.current = completionSchema;
  const lastEmittedValueRef = useRef<string>(value);
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readClipboardRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));

  const readClipboardText = useCallback(async (): Promise<string | null> => (
    readClipboardTextWithFallbacks({
      readNavigator: navigator.clipboard?.readText
        ? () => navigator.clipboard.readText()
        : undefined,
      readBridge: readClipboardTextFromBridge,
    })
  ), [readClipboardTextFromBridge]);
  readClipboardRef.current = readClipboardText;

  // Sync external value changes without disrupting cursor when value echoes local edits.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (value === lastEmittedValueRef.current) return;
    const model = editor.getModel();
    if (!model || model.getValue() === value) {
      lastEmittedValueRef.current = value;
      return;
    }
    lastEmittedValueRef.current = value;
    model.setValue(value);
  }, [value]);

  // Sync diagnostics markers cleanly.
  useEffect(() => {
    const editor = editorRef.current;
    const monacoInstance = monacoRef.current ?? monaco;
    if (!editor || !monacoInstance) return;
    const model = editor.getModel();
    if (!model) return;
    const markers = (diagnostics ?? []).map((diag) => ({
      startLineNumber: Math.max(1, Math.floor(diag.line || 1)),
      startColumn: Math.max(1, Math.floor(diag.column || 1)),
      endLineNumber: Math.max(1, Math.floor(diag.endLine ?? diag.line ?? 1)),
      endColumn: Math.max(1, Math.floor(diag.endColumn ?? (diag.column ? diag.column + 1 : 2))),
      message: diag.message,
      severity: SEVERITY_MAP[diag.severity ?? 'error'] ?? 8,
    }));
    monacoInstance.editor.setModelMarkers(model, 'netcatty-plugin-diagnostics', markers);
  }, [diagnostics, monaco]);

  // Register local schema-aware CompletionItemProvider scoped to this editor's model URI.
  useEffect(() => {
    if (!monaco) return;
    if (!['sql', 'pgsql', 'mysql'].includes(language)) return;
    const disposable = monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', ' '],
      provideCompletionItems(model, position) {
        if (model.uri.toString() !== modelPath) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const dotMatch = /["`]?([a-zA-Z_][\w$]*)["`]?\.\s*[\w$]*$/u.exec(linePrefix);
        const schema = schemaRef.current;
        const tables = schema?.tables ?? [];
        const suggestions: Parameters<typeof monaco.languages.registerCompletionItemProvider>[1] extends {
          provideCompletionItems: (...args: never[]) => infer R;
        }
          ? R extends { suggestions: infer S }
            ? S
            : never
          : never = [] as never;
        const list = suggestions as Array<{
          label: string;
          kind: number;
          insertText: string;
          detail?: string;
          sortText?: string;
          range: typeof range;
        }>;

        if (dotMatch) {
          const qualifier = dotMatch[1].toLowerCase();
          const aliases = extractSqlTableAliases(model.getValue());
          const resolvedTableName = aliases.get(qualifier) ?? qualifier;
          // Match either schema.table or table/alias.column
          for (const tbl of tables) {
            if (tbl.schema && tbl.schema.toLowerCase() === qualifier) {
              list.push({
                label: tbl.name,
                kind: monaco.languages.CompletionItemKind.Struct,
                insertText: tbl.name,
                detail: `${tbl.schema} table`,
                sortText: `0_${tbl.name}`,
                range,
              });
            }
            if (tbl.name.toLowerCase() === resolvedTableName.toLowerCase()) {
              for (const col of tbl.columns ?? []) {
                list.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name,
                  detail: col.type ? `${tbl.name}.${col.name} (${col.type})` : `${tbl.name}.${col.name}`,
                  sortText: `0_${col.name}`,
                  range,
                });
              }
            }
          }
          return { suggestions: list as never };
        }

        const seenColumns = new Set<string>();
        for (const tbl of tables) {
          const label = tbl.schema ? `${tbl.schema}.${tbl.name}` : tbl.name;
          list.push({
            label,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: label,
            detail: tbl.schema ? `Table (${tbl.schema})` : 'Table',
            sortText: `1_${tbl.name}`,
            range,
          });
          if (tbl.schema) {
            list.push({
              label: tbl.name,
              kind: monaco.languages.CompletionItemKind.Struct,
              insertText: tbl.name,
              detail: `Table (${tbl.schema})`,
              sortText: `1_${tbl.name}`,
              range,
            });
          }
          for (const col of tbl.columns ?? []) {
            const key = `${col.name}:${tbl.name}`;
            if (seenColumns.has(key)) continue;
            seenColumns.add(key);
            list.push({
              label: col.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col.name,
              detail: col.type ? `${tbl.name} (${col.type})` : tbl.name,
              sortText: `2_${col.name}`,
              range,
            });
          }
        }

        for (const fn of schema?.functions ?? []) {
          list.push({
            label: fn.name,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: fn.insertText ?? `${fn.name}()`,
            detail: fn.detail ?? 'Function',
            sortText: `3_${fn.name}`,
            range,
          });
        }

        const keywords = schema?.keywords?.length ? schema.keywords : DEFAULT_SQL_KEYWORDS;
        for (const kw of keywords) {
          list.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            detail: 'Keyword',
            sortText: `4_${kw}`,
            range,
          });
        }

        return { suggestions: list as never };
      },
    });
    return () => disposable.dispose();
  }, [language, modelPath, monaco]);

  useEffect(() => () => {
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    for (const d of disposablesRef.current.splice(0)) {
      try { d.dispose(); } catch {}
    }
    editorRef.current = null;
  }, []);

  const handleMount: OnMount = useCallback((editor, monacoInstance) => {
    for (const d of disposablesRef.current.splice(0)) {
      try { d.dispose(); } catch {}
    }
    editorRef.current = editor;
    monacoRef.current = monacoInstance;

    const emitExecute = () => {
      const model = editor.getModel();
      if (!model) return;
      const fullValue = model.getValue();
      const sel = editor.getSelection();
      const selectedText = sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
      const cursorOffset = sel ? model.getOffsetAt(sel.getPosition()) : 0;
      const currentStatement = selectedText.trim()
        ? selectedText.trim()
        : extractCurrentSqlStatement(fullValue, cursorOffset);
      onWidgetEventRef.current('execute', {
        value: fullValue,
        selectedText,
        currentStatement,
      });
    };

    const emitFormat = () => {
      const model = editor.getModel();
      if (!model) return;
      onWidgetEventRef.current('format', { value: model.getValue() });
    };

    const handlePaste = async () => {
      const text = await readClipboardRef.current();
      if (text === null) {
        editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
        return;
      }
      if (!text) return;
      const selections = editor.getSelections();
      if (!selections || selections.length === 0) return;
      editor.executeEdits('netcatty-plugin-paste', buildMonacoPasteEdits(text, selections));
      editor.focus();
    };

    disposablesRef.current.push(
      editor.addAction({
        id: 'netcatty.pluginCodeEditor.execute',
        label: 'Run Query',
        keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter],
        run: emitExecute,
      }),
      editor.addAction({
        id: 'netcatty.pluginCodeEditor.formatAlt',
        label: 'Format Query',
        keybindings: [
          monacoInstance.KeyMod.Shift | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.KeyF,
          monacoInstance.KeyMod.Shift | monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyF,
        ],
        run: emitFormat,
      }),
      editor.addAction({
        id: 'netcatty.pluginCodeEditor.paste',
        label: 'Paste',
        keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyV],
        run: () => {
          void pasteForMonacoEditorCommand({
            activeElement: document.activeElement,
            readClipboardText: () => readClipboardRef.current(),
            pasteIntoEditor: () => handlePaste(),
          });
        },
      }),
      editor.onDidChangeCursorSelection(() => {
        if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = setTimeout(() => {
          const model = editor.getModel();
          const sel = editor.getSelection();
          if (!model || !sel) return;
          const selectionStart = model.getOffsetAt(sel.getStartPosition());
          const selectionEnd = model.getOffsetAt(sel.getEndPosition());
          const selectedText = sel.isEmpty() ? '' : model.getValueInRange(sel);
          onWidgetEventRef.current('selection', { selectionStart, selectionEnd, selectedText });
        }, 60);
      }),
    );

    requestAnimationFrame(() => editor.layout());
  }, []);

  const handleChange = useCallback((nextValue: string | undefined) => {
    const next = nextValue ?? '';
    lastEmittedValueRef.current = next;
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
    changeTimerRef.current = setTimeout(() => {
      onWidgetEventRef.current('change', { value: next });
    }, 80);
  }, []);

  const resolvedHeight = typeof height === 'number' ? `${height}px` : height;

  return (
    <div
      className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background"
      style={resolvedHeight !== '100%' ? { height: resolvedHeight } : undefined}
      data-plugin-code-editor=""
    >
      <Editor
        path={modelPath}
        height={resolvedHeight}
        language={language}
        defaultValue={value}
        onChange={handleChange}
        onMount={handleMount}
        theme={themeName}
        loading={(
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        )}
        options={{
          readOnly,
          contextmenu: false,
          minimap: { enabled: minimap },
          fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          fontLigatures: true,
          lineNumbers,
          wordWrap,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          insertSpaces: true,
          folding: true,
          renderLineHighlight: 'line',
          padding: { top: 8, bottom: 8 },
          bracketPairColorization: { enabled: true },
          quickSuggestions: { other: true, comments: false, strings: false },
          suggestOnTriggerCharacters: true,
        }}
      />
      {placeholder && !value ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[56px] top-2 z-10 font-mono text-[13px] text-muted-foreground/70"
        >
          {placeholder}
        </span>
      ) : null}
    </div>
  );
}
