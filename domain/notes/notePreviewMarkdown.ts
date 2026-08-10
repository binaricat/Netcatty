/**
 * Prepare stored vault-note markdown for GitHub-style static preview.
 *
 * CommonMark (and thus remark/react-markdown) does not parse Markdown nested
 * inside HTML blocks. Note paste stores centered heroes as:
 *   <div align="center">\n\n# Title\n\n**x**\n\n[![badge](url)](href)\n\n</div>
 * Expand those islands by rendering the inner Markdown to HTML (marked + GFM)
 * before the preview engine runs.
 *
 * Relative / non-https images cannot load under app CSP — drop them quietly
 * (no "Image blocked" chips, no alt-as-title clutter).
 */

import { marked } from "marked";

import {
  extractBalancedHtmlElement,
  findHtmlTagEnd,
  htmlOpenTagIsCentered,
  normalizeImageSrc,
} from "./clipboardPaste";

marked.setOptions({
  gfm: true,
  breaks: false,
});

const CENTERABLE_TAGS = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "header"]);

/** True when leftover text (outside tags) still looks like Markdown source. */
export const plainTextLooksLikeMarkdown = (text: string): boolean => {
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .trim();
  if (!plain) return false;
  return (
    /^ {0,3}#{1,6}\s+\S/m.test(plain)
    || /^ {0,3}(?:[-+*]|\d+[.)])\s+\S/m.test(plain)
    || /^ {0,3}>\s+\S/m.test(plain)
    || /^ {0,3}(?:```|~~~)/m.test(plain)
    || /(^|[^!])\[[^\]\n]+\]\([^)\s]+\)/.test(plain)
    || /!\[[^\]]*\]\([^)\s]+\)/.test(plain)
    || /(^|[\s([{])(?:\*\*|__)\S/.test(plain)
    || /(^|[\s([{])`[^`\n]+`/.test(plain)
  );
};

const renderMarkdownFragmentToHtml = (markdown: string): string => {
  const trimmed = markdown.replace(/\r\n?/g, "\n").trim();
  if (!trimmed) return "";
  try {
    const html = marked.parse(trimmed, { async: false });
    return typeof html === "string" ? html.trim() : "";
  } catch {
    return "";
  }
};

/** Only absolute https images are shown in note preview (CSP + remote badges). */
export const isPreviewableImageSrc = (src: string): boolean => {
  const normalized = normalizeImageSrc(src);
  if (!normalized) return false;
  return /^https:\/\//i.test(normalized);
};

/** Drop markdown images that cannot load; normalize http/protocol-relative → https. */
export const rewriteUnpreviewableMarkdownImages = (markdown: string): string => (
  markdown.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, _alt: string, src: string) => {
      if (!isPreviewableImageSrc(src)) return "";
      const normalized = normalizeImageSrc(src) ?? src;
      if (normalized === src) return full;
      return full.replace(src, normalized);
    },
  )
);

/** Drop HTML <img> tags that cannot load; normalize remaining https srcs. */
export const rewriteUnpreviewableHtmlImages = (html: string): string => {
  let body = html;
  let i = 0;
  let out = "";
  while (i < body.length) {
    const next = body.toLowerCase().indexOf("<img", i);
    if (next < 0) {
      out += body.slice(i);
      break;
    }
    out += body.slice(i, next);
    const end = findHtmlTagEnd(body, next);
    if (end < 0) {
      out += body[next];
      i = next + 1;
      continue;
    }
    const tag = body.slice(next, end + 1);
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    if (isPreviewableImageSrc(src)) {
      const normalized = normalizeImageSrc(src) ?? src;
      out += normalized === src ? tag : tag.replace(src, normalized);
    }
    // else: omit unpreviewable image entirely
    i = end + 1;
  }
  return out;
};

/** Remove empty markdown links left by turndown/badge debris: [](url). */
export const stripEmptyMarkdownLinks = (markdown: string): string => (
  markdown.replace(/\[\]\([^)\n]*\)/g, "")
);

/** Collapse empty or whitespace-only center wrappers after image drops. */
export const stripEmptyCenteredHtmlBlocks = (markdown: string): string => (
  markdown
    .replace(/<div\s+align=["']?center["']?\s*>\s*<\/div>/gi, "")
    .replace(/<p\s+align=["']?center["']?\s*>\s*<\/p>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
);

/**
 * Convert centered HTML wrappers that still embed Markdown source into
 * center wrappers around already-rendered HTML so remark can display them.
 */
export const expandCenteredMarkdownHtmlIslands = (markdown: string): string => {
  const source = markdown.replace(/\r\n?/g, "\n");
  let out = "";
  let i = 0;

  while (i < source.length) {
    if (source[i] !== "<") {
      out += source[i];
      i += 1;
      continue;
    }

    const extracted = extractBalancedHtmlElement(source, i);
    if (!extracted || !CENTERABLE_TAGS.has(extracted.tag)) {
      out += source[i];
      i += 1;
      continue;
    }

    const { full, end, tag } = extracted;
    if (!htmlOpenTagIsCentered(full)) {
      out += full;
      i = end;
      continue;
    }

    if (full.endsWith("/>") || new RegExp(`^<${tag}\\b[^>]*>\\s*</${tag}>$`, "i").test(full.trim())) {
      out += full;
      i = end;
      continue;
    }

    const openEnd = findHtmlTagEnd(full, 0);
    if (openEnd < 0) {
      out += full;
      i = end;
      continue;
    }
    const closeTag = `</${tag}>`;
    const inner = full.slice(openEnd + 1, full.length - closeTag.length);
    const textOutsideTags = inner.replace(/<[^>]+>/g, "").trim();
    // Pure HTML islands (e.g. <a><img>) keep as-is. Markdown or bare prose
    // needs marked so center blocks get real <p>/<h1> instead of raw text nodes.
    const needsMarkdownRender = plainTextLooksLikeMarkdown(inner)
      || (textOutsideTags.length > 0 && !/^\s*</.test(inner));

    if (!needsMarkdownRender) {
      out += full;
      i = end;
      continue;
    }

    const rendered = renderMarkdownFragmentToHtml(inner);
    if (!rendered) {
      out += full;
      i = end;
      continue;
    }

    // Stable center div so GitHub-style [align=center] CSS applies.
    out += `\n\n<div align="center">\n${rendered}\n</div>\n\n`;
    i = end;
  }

  return out;
};

/** Preferred name for the GitHub-style preview pipeline. */
export const prepareNoteMarkdownForGithubPreview = (markdown: string): string => {
  let body = (markdown ?? "").replace(/\r\n?/g, "\n");
  if (!body.trim()) return "";

  body = expandCenteredMarkdownHtmlIslands(body);
  body = rewriteUnpreviewableMarkdownImages(body);
  body = rewriteUnpreviewableHtmlImages(body);
  body = stripEmptyMarkdownLinks(body);
  body = stripEmptyCenteredHtmlBlocks(body);
  return body.trim();
};

/** @deprecated Use prepareNoteMarkdownForGithubPreview */
export const prepareNoteMarkdownForStreamdownPreview = prepareNoteMarkdownForGithubPreview;
