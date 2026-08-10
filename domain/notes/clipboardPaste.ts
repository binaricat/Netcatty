/**
 * Note clipboard paste policy (domain — pure, no React).
 *
 * Product policy (lossy but clean — not a GitHub README clone):
 * - Prefer structured text/plain Markdown when present
 * - Otherwise HTML → Markdown via Turndown (+ island conversion)
 * - Linked badges stay as images (tight [![alt](src)](href) or <a><img>)
 * - Image dimensions preserved; CSS scales large screenshots in the panel
 * - Centered blocks → <div align="center"> for MDX GenericHTML
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export type NoteClipboardPasteKind =
  | "markdown"
  | "html-converted"
  | "plain"
  | "empty";

export type NoteClipboardPastePayload = {
  text: string;
  kind: NoteClipboardPasteKind;
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
  /!\[[^\]]*\]\([^)\s]+\)/,
  /<img\b/i,
];

/**
 * Bare known HTML element names. Type tokens like `string` in `List<string>` are
 * intentionally absent so TypeScript generics are not treated as markup islands.
 */
const BARE_HTML_TAG_RE =
  /<\/?(?:a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)(?:\s|\/|>)/i;

/** True when plain clipboard text already looks like structured markdown source. */
export const shouldInsertClipboardTextAsMarkdown = (text: string): boolean => {
  const markdown = text.replace(/\r\n?/g, "\n").trim();
  if (!markdown) return false;
  return PASTED_MARKDOWN_PATTERNS.some((pattern) => pattern.test(markdown));
};

/** True when clipboard HTML is worth converting (not empty / not a lone meta tag). */
export const looksLikeClipboardHtml = (html: string): boolean => {
  const trimmed = html.trim();
  if (!trimmed) return false;
  if (!/<[a-zA-Z!/?]/.test(trimmed)) return false;
  const withoutMeta = trimmed
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
    .trim();
  return withoutMeta.length > 0;
};

/**
 * True when plain text embeds real HTML tags (not TS generics like List<string>).
 *
 * Heuristics:
 * - comments / doctype → HTML
 * - closing tags → HTML
 * - open tags with attributes or void self-close → HTML
 * - bare known HTML element names only (`<div>`, `<span>`) → HTML
 */
export const plainMarkdownContainsHtml = (text: string): boolean => {
  if (/<!--/.test(text) || /<!doctype\b/i.test(text)) return true;
  if (/<\/[a-z][a-z0-9:-]*\s*>/i.test(text)) return true;
  if (/<[a-z][a-z0-9:-]*\s+[^>]*>/i.test(text)) return true;
  if (/<[a-z][a-z0-9:-]*\s*\/>/i.test(text)) return true;
  return BARE_HTML_TAG_RE.test(text);
};

/**
 * True when the payload is primarily an HTML document (browser / Word / GitHub
 * rich clipboard), not markdown-with-a-few-tags.
 */
export const isPrimarilyHtmlDocument = (html: string): boolean => {
  const trimmed = html.trim();
  if (!trimmed) return false;
  if (/<!--StartFragment-->/i.test(trimmed)) return true;
  if (/<\s*html[\s>]/i.test(trimmed)) return true;
  if (/<\s*body[\s>]/i.test(trimmed)) return true;
  const withoutTags = trimmed.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const tagChars = (trimmed.match(/<[^>]+>/g) ?? []).join("").length;
  if (tagChars === 0) return false;
  if (withoutTags.length === 0) return true;
  return tagChars >= withoutTags.length * 0.35;
};

let turndownSingleton: TurndownService | null = null;

