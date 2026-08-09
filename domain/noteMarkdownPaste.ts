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

export type NoteMarkdownPasteMdastTable = {
  align?: Array<"left" | "right" | "center" | null> | null;
  children?: Array<{
    children?: Array<{
      children?: unknown[];
    }>;
  }>;
};

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
  /** Lexical ElementNode children; used to exclude nested list text. */
  getChildren?: () => NoteMarkdownPasteSelectionNode[];
  hasFormat?: (type: NoteMarkdownPasteTextFormat) => boolean;
  /** MDXEditor table decorator nodes expose the backing MDAST table. */
  getMdastNode?: () => NoteMarkdownPasteMdastTable;
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

type NoteMarkdownPasteInlineFormatStackItem =
  | "code"
  | "bold"
  | "italic"
  | "strikethrough";

const NOTE_MARKDOWN_PASTE_INLINE_FORMAT_MARKERS: Record<
  NoteMarkdownPasteInlineFormatStackItem,
  { open: string; close: string }
> = {
  code: { open: "`", close: "`" },
  bold: { open: "**", close: "**" },
  italic: { open: "*", close: "*" },
  strikethrough: { open: "~~", close: "~~" },
};

/**
 * Stable outer→inner open order so adjacent Lexical text nodes that share an
 * outer format (bold "Hello " + bold+strike "world") serialize as one wrapper
 * (`**Hello ~~world~~**`) instead of `**Hello ****~~world~~**`.
 */
const getLexicalInlineMarkdownFormatStack = (
  formatSource: { hasFormat: (type: NoteMarkdownPasteTextFormat) => boolean },
): NoteMarkdownPasteInlineFormatStackItem[] => {
  // Code fences out other emphasis markers in CommonMark-style paste.
  if (formatSource.hasFormat("code")) return ["code"];
  const stack: NoteMarkdownPasteInlineFormatStackItem[] = [];
  if (formatSource.hasFormat("bold")) stack.push("bold");
  if (formatSource.hasFormat("italic")) stack.push("italic");
  // Strike innermost so bold+strike matches clipboard `**~~…~~**`.
  if (formatSource.hasFormat("strikethrough")) stack.push("strikethrough");
  return stack;
};

/**
 * Escape phrasing punctuation so Lexical rendered text round-trips to source
 * Markdown (`**Hello \*world\***`, not `**Hello *world***`). Mirrors the
 * always-on mdast-util-to-markdown phrasing unsafe set (`*`, `_`, `` ` ``, `[`,
 * and GFM `~`), plus `]` so link labels with a literal bracket serialize as
 * `[a\]b](url)` (not broken `[a]b](url)`), plus line-leading block openers
 * (`#`, `>`, `-`, `+`, ordered `1.` / `1)`) so literal `# Heading` / `- item` /
 * `1. item` serialize as `\# Heading` / `\- item` / `1\. item`. (`*` list
 * openers are already covered by the phrasing `*` escape.)
 */
