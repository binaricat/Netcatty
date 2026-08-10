/**
 * Prepare stored note markdown for Streamdown (remark) preview.
 *
 * Streamdown does not parse Markdown nested inside HTML blocks. Note paste
 * stores centered heroes as:
 *   <div align="center">\n\n# Title\n\n**x**\n\n[![badge](url)](href)\n\n</div>
 * which would otherwise render as raw source. We expand those islands by
 * rendering the inner Markdown to safe HTML (marked + GFM) before Streamdown.
 *
 * Relative image URLs also become Streamdown "Image blocked" chips; rewrite
 * them to plain alt text so preview stays clean under app CSP.
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

/**
 * Relative / app-local image paths cannot load under Electron CSP / Streamdown
 * harden. Prefer https; drop or alt-only for the rest.
 */
export const isPreviewableImageSrc = (src: string): boolean => {
  const normalized = normalizeImageSrc(src);
  if (!normalized) return false;
  return /^https:\/\//i.test(normalized);
};

/** Rewrite markdown images with non-https src to alt text (avoid "Image blocked"). */
export const rewriteUnpreviewableMarkdownImages = (markdown: string): string => (
  markdown.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, alt: string, src: string) => {
      if (isPreviewableImageSrc(src)) {
        const normalized = normalizeImageSrc(src) ?? src;
        if (normalized === src) return full;
        return `![${alt}](${normalized})`;
      }
      const label = (alt || "").trim();
      return label ? `*${label}*` : "";
    },
  )
);

/** Drop or neutralize HTML <img> tags that Streamdown would block. */
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
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const alt = (altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "").trim();
    if (isPreviewableImageSrc(src)) {
      const normalized = normalizeImageSrc(src) ?? src;
      if (normalized === src) {
        out += tag;
      } else {
        out += tag.replace(src, normalized);
      }
    } else if (alt) {
      out += `<span class="note-preview-missing-image">${alt.replace(/</g, "&lt;")}</span>`;
    }
    i = end + 1;
  }
  return out;
};

/**
 * Convert centered HTML wrappers that still embed Markdown source into
 * center wrappers around already-rendered HTML so Streamdown can display them.
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
      // Non-centered container: keep as-is (do not char-walk through the body).
      out += full;
      i = end;
      continue;
    }

    // Self-closing / empty
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

    if (!plainTextLooksLikeMarkdown(inner)) {
      // Already HTML (badges as <a><img>, etc.) — keep wrapper.
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

    // Prefer a stable center div so CSS [align=center] applies even if original was <p>.
    out += `\n\n<div align="center">\n${rendered}\n</div>\n\n`;
    i = end;
  }

  return out;
};

/** Full preview pipeline for Streamdown static mode. */
export const prepareNoteMarkdownForStreamdownPreview = (markdown: string): string => {
  let body = (markdown ?? "").replace(/\r\n?/g, "\n");
  if (!body.trim()) return "";

  body = expandCenteredMarkdownHtmlIslands(body);
  body = rewriteUnpreviewableMarkdownImages(body);
  body = rewriteUnpreviewableHtmlImages(body);
  return body;
};
