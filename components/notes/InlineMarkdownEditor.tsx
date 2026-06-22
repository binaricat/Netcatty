import {
  codeBlockPlugin,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from "@mdxeditor/editor";
import { ExternalLink } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveRenderedMarkdownLinkHref } from "../../domain/notes";
import { buildSshNoteLinkOpenHost } from "../../domain/sshDeepLink";
import { cn } from "../../lib/utils";
import type { Host } from "../../types";

export interface InlineMarkdownEditorProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  hosts?: Host[];
  onOpenHost?: (host: Host) => void;
  onOpenExternalLink?: (url: string) => void | Promise<void>;
}

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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const removeHostPickerTriggerBeforeLink = (
  markdown: string,
  link: string,
  trigger: "@" | "/",
  query: string,
): string => {
  const triggerText = `${trigger}${query}`;
  const withQuery = new RegExp(`${escapeRegExp(triggerText)}(?=${escapeRegExp(link)})`);
  const withoutQuery = new RegExp(`${escapeRegExp(trigger)}(?=${escapeRegExp(link)})`);
  return markdown.replace(withQuery, "").replace(withoutQuery, "");
};

const openExternalLink = async (
  href: string,
  onOpenExternalLink?: (url: string) => void | Promise<void>,
) => {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }

  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;

  if (onOpenExternalLink) {
    await onOpenExternalLink(url.toString());
    return;
  }
  window.open(url.toString(), "_blank", "noopener,noreferrer");
};