const escapeNoteMarkdownPhrasingText = (text: string): string => {
  const escaped = text.replace(/([`*_\[\]~])/g, "\\$1");
  return escaped
    .replace(/(^|\n)( {0,3})([#>+-])/g, "$1$2\\$3")
    .replace(/(^|\n)( {0,3})(\d+)([.)])/g, "$1$2$3\\$4");
};

/** Prefer a fence longer than any run of backticks inside the value. */
const formatMdastInlineCode = (value: string): string => {
  let fence = "`";
  while (value.includes(fence)) fence += "`";
  const pad = value.startsWith("`") || value.endsWith("`") || value.includes("\n")
    ? " "
    : "";
  return `${fence}${pad}${value}${pad}${fence}`;
};

const applyLexicalInlineMarkdownFormats = (
  text: string,
  formatSource: { hasFormat: (type: NoteMarkdownPasteTextFormat) => boolean },
): string => {
  if (!text) return text;
  const stack = getLexicalInlineMarkdownFormatStack(formatSource);
  // Code spans use a safe fence; emphasis markers wrap escaped text.
  if (stack[0] === "code") return formatMdastInlineCode(text);
  let formatted = escapeNoteMarkdownPhrasingText(text);
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const markers = NOTE_MARKDOWN_PASTE_INLINE_FORMAT_MARKERS[stack[i]];
    formatted = `${markers.open}${formatted}${markers.close}`;
  }
  return formatted;
};

const longestCommonInlineFormatPrefixLength = (
  current: readonly NoteMarkdownPasteInlineFormatStackItem[],
  desired: readonly NoteMarkdownPasteInlineFormatStackItem[],
): number => {
  const max = Math.min(current.length, desired.length);
  let i = 0;
  while (i < max && current[i] === desired[i]) i += 1;
  return i;
};

/** Close/open format markers so `output` reflects `desired` relative to `stack`. */
const syncLexicalInlineMarkdownFormatStack = (
  stack: NoteMarkdownPasteInlineFormatStackItem[],
  desired: readonly NoteMarkdownPasteInlineFormatStackItem[],
  output: { text: string },
): void => {
  const common = longestCommonInlineFormatPrefixLength(stack, desired);
  while (stack.length > common) {
    const closed = stack.pop();
    if (!closed) break;
    output.text += NOTE_MARKDOWN_PASTE_INLINE_FORMAT_MARKERS[closed].close;
  }
  for (let i = stack.length; i < desired.length; i += 1) {
    const format = desired[i];
    stack.push(format);
    output.text += NOTE_MARKDOWN_PASTE_INLINE_FORMAT_MARKERS[format].open;
  }
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

/**
 * Whether selected phrasing under `node` belongs to `block`. Quote containers
 * nest paragraph/heading/listitem children, so nearest-block matching alone
 * never attributes text to the quote itself.
 */
const doesLexicalNodeBelongToBlock = (
  node: NoteMarkdownPasteSelectionNode,
  block: NoteMarkdownPasteSelectionNode,
  blockKey: string,
): boolean => {
  const nearest = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
  if (nearest && getLexicalNodeKey(nearest, "") === blockKey) return true;
  if (block.getType() !== "quote") return false;
  let current: NoteMarkdownPasteSelectionNode | null = nearest ?? node;
  while (current) {
    if (current === block || getLexicalNodeKey(current, "") === blockKey) return true;
    current = current.getParent();
  }
  return false;
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
      if (doesLexicalNodeBelongToBlock(node, block, blockKey)) plain += "\n";
      continue;
    }
    if (type !== "text") continue;
    if (!doesLexicalNodeBelongToBlock(node, block, blockKey)) continue;
    plain += getSelectedLexicalTextNodeContent(node, selection);
  }
  return plain;
};

/**
 * Block plain text used for whole-block selection checks. List items exclude
 * nested list descendants so parent markers are not dropped when a nested list
 * is selected (`- parent\n  - child`).
 */
const getLexicalBlockComparablePlainText = (
  block: NoteMarkdownPasteSelectionNode,
): string => {
  if (typeof block.getTextContent !== "function") return "";
  if (block.getType() !== "listitem" || typeof block.getChildren !== "function") {
    return block.getTextContent();
  }
  let plain = "";
  for (const child of block.getChildren()) {
    // Nested lists contribute their own listitem blocks; skip their text here.
    if (child.getType() === "list") continue;
    if (typeof child.getTextContent === "function") plain += child.getTextContent();
  }
  return plain;
};

/** True when two list items share a parent list or one is nested under the other. */
const areLexicalListItemsInSameTightRun = (
  prev: NoteMarkdownPasteSelectionNode,
  next: NoteMarkdownPasteSelectionNode,
): boolean => {
  if (prev.getType() !== "listitem" || next.getType() !== "listitem") return false;
  const prevParent = prev.getParent();
  const nextParent = next.getParent();
  if (prevParent && prevParent === nextParent) return true;
  let walk: NoteMarkdownPasteSelectionNode | null = next.getParent();
  while (walk) {
    if (walk === prev) return true;
    walk = walk.getParent();
  }
  walk = prev.getParent();
  while (walk) {
    if (walk === next) return true;
    walk = walk.getParent();
  }
  return false;
};

/**
 * Heading/list/quote markers belong only on whole-block selections. Partial
 * inline ranges (e.g. bold "Hello" inside `# **Hello** world`) serialize as
 * inline markdown only so identical-replace recovery stays accurate.
 *
 * Covering every character of the block is not enough: a heading/list/quote
 * whose sole content is the selected text still has a structural marker outside
 * the text range. Require the block node in getNodes() or an element-type
 * anchor/focus on that block. Quote text lives in nested paragraph blocks, so
 * callers also apply enclosing quote markers via
 * getEnclosingLexicalQuoteMarkerPrefix.
 */
export const doesSelectionEncompassLexicalBlock = (
  block: NoteMarkdownPasteSelectionNode,
  blockKey: string,
  nodes: NoteMarkdownPasteSelectionNode[],
  selection: NoteMarkdownPasteSelection,
): boolean => {
  if (typeof block.getTextContent !== "function") return true;
  const blockText = getLexicalBlockComparablePlainText(block);
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

/**
 * `> ` markers for quote ancestors that the selection fully encompasses.
 * Needed because selected blocks resolve to nested paragraphs, not the quote.
 */
const getEnclosingLexicalQuoteMarkerPrefix = (
  block: NoteMarkdownPasteSelectionNode,
  nodes: NoteMarkdownPasteSelectionNode[],
  selection: NoteMarkdownPasteSelection,
): string => {
  const markers: string[] = [];
  let current = block.getParent();
  while (current) {
    if (current.getType() === "quote") {
      const quoteKey = getLexicalNodeKey(current, `quote:${markers.length}`);
      if (!doesSelectionEncompassLexicalBlock(current, quoteKey, nodes, selection)) {
        break;
      }
      markers.push("> ");
    }
    current = current.getParent();
  }
  return markers.join("");
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
  const formatStack: NoteMarkdownPasteInlineFormatStackItem[] = [];
  let linkBuffer: {
    linkKey: string;
    link: NoteMarkdownPasteSelectionNode & { getURL: () => string };
    label: string;
  } | null = null;

  // Mutable bags so format sync can append into the outer buffer or the
  // in-progress link label without duplicating close/open logic.
  const outerOutput = {
    get text() { return markdown; },
    set text(value: string) { markdown = value; },
  };
  const labelOutput = {
    get text() { return linkBuffer?.label ?? ""; },
    set text(value: string) {
      if (linkBuffer) linkBuffer.label = value;
    },
  };

  const closeInlineFormats = () => {
    syncLexicalInlineMarkdownFormatStack(
      formatStack,
      [],
      linkBuffer ? labelOutput : outerOutput,
    );
  };

  const flushLink = () => {
    if (!linkBuffer) return;
    closeInlineFormats();
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
      // Close formats before the break so `**A**  \n**B**` stays the canonical
      // form for identical-replace checks (clipboard often splits markers).
      flushLink();
      closeInlineFormats();
      // CommonMark hard break (Lexical LineBreakNode), not a block separator.
      markdown += "  \n";
      continue;
    }
    if (type !== "text" || typeof node.hasFormat !== "function") continue;
    const nodeBlock = findLexicalAncestorByTypes(node, NOTE_MARKDOWN_PASTE_BLOCK_TYPES);
    if (!nodeBlock || getLexicalNodeKey(nodeBlock, "") !== blockKey) continue;

    const text = getSelectedLexicalTextNodeContent(node, selection);
    if (!text) continue;
    const desiredFormats = getLexicalInlineMarkdownFormatStack(node);
    // Emit a complete safe code span so values containing backticks stay valid
    // Markdown (longer padded fence), not stack-wrapped single backticks.
    if (desiredFormats[0] === "code") {
      const codeMarkdown = formatMdastInlineCode(text);
      const codeLink = findLexicalLinkAncestor(node);
      if (!codeLink) {
        flushLink();
        closeInlineFormats();
        markdown += codeMarkdown;
        continue;
      }
      const codeLinkKey = getLexicalNodeKey(codeLink, codeLink.getURL());
      if (linkBuffer && linkBuffer.linkKey !== codeLinkKey) flushLink();
      if (!linkBuffer) {
        closeInlineFormats();
        linkBuffer = { linkKey: codeLinkKey, link: codeLink, label: "" };
      }
      closeInlineFormats();
      linkBuffer.label += codeMarkdown;
      continue;
    }
    const escapedText = escapeNoteMarkdownPhrasingText(text);
    const link = findLexicalLinkAncestor(node);
    if (!link) {
      flushLink();
      syncLexicalInlineMarkdownFormatStack(
        formatStack,
        desiredFormats,
        outerOutput,
      );
      markdown += escapedText;
      continue;
    }
    const linkKey = getLexicalNodeKey(link, link.getURL());
    if (linkBuffer && linkBuffer.linkKey !== linkKey) flushLink();
    if (!linkBuffer) {
      closeInlineFormats();
      linkBuffer = { linkKey, link, label: "" };
    }
    syncLexicalInlineMarkdownFormatStack(
      formatStack,
      desiredFormats,
      labelOutput,
    );
    linkBuffer.label += escapedText;
  }
  flushLink();
  closeInlineFormats();
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
    const quotePrefix = getEnclosingLexicalQuoteMarkerPrefix(block, nodes, selection);
    const marker = doesSelectionEncompassLexicalBlock(block, key, nodes, selection)
      ? getLexicalBlockMarkerPrefix(block)
      : "";
    parts.push({ block, markdown: `${quotePrefix}${marker}${inline}` });
  }
  if (parts.length === 0) return null;
  // Same-list / nested list items stay tight (`- a\n- b`, `- p\n  - c`);
  // adjacent distinct lists keep a blank line like MDXEditor serialization.
  let joined = parts[0].markdown;
  for (let i = 1; i < parts.length; i += 1) {
    const prev = parts[i - 1].block;
    const next = parts[i].block;
    const sameListRun = areLexicalListItemsInSameTightRun(prev, next);
    joined += `${sameListRun ? "\n" : "\n\n"}${parts[i].markdown}`;
  }
  return joined;
};

