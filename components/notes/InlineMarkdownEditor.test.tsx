import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getHostPickerTriggerRange,
  isSupportedNoteExternalHref,
  isPointerInsideLinkActionHoverZone,
  resolveHostPickerPopupPosition,
  shouldInsertClipboardTextAsMarkdown,
  shouldHandleHostPickerNavigationKey,
} from "./InlineMarkdownEditor.tsx";

test("host picker navigation keys are handled even before a query is typed", () => {
  assert.equal(shouldHandleHostPickerNavigationKey(true, "ArrowDown", 3), true);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "ArrowUp", 3), true);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "Enter", 3), true);
  assert.equal(shouldHandleHostPickerNavigationKey(true, "Tab", 3), true);
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
  assert.equal(shouldInsertClipboardTextAsMarkdown("![logo](https://example.com/logo.png)"), false);
});

test("note editor registers a code block editor for pasted fenced code", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /codeBlockPlugin\([^)]*\),\s*codeMirrorPlugin\(\{\s*codeBlockLanguages:/s,
  );
  assert.match(source, /codeMirrorExtensions:\s*NOTE_CODE_MIRROR_EXTENSIONS/);
  assert.match(source, /syntaxHighlighting\(noteCodeHighlightStyle\)/);
});

test("note editor exposes preview and edit modes with a markdown toolbar in edit mode", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const managerSource = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");

  assert.match(source, /type NoteEditorMode = "edit" \| "preview"/);
  assert.match(source, /toolbarPlugin\(\{\s*toolbarContents:/s);
  assert.match(source, /readOnly=\{editorMode === "preview"\}/);
  assert.match(source, /<BlockTypeSelect \/>/);
  assert.match(source, /<BoldItalicUnderlineToggles /);
  assert.match(source, /<ListsToggle /);
  assert.match(source, /<InsertCodeBlock \/>/);
  assert.match(source, /<InsertTable \/>/);
  assert.match(source, /editorMode = controlledEditorMode \?\? "edit"/);
  assert.doesNotMatch(source, /data-note-mode-switch/);
  assert.doesNotMatch(source, /absolute -top-9/);
  assert.match(managerSource, /data-note-title-row/);
  assert.match(managerSource, /data-note-mode-switch/);
  assert.match(managerSource, /Glasses/);
  assert.match(managerSource, /PencilLine/);
  assert.match(managerSource, /setNoteEditorMode\(\(currentMode\) => \(/);
  assert.match(managerSource, /currentMode === "edit" \? "preview" : "edit"/);
  assert.match(managerSource, /editorMode=\{noteEditorMode\}/);
  assert.match(managerSource, /className="app-no-drag h-8 w-8 shrink-0 rounded-md p-0 text-muted-foreground transition-colors hover:bg-secondary\/70 hover:text-foreground"/);
  assert.doesNotMatch(managerSource, /data-note-mode-switch[\s\S]{0,500}border/);
  assert.doesNotMatch(`${source}\n${managerSource}`, /role="tablist"|role="tab"|renderModeButton/);
  assert.doesNotMatch(`${source}\n${managerSource}`, /className="mb-2 flex shrink-0 items-center justify-end"/);
});

test("note markdown toolbar remains usable in narrow panes", () => {
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /MoreHorizontal|data-note-toolbar-more|netcatty-note-toolbar-more/);

  assert.match(
    styles,
    /\.netcatty-mdx-editor\s*\{[^}]*container-type:\s*inline-size;/s,
  );
  assert.match(
    styles,
    /\.netcatty-note-markdown-toolbar\s*\{[^}]*max-width:\s*100%;[^}]*height:\s*auto\s*!important;[^}]*overflow:\s*visible\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-note-markdown-toolbar\s*\{[^}]*box-sizing:\s*border-box;[^}]*display:\s*flex\s*!important;[^}]*flex-wrap:\s*wrap\s*!important;[^}]*align-content:\s*flex-start\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-note-markdown-toolbar\s*>\s*\*\s*\{[^}]*flex-shrink:\s*0;/s,
  );
  assert.match(
    styles,
    /@container\s*\(max-width:\s*34rem\)\s*\{[\s\S]*\.netcatty-note-markdown-toolbar\s*\{[^}]*gap:\s*0\.125rem\s*!important;/s,
  );
  assert.match(
    styles,
    /@container\s*\(max-width:\s*34rem\)\s*\{[\s\S]*\.netcatty-note-markdown-toolbar\s*\{[^}]*flex-wrap:\s*wrap\s*!important;[^}]*align-content:\s*flex-start\s*!important;/s,
  );
  assert.match(
    styles,
    /@container\s*\(max-width:\s*34rem\)\s*\{[\s\S]*\.netcatty-note-markdown-toolbar\s+button,[\s\S]*\.netcatty-note-markdown-toolbar\s+\[role="button"\][\s\S]*height:\s*1\.75rem\s*!important;/s,
  );
});

