export type NoteEditorMode = "edit" | "preview";

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

export type NoteMarkdownPasteTextFormat = "bold" | "italic" | "code" | "strikethrough";

export type NoteMarkdownPasteSelectionNode = {
  getType: () => string;
  getParent: () => NoteMarkdownPasteSelectionNode | null;
  getKey?: () => string;
  getURL?: () => string;
  getTitle?: () => string | null;
  getTag?: () => string;
  getListType?: () => "bullet" | "number" | "check" | string;
  getValue?: () => number;
  getChecked?: () => boolean | undefined;
  getTextContent?: () => string;
  hasFormat?: (type: NoteMarkdownPasteTextFormat) => boolean;
};

export type NoteMarkdownPasteSelection = {
  hasFormat: (type: NoteMarkdownPasteTextFormat) => boolean;
  anchor: {
    getNode: () => NoteMarkdownPasteSelectionNode;
    offset?: number;
    type?: string;
  };
  focus?: {
    getNode: () => NoteMarkdownPasteSelectionNode;
    offset?: number;
    type?: string;
  };
  getNodes?: () => NoteMarkdownPasteSelectionNode[];
  isBackward?: () => boolean;
};

const NOTE_MARKDOWN_PASTE_BLOCK_TYPES = new Set([
  "heading",
  "paragraph",
  "listitem",
  "quote",
]);

const isLexicalLinkNode = (
  node: NoteMarkdownPasteSelectionNode,
): node is NoteMarkdownPasteSelectionNode & { getURL: () => string } => (
  (node.getType() === "link" || node.getType() === "autolink")
  && typeof node.getURL === "function"
);

const applyLexicalInlineMarkdownFormats = (
  text: string,
  formatSource: { hasFormat: (type: NoteMarkdownPasteTextFormat) => boolean },
): string => {
  if (!text) return text;
  // Code fences out other emphasis markers in CommonMark-style paste.
  if (formatSource.hasFormat("code")) return `\`${text}\``;
  // Strike innermost so bold+strike matches clipboard `**~~…~~**`.
  let formatted = text;
  if (formatSource.hasFormat("strikethrough")) formatted = `~~${formatted}~~`;
  const bold = formatSource.hasFormat("bold");
  const italic = formatSource.hasFormat("italic");
  if (bold && italic) return `***${formatted}***`;
  if (bold) return `**${formatted}**`;
  if (italic) return `*${formatted}*`;
  return formatted;
};

const formatLexicalLinkMarkdown = (
  label: string,
  url: string,
  title?: string | null,
): string => {
  if (title) {
    return `[${label}](${url} "${title.replace(/"/g, '\\"')}")`;
  }
  return `[${label}](${url})`;
};

const getLexicalListNestingDepth = (listItem: NoteMarkdownPasteSelectionNode): number => {
  let depth = 0;
  let current: NoteMarkdownPasteSelectionNode | null = listItem.getParent();
  while (current) {
    if (current.getType() === "list") depth += 1;
    current = current.getParent();
  }
  return Math.max(depth, 1);
};

const findLexicalAncestorByTypes = (
  node: NoteMarkdownPasteSelectionNode,
  types: ReadonlySet<string>,
): NoteMarkdownPasteSelectionNode | null => {
  let current: NoteMarkdownPasteSelectionNode | null = node;
  while (current) {
    if (types.has(current.getType())) return current;
    current = current.getParent();
  }
  return null;
};

const findLexicalLinkAncestor = (
  node: NoteMarkdownPasteSelectionNode,
): (NoteMarkdownPasteSelectionNode & { getURL: () => string }) | null => {
  let current: NoteMarkdownPasteSelectionNode | null = node;
  while (current) {
    if (isLexicalLinkNode(current)) return current;
    current = current.getParent();
  }
  return null;
};

const getCheckListMarker = (listItem: NoteMarkdownPasteSelectionNode): string => {
  const checked = typeof listItem.getChecked === "function"
    ? Boolean(listItem.getChecked())
    : false;
  return `- [${checked ? "x" : " "}]`;
};