const isMdastRecord = (
  node: unknown,
): node is {
  type?: unknown;
  value?: unknown;
  url?: unknown;
  title?: unknown;
  children?: unknown;
} => typeof node === "object" && node !== null;

/**
 * Serialize MDAST phrasing (table cells, etc.) so inline marks survive for
 * selection-scoped identical-replace checks.
 */
const serializeMdastPhrasingAsMarkdown = (nodes: readonly unknown[]): string => {
  let markdown = "";
  for (const node of nodes) {
    if (typeof node === "string") {
      markdown += escapeNoteMarkdownPhrasingText(node);
      continue;
    }
    if (!isMdastRecord(node)) continue;
    const type = typeof node.type === "string" ? node.type : "";
    const children = Array.isArray(node.children) ? node.children : [];
    if (type === "text") {
      markdown += escapeNoteMarkdownPhrasingText(
        typeof node.value === "string" ? node.value : "",
      );
      continue;
    }
    if (type === "strong") {
      markdown += `**${serializeMdastPhrasingAsMarkdown(children)}**`;
      continue;
    }
    if (type === "emphasis") {
      markdown += `*${serializeMdastPhrasingAsMarkdown(children)}*`;
      continue;
    }
    if (type === "delete") {
      markdown += `~~${serializeMdastPhrasingAsMarkdown(children)}~~`;
      continue;
    }
    if (type === "inlineCode") {
      markdown += formatMdastInlineCode(
        typeof node.value === "string" ? node.value : "",
      );
      continue;
    }
    if (type === "link" && typeof node.url === "string") {
      const title = typeof node.title === "string" ? node.title : null;
      markdown += formatLexicalLinkMarkdown(
        serializeMdastPhrasingAsMarkdown(children),
        node.url,
        title,
      );
      continue;
    }
    if (type === "break") {
      markdown += "  \n";
      continue;
    }
    if (typeof node.value === "string") {
      markdown += escapeNoteMarkdownPhrasingText(node.value);
      continue;
    }
    if (children.length > 0) {
      markdown += serializeMdastPhrasingAsMarkdown(children);
    }
  }
  return markdown;
};

