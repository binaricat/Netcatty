import {
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
  openNewImageDialog$,
  openLinkEditDialog$,
  quotePlugin,
  realmPlugin,
  tablePlugin,
  thematicBreakPlugin,
} from "@mdxeditor/editor";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { AlertTriangle, ExternalLink } from "lucide-react";
import {
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLEAR_HISTORY_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  getNearestEditorFromDOMNode,
} from "lexical";
import React, {
  startTransition,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import { renderNoteMathFormula } from "./noteMathRenderer";
import { createNoteCodeTooltipExtensions } from "./noteCodeTooltips";
import {
  EMPTY_ACTIVE_FORMATS,
  type ActiveTextFormats,
  type InlineMarkdownEditorHandle,
  type NoteEditorMode,
} from "./noteEditorTypes";

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

import { NoteSourceEditor, type NoteSourceEditorHandle } from "./NoteSourceEditor";
import {
  extractNoteHeadings,
  formatMarkdownListSelection,
  formatMarkdownQuoteSelection,
  normalizeNoteHeadingText,
  type MarkdownActionType,
  type NoteHeadingItem,
} from "../../domain/notes";

export { NoteSourceEditor, type NoteSourceEditorHandle };

const NOTE_HEADING_SELECTOR = [1, 2, 3, 4, 5, 6]
  .map((level) => `.netcatty-mdx-content h${level}`)
  .join(", ");

export const getRenderedNoteHeadingText = (element: HTMLElement): string => {
  const readNode = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    const nodeElement = node as Element;
    if (nodeElement.tagName?.toLowerCase() === "img") {
      return nodeElement.getAttribute("alt") ?? "";
    }
    return Array.from(node.childNodes ?? []).map(readNode).join("");
  };
  const childNodes = Array.from(element.childNodes ?? []);
  return childNodes.length > 0
    ? childNodes.map(readNode).join("")
    : element.textContent ?? "";
};

export const scrollNoteHeadingIntoView = (
  root: { querySelectorAll: (selector: string) => ArrayLike<HTMLElement> } | null,
  heading: Pick<NoteHeadingItem, "level" | "text">,
  occurrence = 0,
): boolean => {
  if (!root || occurrence < 0) return false;
  const target = Array.from(root.querySelectorAll(NOTE_HEADING_SELECTOR))
    .filter((element) => element.tagName.toLowerCase() === `h${heading.level}`
      && normalizeNoteHeadingText(getRenderedNoteHeadingText(element)) === normalizeNoteHeadingText(heading.text))[occurrence];
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
  return true;
};

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
  sourceEditorRef?: React.RefObject<NoteSourceEditorHandle | null>;
  noteFontFamily?: string;
  noteFontSize?: number;
  noteCodeFontSize?: number;
  /** Reports the active text-format toggles at the current selection (toolbar highlight). */
  onActiveFormatsChange?: (formats: ActiveTextFormats) => void;
}

export const NOTE_EDIT_DECORATION_DEBOUNCE_MS = 160;

export const shouldApplyMdxParseFailure = (input: {
  currentNoteId?: string;
  failedNoteId?: string;
  currentMarkdown: string;
  failedMarkdown: string;
}): boolean => input.currentNoteId === input.failedNoteId
  && input.currentMarkdown.trim() === input.failedMarkdown.trim();

export const getNoteDecorationMutationDelay = (editorMode: NoteEditorMode): number =>
  editorMode === "edit" || editorMode === "live" ? NOTE_EDIT_DECORATION_DEBOUNCE_MS : 0;

export const shouldApplyExternalNoteMarkdown = (input: {
  latestMarkdown: string;
  syncedMarkdown: string;
  latestSourceMarkdown: string;
  syncedSourceMarkdown: string;
  nextSourceMarkdown: string;
}): boolean => input.latestSourceMarkdown === input.nextSourceMarkdown
  || (
    input.latestMarkdown === input.syncedMarkdown
    && input.latestSourceMarkdown === input.syncedSourceMarkdown
  );