const getLexicalBlockMarkerPrefix = (block: NoteMarkdownPasteSelectionNode): string => {
  const type = block.getType();
  if (type === "listitem") {
    const parent = block.getParent();
    const listType = parent?.getType() === "list" && typeof parent.getListType === "function"
      ? parent.getListType()
      : "bullet";
    const listIndent = Math.max(getLexicalListNestingDepth(block) - 1, 0) * 2;
    if (listType === "number") {
      const value = typeof block.getValue === "function" ? block.getValue() : 1;
      return `${" ".repeat(listIndent)}${value}. `;
    }
    if (listType === "check") {
      return `${" ".repeat(listIndent)}${getCheckListMarker(block)} `;
    }
    return `${" ".repeat(listIndent)}- `;
  }
  if (type === "heading" && typeof block.getTag === "function") {
    const level = Number(block.getTag().replace(/^h/iu, "")) || 1;
    return `${"#".repeat(Math.min(Math.max(level, 1), 6))} `;
  }
  if (type === "quote") {
    return "> ";
  }
  return "";
};

/** Plain selected text inside one block (no markdown markers). */
const getSelectedLexicalBlockPlainText = (
  block: NoteMarkdownPasteSelectionNode,
  blockKey: string,
  nodes: NoteMarkdownPasteSelectionNode[],
  selection: NoteMarkdownPasteSelection,
): string => {
  let plain = "";
  for (const node of nodes) {
    const type = node.getType();
    if (type === "linebreak") {
      const nodeBlock = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
      if (nodeBlock && getLexicalNodeKey(nodeBlock, "") === blockKey) plain += "\n";
      continue;
    }
    if (type !== "text") continue;
    const nodeBlock = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
    if (!nodeBlock || getLexicalNodeKey(nodeBlock, "") !== blockKey) continue;
    plain += getSelectedLexicalTextNodeContent(node, selection);
  }
  return plain;
};

/**
 * Heading/list/quote markers belong only on whole-block selections. Partial
 * inline ranges (e.g. bold "Hello" inside `# **Hello** world`) serialize as
 * inline markdown only so identical-replace recovery stays accurate.
 *
 * Covering every character of the block is not enough: a heading/list whose
 * sole content is the selected text still has a structural marker outside the
 * text range. Require the block node in getNodes() or an element-type
 * anchor/focus on that block.
 */
export const doesSelectionEncompassLexicalBlock = (
  block: NoteMarkdownPasteSelectionNode,
  blockKey: string,
  nodes: NoteMarkdownPasteSelectionNode[],
  selection: NoteMarkdownPasteSelection,
): boolean => {
  if (typeof block.getTextContent !== "function") return true;
  const blockText = block.getTextContent();
  if (getSelectedLexicalBlockPlainText(block, blockKey, nodes, selection) !== blockText) {
    return false;
  }

  for (const node of nodes) {
    if (node === block || getLexicalNodeKey(node, "") === blockKey) return true;
  }

  const anchor = selection.anchor;
  const focus = selection.focus ?? selection.anchor;
  const isElementBoundaryOnBlock = (
    point: { getNode: () => NoteMarkdownPasteSelectionNode; type?: string },
  ): boolean => {
    if (point.type !== "element") return false;
    const pointNode = point.getNode();
    return pointNode === block || getLexicalNodeKey(pointNode, "") === blockKey;
  };
  return isElementBoundaryOnBlock(anchor) || isElementBoundaryOnBlock(focus);
};

