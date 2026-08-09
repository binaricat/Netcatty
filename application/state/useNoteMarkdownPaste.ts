import { useCallback, type ClipboardEvent } from "react";

import {
  didNoteMarkdownPasteApply,
  mergeNoteMarkdownDocumentPaste,
  shouldInterceptNoteMarkdownPaste,
  shouldRecoverNoteMarkdownPasteAfterUnchangedInsert,
  type NoteEditorMode,
} from "../../domain/noteMarkdownPaste";

export type NoteMarkdownPasteEditor = {
  focus: () => void;
  insertMarkdown: (markdown: string) => void;
  setMarkdown: (markdown: string) => void;
  getMarkdown: () => string;
};

export type NoteMarkdownPasteAdapters = {
  isPasteInsideCodeBlock: (target: EventTarget | null) => boolean;
  isPasteInsideLexicalContentSurface: (target: EventTarget | null) => boolean;
  hasActiveLexicalTextSelection: (target: EventTarget | null) => boolean;
  getActiveLexicalPasteSelection: (
    target: EventTarget | null,
  ) => { text: string; markdown: string } | null;
};

/**
 * Coordinates note Markdown paste intercept, insertMarkdown, and document-merge
 * recovery. Presentation components supply editor/DOM adapters and keep the
 * event handler as view glue.
 */
export function useNoteMarkdownPaste({
  editorMode,
  getEditor,
  getLatestMarkdown,
  commitMarkdown,
  adapters,
  onAfterPaste,
}: {
  editorMode: NoteEditorMode;
  getEditor: () => NoteMarkdownPasteEditor | null;
  getLatestMarkdown: () => string;
  commitMarkdown: (markdown: string) => void;
  adapters: NoteMarkdownPasteAdapters;
  onAfterPaste?: () => void;
}): {
  handlePasteCapture: (event: ClipboardEvent<HTMLElement>) => void;
} {
  const handlePasteCapture = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const markdown = event.clipboardData.getData("text/plain");
    const editor = getEditor();
    const canInsertAtSelection = Boolean(editor)
      && adapters.hasActiveLexicalTextSelection(event.target);
    if (
      !shouldInterceptNoteMarkdownPaste({
        editorMode,
        pasteInsideCodeBlock: adapters.isPasteInsideCodeBlock(event.target),
        clipboardText: markdown,
        pasteInsideLexicalContentSurface: adapters.isPasteInsideLexicalContentSurface(
          event.target,
        ),
        canInsertMarkdownAtSelection: canInsertAtSelection,
      })
    ) {
      return;
    }
    if (!editor) return;

    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();

    const applyDocumentPaste = () => {
      const next = mergeNoteMarkdownDocumentPaste(getLatestMarkdown(), markdown);
      // setMarkdown mutes MDXEditor onChange; commit the draft ourselves so
      // autosave still sees the pasted body.
      editor.setMarkdown(next);
      commitMarkdown(next);
    };

    if (!canInsertAtSelection) {
      // No caret/range: append via document merge instead of a no-op insert.
      applyDocumentPaste();
    } else {
      const before = getLatestMarkdown();
      const pasteSelection = adapters.getActiveLexicalPasteSelection(event.target);
      // Keep the nested Lexical editor (e.g. table cell) active. Root
      // MDXEditorMethods.focus() restores a root selection and can move the
      // insert outside the cell or no-op into document-append recovery.
      editor.insertMarkdown(markdown);
      // insertMarkdown's Lexical update is deferred; if selection was lost the
      // insert no-ops after our preventDefault. Recover on the next frames.
      // Do not treat an unrelated draft/editor change as proof the paste landed.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const editorMarkdown = editor.getMarkdown();
          const recoverInput = {
            beforeMarkdown: before,
            clipboardText: markdown,
            selectedText: pasteSelection?.text ?? null,
            selectedMarkdown: pasteSelection?.markdown ?? null,
          };
          // Identical replace (including node selections): never append a duplicate,
          // even when another edit raced before these frames ran.
          if (!shouldRecoverNoteMarkdownPasteAfterUnchangedInsert(recoverInput)) {
            return;
          }
          if (didNoteMarkdownPasteApply({
            ...recoverInput,
            afterMarkdown: editorMarkdown,
          })) {
            // insertMarkdown updated the editor but onChange may still lag.
            if (getLatestMarkdown() === before && editorMarkdown !== before) {
              commitMarkdown(editorMarkdown);
            }
            return;
          }
          applyDocumentPaste();
        });
      });
    }

    onAfterPaste?.();
  }, [
    adapters,
    commitMarkdown,
    editorMode,
    getEditor,
    getLatestMarkdown,
    onAfterPaste,
  ]);

  return { handlePasteCapture };
}