export interface NoteDecorationSchedulerRuntime {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
}

export const createNoteDecorationMutationScheduler = (
  editorMode: NoteEditorMode,
  runDecorations: () => void,
  runtime: NoteDecorationSchedulerRuntime,
): { schedule: () => void; cancel: () => void } => {
  let frame = 0;
  let timer = 0;
  let cancelled = false;

  return {
    schedule: () => {
      if (cancelled) return;
      const delay = getNoteDecorationMutationDelay(editorMode);
      if (delay > 0) {
        if (timer) runtime.clearTimer(timer);
        timer = runtime.setTimer(() => {
          timer = 0;
          if (!cancelled) runDecorations();
        }, delay);
        return;
      }
      if (frame) return;
      frame = runtime.requestFrame(() => {
        frame = 0;
        if (!cancelled) runDecorations();
      });
    },
    cancel: () => {
      cancelled = true;
      if (timer) runtime.clearTimer(timer);
      if (frame) runtime.cancelFrame(frame);
      timer = 0;
      frame = 0;
    },
  };
};

export interface NoteEditorDialogActions {
  openImageDialog: () => void;
  openLinkDialog: () => void;
}

export const invokeNoteEditorDialogAction = (
  action: MarkdownActionType,
  dialogActions: NoteEditorDialogActions | null,
): boolean => {
  if (!dialogActions) return false;
  if (action === "image") {
    dialogActions.openImageDialog();
    return true;
  }
  if (action === "link") {
    dialogActions.openLinkDialog();
    return true;
  }
  return false;
};

const noteEditorDialogBridgePlugin = realmPlugin<{
  setDialogActions: (actions: NoteEditorDialogActions) => void;
}>({
  init: (realm, params) => {
    params?.setDialogActions({
      openImageDialog: () => realm.pub(openNewImageDialog$),
      openLinkDialog: () => realm.pub(openLinkEditDialog$),
    });
  },
});

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
  latex: "LaTeX",
  markdown: "Markdown",
  md: "Markdown",
  nginx: "Nginx",
  plaintext: "Plain text",
  python: "Python",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  tex: "TeX",
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

  const cmContent = wrapper.querySelector(".cm-content");
  if (cmContent) {
    return cmContent.textContent?.replace(/\u00a0/g, " ") ?? "";
  }

  const codeEl = wrapper.querySelector("code");
  if (codeEl) {
    return codeEl.textContent?.replace(/\u00a0/g, " ") ?? "";
  }

  if (wrapper.tagName.toLowerCase() === "pre") {
    return wrapper.textContent?.replace(/\u00a0/g, " ") ?? "";
  }

  return "";
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

const COPY_ICON_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const CHECK_ICON_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const DELETE_ICON_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

