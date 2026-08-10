import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  InsertCodeBlock,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  imagePlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from "@mdxeditor/editor";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { ExternalLink } from "lucide-react";
import {
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  getNearestEditorFromDOMNode,
} from "lexical";
import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { resolveRenderedMarkdownLinkHref } from "../../domain/notes";
import {
  isPointerOnTaskCheckbox,
  toggleTaskListItemAtIndex,
} from "../../domain/notes/taskList";
import { buildSshNoteLinkOpenHost } from "../../domain/sshDeepLink";
import { copyToClipboard } from "../keychain/utils";
import { toast } from "../ui/toast";
import { cn } from "../../lib/utils";
import { FixedSizeVirtualList, type FixedSizeVirtualListHandle } from "../ui/FixedSizeVirtualList";
import type { Host } from "../../types";
import {
  normalizeNotePublicAssetPaths,
  resolveNoteClipboardPaste,
  shouldInsertClipboardTextAsMarkdown,
  shouldInterceptResolvedNotePaste,
} from "./noteClipboardPaste";
import { annotateNoteImageSizes } from "./noteImageLayout";

export {
  annotateNoteImageSizes,
  isNoteSmallImageWidth,
  NOTE_SMALL_IMAGE_MAX_WIDTH,
} from "./noteImageLayout";

export {
  shouldInsertClipboardTextAsMarkdown,
  resolveNoteClipboardPaste,
  shouldInterceptResolvedNotePaste,
  convertClipboardHtmlToMarkdown,
} from "./noteClipboardPaste";

export interface InlineMarkdownEditorProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** When set, note switches reuse the MDX instance via setMarkdown (no full remount). */
  noteId?: string;
  hosts?: Host[];
  editorMode?: NoteEditorMode;
  onOpenHost?: (host: Host) => void;
  onOpenExternalLink?: (url: string) => void | Promise<void>;
  previewEmptyLabel?: string;
}

export type NoteEditorMode = "edit" | "preview";

type HostPickerState = {
  open: boolean;
  query: string;
  selectedIndex: number;
  trigger: "@" | "/";
  left: number;
  top: number;
};

type LinkActionState = {
  href: string;
  label: string;
  left: number;
  top: number;
};

const LINK_ACTION_SIZE = 28;
const LINK_ACTION_HOVER_PADDING = 10;
const HOST_PICKER_WIDTH = 384;
const HOST_PICKER_EDGE_PADDING = 8;
const HOST_PICKER_TOP_FLOOR = 32;
const HOST_PICKER_VERTICAL_GAP = 10;
const HOST_PICKER_HEADER_HEIGHT = 37;
const HOST_PICKER_ROW_HEIGHT = 34;
const HOST_PICKER_EMPTY_HEIGHT = 40;
const HOST_PICKER_LIST_VERTICAL_PADDING = 8;
const HOST_PICKER_LIST_MAX_HEIGHT = 256;
const NOTE_CODE_BLOCK_LANGUAGES = {
  bash: "Bash",
  c: "C",
  conf: "Config",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  dockerfile: "Dockerfile",
  env: "Env",
  go: "Go",
  html: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JavaScript (React)",
  markdown: "Markdown",
  md: "Markdown",
  nginx: "Nginx",
  plaintext: "Plain text",
  python: "Python",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript (React)",
  typescript: "TypeScript",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Zsh",
} satisfies Record<string, string>;

const noteCodeHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, class: "netcatty-code-token-muted" },
  { tag: tags.link, class: "netcatty-code-token-link" },
  { tag: tags.heading, class: "netcatty-code-token-heading" },
  { tag: tags.emphasis, class: "netcatty-code-token-emphasis" },
  { tag: tags.strong, class: "netcatty-code-token-strong" },
  { tag: [tags.keyword, tags.regexp, tags.escape, tags.special(tags.string)], class: "netcatty-code-token-keyword" },
  { tag: [tags.atom, tags.bool, tags.url, tags.labelName], class: "netcatty-code-token-name" },
  { tag: [tags.literal, tags.inserted, tags.number], class: "netcatty-code-token-value" },
  { tag: [tags.string, tags.deleted], class: "netcatty-code-token-string" },
  { tag: [tags.variableName, tags.propertyName], class: "netcatty-code-token-variable" },
  { tag: [tags.definition(tags.variableName), tags.local(tags.variableName)], class: "netcatty-code-token-variable" },
  { tag: [tags.typeName, tags.namespace, tags.className, tags.macroName], class: "netcatty-code-token-type" },
  { tag: [tags.definition(tags.propertyName), tags.special(tags.variableName)], class: "netcatty-code-token-property" },
  { tag: tags.comment, class: "netcatty-code-token-muted" },
  { tag: tags.invalid, class: "netcatty-code-token-invalid" },
]);

const NOTE_CODE_MIRROR_EXTENSIONS = [syntaxHighlighting(noteCodeHighlightStyle)];

type RectLike = Pick<DOMRect, "bottom" | "height" | "left" | "top" | "width">;

const NoteMarkdownToolbar = React.memo(function NoteMarkdownToolbar() {
  return (
    <>
      <UndoRedo />
      <Separator />
      <BlockTypeSelect />
      <Separator />
      <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
      <CodeToggle />
      <Separator />
      <ListsToggle options={["bullet", "number", "check"]} />
      <Separator />
      <CreateLink />
      <InsertImage />
      <InsertCodeBlock />
      <InsertTable />
      <InsertThematicBreak />
    </>
  );
});

const isSshCandidateHost = (host: Host): boolean =>
  Boolean(host.hostname?.trim()) && (host.protocol === undefined || host.protocol === "ssh");

const getHostLinkLabel = (host: Host): string =>
  host.label?.trim() || (host.username ? `${host.username}@${host.hostname}` : host.hostname);

const formatSshDeepLinkForHost = (host: Host): string => {
  const rawHost = host.hostname.trim();
  const hostPart = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  const username = host.username?.trim() ? `${encodeURIComponent(host.username.trim())}@` : "";
  const port = host.port && host.port !== 22 ? `:${host.port}` : "";
  return `ssh://${username}${hostPart}${port}`;
};

