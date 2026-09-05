import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import {
  annotateNoteCodeBlockDeleteButtons,
  createNoteDecorationMutationScheduler,
  getHostPickerTriggerRange,
  getNoteDecorationMutationDelay,
  getRenderedNoteHeadingText,
  isNoteSmallImageWidth,
  isNoteMathLanguageLabel,
  isSupportedNoteExternalHref,
  isPointerInsideLinkActionHoverZone,
  invokeNoteEditorDialogAction,
  linkActionStatesEqual,
  NOTE_SMALL_IMAGE_MAX_WIDTH,
  NOTE_EDIT_DECORATION_DEBOUNCE_MS,
  resolveHostPickerPopupPosition,
  scrollNoteHeadingIntoView,
  shouldApplyExternalNoteMarkdown,
  shouldRenderNoteMathFormula,
  shouldInsertClipboardTextAsMarkdown,
  shouldHandleHostPickerNavigationKey,
} from "./InlineMarkdownEditor.tsx";
import { getSourceEditDelta, shouldCoalesceSourceUndoStep } from "./NoteSourceEditor.tsx";

test("source undo history coalesces only adjacent edits of the same typing kind", () => {
  const previous = { inputType: "insertText", at: 1_000, caret: 2 };
  const adjacentInsert = getSourceEditDelta("ab", "abc");
  const movedCaretInsert = getSourceEditDelta("ab", "axb");
  assert.equal(shouldCoalesceSourceUndoStep(previous, "insertText", 1_500, adjacentInsert), true);
  assert.equal(shouldCoalesceSourceUndoStep(previous, "insertText", 1_500, movedCaretInsert), false);
  assert.equal(shouldCoalesceSourceUndoStep(previous, "insertText", 1_751, adjacentInsert), false);
  assert.equal(shouldCoalesceSourceUndoStep(previous, "deleteContentBackward", 1_100, adjacentInsert), false);
  assert.equal(shouldCoalesceSourceUndoStep(previous, "insertFromPaste", 1_100, adjacentInsert), false);
  assert.equal(shouldCoalesceSourceUndoStep(null, "insertText", 1_100, adjacentInsert), false);
});

test("math language detection does not mistake plain text blocks for TeX", () => {
  assert.equal(isNoteMathLanguageLabel("math"), false);
  assert.equal(isNoteMathLanguageLabel("Math (LaTeX)"), false);
  assert.equal(isNoteMathLanguageLabel("language-latex"), true);
  assert.equal(isNoteMathLanguageLabel("language-tex highlighted"), true);
  assert.equal(isNoteMathLanguageLabel("latex"), true);
  assert.equal(isNoteMathLanguageLabel("tex"), true);
  assert.equal(isNoteMathLanguageLabel("公式"), false);
  assert.equal(isNoteMathLanguageLabel("text"), false);
  assert.equal(isNoteMathLanguageLabel("plaintext"), false);
  assert.equal(isNoteMathLanguageLabel("typescript"), false);
  assert.equal(shouldRenderNoteMathFormula("Plain text"), false);
  assert.equal(shouldRenderNoteMathFormula("plaintext"), false);
  assert.equal(shouldRenderNoteMathFormula(""), false);
  assert.equal(shouldRenderNoteMathFormula("math"), false);
  assert.equal(shouldRenderNoteMathFormula("latex"), true);
  assert.equal(shouldRenderNoteMathFormula("tex"), true);
});