const serializeMdastTableCellAsMarkdown = (cell: unknown): string => {
  if (!isMdastRecord(cell)) return "";
  const children = Array.isArray(cell.children) ? cell.children : [];
  const text = serializeMdastPhrasingAsMarkdown(children)
    .replace(/\r\n?/g, "\n")
    .replace(/\|/g, "\\|");
  // Pipe tables are single-line cells in the clipboard form we accept.
  return text.replace(/\n+/g, " ").trim();
};

/**
 * Serialize an MDXEditor/MDAST table node to GFM pipe table markdown for
 * selection-scoped identical-replace checks.
 */
export const serializeMdastTableAsMarkdown = (
  table: NoteMarkdownPasteMdastTable | null | undefined,
): string | null => {
  const rows = (table?.children ?? [])
    .map((row) => (row.children ?? []).map((cell) => serializeMdastTableCellAsMarkdown(cell)))
    .filter((row) => row.length > 0);
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((row) => row.length));
  if (colCount === 0) return null;
  const pad = (row: string[]): string[] => Array.from(
    { length: colCount },
    (_, index) => row[index] ?? "",
  );
  const align = table?.align ?? [];
  const separator = Array.from({ length: colCount }, (_, index) => {
    const value = align[index];
    if (value === "center") return ":---:";
    if (value === "right") return "---:";
    if (value === "left") return ":---";
    return "---";
  });
  const lines = [
    `| ${pad(rows[0]).join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${pad(row).join(" | ")} |`),
  ];
  return lines.join("\n");
};