const filterHostPickerHosts = (hostCandidates: Host[], query: string): Host[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return hostCandidates.slice(0, 8);
  return hostCandidates.filter((host) => {
    const haystack = [
      host.label,
      host.hostname,
      host.username,
      ...(host.tags || []),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(normalizedQuery);
  }).slice(0, 8);
};

const getEstimatedHostPickerHeight = (availableHostCount: number): number => {
  const listHeight = availableHostCount > 0
    ? availableHostCount * HOST_PICKER_ROW_HEIGHT + HOST_PICKER_LIST_VERTICAL_PADDING
    : HOST_PICKER_EMPTY_HEIGHT;
  return HOST_PICKER_HEADER_HEIGHT + Math.min(HOST_PICKER_LIST_MAX_HEIGHT, listHeight);
};

export const isNotePasteInsideCodeBlock = (target: EventTarget | null): boolean => {
  if (typeof Element === "undefined") return false;
  const element = target instanceof Element
    ? target
    : typeof Node !== "undefined" && target instanceof Node
      ? target.parentElement
      : null;
  return Boolean(element?.closest(".cm-editor, [class*=\"_codeMirrorWrapper_\"]"));
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

/**
 * Last-resort caret paste after insertMarkdown no-ops (preventDefault already applied).
 * Inserts clipboard text at the active Lexical range so non-empty notes are not discarded.
 */
export const insertClipboardTextAtActiveLexicalSelection = (
  target: EventTarget | null,
  text: string,
): boolean => {
  if (!text) return false;
  if (typeof Element === "undefined" || typeof Node === "undefined") return false;
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return false;
  const lexicalEditor = getNearestEditorFromDOMNode(element);
  if (!lexicalEditor) return false;
  let didInsert = false;
  lexicalEditor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    selection.insertText(text);
    didInsert = true;
  });
  return didInsert;
};

/**
 * Merge a recovered markdown paste into the current document body.
 * Used when Lexical has no caret (or insertMarkdown no-ops after preventDefault).
 * Strips leading blank lines only — keep first-line indentation for nested lists.
 */
export const mergeNoteMarkdownDocumentPaste = (
  currentMarkdown: string,
  clipboardText: string,
): string => {
  const current = currentMarkdown.replace(/\s+$/u, "");
  const pasted = clipboardText
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+/u, "")
    .replace(/\s+$/u, "");
  if (!pasted) return currentMarkdown;
  if (!current) return pasted;
  return `${current}\n\n${pasted}`;
};

/**
 * Decide whether markdown paste should call preventDefault.
 * Selection is optional: when the caret is gone (common after a prior
 * insertMarkdown), recover via document setMarkdown merge instead of letting
 * preventDefault + a no-op Lexical insert swallow the clipboard.
 *
 * Prefer {@link shouldInterceptResolvedNotePaste} when HTML clipboard is available.
 */
export const shouldInterceptNoteMarkdownPaste = (input: {
  editorMode: NoteEditorMode;
  pasteInsideCodeBlock: boolean;
  clipboardText: string;
  canInsertMarkdownAtSelection: boolean;
}): boolean => {
  if (input.editorMode !== "edit") return false;
  if (input.pasteInsideCodeBlock) return false;
  return shouldInsertClipboardTextAsMarkdown(input.clipboardText);
};

/**
 * Long pastes still use insertMarkdown when a caret/selection exists so we do
 * not jump content to the document end (document-merge appends).
 * Settle attempts scale up for large payloads.
 */
export const NOTE_MARKDOWN_PASTE_INSERT_MAX_CHARS = 4_000;

/** Poll window for deferred insertMarkdown settlement before document recovery. */
export const NOTE_MARKDOWN_PASTE_SETTLE_POLL_MS = 50;
export const NOTE_MARKDOWN_PASTE_SETTLE_MIN_ATTEMPTS = 6;
export const NOTE_MARKDOWN_PASTE_SETTLE_MAX_ATTEMPTS = 40;

export type NoteMarkdownPasteStrategy = "document-merge" | "insert-at-selection";

export const resolveNoteMarkdownPasteStrategy = (input: {
  canInsertMarkdownAtSelection: boolean;
  clipboardText: string;
}): NoteMarkdownPasteStrategy => {
  // Only fall back to whole-document merge when Lexical has no caret/selection.
  // Forcing document-merge on long pastes used to append at EOF and lose caret.
  if (!input.canInsertMarkdownAtSelection) return "document-merge";
  return "insert-at-selection";
};

/** Scale settle polls with paste size so slow inserts are not treated as no-ops. */
export const resolveNoteMarkdownPasteSettleAttempts = (clipboardLength: number): number => {
  const scaled = Math.ceil(clipboardLength / 1_200);
  return Math.min(
    NOTE_MARKDOWN_PASTE_SETTLE_MAX_ATTEMPTS,
    Math.max(NOTE_MARKDOWN_PASTE_SETTLE_MIN_ATTEMPTS, scaled),
  );
};

export const resolveHostPickerPopupPosition = ({
  anchorRect,
  containerRect,
  availableHostCount,
  viewportHeight,
}: {
  anchorRect: RectLike;
  containerRect: RectLike;
  availableHostCount: number;
  viewportHeight: number;
}): { left: number; top: number } => {
  const estimatedHeight = getEstimatedHostPickerHeight(availableHostCount);
  const maxLeft = Math.max(
    HOST_PICKER_EDGE_PADDING,
    containerRect.width - HOST_PICKER_WIDTH - HOST_PICKER_EDGE_PADDING,
  );
  const left = Math.max(
    HOST_PICKER_EDGE_PADDING,
    Math.min(maxLeft, anchorRect.left - containerRect.left),
  );
  const visibleBottom = Math.min(containerRect.top + containerRect.height, viewportHeight);
  const visibleTop = Math.max(containerRect.top, 0);
  const spaceBelow = visibleBottom - anchorRect.bottom - HOST_PICKER_VERTICAL_GAP;
  const spaceAbove = anchorRect.top - visibleTop - HOST_PICKER_VERTICAL_GAP;
  const shouldOpenAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
  const belowTop = anchorRect.bottom - containerRect.top + HOST_PICKER_VERTICAL_GAP;
  const aboveTop = anchorRect.top - containerRect.top - estimatedHeight - HOST_PICKER_VERTICAL_GAP;
  const maxTop = Math.max(
    HOST_PICKER_TOP_FLOOR,
    containerRect.height - estimatedHeight - HOST_PICKER_EDGE_PADDING,
  );
  const top = shouldOpenAbove
    ? Math.max(HOST_PICKER_TOP_FLOOR, aboveTop)
    : Math.max(HOST_PICKER_TOP_FLOOR, Math.min(belowTop, maxTop));

  return { left, top };
};

