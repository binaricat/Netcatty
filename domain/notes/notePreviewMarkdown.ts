/**
 * Prepare stored vault-note markdown for GitHub-style static preview.
 *
 * CommonMark (and thus remark/react-markdown) does not parse Markdown nested
 * inside HTML blocks. Note paste stores centered heroes as:
 *   <div align="center">\n\n# Title\n\n**x**\n\n[![badge](url)](href)\n\n</div>
 * Expand those islands by rendering the inner Markdown to HTML (marked + GFM)
 * before the preview engine runs.
 *
 * Image src policy: keep absolute/relative as stored (via normalizeImageSrc).
 * Never map to GitHub raw; never drop relative logos. Vite serves repo
 * `public/` at site root (`public/icon.png` → `/icon.png`).
 *
 * Oversized center wrappers (body sections accidentally nested under
 * align=center) are unwrapped so Features etc. stay left-aligned like edit mode.
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
 * Resolve image src for in-app preview/edit load.
 * Preserves https and relative paths; only applies Vite public/ root rewrite.
 */
export const resolveNoteImageSrc = (src: string): string | null => normalizeImageSrc(src);

/** @deprecated Use resolveNoteImageSrc — all non-dangerous srcs are kept. */
export const isPreviewableImageSrc = (src: string): boolean => resolveNoteImageSrc(src) != null;

const replaceSrcInMarkdownImage = (full: string, src: string, next: string): string => {
  if (src === next) return full;
  // Replace only the first src occurrence inside ](src...)
  const idx = full.indexOf(`](${src}`);
  if (idx < 0) return full.replace(src, next);
  return `${full.slice(0, idx + 2)}${next}${full.slice(idx + 2 + src.length)}`;
};

/** Normalize markdown image srcs (public/ → /, http → https); never drop. */
export const rewriteNoteMarkdownImages = (markdown: string): string => (
  markdown.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, _alt: string, src: string) => {
      const resolved = resolveNoteImageSrc(src);
      if (!resolved) return ""; // only data: / javascript:
      return replaceSrcInMarkdownImage(full, src, resolved);
    },
  )
);

/** @deprecated */
export const rewriteUnpreviewableMarkdownImages = rewriteNoteMarkdownImages;

/** Normalize HTML <img src>; never drop relative logos. */
export const rewriteNoteHtmlImages = (html: string): string => {
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
    const resolved = resolveNoteImageSrc(src);
    if (!resolved) {
      // Dangerous scheme only — omit the tag
      i = end + 1;
      continue;
    }
    out += resolved === src ? tag : tag.replace(src, resolved);
    i = end + 1;
  }
  return out;
};

/** @deprecated */
export const rewriteUnpreviewableHtmlImages = rewriteNoteHtmlImages;

/** Remove empty markdown links left by turndown/badge debris: [](url). */
export const stripEmptyMarkdownLinks = (markdown: string): string => (
  markdown.replace(/\[\]\([^)\n]*\)/g, "")
);

/** Collapse empty or whitespace-only center wrappers. */
export const stripEmptyCenteredHtmlBlocks = (markdown: string): string => (
  markdown
    .replace(/<div\s+align=["']?center["']?\s*>\s*<\/div>/gi, "")
    .replace(/<p\s+align=["']?center["']?\s*>\s*<\/p>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
);

/**
 * Body sections (Features, long lists, many headings) must not stay under
 * align=center — edit mode left-aligns them; preview must match.
 */
export const isOversizedCenterInner = (innerHtml: string): boolean => {
  const h2plus = (innerHtml.match(/<h[2-6]\b/gi) ?? []).length;
  const h1 = (innerHtml.match(/<h1\b/gi) ?? []).length;
  const listItems = (innerHtml.match(/<li\b/gi) ?? []).length;
  const plainLen = innerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  if (h2plus >= 1) return true;
  if (h1 >= 2) return true;
  if (listItems >= 4) return true;
  if (plainLen > 900) return true;
  // Body-style headings that sometimes land inside a bad wrapper
  if (/<h1[^>]*>\s*(Features|Contents|Screenshots|What is|Why |Getting Started)/i.test(innerHtml)) {
    return true;
  }
  return false;
};

/**
 * Convert centered HTML wrappers that still embed Markdown source into
 * center wrappers around already-rendered HTML so remark can display them.
 * Oversized / body-like blocks are emitted unwrapped (left-aligned).
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
    const needsMarkdownRender = plainTextLooksLikeMarkdown(inner)
      || (textOutsideTags.length > 0 && !/^\s*</.test(inner));

    let payload = inner;
    if (needsMarkdownRender) {
      const rendered = renderMarkdownFragmentToHtml(inner);
      if (rendered) payload = rendered;
    }

    if (isOversizedCenterInner(payload)) {
      // Body content accidentally centered — unwrap so text is left-aligned.
      out += `\n\n${payload.trim()}\n\n`;
    } else {
      out += `\n\n<div align="center">\n${payload.trim()}\n</div>\n\n`;
    }
    i = end;
  }

  return out;
};

/**
 * Unwrap remaining oversized center shells (already-HTML body nested under center).
 */
export const unwrapOversizedCenteredHtmlBlocks = (markdown: string): string => {
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
    if (!extracted || extracted.tag !== "div" || !htmlOpenTagIsCentered(extracted.full)) {
      out += source[i];
      i += 1;
      continue;
    }
    const { full, end } = extracted;
    const openEnd = findHtmlTagEnd(full, 0);
    if (openEnd < 0) {
      out += full;
      i = end;
      continue;
    }
    const inner = full.slice(openEnd + 1, full.length - "</div>".length);
    if (isOversizedCenterInner(inner)) {
      out += `\n\n${inner.trim()}\n\n`;
    } else {
      out += full;
    }
    i = end;
  }
  return out;
};

/** Preferred name for the GitHub-style preview pipeline. */
export const prepareNoteMarkdownForGithubPreview = (markdown: string): string => {
  let body = (markdown ?? "").replace(/\r\n?/g, "\n");
  if (!body.trim()) return "";

  body = expandCenteredMarkdownHtmlIslands(body);
  body = unwrapOversizedCenteredHtmlBlocks(body);
  body = rewriteNoteMarkdownImages(body);
  body = rewriteNoteHtmlImages(body);
  body = stripEmptyMarkdownLinks(body);
  body = stripEmptyCenteredHtmlBlocks(body);
  return body.trim();
};

/** @deprecated Use prepareNoteMarkdownForGithubPreview */
export const prepareNoteMarkdownForStreamdownPreview = prepareNoteMarkdownForGithubPreview;
