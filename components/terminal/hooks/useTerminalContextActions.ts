import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback } from "react";
import type { RefObject } from "react";
import { logger } from "../../../lib/logger";
import { pasteTextIntoTerminal } from "../runtime/terminalUserPaste";
import { clearTerminalViewport } from "../clearTerminalViewport";
import { extractRootPathsFromClipboardFiles } from "../terminalHelpers";

type BroadcastPasteRefs = {
  sourceSessionId: string;
  sessionRef: RefObject<string | null>;
  isBroadcastEnabledRef?: RefObject<boolean | undefined>;
  onBroadcastInputRef?: RefObject<((data: string, sourceSessionId: string) => void) | undefined>;
};

export const broadcastTerminalPasteData = (
  data: string,
  { sourceSessionId, sessionRef, isBroadcastEnabledRef, onBroadcastInputRef }: BroadcastPasteRefs,
): boolean => {
  if (sessionRef.current && isBroadcastEnabledRef?.current && onBroadcastInputRef?.current) {
    onBroadcastInputRef.current(data, sourceSessionId);
    return true;
  }
  return false;
};

export const useTerminalContextActions = ({
  termRef,
  sourceSessionId,
  sessionRef,
  onHasSelectionChange,
  scrollOnPasteRef,
  isBroadcastEnabledRef,
  onBroadcastInputRef,
  isLocalConnection,
  terminalBackend,
}: {
  termRef: RefObject<XTerm | null>;
  sourceSessionId: string;
  sessionRef: RefObject<string | null>;
  onHasSelectionChange?: (hasSelection: boolean) => void;
  scrollOnPasteRef?: RefObject<boolean>;
  isBroadcastEnabledRef?: RefObject<boolean | undefined>;
  onBroadcastInputRef?: RefObject<((data: string, sourceSessionId: string) => void) | undefined>;
  isLocalConnection: boolean;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
}) => {
  const broadcastUserPasteData = useCallback((data: string) => {
    return broadcastTerminalPasteData(data, {
      sourceSessionId,
      sessionRef,
      isBroadcastEnabledRef,
      onBroadcastInputRef,
    });
  }, [isBroadcastEnabledRef, onBroadcastInputRef, sessionRef, sourceSessionId]);

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
      const readClipboardFiles = window.netcatty?.readClipboardFiles;
      if (readClipboardFiles) {
        const files = await readClipboardFiles();
        if (files.length > 0 && isLocalConnection && sessionRef.current) {
          const paths = extractRootPathsFromClipboardFiles(files);
          if (paths.length > 0) {
            terminalBackend.writeToSession(sessionRef.current, paths.join(" "));
            term.focus();
            return;
          }
        }
      }

      const text = await navigator.clipboard.readText();
      if (text && sessionRef.current) {
        pasteTextIntoTerminal(term, text, {
          scrollOnPaste: scrollOnPasteRef?.current ?? false,
          onPasteData: broadcastUserPasteData,
        });
      }
    } catch (err) {
      logger.warn("Failed to paste from clipboard", err);
    }
  }, [
    broadcastUserPasteData,
    isLocalConnection,
    sessionRef,
    termRef,
    scrollOnPasteRef,
    terminalBackend,
  ]);

  const onPasteSelection = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const selection = term.getSelection();
    if (!selection || !sessionRef.current) return;
    pasteTextIntoTerminal(term, selection, {
      scrollOnPaste: scrollOnPasteRef?.current ?? false,
      onPasteData: broadcastUserPasteData,
    });
  }, [broadcastUserPasteData, sessionRef, termRef, scrollOnPasteRef]);

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