const SUPPORTED_NOTE_EXTERNAL_LINK_PROTOCOL_PATTERN = /^(?:https?:|mailto:)/i;

export const isSupportedNoteExternalHref = (href: string): boolean => {
  const trimmed = href.trim();
  if (!SUPPORTED_NOTE_EXTERNAL_LINK_PROTOCOL_PATTERN.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
};

const openExternalLink = async (
  href: string,
  onOpenExternalLink?: (url: string) => void | Promise<void>,
): Promise<boolean> => {
  if (!isSupportedNoteExternalHref(href)) return false;
  const url = new URL(href.trim());

  if (onOpenExternalLink) {
    await onOpenExternalLink(url.toString());
    return true;
  }
  window.open(url.toString(), "_blank", "noopener,noreferrer");
  return true;
};

export const shouldHandleHostPickerNavigationKey = (
  pickerOpen: boolean,
  key: string,
  availableHostCount: number,
): boolean => {
  if (!pickerOpen) return false;
  if (key === "Escape") return true;
  if (availableHostCount <= 0) return false;
  return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Tab";
};

export const isPointerInsideLinkActionHoverZone = (
  action: LinkActionState | null,
  x: number,
  y: number,
): boolean => {
  if (!action) return false;
  return x >= action.left - LINK_ACTION_HOVER_PADDING
    && x <= action.left + LINK_ACTION_SIZE + LINK_ACTION_HOVER_PADDING
    && y >= action.top - LINK_ACTION_HOVER_PADDING
    && y <= action.top + LINK_ACTION_SIZE + LINK_ACTION_HOVER_PADDING;
};

/** Avoid React re-renders when the open-link chip does not move. */
export const linkActionStatesEqual = (
  a: LinkActionState | null,
  b: LinkActionState | null,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.href === b.href
    && a.label === b.label
    && a.left === b.left
    && a.top === b.top;
};

export const getHostPickerTriggerRange = (textBeforeCursor: string): {
  query: string;
  startOffset: number;
  trigger: "@" | "/";
} | null => {
  const triggerMatch = /(^|\s)([@/])([^\s@/]*)$/.exec(textBeforeCursor);
  if (!triggerMatch) return null;
  return {
    query: triggerMatch[3],
    startOffset: triggerMatch.index + triggerMatch[1].length,
    trigger: triggerMatch[2] as "@" | "/",
  };
};

export const getCodeMirrorBlockText = (wrapper: Element): string => {
  const lines = wrapper.querySelectorAll(".cm-content .cm-line");
  if (lines.length > 0) {
    return Array.from(lines)
      .map((line) => line.textContent?.replace(/\u00a0/g, " ") ?? "")
      .join("\n");
  }

  const content = wrapper.querySelector(".cm-content");
  return content?.textContent?.replace(/\u00a0/g, " ") ?? "";
};

const clearNoteCodeBlockCopyResetTimer = (button: HTMLElement): void => {
  const timerId = Number(button.dataset.resetTimerId);
  if (timerId) {
    window.clearTimeout(timerId);
    delete button.dataset.resetTimerId;
  }
};

export const removeNoteCodeBlockCopyButtons = (container: HTMLElement): void => {
  container.querySelectorAll("[data-note-code-copy]").forEach((button) => {
    if (button instanceof HTMLElement) {
      clearNoteCodeBlockCopyResetTimer(button);
    }
    button.remove();
  });
};

export const annotateNoteCodeBlockCopyButtons = (
  container: HTMLElement,
  {
    copyLabel,
    copiedLabel,
    copyFailedLabel,
    onCopy,
  }: {
    copyLabel: string;
    copiedLabel: string;
    copyFailedLabel: string;
    onCopy: (text: string) => Promise<boolean>;
  },
): void => {
  container.querySelectorAll('[class*="_codeMirrorWrapper_"]').forEach((wrapper) => {
    if (!(wrapper instanceof HTMLElement)) return;
    if (wrapper.querySelector("[data-note-code-copy]")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.noteCodeCopy = "true";
    button.className = "netcatty-note-code-copy";
    button.title = copyLabel;
    button.setAttribute("aria-label", copyLabel);
    button.textContent = copyLabel;

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        clearNoteCodeBlockCopyResetTimer(button);
        const text = getCodeMirrorBlockText(wrapper);
        const ok = await onCopy(text);
        if (!ok) {
          toast.error(copyFailedLabel);
          return;
        }
        button.dataset.copied = "true";
        button.textContent = copiedLabel;
        button.title = copiedLabel;
        button.setAttribute("aria-label", copiedLabel);
        const timerId = window.setTimeout(() => {
          delete button.dataset.copied;
          delete button.dataset.resetTimerId;
          button.textContent = copyLabel;
          button.title = copyLabel;
          button.setAttribute("aria-label", copyLabel);
        }, 1500);
        button.dataset.resetTimerId = String(timerId);
      })();
    });

    wrapper.appendChild(button);
  });
};

const deleteLexicalTextRange = (range: Range, onUpdate: () => void): boolean => {
  const rangeContainer = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  const lexicalEditor = getNearestEditorFromDOMNode(rangeContainer);
  if (!lexicalEditor) return false;

  let didDelete = false;
  lexicalEditor.update(
    () => {
      const startNode = $getNearestNodeFromDOMNode(range.startContainer);
      const endNode = $getNearestNodeFromDOMNode(range.endContainer);
      if (!$isTextNode(startNode) || !$isTextNode(endNode)) return;

      const selection = $createRangeSelection();
      selection.anchor.set(startNode.getKey(), range.startOffset, "text");
      selection.focus.set(endNode.getKey(), range.endOffset, "text");
      $setSelection(selection);
      selection.removeText();
      didDelete = true;
    },
    { onUpdate },
  );
  return didDelete;
};

