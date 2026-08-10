/**
 * UI re-export of note clipboard paste policy.
 * Implementation lives in domain/notes/clipboardPaste.ts (pure, no React).
 */
export {
  type NoteClipboardPasteKind,
  type NoteClipboardPastePayload,
  shouldInsertClipboardTextAsMarkdown,
  looksLikeClipboardHtml,
  plainMarkdownContainsHtml,
  isPrimarilyHtmlDocument,
  isCenteredBlockElement,
  htmlOpenTagIsCentered,
  wrapCenteredMarkdown,
  decodeHtmlEntities,
  normalizeImageSrc,
  normalizeNotePublicAssetPaths,
  serializeSafeHtmlImage,
  trimBlankLinesOutsideCode,
  findHtmlTagEnd,
  convertHtmlImgTagToMarkdownOrHtml,
  normalizeLinkedBadgeImages,
  maskCodeRegions,
  unmaskCodeRegions,
  normalizePastedNoteMarkdown,
  convertClipboardHtmlToMarkdown,
  extractBalancedHtmlElement,
  convertHtmlIslandsInMarkdown,
  resolveNoteClipboardPaste,
  shouldInterceptResolvedNotePaste,
} from "../../domain/notes/clipboardPaste";