test("live note decoration scans are debounced while preview mounts stay immediate", () => {
  assert.equal(getNoteDecorationMutationDelay("edit"), NOTE_EDIT_DECORATION_DEBOUNCE_MS);
  assert.equal(getNoteDecorationMutationDelay("live"), NOTE_EDIT_DECORATION_DEBOUNCE_MS);
  assert.equal(getNoteDecorationMutationDelay("preview"), 0);

  let nextId = 1;
  let runCount = 0;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();
  const runtime = {
    requestFrame: (callback: () => void) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id: number) => { frames.delete(id); },
    setTimer: (callback: () => void, delay: number) => {
      assert.equal(delay, NOTE_EDIT_DECORATION_DEBOUNCE_MS);
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id: number) => { timers.delete(id); },
  };

  const editScheduler = createNoteDecorationMutationScheduler("edit", () => { runCount += 1; }, runtime);
  editScheduler.schedule();
  editScheduler.schedule();
  editScheduler.schedule();
  assert.equal(runCount, 0);
  assert.equal(timers.size, 1);
  const pendingEdit = [...timers.values()][0];
  timers.clear();
  pendingEdit();
  assert.equal(runCount, 1);

  editScheduler.schedule();
  assert.equal(timers.size, 1);
  const cancelledEdit = [...timers.values()][0];
  editScheduler.cancel();
  assert.equal(timers.size, 0);
  cancelledEdit();
  assert.equal(runCount, 1);

  const previewScheduler = createNoteDecorationMutationScheduler("preview", () => { runCount += 1; }, runtime);
  previewScheduler.schedule();
  previewScheduler.schedule();
  assert.equal(frames.size, 1);
  const pendingPreview = [...frames.values()][0];
  frames.clear();
  pendingPreview();
  assert.equal(runCount, 2);
});

test("note link and image actions open the editor dialogs", () => {
  const opened: string[] = [];
  const dialogs = {
    openImageDialog: () => opened.push("image"),
    openLinkDialog: () => opened.push("link"),
  };

  assert.equal(invokeNoteEditorDialogAction("link", dialogs), true);
  assert.equal(invokeNoteEditorDialogAction("image", dialogs), true);
  assert.equal(invokeNoteEditorDialogAction("bold", dialogs), false);
  assert.equal(invokeNoteEditorDialogAction("link", null), false);
  assert.deepEqual(opened, ["link", "image"]);
});

test("toolbar text selection is restricted to the note editor", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /if \(domText\) \{/);
  assert.match(source, /domSelection && domSelection\.rangeCount > 0 && container/);
  assert.match(source, /container\.contains\(range\.startContainer\)/);
  assert.match(source, /container\.contains\(range\.endContainer\)/);
  assert.match(source, /return domText;[\s\S]*return "";[\s\S]*querySelector\("\[contenteditable\]"\)/);
});

test("note outline jumps to the matching rendered heading", () => {
  let scrollOptions: ScrollIntoViewOptions | undefined;
  const first = {
    tagName: "H1",
    textContent: "Quoted",
    scrollIntoView: () => undefined,
  } as unknown as HTMLElement;
  const second = {
    tagName: "H2",
    textContent: "Real",
    scrollIntoView: (options?: ScrollIntoViewOptions) => {
      scrollOptions = options;
    },
  } as unknown as HTMLElement;
  const root = {
    querySelectorAll: (selector: string) => {
      assert.match(selector, /\.netcatty-mdx-content h1/);
      assert.match(selector, /\.netcatty-mdx-content h6/);
      return [first, second];
    },
  };

  assert.equal(scrollNoteHeadingIntoView(root, { level: 2, text: "Real" }), true);
  assert.deepEqual(scrollOptions, {
    behavior: "smooth",
    block: "start",
    inline: "nearest",
  });
  assert.equal(scrollNoteHeadingIntoView(root, { level: 3, text: "Missing" }), false);
  assert.equal(scrollNoteHeadingIntoView(null, { level: 1, text: "None" }), false);
});

test("note outline matches rendered whitespace and strikethrough heading text", () => {
  let scrolled = false;
  const renderedHeading = {
    tagName: "H2",
    textContent: "Removed\n title",
    scrollIntoView: () => {
      scrolled = true;
    },
  } as unknown as HTMLElement;
  const root = {
    querySelectorAll: () => [renderedHeading],
  };

  assert.equal(scrollNoteHeadingIntoView(root, { level: 2, text: "Removed title" }), true);
  assert.equal(scrolled, true);
});