const getSelectedLexicalTextNodeContent = (
  node: NoteMarkdownPasteSelectionNode,
  selection: NoteMarkdownPasteSelection,
): string => {
  const fullText = typeof node.getTextContent === "function" ? node.getTextContent() : "";
  const anchor = selection.anchor;
  const focus = selection.focus ?? selection.anchor;
  const isBefore = typeof selection.isBackward === "function"
    ? !selection.isBackward()
    : true;
  const startPoint = isBefore ? anchor : focus;
  const endPoint = isBefore ? focus : anchor;
  // Element-type points use child-index offsets, not character offsets. Only
  // text-typed endpoints contribute character slices; the element-bounded side
  // treats every text node present in getNodes() as fully selected.
  const startTextNode = startPoint.type === "text" ? startPoint.getNode() : null;
  const endTextNode = endPoint.type === "text" ? endPoint.getNode() : null;
  const startOffset = startPoint.type === "text" && typeof startPoint.offset === "number"
    ? startPoint.offset
    : 0;
  const endOffset = endPoint.type === "text" && typeof endPoint.offset === "number"
    ? endPoint.offset
    : fullText.length;

  if (startTextNode && endTextNode && node === startTextNode && node === endTextNode) {
    return startOffset < endOffset
      ? fullText.slice(startOffset, endOffset)
      : fullText.slice(endOffset, startOffset);
  }
  if (startTextNode && node === startTextNode) return fullText.slice(startOffset);
  if (endTextNode && node === endTextNode) return fullText.slice(0, endOffset);
  return fullText;
};

const getLexicalNodeKey = (
  node: NoteMarkdownPasteSelectionNode,
  fallback: string,
): string => (typeof node.getKey === "function" ? node.getKey() : fallback);

const serializeLexicalBlockInlineMarkdown = (
  block: NoteMarkdownPasteSelectionNode,
  blockKey: string,
  nodes: NoteMarkdownPasteSelectionNode[],
  selection: NoteMarkdownPasteSelection,
): string => {
  let markdown = "";
  let linkBuffer: {
    linkKey: string;
    link: NoteMarkdownPasteSelectionNode & { getURL: () => string };
    label: string;
  } | null = null;

  const flushLink = () => {
    if (!linkBuffer) return;
    const title = typeof linkBuffer.link.getTitle === "function"
      ? linkBuffer.link.getTitle()
      : null;
    markdown += formatLexicalLinkMarkdown(linkBuffer.label, linkBuffer.link.getURL(), title);
    linkBuffer = null;
  };

  for (const node of nodes) {
    const type = node.getType();
    if (type === "linebreak") {
      // Hard breaks are inline to their owning block; skip when serializing a
      // sibling block from a multi-block selection (same filter as text nodes).
      const nodeBlock = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
      if (!nodeBlock || getLexicalNodeKey(nodeBlock, "") !== blockKey) continue;
      flushLink();
      // CommonMark hard break (Lexical LineBreakNode), not a block separator.
      markdown += "  \n";
      continue;
    }
    if (type !== "text" || typeof node.hasFormat !== "function") continue;
    const nodeBlock = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
    if (!nodeBlock || getLexicalNodeKey(nodeBlock, "") !== blockKey) continue;

    const text = getSelectedLexicalTextNodeContent(node, selection);
    if (!text) continue;
    const formatted = applyLexicalInlineMarkdownFormats(text, node);
    const link = findLexicalLinkAncestor(node);
    if (!link) {
      flushLink();
      markdown += formatted;
      continue;
    }
    const linkKey = getLexicalNodeKey(link, link.getURL());
    if (linkBuffer && linkBuffer.linkKey !== linkKey) flushLink();
    if (!linkBuffer) linkBuffer = { linkKey, link, label: formatted };
    else linkBuffer.label += formatted;
  }
  flushLink();
  return markdown;
};

