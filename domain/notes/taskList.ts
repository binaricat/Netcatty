/**
 * GFM task-list helpers for note markdown.
 * Lexical CheckListPlugin only toggles when the editor is editable; preview mode
 * reuses these pure transforms so checkboxes stay clickable.
 */

import { maskCodeRegions, unmaskCodeRegions } from "./clipboardPaste";

/**
 * Matches "- [ ]", "* [x]", "1. [X]", "1) [ ]", and optional blockquote
 * prefixes (`> - [ ]`) at line start. Code regions are masked before matching
 * so fence contents never steal a DOM checkbox index.
 */
// Require whitespace (or EOL) after `]` so `- [ ]foo` is not treated as a task.
const TASK_LIST_ITEM_PATTERN =
  "^([ \\t]*(?:>[ \\t]*)*(?:[-*+]|\\d+[.)])[ \\t]+)\\[([ xX])\\](?=\\s|$)";

const createTaskListItemRe = (): RegExp => new RegExp(TASK_LIST_ITEM_PATTERN, "gm");

export const countTaskListItems = (markdown: string): number => {
  const { text } = maskCodeRegions(markdown);
  return text.match(createTaskListItemRe())?.length ?? 0;
};

/**
 * Toggle the Nth GFM task checkbox (0-based order among rendered tasks:
 * outside fenced/indented/inline code). Returns the original string when the
 * index is out of range.
 */
export const toggleTaskListItemAtIndex = (markdown: string, index: number): string => {
  if (index < 0 || !Number.isFinite(index)) return markdown;

  const { text, slots, sentinel } = maskCodeRegions(markdown);
  let seen = 0;
  let changed = false;
  const next = text.replace(createTaskListItemRe(), (full, prefix: string, mark: string) => {
    if (seen++ !== index) return full;
    changed = true;
    const nextMark = mark === " " ? "x" : " ";
    return `${prefix}[${nextMark}]`;
  });

  return changed ? unmaskCodeRegions(next, slots, sentinel) : markdown;
};

/** Left-edge hit box for checklist toggles (checkbox + padding), in CSS px. */
export const NOTE_TASK_CHECKBOX_HIT_PX = 28;

export const isPointerOnTaskCheckbox = (
  listItemRect: Pick<DOMRect, "left" | "right">,
  clientX: number,
  hitPx: number = NOTE_TASK_CHECKBOX_HIT_PX,
): boolean => clientX >= listItemRect.left && clientX <= listItemRect.left + hitPx;
