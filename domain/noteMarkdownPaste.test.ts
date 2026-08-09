import assert from "node:assert/strict";
import test from "node:test";

import {
  didNoteMarkdownPasteApply,
  doesSelectionEncompassLexicalBlock,
  mergeNoteMarkdownDocumentPaste,
  noteMarkdownClipboardToPlainText,
  normalizeNoteMarkdownForEquivalence,
  serializeLexicalNodeSelectionAsMarkdown,
  serializeLexicalSelectionAsMarkdown,
  serializeMdastTableAsMarkdown,
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
  // Strikethrough (and bold+strike) must match Lexical plain selection text.
  assert.equal(noteMarkdownClipboardToPlainText("~~Hello~~"), "Hello");
  assert.equal(noteMarkdownClipboardToPlainText("**~~Hello~~**"), "Hello");
  assert.equal(noteMarkdownClipboardToPlainText("~~**Hello**~~"), "Hello");
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
  // Code spans / link destinations keep literal underscores (not **).
  assert.equal(normalizeNoteMarkdownForEquivalence("`__x__`"), "`__x__`");
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("`__x__`"),
    normalizeNoteMarkdownForEquivalence("`**x**`"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("[label](https://example.com/__path__)"),
    "[label](https://example.com/__path__)",
  );
  // Labels still canonicalize; only destinations are protected.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("[__x__](https://example.com/__path__)"),
    "[**x**](https://example.com/__path__)",
  );
  // MDXEditor emits `*` list markers; our selection serializer uses `-`.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("* one\n* two"),
    normalizeNoteMarkdownForEquivalence("- one\n- two"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("+ one\n  + nested"),
    normalizeNoteMarkdownForEquivalence("- one\n  - nested"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("* [ ] task\n* [x] done"),
    normalizeNoteMarkdownForEquivalence("- [ ] task\n- [x] done"),
  );
  // Emphasis / code must not be rewritten as list markers.
  assert.equal(normalizeNoteMarkdownForEquivalence("*Hi*"), "*Hi*");
  assert.equal(normalizeNoteMarkdownForEquivalence("`* not a list`"), "`* not a list`");
  // Same-marker thematic breaks canonicalize; mixed marker runs do not.
  assert.equal(normalizeNoteMarkdownForEquivalence("---"), "***");
  assert.equal(normalizeNoteMarkdownForEquivalence("- - -"), "***");
  assert.equal(normalizeNoteMarkdownForEquivalence("___"), "***");
  assert.equal(normalizeNoteMarkdownForEquivalence("* * *"), "***");
  assert.equal(normalizeNoteMarkdownForEquivalence("-_*"), "-_*");
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("-_*"),
    normalizeNoteMarkdownForEquivalence("***"),
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
  // Literal Markdown punctuation in Lexical text must be escaped so identical
  // replace checks see source spelling (`\*world\*`), not rendered markers.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello *world*", {
      hasFormat: (type) => type === "bold",
      anchor: plainAnchor,
    }),
    "**Hello \\*world\\***",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("**Hello**", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\*\\*Hello\\*\\*",
  );
  // Literal block-opening punctuation must escape so identical-replace checks
  // see source spelling (`\# Heading`), not a structural heading.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("# Heading", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\# Heading",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("> quote", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\> quote",
  );
  // Literal list openers must escape so identical-replace checks see source
  // spelling (`\- item` / `1\. item`), not a structural list.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("- item", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\- item",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("+ item", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\+ item",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("1. item", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "1\\. item",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("2) item", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "2\\) item",
  );
  // Inline code with embedded backticks needs a longer safe fence.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("a`b", {
      hasFormat: (type) => type === "code",
      anchor: plainAnchor,
    }),
    "``a`b``",
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
      hasFormat: (type) => type === "strikethrough",
      anchor: plainAnchor,
    }),
    "~~Hello~~",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello", {
      hasFormat: (type) => type === "bold" || type === "strikethrough",
      anchor: plainAnchor,
    }),
    "**~~Hello~~**",
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

  // Adjacent list items must stay single-newline joined (`- one\n- two`), not
  // blank-line separated, or identical paste recovery appends a duplicate.
  const bulletList = {
    getType: () => "list",
    getListType: () => "bullet" as const,
    getParent: () => null,
  };
  const bulletOne = {
    getType: () => "listitem",
    getKey: () => "li-one",
    getTextContent: () => "one",
    getParent: () => bulletList,
  };
  const bulletTwo = {
    getType: () => "listitem",
    getKey: () => "li-two",
    getTextContent: () => "two",
    getParent: () => bulletList,
  };
  const bulletOneText = {
    getType: () => "text",
    getKey: () => "t-one",
    getTextContent: () => "one",
    hasFormat: () => false,
    getParent: () => bulletOne,
  };
  const bulletTwoText = {
    getType: () => "text",
    getKey: () => "t-two",
    getTextContent: () => "two",
    hasFormat: () => false,
    getParent: () => bulletTwo,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("one\ntwo", {
      hasFormat: () => false,
      anchor: { getNode: () => bulletOneText, offset: 0, type: "text" },
      focus: { getNode: () => bulletTwoText, offset: 3, type: "text" },
      isBackward: () => false,
      getNodes: () => [bulletOne, bulletOneText, bulletTwo, bulletTwoText],
    }),
    "- one\n- two",
  );
  // Adjacent but distinct lists (ul then ol) keep a blank line between runs.
  const numberList = {
    getType: () => "list",
    getListType: () => "number" as const,
    getParent: () => null,
  };
  const numberOne = {
    getType: () => "listitem",
    getKey: () => "li-num",
    getValue: () => 1,
    getTextContent: () => "one",
    getParent: () => numberList,
  };
  const numberOneText = {
    getType: () => "text",
    getKey: () => "t-num",
    getTextContent: () => "one",
    hasFormat: () => false,
    getParent: () => numberOne,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("two\none", {
      hasFormat: () => false,
      anchor: { getNode: () => bulletTwoText, offset: 0, type: "text" },
      focus: { getNode: () => numberOneText, offset: 3, type: "text" },
      isBackward: () => false,
      getNodes: () => [bulletTwo, bulletTwoText, numberOne, numberOneText],
    }),
    "- two\n\n1. one",
  );
  // Nested list: parent getTextContent includes child text; still emit parent marker
  // and keep a single newline so identical-replace recovery stays accurate.
  type NestedPasteNode = {
    getType: () => string;
    getKey: () => string;
    getTextContent: () => string;
    getParent: () => NestedPasteNode | null;
    getChildren?: () => NestedPasteNode[];
    getListType?: () => "bullet";
    hasFormat?: () => boolean;
  };
  const nestOuterList: NestedPasteNode = {
    getType: () => "list",
    getKey: () => "list-outer",
    getListType: () => "bullet",
    getTextContent: () => "parent\nchild",
    getParent: () => null,
  };
  const nestParentItem: NestedPasteNode = {
    getType: () => "listitem",
    getKey: () => "li-parent",
    getTextContent: () => "parent\nchild",
    getParent: () => nestOuterList,
  };
  const nestParentText: NestedPasteNode = {
    getType: () => "text",
    getKey: () => "t-parent",
    getTextContent: () => "parent",
    hasFormat: () => false,
    getParent: () => nestParentItem,
  };
  const nestInnerList: NestedPasteNode = {
    getType: () => "list",
    getKey: () => "list-inner",
    getListType: () => "bullet",
    getTextContent: () => "child",
    getParent: () => nestParentItem,
  };
  const nestChildItem: NestedPasteNode = {
    getType: () => "listitem",
    getKey: () => "li-child",
    getTextContent: () => "child",
    getParent: () => nestInnerList,
  };
  const nestChildText: NestedPasteNode = {
    getType: () => "text",
    getKey: () => "t-child",
    getTextContent: () => "child",
    hasFormat: () => false,
    getParent: () => nestChildItem,
  };
  nestParentItem.getChildren = () => [nestParentText, nestInnerList];
  nestChildItem.getChildren = () => [nestChildText];
  assert.equal(
    serializeLexicalSelectionAsMarkdown("parent\nchild", {
      hasFormat: () => false,
      anchor: { getNode: () => nestParentText, offset: 0, type: "text" },
      focus: { getNode: () => nestChildText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        nestParentItem,
        nestParentText,
        nestChildItem,
        nestChildText,
      ],
    }),
    "- parent\n  - child",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "- one\n- two",
      clipboardText: "- one\n- two",
      selectedText: "one\ntwo",
      selectedMarkdown: "- one\n- two",
    }),
    false,
  );
  // Clipboard / MDXEditor `*` markers must match serializer `-` without append recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "Intro\n\n* one\n* two\n\nOutro",
      clipboardText: "* one\n* two",
      selectedText: "one\ntwo",
      selectedMarkdown: "- one\n- two",
    }),
    false,
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

  // Outer bold spanning a bold+strikethrough Lexical split must coalesce.
  const coalesceParagraph = {
    getType: () => "paragraph",
    getKey: () => "coalesce-p",
    getTextContent: () => "Hello world",
    getParent: () => null,
  };
  const coalesceHello = {
    getType: () => "text",
    getKey: () => "coalesce-hello",
    getTextContent: () => "Hello ",
    hasFormat: (type: string) => type === "bold",
    getParent: () => coalesceParagraph,
  };
  const coalesceWorld = {
    getType: () => "text",
    getKey: () => "coalesce-world",
    getTextContent: () => "world",
    hasFormat: (type: string) => type === "bold" || type === "strikethrough",
    getParent: () => coalesceParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("Hello world", {
      hasFormat: () => false,
      anchor: { getNode: () => coalesceHello, offset: 0, type: "text" },
      focus: { getNode: () => coalesceWorld, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [coalesceHello, coalesceWorld],
    }),
    "**Hello ~~world~~**",
  );

  // Inline-code selection with an embedded backtick uses a longer safe fence.
  const codeParagraph = {
    getType: () => "paragraph",
    getKey: () => "code-p",
    getTextContent: () => "a`b",
    getParent: () => null,
  };
  const codeText = {
    getType: () => "text",
    getKey: () => "code-text",
    getTextContent: () => "a`b",
    hasFormat: (type: string) => type === "code",
    getParent: () => codeParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("a`b", {
      hasFormat: () => false,
      anchor: { getNode: () => codeText, offset: 0, type: "text" },
      focus: { getNode: () => codeText, offset: 3, type: "text" },
      isBackward: () => false,
      getNodes: () => [codeText],
    }),
    "``a`b``",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "prefix **Hello ~~world~~** suffix",
      clipboardText: "**Hello ~~world~~**",
      selectedText: "Hello world",
      selectedMarkdown: "**Hello ~~world~~**",
    }),
    false,
  );

  // A hard break belongs to one block only; multi-block serialization must not
  // replay it into every selected block (or identical paste recovers a duplicate).
  const hardBreakSibling = {
    getType: () => "paragraph",
    getKey: () => "hb-sib",
    getTextContent: () => "C",
    getParent: () => null,
  };
  const hardBreakSiblingText = {
    getType: () => "text",
    getKey: () => "hb-c",
    getTextContent: () => "C",
    hasFormat: () => false,
    getParent: () => hardBreakSibling,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A\nB\nC", {
      hasFormat: () => false,
      anchor: { getNode: () => hardBreakA, offset: 0, type: "text" },
      focus: { getNode: () => hardBreakSiblingText, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        hardBreakA,
        hardBreakNode,
        hardBreakB,
        hardBreakSibling,
        hardBreakSiblingText,
      ],
    }),
    "**A**  \n**B**\n\nC",
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

  // Whole blockquote: MDXEditor nests quote → paragraph → text. Nearest-block
  // lookup hits the paragraph, so serialization must still preserve the quote
  // marker when the quote node is part of the selection.
  const quoteBlock = {
    getType: () => "quote",
    getKey: () => "quote",
    getTextContent: () => "quote",
    getParent: () => null,
  };
  const quoteParagraph = {
    getType: () => "paragraph",
    getKey: () => "quote-p",
    getTextContent: () => "quote",
    getParent: () => quoteBlock,
  };
  const quoteText = {
    getType: () => "text",
    getKey: () => "quote-t",
    getTextContent: () => "quote",
    hasFormat: () => false,
    getParent: () => quoteParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("quote", {
      hasFormat: () => false,
      anchor: { getNode: () => quoteText, offset: 0, type: "text" },
      focus: { getNode: () => quoteText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [quoteBlock, quoteParagraph, quoteText],
    }),
    "> quote",
  );
  // Text-only coverage inside a quote omits the marker (same sole-content rule
  // as headings) so pasting plain `quote` is not treated as a no-op recovery.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("quote", {
      hasFormat: () => false,
      anchor: { getNode: () => quoteText, offset: 0, type: "text" },
      focus: { getNode: () => quoteText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [quoteText],
    }),
    "quote",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "> quote",
      clipboardText: "> quote",
      selectedText: "quote",
      selectedMarkdown: "> quote",
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
  // Clipboard equals the full note but only a partial range was selected: if
  // insertMarkdown no-ops after preventDefault, recovery must still append.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# A\n\nB",
      clipboardText: "# A\n\nB",
      selectedText: "B",
      selectedMarkdown: "B",
    }),
    true,
  );
  // Select-all evidence via selection-scoped markdown still suppresses recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# A\n\nB",
      clipboardText: "# A\n\nB",
      selectedText: "A\n\nB",
      selectedMarkdown: "# A\n\nB",
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
  // Bold+strikethrough identical replace must not append a duplicate fragment.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "prefix **~~Hello~~** suffix",
      clipboardText: "**~~Hello~~**",
      selectedText: "Hello",
      selectedMarkdown: "**~~Hello~~**",
    }),
    false,
  );
  // Select-all code-span content change (`__x__` → `**x**`) must recover; do
  // not treat protected underscores inside backticks as equivalent emphasis.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "`__x__`",
      clipboardText: "`**x**`",
      selectedText: "__x__",
      selectedMarkdown: "`__x__`",
    }),
    true,
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
  // Literal visible `**Hello**` (source `\*\*Hello\*\*`) equals clipboard
  // `**Hello**` as plain strings, but is not an identical markdown replace.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n\\*\\*Hello\\*\\*",
      clipboardText: "**Hello**",
      selectedText: "**Hello**",
      selectedMarkdown: "\\*\\*Hello\\*\\*",
    }),
    true,
  );
  // Literal `# Heading` (source `\# Heading`) must recover when pasting a real heading.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n\\# Heading",
      clipboardText: "# Heading",
      selectedText: "# Heading",
      selectedMarkdown: "\\# Heading",
    }),
    true,
  );
  // Literal `- item` (source `\- item`) must recover when pasting a real list item.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Note\n\n\\- item",
      clipboardText: "- item",
      selectedText: "- item",
      selectedMarkdown: "\\- item",
    }),
    true,
  );
  // Single-block doc: selecting only rendered heading text must recover when
  // pasting the full heading — plain-text strip of `# Hello` is also `Hello`.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# Hello",
      clipboardText: "# Hello",
      selectedText: "Hello",
      selectedMarkdown: "Hello",
    }),
    true,
  );
  // Mixed marker run is not a thematic break; do not treat it as identical to ***.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n***\n\noutro",
      clipboardText: "-_*",
      selectedText: "",
      selectedMarkdown: "***",
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
  // Node selection: identical thematic-break replace must not append a duplicate.
  assert.equal(
    serializeLexicalNodeSelectionAsMarkdown([
      { getType: () => "horizontalrule", getParent: () => null },
    ]),
    "***",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n---\n\noutro",
      clipboardText: "---",
      selectedText: noteMarkdownClipboardToPlainText("***"),
      selectedMarkdown: "***",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n***\n\noutro",
      clipboardText: "***",
      selectedText: "",
      selectedMarkdown: "***",
    }),
    false,
  );
  // Node selection: identical table replace must not append a duplicate.
  const tableMarkdown = serializeMdastTableAsMarkdown({
    children: [
      {
        children: [
          { children: [{ type: "text", value: "A" }] },
          { children: [{ type: "text", value: "B" }] },
        ],
      },
      {
        children: [
          { children: [{ type: "text", value: "1" }] },
          { children: [{ type: "text", value: "2" }] },
        ],
      },
    ],
  });
  assert.equal(tableMarkdown, "| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(
    serializeLexicalNodeSelectionAsMarkdown([
      {
        getType: () => "table",
        getParent: () => null,
        getMdastNode: () => ({
          children: [
            {
              children: [
                { children: [{ type: "text", value: "A" }] },
                { children: [{ type: "text", value: "B" }] },
              ],
            },
            {
              children: [
                { children: [{ type: "text", value: "1" }] },
                { children: [{ type: "text", value: "2" }] },
              ],
            },
          ],
        }),
      },
    ]),
    tableMarkdown,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: `intro\n\n${tableMarkdown}\n\noutro`,
      clipboardText: "| A | B |\n| - | - |\n| 1 | 2 |",
      selectedText: noteMarkdownClipboardToPlainText(tableMarkdown ?? ""),
      selectedMarkdown: tableMarkdown,
    }),
    false,
  );
  // Formatted / linked table cells must keep inline Markdown (not plain "A").
  const formattedTableMarkdown = serializeMdastTableAsMarkdown({
    children: [
      {
        children: [
          { children: [{ type: "strong", children: [{ type: "text", value: "A" }] }] },
          {
            children: [{
              type: "link",
              url: "https://x.test",
              children: [{ type: "text", value: "B" }],
            }],
          },
        ],
      },
      {
        children: [
          { children: [{ type: "text", value: "1" }] },
          { children: [{ type: "text", value: "2" }] },
        ],
      },
    ],
  });
  assert.equal(
    formattedTableMarkdown,
    "| **A** | [B](https://x.test) |\n| --- | --- |\n| 1 | 2 |",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: `intro\n\n${formattedTableMarkdown}\n\noutro`,
      clipboardText: "| **A** | [B](https://x.test) |\n| --- | --- |\n| 1 | 2 |",
      selectedText: noteMarkdownClipboardToPlainText(formattedTableMarkdown ?? ""),
      selectedMarkdown: formattedTableMarkdown,
    }),
    false,
  );
});

