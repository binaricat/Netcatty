import assert from "node:assert/strict";
import test from "node:test";

import {
  doesSelectionEncompassLexicalBlock,
  mergeNoteMarkdownDocumentPaste,
  noteMarkdownClipboardToPlainText,
  normalizeNoteMarkdownForEquivalence,
  serializeLexicalSelectionAsMarkdown,
  shouldInterceptNoteMarkdownPaste,
  shouldRecoverNoteMarkdownPasteAfterUnchangedInsert,
} from "./noteMarkdownPaste";

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
  // Destinations with balanced parentheses must not leave a trailing ")".
  assert.equal(
    noteMarkdownClipboardToPlainText("[docs](https://example.test/a_(b))"),
    "docs",
  );
  assert.equal(noteMarkdownClipboardToPlainText("- item"), "item");
  assert.equal(noteMarkdownClipboardToPlainText("- [ ] task"), "task");
  assert.equal(noteMarkdownClipboardToPlainText("- [x] task"), "task");
  assert.equal(
    noteMarkdownClipboardToPlainText("# Heading One\n\n## Heading Two"),
    "Heading One\n\nHeading Two",
  );
  // Hard-break markers become a plain newline (Lexical selection text).
  assert.equal(noteMarkdownClipboardToPlainText("**A**  \n**B**"), "A\nB");
  assert.equal(noteMarkdownClipboardToPlainText("**A**\\\n**B**"), "A\nB");
});

