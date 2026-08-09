import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mergeNoteMarkdownDocumentPaste,
  noteMarkdownClipboardToPlainText,
  serializeLexicalSelectionAsMarkdown,
  shouldInterceptNoteMarkdownPaste,
  shouldRecoverNoteMarkdownPasteAfterUnchangedInsert,
} from "./InlineMarkdownEditor.tsx";

test("markdown paste intercepts structured clipboard text in edit mode even without a Lexical selection", () => {
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      pasteInsideLexicalContentSurface: true,
      canInsertMarkdownAtSelection: true,
    }),
    true,
  );
  // After a prior insertMarkdown clears the caret, continuous paste must still
  // be recoverable via document setMarkdown rather than a swallowed preventDefault.
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      pasteInsideLexicalContentSurface: true,
      canInsertMarkdownAtSelection: false,
    }),
    true,
  );
  // Link dialog / toolbar inputs are outside the Lexical content surface.
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "edit",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      pasteInsideLexicalContentSurface: false,
      canInsertMarkdownAtSelection: false,
    }),
    false,
  );
  assert.equal(
    shouldInterceptNoteMarkdownPaste({
      editorMode: "preview",
      pasteInsideCodeBlock: false,
      clipboardText: "# Heading\n\n- item",
      pasteInsideLexicalContentSurface: true,
      canInsertMarkdownAtSelection: true,
    }),
    false,
  );
});

test("document markdown paste merge appends when recovering without a selection", () => {
  assert.equal(
    mergeNoteMarkdownDocumentPaste("Existing note", "# Pasted\n\n- item"),
    "Existing note\n\n# Pasted\n\n- item",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("   ", "# Only paste"),
    "# Only paste",
  );
});

test("document markdown paste merge preserves leading indentation on the first content line", () => {
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "  - child"),
    "- parent\n\n  - child",
  );
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "\n\n  - child\n"),
    "- parent\n\n  - child",
  );
  // Blank lines that only contain spaces are stripped; content indent is kept.
  assert.equal(
    mergeNoteMarkdownDocumentPaste("- parent", "  \n\t\n  - child"),
    "- parent\n\n  - child",
  );
});

test("clipboard markdown plain-text approx matches Lexical selection text", () => {
  assert.equal(noteMarkdownClipboardToPlainText("**Hello**"), "Hello");
  assert.equal(noteMarkdownClipboardToPlainText("[docs](https://example.com)"), "docs");
  assert.equal(noteMarkdownClipboardToPlainText("- item"), "item");
});

