import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback } from "react";
import type { RefObject } from "react";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { pasteTextIntoTerminal } from "../runtime/terminalUserPaste";
import { clearTerminalViewport } from "../clearTerminalViewport";
import {
  handleRemoteClipboardImageUpload,
  type RemoteClipboardImageUploadResult,
} from "../clipboardImagePaste";
import { handleTerminalClipboardPaste } from "../terminalClipboardPaste";

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
  supportsRemoteImagePaste,
  terminalBackend,
  getRemoteCwd,
  scrollToBottomAfterProgrammaticInput,
  onClipboardImageUploadResult,
}: {
  termRef: RefObject<XTerm | null>;
  sourceSessionId: string;
  sessionRef: RefObject<string | null>;
  onHasSelectionChange?: (hasSelection: boolean) => void;
  scrollOnPasteRef?: RefObject<boolean>;
  isBroadcastEnabledRef?: RefObject<boolean | undefined>;
  onBroadcastInputRef?: RefObject<((data: string, sourceSessionId: string) => void) | undefined>;
  isLocalConnection: boolean;
  supportsRemoteImagePaste: boolean;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
  getRemoteCwd?: () => Promise<string | null | undefined>;
  scrollToBottomAfterProgrammaticInput?: (data: string) => void;
  onClipboardImageUploadResult?: (result: RemoteClipboardImageUploadResult) => void;
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
      const bridge = netcattyBridge.get();
      await handleTerminalClipboardPaste({
        bridge,
        isLocalConnection,
        readClipboardText: () => navigator.clipboard.readText(),
        scrollOnPaste: scrollOnPasteRef?.current ?? false,
        onPasteData: broadcastUserPasteData,
        sessionId: sessionRef.current,
        terminalBackend,
        term,
      });
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

  const onUploadClipboardImage = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    try {
      const bridge = netcattyBridge.get();
      const result = await handleRemoteClipboardImageUpload({
        bridge,
        getRemoteCwd: getRemoteCwd ?? (async () => undefined),
        sessionId: supportsRemoteImagePaste ? sessionRef.current : null,
        terminalBackend,
        term,
        scrollToBottomAfterProgrammaticInput,
      });
      onClipboardImageUploadResult?.(result);
    } catch (err) {
      logger.warn("Failed to upload clipboard image", err);
      onClipboardImageUploadResult?.({ ok: false, reason: "upload-failed" });
    }
  }, [
    getRemoteCwd,
    onClipboardImageUploadResult,
    scrollToBottomAfterProgrammaticInput,
    sessionRef,
    supportsRemoteImagePaste,
    termRef,
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

  return {
    onCopy,
    onPaste,
    onUploadClipboardImage: supportsRemoteImagePaste ? onUploadClipboardImage : undefined,
    onPasteSelection,
    onSelectAll,
    onClear,
    onSelectWord,
  };
};
