import { Prec } from "@codemirror/state";
import { EditorView, tooltips } from "@codemirror/view";

export const createNoteCodeTooltipExtensions = (parent: HTMLElement | undefined) => [
  // Code blocks and their enclosing note panes can clip editor descendants.
  Prec.highest(tooltips({ parent })),
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