test("selection markdown serialization scopes bold and link formatting", () => {
  const plainAnchor = {
    getNode: () => ({
      getType: () => "text",
      getParent: () => null,
    }),
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: (type) => type === "bold",
      anchor: plainAnchor,
    }),
    "**Hello**",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: (type) => type === "bold" || type === "italic",
      anchor: plainAnchor,
    }),
    "***Hello***",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "Hello",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("docs", {
      hasFormat: () => false,
      anchor: {
        getNode: () => ({
          getType: () => "link",
          getURL: () => "https://a.example",
          getParent: () => null,
        }),
      },
    }),
    "[docs](https://a.example)",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("docs", {
      hasFormat: () => false,
      anchor: {
        getNode: () => ({
          getType: () => "link",
          getURL: () => "https://a.example",
          getTitle: () => "API",
          getParent: () => null,
        }),
      },
    }),
    '[docs](https://a.example "API")',
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Title", {
      hasFormat: () => false,
      anchor: {
        getNode: () => ({
          getType: () => "text",
          getParent: () => ({
            getType: () => "heading",
            getTag: () => "h2",
            getParent: () => null,
          }),
        }),
      },
    }),
    "## Title",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("item", {
      hasFormat: (type) => type === "bold",
      anchor: {
        getNode: () => ({
          getType: () => "text",
          getParent: () => ({
            getType: () => "listitem",
            getParent: () => ({
              getType: () => "list",
              getListType: () => "bullet",
              getParent: () => null,
            }),
          }),
        }),
      },
    }),
    "- **item**",
  );

  const headingOne = {
    getType: () => "heading",
    getTag: () => "h1",
    getKey: () => "h1",
    getParent: () => null,
  };
  const headingTwo = {
    getType: () => "heading",
    getTag: () => "h2",
    getKey: () => "h2",
    getParent: () => null,
  };
  const headingOneText = {
    getType: () => "text",
    getKey: () => "t1",
    getTextContent: () => "Heading One",
    hasFormat: () => false,
    getParent: () => headingOne,
  };
  const headingTwoText = {
    getType: () => "text",
    getKey: () => "t2",
    getTextContent: () => "Heading Two",
    hasFormat: () => false,
    getParent: () => headingTwo,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Heading One\n\nHeading Two", {
      hasFormat: () => false,
      anchor: { getNode: () => headingOneText, offset: 0, type: "text" },
      focus: { getNode: () => headingTwoText, offset: 11, type: "text" },
      isBackward: () => false,
      getNodes: () => [headingOne, headingOneText, headingTwo, headingTwoText],
    }),
    "# Heading One\n\n## Heading Two",
  );

  const paragraphNode = {
    getType: () => "paragraph",
    getKey: () => "p",
    getParent: () => null,
  };
  const linkNode = {
    getType: () => "link",
    getURL: () => "https://a.example",
    getTitle: () => "API",
    getKey: () => "link",
    getParent: () => paragraphNode,
  };
  const linkText = {
    getType: () => "text",
    getKey: () => "lt",
    getTextContent: () => "docs",
    hasFormat: () => false,
    getParent: () => linkNode,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("docs", {
      hasFormat: () => false,
      anchor: { getNode: () => linkText, offset: 0, type: "text" },
      focus: { getNode: () => linkText, offset: 4, type: "text" },
      isBackward: () => false,
      getNodes: () => [linkNode, linkText],
    }),
    '[docs](https://a.example "API")',
  );

  // Partial selection inside a heading must omit the heading marker so pasting
  // identical `**Hello**` is not misclassified as a lost-selection no-op.
  const partialHeading = {
    getType: () => "heading",
    getTag: () => "h1",
    getKey: () => "ph",
    getTextContent: () => "Hello world",
    getParent: () => null,
  };
  const helloText = {
    getType: () => "text",
    getKey: () => "hello",
    getTextContent: () => "Hello",
    hasFormat: (type: string) => type === "bold",
    getParent: () => partialHeading,
  };
  const worldText = {
    getType: () => "text",
    getKey: () => "world",
    getTextContent: () => " world",
    hasFormat: () => false,
    getParent: () => partialHeading,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: () => false,
      anchor: { getNode: () => helloText, offset: 0, type: "text" },
      focus: { getNode: () => helloText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [helloText],
    }),
    "**Hello**",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello world", {
      hasFormat: () => false,
      anchor: { getNode: () => helloText, offset: 0, type: "text" },
      focus: { getNode: () => worldText, offset: 6, type: "text" },
      isBackward: () => false,
      getNodes: () => [helloText, worldText],
    }),
    "# **Hello** world",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# **Hello** world",
      clipboardText: "**Hello**",
      selectedText: "Hello",
      selectedMarkdown: "**Hello**",
    }),
    false,
  );
});

