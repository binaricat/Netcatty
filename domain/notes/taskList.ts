/**
 * GFM task-list helpers for note markdown.
 * Lexical CheckListPlugin only toggles when the editor is editable; preview mode
 * reuses these pure transforms so checkboxes stay clickable.
 */

import { maskCodeRegions, unmaskCodeRegions } from "./clipboardPaste";

/**
 * Matches "- [ ]", "* [x]", "1. [X]", "1) [ ]", and optional blockquote
 * prefixes (`> - [ ]`) at line start. Code regions and HTML comments are
 * masked before matching so they never steal a DOM checkbox index.
 */
// Require whitespace (or EOL) after `]` so `- [ ]foo` is not treated as a task.
const TASK_LIST_ITEM_PATTERN =
  "^([ \\t]*(?:>[ \\t]*)*(?:[-*+]|\\d+[.)])[ \\t]+)\\[([ xX])\\](?=\\s|$)";

const createTaskListItemRe = (): RegExp => new RegExp(TASK_LIST_ITEM_PATTERN, "gm");

const escapeRegExp = (value: string): string => (
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
);

/** Mask HTML comments with a unique sentinel so task indices skip them. */
const maskHtmlComments = (markdown: string): {
  text: string;
  slots: string[];
  sentinel: string;
} => {
  let n = 0;
  let sentinel = "@@NETCATTY_MD_COMMENT_";
  while (markdown.includes(sentinel)) {
    n += 1;
    sentinel = `@@NETCATTY_MD_COMMENT_S${n}_`;
  }
  const slots: string[] = [];
  const text = markdown.replace(/<!--[\s\S]*?-->/g, (chunk) => {
    const token = `${sentinel}${slots.length}@@`;
    slots.push(chunk);
    return token;
  });
  return { text, slots, sentinel };
};

const unmaskHtmlComments = (
  text: string,
  slots: string[],
  sentinel: string,
): string => {
  const re = new RegExp(`${escapeRegExp(sentinel)}(\\d+)@@`, "g");
  return text.replace(re, (_, idx: string) => slots[Number(idx)] ?? "");
};

/** Prepare markdown for task scanning: code regions then HTML comments. */
const prepareTaskScanText = (markdown: string): {
  text: string;
  restore: (body: string) => string;
} => {
  const codeMask = maskCodeRegions(markdown);
  const commentMask = maskHtmlComments(codeMask.text);
  return {
    text: commentMask.text,
    restore: (body: string) => {
      const withComments = unmaskHtmlComments(
        body,
        commentMask.slots,
        commentMask.sentinel,
      );
      return unmaskCodeRegions(withComments, codeMask.slots, codeMask.sentinel);
    },
  };
};

export const countTaskListItems = (markdown: string): number => {
  const { text } = prepareTaskScanText(markdown);
  return text.match(createTaskListItemRe())?.length ?? 0;
};

/**
 * Toggle the Nth GFM task checkbox (0-based order among rendered tasks:
 * outside fenced/indented/inline code and HTML comments). Returns the original
 * string when the index is out of range.
 */
export const toggleTaskListItemAtIndex = (markdown: string, index: number): string => {
  if (index < 0 || !Number.isFinite(index)) return markdown;

  const { text, restore } = prepareTaskScanText(markdown);
  let seen = 0;
  let changed = false;
  const next = text.replace(createTaskListItemRe(), (full, prefix: string, mark: string) => {
    if (seen++ !== index) return full;
    changed = true;
    const nextMark = mark === " " ? "x" : " ";
    return `${prefix}[${nextMark}]`;
  });

  return changed ? restore(next) : markdown;
};

/** Left-edge hit box for checklist toggles (checkbox + padding), in CSS px. */
export const NOTE_TASK_CHECKBOX_HIT_PX = 28;

export const isPointerOnTaskCheckbox = (
  listItemRect: Pick<DOMRect, "left" | "right">,
  clientX: number,
  hitPx: number = NOTE_TASK_CHECKBOX_HIT_PX,
): boolean => clientX >= listItemRect.left && clientX <= listItemRect.left + hitPx;