/**
 * Markdown for a Lexical NodeSelection (decorator blocks such as thematic
 * breaks and tables). Range selections use serializeLexicalSelectionAsMarkdown.
 */
export const serializeLexicalNodeSelectionAsMarkdown = (
  nodes: readonly NoteMarkdownPasteSelectionNode[],
): string | null => {
  if (nodes.length === 0) return null;
  const parts: string[] = [];
  for (const node of nodes) {
    const type = node.getType();
    if (type === "horizontalrule") {
      // mdast-util-to-markdown / MDXEditor default thematic break form.
      parts.push("***");
      continue;
    }
    if (type === "table") {
      if (typeof node.getMdastNode !== "function") return null;
      const tableMarkdown = serializeMdastTableAsMarkdown(node.getMdastNode());
      if (tableMarkdown === null) return null;
      parts.push(tableMarkdown);
      continue;
    }
    // Unknown decorator / block node: no selection-scoped equivalence evidence.
    return null;
  }
  return parts.join("\n\n");
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
  // Thematic breaks before emphasis: otherwise `***` is eaten as italic `*…*`.
  text = text.replace(/^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/gm, "");
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

const NOTE_MARKDOWN_GFM_TABLE_SEPARATOR_RE =
  /^\|?(?:\s*:?-+:?\s*\|)+(?:\s*:?-+:?\s*)\|?\s*$/;

const isNoteMarkdownGfmTableSeparatorLine = (line: string): boolean =>
  NOTE_MARKDOWN_GFM_TABLE_SEPARATOR_RE.test(line.trim());

const isNoteMarkdownGfmTableDataRowLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed || isNoteMarkdownGfmTableSeparatorLine(trimmed)) return false;
  return trimmed.includes("|");
};

