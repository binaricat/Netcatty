/**
 * GitHub-style read-only note preview (react-markdown + GFM + raw HTML).
 * Edit mode stays on MDXEditor; preview is a static HTML path for large notes.
 *
 * Inspired by uiw/react-markdown-preview and github-markdown-css — not Streamdown
 * (chat-oriented, Image blocked chrome, wrong layout for README heroes).
 */
import React, { useEffect, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { prepareNoteMarkdownForGithubPreview } from "../../domain/notes/notePreviewMarkdown";
import { cn } from "../../lib/utils";
import { annotateNoteImageSizes } from "./noteImageLayout";

import "github-markdown-css/github-markdown-dark.css";

/**
 * Sanitize schema: GitHub README paste needs align on block tags and
 * width/height/alt on images. Default rehype-sanitize strips those.
 */
export const NOTE_GITHUB_PREVIEW_SANITIZE_SCHEMA: SanitizeOptions = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "div",
    "span",
    "center",
  ],
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      "align",
      "className",
      "class",
      "style",
    ],
    p: [
      ...(defaultSchema.attributes?.p ?? []),
      "align",
      "className",
      "class",
      "style",
    ],
    h1: [...(defaultSchema.attributes?.h1 ?? []), "align", "className", "class", "style"],
    h2: [...(defaultSchema.attributes?.h2 ?? []), "align", "className", "class", "style"],
    h3: [...(defaultSchema.attributes?.h3 ?? []), "align", "className", "class", "style"],
    h4: [...(defaultSchema.attributes?.h4 ?? []), "align", "className", "class", "style"],
    h5: [...(defaultSchema.attributes?.h5 ?? []), "align", "className", "class", "style"],
    h6: [...(defaultSchema.attributes?.h6 ?? []), "align", "className", "class", "style"],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      "alt",
      "title",
      "width",
      "height",
      "loading",
      "decoding",
      "className",
      "class",
    ],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      "name",
      "target",
      "rel",
      "className",
      "class",
      "title",
    ],
    span: [...(defaultSchema.attributes?.span ?? []), "className", "class", "style"],
    td: [...(defaultSchema.attributes?.td ?? []), "align"],
    th: [...(defaultSchema.attributes?.th ?? []), "align"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "ssh", "http", "https", "mailto"],
    src: [...(defaultSchema.protocols?.src ?? []), "http", "https"],
  },
};

const remarkPlugins = [remarkGfm];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rehype plugin tuple typing varies by unified version
const rehypePlugins: any[] = [
  rehypeRaw,
  [rehypeSanitize, NOTE_GITHUB_PREVIEW_SANITIZE_SCHEMA],
];

export type NoteMarkdownPreviewProps = {
  markdown: string;
  className?: string;
};

export const NoteMarkdownPreview = React.memo(function NoteMarkdownPreview({
  markdown,
  className,
}: NoteMarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const body = useMemo(
    () => prepareNoteMarkdownForGithubPreview(markdown),
    [markdown],
  );

  // Compact badge-row layout markers after images mount.
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
  }, [body]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "netcatty-note-markdown-preview netcatty-note-github-preview markdown-body",
        className,
      )}
      data-note-preview-engine="github-markdown"
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        // Parent InlineMarkdownEditor owns ssh/http open via click capture.
        urlTransform={(url) => url}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
});