export const InlineMarkdownEditor = React.memo(function InlineMarkdownEditor({
  value,
  placeholder,
  onChange,
  noteId,
  hosts = [],
  editorMode: controlledEditorMode,
  onOpenHost,
  onOpenExternalLink,
  previewEmptyLabel,
}: InlineMarkdownEditorProps) {
  const { t } = useI18n();
  const editorRef = useRef<MDXEditorMethods>(null);
  // Display-normalized space (same as setMarkdown / public-asset rewrite).
  const latestMarkdownRef = useRef(normalizeNotePublicAssetPaths(value));
  const syncedPropValueRef = useRef(normalizeNotePublicAssetPaths(value));
  const noteIdRef = useRef(noteId);
  // Bumped on unmount / external value sync so deferred paste recovery cannot
  // commit into a switched or unmounted note.
  const pasteRecoveryGenerationRef = useRef(0);
  // Invalidates in-flight deferred setMarkdown when the user switches again.
  const contentSwapTokenRef = useRef(0);
  const contentSwapPendingRef = useRef(false);
  /** Latest markdown the in-flight note-switch import should apply (refreshed on external value). */
  const contentSwapScheduledRef = useRef<{
    token: number;
    noteId: string;
    markdown: string;
  } | null>(null);
  const contentSwapFramesRef = useRef<{ outer: number; inner: number }>({
    outer: 0,
    inner: 0,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const lastLinkActivationRef = useRef<{ href: string; at: number } | null>(null);
  const [hostPicker, setHostPicker] = useState<HostPickerState>({
    open: false,
    query: "",
    selectedIndex: 0,
    trigger: "@",
    left: 0,
    top: 32,
  });
  const [linkAction, setLinkAction] = useState<LinkActionState | null>(null);
  const [isContentSwapping, setIsContentSwapping] = useState(false);
  const linkActionRef = useRef<LinkActionState | null>(null);
  linkActionRef.current = linkAction;
  const mouseMoveFrameRef = useRef(0);
  const editorMode = controlledEditorMode ?? "edit";
  const hostPickerRangeRef = useRef<Range | null>(null);
  const hostPickerListRef = useRef<FixedSizeVirtualListHandle>(null);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const setLinkActionIfChanged = useCallback((next: LinkActionState | null) => {
    if (linkActionStatesEqual(linkActionRef.current, next)) return;
    linkActionRef.current = next;
    setLinkAction(next);
  }, []);

  // Rewrite /public/* → /* for Vite static root (edit + preview). Display only;
  // onChange still receives editor output (paste path also normalizes).
  const displayMarkdown = useMemo(
    () => normalizeNotePublicAssetPaths(value),
    [value],
  );

  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    // Remote images from paste / markdown. allowSetImageDimensions keeps width/height
    // from HTML <img width height> (GitHub README style) editable in the UI.
    imagePlugin({
      allowSetImageDimensions: true,
    }),
    codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    codeMirrorPlugin({
      codeBlockLanguages: NOTE_CODE_BLOCK_LANGUAGES,
      codeMirrorExtensions: NOTE_CODE_MIRROR_EXTENSIONS,
    }),
    ...(editorMode === "edit" ? [
      toolbarPlugin({
        toolbarContents: () => <NoteMarkdownToolbar />,
        toolbarClassName: "netcatty-note-markdown-toolbar",
      }),
    ] : []),
    markdownShortcutPlugin(),
  ], [editorMode]);
  const hostCandidates = useMemo(
    () => hosts.filter(isSshCandidateHost),
    [hosts],
  );
  const filteredHosts = useMemo(() => {
    return filterHostPickerHosts(hostCandidates, hostPicker.query);
  }, [hostCandidates, hostPicker.query]);

    const cancelDeferredContentSwap = useCallback(() => {
    const frames = contentSwapFramesRef.current;
    if (frames.outer) window.cancelAnimationFrame(frames.outer);
    if (frames.inner) window.cancelAnimationFrame(frames.inner);
    contentSwapFramesRef.current = { outer: 0, inner: 0 };
  }, []);

  /** Clear shared Lexical undo/redo so Undo after a note switch cannot restore another note. */
  const clearLexicalHistory = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const editable = container.querySelector("[contenteditable]");
    if (!(editable instanceof Element)) return;
    const lexicalEditor = getNearestEditorFromDOMNode(editable);
    if (!lexicalEditor) return;
    try {
      lexicalEditor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    } catch {
      // History plugin may not be mounted yet.
    }
  }, []);

  // Swap note content without remounting MDX/Lexical (key=noteId was the main
  // switch lag). Parent flushes drafts before changing noteId/value.
  // Yield a paint (double rAF) before setMarkdown so the notes tree selection
  // can commit first; always show a blocking overlay while Lexical imports so
  // toolbar/IME cannot mutate the previous note's tree.
  // Cancel pending frames via token/ref only on the next note switch or unmount —
  // not on effect re-runs for same-note value churn (that would drop the import).
  useEffect(() => {
    const markdown = displayMarkdown;
    const noteChanged = noteId !== undefined && noteId !== noteIdRef.current;

    if (noteChanged) {
      const scheduledNoteId = noteId;
      noteIdRef.current = noteId;
      pasteRecoveryGenerationRef.current += 1;
      // Keep both refs in displayMarkdown space so public-path normalization
      // does not look like a divergent local draft.
      latestMarkdownRef.current = markdown;
      syncedPropValueRef.current = markdown;
      setHostPicker((current) => (
        current.open
          ? { ...current, open: false, query: "", selectedIndex: 0 }
          : current
      ));
      setLinkActionIfChanged(null);

      cancelDeferredContentSwap();
      const token = contentSwapTokenRef.current + 1;
      contentSwapTokenRef.current = token;
      contentSwapPendingRef.current = true;
      contentSwapScheduledRef.current = { token, noteId: scheduledNoteId, markdown };
      setIsContentSwapping(true);

      contentSwapFramesRef.current.outer = window.requestAnimationFrame(() => {
        contentSwapFramesRef.current.outer = 0;
        contentSwapFramesRef.current.inner = window.requestAnimationFrame(() => {
          contentSwapFramesRef.current.inner = 0;
          if (token !== contentSwapTokenRef.current) return;
          const scheduled = contentSwapScheduledRef.current;
          if (!scheduled || scheduled.token !== token) {
            contentSwapPendingRef.current = false;
            startTransition(() => setIsContentSwapping(false));
            return;
          }
          // Drop the import if the user already edited away from the scheduled body.
          if (
            noteIdRef.current !== scheduled.noteId
            || latestMarkdownRef.current !== scheduled.markdown
          ) {
            contentSwapPendingRef.current = false;
            contentSwapScheduledRef.current = null;
            startTransition(() => setIsContentSwapping(false));
            return;
          }
          try {
            // Use scheduled.markdown (may have been refreshed during the yield).
            editorRef.current?.setMarkdown(scheduled.markdown);
            clearLexicalHistory();
          } catch {
            // MDX may not be mounted yet (mode empty-preview); next mount gets markdown prop.
          }
          contentSwapPendingRef.current = false;
          contentSwapScheduledRef.current = null;
          startTransition(() => setIsContentSwapping(false));
        });
      });
      return;
    }

    // Deferred switch still in flight: refresh the payload if the same note's
    // external value changed (sync/publish), otherwise skip competing imports.
    if (contentSwapPendingRef.current) {
      if (
        noteId !== undefined
        && noteId === noteIdRef.current
        && contentSwapScheduledRef.current?.noteId === noteId
      ) {
        contentSwapScheduledRef.current = {
          ...contentSwapScheduledRef.current,
          markdown,
        };
        latestMarkdownRef.current = markdown;
        syncedPropValueRef.current = markdown;
      }
      return;
    }

    if (latestMarkdownRef.current === value || latestMarkdownRef.current === markdown) {
      latestMarkdownRef.current = markdown;
      syncedPropValueRef.current = markdown;
      return;
    }
    // Local draft diverged from last external value — do not clobber.
    if (latestMarkdownRef.current !== syncedPropValueRef.current) {
      return;
    }
    pasteRecoveryGenerationRef.current += 1;
    syncedPropValueRef.current = markdown;
    latestMarkdownRef.current = markdown;
    try {
      editorRef.current?.setMarkdown(markdown);
      clearLexicalHistory();
    } catch {
      // ignore
    }
  }, [
    noteId,
    value,
    displayMarkdown,
    setLinkActionIfChanged,
    cancelDeferredContentSwap,
    clearLexicalHistory,
  ]);

  useEffect(() => () => {
    pasteRecoveryGenerationRef.current += 1;
    contentSwapTokenRef.current += 1;
    contentSwapPendingRef.current = false;
    cancelDeferredContentSwap();
    if (mouseMoveFrameRef.current) {
      window.cancelAnimationFrame(mouseMoveFrameRef.current);
      mouseMoveFrameRef.current = 0;
    }
  }, [cancelDeferredContentSwap]);

  useEffect(() => {
    if (!hostPicker.open) return;
    if (hostPicker.selectedIndex < filteredHosts.length) return;
    setHostPicker((current) => ({
      ...current,
      selectedIndex: Math.max(0, filteredHosts.length - 1),
    }));
  }, [filteredHosts.length, hostPicker.open, hostPicker.selectedIndex]);

  useEffect(() => {
    if (!hostPicker.open || filteredHosts.length === 0) return;
    hostPickerListRef.current?.scrollToIndex(hostPicker.selectedIndex);
  }, [filteredHosts.length, hostPicker.open, hostPicker.selectedIndex]);

  useEffect(() => {
    if (editorMode === "edit") return;
    hostPickerRangeRef.current = null;
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
  }, [editorMode]);

  useEffect(() => {
    setLinkAction(null);
  }, [editorMode]);

  const getHostPickerContext = useCallback(() => {
    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer)) return null;
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    const textNode = range.startContainer as Text;
    const textBeforeCursor = textNode.data.slice(0, range.startOffset);
    const triggerRangeInfo = getHostPickerTriggerRange(textBeforeCursor);
    if (!triggerRangeInfo) return null;

    const triggerRange = document.createRange();
    triggerRange.setStart(textNode, triggerRangeInfo.startOffset);
    triggerRange.setEnd(textNode, range.startOffset);

    const caretRect = range.getBoundingClientRect();
    const fallbackRect = triggerRange.getBoundingClientRect();
    const anchorRect = caretRect.width || caretRect.height ? caretRect : fallbackRect;
    const containerRect = container.getBoundingClientRect();
    const position = resolveHostPickerPopupPosition({
      anchorRect,
      availableHostCount: filterHostPickerHosts(hostCandidates, triggerRangeInfo.query).length,
      containerRect,
      viewportHeight: window.innerHeight,
    });

    return {
      left: position.left,
      query: triggerRangeInfo.query,
      range: triggerRange,
      trigger: triggerRangeInfo.trigger,
      top: position.top,
    };
  }, [hostCandidates]);

  const updateHostPickerFromSelection = useCallback(() => {
    const context = getHostPickerContext();
    if (!context) {
      hostPickerRangeRef.current = null;
      setHostPicker((current) => current.open
        ? { ...current, open: false, query: "", selectedIndex: 0 }
        : current);
      return;
    }

    hostPickerRangeRef.current = context.range.cloneRange();
    setHostPicker((current) => ({
      open: true,
      query: context.query,
      selectedIndex: current.open && current.query === context.query ? current.selectedIndex : 0,
      trigger: context.trigger,
      left: context.left,
      top: context.top,
    }));
  }, [getHostPickerContext]);

  const scheduleHostPickerUpdate = useCallback(() => {
    if (editorMode !== "edit") return;
    window.requestAnimationFrame(updateHostPickerFromSelection);
  }, [editorMode, updateHostPickerFromSelection]);

  const annotateHostLinks = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const hostsSnapshot = hostsRef.current;

    container.querySelectorAll<HTMLAnchorElement>(".netcatty-mdx-content a[href]").forEach((link) => {
      const renderedHref = link.getAttribute("href") || link.href;
      const label = link.textContent?.trim() || renderedHref;
      if (!renderedHref) return;
      const href = resolveRenderedMarkdownLinkHref(latestMarkdownRef.current, label, renderedHref);
      const host = buildSshNoteLinkOpenHost(hostsSnapshot, href, label, {
        id: "note-link-preview",
        now: 0,
      });

      if (host) {
        link.dataset.netcattyHostLink = "true";
        link.title = `打开主机 ${label}`;
      } else {
        delete link.dataset.netcattyHostLink;
        link.removeAttribute("title");
      }
    });
  }, []);

  const annotateCodeBlockCopyButtons = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    annotateNoteCodeBlockCopyButtons(container, {
      copyLabel: t("action.copy"),
      copiedLabel: t("notes.codeBlock.copied"),
      copyFailedLabel: t("notes.codeBlock.copyFailed"),
      onCopy: copyToClipboard,
    });
  }, [t]);

  // DOM decoration: host links, image sizes, preview code-copy buttons.
  // Preview observes mutations (MDX mounts); edit debounces to avoid per-keystroke walks.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    let debounceTimer = 0;
    const EDIT_DECORATION_DEBOUNCE_MS = 180;

    const runDecorations = (includeHostLinks: boolean) => {
      annotateNoteImageSizes(container);
      if (includeHostLinks) annotateHostLinks();
      if (editorMode === "preview") {
        annotateCodeBlockCopyButtons();
      } else {
        removeNoteCodeBlockCopyButtons(container);
      }
    };

    const scheduleFromMutation = () => {
      if (editorMode === "preview") {
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          runDecorations(true);
        });
        return;
      }
      // Debounced: still re-annotate host links after setMarkdown swaps in edit
      // mode (childList) and after image width/height edits (attributes).
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = 0;
        runDecorations(true);
      }, EDIT_DECORATION_DEBOUNCE_MS);
    };

    runDecorations(true);

    const observer = new MutationObserver(scheduleFromMutation);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["width", "height", "src", "href"],
    });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      if (debounceTimer) window.clearTimeout(debounceTimer);
      removeNoteCodeBlockCopyButtons(container);
    };
  }, [annotateCodeBlockCopyButtons, annotateHostLinks, editorMode]);

  // Host list identity can change while a note stays open (vault refresh).
  useEffect(() => {
    annotateHostLinks();
  }, [annotateHostLinks, hosts]);

  const commitMarkdown = useCallback((markdown: string) => {
    // Deferred note-switch still shows the previous Lexical tree; ignore muted
    // or stale onChange so we never write note A's body into note B's draft.
    if (contentSwapPendingRef.current) return;
    if (markdown === latestMarkdownRef.current) return;
    latestMarkdownRef.current = markdown;
    onChange(markdown);
  }, [onChange]);

  const insertHostLink = useCallback((host: Host) => {
    const link = `[${getHostLinkLabel(host)}](${formatSshDeepLinkForHost(host)})`;
    const editor = editorRef.current;
    const replacementRange = getHostPickerContext()?.range ?? hostPickerRangeRef.current;
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
    hostPickerRangeRef.current = null;

    if (editor) {
      editor.focus();
      if (replacementRange) {
        const didDeleteTrigger = deleteLexicalTextRange(replacementRange, () => {
          editor.insertMarkdown(link);
        });
        if (didDeleteTrigger) return;
      }
      editor.insertMarkdown(link);
      return;
    }

    const next = latestMarkdownRef.current
      ? `${latestMarkdownRef.current}\n${link}`
      : link;
    commitMarkdown(next);
  }, [commitMarkdown, getHostPickerContext]);

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editorMode !== "edit") return;
    if (!shouldHandleHostPickerNavigationKey(hostPicker.open, event.key, filteredHosts.length)) return;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();

    if (event.key === "Escape") {
      setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
      return;
    }

    if (event.key === "ArrowDown") {
      setHostPicker((current) => ({
        ...current,
        selectedIndex: (current.selectedIndex + 1) % filteredHosts.length,
      }));
      return;
    }

    if (event.key === "ArrowUp") {
      setHostPicker((current) => ({
        ...current,
        selectedIndex: (current.selectedIndex - 1 + filteredHosts.length) % filteredHosts.length,
      }));
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      const selectedHost = filteredHosts[hostPicker.selectedIndex];
      if (!selectedHost) return;
      insertHostLink(selectedHost);
      return;
    }
  }, [
    filteredHosts,
    editorMode,
    hostPicker.open,
    hostPicker.selectedIndex,
    insertHostLink,
  ]);

  const handleKeyUpCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editorMode !== "edit") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (hostCandidates.length === 0) return;
    if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
    scheduleHostPickerUpdate();
  }, [editorMode, hostCandidates.length, scheduleHostPickerUpdate]);

  const openLink = useCallback((href: string, label?: string): boolean => {
    const host = buildSshNoteLinkOpenHost(hosts, href, label, {
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    if (host) {
      if (onOpenHost) {
        onOpenHost(host);
      }
      return true;
    }

    if (!isSupportedNoteExternalHref(href)) return false;
    void openExternalLink(href, onOpenExternalLink);
    return true;
  }, [hosts, onOpenExternalLink, onOpenHost]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (contentSwapPendingRef.current) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    const container = containerRef.current;
    if (!container?.contains(target)) return;

    // Preview is readOnly — Lexical CheckListPlugin refuses toggles. Map the
    // checkbox click back onto GFM markdown so todos stay interactive.
    if (editorMode === "preview") {
      const taskItem = target.closest<HTMLElement>("li[role='checkbox'], li[aria-checked]");
      if (taskItem && container.contains(taskItem)) {
        const itemRect = taskItem.getBoundingClientRect();
        if (isPointerOnTaskCheckbox(itemRect, event.clientX)) {
          const items = container.querySelectorAll<HTMLElement>(
            "li[role='checkbox'], li[aria-checked]",
          );
          const index = Array.prototype.indexOf.call(items, taskItem);
          if (index >= 0) {
            const next = toggleTaskListItemAtIndex(latestMarkdownRef.current, index);
            if (next !== latestMarkdownRef.current) {
              event.preventDefault();
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation?.();
              commitMarkdown(next);
              try {
                editorRef.current?.setMarkdown(next);
              } catch {
                // ignore — next mount/sync will pick up value
              }
              return;
            }
          }
        }
      }

      const link = target.closest<HTMLAnchorElement>("a[href]");
      const renderedHref = link?.getAttribute("href") || link?.href;
      if (!link || !renderedHref || !container.contains(link)) return;

      const label = link.textContent?.trim() || renderedHref;
      const href = resolveRenderedMarkdownLinkHref(
        latestMarkdownRef.current,
        label,
        renderedHref,
      );
      const handled = openLink(href, label);
      if (!handled) return;

      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation?.();
      return;
    }

    scheduleHostPickerUpdate();
  }, [commitMarkdown, editorMode, openLink, scheduleHostPickerUpdate]);

  const activateLinkAction = useCallback((
    event: React.SyntheticEvent<HTMLElement>,
    action: LinkActionState,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    const last = lastLinkActivationRef.current;
    if (last?.href === action.href && now - last.at < 350) {
      return;
    }
    lastLinkActivationRef.current = { href: action.href, at: now };
    openLink(action.href, action.label);
    setLinkActionIfChanged(null);
  }, [openLink, setLinkActionIfChanged]);

  const handleMouseMoveCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (editorMode !== "edit") {
      setLinkActionIfChanged(null);
      return;
    }

    // Coalesce to one evaluation per frame while scrubbing links in large docs.
    const clientX = event.clientX;
    const clientY = event.clientY;
    const target = event.target;
    if (mouseMoveFrameRef.current) {
      window.cancelAnimationFrame(mouseMoveFrameRef.current);
    }
    mouseMoveFrameRef.current = window.requestAnimationFrame(() => {
      mouseMoveFrameRef.current = 0;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-note-link-action]")) return;

      const link = target.closest<HTMLAnchorElement>("a[href]");
      const renderedHref = link?.getAttribute("href") || link?.href;
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const pointerX = clientX - containerRect.left;
      const pointerY = clientY - containerRect.top;

      if (!link || !renderedHref) {
        if (!isPointerInsideLinkActionHoverZone(linkActionRef.current, pointerX, pointerY)) {
          setLinkActionIfChanged(null);
        }
        return;
      }

      const label = link.textContent?.trim() || renderedHref;
      // Fast path: skip full-markdown scan when the rendered href is already openable.
      let href = renderedHref;
      if (
        !isSupportedNoteExternalHref(renderedHref)
        && !/^ssh:/i.test(renderedHref)
      ) {
        href = resolveRenderedMarkdownLinkHref(
          latestMarkdownRef.current,
          label,
          renderedHref,
        );
      }
      const canOpenLink = Boolean(buildSshNoteLinkOpenHost(hostsRef.current, href, label, {
        id: "note-link-hover",
        now: 0,
      })) || isSupportedNoteExternalHref(href);
      if (!canOpenLink) {
        setLinkActionIfChanged(null);
        return;
      }
      const linkRect = link.getBoundingClientRect();
      setLinkActionIfChanged({
        href,
        label,
        left: Math.max(0, Math.min(containerRect.width - LINK_ACTION_SIZE - 6, linkRect.right - containerRect.left + 2)),
        top: Math.max(0, linkRect.top - containerRect.top - 2),
      });
    });
  }, [editorMode, setLinkActionIfChanged]);

  const handleBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) return;
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
  }, []);

  const handlePasteCapture = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    // Browser / Word copies put structure in text/html; text/plain is often
    // flattened. Resolve HTML → markdown so rich paste is not a silent no-op.
    const payload = resolveNoteClipboardPaste({
      plainText: event.clipboardData.getData("text/plain"),
      htmlText: event.clipboardData.getData("text/html"),
    });
    const markdown = payload.text;
    const editor = editorRef.current;
    const canInsertAtSelection = Boolean(editor)
      && hasActiveLexicalTextSelection(event.target);
    if (
      !shouldInterceptResolvedNotePaste({
        editorMode,
        pasteInsideCodeBlock: isNotePasteInsideCodeBlock(event.target),
        payload,
      })
    ) {
      return;
    }
    if (!editor) return;

    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();

    const applyDocumentPaste = () => {
      // Prefer live editor markdown: a prior insertMarkdown may have updated Lexical
      // while onChange was muted, leaving latestMarkdownRef stale.
      const currentMarkdown = editor.getMarkdown();
      const next = mergeNoteMarkdownDocumentPaste(currentMarkdown, markdown);
      // setMarkdown mutes MDXEditor onChange; commit the draft ourselves so
      // autosave still sees the pasted body.
      editor.setMarkdown(next);
      commitMarkdown(next);
    };

    const strategy = resolveNoteMarkdownPasteStrategy({
      canInsertMarkdownAtSelection: canInsertAtSelection,
      clipboardText: markdown,
    });

    // Document merge (append) only when there is no caret. With a selection,
    // always insertMarkdown and never fall back to EOF append.
    if (strategy === "document-merge") {
      applyDocumentPaste();
    } else {
      // Baseline the live Lexical export — after muted setMarkdown (note switch),
      // latestMarkdownRef can still be the input string while getMarkdown() is the
      // round-tripped export. Comparing against the ref alone can false-positive
      // "paste applied" and drop the clipboard body after preventDefault.
      const beforeLatest = latestMarkdownRef.current;
      let beforeEditor = beforeLatest;
      try {
        beforeEditor = editor.getMarkdown();
      } catch {
        beforeEditor = beforeLatest;
      }
      const recoveryGeneration = ++pasteRecoveryGenerationRef.current;
      const maxAttempts = resolveNoteMarkdownPasteSettleAttempts(markdown.length);
      const emptyDoc = !beforeEditor.replace(/\s+/g, "");
      const pasteTarget = event.target;
      // After the first insert is definitively unchanged, retry once at the
      // selection — never mid-window (that can double-apply a merely-slow update).
      const postFailureSettleAttempts = Math.max(
        3,
        Math.floor(NOTE_MARKDOWN_PASTE_SETTLE_MIN_ATTEMPTS / 2),
      );
      const draftStillOurs = () => (
        latestMarkdownRef.current === beforeLatest
        || latestMarkdownRef.current === beforeEditor
      );

      const recoverInterceptedPasteAtSelection = () => {
        if (pasteRecoveryGenerationRef.current !== recoveryGeneration) return;
        if (!draftStillOurs()) return;
        // First insert may still be in flight past the poll window — re-check
        // before a second insertMarkdown to avoid double-applying a slow update.
        let live = beforeEditor;
        try {
          live = editor.getMarkdown();
        } catch {
          live = beforeEditor;
        }
        if (live !== beforeEditor) {
          commitMarkdown(live);
          return;
        }
        try {
          editor.focus();
          editor.insertMarkdown(markdown);
        } catch {
          // Fall through to Lexical text insert below after settle.
        }
        const tryCommitRecoveredPaste = (attempt: number) => {
          if (pasteRecoveryGenerationRef.current !== recoveryGeneration) return;
          if (!draftStillOurs()) return;
          let current = beforeEditor;
          try {
            current = editor.getMarkdown();
          } catch {
            current = beforeEditor;
          }
          if (current !== beforeEditor) {
            commitMarkdown(current);
            return;
          }
          if (attempt < postFailureSettleAttempts) {
            window.setTimeout(
              () => tryCommitRecoveredPaste(attempt + 1),
              NOTE_MARKDOWN_PASTE_SETTLE_POLL_MS,
            );
            return;
          }
          // insertMarkdown still no-op'd: keep caret locus via Lexical insertText.
          if (!insertClipboardTextAtActiveLexicalSelection(pasteTarget, markdown)) return;
          try {
            const next = editor.getMarkdown();
            if (next !== beforeEditor) commitMarkdown(next);
          } catch {
            // Selection insert may not serialize; avoid discarding silently only
            // when Lexical accepted the text (didInsert). Nothing more to commit.
          }
        };
        window.setTimeout(
          () => tryCommitRecoveredPaste(0),
          NOTE_MARKDOWN_PASTE_SETTLE_POLL_MS,
        );
      };

      try {
        editor.focus();
        editor.insertMarkdown(markdown);
      } catch {
        // Only append when the document is empty — never jump mid-doc paste to EOF.
        if (emptyDoc) applyDocumentPaste();
        else recoverInterceptedPasteAtSelection();
        setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
        setLinkAction(null);
        return;
      }
      // insertMarkdown's Lexical update is deferred. Commit when settled; if it
      // still no-ops after the settle window, recover at the selection (or append
      // only for an empty document).
      const tryCommitSettledPaste = (attempt: number) => {
        if (pasteRecoveryGenerationRef.current !== recoveryGeneration) return;
        if (!draftStillOurs()) return;
        let current = beforeEditor;
        try {
          current = editor.getMarkdown();
        } catch {
          if (emptyDoc) applyDocumentPaste();
          else recoverInterceptedPasteAtSelection();
          return;
        }
        if (current !== beforeEditor) {
          commitMarkdown(current);
          return;
        }
        if (attempt >= maxAttempts) {
          if (emptyDoc) applyDocumentPaste();
          else recoverInterceptedPasteAtSelection();
          return;
        }
        window.setTimeout(
          () => tryCommitSettledPaste(attempt + 1),
          NOTE_MARKDOWN_PASTE_SETTLE_POLL_MS,
        );
      };
      window.setTimeout(
        () => tryCommitSettledPaste(0),
        NOTE_MARKDOWN_PASTE_SETTLE_POLL_MS,
      );
    }

    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
    setLinkAction(null);
  }, [commitMarkdown, editorMode]);

  const blockWhileContentSwapping = useCallback((event: React.SyntheticEvent) => {
    if (!contentSwapPendingRef.current) return false;
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();
    return true;
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full flex-col"
      aria-busy={isContentSwapping || undefined}
      onBlurCapture={handleBlurCapture}
      onClickCapture={(event) => {
        if (blockWhileContentSwapping(event)) return;
        handleClickCapture(event);
      }}
      onPointerDownCapture={blockWhileContentSwapping}
      onDragStartCapture={blockWhileContentSwapping}
      onDropCapture={blockWhileContentSwapping}
      onInputCapture={(event) => {
        if (blockWhileContentSwapping(event)) return;
        scheduleHostPickerUpdate();
      }}
      onKeyDownCapture={(event) => {
        // Block edits while Lexical import is deferred/running (toolbar/IME too).
        if (blockWhileContentSwapping(event)) return;
        handleKeyDownCapture(event);
      }}
      onKeyUpCapture={handleKeyUpCapture}
      onMouseLeave={() => {
        if (mouseMoveFrameRef.current) {
          window.cancelAnimationFrame(mouseMoveFrameRef.current);
          mouseMoveFrameRef.current = 0;
        }
        setLinkActionIfChanged(null);
      }}
      onMouseMoveCapture={handleMouseMoveCapture}
      onPasteCapture={(event) => {
        if (blockWhileContentSwapping(event)) return;
        handlePasteCapture(event);
      }}
    >
      {isContentSwapping && (
        // Instant solid cover — no fade/opacity animation (composites poorly over Lexical).
        <div
          className="absolute inset-0 z-20 bg-background"
          data-notes-content-swapping="true"
          aria-hidden="true"
        />
      )}
      {editorMode === "edit" && linkAction && (
        <button
          type="button"
          data-note-link-action="true"
          title={`打开 ${linkAction.label}`}
          className="absolute z-40 flex h-7 w-7 items-center justify-center rounded-md bg-popover text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground"
          style={{ left: linkAction.left, top: linkAction.top }}
          onPointerDown={(event) => activateLinkAction(event, linkAction)}
          onMouseDown={(event) => activateLinkAction(event, linkAction)}
          onClick={(event) => activateLinkAction(event, linkAction)}
        >
          <ExternalLink size={14} />
        </button>
      )}
      {hostPicker.open && (
        <div
          className="absolute z-30 w-[min(24rem,calc(100vw-4rem))] overflow-hidden rounded-md border border-border/70 bg-popover text-popover-foreground shadow-lg"
          style={{ left: hostPicker.left, top: hostPicker.top }}
        >
          <div className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
            {hostPicker.query ? `${hostPicker.trigger}${hostPicker.query}` : "选择主机"}
          </div>
            <div
              className="max-h-64"
              style={{
                height: Math.min(
                  HOST_PICKER_LIST_MAX_HEIGHT,
                  filteredHosts.length === 0
                    ? HOST_PICKER_EMPTY_HEIGHT
                    : HOST_PICKER_LIST_VERTICAL_PADDING + filteredHosts.length * HOST_PICKER_ROW_HEIGHT,
                ),
              }}
            >
              {filteredHosts.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">没有匹配的主机</div>
              ) : (
                <FixedSizeVirtualList
                  ref={hostPickerListRef}
                  items={filteredHosts}
                  itemHeight={HOST_PICKER_ROW_HEIGHT}
                  getItemKey={(host) => host.id}
                  className="h-full"
                  contentClassName="p-1"
                  renderItem={(host, index) => (
                    <button
                      type="button"
                      className={cn(
                        "flex h-full w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                        index === hostPicker.selectedIndex ? "bg-secondary text-foreground" : "hover:bg-secondary/70",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertHostLink(host)}
                    >
                      <span className="min-w-0 flex-1 truncate">{getHostLinkLabel(host)}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {host.username ? `${host.username}@` : ""}{host.hostname}
                      </span>
                    </button>
                  )}
                />
              )}
            </div>
        </div>
      )}
      {editorMode === "preview" && !displayMarkdown.trim() ? (
        <div className="netcatty-note-preview-empty">
          {previewEmptyLabel ?? placeholder}
        </div>
      ) : (
        <MDXEditor
          key={editorMode}
          ref={editorRef}
          markdown={displayMarkdown}
          placeholder={placeholder}
          plugins={plugins}
          readOnly={editorMode === "preview"}
          className={cn(
            "netcatty-mdx-editor",
            editorMode === "preview" && "netcatty-mdx-editor--preview",
          )}
          contentEditableClassName="netcatty-mdx-content"
          onChange={commitMarkdown}
        />
      )}
    </div>
  );
});
