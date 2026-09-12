import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const managerSource = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(
  new URL("../vault/VaultViewLayout.tsx", import.meta.url),
  "utf8",
);

test("notes tree width resize avoids React setState on every pointermove", () => {
  // Dragging the sidebar used to call setTreeWidth per pixel and re-render the
  // whole NotesManager (including MDXEditor). Live width must stay on the DOM
  // until pointerup commits state + localStorage.
  assert.match(managerSource, /treeAsideRef/);
  assert.match(managerSource, /requestAnimationFrame/);
  assert.match(managerSource, /aside\.style\.width = `\$\{width\}px`/);
  assert.match(
    managerSource,
    /const handlePointerMove = \(moveEvent: PointerEvent\) => \{[\s\S]*?requestAnimationFrame/,
  );
  assert.doesNotMatch(
    managerSource,
    /const handlePointerMove = \(moveEvent: PointerEvent\) => \{\s*\n\s*setTreeWidth\(/,
  );
  assert.match(managerSource, /persistTreeWidth\(nextWidth\)/);
  assert.match(managerSource, /isTreeResizing && "pointer-events-none"/);
});

test("note content drafts stay in refs so MDX keystrokes do not rebuild the shell", () => {
  assert.doesNotMatch(
    managerSource,
    /const \[draftContent, setDraftContent\]/,
    "draftContent React state causes a full NotesManager render per keystroke",
  );
  assert.match(
    managerSource,
    /draftContentRef\.current = fields\.content;/,
  );
  assert.doesNotMatch(
    managerSource,
    /setDraftContent\(fields\.content\)/,
  );
});

test("NotesManager teardown flush uses a stable ref under StrictMode", () => {
  assert.match(managerSource, /flushNoteDraftRef\.current = flushNoteDraft/);
  assert.match(
    managerSource,
    /useEffect\(\(\) => \(\) => \{\s*\n\s*flushNoteDraftRef\.current\(\);\s*\n\s*\}, \[\]\)/,
  );
});

test("Vault notes section is memoized against unrelated VaultView churn", () => {
  assert.match(layoutSource, /const MemoVaultNotesSection = React\.memo/);
  assert.match(layoutSource, /<MemoVaultNotesSection\b/);
  assert.match(layoutSource, /const handleNotesOpenHost = useCallback/);
  assert.match(layoutSource, /onOpenHost=\{handleNotesOpenHost\}/);
  assert.match(
    layoutSource,
    /useNotesStore\(\{\s*\n\s*enabled:\s*isActive,\s*\n\s*\}\)/,
  );
  assert.match(
    layoutSource,
    /if \(next\.isActive && prev\.hosts !== next\.hosts\) return false;/,
    "hidden retained notes must ignore hosts identity churn",
  );
});

test("hidden terminal notes side panel does not subscribe to notes publishes", () => {
  const slotsSource = readFileSync(
    new URL("../terminalLayer/terminalLayerSidePanelSlots.tsx", import.meta.url),
    "utf8",
  );
  assert.match(slotsSource, /useNotesStore\(\{\s*enabled:\s*isVisible\s*\}\)/);
});

test("notes manager prefetches the MDXEditor chunk when becoming active", () => {
  assert.match(managerSource, /prefetchInlineMarkdownEditor/);
  assert.match(
    managerSource,
    /if \(!isActive\) return;\s*\n\s*prefetchInlineMarkdownEditor\(\);/,
  );
});

test("mode toggle flushes ref-only content drafts before remounting the editor", () => {
  assert.match(
    managerSource,
    /flushNoteDraft\(\);\s*\n\s*setNoteEditorMode/,
    "preview/edit remount must see the in-progress body",
  );
});

test("note switches reuse MDX instance instead of key=noteId remount", () => {
  assert.match(managerSource, /noteId=\{selectedNoteView\.id\}/);
  assert.doesNotMatch(
    managerSource,
    /<InlineMarkdownEditor[\s\S]{0,200}key=\{selectedNoteView\.id\}/,
    "key=noteId forces full Lexical teardown on every note switch",
  );
  const editorSource = readFileSync(
    new URL("./InlineMarkdownEditor.tsx", import.meta.url),
    "utf8",
  );
  assert.match(editorSource, /noteId !== noteIdRef\.current/);
  assert.match(editorSource, /setMarkdown\(scheduled\.markdown\)/);
  assert.match(
    editorSource,
    /contentSwapFramesRef\.current\.outer = window\.requestAnimationFrame/,
    "outer rAF yields a paint so the tree selection updates before Lexical import",
  );
  assert.match(
    editorSource,
    /contentSwapFramesRef\.current\.inner = window\.requestAnimationFrame/,
    "inner rAF completes the double-yield before setMarkdown",
  );
  assert.match(editorSource, /data-notes-content-swapping="true"/);
  assert.match(editorSource, /setIsContentSwapping\(true\)/);
  assert.match(editorSource, /CLEAR_HISTORY_COMMAND/);
  assert.match(editorSource, /clearLexicalHistory/);
  assert.match(editorSource, /attributeFilter:\s*\[\s*"width",\s*"height"/);
  assert.match(editorSource, /onPointerDownCapture=\{blockWhileContentSwapping\}/);
  assert.match(editorSource, /startTransition\(\(\) => setIsContentSwapping\(false\)\)/);
  assert.match(
    editorSource,
    /latestMarkdownRef\.current !== scheduled\.markdown/,
    "deferred setMarkdown must not clobber edits typed after the switch",
  );
  assert.match(
    editorSource,
    /if \(contentSwapPendingRef\.current\) return;/,
    "stale onChange during the swap yield must not write the previous note into the new draft",
  );
  assert.match(
    editorSource,
    /contentSwapScheduledRef/,
    "deferred import must refresh when the same note's value changes during the yield",
  );
  assert.match(
    editorSource,
    /syncedPropValueRef\.current = markdown;/,
    "draft-clobber guard compares display-normalized values after note switch",
  );
  assert.match(
    editorSource,
    /runDecorations\(true\)/,
    "edit-mode note swaps must re-annotate host links after setMarkdown",
  );
});

test("host-link annotation does not re-run on every markdown value keystroke", () => {
  const editorSource = readFileSync(
    new URL("./InlineMarkdownEditor.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    editorSource,
    /annotateHostLinks,\s*value\s*\]/,
    "value in annotateHostLinks effect deps walks the DOM on every keystroke",
  );
  assert.doesNotMatch(
    editorSource,
    /annotateCodeBlockCopyButtons,\s*editorMode,\s*value\s*\]/,
    "value in code-copy effect deps re-walks every code block on each draft identity change",
  );
  assert.match(
    editorSource,
    /\[annotateCodeBlockCopyButtons, annotateHostLinks, editorMode\]/,
    "DOM decoration is independent of markdown value identity",
  );
  assert.match(
    editorSource,
    /readOnly=\{editorMode === "preview"\}/,
    "preview reuses MDXEditor in read-only mode",
  );
  assert.match(
    editorSource,
    /syncedPropValueRef/,
    "external note publishes must not clobber an in-progress local draft",
  );
  assert.match(
    editorSource,
    /shouldApplyExternalNoteMarkdown/,
  );
  assert.match(
    editorSource,
    /syncedSourceMarkdownRef/,
  );
});

test("link hover and small-image CSS avoid render thrash", () => {
  const editorSource = readFileSync(
    new URL("./InlineMarkdownEditor.tsx", import.meta.url),
    "utf8",
  );
  const cssSource = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

  const imageLayoutSource = readFileSync(
    new URL("./noteImageLayout.ts", import.meta.url),
    "utf8",
  );
  assert.match(editorSource, /linkActionStatesEqual/);
  assert.match(editorSource, /setLinkActionIfChanged/);
  assert.match(editorSource, /annotateNoteImageSizes/);
  assert.match(imageLayoutSource, /data-note-img-size/);
  // No combinatorial :has(img[width="N"]) matrix for small icons.
  assert.doesNotMatch(
    cssSource,
    /:has\(img\[width="16"\]\).*?:has\(img\[width="20"\]/s,
  );
  assert.match(cssSource, /img\[data-note-img-size="sm"\]/);
});
