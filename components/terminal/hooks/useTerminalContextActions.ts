import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback } from "react";
import type { RefObject } from "react";
import { logger } from "../../../lib/logger";
import { pasteTextIntoTerminal } from "../runtime/terminalUserPaste";
import { clearTerminalViewport } from "../clearTerminalViewport";

export const useTerminalContextActions = ({
  termRef,
  sessionRef,
  onHasSelectionChange,
  scrollOnPasteRef,
}: {
  termRef: RefObject<XTerm | null>;
  sessionRef: RefObject<string | null>;
  onHasSelectionChange?: (hasSelection: boolean) => void;
  scrollOnPasteRef?: RefObject<boolean>;
}) => {
  const onCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
    }
  }, [termRef]);

  const onPaste = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text && sessionRef.current) {
        pasteTextIntoTerminal(term, text, {
          scrollOnPaste: scrollOnPasteRef?.current ?? false,
        });
      }
    } catch (err) {
      logger.warn("Failed to paste from clipboard", err);
    }
  }, [sessionRef, termRef, scrollOnPasteRef]);

  const onPasteSelection = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (!selection || !sessionRef.current) return;
    pasteTextIntoTerminal(term, selection, {
      scrollOnPaste: scrollOnPasteRef?.current ?? false,
    });
  }, [sessionRef, termRef, scrollOnPasteRef]);

  const onSelectAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    onHasSelectionChange?.(true);
  }, [onHasSelectionChange, termRef]);

  const onClear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    clearTerminalViewport(term);
  }, [termRef]);

  const onSelectWord = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    onHasSelectionChange?.(true);
  }, [onHasSelectionChange, termRef]);

  return { onCopy, onPaste, onPasteSelection, onSelectAll, onClear, onSelectWord };
};