test("note outline matches image alt text inside rendered headings", () => {
  const textNode = (textContent: string) => ({ nodeType: 3, textContent, childNodes: [] });
  const imageNode = (alt: string) => ({
    nodeType: 1,
    tagName: "IMG",
    textContent: "",
    childNodes: [],
    getAttribute: (name: string) => name === "alt" ? alt : null,
  });
  let scrolled = 0;
  const imageHeading = {
    tagName: "H2",
    textContent: "",
    childNodes: [imageNode("Logo")],
    scrollIntoView: () => { scrolled += 1; },
  } as unknown as HTMLElement;
  const mixedHeading = {
    tagName: "H2",
    textContent: "Release  notes",
    childNodes: [textNode("Release "), imageNode("Logo"), textNode(" notes")],
    scrollIntoView: () => { scrolled += 1; },
  } as unknown as HTMLElement;
  const root = { querySelectorAll: () => [imageHeading, mixedHeading] };

  assert.equal(getRenderedNoteHeadingText(imageHeading), "Logo");
  assert.equal(getRenderedNoteHeadingText(mixedHeading), "Release Logo notes");
  assert.equal(scrollNoteHeadingIntoView(root, { level: 2, text: "Logo" }), true);
  assert.equal(scrollNoteHeadingIntoView(root, { level: 2, text: "Release Logo notes" }), true);
  assert.equal(scrolled, 2);
});

test("host picker navigation keys are handled even before a query is typed", () => {
  assert.equal(shouldHandleHostPickerNavigationKey(true, "ArrowDown", 3), true);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "ArrowUp", 3), true);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "Enter", 3), true);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "Tab", 3), true);
});

test("host picker uses a constrained virtual list and keeps pointer selection", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /FixedSizeVirtualList/);
  assert.match(source, /ref=\{hostPickerListRef\}/);
  assert.match(source, /HOST_PICKER_LIST_MAX_HEIGHT/);
  assert.match(
    source,
    /filteredHosts\.length === 0\s*\?\s*HOST_PICKER_EMPTY_HEIGHT\s*:\s*HOST_PICKER_LIST_VERTICAL_PADDING \+ filteredHosts\.length \* HOST_PICKER_ROW_HEIGHT/,
  );
  assert.match(source, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(source, /onClick=\{\(\) => insertHostLink\(host\)\}/);
});

test("host picker still lets ordinary trigger text continue through the editor", () => {
  assert.equal(shouldHandleHostPickerNavigationKey(true, "@", 3), false);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "/", 3), false);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "a", 3), false);
});

test("host picker does not consume submit keys when there are no hosts to choose", () => {
  assert.equal(shouldHandleHostPickerNavigationKey(true, "ArrowDown", 0), false);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "Enter", 0), false);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "Escape", 0), true);
});

test("link action hover zone keeps the open button reachable but not sticky", () => {
  const action = { href: "https://example.com", label: "example", left: 100, top: 50 };

  assert.equal(isPointerInsideLinkActionHoverZone(action, 105, 55), true);
  assert.equal(isPointerInsideLinkActionHoverZone(action, 95, 45), true);
  assert.equal(isPointerInsideLinkActionHoverZone(action, 160, 55), false);
  assert.equal(isPointerInsideLinkActionHoverZone(null, 105, 55), false);
});

test("link action state equality skips identical hover chips", () => {
  const a = { href: "https://example.com", label: "example", left: 100, top: 50 };
  assert.equal(linkActionStatesEqual(a, { ...a }), true);
  assert.equal(linkActionStatesEqual(a, { ...a, left: 101 }), false);
  assert.equal(linkActionStatesEqual(a, null), false);
  assert.equal(linkActionStatesEqual(null, null), true);
});

test("small note image width threshold matches README badge sizes", () => {
  assert.equal(isNoteSmallImageWidth(32), true);
  assert.equal(isNoteSmallImageWidth("96"), true);
  assert.equal(isNoteSmallImageWidth(NOTE_SMALL_IMAGE_MAX_WIDTH), true);
  assert.equal(isNoteSmallImageWidth(128), false);
  assert.equal(isNoteSmallImageWidth(2000), false);
  assert.equal(isNoteSmallImageWidth(""), false);
  assert.equal(isNoteSmallImageWidth(null), false);
});

