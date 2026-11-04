import type { SplitHint } from './TerminalLayerSupport';

/**
 * Value equality for workspace drop hints. dragover fires at pointer rate and
 * computeSplitHint always returns a fresh object, so comparing by value keeps
 * the workspace from re-rendering until the preview actually moves.
 */
export function isSameSplitHint(left: SplitHint, right: SplitHint): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.direction === right.direction
    && left.position === right.position
    && left.targetSessionId === right.targetSessionId
    && left.rect?.x === right.rect?.x
    && left.rect?.y === right.rect?.y
    && left.rect?.w === right.rect?.w
    && left.rect?.h === right.rect?.h;
}