const canonicalizeNoteMarkdownGfmTableSeparatorLine = (line: string): string => {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => {
      const trimmed = cell.trim();
      const left = trimmed.startsWith(":");
      const right = trimmed.endsWith(":");
      if (left && right) return ":---:";
      if (right) return "---:";
      if (left) return ":---";
      return "---";
    });
  return `| ${cells.join(" | ")} |`;
};

const canonicalizeNoteMarkdownGfmTableDataRowLine = (line: string): string => {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  return `| ${cells.join(" | ")} |`;
};

/**
 * Canonicalize a GFM pipe table block (header + separator + body) so optional
 * outer pipes and separator dash runs match MDXEditor's serializer form.
 */
const normalizeNoteMarkdownGfmTableRows = (text: string): string => {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    const separator = lines[i + 1];
    if (
      separator !== undefined
      && isNoteMarkdownGfmTableDataRowLine(header)
      && isNoteMarkdownGfmTableSeparatorLine(separator)
    ) {
      out.push(canonicalizeNoteMarkdownGfmTableDataRowLine(header));
      out.push(canonicalizeNoteMarkdownGfmTableSeparatorLine(separator));
      i += 2;
      while (i < lines.length && isNoteMarkdownGfmTableDataRowLine(lines[i] ?? "")) {
        out.push(canonicalizeNoteMarkdownGfmTableDataRowLine(lines[i] ?? ""));
        i += 1;
      }
      continue;
    }
    out.push(header);
    i += 1;
  }
  return out.join("\n");
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
    // Thematic breaks: --- / ___ / * * * → *** (same marker only; mixed `-_*`
    // is not a thematic break and must stay inequivalent to a real rule).
    next = next.replace(
      /^ {0,3}(?:(?:-[ \t]*){2,}-|(?:_[ \t]*){2,}_|(?:\*[ \t]*){2,}\*)[ \t]*$/gm,
      "***",
    );
    // Unordered / task-list markers: MDXEditor defaults to `*`, serializer uses `-`.
    // Require trailing whitespace so `*Hi*` / `***` stay untouched.
    next = next.replace(/^(\s*)[-+*](\s+)/gm, "$1-$2");
    // GFM tables: optional outer pipes + separator dash runs → serializer form
    // (`A | B` / `--- | ---` → `| A | B |` / `| --- | --- |`).
    next = normalizeNoteMarkdownGfmTableRows(next);
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
  const selectedMarkdown = input.selectedMarkdown?.replace(/\r\n?/g, "\n") ?? null;
  const beforeNorm = normalizeNoteMarkdownForEquivalence(before);
  const clipboardNorm = normalizeNoteMarkdownForEquivalence(clipboard);
  // Clipboard equals the document: Select All identical replace stays suppressed,
  // but a partial selection must still recover if insertMarkdown no-ops.
  if (clipboardNorm === beforeNorm) {
    const selected = input.selectedText?.replace(/\r\n?/g, "\n") ?? null;
    const beforePlain = noteMarkdownClipboardToPlainText(beforeNorm);
    const selectedMarkdownNorm = selectedMarkdown !== null
      ? normalizeNoteMarkdownForEquivalence(selectedMarkdown)
      : null;
    // Prefer selection markdown: stripping `# Hello` also yields plain `Hello`,
    // so wholeDocByPlain must not override evidence that only `Hello` was selected.
    if (selectedMarkdownNorm !== null && selectedMarkdownNorm !== beforeNorm) {
      return true;
    }
    if (selectedMarkdownNorm !== null && selectedMarkdownNorm === beforeNorm) {
      return false;
    }
    const wholeDocByPlain = selected !== null
      && (selected === before || selected === beforePlain);
    if (wholeDocByPlain) return false;
    const partialPlain = selected !== null
      && selected !== before
      && selected !== beforePlain;
    if (partialPlain) return true;
    return false;
  }
  // Selection-scoped markdown match is sufficient to suppress recovery for
  // identical replaces (including Lexical node selections with empty plain text).
  if (
    selectedMarkdown !== null
    && normalizeNoteMarkdownForEquivalence(selectedMarkdown) === clipboardNorm
  ) {
    return false;
  }
  if (input.selectedText !== null) {
    const selected = input.selectedText.replace(/\r\n?/g, "\n");
    // Normalize first so table separators / thematic-break spellings project
    // to the same plain form as selection-scoped markdown evidence.
    const clipboardPlain = noteMarkdownClipboardToPlainText(clipboardNorm);
    // Exact plain clipboard match (no markdown markers to apply). Do not use
    // selected===clipboard alone: selecting literal punctuation rendered from
    // `\*\*Hello\*\*` yields selected `**Hello**`, which equals clipboard
    // `**Hello**` as strings even though selection markdown differs and the
    // paste still needs recovery after a lost-selection insert no-op.
    if (selected === clipboard && clipboard === clipboardPlain) return false;
  }
  return true;
};