const getTurndown = (): TurndownService => {
  if (turndownSingleton) return turndownSingleton;
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    preformattedCode: true,
  });
  service.use(gfm);
  service.addRule("stripEmptyAnchors", {
    filter: (node) => (
      node.nodeName === "A"
      && !(node as HTMLElement).getAttribute("href")
      && !(node.textContent ?? "").trim()
    ),
    replacement: () => "",
  });
  service.addRule("skipDataImages", {
    filter: (node) => (
      node.nodeName === "IMG"
      && ((node as HTMLImageElement).getAttribute("src") ?? "").startsWith("data:")
    ),
    replacement: () => "",
  });
  service.addRule("keepCenteredBlocks", {
    filter: (node) => isCenteredBlockElement(node as HTMLElement),
    replacement: (content, node) => {
      let inner = content.trim();
      const tag = (node as HTMLElement).nodeName.toLowerCase();
      const heading = /^h([1-6])$/.exec(tag);
      if (heading && inner && !/^#{1,6}\s/m.test(inner)) {
        inner = `${"#".repeat(Number(heading[1]))} ${inner}`;
      }
      return wrapCenteredMarkdown(inner);
    },
  });
  service.addRule("imagesForNotes", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as HTMLImageElement;
      const src = (el.getAttribute("src") ?? "").trim();
      if (!src || src.startsWith("data:")) return "";
      const html = serializeSafeHtmlImage({
        src,
        alt: el.getAttribute("alt") ?? "",
        title: el.getAttribute("title") ?? undefined,
        width: el.getAttribute("width") ?? undefined,
        height: el.getAttribute("height") ?? undefined,
      });
      return html ? `\n\n${html}\n\n` : "";
    },
  });
  turndownSingleton = service;
  return service;
};

const CENTERED_BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "HEADER",
]);

export const isCenteredBlockElement = (node: HTMLElement | Element | null | undefined): boolean => {
  if (!node || !("nodeName" in node)) return false;
  if (!CENTERED_BLOCK_TAGS.has(node.nodeName)) return false;
  const el = node as HTMLElement;
  const align = (el.getAttribute?.("align") ?? "").trim().toLowerCase();
  if (align === "center") return true;
  const style = el.getAttribute?.("style") ?? "";
  if (/text-align\s*:\s*center/i.test(style)) return true;
  return false;
};