test("didNoteMarkdownPasteApply distinguishes paste success from concurrent edits", () => {
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "# Note\n\nHello",
      afterMarkdown: "# Note\n\nHello",
      clipboardText: "**World**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    false,
  );
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "# Note\n\nHello",
      afterMarkdown: "# Note\n\n**World**",
      clipboardText: "**World**",
      selectedText: "Hello",
      selectedMarkdown: "Hello",
    }),
    true,
  );
  // Concurrent typing without the clipboard fragment is not paste success.
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "# Note\n\nHello",
      afterMarkdown: "# Note\n\nHello!",
      clipboardText: "**World**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    false,
  );
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "intro\n\n---\n\noutro",
      afterMarkdown: "intro\n\n***\n\noutro",
      clipboardText: "---",
      selectedText: "",
      selectedMarkdown: "***",
    }),
    true,
  );
  // Replacing a later duplicate of the selected fragment must still count as
  // success (first-occurrence rewrite would not match the editor result).
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "**new** / **old** / **old**",
      afterMarkdown: "**new** / **old** / **new**",
      clipboardText: "**new**",
      selectedText: "old",
      selectedMarkdown: "**old**",
    }),
    true,
  );
  // Collapsed caret insert still counts when the clipboard fragment already
  // existed elsewhere (presence-only checks would miss this success).
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "A **x** B",
      afterMarkdown: "A **x****x** B",
      clipboardText: "**x**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    true,
  );
});