test("markdown equivalence normalizes underscore emphasis to serializer form", () => {
  assert.equal(normalizeNoteMarkdownForEquivalence("__Hello__"), "**Hello**");
  assert.equal(normalizeNoteMarkdownForEquivalence("_Hi_"), "*Hi*");
  assert.equal(
    normalizeNoteMarkdownForEquivalence("__Hello__"),
    normalizeNoteMarkdownForEquivalence("**Hello**"),
  );
  // Hard breaks: backslash and two-trailing-spaces forms are equivalent.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("**A**\\\n**B**"),
    normalizeNoteMarkdownForEquivalence("**A**  \n**B**"),
  );
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
  assert.equal(
    serializeLexicalSelectionAsMarkdown("task", {
      hasFormat: () => false,
      anchor: {
        getNode: () => ({
          getType: () => "text",
          getParent: () => ({
            getType: () => "listitem",
            getChecked: () => false,
            getParent: () => ({
              getType: () => "list",
              getListType: () => "check",
              getParent: () => null,
            }),
          }),
        }),
      },
    }),
    "- [ ] task",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("task", {
      hasFormat: () => false,
      anchor: {
        getNode: () => ({
          getType: () => "text",
          getParent: () => ({
            getType: () => "listitem",
            getChecked: () => true,
            getParent: () => ({
              getType: () => "list",
              getListType: () => "check",
              getParent: () => null,
            }),
          }),
        }),
      },
    }),
    "- [x] task",
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
    serializeLexicalSelectionAsMarkdown("Heading One\nHeading Two", {
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

  // Lexical linebreak nodes are Markdown hard breaks (two trailing spaces).
  const hardBreakParagraph = {
    getType: () => "paragraph",
    getKey: () => "hb-p",
    getTextContent: () => "AB",
    getParent: () => null,
  };
  const hardBreakA = {
    getType: () => "text",
    getKey: () => "hb-a",
    getTextContent: () => "A",
    hasFormat: (type: string) => type === "bold",
    getParent: () => hardBreakParagraph,
  };
  const hardBreakNode = {
    getType: () => "linebreak",
    getKey: () => "hb-br",
    getParent: () => hardBreakParagraph,
  };
  const hardBreakB = {
    getType: () => "text",
    getKey: () => "hb-b",
    getTextContent: () => "B",
    hasFormat: (type: string) => type === "bold",
    getParent: () => hardBreakParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A\nB", {
      hasFormat: () => false,
      anchor: { getNode: () => hardBreakA, offset: 0, type: "text" },
      focus: { getNode: () => hardBreakB, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [hardBreakA, hardBreakNode, hardBreakB],
    }),
    "**A**  \n**B**",
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
  // Mixed element/text endpoints: element side is fully selected, text side
  // still honors the character offset (prefix of bold "Hello").
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hel", {
      hasFormat: () => false,
      anchor: { getNode: () => partialHeading, offset: 0, type: "element" },
      focus: { getNode: () => helloText, offset: 3, type: "text" },
      isBackward: () => false,
      getNodes: () => [partialHeading, helloText],
    }),
    "**Hel**",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# **Hello** world",
      clipboardText: "**Hel**",
      selectedText: "Hel",
      selectedMarkdown: "**Hel**",
    }),
    false,
  );
  // Text-only coverage of the full block still omits the marker; Lexical
  // whole-block selections include the heading element in getNodes().
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello world", {
      hasFormat: () => false,
      anchor: { getNode: () => helloText, offset: 0, type: "text" },
      focus: { getNode: () => worldText, offset: 6, type: "text" },
      isBackward: () => false,
      getNodes: () => [helloText, worldText],
    }),
    "**Hello** world",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello world", {
      hasFormat: () => false,
      anchor: { getNode: () => helloText, offset: 0, type: "text" },
      focus: { getNode: () => worldText, offset: 6, type: "text" },
      isBackward: () => false,
      getNodes: () => [partialHeading, helloText, worldText],
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

  // Sole-content heading: selecting bold "Hello" is not a whole-block selection.
  const soleHeading = {
    getType: () => "heading",
    getTag: () => "h1",
    getKey: () => "sole",
    getTextContent: () => "Hello",
    getParent: () => null,
  };
  const soleHelloText = {
    getType: () => "text",
    getKey: () => "sole-hello",
    getTextContent: () => "Hello",
    hasFormat: (type: string) => type === "bold",
    getParent: () => soleHeading,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: () => false,
      anchor: { getNode: () => soleHelloText, offset: 0, type: "text" },
      focus: { getNode: () => soleHelloText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [soleHelloText],
    }),
    "**Hello**",
  );
  assert.equal(
    doesSelectionEncompassLexicalBlock(
      soleHeading,
      "sole",
      [soleHelloText],
      {
        hasFormat: () => false,
        anchor: { getNode: () => soleHelloText, offset: 0, type: "text" },
        focus: { getNode: () => soleHelloText, offset: 5, type: "text" },
        isBackward: () => false,
        getNodes: () => [soleHelloText],
      },
    ),
    false,
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: () => false,
      anchor: { getNode: () => soleHelloText, offset: 0, type: "text" },
      focus: { getNode: () => soleHelloText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [soleHeading, soleHelloText],
    }),
    "# **Hello**",
  );
  assert.equal(
    doesSelectionEncompassLexicalBlock(
      soleHeading,
      "sole",
      [soleHelloText],
      {
        hasFormat: () => false,
        anchor: { getNode: () => soleHeading, offset: 0, type: "element" },
        focus: { getNode: () => soleHeading, offset: 1, type: "element" },
        isBackward: () => false,
        getNodes: () => [soleHelloText],
      },
    ),
    true,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# **Hello**",
      clipboardText: "**Hello**",
      selectedText: "Hello",
      selectedMarkdown: "**Hello**",
    }),
    false,
  );

  const checkList = {
    getType: () => "list",
    getListType: () => "check" as const,
    getParent: () => null,
  };
  const uncheckedItem = {
    getType: () => "listitem",
    getKey: () => "li-unchecked",
    getChecked: () => false,
    getTextContent: () => "task",
    getParent: () => checkList,
  };
  const checkedItem = {
    getType: () => "listitem",
    getKey: () => "li-checked",
    getChecked: () => true,
    getTextContent: () => "task",
    getParent: () => checkList,
  };
  const uncheckedText = {
    getType: () => "text",
    getKey: () => "t-unchecked",
    getTextContent: () => "task",
    hasFormat: () => false,
    getParent: () => uncheckedItem,
  };
  const checkedText = {
    getType: () => "text",
    getKey: () => "t-checked",
    getTextContent: () => "task",
    hasFormat: () => false,
    getParent: () => checkedItem,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("task", {
      hasFormat: () => false,
      anchor: { getNode: () => uncheckedText, offset: 0, type: "text" },
      focus: { getNode: () => uncheckedText, offset: 4, type: "text" },
      isBackward: () => false,
      getNodes: () => [uncheckedItem, uncheckedText],
    }),
    "- [ ] task",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("task", {
      hasFormat: () => false,
      anchor: { getNode: () => checkedText, offset: 0, type: "text" },
      focus: { getNode: () => checkedText, offset: 4, type: "text" },
      isBackward: () => false,
      getNodes: () => [checkedItem, checkedText],
    }),
    "- [x] task",
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
  // Underscore bold is equivalent to serializer `**…**`; do not append a duplicate.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n**Hello** world",
      clipboardText: "__Hello__",
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
  // Link destinations with balanced parentheses must not trip plain-text
  // comparison into duplicate-append recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [docs](https://example.test/a_(b)) end",
      clipboardText: "[docs](https://example.test/a_(b))",
      selectedText: "docs",
      selectedMarkdown: "[docs](https://example.test/a_(b))",
    }),
    false,
  );
  // Identical hard-break fragment must not append a duplicate.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n**A**  \n**B**\n\noutro",
      clipboardText: "**A**  \n**B**",
      selectedText: "A\nB",
      selectedMarkdown: "**A**  \n**B**",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n**A**  \n**B**\n\noutro",
      clipboardText: "**A**\\\n**B**",
      selectedText: "A\nB",
      selectedMarkdown: "**A**  \n**B**",
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
  // Lexical getTextContent() joins blocks with one newline, not Markdown's blank line.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n# Heading One\n\n## Heading Two\n\noutro",
      clipboardText: "# Heading One\n\n## Heading Two",
      selectedText: "Heading One\nHeading Two",
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
  // Identical task-list replace must keep checkbox state in selectedMarkdown.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n- [ ] task\n\n- [x] other",
      clipboardText: "- [ ] task",
      selectedText: "task",
      selectedMarkdown: "- [ ] task",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n- [x] task\n\n- [ ] other",
      clipboardText: "- [x] task",
      selectedText: "task",
      selectedMarkdown: "- [x] task",
    }),
    false,
  );
  // Checked vs unchecked is a real change; recover when insert no-ops.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n- [ ] task",
      clipboardText: "- [x] task",
      selectedText: "task",
      selectedMarkdown: "- [ ] task",
    }),
    true,
  );
});
