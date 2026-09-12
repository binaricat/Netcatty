import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { type MarkdownActionType, wrapMarkdownSyntax } from "../../domain/notes";

const SOURCE_EDIT_UNDO_COALESCE_MS = 750;

interface SourceHistorySnapshot {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export const shouldCoalesceSourceUndoStep = (
  previous: { inputType: string; at: number; caret: number } | null,
  inputType: string,
  now: number,
  edit: { start: number; removedLength: number; insertedLength: number },
): boolean => {
  if (!previous || previous.inputType !== inputType || now - previous.at > SOURCE_EDIT_UNDO_COALESCE_MS) {
    return false;
  }
  if (inputType === "insertText") {
    return edit.removedLength === 0 && edit.start === previous.caret;
  }
  if (inputType === "deleteContentBackward") {
    return edit.insertedLength === 0 && edit.start + edit.removedLength === previous.caret;
  }
  if (inputType === "deleteContentForward") {
    return edit.insertedLength === 0 && edit.start === previous.caret;
  }
  return false;
};

export const getSourceEditDelta = (
  previousValue: string,
  nextValue: string,
): { start: number; removedLength: number; insertedLength: number } => {
  let start = 0;
  const sharedLength = Math.min(previousValue.length, nextValue.length);
  while (start < sharedLength && previousValue[start] === nextValue[start]) start += 1;

  let previousEnd = previousValue.length;
  let nextEnd = nextValue.length;
  while (
    previousEnd > start
    && nextEnd > start
    && previousValue[previousEnd - 1] === nextValue[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  return {
    start,
    removedLength: previousEnd - start,
    insertedLength: nextEnd - start,
  };
};

export interface NoteSourceEditorHandle {
  insertAction: (action: MarkdownActionType) => void;
  focus: () => void;
  scrollToLine: (line: number) => boolean;
}

export interface NoteSourceEditorProps {
  noteId?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
  noteFontFamily?: string;
  noteFontSize?: number;
  /** Blocks edits (used when the rich editor cannot render the markdown). */
  readOnly?: boolean;
}

export const NoteSourceEditor = React.forwardRef<NoteSourceEditorHandle, NoteSourceEditorProps>(
  ({ noteId, value, placeholder = "", onChange, className = "", noteFontFamily, noteFontSize, readOnly = false }, ref) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const lineNumbersRef = useRef<HTMLDivElement>(null);
    const [localValue, setLocalValue] = useState(value);
    const prevNoteIdRef = useRef(noteId);
    const prevValueRef = useRef(value);

    // Undo/redo history for the source textarea (native textarea undo is
    // unreliable once the value is controlled by React).
    const undoStackRef = useRef<SourceHistorySnapshot[]>([]);
    const redoStackRef = useRef<SourceHistorySnapshot[]>([]);
    const lastUserEditRef = useRef<{ inputType: string; at: number; caret: number } | null>(null);
    const compositionBaselineRef = useRef<SourceHistorySnapshot | null>(null);
    const skipNextCompositionCommitRef = useRef(false);

    const resetUserEditCoalescing = () => {
      lastUserEditRef.current = null;
    };

    const createSnapshot = (
      snapshotValue = localValue,
      selectionStart = textareaRef.current?.selectionStart ?? snapshotValue.length,
      selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart,
    ): SourceHistorySnapshot => ({
      value: snapshotValue,
      selectionStart: Math.min(selectionStart, snapshotValue.length),
      selectionEnd: Math.min(selectionEnd, snapshotValue.length),
    });

    // Adopt the external value only for genuine external changes:
    // - noteId switch → always adopt (new note).
    // - prop value changed AND differs from localValue → external edit.
    // The parent debounces our own edits and echoes them back with
    // value === localValue; those echoes must NOT reset the textarea, or the
    // keystroke would be reverted and the caret would jump to the end.
    useEffect(() => {
      if (noteId !== prevNoteIdRef.current) {
        prevNoteIdRef.current = noteId;
        prevValueRef.current = value;
        setLocalValue(value);
        undoStackRef.current = [];
        redoStackRef.current = [];
        compositionBaselineRef.current = null;
        skipNextCompositionCommitRef.current = false;
        resetUserEditCoalescing();
        return;
      }
      if (value !== prevValueRef.current) {
        prevValueRef.current = value;
        if (value !== localValue) {
          setLocalValue(value);
          undoStackRef.current = [];
          redoStackRef.current = [];
          compositionBaselineRef.current = null;
          skipNextCompositionCommitRef.current = false;
          resetUserEditCoalescing();
        }
      }
    }, [noteId, value, localValue]);

    const lineCount = (localValue.match(/\n/g)?.length || 0) + 1;
    const lineNumbers = useMemo(
      () => Array.from({ length: lineCount }, (_, i) => i + 1).join("\n"),
      [lineCount],
    );
    const gutterWidth = Math.max(48, String(lineCount).length * 9 + 24);

    const handleScroll = () => {
      if (textareaRef.current && lineNumbersRef.current) {
        lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;
      const nextValue = e.target.value;
      if (nextValue === localValue) return;
      const nativeInputType = (e.nativeEvent as InputEvent | undefined)?.inputType;
      const inputType = typeof nativeInputType === "string" && nativeInputType
        ? nativeInputType
        : "input";
      const isCompositionInput = inputType === "insertCompositionText"
        || inputType === "insertFromComposition";
      if (isCompositionInput) {
        if (inputType === "insertFromComposition" && skipNextCompositionCommitRef.current) {
          skipNextCompositionCommitRef.current = false;
          setLocalValue(nextValue);
          onChange(nextValue);
          return;
        }
        if (compositionBaselineRef.current === null) {
          const edit = getSourceEditDelta(localValue, nextValue);
          const baseline = createSnapshot(
            localValue,
            edit.start,
            edit.start + edit.removedLength,
          );
          compositionBaselineRef.current = baseline;
          undoStackRef.current.push(baseline);
          redoStackRef.current = [];
        }
        if (inputType === "insertFromComposition") compositionBaselineRef.current = null;
        resetUserEditCoalescing();
        setLocalValue(nextValue);
        onChange(nextValue);
        return;
      }
      compositionBaselineRef.current = null;
      const now = Date.now();
      const edit = getSourceEditDelta(localValue, nextValue);
      if (!shouldCoalesceSourceUndoStep(lastUserEditRef.current, inputType, now, edit)) {
        const previousSelectionStart = inputType === "deleteContentBackward"
          ? edit.start + edit.removedLength
          : edit.start;
        undoStackRef.current.push(createSnapshot(
          localValue,
          previousSelectionStart,
          edit.start + edit.removedLength,
        ));
      }
      const caret = typeof e.target.selectionStart === "number"
        ? e.target.selectionStart
        : edit.start + edit.insertedLength;
      lastUserEditRef.current = { inputType, at: now, caret };
      redoStackRef.current = [];
      setLocalValue(nextValue);
      onChange(nextValue);
    };

    const applyHistoryAction = (action: "undo" | "redo"): boolean => {
      const textarea = textareaRef.current;
      if (!textarea) return false;
      const stack = action === "undo" ? undoStackRef.current : redoStackRef.current;
      const target = stack.pop();
      if (target === undefined) return false;
      resetUserEditCoalescing();
      compositionBaselineRef.current = null;
      const current = createSnapshot();
      if (action === "undo") {
        redoStackRef.current.push(current);
      } else {
        undoStackRef.current.push(current);
      }
      setLocalValue(target.value);
      onChange(target.value);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(target.selectionStart, target.selectionEnd);
      });
      return true;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      // Read-only fallback (preview mode): the DOM readOnly attribute blocks
      // typing but not our custom Tab/undo handling, which would still mutate
      // and persist the note.
      if (readOnly) return;

      const key = e.key.toLowerCase();
      const commandModifier = e.metaKey || e.ctrlKey;
      const historyAction = commandModifier && !e.altKey
        ? key === "z"
          ? (e.shiftKey ? "redo" : "undo")
          : key === "y" && e.ctrlKey
            ? "redo"
            : null
        : null;
      if (historyAction) {
        e.preventDefault();
        applyHistoryAction(historyAction);
        return;
      }

      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
        resetUserEditCoalescing();
      }

      // Handle Tab insertion
      if (e.key === "Tab") {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const nextValue = `${localValue.substring(0, start)}  ${localValue.substring(end)}`;
        undoStackRef.current.push(createSnapshot(localValue, start, end));
        redoStackRef.current = [];
        compositionBaselineRef.current = null;
        resetUserEditCoalescing();
        setLocalValue(nextValue);
        onChange(nextValue);
        requestAnimationFrame(() => {
          textarea.selectionStart = start + 2;
          textarea.selectionEnd = start + 2;
        });
      }
    };

    useImperativeHandle(ref, () => ({
      insertAction: (action: MarkdownActionType) => {
        const textarea = textareaRef.current;
        if (!textarea || readOnly) return;

        if (action === "undo" || action === "redo") {
          applyHistoryAction(action);
          return;
        }

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const result = wrapMarkdownSyntax(localValue, start, end, action);
        if (result.text !== localValue) {
          undoStackRef.current.push(createSnapshot(localValue, start, end));
          redoStackRef.current = [];
          compositionBaselineRef.current = null;
          resetUserEditCoalescing();
        }
        setLocalValue(result.text);
        onChange(result.text);
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
        });
      },
      focus: () => {
        textareaRef.current?.focus();
      },
      scrollToLine: (line: number) => {
        const textarea = textareaRef.current;
        if (!textarea) return false;
        const top = Math.max(0, (Math.max(1, line) - 1) * 24 - 12);
        if (typeof textarea.scrollTo === "function") {
          textarea.scrollTo({ top, behavior: "smooth" });
        } else {
          textarea.scrollTop = top;
        }
        if (lineNumbersRef.current) {
          lineNumbersRef.current.scrollTop = top;
        }
        return true;
      },
    }));

    return (
      <div
        className={`relative flex h-full w-full bg-background font-mono text-sm select-text overflow-hidden ${className}`}
      >
        {/* Line numbers gutter */}
        <div
          ref={lineNumbersRef}
          style={{ width: `${gutterWidth}px` }}
          className="shrink-0 py-3 select-none text-right pr-3 text-muted-foreground/40 border-r border-border/50 overflow-hidden font-mono text-sm leading-6"
          onWheel={(e) => {
            if (textareaRef.current) {
              textareaRef.current.scrollTop += e.deltaY;
            }
          }}
        >
          <pre className="m-0 whitespace-pre font-inherit leading-6">{lineNumbers}</pre>
        </div>

        {/* Source Textarea */}
        <div className="relative flex-1 h-full min-w-0">
          <textarea
            ref={textareaRef}
            value={localValue}
            onChange={handleChange}
            onScroll={handleScroll}
            onKeyDown={handleKeyDown}
            onPointerDown={resetUserEditCoalescing}
            onCompositionStart={() => {
              skipNextCompositionCommitRef.current = false;
              if (compositionBaselineRef.current === null) {
                const baseline = createSnapshot();
                compositionBaselineRef.current = baseline;
                undoStackRef.current.push(baseline);
                redoStackRef.current = [];
              }
              resetUserEditCoalescing();
            }}
            onCompositionEnd={() => {
              const baseline = compositionBaselineRef.current;
              if (baseline !== null && baseline.value === localValue) {
                undoStackRef.current.pop();
              }
              skipNextCompositionCommitRef.current = baseline !== null && baseline.value !== localValue;
              compositionBaselineRef.current = null;
              resetUserEditCoalescing();
            }}
            placeholder={placeholder}
            spellCheck={false}
            readOnly={readOnly || undefined}
            aria-readonly={readOnly || undefined}
            style={{
              fontFamily: noteFontFamily || undefined,
              fontSize: noteFontSize ? `${noteFontSize}px` : undefined,
            }}
            className="w-full h-full py-3 px-4 bg-transparent text-foreground resize-none outline-none font-mono text-sm leading-6 whitespace-pre overflow-auto"
          />
        </div>
      </div>
    );
  },
);

NoteSourceEditor.displayName = "NoteSourceEditor";
