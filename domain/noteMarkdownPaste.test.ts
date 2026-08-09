import assert from "node:assert/strict";
import test from "node:test";

import {
  didNoteMarkdownPasteApply,
  doesSelectionEncompassLexicalBlock,
  mergeNoteMarkdownDocumentPaste,
  noteMarkdownClipboardToPlainText,
  normalizeNoteMarkdownForEquivalence,
  serializeLexicalCodeBlockAsMarkdown,
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
  // Single-character underscore emphasis must canonicalize (MDXEditor → *x*).
  assert.equal(normalizeNoteMarkdownForEquivalence("_x_"), "*x*");
  assert.equal(
    normalizeNoteMarkdownForEquivalence("# T\n\n_x_"),
    normalizeNoteMarkdownForEquivalence("# T\n\n*x*"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("__Hello__"),
    normalizeNoteMarkdownForEquivalence("**Hello**"),
  );
  // Hard breaks: backslash / two-trailing-spaces / bare newline (MDXEditor) equate.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("**A**\\\n**B**"),
    normalizeNoteMarkdownForEquivalence("**A**  \n**B**"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("**A**  \n**B**"),
    normalizeNoteMarkdownForEquivalence("**A**\n**B**"),
  );
  assert.equal(normalizeNoteMarkdownForEquivalence("**A**  \n**B**"), "**A**\n**B**");
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
  // Escaped `\)` must not end the destination early or `__id__` leaks into
  // emphasis canonicalization and looks identical to `**id**`.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("[x](https://host/a\\)b/__id__)"),
    "[x](https://host/a\\)b/__id__)",
  );
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("[x](https://host/a\\)b/__id__)"),
    normalizeNoteMarkdownForEquivalence("[x](https://host/a\\)b/**id**)"),
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
  // GFM tables without outer pipes match the serializer's piped form.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("A | B\n--- | ---\nC | D"),
    normalizeNoteMarkdownForEquivalence("| A | B |\n| --- | --- |\n| C | D |"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("A | B\n--- | ---\nC | D"),
    "| A | B |\n| --- | --- |\n| C | D |",
  );
  // Harmless intraword \_ escapes match unescaped clipboard spelling.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("# foo\\_bar"),
    normalizeNoteMarkdownForEquivalence("# foo_bar"),
  );
  assert.equal(normalizeNoteMarkdownForEquivalence("# foo\\_bar"), "# foo_bar");
  // Intentional escaped emphasis delimiters must stay inequivalent to real marks.
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("\\_foo\\_"),
    normalizeNoteMarkdownForEquivalence("_foo_"),
  );
  // Escaped closing strong delimiter must not canonicalize to **x** (would
  // suppress recovery when insertMarkdown no-ops over a bold selection).
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("__x\\__"),
    normalizeNoteMarkdownForEquivalence("**x**"),
  );
  // Closing `__` followed by an alphanumeric is not a CommonMark delimiter;
  // do not rewrite to `**` or identical-replace checks suppress recovery.
  assert.equal(normalizeNoteMarkdownForEquivalence("__x__y"), "__x__y");
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("# T\n\n__x__y"),
    normalizeNoteMarkdownForEquivalence("# T\n\n**x**y"),
  );
  // Escaped `]` in a link label must not end the label early or destination
  // `__id__` leaks into emphasis canonicalization.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("[a\\]b](https://x/__id__)"),
    "[a\\]b](https://x/__id__)",
  );
  assert.notEqual(
    normalizeNoteMarkdownForEquivalence("[a\\]b](https://x/__id__)"),
    normalizeNoteMarkdownForEquivalence("[a\\]b](https://x/**id**)"),
  );
  // List markers inside blockquotes match serializer `-` form.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("> * one\n> * two"),
    normalizeNoteMarkdownForEquivalence("> - one\n> - two"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence(">> * nested"),
    normalizeNoteMarkdownForEquivalence(">> - nested"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("> * [ ] task"),
    normalizeNoteMarkdownForEquivalence("> - [ ] task"),
  );
  // Ordered `1)` matches serializer / MDXEditor `1.` form.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("1) item\n2) next"),
    normalizeNoteMarkdownForEquivalence("1. item\n2. next"),
  );
  assert.equal(normalizeNoteMarkdownForEquivalence("1) item"), "1. item");
  assert.equal(
    normalizeNoteMarkdownForEquivalence("> 1) quoted"),
    normalizeNoteMarkdownForEquivalence("> 1. quoted"),
  );
  // Tilde fences match serializer backtick fences (same info / body).
  assert.equal(
    normalizeNoteMarkdownForEquivalence("~~~\ncode\n~~~"),
    normalizeNoteMarkdownForEquivalence("```\ncode\n```"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("~~~js\nx = 1\n~~~"),
    normalizeNoteMarkdownForEquivalence("```js\nx = 1\n```"),
  );
  assert.equal(
    normalizeNoteMarkdownForEquivalence("~~~js\nx = 1\n~~~"),
    "```js\nx = 1\n```",
  );
  // Fence body is not emphasis-rewritten; only the fence marker spelling changes.
  assert.equal(
    normalizeNoteMarkdownForEquivalence("~~~\n__x__\n~~~"),
    "```\n__x__\n```",
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
  // Literal backslash before punctuation must escape too (`a\*b` → `a\\\*b`).
  assert.equal(
    serializeLexicalSelectionAsMarkdown("a\\*b", {
      hasFormat: (type) => type === "bold",
      anchor: plainAnchor,
    }),
    "**a\\\\\\*b**",
  );
  // Literal backslash before a list opener must round-trip (`\- item` → `\\\- item`).
  assert.equal(
    serializeLexicalSelectionAsMarkdown("\\- item", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\\\\\- item",
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
  // Literal HTML openers must escape so a heading whose Lexical text is `<tag>`
  // reconstructs as `# \<tag>` (source spelling), not `# <tag>` (HTML node).
  assert.equal(
    serializeLexicalSelectionAsMarkdown("<tag>", {
      hasFormat: () => false,
      anchor: plainAnchor,
    }),
    "\\<tag>",
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
  // Literal `\` before `"` in a title must escape the backslash first.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("docs", {
      hasFormat: () => false,
      anchor: {
        getNode: () => ({
          getType: () => "link",
          getURL: () => "https://a.example",
          getTitle: () => 'say \\"hi\\"',
          getParent: () => null,
        }),
      },
    }),
    '[docs](https://a.example "say \\\\\\\"hi\\\\\\"")',
  );
  // Collapsed caret inside a link must serialize as empty (not `[](url)`).
  const caretLinkParagraph = {
    getType: () => "paragraph",
    getKey: () => "caret-p",
    getParent: () => null as null,
  };
  const caretLink = {
    getType: () => "link",
    getURL: () => "https://x.test",
    getKey: () => "caret-link",
    getParent: () => caretLinkParagraph,
  };
  const caretLinkText = {
    getType: () => "text",
    getKey: () => "caret-lt",
    getTextContent: () => "A",
    hasFormat: () => false,
    getParent: () => caretLink,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("", {
      hasFormat: () => false,
      anchor: { getNode: () => caretLinkText, offset: 1, type: "text" },
      focus: { getNode: () => caretLinkText, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [caretLinkText],
    }),
    "",
  );
  // Fallback path (no getNodes): empty selectedText must not become `[](url)`.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("", {
      hasFormat: () => false,
      anchor: { getNode: () => caretLinkText, offset: 1, type: "text" },
    }),
    "",
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

  // Whole-heading selection with HTML-looking Lexical text must escape `<`
  // so identical-replace evidence matches source `# \<tag>`.
  const htmlHeading = {
    getType: () => "heading",
    getTag: () => "h1",
    getKey: () => "h-html",
    getTextContent: () => "<tag>",
    getParent: () => null,
  };
  const htmlHeadingText = {
    getType: () => "text",
    getKey: () => "t-html",
    getTextContent: () => "<tag>",
    hasFormat: () => false,
    getParent: () => htmlHeading,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("<tag>", {
      hasFormat: () => false,
      anchor: { getNode: () => htmlHeadingText, offset: 0, type: "text" },
      focus: { getNode: () => htmlHeadingText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [htmlHeading, htmlHeadingText],
    }),
    "# \\<tag>",
  );

  // Range selections that include a thematic-break decorator must keep `***`
  // between blocks; dropping it misclassifies identical paste as a no-op.
  const paragraphA = {
    getType: () => "paragraph",
    getKey: () => "p-a",
    getTextContent: () => "A",
    getParent: () => null,
  };
  const paragraphB = {
    getType: () => "paragraph",
    getKey: () => "p-b",
    getTextContent: () => "B",
    getParent: () => null,
  };
  const paragraphAText = {
    getType: () => "text",
    getKey: () => "t-a",
    getTextContent: () => "A",
    hasFormat: () => false,
    getParent: () => paragraphA,
  };
  const paragraphBText = {
    getType: () => "text",
    getKey: () => "t-b",
    getTextContent: () => "B",
    hasFormat: () => false,
    getParent: () => paragraphB,
  };
  const thematicBreak = {
    getType: () => "horizontalrule",
    getKey: () => "hr-1",
    getParent: () => null,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A\n\nB", {
      hasFormat: () => false,
      anchor: { getNode: () => paragraphAText, offset: 0, type: "text" },
      focus: { getNode: () => paragraphBText, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        paragraphA,
        paragraphAText,
        thematicBreak,
        paragraphB,
        paragraphBText,
      ],
    }),
    "A\n\n***\n\nB",
  );

  // Range selections that include a fenced codeblock decorator must keep the
  // fence; dropping it misclassifies identical paste as a no-op.
  const codeBlockNode = {
    getType: () => "codeblock",
    getKey: () => "cb-1",
    getParent: () => null,
    getCode: () => "x = 1",
    getLanguage: () => "js",
    getMeta: () => "",
  };
  assert.equal(
    serializeLexicalCodeBlockAsMarkdown(codeBlockNode),
    "```js\nx = 1\n```",
  );
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A\n\nx = 1\n\nB", {
      hasFormat: () => false,
      anchor: { getNode: () => paragraphAText, offset: 0, type: "text" },
      focus: { getNode: () => paragraphBText, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        paragraphA,
        paragraphAText,
        codeBlockNode,
        paragraphB,
        paragraphBText,
      ],
    }),
    "A\n\n```js\nx = 1\n```\n\nB",
  );
  assert.equal(
    serializeLexicalNodeSelectionAsMarkdown([codeBlockNode]),
    "```js\nx = 1\n```",
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
  // Nested ordered lists indent by ancestor marker width (`1. ` → 3, `10. ` → 4).
  type NestedOrderedPasteNode = {
    getType: () => string;
    getKey: () => string;
    getTextContent: () => string;
    getParent: () => NestedOrderedPasteNode | null;
    getChildren?: () => NestedOrderedPasteNode[];
    getListType?: () => "number";
    getValue?: () => number;
    hasFormat?: () => boolean;
  };
  const orderedOuterList: NestedOrderedPasteNode = {
    getType: () => "list",
    getKey: () => "ol-outer",
    getListType: () => "number",
    getTextContent: () => "parent\nchild",
    getParent: () => null,
  };
  const orderedParentItem: NestedOrderedPasteNode = {
    getType: () => "listitem",
    getKey: () => "oli-parent",
    getValue: () => 1,
    getTextContent: () => "parent\nchild",
    getParent: () => orderedOuterList,
  };
  const orderedParentText: NestedOrderedPasteNode = {
    getType: () => "text",
    getKey: () => "ot-parent",
    getTextContent: () => "parent",
    hasFormat: () => false,
    getParent: () => orderedParentItem,
  };
  const orderedInnerList: NestedOrderedPasteNode = {
    getType: () => "list",
    getKey: () => "ol-inner",
    getListType: () => "number",
    getTextContent: () => "child",
    getParent: () => orderedParentItem,
  };
  const orderedChildItem: NestedOrderedPasteNode = {
    getType: () => "listitem",
    getKey: () => "oli-child",
    getValue: () => 1,
    getTextContent: () => "child",
    getParent: () => orderedInnerList,
  };
  const orderedChildText: NestedOrderedPasteNode = {
    getType: () => "text",
    getKey: () => "ot-child",
    getTextContent: () => "child",
    hasFormat: () => false,
    getParent: () => orderedChildItem,
  };
  orderedParentItem.getChildren = () => [orderedParentText, orderedInnerList];
  orderedChildItem.getChildren = () => [orderedChildText];
  assert.equal(
    serializeLexicalSelectionAsMarkdown("parent\nchild", {
      hasFormat: () => false,
      anchor: { getNode: () => orderedParentText, offset: 0, type: "text" },
      focus: { getNode: () => orderedChildText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        orderedParentItem,
        orderedParentText,
        orderedChildItem,
        orderedChildText,
      ],
    }),
    "1. parent\n   1. child",
  );
  orderedParentItem.getValue = () => 10;
  assert.equal(
    serializeLexicalSelectionAsMarkdown("parent\nchild", {
      hasFormat: () => false,
      anchor: { getNode: () => orderedParentText, offset: 0, type: "text" },
      focus: { getNode: () => orderedChildText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        orderedParentItem,
        orderedParentText,
        orderedChildItem,
        orderedChildText,
      ],
    }),
    "10. parent\n    1. child",
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
  // Serializer escapes intraword `_`; clipboard often omits the backslash.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# foo\\_bar",
      clipboardText: "# foo_bar",
      selectedText: "foo_bar",
      selectedMarkdown: "# foo\\_bar",
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

  // Literal `]` in link labels must escape so identical-replace checks see
  // `[a\]b](url)`, not a broken `[a]b](url)` wrapper.
  const bracketParagraph = {
    getType: () => "paragraph",
    getKey: () => "bracket-p",
    getParent: () => null,
  };
  const bracketLink = {
    getType: () => "link",
    getURL: () => "https://example.test",
    getKey: () => "bracket-link",
    getParent: () => bracketParagraph,
  };
  const bracketLinkText = {
    getType: () => "text",
    getKey: () => "bracket-t",
    getTextContent: () => "a]b",
    hasFormat: () => false,
    getParent: () => bracketLink,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("a]b", {
      hasFormat: () => false,
      anchor: { getNode: () => bracketLinkText, offset: 0, type: "text" },
      focus: { getNode: () => bracketLinkText, offset: 3, type: "text" },
      isBackward: () => false,
      getNodes: () => [bracketLink, bracketLinkText],
    }),
    "[a\\]b](https://example.test)",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [a\\]b](https://example.test) end",
      clipboardText: "[a\\]b](https://example.test)",
      selectedText: "a]b",
      selectedMarkdown: "[a\\]b](https://example.test)",
    }),
    false,
  );

  // Decoded destinations with an unmatched `)` must re-escape so identical
  // paste of `[x](https://example.test/a\)b)` is not misclassified as failed.
  const parenDestParagraph = {
    getType: () => "paragraph",
    getKey: () => "paren-dest-p",
    getParent: () => null,
  };
  const parenDestLink = {
    getType: () => "link",
    getURL: () => "https://example.test/a)b",
    getKey: () => "paren-dest-link",
    getParent: () => parenDestParagraph,
  };
  const parenDestText = {
    getType: () => "text",
    getKey: () => "paren-dest-t",
    getTextContent: () => "x",
    hasFormat: () => false,
    getParent: () => parenDestLink,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("x", {
      hasFormat: () => false,
      anchor: { getNode: () => parenDestText, offset: 0, type: "text" },
      focus: { getNode: () => parenDestText, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [parenDestLink, parenDestText],
    }),
    "[x](https://example.test/a\\)b)",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [x](https://example.test/a\\)b) end",
      clipboardText: "[x](https://example.test/a\\)b)",
      selectedText: "x",
      selectedMarkdown: "[x](https://example.test/a\\)b)",
    }),
    false,
  );
  // Escaped `\)` before underscore runs: different destinations must recover.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [x](https://host/a\\)b/__id__) end",
      clipboardText: "[x](https://host/a\\)b/**id**)",
      selectedText: "x",
      selectedMarkdown: "[x](https://host/a\\)b/__id__)",
    }),
    true,
  );
  // Balanced destination parentheses stay bare (clipboard / MDXEditor form).
  const balancedDestLink = {
    getType: () => "link",
    getURL: () => "https://example.test/a_(b)",
    getKey: () => "balanced-dest-link",
    getParent: () => parenDestParagraph,
  };
  const balancedDestText = {
    getType: () => "text",
    getKey: () => "balanced-dest-t",
    getTextContent: () => "docs",
    hasFormat: () => false,
    getParent: () => balancedDestLink,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("docs", {
      hasFormat: () => false,
      anchor: { getNode: () => balancedDestText, offset: 0, type: "text" },
      focus: { getNode: () => balancedDestText, offset: 4, type: "text" },
      isBackward: () => false,
      getNodes: () => [balancedDestLink, balancedDestText],
    }),
    "[docs](https://example.test/a_(b))",
  );

  // Lexical linebreak nodes match MDXEditor export (bare newline, not `  \n`).
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
    "**A**\n**B**",
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

  // Mid-line formatting boundaries are not Markdown line starts: `A **# B**`
  // must not escape `#` (MDXEditor serializes without `\#`).
  const midLineHashParagraph = {
    getType: () => "paragraph",
    getKey: () => "mid-hash-p",
    getTextContent: () => "A # B",
    getParent: () => null,
  };
  const midLineHashPlain = {
    getType: () => "text",
    getKey: () => "mid-hash-plain",
    getTextContent: () => "A ",
    hasFormat: () => false,
    getParent: () => midLineHashParagraph,
  };
  const midLineHashBold = {
    getType: () => "text",
    getKey: () => "mid-hash-bold",
    getTextContent: () => "# B",
    hasFormat: (type: string) => type === "bold",
    getParent: () => midLineHashParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A # B", {
      hasFormat: () => false,
      anchor: { getNode: () => midLineHashPlain, offset: 0, type: "text" },
      focus: { getNode: () => midLineHashBold, offset: 3, type: "text" },
      isBackward: () => false,
      getNodes: () => [midLineHashPlain, midLineHashBold],
    }),
    "A **# B**",
  );
  // Bold-only `# Heading` at line start still keeps `#` unescaped after markers.
  assert.equal(
    serializeLexicalSelectionAsMarkdown("# Heading", {
      hasFormat: (type) => type === "bold",
      anchor: plainAnchor,
    }),
    "**# Heading**",
  );

  // Inline code with both-end spaces needs pad spaces so CommonMark keeps them.
  const spacedCodeParagraph = {
    getType: () => "paragraph",
    getKey: () => "spaced-code-p",
    getTextContent: () => " foo ",
    getParent: () => null,
  };
  const spacedCodeText = {
    getType: () => "text",
    getKey: () => "spaced-code-text",
    getTextContent: () => " foo ",
    hasFormat: (type: string) => type === "code",
    getParent: () => spacedCodeParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown(" foo ", {
      hasFormat: () => false,
      anchor: { getNode: () => spacedCodeText, offset: 0, type: "text" },
      focus: { getNode: () => spacedCodeText, offset: 5, type: "text" },
      isBackward: () => false,
      getNodes: () => [spacedCodeText],
    }),
    "`  foo  `",
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

  // Outer bold spanning text before/inside/after a link must stay outside the
  // link (`**A [B](url) C**`), not close at the link boundary.
  const linkSpanParagraph = {
    getType: () => "paragraph",
    getKey: () => "link-span-p",
    getTextContent: () => "A B C",
    getParent: () => null,
  };
  const linkSpanLink = {
    getType: () => "link",
    getURL: () => "https://x.test",
    getKey: () => "link-span-link",
    getParent: () => linkSpanParagraph,
  };
  const linkSpanBefore = {
    getType: () => "text",
    getKey: () => "link-span-a",
    getTextContent: () => "A ",
    hasFormat: (type: string) => type === "bold",
    getParent: () => linkSpanParagraph,
  };
  const linkSpanLabel = {
    getType: () => "text",
    getKey: () => "link-span-b",
    getTextContent: () => "B",
    hasFormat: (type: string) => type === "bold",
    getParent: () => linkSpanLink,
  };
  const linkSpanAfter = {
    getType: () => "text",
    getKey: () => "link-span-c",
    getTextContent: () => " C",
    hasFormat: (type: string) => type === "bold",
    getParent: () => linkSpanParagraph,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A B C", {
      hasFormat: () => false,
      anchor: { getNode: () => linkSpanBefore, offset: 0, type: "text" },
      focus: { getNode: () => linkSpanAfter, offset: 2, type: "text" },
      isBackward: () => false,
      getNodes: () => [linkSpanBefore, linkSpanLink, linkSpanLabel, linkSpanAfter],
    }),
    "**A [B](https://x.test) C**",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "**A [B](https://x.test) C**",
      clipboardText: "**A [B](https://x.test) C**",
      selectedText: "A B C",
      selectedMarkdown: "**A [B](https://x.test) C**",
    }),
    false,
  );

  // Outer bold that ends inside a link label must close before `[`, not wrap the
  // whole link (`**A **[**B** C](url)`, not `**A [B C](url)**`).
  const partialLinkParagraph = {
    getType: () => "paragraph",
    getKey: () => "partial-link-p",
    getTextContent: () => "A B C",
    getParent: () => null,
  };
  const partialLink = {
    getType: () => "link",
    getURL: () => "https://x.test",
    getKey: () => "partial-link",
    getParent: () => partialLinkParagraph,
  };
  const partialLinkBefore = {
    getType: () => "text",
    getKey: () => "partial-link-a",
    getTextContent: () => "A ",
    hasFormat: (type: string) => type === "bold",
    getParent: () => partialLinkParagraph,
  };
  const partialLinkBoldLabel = {
    getType: () => "text",
    getKey: () => "partial-link-b",
    getTextContent: () => "B",
    hasFormat: (type: string) => type === "bold",
    getParent: () => partialLink,
  };
  const partialLinkPlainLabel = {
    getType: () => "text",
    getKey: () => "partial-link-c",
    getTextContent: () => " C",
    hasFormat: () => false,
    getParent: () => partialLink,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A B C", {
      hasFormat: () => false,
      anchor: { getNode: () => partialLinkBefore, offset: 0, type: "text" },
      focus: { getNode: () => partialLinkPlainLabel, offset: 2, type: "text" },
      isBackward: () => false,
      getNodes: () => [
        partialLinkBefore,
        partialLink,
        partialLinkBoldLabel,
        partialLinkPlainLabel,
      ],
    }),
    "**A **[**B** C](https://x.test)",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "**A **[**B** C](https://x.test)",
      clipboardText: "**A **[**B** C](https://x.test)",
      selectedText: "A B C",
      selectedMarkdown: "**A **[**B** C](https://x.test)",
    }),
    false,
  );

  // Multi-paragraph blockquote: blank separator stays quoted (`> A\n>\n> B`)
  // like MDXEditor, not an unquoted gap (`> A\n\n> B`).
  const multiQuote = {
    getType: () => "quote",
    getKey: () => "multi-quote",
    getTextContent: () => "AB",
    getParent: () => null,
  };
  const multiQuoteP1 = {
    getType: () => "paragraph",
    getKey: () => "multi-quote-p1",
    getTextContent: () => "A",
    getParent: () => multiQuote,
  };
  const multiQuoteP2 = {
    getType: () => "paragraph",
    getKey: () => "multi-quote-p2",
    getTextContent: () => "B",
    getParent: () => multiQuote,
  };
  const multiQuoteT1 = {
    getType: () => "text",
    getKey: () => "multi-quote-t1",
    getTextContent: () => "A",
    hasFormat: () => false,
    getParent: () => multiQuoteP1,
  };
  const multiQuoteT2 = {
    getType: () => "text",
    getKey: () => "multi-quote-t2",
    getTextContent: () => "B",
    hasFormat: () => false,
    getParent: () => multiQuoteP2,
  };
  assert.equal(
    serializeLexicalSelectionAsMarkdown("A\n\nB", {
      hasFormat: () => false,
      anchor: { getNode: () => multiQuoteT1, offset: 0, type: "text" },
      focus: { getNode: () => multiQuoteT2, offset: 1, type: "text" },
      isBackward: () => false,
      getNodes: () => [multiQuote, multiQuoteP1, multiQuoteT1, multiQuoteP2, multiQuoteT2],
    }),
    "> A\n>\n> B",
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "> A\n>\n> B",
      clipboardText: "> A\n>\n> B",
      selectedText: "A\n\nB",
      selectedMarkdown: "> A\n>\n> B",
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
    "**A**\n**B**\n\nC",
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
  // Single-character underscore italic ≡ serializer `*x*`; do not append a duplicate.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# T\n\n*x*",
      clipboardText: "# T\n\n_x_",
      selectedText: "T\nx",
      selectedMarkdown: "# T\n\n*x*",
    }),
    false,
  );
  // Escaped closing `__` is not real strong emphasis; lost-selection no-op must recover.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "**x**",
      clipboardText: "__x\\__",
      selectedText: "x",
      selectedMarkdown: "**x**",
    }),
    true,
  );
  // Quoted list marker spelling (`*` vs `-`) is an identical replace, not a no-op.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "> - one",
      clipboardText: "> * one",
      selectedText: "one",
      selectedMarkdown: "> - one",
    }),
    false,
  );
  // Ordered `1)` clipboard vs serializer `1.` must not append a duplicate list.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "1. item\n2. next",
      clipboardText: "1) item\n2) next",
      selectedText: "item\nnext",
      selectedMarkdown: "1. item\n2. next",
    }),
    false,
  );
  // Tilde-fenced clipboard vs backtick selection must not append a duplicate block.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "A\n\n```js\nx = 1\n```\n\nB",
      clipboardText: "~~~js\nx = 1\n~~~",
      selectedText: "x = 1",
      selectedMarkdown: "```js\nx = 1\n```",
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
  // Fully selected heading whose Lexical text is `<tag>` must match source
  // `# \<tag>` so identical paste does not append a duplicate via recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# \\<tag>",
      clipboardText: "# \\<tag>",
      selectedText: "<tag>",
      selectedMarkdown: "# \\<tag>",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# \\<tag>",
      clipboardText: "# \\<tag>",
      selectedText: "<tag>",
      // Unescaped reconstruction parses as HTML and must not suppress recovery.
      selectedMarkdown: "# <tag>",
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
  // Intraword `__…__` is not strong emphasis; pasting `**x**y` over `__x__y`
  // must recover when insertMarkdown no-ops after losing selection.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "# T\n\n__x__y",
      clipboardText: "# T\n\n**x**y",
      selectedText: "Txy",
      selectedMarkdown: "# T\n\n__x__y",
    }),
    true,
  );
  // Escaped `]` in the label must keep destinations distinct for recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "see [a\\]b](https://x/__id__) end",
      clipboardText: "[a\\]b](https://x/**id**)",
      selectedText: "a]b",
      selectedMarkdown: "[a\\]b](https://x/__id__)",
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
  // Identical hard-break fragment must not append a duplicate (MDXEditor bare
  // newline, CommonMark two-space, and backslash forms are equivalent).
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n**A**\n**B**\n\noutro",
      clipboardText: "**A**\n**B**",
      selectedText: "A\nB",
      selectedMarkdown: "**A**\n**B**",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n**A**\n**B**\n\noutro",
      clipboardText: "**A**  \n**B**",
      selectedText: "A\nB",
      selectedMarkdown: "**A**\n**B**",
    }),
    false,
  );
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "intro\n\n**A**\n**B**\n\noutro",
      clipboardText: "**A**\\\n**B**",
      selectedText: "A\nB",
      selectedMarkdown: "**A**\n**B**",
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
  // Titles with literal backslash+quote must round-trip after escaping.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: 'see [docs](https://a.example "say \\\\\\\"hi\\\\\\"") end',
      clipboardText: '[docs](https://a.example "say \\\\\\\"hi\\\\\\"")',
      selectedText: "docs",
      selectedMarkdown: '[docs](https://a.example "say \\\\\\\"hi\\\\\\"")',
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
  // Range selection across a thematic break must suppress identical-replace recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "A\n\n***\n\nB",
      clipboardText: "A\n\n***\n\nB",
      selectedText: "A\n\nB",
      selectedMarkdown: "A\n\n***\n\nB",
    }),
    false,
  );
  // Range selection across a codeblock must suppress identical-replace recovery.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: "A\n\n```js\nx = 1\n```\n\nB",
      clipboardText: "A\n\n```js\nx = 1\n```\n\nB",
      selectedText: "A\n\nx = 1\n\nB",
      selectedMarkdown: "A\n\n```js\nx = 1\n```\n\nB",
    }),
    false,
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
  // Valid GFM without outer pipes must not append a duplicate after identical replace.
  assert.equal(
    shouldRecoverNoteMarkdownPasteAfterUnchangedInsert({
      beforeMarkdown: `intro\n\n${tableMarkdown}\n\noutro`,
      clipboardText: "A | B\n--- | ---\n1 | 2",
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
  // Collapsed caret inside a link must use the caret branch (empty selectedMarkdown),
  // not a nonempty `[](url)` serialization that rejects a successful insert.
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "[A](https://x.test) / **x**",
      afterMarkdown: "[A](https://x.test) / **x****x**",
      clipboardText: "**x**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    true,
  );
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "[A](https://x.test) / **x**",
      afterMarkdown: "[A](https://x.test) / **x****x**",
      clipboardText: "**x**",
      selectedText: "",
      selectedMarkdown: "[](https://x.test)",
    }),
    false,
  );
  // Successful paste plus typing during the recovery frames must not look like
  // a failed insert (document-append would then duplicate the fragment).
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "A **x** B",
      afterMarkdown: "A **x****x**! B",
      clipboardText: "**x**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    true,
  );
  // Typing alone (no paste) is still not success.
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: "A **x** B",
      afterMarkdown: "A **x** B!",
      clipboardText: "**x**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    false,
  );
  // Paste-at-end on a long note must stay linear (not a per-index rebuild).
  const longBefore = `${"word ".repeat(4000)}end`;
  const longClipboard = "**pasted**";
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: longBefore,
      afterMarkdown: `${longBefore}${longClipboard}`,
      clipboardText: longClipboard,
      selectedText: "",
      selectedMarkdown: "",
    }),
    true,
  );
  // Failed paste + concurrent typing over many repeated fragments must not
  // rebuild/rescan a full document per occurrence (UI-blocking on large notes).
  const repeated = "**x** ".repeat(10_000);
  const typedAfter = `${repeated}typed!`;
  const started = Date.now();
  assert.equal(
    didNoteMarkdownPasteApply({
      beforeMarkdown: repeated,
      afterMarkdown: typedAfter,
      clipboardText: "**x**",
      selectedText: "",
      selectedMarkdown: "",
    }),
    false,
  );
  assert.ok(Date.now() - started < 500);
});
