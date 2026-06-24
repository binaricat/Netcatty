import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CodeToggle,
  CreateLink,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
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
  $isTextNode,
  $setSelection,
  getNearestEditorFromDOMNode,
} from "lexical";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { resolveRenderedMarkdownLinkHref } from "../../domain/notes";
import { buildSshNoteLinkOpenHost } from "../../domain/sshDeepLink";
import { copyToClipboard } from "../keychain/utils";
import { toast } from "../ui/toast";
import { cn } from "../../lib/utils";
import type { Host } from "../../types";

export interface InlineMarkdownEditorProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
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

const PASTED_MARKDOWN_PATTERNS = [
  /^ {0,3}#{1,6}\s+\S/m,
  /^ {0,3}(?:[-+*]|\d+[.)])\s+\S/m,
  /^ {0,3}>\s+\S/m,
  /^ {0,3}(?:```|~~~)/m,
  /^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/m,
  /^ {0,3}\|?.+\|.+\n {0,3}\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m,
  /(^|[^!])\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"\n]*")?\)/,
  /(^|[\s([{])(?:\*\*|__)\S[\s\S]*?\S(?:\*\*|__)(?=$|[\s\])}.,;:!?])/,
  /(^|[\s([{])`[^`\n]+`(?=$|[\s\])}.,;:!?])/,
];

export const shouldInsertClipboardTextAsMarkdown = (text: string): boolean => {
  const markdown = text.replace(/\r\n?/g, "\n").trim();
  if (!markdown) return false;
  return PASTED_MARKDOWN_PATTERNS.some((pattern) => pattern.test(markdown));
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

export function InlineMarkdownEditor({
  value,
  placeholder,
  onChange,
  hosts = [],
  editorMode: controlledEditorMode,
  onOpenHost,
  onOpenExternalLink,
  previewEmptyLabel,
}: InlineMarkdownEditorProps) {
  const { t } = useI18n();
  const editorRef = useRef<MDXEditorMethods>(null);
  const latestMarkdownRef = useRef(value);
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
  const editorMode = controlledEditorMode ?? "edit";
  const hostPickerRangeRef = useRef<Range | null>(null);
  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
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

  useEffect(() => {
    if (latestMarkdownRef.current === value) return;
    latestMarkdownRef.current = value;
    editorRef.current?.setMarkdown(value);
  }, [value]);

  useEffect(() => {
    if (!hostPicker.open) return;
    if (hostPicker.selectedIndex < filteredHosts.length) return;
    setHostPicker((current) => ({
      ...current,
      selectedIndex: Math.max(0, filteredHosts.length - 1),
    }));
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

    container.querySelectorAll<HTMLAnchorElement>(".netcatty-mdx-content a[href]").forEach((link) => {
      const renderedHref = link.getAttribute("href") || link.href;
      const label = link.textContent?.trim() || renderedHref;
      if (!renderedHref) return;
      const href = resolveRenderedMarkdownLinkHref(latestMarkdownRef.current, label, renderedHref);
      const host = buildSshNoteLinkOpenHost(hosts, href, label, {
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
  }, [hosts]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(annotateHostLinks);
    return () => window.cancelAnimationFrame(frame);
  }, [annotateHostLinks, value]);

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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (editorMode !== "preview") {
      removeNoteCodeBlockCopyButtons(container);
      return;
    }

    annotateCodeBlockCopyButtons();
    const observer = new MutationObserver(() => {
      annotateCodeBlockCopyButtons();
    });
    observer.observe(container, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      removeNoteCodeBlockCopyButtons(container);
    };
  }, [annotateCodeBlockCopyButtons, editorMode, value]);

  const commitMarkdown = useCallback((markdown: string) => {
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
    if (editorMode !== "preview") {
      scheduleHostPickerUpdate();
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    const renderedHref = link?.getAttribute("href") || link?.href;
    if (!link || !renderedHref || !containerRef.current?.contains(link)) return;

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
  }, [editorMode, openLink, scheduleHostPickerUpdate]);

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
    setLinkAction(null);
  }, [openLink]);

  const handleMouseMoveCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (editorMode !== "edit") {
      setLinkAction(null);
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-note-link-action]")) return;

    const link = target.closest<HTMLAnchorElement>("a[href]");
    const renderedHref = link?.getAttribute("href") || link?.href;
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const pointerX = event.clientX - containerRect.left;
    const pointerY = event.clientY - containerRect.top;

    if (!link || !renderedHref) {
      if (!isPointerInsideLinkActionHoverZone(linkAction, pointerX, pointerY)) {
        setLinkAction(null);
      }
      return;
    }

    const label = link.textContent?.trim() || renderedHref;
    const href = resolveRenderedMarkdownLinkHref(
      latestMarkdownRef.current,
      label,
      renderedHref,
    );
    const canOpenLink = Boolean(buildSshNoteLinkOpenHost(hosts, href, label, {
      id: "note-link-hover",
      now: 0,
    })) || isSupportedNoteExternalHref(href);
    if (!canOpenLink) {
      setLinkAction(null);
      return;
    }
    const linkRect = link.getBoundingClientRect();
    setLinkAction({
      href,
      label,
      left: Math.max(0, Math.min(containerRect.width - LINK_ACTION_SIZE - 6, linkRect.right - containerRect.left + 2)),
      top: Math.max(0, linkRect.top - containerRect.top - 2),
    });
  }, [editorMode, hosts, linkAction]);

  const handleBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) return;
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
  }, []);

  const handlePasteCapture = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (editorMode !== "edit") return;
    if (isNotePasteInsideCodeBlock(event.target)) return;
    const markdown = event.clipboardData.getData("text/plain");
    if (!shouldInsertClipboardTextAsMarkdown(markdown)) return;

    const editor = editorRef.current;
    if (!editor) return;

    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation?.();
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
    setLinkAction(null);
    editor.insertMarkdown(markdown);
  }, [editorMode]);

  return (
    <div
      ref={containerRef}
      className="relative flex h-full flex-col"
      onBlurCapture={handleBlurCapture}
      onClickCapture={handleClickCapture}
      onInputCapture={scheduleHostPickerUpdate}
      onKeyDownCapture={handleKeyDownCapture}
      onKeyUpCapture={handleKeyUpCapture}
      onMouseLeave={() => setLinkAction(null)}
      onMouseMoveCapture={handleMouseMoveCapture}
      onPasteCapture={handlePasteCapture}
    >
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
          <div className="max-h-64 overflow-auto p-1">
            {filteredHosts.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">没有匹配的主机</div>
            ) : filteredHosts.map((host, index) => (
              <button
                key={host.id}
                type="button"
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
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
            ))}
          </div>
        </div>
      )}
      {editorMode === "preview" && !value.trim() ? (
        <div className="netcatty-note-preview-empty">
          {previewEmptyLabel ?? placeholder}
        </div>
      ) : (
        <MDXEditor
          key={editorMode}
          ref={editorRef}
          markdown={value}
          placeholder={placeholder}
          plugins={plugins}
          readOnly={editorMode === "preview"}
          className={cn("netcatty-mdx-editor", editorMode === "preview" && "netcatty-mdx-editor--preview")}
          contentEditableClassName="netcatty-mdx-content"
          onChange={commitMarkdown}
        />
      )}
    </div>
  );
}
