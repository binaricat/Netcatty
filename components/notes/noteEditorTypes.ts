import type { MarkdownActionType, NoteHeadingItem } from "../../domain/notes";

export interface InlineMarkdownEditorHandle {
  executeAction: (action: MarkdownActionType) => void;
  focus: () => void;
  scrollToHeading: (heading: NoteHeadingItem, headingIndex: number) => boolean;
}

export type NoteEditorMode = "edit" | "preview" | "source" | "live";

/** Active text-format toggles at the current selection (toolbar highlight). */
export type ActiveTextFormats = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  code: boolean;
};

export const EMPTY_ACTIVE_FORMATS: ActiveTextFormats = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  code: false,
};