test("note image actions use a bordered toolbar shown only on hover or focus", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\[data-editor-block-type="image"\] \[class\*="_editImageToolbar_"\][\s\S]*?gap:\s*0\.0625rem;[\s\S]*?padding:\s*0\.125rem;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;[\s\S]*?border:\s*1px solid/s,
  );
  assert.match(
    styles,
    /\[data-editor-block-type="image"\] \[class\*="_editImageToolbar_"\] button,[\s\S]*?width:\s*1\.375rem;[\s\S]*?height:\s*1\.375rem;/s,
  );
  assert.match(
    styles,
    /\[data-editor-block-type="image"\] \[class\*="_editImageToolbar_"\] button svg,[\s\S]*?width:\s*0\.875rem;[\s\S]*?height:\s*0\.875rem;/s,
  );
  assert.match(
    styles,
    /\[data-editor-block-type="image"\]:hover \[class\*="_editImageToolbar_"\][\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/s,
  );
  assert.match(
    styles,
    /\[data-editor-block-type="image"\]:focus-within \[class\*="_editImageToolbar_"\]/,
  );
  assert.doesNotMatch(
    styles,
    /\[data-editor-block-type="image"\]\[data-note-img-size="sm"\] \[class\*="_editImageToolbar_"\]/,
  );
});

test("host picker trigger range only covers the typed trigger and query", () => {
  const text = "before\n\n@10.2.0.32";
  const range = getHostPickerTriggerRange(text);

  assert.deepEqual(range, {
    query: "10.2.0.32",
    startOffset: "before\n\n".length,
    trigger: "@",
  });
  assert.equal(text.slice(0, range?.startOffset), "before\n\n");
});

test("host picker trigger range supports slash without stealing ordinary text", () => {
  assert.deepEqual(getHostPickerTriggerRange("run /prod"), {
    query: "prod",
    startOffset: "run ".length,
    trigger: "/",
  });
  assert.equal(getHostPickerTriggerRange("email foo@bar"), null);
});

test("host picker opens above the caret when the bottom edge has no room", () => {
  const position = resolveHostPickerPopupPosition({
    anchorRect: { left: 520, top: 910, bottom: 930, width: 1, height: 20 },
    containerRect: { left: 400, top: 40, bottom: 960, width: 1200, height: 920 },
    availableHostCount: 8,
    viewportHeight: 960,
  });

  assert.equal(position.left, 120);
  assert.ok(position.top < 870);
});

test("host picker stays below the caret when there is enough room", () => {
  const position = resolveHostPickerPopupPosition({
    anchorRect: { left: 520, top: 160, bottom: 180, width: 1, height: 20 },
    containerRect: { left: 400, top: 40, bottom: 960, width: 1200, height: 920 },
    availableHostCount: 4,
    viewportHeight: 960,
  });

  assert.equal(position.left, 120);
  assert.equal(position.top, 150);
});

test("pasted markdown is detected only when it has renderable structure", () => {
  assert.equal(shouldInsertClipboardTextAsMarkdown("# Runbook\n\n- restart sshd"), true);
  assert.equal(shouldInsertClipboardTextAsMarkdown("Open [docs](https://example.com)"), true);
  assert.equal(shouldInsertClipboardTextAsMarkdown("```sh\nuptime\n```"), true);
  assert.equal(shouldInsertClipboardTextAsMarkdown("plain text from clipboard"), false);
  assert.equal(shouldInsertClipboardTextAsMarkdown("https://example.com/path_(x)"), false);
  // Image markdown / raw HTML img must intercept so notes can render remote images.
  assert.equal(shouldInsertClipboardTextAsMarkdown("![logo](https://example.com/logo.png)"), true);
  assert.equal(shouldInsertClipboardTextAsMarkdown('<img alt="logo" src="https://example.com/logo.png" />'), true);
});