export const htmlOpenTagIsCentered = (openTagOrFull: string): boolean => {
  if (/\balign\s*=\s*(?:"|')?center(?:"|')?/i.test(openTagOrFull)) return true;
  if (/text-align\s*:\s*center/i.test(openTagOrFull)) return true;
  // MDX / Tailwind class-based centering
  if (/\bclass(?:Name)?\s*=\s*["'][^"']*\btext-center\b/i.test(openTagOrFull)) return true;
  return false;
};

export const wrapCenteredMarkdown = (inner: string): string => {
  const body = inner.replace(/\r\n?/g, "\n").trim();
  if (!body) return "";
  if (/^<div\s+align="center">/i.test(body) && /<\/div>\s*$/i.test(body)) {
    return `\n\n${body}\n\n`;
  }
  return `\n\n<div align="center">\n\n${body}\n\n</div>\n\n`;
};

/** Unicode scalar values accepted by String.fromCodePoint (rejects surrogates-only overflow). */
const isValidUnicodeCodePoint = (code: number): boolean => (
  Number.isFinite(code)
  && Number.isInteger(code)
  && code >= 0
  && code <= 0x10FFFF
);

const codePointFromEntity = (code: number, fallback: string): string => (
  isValidUnicodeCodePoint(code) ? String.fromCodePoint(code) : fallback
);

/** Decode common HTML entities (once) before re-escaping on serialize. */
export const decodeHtmlEntities = (value: string): string => (
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n: string) => codePointFromEntity(Number(n), _))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => (
      codePointFromEntity(Number.parseInt(hex, 16), _)
    ))
    // &amp; last so we don't re-expand decoded entities
    .replace(/&amp;/gi, "&")
);

/**
 * Normalize image src for note storage / in-app load.
 * - https ok
 * - http → https (CSP blocks http images)
 * - //host → https://host (app:// base would otherwise break)
 * - Vite/Electron: files under repo `public/` are served at site root, so
 *   `public/icon.png` / `/public/icon.png` → `/icon.png` (avoids Vite
 *   "use /icon.png instead of /public/icon.png" warnings)
 * - other relative paths kept as-is (`./docs/...`, `/distro/foo.svg`)
 * - data:/javascript: rejected
 */
export const normalizeImageSrc = (src: string): string | null => {
  let trimmed = src.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return null;
  if (/^javascript:/i.test(trimmed)) return null;
  if (trimmed.startsWith("//") && /^\/\/[^/\s]/.test(trimmed)) {
    trimmed = `https:${trimmed}`;
  }
  if (/^http:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed.slice("http://".length)}`;
  }
  if (/^https:\/\//i.test(trimmed)) return trimmed;
  // public/ is the Vite static root — never request /public/...
  if (/^\/?public\//i.test(trimmed)) {
    return `/${trimmed.replace(/^\/?public\//i, "")}`;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }
  // Bare relative like `public/icon.png` already handled; `docs/foo.png` keep.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return null;
};

/**
 * Rewrite Vite public-dir URLs in markdown/HTML so the browser never requests /public/*.
 *   /public/foo.png → /foo.png
 *   public/foo.png  → /foo.png
 * Only outside fenced/indented/inline code so docs samples stay literal.
 */
export const normalizeNotePublicAssetPaths = (markdown: string): string => (
  mapOutsideCode(markdown, (plain) => {
    let body = plain;
    body = body.replace(/((?:^|\s)src\s*=\s*["'])\/?public\//gi, "$1/");
    body = body.replace(/\]\(\s*\/?public\//gi, "](/");
    return body;
  })
);

const escapeHtmlAttr = (value: string): string => (
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
);

export const serializeSafeHtmlImage = (input: {
  src: string;
  alt?: string;
  title?: string;
  width?: string | number | null;
  height?: string | number | null;
}): string => {
  const src = normalizeImageSrc(input.src ?? "");
  if (!src) return "";
  const alt = decodeHtmlEntities(input.alt ?? "").replace(/[[\]]/g, "");
  const title = decodeHtmlEntities(input.title?.trim() || "");
  const widthRaw = input.width != null ? String(input.width).trim() : "";
  const heightRaw = input.height != null ? String(input.height).trim() : "";
  const safeWidth = /^(?:\d+(?:\.\d+)?%?)$/.test(widthRaw) ? widthRaw : "";
  const safeHeight = /^(?:\d+(?:\.\d+)?%?)$/.test(heightRaw) ? heightRaw : "";

  if (!safeWidth && !safeHeight) {
    const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
    // CommonMark: destinations with spaces/parens must be <angled> or they break.
    const destination = /[\s()]/.test(src) ? `<${src.replace(/[<>]/g, "")}>` : src;
    return `![${alt}](${destination}${titlePart})`;
  }

  const parts = [
    `src="${escapeHtmlAttr(src)}"`,
    `alt="${escapeHtmlAttr(alt)}"`,
  ];
  if (title) parts.push(`title="${escapeHtmlAttr(title)}"`);
  if (safeWidth) parts.push(`width="${escapeHtmlAttr(safeWidth)}"`);
  if (safeHeight) parts.push(`height="${escapeHtmlAttr(safeHeight)}"`);
  return `<img ${parts.join(" ")} />`;
};

/**
 * Collapse consecutive blank lines outside fenced/indented code, but keep
 * Turndown hard-breaks (two trailing spaces before \n) and blank lines in code.
 */
export const trimBlankLinesOutsideCode = (value: string): string => {
  const regions = maskCodeRegions(value.replace(/\r\n?/g, "\n"));
  let body = regions.text;
  // Collapse 3+ blank lines → 2, without eating hard-break spaces on content lines.
  body = body.replace(/\n{3,}/g, "\n\n");
  body = body.replace(/^\n+/, "").replace(/\n+$/, "");
  // Strip trailing spaces on blank-only lines, but keep "  \n" hard breaks on non-empty lines.
  body = body.replace(/^[ \t]+$/gm, "");
  return unmaskCodeRegions(body, regions.slots, regions.sentinel);
};

const trimBlankLines = trimBlankLinesOutsideCode;

const turndownFragment = (html: string): string => {
  try {
    return getTurndown().turndown(html);
  } catch {
    return "";
  }
};

/** Scan an HTML tag end respecting quoted attribute values (allows `>` inside quotes). */
export const findHtmlTagEnd = (source: string, start: number): number => {
  if (source[start] !== "<") return -1;
  let i = start + 1;
  let quote: '"' | "'" | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === ">") return i;
    i += 1;
  }
  return -1;
};

/** Parse a single <img …> tag (quote-aware) into safe markdown/HTML. */
export const convertHtmlImgTagToMarkdownOrHtml = (imgTag: string): string => {
  const trimmed = imgTag.trim();
  if (!/^<img\b/i.test(trimmed)) return turndownFragment(imgTag).trim();
  const end = findHtmlTagEnd(trimmed, 0);
  if (end < 0) return "";
  const open = trimmed.slice(0, end + 1);
  // Only convert a pure img tag (optional trailing whitespace), not following debris.
  if (trimmed.slice(end + 1).trim()) {
    // Fall back: try only the tag portion
  }
  const attrBlob = open.replace(/^<img\b/i, "").replace(/\/?>$/, "");
  const getAttr = (name: string): string => {
    // Require a real attribute boundary so `data-src` does not match `src`.
    const re = new RegExp(
      `(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    );
    const m = re.exec(attrBlob);
    const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
    return decodeHtmlEntities(raw);
  };
  return serializeSafeHtmlImage({
    src: getAttr("src"),
    alt: getAttr("alt"),
    title: getAttr("title") || undefined,
    width: getAttr("width") || undefined,
    height: getAttr("height") || undefined,
  });
};

const extractMarkdownImageAlt = (imageChunk: string): string => {
  const md = /!\[([^\]]*)\]/.exec(imageChunk);
  if (md) return (md[1] || "link").trim() || "link";
  const htmlAlt = /alt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(imageChunk);
  if (htmlAlt) {
    return decodeHtmlEntities((htmlAlt[1] ?? htmlAlt[2] ?? "link").trim()) || "link";
  }
  return "link";
};

export const normalizeLinkedBadgeImages = (markdown: string): string => {
  let body = markdown.replace(/\r\n?/g, "\n");

  body = body.replace(
    /\[\s*!\[[^\]]*\]\(([^)]+)\)\s*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (full, imgSrc: string, href: string) => {
      const alt = extractMarkdownImageAlt(full);
      // Support angled destinations with spaces: <images/company logo.png>
      const rawDest = (imgSrc || "").trim();
      let dest = rawDest;
      if (rawDest.startsWith("<")) {
        const end = rawDest.indexOf(">");
        dest = end > 0 ? rawDest.slice(1, end) : rawDest.slice(1);
      } else {
        dest = rawDest.split(/\s+/)[0] ?? "";
      }
      const src = normalizeImageSrc(dest);
      if (!src) return `[${alt}](${href})`;
      return `[![${alt}](${src})](${href})`;
    },
  );

  body = body.replace(
    /\[\s*(<img\b[\s\S]*?>)\s*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gi,
    (_full, imgTag: string, href: string) => {
      const end = findHtmlTagEnd(String(imgTag).trim(), 0);
      const tag = end >= 0 ? String(imgTag).trim().slice(0, end + 1) : String(imgTag).trim();
      const safeImg = convertHtmlImgTagToMarkdownOrHtml(tag);
      if (!safeImg) return "";
      if (safeImg.startsWith("<img")) {
        return `<a href="${escapeHtmlAttr(href)}">${safeImg}</a>`;
      }
      const m = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(safeImg);
      if (m) return `[![${m[1]}](${m[2]})](${href})`;
      return `[${extractMarkdownImageAlt(safeImg)}](${href})`;
    },
  );

  body = body.replace(
    /<a\b([^>]*)>\s*(<img\b[\s\S]*?>)\s*<\/a>/gi,
    (full, aAttrs: string, imgTag: string) => {
      // Require a real attribute boundary so `data-href` does not match `href`.
      const hrefMatch = /(?:^|[\s"'/])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(aAttrs);
      const href = decodeHtmlEntities(
        (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim(),
      );
      if (!href || /^javascript:/i.test(href)) {
        return convertHtmlImgTagToMarkdownOrHtml(imgTag) || "";
      }
      const end = findHtmlTagEnd(String(imgTag).trim(), 0);
      const tag = end >= 0 ? String(imgTag).trim().slice(0, end + 1) : String(imgTag).trim();
      const safeImg = convertHtmlImgTagToMarkdownOrHtml(tag);
      if (!safeImg) return "";
      if (safeImg.startsWith("<img")) {
        return `<a href="${escapeHtmlAttr(href)}">${safeImg}</a>`;
      }
      const m = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(safeImg);
      if (m) return `[![${m[1]}](${m[2]})](${href})`;
      return `[${extractMarkdownImageAlt(full)}](${href})`;
    },
  );

  return body;
};

export type CodeMask = {
  text: string;
  slots: string[];
  /** Unique prefix for this pass so user-authored sentinel text cannot collide. */
  sentinel: string;
};

const escapeRegExp = (value: string): string => (
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
);

const chooseCodeMaskSentinel = (markdown: string): string => {
  let n = 0;
  let sentinel = "@@NETCATTY_MD_CODE_";
  while (markdown.includes(sentinel)) {
    n += 1;
    sentinel = `@@NETCATTY_MD_CODE_S${n}_`;
  }
  return sentinel;
};

/**
 * Mask GFM fenced blocks. Closing fence may be longer than the opener
 * (CommonMark: close with same char and length >= open).
 * Fence run must be homogeneous (` or ~), not a mixed character class.
 */
const maskFencedCodeBlocks = (
  markdown: string,
  stash: (chunk: string) => string,
): string => {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  // Any blockquote depth, then up to 3 spaces, then homogeneous ``` or ~~~ (3+).
  const openRe = /^((?:[ \t]{0,3}>[ \t]?)*)[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
  const closeRe = /^((?:[ \t]{0,3}>[ \t]?)*)[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

  while (i < lines.length) {
    const openMatch = openRe.exec(lines[i] ?? "");
    if (!openMatch) {
      out.push(lines[i] ?? "");
      i += 1;
      continue;
    }
    const fence = openMatch[2] ?? "";
    const fenceChar = fence[0] ?? "`";
    const fenceLen = fence.length;
    // Info string may not contain the fence character (CommonMark).
    const info = openMatch[3] ?? "";
    if (info.includes(fenceChar)) {
      out.push(lines[i] ?? "");
      i += 1;
      continue;
    }

    const block: string[] = [lines[i] ?? ""];
    i += 1;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const closeMatch = closeRe.exec(line);
      if (
        closeMatch
        && (closeMatch[2]?.[0] ?? "") === fenceChar
        && (closeMatch[2]?.length ?? 0) >= fenceLen
      ) {
        block.push(line);
        i += 1;
        break;
      }
      block.push(line);
      i += 1;
    }
    // Unclosed fence: still mask through EOF so trailing samples stay protected.
    out.push(stash(block.join("\n")));
  }
  return out.join("\n");
};

const isMarkdownListLine = (line: string): boolean => (
  /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line)
);

/**
 * Mask 4-space / tab indented code. Nested list items under a preceding list
 * line stay unmasked so task indices match the preview DOM; standalone
 * `    - [ ] sample` at document root remains code (no checkbox in preview).
 */
const maskIndentedCodeBlocks = (
  markdown: string,
  stash: (chunk: string) => string,
): string => {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let i = 0;
  const isBlank = (line: string) => /^[ \t]*$/.test(line);
  const isIndented = (line: string) => /^(?: {4}|\t)/.test(line);

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!isIndented(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    let prev = i - 1;
    while (prev >= 0 && isBlank(lines[prev] ?? "")) prev -= 1;
    const inListContext = prev >= 0 && isMarkdownListLine(lines[prev] ?? "");
    if (inListContext && isMarkdownListLine(line)) {
      out.push(line);
      i += 1;
      continue;
    }

    const block: string[] = [];
    while (i < lines.length && isIndented(lines[i] ?? "")) {
      const cur = lines[i] ?? "";
      // Nested list continuation inside an open list stays as list, not code.
      if (inListContext && isMarkdownListLine(cur)) {
        if (block.length > 0) out.push(stash(block.join("\n")));
        block.length = 0;
        out.push(cur);
        i += 1;
        continue;
      }
      block.push(cur);
      i += 1;
    }
    if (block.length > 0) out.push(stash(block.join("\n")));
  }
  return out.join("\n");
};

/**
 * Mask CommonMark inline code spans (`…`, `` … ` … ``, etc.).
 * Content may include shorter backtick runs; close with the same length.
 */
const maskInlineCodeSpans = (
  markdown: string,
  stash: (chunk: string) => string,
): string => {
  let out = "";
  let i = 0;
  while (i < markdown.length) {
    if (markdown[i] !== "`") {
      out += markdown[i];
      i += 1;
      continue;
    }
    let j = i;
    while (j < markdown.length && markdown[j] === "`") j += 1;
    const n = j - i;
    // Scan for a closing run of exactly n backticks (not part of a longer run).
    let k = j;
    let found = -1;
    while (k < markdown.length) {
      // Blank line ends an inline code attempt (CommonMark).
      if (markdown[k] === "\n" && markdown[k + 1] === "\n") break;
      if (markdown[k] !== "`") {
        k += 1;
        continue;
      }
      let m = k;
      while (m < markdown.length && markdown[m] === "`") m += 1;
      const run = m - k;
      if (run === n) {
        found = m;
        break;
      }
      k = m;
    }
    if (found < 0) {
      out += markdown[i];
      i += 1;
      continue;
    }
    out += stash(markdown.slice(i, found));
    i = found;
  }
  return out;
};

/** Mask fenced (3+ ticks), indented, and inline code so cleanup won't touch them. */
export const maskCodeRegions = (markdown: string): CodeMask => {
  const slots: string[] = [];
  const sentinel = chooseCodeMaskSentinel(markdown);
  const stash = (chunk: string): string => {
    const token = `${sentinel}${slots.length}@@`;
    slots.push(chunk);
    return token;
  };

  let body = maskFencedCodeBlocks(markdown, stash);
  body = maskIndentedCodeBlocks(body, stash);
  body = maskInlineCodeSpans(body, stash);

  return { text: body, slots, sentinel };
};

export const unmaskCodeRegions = (
  text: string,
  slots: string[],
  sentinel = "@@NETCATTY_MD_CODE_",
): string => {
  const re = new RegExp(`${escapeRegExp(sentinel)}(\\d+)@@`, "g");
  return text.replace(re, (_, idx: string) => slots[Number(idx)] ?? "");
};

const stripOrphanLinkClosersOutsideCode = (markdown: string): string => {
  const { text, slots, sentinel } = maskCodeRegions(markdown);
  const cleaned = text.replace(/^\s*\]\([^)\n]+\)\s*$/gm, "");
  return unmaskCodeRegions(cleaned, slots, sentinel);
};

/** Apply a transform only outside code regions. */
const mapOutsideCode = (markdown: string, fn: (plain: string) => string): string => {
  const { text, slots, sentinel } = maskCodeRegions(markdown);
  return unmaskCodeRegions(fn(text), slots, sentinel);
};

export const normalizePastedNoteMarkdown = (markdown: string): string => {
  // Badge + bare <img> cleanup only outside fenced/indented/inline code so
  // samples like `[](https://…)` inside fences are not rewritten.
  let body = mapOutsideCode(markdown, (plain) => {
    let next = normalizeLinkedBadgeImages(plain);
    next = next.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<img\b[\s\S]*?>/gi, (chunk) => {
      if (/^<a\b/i.test(chunk)) return chunk;
      // Quote-aware img slice
      const end = findHtmlTagEnd(chunk.trim(), 0);
      const tag = end >= 0 ? chunk.trim().slice(0, end + 1) : chunk.trim();
      return convertHtmlImgTagToMarkdownOrHtml(tag) || "";
    });
    return normalizeLinkedBadgeImages(next);
  });
  body = stripOrphanLinkClosersOutsideCode(body);
  return trimBlankLines(body);
};

export const convertClipboardHtmlToMarkdown = (html: string): string => {
  if (!looksLikeClipboardHtml(html)) return "";
  return normalizePastedNoteMarkdown(turndownFragment(html));
};

/**
 * Extract a balanced HTML element starting at `start` (must point at '<').
 * Returns [fullMatch, endIndexExclusive] or null.
 */
export const extractBalancedHtmlElement = (
  source: string,
  start: number,
): { full: string; end: number; tag: string } | null => {
  if (source[start] !== "<") return null;
  const openEnd = findHtmlTagEnd(source, start);
  if (openEnd < 0) return null;
  const openTag = source.slice(start, openEnd + 1);
  const tagMatch = /^<\/?([a-zA-Z][\w:-]*)/.exec(openTag);
  if (!tagMatch) return null;
  const tag = tagMatch[1].toLowerCase();
  if (/\/\s*>$/.test(openTag) || /^<(?:br|hr|img|meta|link|input|source|track|wbr)\b/i.test(openTag)) {
    return { full: openTag, end: openEnd + 1, tag };
  }
  if (openTag.startsWith("</")) return null;

  // Raw-text elements: body is not HTML — do not treat `<` inside as nested tags.
  if (/^(?:script|style|textarea|title|xmp)$/i.test(tag)) {
    const closeRe = new RegExp(`</${tag}\\s*>`, "i");
    const rest = source.slice(openEnd + 1);
    const closeMatch = closeRe.exec(rest);
    if (!closeMatch) return null;
    const end = openEnd + 1 + closeMatch.index + closeMatch[0].length;
    return { full: source.slice(start, end), end, tag };
  }

  let i = openEnd + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const next = source.indexOf("<", i);
    if (next < 0) return null;
    const te = findHtmlTagEnd(source, next);
    if (te < 0) return null;
    const piece = source.slice(next, te + 1);
    const tm = /^<\/?([a-zA-Z][\w:-]*)/.exec(piece);
    if (tm && tm[1].toLowerCase() === tag) {
      if (piece.startsWith("</")) depth -= 1;
      else if (!/\/\s*>$/.test(piece)) depth += 1;
    }
    i = te + 1;
    if (depth === 0) {
      return { full: source.slice(start, i), end: i, tag };
    }
  }
  return null;
};

export const convertHtmlIslandsInMarkdown = (markdown: string): string => {
  let body = markdown.replace(/\r\n?/g, "\n");

  if (!plainMarkdownContainsHtml(body)) {
    return normalizePastedNoteMarkdown(body);
  }

  // Mask fenced + indented + inline code so HTML samples in code are not Turndown'd.
  const { text: masked, slots, sentinel } = maskCodeRegions(body);
  body = masked.replace(/<!--[\s\S]*?-->/g, "");

  // Walk left-to-right converting HTML islands with balanced matching.
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "<") {
      out += body[i];
      i += 1;
      continue;
    }
    const extracted = extractBalancedHtmlElement(body, i);
    if (!extracted) {
      out += body[i];
      i += 1;
      continue;
    }
    const { full, end, tag } = extracted;
    const lower = tag.toLowerCase();

    if (lower === "script" || lower === "style") {
      i = end;
      continue;
    }

    if (lower === "div" && htmlOpenTagIsCentered(full)) {
      out += full;
      i = end;
      continue;
    }

    if (lower === "img" || lower === "br" || lower === "hr") {
      if (lower === "img") {
        const md = convertHtmlImgTagToMarkdownOrHtml(full);
        out += md ? `\n\n${md}\n\n` : "";
      } else {
        const md = turndownFragment(full.endsWith("/>") ? full : full.replace(/>$/, " />"));
        out += md || (lower === "br" ? "  \n" : "");
      }
      i = end;
      continue;
    }

    if (
      (lower === "p" || /^h[1-6]$/.test(lower))
      && htmlOpenTagIsCentered(full)
    ) {
      const md = turndownFragment(full);
      out += md.trim() ? `\n\n${md.trim()}\n\n` : "";
      i = end;
      continue;
    }

    const md = turndownFragment(full);
    if (md.trim()) {
      if (
        /^(p|div|section|article|table|ul|ol|blockquote|h[1-6]|pre|figure)$/i.test(lower)
      ) {
        out += `\n\n${md.trim()}\n\n`;
      } else {
        out += md;
      }
    }
    i = end;
  }

  return normalizePastedNoteMarkdown(unmaskCodeRegions(out, slots, sentinel));
};

/**
 * Resolve clipboard plain + html into note markdown.
 * Structured text/plain wins over presentation HTML wrappers.
 */
export const resolveNoteClipboardPaste = (input: {
  plainText: string;
  htmlText: string;
}): NoteClipboardPastePayload => {
  const plain = (input.plainText ?? "").replace(/\r\n?/g, "\n");
  const html = input.htmlText ?? "";

  // 1) Structured plain Markdown is authoritative (browser often also puts
  //    wrapper HTML that would escape # / ** if Turndown runs first).
  if (shouldInsertClipboardTextAsMarkdown(plain)) {
    if (plainMarkdownContainsHtml(plain)) {
      const converted = convertHtmlIslandsInMarkdown(plain);
      if (converted.trim()) {
        return {
          text: converted,
          kind: plainMarkdownContainsHtml(converted) ? "markdown" : "html-converted",
        };
      }
    }
    return { text: normalizePastedNoteMarkdown(plain), kind: "markdown" };
  }

  // 2) Rich HTML document (browser / Word / GitHub render clipboard)
  if (looksLikeClipboardHtml(html) && isPrimarilyHtmlDocument(html)) {
    const converted = convertClipboardHtmlToMarkdown(html);
    if (converted.trim()) {
      return { text: converted, kind: "html-converted" };
    }
  }

  // 3) Non-primary HTML fragment when plain is unstructured
  if (looksLikeClipboardHtml(html)) {
    const converted = convertClipboardHtmlToMarkdown(html);
    if (converted.trim()) {
      return { text: converted, kind: "html-converted" };
    }
  }

  // 4) Plain that is mostly HTML fragment
  if (looksLikeClipboardHtml(plain)) {
    const converted = convertClipboardHtmlToMarkdown(plain);
    if (converted.trim()) {
      return { text: converted, kind: "html-converted" };
    }
  }

  if (plain.trim()) {
    return { text: plain, kind: "plain" };
  }

  return { text: "", kind: "empty" };
};

export const shouldInterceptResolvedNotePaste = (input: {
  editorMode: "edit" | "preview";
  pasteInsideCodeBlock: boolean;
  payload: NoteClipboardPastePayload;
}): boolean => {
  if (input.editorMode !== "edit") return false;
  if (input.pasteInsideCodeBlock) return false;
  if (input.payload.kind === "empty") return false;
  if (input.payload.kind === "html-converted") return true;
  if (input.payload.kind === "markdown") return true;
  return false;
};