const serializeLexicalSelectionNodesAsMarkdown = (
  selection: NoteMarkdownPasteSelection,
): string | null => {
  if (typeof selection.getNodes !== "function") return null;
  const nodes = selection.getNodes();
  if (nodes.length === 0) return null;

  const blocks: Array<{ block: NoteMarkdownPasteSelectionNode; key: string }> = [];
  const seenBlockKeys = new Set<string>();
  for (const node of nodes) {
    const block = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
    if (!block) continue;
    const key = getLexicalNodeKey(block, `${block.getType()}:${blocks.length}`);
    if (seenBlockKeys.has(key)) continue;
    seenBlockKeys.add(key);
    blocks.push({ block, key });
  }
  if (blocks.length === 0) return null;

  const parts: Array<{ block: NoteMarkdownPasteSelectionNode; markdown: string }> = [];
  for (const { block, key } of blocks) {
    const inline = serializeLexicalBlockInlineMarkdown(block, key, nodes, selection);
    if (!inline) continue;
    const marker = doesSelectionEncompassLexicalBlock(block, key, nodes, selection)
      ? getLexicalBlockMarkerPrefix(block)
      : "";
    parts.push({ block, markdown: `${marker}${inline}` });
  }
  if (parts.length === 0) return null;
  // Adjacent list items stay tight (`- a\n- b`); other block boundaries keep a
  // blank line so identical-replace equivalence matches clipboard Markdown.
  let joined = parts[0].markdown;
  for (let i = 1; i < parts.length; i += 1) {
    const prev = parts[i - 1].block;
    const next = parts[i].block;
    const sameListRun = prev.getType() === "listitem" && next.getType() === "listitem";
    joined += `${sameListRun ? "\n" : "\n\n"}${parts[i].markdown}`;
  }
  return joined;
};

/**
 * Best-effort markdown for the active Lexical range (combined text formats,
 * link URL/title, and per-block markers). Used to scope paste-equivalence
 * checks to the selection, not the whole document.
 */
export const serializeLexicalSelectionAsMarkdown = (
  selectedText: string,
  selection: NoteMarkdownPasteSelection,
): string => {
  const fromNodes = serializeLexicalSelectionNodesAsMarkdown(selection);
  if (fromNodes !== null) return fromNodes;

  // Fallback when getNodes() is unavailable (unit mocks): single-anchor path.
  let markdown = applyLexicalInlineMarkdownFormats(selectedText, selection);
  let linkUrl: string | null = null;
  let linkTitle: string | null = null;
  let headingTag: string | null = null;
  let listMarker: string | null = null;
  let listIndent = 0;
  let isQuote = false;

  let current: NoteMarkdownPasteSelectionNode | null = selection.anchor.getNode();
  while (current) {
    const type = current.getType();
    if (!linkUrl && isLexicalLinkNode(current)) {
      linkUrl = current.getURL();
      linkTitle = typeof current.getTitle === "function" ? current.getTitle() : null;
    }
    if (!headingTag && type === "heading" && typeof current.getTag === "function") {
      headingTag = current.getTag();
    }
    if (listMarker === null && type === "listitem") {
      const parent = current.getParent();
      const listType = parent?.getType() === "list" && typeof parent.getListType === "function"
        ? parent.getListType()
        : "bullet";
      listIndent = Math.max(getLexicalListNestingDepth(current) - 1, 0) * 2;
      if (listType === "number") {
        const value = typeof current.getValue === "function" ? current.getValue() : 1;
        listMarker = `${value}.`;
      } else if (listType === "check") {
        listMarker = getCheckListMarker(current);
      } else {
        listMarker = "-";
      }
    }
    if (!isQuote && type === "quote") {
      isQuote = true;
    }
    current = current.getParent();
  }

  if (linkUrl) {
    markdown = formatLexicalLinkMarkdown(markdown, linkUrl, linkTitle);
  }
  if (selectedText.length === 0) return markdown;

  // Fallback (no getNodes): include block markers only when block plain text
  // is unknown. Text equality alone cannot prove the structural marker was
  // selected (sole-content heading/list item).
  let blockTextKnown = false;
  let blockProbe: NoteMarkdownPasteSelectionNode | null = selection.anchor.getNode();
  while (blockProbe) {
    if (NOTE_MARKDOWN_PASTE_BLOCK_TYPES.has(blockProbe.getType())) {
      blockTextKnown = typeof blockProbe.getTextContent === "function";
      break;
    }
    blockProbe = blockProbe.getParent();
  }
  const includeBlockMarker = !blockTextKnown;

  if (includeBlockMarker && listMarker !== null) {
    return `${" ".repeat(listIndent)}${listMarker} ${markdown}`;
  }
  if (includeBlockMarker && headingTag) {
    const level = Number(headingTag.replace(/^h/iu, "")) || 1;
    return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${markdown}`;
  }
  if (includeBlockMarker && isQuote) {
    return `> ${markdown}`;
  }
  return markdown;
};

/**
 * Merge a markdown paste when Lexical selection is missing or insertMarkdown
 * no-ops. Prefer insertMarkdown whenever a selection exists so caret/replace
 * semantics stay intact (including Select All + Paste).
 */
export const mergeNoteMarkdownDocumentPaste = (
  currentMarkdown: string,
  clipboardText: string,
): string => {
  const current = currentMarkdown.replace(/\s+$/u, "");
  // Strip leading blank lines only — keep indentation on the first content line
  // (nested list markers, fenced code, etc.).
  const pasted = clipboardText
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[^\S\n]*\n)+/u, "")
    .replace(/\s+$/u, "");
  if (!pasted) return currentMarkdown;
  if (!current) return pasted;
  return `${current}\n\n${pasted}`;
};

/**
 * Replace `[label](destination)` / `![alt](destination)` with the label/alt,
 * allowing balanced parentheses inside the destination
 * (e.g. `[docs](https://example.test/a_(b))` → `docs`).
 */
const replaceMarkdownLinksWithLabels = (text: string, images: boolean): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(images ? "![" : "[", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    if (!images && open > 0 && text[open - 1] === "!") {
      // Image marker belongs to the image pass; keep "[" for later.
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += text.slice(i, open);
    const labelStart = open + (images ? 2 : 1);
    const labelEnd = text.indexOf("]", labelStart);
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      out += text.slice(open, open + (images ? 2 : 1));
      i = open + (images ? 2 : 1);
      continue;
    }
    let depth = 1;
    let destEnd = -1;
    for (let j = labelEnd + 2; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "\n") break;
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          destEnd = j;
          break;
        }
      }
    }
    if (destEnd === -1) {
      out += text.slice(open, open + (images ? 2 : 1));
      i = open + (images ? 2 : 1);
      continue;
    }
    out += text.slice(labelStart, labelEnd);
    i = destEnd + 1;
  }
  return out;
};

