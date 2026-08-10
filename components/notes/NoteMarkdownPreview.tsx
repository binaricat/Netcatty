/**
 * Lightweight read-only note preview (Streamdown / remark) — no Lexical/MDXEditor.
 * Edit mode stays on MDXEditor; preview switches here for large-doc scroll/paint cost.
 */
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import React, { useEffect, useMemo, useRef } from "react";
import { Streamdown } from "streamdown";

import { createSafeCodeHighlighter } from "../ai-elements/streamdownCodeHighlighter";
import { cn } from "../../lib/utils";
import { annotateNoteImageSizes } from "./noteImageLayout";

const safeCode = createSafeCodeHighlighter(code);
const streamdownPlugins = { cjk, code: safeCode };

/**
 * Extra HTML allowed for vault-note paste islands (centered heroes, sized images).
 * Merged into Streamdown's rehype-sanitize schema when provided.
 */
const NOTE_PREVIEW_ALLOWED_TAGS: Record<string, string[]> = {
  div: ["align", "class", "style"],
  span: ["class", "style"],
  img: ["src", "alt", "title", "width", "height", "loading", "decoding", "class"],
  a: ["href", "title", "name", "target", "rel", "class"],
  br: [],
  hr: [],
  p: ["align", "class", "style"],
  h1: ["align", "class", "style"],
  h2: ["align", "class", "style"],
  h3: ["align", "class", "style"],
  h4: ["align", "class", "style"],
  h5: ["align", "class", "style"],
  h6: ["align", "class", "style"],
};

const NOTE_PREVIEW_CONTROLS = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
} as const;

export type NoteMarkdownPreviewProps = {
  markdown: string;
  className?: string;
};

export const NoteMarkdownPreview = React.memo(function NoteMarkdownPreview({
  markdown,
  className,
}: NoteMarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Re-mark small-icon rows after Streamdown mounts images (badge walls).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    const run = () => annotateNoteImageSizes(root);
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        run();
      });
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [markdown]);

  const body = useMemo(() => markdown.replace(/\r\n?/g, "\n"), [markdown]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "netcatty-note-markdown-preview netcatty-mdx-editor netcatty-mdx-editor--preview",
        className,
      )}
      data-note-preview-engine="streamdown"
    >
      <Streamdown
        mode="static"
        plugins={streamdownPlugins}
        normalizeHtmlIndentation
        // Parent InlineMarkdownEditor owns ssh/http link open via capture.
        linkSafety={{ enabled: false }}
        controls={NOTE_PREVIEW_CONTROLS}
        allowedTags={NOTE_PREVIEW_ALLOWED_TAGS}
        className={cn(
          "netcatty-mdx-content",
          // Match note editor typography; Streamdown default space-y-4 is a bit airy.
          "space-y-0 text-[15px] leading-[1.75] text-foreground/90",
          "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          "[&_a]:text-primary [&_a]:underline",
          "[&_img]:max-w-full",
        )}
      >
        {body}
      </Streamdown>
    </div>
  );
});
