import {
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  getNearestEditorFromDOMNode,
} from "lexical";

import {
  noteMarkdownClipboardToPlainText,
  normalizeNoteMarkdownForEquivalence,
  serializeLexicalNodeSelectionAsMarkdown,
  serializeLexicalSelectionAsMarkdown,
} from "../../domain/noteMarkdownPaste";

export const isNotePasteInsideCodeBlock = (target: EventTarget | null): boolean => {
  if (typeof Element === "undefined") return false;
  const element = target instanceof Element
    ? target
    : typeof Node !== "undefined" && target instanceof Node
      ? target.parentElement
      : null;
  return Boolean(element?.closest(".cm-editor, [class*=\"_codeMirrorWrapper_\"]"));
};

/**
 * True when the paste event originates from the Lexical contenteditable surface
 * (`.netcatty-mdx-content`). Dialog/toolbar form fields live under the MDX root
 * portal but outside that surface and must keep native paste.
 */
export const isNotePasteInsideLexicalContentSurface = (
  target: EventTarget | null,
): boolean => {
  if (typeof Element === "undefined") return false;
  const element = target instanceof Element
    ? target
    : typeof Node !== "undefined" && target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return false;
  // Explicit form controls are never the Lexical editing surface.
  if (element.closest("input, textarea, select")) return false;
  if (element.closest(".netcatty-note-markdown-toolbar")) return false;
  return Boolean(element.closest(".netcatty-mdx-content"));
};

/** True when Lexical currently has a selection that insertMarkdown can target. */
export const hasActiveLexicalTextSelection = (target: EventTarget | null): boolean => {
  if (typeof Element === "undefined" || typeof Node === "undefined") return false;
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return false;
  const lexicalEditor = getNearestEditorFromDOMNode(element);
  if (!lexicalEditor) return false;
  let hasSelection = false;
  lexicalEditor.getEditorState().read(() => {
    hasSelection = $getSelection() !== null;
  });
  return hasSelection;
};

/** Active Lexical range/node plain text + selection-scoped markdown, or null. */
export const getActiveLexicalPasteSelection = (
  target: EventTarget | null,
): { text: string; markdown: string } | null => {
  if (typeof Element === "undefined" || typeof Node === "undefined") return null;
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return null;
  const lexicalEditor = getNearestEditorFromDOMNode(element);
  if (!lexicalEditor) return null;
  let pasteSelection: { text: string; markdown: string } | null = null;
  lexicalEditor.getEditorState().read(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      const text = selection.getTextContent();
      pasteSelection = {
        text,
        markdown: serializeLexicalSelectionAsMarkdown(text, selection),
      };
      return;
    }
    if ($isNodeSelection(selection)) {
      const nodes = selection.getNodes();
      const markdown = serializeLexicalNodeSelectionAsMarkdown(nodes);
      if (markdown === null) return;
      // Decorator nodes (HR) expose "\n" via getTextContent; project through the
      // same plain-text rules as clipboard markdown so identical replaces match.
      pasteSelection = {
        text: noteMarkdownClipboardToPlainText(
          normalizeNoteMarkdownForEquivalence(markdown),
        ),
        markdown,
      };
    }
  });
  return pasteSelection;
};

/** Plain text of the active Lexical range, or null when insertMarkdown cannot target it. */
export const getActiveLexicalSelectedText = (target: EventTarget | null): string | null =>
  getActiveLexicalPasteSelection(target)?.text ?? null;
