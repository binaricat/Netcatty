import type { PointerEvent as ReactPointerEvent } from "react";

export type PrimaryOnlyDragEventRoot = Pick<
  EventTarget,
  "addEventListener" | "removeEventListener"
>;

export const isNonPrimaryPointer = (event: { button?: number; buttons?: number }): boolean =>
  event.button === 2
  || event.buttons === 2
  || (typeof event.button === "number" && event.button !== 0);

const pendingRestore = new WeakMap<HTMLElement, () => void>();

export function restorePrimaryOnlyDrag(target: HTMLElement, enabled: boolean): void {
  const restore = pendingRestore.get(target);
  if (restore) {
    restore();
    return;
  }
  target.draggable = enabled;
}

export function armPrimaryOnlyDragRestore(
  target: HTMLElement,
  enabled: boolean,
  root: PrimaryOnlyDragEventRoot = window,
): void {
  pendingRestore.get(target)?.();
  const restore = () => {
    target.draggable = enabled;
    root.removeEventListener("pointerup", restore, true);
    root.removeEventListener("pointercancel", restore, true);
    if (pendingRestore.get(target) === restore) pendingRestore.delete(target);
  };
  pendingRestore.set(target, restore);
  root.addEventListener("pointerup", restore, true);
  root.addEventListener("pointercancel", restore, true);
}

export function primaryOnlyDragHandlers(
  enabled: boolean,
  root?: PrimaryOnlyDragEventRoot,
) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button === 0) return;
      event.currentTarget.draggable = false;
      armPrimaryOnlyDragRestore(event.currentTarget, enabled, root ?? window);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      restorePrimaryOnlyDrag(event.currentTarget, enabled);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      restorePrimaryOnlyDrag(event.currentTarget, enabled);
    },
  };
}