function createCopyButton(
  wrapper: HTMLElement,
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
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.noteCodeCopy = "true";
  button.className = "netcatty-note-code-copy";
  button.title = copyLabel;
  button.setAttribute("aria-label", copyLabel);
  button.innerHTML = COPY_ICON_SVG;

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
      button.innerHTML = CHECK_ICON_SVG;
      button.title = copiedLabel;
      button.setAttribute("aria-label", copiedLabel);
      const timerId = window.setTimeout(() => {
        delete button.dataset.copied;
        delete button.dataset.resetTimerId;
        button.innerHTML = COPY_ICON_SVG;
        button.title = copyLabel;
        button.setAttribute("aria-label", copyLabel);
      }, 1500);
      button.dataset.resetTimerId = String(timerId);
    })();
  });

  return button;
}

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
  container.querySelectorAll('[class*="_codeMirrorWrapper_"], pre').forEach((rawNode) => {
    if (!(rawNode instanceof HTMLElement)) return;

    const wrapper = rawNode;
    const toolbar = wrapper.querySelector('[class*="_codeMirrorToolbar_"]');
    // In preview/read-only mode MDXEditor still renders the CodeMirror toolbar
    // in the DOM but CSS hides it (display: none). A copy button appended to a
    // hidden toolbar would never be visible, so treat a hidden toolbar as absent.
    const toolbarVisible =
      toolbar instanceof HTMLElement && getComputedStyle(toolbar).display !== "none";

    if (toolbarVisible) {
      // Live edit mode with toolbar
      const existingInToolbar = toolbar.querySelector("[data-note-code-copy]");
      wrapper.querySelectorAll("[data-note-code-copy]").forEach((btn) => {
        if (btn !== existingInToolbar) {
          clearNoteCodeBlockCopyResetTimer(btn as HTMLElement);
          btn.remove();
        }
      });

      if (existingInToolbar) {
        if (toolbar.lastElementChild !== existingInToolbar) {
          toolbar.appendChild(existingInToolbar);
        }
        return;
      }

      const button = createCopyButton(wrapper, { copyLabel, copiedLabel, copyFailedLabel, onCopy });
      toolbar.appendChild(button);
    } else {
      // Reading / preview mode without toolbar (or toolbar hidden by CSS)
      const existingButtons = wrapper.querySelectorAll("[data-note-code-copy]");
      if (existingButtons.length > 0) {
        // A button may have been appended to the hidden toolbar earlier; move it
        // onto the wrapper so it is visible in read-only mode.
        const firstButton = existingButtons[0] as HTMLElement;
        if (firstButton.parentElement !== wrapper) {
          wrapper.appendChild(firstButton);
        }
        for (let idx = 1; idx < existingButtons.length; idx++) {
          clearNoteCodeBlockCopyResetTimer(existingButtons[idx] as HTMLElement);
          existingButtons[idx].remove();
        }
        return;
      }

      if (getComputedStyle(wrapper).position === "static") {
        wrapper.style.position = "relative";
      }

      const button = createCopyButton(wrapper, { copyLabel, copiedLabel, copyFailedLabel, onCopy });
      wrapper.appendChild(button);
    }
  });
};

/**
 * Replaces MDXEditor's built-in filled-path delete icon with a standard
 * lucide-style stroke SVG so it matches the copy button in the toolbar.
 * The click handler (lexicalNode.remove()) is left untouched.
 */
export const annotateNoteCodeBlockDeleteButtons = (container: HTMLElement): void => {
  container.querySelectorAll('[class*="_codeMirrorToolbar_"]').forEach((toolbar) => {
    if (!(toolbar instanceof HTMLElement)) return;
    if (toolbar.querySelector("[data-note-code-delete]")) return;

    const deleteButton = Array.from(toolbar.querySelectorAll("button")).find(
      (button) =>
        !button.hasAttribute("data-note-code-copy") &&
        !button.hasAttribute("data-note-code-delete") &&
        !button.className.includes("_selectTrigger_") &&
        !button.className.includes("_toolbarCodeBlockLanguageSelectTrigger_"),
    );
    if (!deleteButton) return;

    deleteButton.dataset.noteCodeDelete = "true";
    deleteButton.innerHTML = DELETE_ICON_SVG;
  });
};

export const isNoteMathLanguageLabel = (value: string): boolean => {
  const normalized = value.toLowerCase().trim();
  if (!normalized) return false;
  return normalized === "latex"
    || normalized === "tex"
    || /(?:^|\s)language-(?:latex|tex)(?:\s|$)/.test(normalized);
};

export const shouldRenderNoteMathFormula = (
  languageLabel: string,
): boolean => isNoteMathLanguageLabel(languageLabel);