test("note editor registers a code block editor for pasted fenced code", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /codeBlockPlugin\([^)]*\),\s*codeMirrorPlugin\(\{\s*codeBlockLanguages:/s,
  );
  assert.match(source, /codeMirrorExtensions:\s*\[\s*\.\.\.NOTE_CODE_MIRROR_EXTENSIONS,/);
  assert.match(source, /syntaxHighlighting\(noteCodeHighlightStyle\)/);
  // Tooltips mount on body to escape clipped code blocks, so their placement
  // must be bounded to this editor instead of the whole window.
  assert.match(
    source,
    /createNoteCodeTooltipExtensions\(\s*typeof document === "undefined" \? undefined : document\.body,/,
  );
  assert.match(source, /\(\) => containerRef\.current,/);
});

test("note editor enables image plugin for remote markdown images", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /imagePlugin\(\{\s*allowSetImageDimensions:\s*true/);
});

test("note editor exposes its modes from a borderless title-row dropdown", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const managerSource = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
  const toolbarSource = readFileSync(new URL("./NoteToolbar.tsx", import.meta.url), "utf8");

  assert.match(source, /type NoteEditorMode/);
  // The app-owned NoteToolbar (not MDXEditor's toolbarPlugin) hosts the
  // formatting controls; MDXEditor must not render its own toolbar.
  assert.doesNotMatch(source, /toolbarPlugin\(/);
  assert.match(toolbarSource, /onAction\?\.\("undo"\)/);
  assert.match(toolbarSource, /onAction\?\.\("redo"\)/);
  assert.match(toolbarSource, /<Undo2 size=\{14\} \/>/);
  assert.match(toolbarSource, /<Redo2 size=\{14\} \/>/);
  // Preview and edit both use MDXEditor (readOnly in preview).
  assert.match(source, /readOnly=\{editorMode === "preview"\}/);
  assert.match(source, /key=\{editorMode\}/);
  assert.match(source, /netcatty-mdx-editor--preview/);
  assert.doesNotMatch(source, /NoteMarkdownPreview|react-markdown|github-markdown/);
  assert.match(source, /editorMode = controlledEditorMode \?\? "edit"/);
  assert.doesNotMatch(source, /data-note-mode-switch/);
  assert.doesNotMatch(source, /absolute -top-9/);
  assert.match(managerSource, /data-note-title-row/);
  assert.match(toolbarSource, /data-note-mode-dropdown-trigger/);
  assert.match(toolbarSource, /data-note-mode-option=\{option\.mode\}/);
  assert.match(toolbarSource, /gap-1\.5 border-0 bg-transparent px-2/);
  assert.match(toolbarSource, /<SelectContent align="end" className="w-max min-w-\[10rem\]">/);
  assert.match(
    toolbarSource,
    /data-note-mode-option=\{option\.mode\}[\s\S]*?className="h-9 whitespace-nowrap"/,
  );
  assert.match(toolbarSource, /<Select value=\{normalizedMode\}/);
  assert.doesNotMatch(toolbarSource, /data-note-mode-switch=/);
  assert.match(managerSource, /data-note-title-row[\s\S]*?<NoteModeDropdown[\s\S]*?<NoteToolbar/);
  assert.match(managerSource, /<NoteModeDropdown[\s\S]*?editorMode=\{noteEditorMode\}/);
  assert.match(managerSource, /editorMode=\{noteEditorMode\}/);
  assert.doesNotMatch(`${source}\n${managerSource}`, /role="tablist"|role="tab"|renderModeButton/);
  assert.doesNotMatch(`${source}\n${managerSource}`, /className="mb-2 flex shrink-0 items-center justify-end"/);
});

test("note markdown toolbar remains usable in narrow panes", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const toolbarSource = readFileSync(new URL("./NoteToolbar.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /MoreHorizontal|data-note-toolbar-more|netcatty-note-toolbar-more/);

  assert.match(
    styles,
    /\.netcatty-mdx-editor\s*\{[^}]*container-type:\s*inline-size;/s,
  );
  // Keep fixed-containing-block in sync with MDX linkDialog coordinate math
  // (container-type alone is not a fixed CB in browsers).
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s*\{[^}]*transform:\s*translateZ\(0\);/s,
  );
  // The app-owned NoteToolbar scrolls horizontally when the pane is narrow so
  // formatting buttons are never clipped; the scrollbar stays visible.
  assert.match(
    toolbarSource,
    /overflow-x-auto [^"]*\[scrollbar-width:thin\]/,
  );
  assert.match(
    toolbarSource,
    /\[&::-webkit-scrollbar\]:h-1\.5/,
  );
  assert.match(
    toolbarSource,
    /\[&::-webkit-scrollbar-thumb\]:bg-border\/70/,
  );
  assert.match(
    toolbarSource,
    /flex flex-1 items-center gap-0\.5 min-w-0 overflow-x-auto/,
  );
});

test("preview mode opens links directly without showing the edit hover action", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /const handleClickCapture = useCallback/);
  assert.match(
    source,
    /if \(editorMode === "preview"\) \{[\s\S]*toggleTaskListItemAtIndex[\s\S]*const handled = openLink\(href, label\);/,
    "preview click path handles task toggles then openable links",
  );
  assert.match(source, /const handled = openLink\(href, label\);[\s\S]*if \(!handled\) return;[\s\S]*event\.preventDefault\(\);/);
  assert.match(source, /scheduleHostPickerUpdate\(\);\s*\n\s*\}, \[commitMarkdown, editorMode, openLink, scheduleHostPickerUpdate\]/);
  assert.match(source, /onClickCapture=\{\(event\) => \{[\s\S]*blockWhileContentSwapping[\s\S]*handleClickCapture/);
  assert.match(source, /if \(editorMode !== "edit"\) \{[\s\S]*setLinkActionIfChanged\(null\);[\s\S]*return;/);
  assert.match(source, /\{editorMode === "edit" && linkAction && \(/);
});

test("preview mode only intercepts links netcatty can open", () => {
  assert.equal(isSupportedNoteExternalHref("https://example.com/docs"), true);
  assert.equal(isSupportedNoteExternalHref("http://example.com/docs"), true);
  assert.equal(isSupportedNoteExternalHref("mailto:support@example.com"), true);
  assert.equal(isSupportedNoteExternalHref("#section"), false);
  assert.equal(isSupportedNoteExternalHref("/docs"), false);
  assert.equal(isSupportedNoteExternalHref("file:///tmp/readme.md"), false);
});

test("pasting inside code blocks keeps CodeMirror in control", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /export const isNotePasteInsideCodeBlock/);
  assert.match(source, /element\?\.closest/);
  assert.match(source, /\.cm-editor/);
  assert.match(source, /_codeMirrorWrapper_/);
  assert.match(
    source,
    /pasteInsideCodeBlock:\s*isNotePasteInsideCodeBlock\(event\.target\)/,
  );
});

test("note code block editor colors follow the app theme", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(styles, /\.netcatty-mdx-editor\s+\.cm-editor/);
  assert.match(styles, /\.netcatty-mdx-editor\s+\.cm-gutters/);
  assert.match(styles, /background:\s*hsl\(var\(--secondary\)/);
  assert.match(styles, /color:\s*hsl\(var\(--foreground\)/);
  assert.match(styles, /--note-code-token-keyword:\s*color-mix\(in oklab,\s*hsl\(var\(--primary\)\)/);
  assert.match(styles, /\.netcatty-mdx-editor\s+\.cm-content\s+\.netcatty-code-token-keyword/);
  assert.match(styles, /\.netcatty-mdx-editor\s+\.cm-content\s+\.netcatty-code-token-string/);
  assert.doesNotMatch(styles, /span\[class\*="ͼ"\]/);
  assert.doesNotMatch(styles, /\.netcatty-mdx-editor\s+\.cm-line\s+span/);
});

test("note code block active line is highlighted only while focused", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-activeLine,\s*\.netcatty-mdx-editor\s+\.cm-activeLineGutter\s*\{[^}]*background:\s*transparent/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-editor:focus-within\s+\.cm-activeLine,\s*\.netcatty-mdx-editor\s+\.cm-editor:focus-within\s+\.cm-activeLineGutter\s*\{[^}]*background:\s*hsl\(var\(--primary\)\s*\/\s*0\.08\)/s,
  );
});

test("note code block frame is borderless and language picker is compact", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorWrapper_"\]\s*\{[^}]*border:\s*0\s*!important;[^}]*background:\s*transparent\s*!important;[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-editor\s*\{[^}]*border:\s*0\s*!important;[^}]*background:\s*transparent\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-content\s+pre\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*padding:\s*0;/s,
  );
  assert.match(
    styles,
    /\.netcatty-note-code-copy\s*\{[^}]*border:\s*0\s*!important;[^}]*background:\s*transparent\s*!important;[^}]*box-shadow:\s*none\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s*\{[^}]*position:\s*absolute\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor \[class\*="_codeMirrorToolbar_"\] \[class\*="_selectTrigger_"\]\s*\{[^}]*height:\s*1\.45rem\s*!important;[^}]*font-size:\s*11px\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor \[class\*="_codeMirrorToolbar_"\] \[class\*="_tooltipTrigger_"\]\s*\{[^}]*display:\s*inline-flex\s*!important;[^}]*align-items:\s*center\s*!important;[^}]*align-self:\s*center\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor \[class\*="_codeMirrorToolbar_"\]\s+\[class\*="_selectTrigger_"\]\s*\{[^}]*width:\s*auto\s*!important;[^}]*min-width:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor \[class\*="_toolbarCodeBlockLanguageSelectContent_"\][\s\S]*width:\s*auto\s*!important;[\s\S]*min-width:\s*max-content\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor \[class\*="_toolbarCodeBlockLanguageSelectContent_"\] \[class\*="_selectItem_"\][\s\S]*font-size:\s*11px\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-editor\s*\{[^}]*font-size:\s*13px\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-line\s*\{[^}]*line-height:\s*1\.45\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-gutterElement\s*\{[^}]*font-size:\s*13px\s*!important;[^}]*line-height:\s*1\.45\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorWrapper_"\]\s*\{[^}]*gap:\s*0;[^}]*margin:\s*0\.25rem\s+0\s+0\.55rem;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorWrapper_"\]\s+\.cm-content\s*\{[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-gutters\s*\{[^}]*background:\s*transparent\s*!important;[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor--preview\s+\[class\*="_codeMirrorToolbar_"\]\s*\{[^}]*display:\s*none\s*!important;/s,
  );
});

