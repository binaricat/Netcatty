type FocusTargetLike = {
  tagName?: string | null;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  getAttribute?: (name: string) => string | null;
};

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]';
const NATIVE_POINTER_SELECTOR = `${EDITABLE_SELECTOR}, [data-terminal-detach-drag-handle="true"]`;

/**
 * The terminal's top overlay sits above the xterm textarea. Pointer clicks on
 * that layer should usually keep focus in the terminal so typing can continue.
 * Only allow native focus changes for genuinely editable controls.
 */
export const shouldPreserveTerminalFocusOnMouseDown = (target: EventTarget | null): boolean => {
  if (!target || typeof target !== "object") return true;

  const candidate = target as FocusTargetLike;
  const tagName = typeof candidate.tagName === "string"
    ? candidate.tagName.toUpperCase()
    : "";

  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return false;
  }

  if (candidate.isContentEditable) {
    return false;
  }

  if (typeof candidate.getAttribute === "function") {
    const contentEditable = candidate.getAttribute("contenteditable");
    const role = candidate.getAttribute("role");
    const detachDragHandle = candidate.getAttribute("data-terminal-detach-drag-handle");
    if (contentEditable === "" || contentEditable === "true" || role === "textbox") {
      return false;
    }
    if (detachDragHandle === "true") {
      return false;
    }
  }

  if (typeof candidate.closest === "function" && candidate.closest(NATIVE_POINTER_SELECTOR)) {
    return false;
  }

  return true;
};