export const annotateMathFormulaBlocks = (container: HTMLElement, editorMode: string): void => {
  container.querySelectorAll('[class*="_codeMirrorWrapper_"], pre').forEach((wrapper) => {
    if (!(wrapper instanceof HTMLElement)) return;

    const langTrigger = wrapper.querySelector('[class*="_toolbarCodeBlockLanguageSelectTrigger_"], [class*="_selectTrigger_"], select');
    const triggerText = langTrigger?.textContent?.trim() ?? "";
    const dataLanguage = wrapper.getAttribute("data-language")?.trim() ?? "";
    const codeLanguage = /(?:^|\s)language-([^\s]+)/i.exec(
      wrapper.querySelector("code")?.className ?? "",
    )?.[1] ?? "";
    const selectLanguage = langTrigger instanceof HTMLSelectElement
      ? langTrigger.value.trim()
      : "";
    const lang = (dataLanguage || codeLanguage || selectLanguage || triggerText).toLowerCase();

    const text = getCodeMirrorBlockText(wrapper).trim();

    const isMathBlock = shouldRenderNoteMathFormula(lang);
    if (!isMathBlock) {
      const existingPreview = wrapper.querySelector(".netcatty-math-formula-preview");
      if (existingPreview) existingPreview.remove();
      wrapper.classList.remove("netcatty-math-reading-mode");
      return;
    }

    const formulaSource = text;
    if (!formulaSource) {
      const existingPreview = wrapper.querySelector(".netcatty-math-formula-preview");
      if (existingPreview) existingPreview.remove();
      wrapper.classList.remove("netcatty-math-reading-mode");
      return;
    }

    let preview = wrapper.querySelector(".netcatty-math-formula-preview") as HTMLElement | null;
    if (!preview) {
      preview = document.createElement("div");
      preview.className = "netcatty-math-formula-preview";
      wrapper.appendChild(preview);
    }

    if (preview.dataset.formulaSource !== formulaSource) {
      preview.dataset.formulaSource = formulaSource;
      preview.innerHTML = renderNoteMathFormula(formulaSource);
    }

    if (editorMode === "preview") {
      wrapper.classList.add("netcatty-math-reading-mode");
    } else {
      wrapper.classList.remove("netcatty-math-reading-mode");
    }
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

export const InlineMarkdownEditor = React.memo(
  React.forwardRef<InlineMarkdownEditorHandle, InlineMarkdownEditorProps>(function InlineMarkdownEditor(
    {
      value,
      placeholder,
      onChange,
      noteId,
      hosts = [],
      editorMode: controlledEditorMode,
      onOpenHost,
      onOpenExternalLink,
      previewEmptyLabel,
      sourceEditorRef,
      noteFontFamily,
      noteFontSize,
      noteCodeFontSize,
      onActiveFormatsChange,
    }: InlineMarkdownEditorProps,
    ref,
  ) {
    const { t } = useI18n();
    const editorRef = useRef<MDXEditorMethods>(null);
    const dialogActionsRef = useRef<NoteEditorDialogActions | null>(null);
    // Display-normalized space (same as setMarkdown / public-asset rewrite).
    const latestMarkdownRef = useRef(normalizeNotePublicAssetPaths(value));
    const syncedPropValueRef = useRef(normalizeNotePublicAssetPaths(value));
    // Raw persisted space used by source mode so display-only path rewrites
    // never suppress an intentional source edit.
    const latestSourceMarkdownRef = useRef(value);
    const syncedSourceMarkdownRef = useRef(value);
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

    const getSelectedText = useCallback((): string => {
      const container = containerRef.current;
      const domSelection = window.getSelection();
      const domText = domSelection?.toString() || "";
      if (domText) {
        if (domSelection && domSelection.rangeCount > 0 && container) {
          const range = domSelection.getRangeAt(0);
          if (container.contains(range.startContainer) && container.contains(range.endContainer)) {
            return domText;
          }
        }
        return "";
      }

      const editable = container?.querySelector("[contenteditable]");
      const lexicalEditor = editable ? getNearestEditorFromDOMNode(editable) : null;
      if (lexicalEditor) {
        let lexicalText = "";
        lexicalEditor.getEditorState().read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            lexicalText = selection.getTextContent();
          }
        });
        if (lexicalText) return lexicalText;
      }
      return "";
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        executeAction: (action: MarkdownActionType) => {
          if (controlledEditorMode === "source") {
            if (sourceEditorRef && "current" in sourceEditorRef && sourceEditorRef.current) {
              sourceEditorRef.current.insertAction(action);
            }
            return;
          }

          // Unrenderable-markdown fallback: the raw source editor is mounted.
          if (mdxFallbackActiveRef.current) {
            fallbackSourceEditorRef.current?.insertAction(action);
            return;
          }

          const container = containerRef.current;
          const editable = container?.querySelector("[contenteditable]");
          const lexicalEditor = editable ? getNearestEditorFromDOMNode(editable) : null;

          if (action === "undo" || action === "redo") {
            if (lexicalEditor) {
              lexicalEditor.dispatchCommand(action === "undo" ? UNDO_COMMAND : REDO_COMMAND, undefined);
            }
            return;
          }

          if (
            action === "bold" ||
            action === "italic" ||
            action === "underline" ||
            action === "strikethrough" ||
            action === "code"
          ) {
            if (lexicalEditor) {
              lexicalEditor.dispatchCommand(FORMAT_TEXT_COMMAND, action);
              return;
            }
          }

          const editor = editorRef.current;
          if (editor) {
            const rawSelection = getSelectedText();
            const sel = rawSelection.trim();
            const blockSelection = (fallback: string): string => sel ? rawSelection : fallback;
            switch (action) {
              case "h1":
                editor.insertMarkdown(`\n# ${sel || "Heading 1"}\n`);
                break;
              case "h2":
                editor.insertMarkdown(`\n## ${sel || "Heading 2"}\n`);
                break;
              case "h3":
                editor.insertMarkdown(`\n### ${sel || "Heading 3"}\n`);
                break;
              case "h4":
                editor.insertMarkdown(`\n#### ${sel || "Heading 4"}\n`);
                break;
              case "quote":
                editor.insertMarkdown(`\n${formatMarkdownQuoteSelection(blockSelection("Quote"))}\n`);
                break;
              case "bullet":
                editor.insertMarkdown(`\n${formatMarkdownListSelection(blockSelection("List item"), "bullet")}\n`);
                break;
              case "number":
                editor.insertMarkdown(`\n${formatMarkdownListSelection(blockSelection("List item"), "number")}\n`);
                break;
              case "task":
                editor.insertMarkdown(`\n${formatMarkdownListSelection(blockSelection("Task"), "task")}\n`);
                break;
              case "codeblock":
                editor.insertMarkdown(`\n\`\`\`bash\n${sel}\n\`\`\`\n`);
                break;
              case "table":
                editor.insertMarkdown("\n| Column 1 | Column 2 | Column 3 |\n| :--- | :--- | :--- |\n| Cell 1 | Cell 2 | Cell 3 |\n");
                break;
              case "divider":
                editor.insertMarkdown("\n---\n");
                break;
              case "link":
                invokeNoteEditorDialogAction(action, dialogActionsRef.current);
                break;
              case "image":
                invokeNoteEditorDialogAction(action, dialogActionsRef.current);
                break;
              case "math":
                editor.insertMarkdown(`\n\`\`\`latex\n${sel}\n\`\`\`\n`);
                break;
              default:
                break;
            }
          }
        },
        focus: () => {
          if (mdxFallbackActiveRef.current) {
            fallbackSourceEditorRef.current?.focus();
            return;
          }
          editorRef.current?.focus();
        },
        scrollToHeading: (heading: NoteHeadingItem, headingIndex: number) => {
          if (controlledEditorMode === "source") {
            return sourceEditorRef?.current?.scrollToLine(heading.line) ?? false;
          }
          if (mdxFallbackActiveRef.current) {
            return fallbackSourceEditorRef.current?.scrollToLine(heading.line) ?? false;
          }
          const occurrence = extractNoteHeadings(value)
            .slice(0, headingIndex)
            .filter((item) => item.level === heading.level && item.text === heading.text)
            .length;
          return scrollNoteHeadingIntoView(containerRef.current, heading, occurrence);
        },
      }),
      [controlledEditorMode, getSelectedText, sourceEditorRef, value],
    );
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
  const [acceptedSourceMarkdown, setAcceptedSourceMarkdown] = useState(value);
  const [isContentSwapping, setIsContentSwapping] = useState(false);
  // MDX (the rich editor's parser) rejects some CommonMark — e.g. unbalanced
  // angle tags like `<host>` in prose. MDXEditor then renders an EMPTY document
  // and only reports the failure through onError, which made such notes look
  // like they had lost their content. Track the failure and fall back to the
  // raw markdown source view so the content always stays visible.
  const [mdxParseFailure, setMdxParseFailure] = useState<string | null>(null);
  const linkActionRef = useRef<LinkActionState | null>(null);
  linkActionRef.current = linkAction;
  const mouseMoveFrameRef = useRef(0);
  const editorMode = controlledEditorMode ?? "edit";
  const mdxFallbackActive = mdxParseFailure !== null && editorMode !== "source";
  const mdxFallbackActiveRef = useRef(false);
  mdxFallbackActiveRef.current = mdxFallbackActive;
  const fallbackSourceEditorRef = useRef<NoteSourceEditorHandle | null>(null);
  const hostPickerRangeRef = useRef<Range | null>(null);
  const hostPickerListRef = useRef<FixedSizeVirtualListHandle>(null);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  // Report active text-format toggles (bold/italic/underline/strikethrough/
  // code) at the current selection so the toolbar can highlight enabled
  // buttons. Listens to Lexical selection/update changes in edit/live modes.
  useEffect(() => {
    if (!onActiveFormatsChange) return;
    if (mdxFallbackActive || (editorMode !== "edit" && editorMode !== "live")) {
      onActiveFormatsChange(EMPTY_ACTIVE_FORMATS);
      return;
    }

    const container = containerRef.current;
    const editable = container?.querySelector("[contenteditable]");
    const lexicalEditor = editable ? getNearestEditorFromDOMNode(editable) : null;
    if (!lexicalEditor) return;

    const readFormats = (): ActiveTextFormats => {
      const formats: ActiveTextFormats = { ...EMPTY_ACTIVE_FORMATS };
      lexicalEditor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          formats.bold = selection.hasFormat("bold");
          formats.italic = selection.hasFormat("italic");
          formats.underline = selection.hasFormat("underline");
          formats.strikethrough = selection.hasFormat("strikethrough");
          formats.code = selection.hasFormat("code");
        }
      });
      return formats;
    };

    const report = () => {
      onActiveFormatsChange(readFormats());
    };

    const unregisterUpdate = lexicalEditor.registerUpdateListener(report);
    const unregisterSelection = lexicalEditor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        report();
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    report();

    return () => {
      unregisterUpdate();
      unregisterSelection();
    };
  }, [editorMode, mdxFallbackActive, onActiveFormatsChange]);

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
      codeMirrorExtensions: [
        ...NOTE_CODE_MIRROR_EXTENSIONS,
        ...createNoteCodeTooltipExtensions(
          typeof document === "undefined" ? undefined : document.body,
          // Tooltips escape clipped code blocks via the body parent; bound
          // their placement to this notes editor so a completion near a pane
          // edge flips or shrinks instead of rendering over an adjacent pane.
          () => containerRef.current,
        ),
      ],
    }),
    markdownShortcutPlugin(),
    noteEditorDialogBridgePlugin({
      setDialogActions: (actions) => {
        dialogActionsRef.current = actions;
      },
    }),
  ], []);
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
      // The new note's markdown gets a fresh MDX import; clear a previous
      // note's unrenderable-markdown fallback.
      setMdxParseFailure(null);
      setMdxRetry(null);
      // Keep both refs in displayMarkdown space so public-path normalization
      // does not look like a divergent local draft.
      latestMarkdownRef.current = markdown;
      syncedPropValueRef.current = markdown;
      latestSourceMarkdownRef.current = value;
      syncedSourceMarkdownRef.current = value;
      setAcceptedSourceMarkdown(value);
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
        latestSourceMarkdownRef.current = value;
        syncedSourceMarkdownRef.current = value;
        setAcceptedSourceMarkdown(value);
      }
      return;
    }

    // Local display or source draft diverged from the last external value —
    // do not clobber it unless this value is the parent's echo of that draft.
    if (!shouldApplyExternalNoteMarkdown({
      latestMarkdown: latestMarkdownRef.current,
      syncedMarkdown: syncedPropValueRef.current,
      latestSourceMarkdown: latestSourceMarkdownRef.current,
      syncedSourceMarkdown: syncedSourceMarkdownRef.current,
      nextSourceMarkdown: value,
    })) {
      return;
    }
    const displayChanged = latestMarkdownRef.current !== markdown;
    pasteRecoveryGenerationRef.current += 1;
    syncedPropValueRef.current = markdown;
    latestMarkdownRef.current = markdown;
    latestSourceMarkdownRef.current = value;
    syncedSourceMarkdownRef.current = value;
    setAcceptedSourceMarkdown(value);
    if (displayChanged && mdxFallbackActiveRef.current) {
      // A sync/publish update replaced this note's unrenderable markdown while
      // the source fallback was active. editorRef.setMarkdown below would hit
      // the unmounted MDXEditor, so clear the failure instead: the rich editor
      // remounts with the new markdown. If it is still unrenderable, onError
      // re-arms the fallback.
      setMdxParseFailure(null);
      setMdxRetry(null);
    }
    if (!displayChanged) return;
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
    // Mode changes remount the rich editor (key={editorMode}); give its MDX
    // import a fresh chance after an unrenderable-markdown fallback.
    setMdxParseFailure(null);
    setMdxRetry(null);
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

    const runDecorations = (includeHostLinks: boolean) => {
      annotateNoteImageSizes(container);
      if (includeHostLinks) annotateHostLinks();
      annotateCodeBlockCopyButtons();
      annotateNoteCodeBlockDeleteButtons(container);
      annotateMathFormulaBlocks(container, editorMode);
    };

    const mutationScheduler = createNoteDecorationMutationScheduler(
      editorMode,
      () => runDecorations(true),
      {
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (id) => window.cancelAnimationFrame(id),
        setTimer: (callback, delay) => window.setTimeout(callback, delay),
        clearTimer: (id) => window.clearTimeout(id),
      },
    );

    runDecorations(true);

    const timer1 = window.setTimeout(() => runDecorations(true), 80);
    const timer2 = window.setTimeout(() => runDecorations(true), 300);

    const observer = new MutationObserver(mutationScheduler.schedule);
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["width", "height", "src", "href", "data-language"],
    });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer1);
      window.clearTimeout(timer2);
      mutationScheduler.cancel();
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
    latestSourceMarkdownRef.current = markdown;
    setAcceptedSourceMarkdown(markdown);
    onChange(markdown);
  }, [onChange]);

  const commitSourceMarkdown = useCallback((markdown: string) => {
    if (contentSwapPendingRef.current) return;
    if (markdown === latestSourceMarkdownRef.current) return;
    latestSourceMarkdownRef.current = markdown;
    latestMarkdownRef.current = normalizeNotePublicAssetPaths(markdown);
    setAcceptedSourceMarkdown(markdown);
    onChange(markdown);
  }, [onChange]);

  // MDXEditor reports markdown it cannot import through onError (the lexical
  // document is left empty). Switch to the raw source view so the note content
  // is never silently hidden; the user can retry or edit the raw markdown.
  // The failure is reported while MDXEditor's realm is still rendering, so a
  // synchronous setState here would be dropped — defer it to a timer.
  const handleMdxParseError = useCallback((payload: { error: string; source: string }) => {
    const failedNoteId = noteIdRef.current;
    const failedMarkdown = normalizeNotePublicAssetPaths(payload.source);
    window.setTimeout(() => {
      if (!shouldApplyMdxParseFailure({
        currentNoteId: noteIdRef.current,
        failedNoteId,
        currentMarkdown: latestMarkdownRef.current,
        failedMarkdown,
      })) return;
      // The same note can receive a newer external value before the deferred
      // callback runs. Do not show the old import failure over that content.
      setMdxParseFailure((current) => current ?? payload.error);
    }, 0);
  }, []);

  // One-shot markdown for the retry after a fallback: NotesManager debounces
  // source drafts, so the `value` prop can still hold the pre-fix body when
  // the user retries right after editing in the fallback. Seed that retry
  // import from the editor's own latest accepted source instead, but only while
  // the parent prop is still the stale body that originally failed.
  const [mdxRetry, setMdxRetry] = useState<{ markdown: string; staleValue: string } | null>(null);

  const retryRichNoteEditor = useCallback(() => {
    setMdxRetry({ markdown: latestSourceMarkdownRef.current, staleValue: value });
    setMdxParseFailure(null);
  }, [value]);

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
      style={{
        ["--note-font-family" as string]: noteFontFamily || undefined,
        ["--note-font-size" as string]: noteFontSize ? `${noteFontSize}px` : undefined,
        ["--note-code-font-size" as string]: noteCodeFontSize ? `${noteCodeFontSize}px` : undefined,
      }}
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
                <FixedSizeVirtualList<Host>
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
      {editorMode === "source" ? (
        <NoteSourceEditor
          ref={sourceEditorRef}
          noteId={noteId}
          value={noteId !== undefined && noteId !== noteIdRef.current ? value : acceptedSourceMarkdown}
          placeholder={placeholder}
          onChange={commitSourceMarkdown}
          noteFontFamily={noteFontFamily}
          noteFontSize={noteCodeFontSize || noteFontSize}
        />
      ) : mdxFallbackActive ? (
        <div
          data-note-markdown-source-fallback="true"
          className="flex min-h-[calc(100vh-15rem)] min-w-0 flex-1 flex-col"
        >
          <div
            data-note-markdown-source-notice="true"
            className="flex items-start gap-2 border-b border-border/60 bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{t("notes.editor.unrenderableMarkdown")}</span>
            <button
              type="button"
              data-note-markdown-source-retry="true"
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-foreground underline decoration-dotted hover:bg-secondary"
              onClick={retryRichNoteEditor}
            >
              {t("notes.editor.retryRichView")}
            </button>
          </div>
          <NoteSourceEditor
            ref={fallbackSourceEditorRef}
            noteId={noteId}
            value={noteId !== undefined && noteId !== noteIdRef.current ? value : acceptedSourceMarkdown}
            placeholder={placeholder}
            onChange={commitSourceMarkdown}
            readOnly={editorMode === "preview"}
            noteFontFamily={noteFontFamily}
            noteFontSize={noteCodeFontSize || noteFontSize}
          />
        </div>
      ) : editorMode === "preview" && !displayMarkdown.trim() ? (
        <div className="netcatty-note-preview-empty">
          {previewEmptyLabel ?? placeholder}
        </div>
      ) : (
        <MDXEditor
          key={editorMode}
          ref={editorRef}
          markdown={
            mdxRetry !== null && value === mdxRetry.staleValue
              ? normalizeNotePublicAssetPaths(mdxRetry.markdown)
              : displayMarkdown
          }
          placeholder={placeholder}
          plugins={plugins}
          readOnly={editorMode === "preview"}
          className={cn(
            "netcatty-mdx-editor",
            editorMode === "preview" && "netcatty-mdx-editor--preview",
          )}
          contentEditableClassName="netcatty-mdx-content"
          onChange={(markdown, initialMarkdownNormalize) => {
            // Importing Markdown may escape literal comparisons on export.
            // Keep the user's source until they actually edit the rich view.
            if (!initialMarkdownNormalize && editorMode !== "preview") {
              commitMarkdown(markdown);
            }
          }}
          onError={handleMdxParseError}
        />
      )}
    </div>
  );
}));