test("unchanged insert recovery skips identical replacements but recovers lost-selection no-ops", () => {
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "# Note\n\nHello",
      selectedText: "Note\n\nHello",
    }),
    false,
  );
  // Structured markdown that would pass shouldInsertClipboardTextAsMarkdown:
  // selecting rendered bold "Hello" and pasting **Hello** must not append.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n**Hello** world",
      clipboardText: "**Hello**",
      selectedText: "Hello",
      selectedMarkdown: "**Hello**",
    }),
    false,
  );
  // Combined bold+italic must serialize both markers; otherwise identical
  // ***Hello*** paste is misclassified as a lost-selection no-op.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n***Hello*** world",
      clipboardText: "***Hello***",
      selectedText: "Hello",
      selectedMarkdown: "***Hello***",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n## Title",
      clipboardText: "## Title",
      selectedText: "Title",
      selectedMarkdown: "## Title",
    }),
    false,
  );
  // Plain Hello + paste **Hello** is a formatting change; if insert no-ops,
  // recover so preventDefault does not drop the clipboard.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "**Hello**",
      selectedText: "Hello",
      selectedMarkdown: "Hello",
    }),
    true,
  );
  // Clipboard markdown elsewhere in the doc must not suppress recovery for a
  // different plain selection of the same rendered text.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "**Hello** and Hello",
      clipboardText: "**Hello**",
      selectedText: "Hello",
      selectedMarkdown: "Hello",
    }),
    true,
  );
  // Same link label, different URL must recover when insert leaves the doc unchanged.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [docs](https://a.example) end",
      clipboardText: "[docs](https://b.example)",
      selectedText: "docs",
      selectedMarkdown: "[docs](https://a.example)",
    }),
    true,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [docs](https://a.example) end",
      clipboardText: "[docs](https://a.example)",
      selectedText: "docs",
      selectedMarkdown: "[docs](https://a.example)",
    }),
    false,
  );
  // Link title must be part of selection markdown; otherwise an identical
  // titled-link replace is misclassified as a lost-selection no-op.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: 'see [docs](https://a.example "API") end',
      clipboardText: '[docs](https://a.example "API")',
      selectedText: "docs",
      selectedMarkdown: '[docs](https://a.example "API")',
    }),
    false,
  );
  // Multi-block identical replace (two headings) must not append a duplicate.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n# Heading One\n\n## Heading Two\n\noutro",
      clipboardText: "# Heading One\n\n## Heading Two",
      selectedText: "Heading One\n\nHeading Two",
      selectedMarkdown: "# Heading One\n\n## Heading Two",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "**Goodbye**",
      selectedText: "Hello",
      selectedMarkdown: "Hello",
    }),
    true,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\nHello",
      clipboardText: "- item",
      selectedText: "",
      selectedMarkdown: "",
    }),
    true,
  );
});

test("InlineMarkdownEditor only preventDefaults markdown paste after a successful intercept guard", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /shouldInterceptNoteMarkdownPaste/);
  assert.match(source, /isNotePasteInsideLexicalContentSurface/);
  assert.match(source, /hasActiveLexicalTextSelection/);
  assert.match(source, /getActiveLexicalPasteSelection/);
  assert.match(source, /mergeNoteMarkdownDocumentPaste/);
  assert.match(source, /shouldRecoverNoteMarkdownPasteAfterUnchangedInsert/);
  assert.match(source, /doesSelectionEncompassLexicalBlock/);
  assert.match(source, /setMarkdown\(/);
  assert.match(
    source,
    /pasteInsideLexicalContentSurface:\s*isNotePasteInsideLexicalContentSurface\(event\.target\)/,
  );
  assert.match(
    source,
    /if\s*\(\s*!input\.pasteInsideLexicalContentSurface\s*\)\s*return\s*false/,
  );
  assert.match(
    source,
    /shouldInterceptNoteMarkdownPaste\([\s\S]*?\)[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(
    source,
    /if \(\s*!shouldInterceptNoteMarkdownPaste\([\s\S]*?\)\s*\{\s*return;\s*\}/,
  );
  // Document merge is reserved for missing selection / insert no-op recovery —
  // never forced solely by clipboard length while a selection exists.
  assert.doesNotMatch(source, /shouldUseDocumentNoteMarkdownPaste/);
  assert.match(
    source,
    /if\s*\(\s*!canInsertAtSelection\s*\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*applyDocumentPaste\(\)/,
  );
});