/**
 * Approximate Lexical selection.getTextContent() for clipboard markdown so
 * equivalent pastes (bold Hello vs **Hello**) can be compared as plain text.
 */
export const noteMarkdownClipboardToPlainText = (markdown: string): string => {
  let text = markdown.replace(/\r\n?/g, "\n");
  // Fenced code: keep inner content (drop the fence lines).
  text = text.replace(/^ {0,3}(?:```|~~~)[^\n]*\n([\s\S]*?)^ {0,3}(?:```|~~~)[ \t]*$/gm, "$1");
  text = replaceMarkdownLinksWithLabels(text, true);
  text = replaceMarkdownLinksWithLabels(text, false);
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, "$2");
  // GFM strikethrough after bold/italic so `**~~Hello~~**` / `~~**Hello**~~` → Hello.
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  text = text.replace(/^ {0,3}#{1,6}\s+/gm, "");
  // Task-list markers before ordinary list bullets so `- [ ] task` → `task`.
  text = text.replace(/^ {0,3}[-+*]\s+\[[ xX]\]\s+/gm, "");
  text = text.replace(/^ {0,3}(?:[-+*]|\d+[.)])\s+/gm, "");
  text = text.replace(/^ {0,3}>\s?/gm, "");
  text = text.replace(/^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/gm, "");
  // Hard breaks → plain newlines (Lexical selection text has no marker spaces).
  text = text.replace(/ {2,}\n/g, "\n");
  text = text.replace(/\\\n/g, "\n");
  return text;
};

/** Collapse block separators so Lexical plain selection matches Markdown plain text. */
const normalizePlainSelectionBlockSeparators = (text: string): string =>
  text.replace(/\n+/g, "\n");

