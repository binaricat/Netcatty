import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const managerSource = readFileSync(new URL("./NotesManager.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(
  new URL("../vault/VaultViewLayout.tsx", import.meta.url),
  "utf8",
);

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
    /latestMarkdownRef\.current !== syncedPropValueRef\.current/,
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