test("note formulas render without framed surfaces", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.doesNotMatch(styles, /data-language="math"/);
  assert.match(
    styles,
    /\.netcatty-math-formula-preview\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;/s,
  );
  assert.match(
    styles,
    /\.netcatty-math-reading-mode\s*\{[^}]*background:\s*transparent\s*!important;[^}]*border:\s*none\s*!important;[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-math-reading-mode\s+\.netcatty-math-formula-preview\s*\{[^}]*background:\s*transparent;/s,
  );
  assert.match(styles, /\.netcatty-math-formula-preview\s*\{[^}]*justify-content:\s*safe center;[^}]*overflow-x:\s*auto;/s);
  assert.match(
    styles,
    /\.netcatty-math-reading-mode\s*>\s*\.netcatty-note-code-copy\s*\{[^}]*display:\s*none\s*!important;/s,
  );
});

test("getCodeMirrorBlockText reads rendered code block lines", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /export const getCodeMirrorBlockText/);
  assert.match(source, /\.cm-content \.cm-line/);
  assert.match(source, /\.join\("\\n"\)/);
});

test("annotateNoteCodeBlockCopyButtons adds a copy action to code blocks", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /export const annotateNoteCodeBlockCopyButtons/);
  assert.match(source, /data-note-code-copy/);
  assert.match(source, /getCodeMirrorBlockText\(wrapper\)/);
  assert.match(source, /onCopy\(text\)/);
});

