import { Prec } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";

export interface NoteTooltipSpace {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** True when the element clips horizontally overflowing descendants. */
const clipsHorizontally = (style: CSSStyleDeclaration): boolean =>
  style.overflowX !== "visible";

/** True when the element clips vertically overflowing descendants. Paint
 *  containment (strict/content/paint) also clips and captures fixed
 *  descendants even when overflow is visible. */
const clipsVertically = (style: CSSStyleDeclaration): boolean =>
  style.overflowY !== "visible" ||
  /(^|\s)(strict|content|paint)(\s|$)/.test(style.contain || "");

/**
 * Viewport-space bounds CodeMirror may place note tooltips in: the owning
 * notes region (`boundsRoot`) shrunk by every clipping ancestor (terminal
 * side-panel pane hosts, ScrollArea viewports). Tooltips are mounted on
 * `document.body` so they escape clipped code blocks; bounding their space
 * to the notes pane keeps a completion from rendering over an adjacent
 * split pane. Without a mounted `boundsRoot`, falls back to the window
 * bounds CodeMirror would use by default.
 */
export const getNoteTooltipSpace = (
  boundsRoot: HTMLElement | null | undefined,
  doc: Document,
): NoteTooltipSpace => {
  if (!boundsRoot || !boundsRoot.isConnected) {
    const docElt = doc.documentElement;
    return { top: 0, left: 0, right: docElt.clientWidth, bottom: docElt.clientHeight };
  }
  const rootRect = boundsRoot.getBoundingClientRect();
  let space: NoteTooltipSpace = {
    top: rootRect.top,
    left: rootRect.left,
    right: rootRect.right,
    bottom: rootRect.bottom,
  };
  const defaultView = boundsRoot.ownerDocument.defaultView;
  if (!defaultView) return space;
  for (let node: Element | null = boundsRoot; node; node = node.parentElement) {
    const style = defaultView.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (clipsHorizontally(style)) {
      space = {
        ...space,
        left: Math.max(space.left, rect.left),
        right: Math.min(space.right, rect.right),
      };
    }
    if (clipsVertically(style)) {
      space = {
        ...space,
        top: Math.max(space.top, rect.top),
        bottom: Math.min(space.bottom, rect.bottom),
      };
    }
  }
  return space;
};

export const createNoteCodeTooltipExtensions = (
  parent: HTMLElement | undefined,
  getBoundsRoot?: () => HTMLElement | null,
) => [
  // Code blocks and their enclosing note panes can clip editor descendants.
  Prec.highest(
    tooltips({
      parent,
      // Tooltips escape those clips via the global parent, so constrain their
      // placement to the owning notes pane instead of the whole window.
      tooltipSpace: getBoundsRoot
        ? (view: EditorView) => getNoteTooltipSpace(getBoundsRoot(), view.dom.ownerDocument)
        : undefined,
    }),
  ),
  // CodeMirror carries this theme's scope onto its detached tooltip container.
  // Keep these rules local to Notes and use the application's existing colors.
  Prec.highest(EditorView.theme({
    ".cm-tooltip": {
      backgroundColor: "hsl(var(--popover))",
      color: "hsl(var(--popover-foreground))",
      border: "1px solid hsl(var(--border))",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "hsl(var(--accent))",
      color: "hsl(var(--accent-foreground))",
    },
  })),
];
