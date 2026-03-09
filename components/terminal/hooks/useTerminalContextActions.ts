import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback } from "react";
import type { RefObject } from "react";
import { logger } from "../../../lib/logger";
import { normalizeLineEndings, wrapBracketedPaste } from "../../../lib/utils";

type TerminalBackendWriteApi = {
  writeToSession: (sessionId: string, data: string) => void;
};

export const useTerminalContextActions = ({
  termRef,
  sessionRef,
  terminalBackend,
  onHasSelectionChange,
  disableBracketedPasteRef,
  scrollOnPasteRef,
}: {
  termRef: RefObject<XTerm | null>;
  sessionRef: RefObject<string | null>;
  terminalBackend: TerminalBackendWriteApi;
  onHasSelectionChange?: (hasSelection: boolean) => void;
  disableBracketedPasteRef?: RefObject<boolean>;
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
        let data = normalizeLineEndings(text);
        if (term.modes.bracketedPasteMode && !disableBracketedPasteRef?.current) data = wrapBracketedPaste(data);
        terminalBackend.writeToSession(sessionRef.current, data);
        if (scrollOnPasteRef?.current) {
          term.scrollToBottom();
        }
      }
    } catch (err) {
      logger.warn("Failed to paste from clipboard", err);
    }
  }, [sessionRef, termRef, terminalBackend, disableBracketedPasteRef, scrollOnPasteRef]);

  const onSelectAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    onHasSelectionChange?.(true);
  }, [onHasSelectionChange, termRef]);

  const onClear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.clear();
  }, [termRef]);

  const onSelectWord = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    term.selectAll();
    onHasSelectionChange?.(true);
  }, [onHasSelectionChange, termRef]);

  return { onCopy, onPaste, onSelectAll, onClear, onSelectWord };
};