export function InlineMarkdownEditor({
  value,
  placeholder,
  onChange,
  hosts = [],
  onOpenHost,
  onOpenExternalLink,
}: InlineMarkdownEditorProps) {
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
  const hostPickerRangeRef = useRef<Range | null>(null);
  const plugins = useMemo(() => [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    thematicBreakPlugin(),
    linkPlugin(),
    tablePlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    markdownShortcutPlugin(),
  ], []);
  const hostCandidates = useMemo(
    () => hosts.filter(isSshCandidateHost),
    [hosts],
  );
  const filteredHosts = useMemo(() => {
    const query = hostPicker.query.trim().toLowerCase();
    if (!query) return hostCandidates.slice(0, 8);
    return hostCandidates.filter((host) => {
      const haystack = [
        host.label,
        host.hostname,
        host.username,
        ...(host.tags || []),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    }).slice(0, 8);
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
    const triggerMatch = /(^|\s)([@/])([^\s@/]*)$/.exec(textBeforeCursor);
    if (!triggerMatch) return null;

    const triggerStart = triggerMatch.index + triggerMatch[1].length;
    const query = triggerMatch[3];
    const triggerRange = document.createRange();
    triggerRange.setStart(textNode, triggerStart);
    triggerRange.setEnd(textNode, range.startOffset);

    const caretRect = range.getBoundingClientRect();
    const fallbackRect = triggerRange.getBoundingClientRect();
    const anchorRect = caretRect.width || caretRect.height ? caretRect : fallbackRect;
    const containerRect = container.getBoundingClientRect();
    const left = Math.max(8, Math.min(containerRect.width - 392, anchorRect.left - containerRect.left));
    const top = Math.max(32, anchorRect.bottom - containerRect.top + 10);

    return {
      left,
      query,
      range: triggerRange,
      trigger: triggerMatch[2] as "@" | "/",
      top,
    };
  }, []);

  const updateHostPickerFromSelection = useCallback(() => {
    const context = getHostPickerContext();
    if (!context) {
      hostPickerRangeRef.current = null;
      setHostPicker((current) => current.open
        ? { ...current, open: false, query: "", selectedIndex: 0 }
        : current);
      return;
    }

    hostPickerRangeRef.current = context.range;
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
    window.requestAnimationFrame(updateHostPickerFromSelection);
  }, [updateHostPickerFromSelection]);

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

  const commitMarkdown = useCallback((markdown: string) => {
    if (markdown === latestMarkdownRef.current) return;
    latestMarkdownRef.current = markdown;
    onChange(markdown);
  }, [onChange]);

  const insertHostLink = useCallback((host: Host) => {
    const link = `[${getHostLinkLabel(host)}](${formatSshDeepLinkForHost(host)})`;
    const editor = editorRef.current;
    const replacementRange = hostPickerRangeRef.current;
    const trigger = hostPicker.trigger;
    const query = hostPicker.query;
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
    hostPickerRangeRef.current = null;

    if (editor) {
      if (replacementRange) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(replacementRange);
      } else {
        editor.focus();
      }
      editor.insertMarkdown(link);
      const cleanedMarkdown = removeHostPickerTriggerBeforeLink(
        editor.getMarkdown(),
        link,
        trigger,
        query,
      );
      if (cleanedMarkdown !== editor.getMarkdown()) {
        editor.setMarkdown(cleanedMarkdown);
      }
      commitMarkdown(cleanedMarkdown);
      return;
    }

    const next = latestMarkdownRef.current
      ? `${latestMarkdownRef.current}\n${link}`
      : link;
    commitMarkdown(next);
  }, [commitMarkdown, hostPicker.query, hostPicker.trigger]);

  const handleKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hostPicker.open) return;
    const shouldUsePickerKeyboard = hostPicker.query.trim().length > 0;

    if (event.key === "Escape") {
      event.preventDefault();
      setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
      return;
    }

    if (shouldUsePickerKeyboard && event.key === "ArrowDown") {
      event.preventDefault();
      setHostPicker((current) => ({
        ...current,
        selectedIndex: filteredHosts.length === 0
          ? 0
          : (current.selectedIndex + 1) % filteredHosts.length,
      }));
      return;
    }

    if (shouldUsePickerKeyboard && event.key === "ArrowUp") {
      event.preventDefault();
      setHostPicker((current) => ({
        ...current,
        selectedIndex: filteredHosts.length === 0
          ? 0
          : (current.selectedIndex - 1 + filteredHosts.length) % filteredHosts.length,
      }));
      return;
    }

    if (shouldUsePickerKeyboard && (event.key === "Enter" || event.key === "Tab")) {
      const selectedHost = filteredHosts[hostPicker.selectedIndex];
      if (!selectedHost) return;
      event.preventDefault();
      insertHostLink(selectedHost);
      return;
    }

  }, [
    filteredHosts,
    hostPicker.open,
    hostPicker.query,
    hostPicker.selectedIndex,
    insertHostLink,
  ]);

  const handleKeyUpCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (hostCandidates.length === 0) return;
    if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
    scheduleHostPickerUpdate();
  }, [hostCandidates.length, scheduleHostPickerUpdate]);

  const openLink = useCallback((href: string, label?: string) => {
    const host = buildSshNoteLinkOpenHost(hosts, href, label, {
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    if (host) {
      if (onOpenHost) {
        onOpenHost(host);
      }
      return;
    }

    void openExternalLink(href, onOpenExternalLink);
  }, [hosts, onOpenExternalLink, onOpenHost]);

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
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-note-link-action]")) return;

    const link = target.closest<HTMLAnchorElement>("a[href]");
    const renderedHref = link?.getAttribute("href") || link?.href;
    const container = containerRef.current;
    if (!link || !renderedHref || !container) {
      return;
    }

    const label = link.textContent?.trim() || renderedHref;
    const href = resolveRenderedMarkdownLinkHref(
      latestMarkdownRef.current,
      label,
      renderedHref,
    );
    const linkRect = link.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setLinkAction({
      href,
      label,
      left: Math.max(0, Math.min(containerRect.width - 34, linkRect.right - containerRect.left + 6)),
      top: Math.max(0, linkRect.top - containerRect.top - 2),
    });
  }, []);

  const handleBlurCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && containerRef.current?.contains(nextTarget)) return;
    setHostPicker((current) => ({ ...current, open: false, query: "", selectedIndex: 0 }));
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      onBlurCapture={handleBlurCapture}
      onClickCapture={scheduleHostPickerUpdate}
      onInputCapture={scheduleHostPickerUpdate}
      onKeyDownCapture={handleKeyDownCapture}
      onKeyUpCapture={handleKeyUpCapture}
      onMouseLeave={() => setLinkAction(null)}
      onMouseMoveCapture={handleMouseMoveCapture}
    >
      {linkAction && (
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
      <MDXEditor
        ref={editorRef}
        markdown={value}
        placeholder={placeholder}
        plugins={plugins}
        className="netcatty-mdx-editor"
        contentEditableClassName="netcatty-mdx-content"
        onChange={commitMarkdown}
      />
    </div>
  );
}
