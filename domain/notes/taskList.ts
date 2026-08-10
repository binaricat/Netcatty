/**
 * GFM task-list helpers for note markdown.
 * Lexical CheckListPlugin only toggles when the editor is editable; preview mode
 * reuses these pure transforms so checkboxes stay clickable.
 */

/** Matches "- [ ]", "* [x]", "1. [X]" etc. at line start (indent allowed). */
const TASK_LIST_ITEM_PATTERN = "^([ \\t]*(?:[-*+]|\\d+\\.)[ \\t]+)\\[([ xX])\\]";

const createTaskListItemRe = (): RegExp => new RegExp(TASK_LIST_ITEM_PATTERN, "gm");

export const countTaskListItems = (markdown: string): number => {
  const matches = markdown.match(createTaskListItemRe());
  return matches?.length ?? 0;
};

/**
 * Toggle the Nth GFM task checkbox (0-based document order).
 * Returns the original string when the index is out of range.
 */
export const toggleTaskListItemAtIndex = (markdown: string, index: number): string => {
  if (index < 0 || !Number.isFinite(index)) return markdown;

  let seen = 0;
  let changed = false;
  const next = markdown.replace(createTaskListItemRe(), (full, prefix: string, mark: string) => {
    if (seen++ !== index) return full;
    changed = true;
    const nextMark = mark === " " ? "x" : " ";
    return `${prefix}[${nextMark}]`;
  });

  return changed ? next : markdown;
};

/** Left-edge hit box for checklist toggles (checkbox + padding), in CSS px. */
export const NOTE_TASK_CHECKBOX_HIT_PX = 28;

export const isPointerOnTaskCheckbox = (
  listItemRect: Pick<DOMRect, "left" | "right">,
  clientX: number,
  hitPx: number = NOTE_TASK_CHECKBOX_HIT_PX,
): boolean => clientX >= listItemRect.left && clientX <= listItemRect.left + hitPx;