test("preview mode opens links directly without showing the edit hover action", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");

  assert.match(source, /const handleClickCapture = useCallback/);
  assert.match(source, /if \(editorMode !== "preview"\) \{[\s\S]*scheduleHostPickerUpdate\(\);[\s\S]*return;/);
  assert.match(source, /const handled = openLink\(href, label\);[\s\S]*if \(!handled\) return;[\s\S]*event\.preventDefault\(\);/);
  assert.match(source, /onClickCapture=\{handleClickCapture\}/);
  assert.match(source, /if \(editorMode !== "edit"\) \{[\s\S]*setLinkAction\(null\);[\s\S]*return;/);
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
  assert.match(source, /if \(isNotePasteInsideCodeBlock\(event\.target\)\) return;/);
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
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorWrapper_"\]\s*\{[^}]*border:\s*0\s*!important;[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-editor\s*\{[^}]*border:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\[class\*="_codeMirrorToolbar_"\]\s*\{[^}]*position:\s*static\s*!important;[^}]*padding:\s*0\.125rem;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor \[class\*="_codeMirrorToolbar_"\] \[class\*="_selectTrigger_"\]\s*\{[^}]*height:\s*1\.45rem\s*!important;[^}]*font-size:\s*11px\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s+\[class\*="_selectTrigger_"\]\s*\{[^}]*width:\s*auto\s*!important;[^}]*min-width:\s*fit-content\s*!important;/s,
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
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorWrapper_"\]\s*\{[^}]*gap:\s*0;[^}]*margin:\s*0\.3rem\s+0\s+0\.65rem;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorWrapper_"\]\s+\.cm-content\s*\{[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor\s+\.cm-gutters\s*\{[^}]*padding:\s*0\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor--preview\s+\[class\*="_codeMirrorToolbar_"\]\s*\{[^}]*display:\s*none\s*!important;/s,
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

test("note code blocks expose a hover copy action only in preview mode", () => {
  const source = readFileSync(new URL("./InlineMarkdownEditor.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  assert.match(source, /removeNoteCodeBlockCopyButtons/);
  assert.match(source, /if \(editorMode !== "preview"\) \{[\s\S]*removeNoteCodeBlockCopyButtons/);
  assert.match(source, /annotateNoteCodeBlockCopyButtons/);
  assert.match(source, /notes\.codeBlock\.copied/);
  assert.match(source, /copyFailedLabel/);
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
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s*\{[^}]*position:\s*static\s*!important;[^}]*justify-content:\s*flex-end;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s+\[class\*="_selectTrigger_"\]\s*\{[^}]*font-size:\s*11px\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s+button\s*\{[^}]*height:\s*1\.35rem\s*!important;/s,
  );
  assert.match(
    styles,
    /\.netcatty-mdx-editor:not\(\.netcatty-mdx-editor--preview\)\s+\[class\*="_codeMirrorToolbar_"\]\s+button\s+svg\s*\{[^}]*width:\s*14px\s*!important;/s,
  );
});