const MARKDOWN_EQUIVALENCE_PROTECT_PREFIX = "\u0000MDPROT:";
const MARKDOWN_EQUIVALENCE_PROTECT_SUFFIX = "\u0000";

/**
 * Run a transform only on Markdown that is safe to rewrite for emphasis
 * equivalence. Inline/fenced code and link/image destinations keep literal
 * underscores (e.g. `` `__x__` `` must not become `` `**x**` ``).
 */
const mapNoteMarkdownOutsideProtectedRegions = (
  text: string,
  transform: (exposed: string) => string,
): string => {
  const saved: string[] = [];
  const stash = (chunk: string): string => {
    const id = saved.length;
    saved.push(chunk);
    return `${MARKDOWN_EQUIVALENCE_PROTECT_PREFIX}${id}${MARKDOWN_EQUIVALENCE_PROTECT_SUFFIX}`;
  };

  let working = text;
  working = working.replace(
    /^ {0,3}(?:```|~~~)[^\n]*\n[\s\S]*?^ {0,3}(?:```|~~~)[ \t]*$/gm,
    (chunk) => stash(chunk),
  );
  working = working.replace(/`[^`\n]+`/g, (chunk) => stash(chunk));
  working = protectMarkdownLinkDestinations(working, stash);
  working = transform(working);
  return working.replace(
    new RegExp(
      `${MARKDOWN_EQUIVALENCE_PROTECT_PREFIX}(\\d+)${MARKDOWN_EQUIVALENCE_PROTECT_SUFFIX}`,
      "g",
    ),
    (_match, id: string) => saved[Number(id)] ?? "",
  );
};

/** Keep `[label](dest)` / `![alt](dest)` wrappers; stash only the `(dest)` segment. */
const protectMarkdownLinkDestinations = (
  text: string,
  stash: (chunk: string) => string,
): string => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const img = text.indexOf("![", i);
    const link = text.indexOf("[", i);
    let open = -1;
    let images = false;
    if (img !== -1 && (link === -1 || img <= link)) {
      open = img;
      images = true;
    } else if (link !== -1) {
      open = link;
    } else {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const labelStart = open + (images ? 2 : 1);
    const labelEnd = text.indexOf("]", labelStart);
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      out += text.slice(open, open + (images ? 2 : 1));
      i = open + (images ? 2 : 1);
      continue;
    }
    let depth = 1;
    let destEnd = -1;
    for (let j = labelEnd + 2; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "\n") break;
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          destEnd = j;
          break;
        }
      }
    }
    if (destEnd === -1) {
      out += text.slice(open, open + (images ? 2 : 1));
      i = open + (images ? 2 : 1);
      continue;
    }
    // Label stays exposed (emphasis may canonicalize); destination is literal.
    out += text.slice(open, labelEnd + 1);
    out += stash(text.slice(labelEnd + 1, destEnd + 1));
    i = destEnd + 1;
  }
  return out;
};

/**
 * Canonicalize semantically equivalent Markdown spelling so identical-replace
 * checks are not tripped by serializer vs clipboard marker differences
 * (`**Hello**` vs `__Hello__`, `*Hi*` vs `_Hi_`, `* item` vs `- item`).
 */
export const normalizeNoteMarkdownForEquivalence = (markdown: string): string => {
  const text = markdown.replace(/\r\n?/g, "\n");
  return mapNoteMarkdownOutsideProtectedRegions(text, (exposed) => {
    let next = exposed;
    // Strong emphasis: __x__ → **x** (serializer canonical form).
    next = next.replace(/(__)(?=\S)([\s\S]*?\S)\1/g, "**$2**");
    // Emphasis: _x_ → *x* (avoid matching inside identifiers / already-normalized **).
    next = next.replace(
      /(^|[^\\*\w])_(\S[\s\S]*?\S)_(?=$|[^\\*\w])/g,
      "$1*$2*",
    );
    // Unordered / task-list markers: MDXEditor defaults to `*`, serializer uses `-`.
    // Require trailing whitespace so `*Hi*` / `***` stay untouched.
    next = next.replace(/^(\s*)[-+*](\s+)/gm, "$1-$2");
    // Hard breaks: backslash form → two-trailing-spaces (serializer form).
    next = next.replace(/\\\n/g, "  \n");
    // Collapse 3+ trailing spaces before a newline to the canonical two-space break.
    next = next.replace(/ {3,}\n/g, "  \n");
    return next;
  });
};

/**
 * After insertMarkdown, an unchanged document is either a successful identical
 * replace or a lost-selection no-op. Only the latter should fall back to
 * document-append recovery.
 *
 * Lexical selection text is plain (bold/link label only). Do not treat
 * plain-text equality alone as a successful replace — pasting `**Hello**` over
 * plain `Hello`, or the same link label with a different URL, must still
 * recover when the insert no-ops. Suppress recovery only when the clipboard
 * markdown matches the active selection's own markdown (not merely when the
 * same clipboard substring exists elsewhere in the document).
 */
export const shouldRecoverNoteMarkdownPasteAfterUnchangedInsert = (input: {
  beforeMarkdown: string;
  clipboardText: string;
  selectedText: string | null;
  /** Selection-scoped markdown; required to suppress structured identical replaces. */
  selectedMarkdown?: string | null;
}): boolean => {
  const before = input.beforeMarkdown.replace(/\r\n?/g, "\n");
  const clipboard = input.clipboardText.replace(/\r\n?/g, "\n");
  // Select All + paste of the same body: serialization stays equal on success.
  if (normalizeNoteMarkdownForEquivalence(clipboard)
    === normalizeNoteMarkdownForEquivalence(before)) {
    return false;
  }
  if (input.selectedText !== null) {
    const selected = input.selectedText.replace(/\r\n?/g, "\n");
    // Exact plain clipboard match (no markdown markers to apply).
    if (selected === clipboard) return false;
    // Structured clipboard: skip recovery only when the selection itself is
    // already that markdown (identical formatted/link replace at this range).
    // Compare normalized structure so `__Hello__` matches serializer `**Hello**`.
    // Also normalize block separators: Lexical selection plain text uses one
    // newline between blocks while clipboard Markdown keeps a blank line.
    if (
      normalizePlainSelectionBlockSeparators(selected)
      === normalizePlainSelectionBlockSeparators(noteMarkdownClipboardToPlainText(clipboard))
    ) {
      const selectedMarkdown = input.selectedMarkdown?.replace(/\r\n?/g, "\n") ?? null;
      if (
        selectedMarkdown !== null
        && normalizeNoteMarkdownForEquivalence(selectedMarkdown)
          === normalizeNoteMarkdownForEquivalence(clipboard)
      ) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Decide whether markdown paste should call preventDefault.
 * Selection is optional on the Lexical content surface: when the caret is gone
 * (common after a prior insertMarkdown), the handler recovers via document
 * setMarkdown merge instead of letting preventDefault + a no-op Lexical insert
 * swallow the clipboard. Dialog/toolbar inputs are never intercepted.
 */
export const shouldInterceptNoteMarkdownPaste = (input: {
  editorMode: NoteEditorMode;
  pasteInsideCodeBlock: boolean;
  clipboardText: string;
  /** True when paste targets Lexical contenteditable (not dialog/toolbar). */
  pasteInsideLexicalContentSurface: boolean;
  /**
   * Strategy hint for insertMarkdown vs document merge after intercept.
   * Kept on the input for callers; intercept itself keys off the content surface.
   */
  canInsertMarkdownAtSelection: boolean;
}): boolean => {
  if (input.editorMode !== "edit") return false;
  if (input.pasteInsideCodeBlock) return false;
  // Restrict intercept (including no-selection recovery) to the Lexical editing
  // surface so link dialog / toolbar pastes keep native input behavior.
  if (!input.pasteInsideLexicalContentSurface) return false;
  return shouldInsertClipboardTextAsMarkdown(input.clipboardText);
};