/**
 * True when insertMarkdown (or an equivalent in-editor replace) already applied
 * the clipboard to the document. Used so concurrent draft/editor updates are
 * not mistaken for paste success, and so identical node replaces can be
 * distinguished from lost-selection no-ops.
 */
export const didNoteMarkdownPasteApply = (input: {
  beforeMarkdown: string;
  afterMarkdown: string;
  clipboardText: string;
  selectedText: string | null;
  selectedMarkdown?: string | null;
}): boolean => {
  const before = input.beforeMarkdown.replace(/\r\n?/g, "\n");
  const after = input.afterMarkdown.replace(/\r\n?/g, "\n");
  if (after === before) return false;

  const beforeNorm = normalizeNoteMarkdownForEquivalence(before);
  const afterNorm = normalizeNoteMarkdownForEquivalence(after);
  const clipboardNorm = normalizeNoteMarkdownForEquivalence(
    input.clipboardText.replace(/\r\n?/g, "\n"),
  );
  if (!clipboardNorm) return afterNorm !== beforeNorm;

  // Select-all style replace.
  if (afterNorm === clipboardNorm) return true;

  const selectedMarkdown = input.selectedMarkdown?.replace(/\r\n?/g, "\n") ?? null;
  if (selectedMarkdown !== null && selectedMarkdown.length > 0) {
    const selectedNorm = normalizeNoteMarkdownForEquivalence(selectedMarkdown);
    // Walk every occurrence: the selection may be the 2nd/3rd match of the same
    // fragment (`**old**` … `**old**`), and first-index replacement would miss.
    let searchFrom = 0;
    while (searchFrom <= beforeNorm.length) {
      const index = beforeNorm.indexOf(selectedNorm, searchFrom);
      if (index === -1) break;
      const expected = `${beforeNorm.slice(0, index)}${clipboardNorm}${beforeNorm.slice(index + selectedNorm.length)}`;
      if (afterNorm === expected) return true;
      searchFrom = index + 1;
    }
  }

  // Collapsed caret: walk every insert index so a successful in-place paste
  // still counts when the clipboard fragment already existed elsewhere
  // (`A **x** B` + paste `**x**` → `A **x** **x** B`).
  const caretSelection = selectedMarkdown === null || selectedMarkdown.length === 0;
  if (caretSelection) {
    for (let index = 0; index <= beforeNorm.length; index += 1) {
      const expected = `${beforeNorm.slice(0, index)}${clipboardNorm}${beforeNorm.slice(index)}`;
      if (afterNorm === expected) return true;
    }
  }

  // Caret / append insert: clipboard fragment became present.
  if (!beforeNorm.includes(clipboardNorm) && afterNorm.includes(clipboardNorm)) {
    return true;
  }

  return afterNorm === normalizeNoteMarkdownForEquivalence(
    mergeNoteMarkdownDocumentPaste(before, input.clipboardText),
  );
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