test("annotateNoteCodeBlockCopyButtons treats a CSS-hidden toolbar as absent so preview shows the copy button", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /getComputedStyle\(toolbar\)\.display !== "none"/);
  assert.match(source, /toolbarVisible/);
  assert.match(source, /firstButton\.parentElement !== wrapper/);
  assert.match(source, /wrapper\.appendChild\(firstButton\)/);
});

test("annotateNoteCodeBlockDeleteButtons swaps the delete icon only once", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const dom = new JSDOM(`
    <div id="container">
      <div class="_codeMirrorToolbar_test">
        <button class="_toolbarCodeBlockLanguageSelectTrigger_test"></button>
        <button id="delete"></button>
      </div>
    </div>
  `);
  const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: dom.window.HTMLElement,
  });

  try {
    const container = dom.window.document.querySelector("#container") as HTMLElement;
    const deleteButton = dom.window.document.querySelector("#delete") as HTMLButtonElement;
    annotateNoteCodeBlockDeleteButtons(container);
    const installedIcon = deleteButton.firstElementChild;
    assert.equal(deleteButton.dataset.noteCodeDelete, "true");
    assert.equal(installedIcon?.nodeName.toLowerCase(), "svg");
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(deleteButton, { attributes: true, childList: true, subtree: true });

    annotateNoteCodeBlockDeleteButtons(container);

    assert.equal(observer.takeRecords().length, 0);
    assert.equal(deleteButton.firstElementChild, installedIcon);
    observer.disconnect();
  } finally {
    if (previousHTMLElement) {
      Object.defineProperty(globalThis, "HTMLElement", previousHTMLElement);
    } else {
      delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    }
    dom.window.close();
  }

  assert.match(source, /export const annotateNoteCodeBlockDeleteButtons/);
  assert.match(source, /data-note-code-delete/);
  assert.match(source, /DELETE_ICON_SVG/);
  assert.match(source, /stroke="currentColor"/);
  assert.match(source, /stroke-width="2"/);
});

test("note preview uses MDX readOnly with code-copy chrome", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(source, /removeNoteCodeBlockCopyButtons/);
  assert.match(source, /readOnly=\{editorMode === "preview"\}/);
  assert.match(source, /annotateCodeBlockCopyButtons/);
  assert.match(source, /annotateNoteCodeBlockCopyButtons/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /setAttribute\("aria-label", copiedLabel\)/);
  assert.match(styles, /\.netcatty-note-code-copy/);
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorWrapper_"\]:hover\s+\.netcatty-note-code-copy/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorWrapper_"\]\s*\{[^}]*display:\s*flex;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s*\{[^}]*justify-content:\s*flex-end;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorToolbar_"\]\s+\[class\*="_selectTrigger_"\]\s*\{[^}]*font-size:\s*11px\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorToolbar_"\]\s+button[^{]*\{[^}]*height:\s*1\.4rem\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorToolbar_"\][^{]*svg\s*\{[^}]*width:\s*10px\s*!important;/s,
  );
});

test("annotateMathFormulaBlocks handles empty math blocks and avoids reading toolbar text", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /export const annotateMathFormulaBlocks/);
  assert.match(source, /const text = getCodeMirrorBlockText\(wrapper\)\.trim\(\);/);
  assert.match(source, /if \(!formulaSource\) \{/);
  assert.match(source, /existingPreview\.remove\(\)/);
});

test("NoteSourceEditor manages local draft state to prevent cursor jumping on debounced commits", () => {
  const source = readFileSync(new URL("./NoteSourceEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /const \[localValue, setLocalValue\] = useState\(value\);/);
  assert.match(source, /value=\{localValue\}/);
  assert.match(source, /onChange=\{handleChange\}/);
  assert.match(source, /prevNoteIdRef\.current/);
  assert.match(source, /prevValueRef\.current/);
});

test("source mode compares raw markdown separately from display-normalized markdown", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /const latestSourceMarkdownRef = useRef\(value\)/);
  assert.match(source, /markdown === latestSourceMarkdownRef\.current/);
  assert.match(source, /latestMarkdownRef\.current = normalizeNotePublicAssetPaths\(markdown\)/);
  assert.match(source, /setAcceptedSourceMarkdown\(markdown\)/);
  assert.match(
    source,
    /<NoteSourceEditor[\s\S]*?value=\{noteId !== undefined && noteId !== noteIdRef\.current \? value : acceptedSourceMarkdown\}[\s\S]*?onChange=\{commitSourceMarkdown\}/,
  );
});

test("raw source drafts are not overwritten by external values with equivalent display markdown", () => {
  const base = {
    latestMarkdown: "![x](/x.png)",
    syncedMarkdown: "![x](/x.png)",
    latestSourceMarkdown: "![x](/x.png)",
    syncedSourceMarkdown: "![x](/public/x.png)",
  };

  assert.equal(shouldApplyExternalNoteMarkdown({
    ...base,
    nextSourceMarkdown: "# Remote",
  }), false);
  assert.equal(shouldApplyExternalNoteMarkdown({
    ...base,
    nextSourceMarkdown: "![x](/x.png)",
  }), true);
  assert.equal(shouldApplyExternalNoteMarkdown({
    ...base,
    latestSourceMarkdown: "![x](/public/x.png)",
    nextSourceMarkdown: "![x](/x.png)",
  }), true);
});
