import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback } from "react";
import type { RefObject } from "react";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import { pasteTextIntoTerminal } from "../runtime/terminalUserPaste";
import { clearTerminalViewportAndSyncPty } from "../clearTerminalViewport";
import {
  handleRemoteClipboardImageUpload,
  type RemoteClipboardImageUploadResult,
} from "../clipboardImagePaste";
import { handleTerminalClipboardPaste } from "../terminalClipboardPaste";
import { pulseCopyOnSelectUserCommand } from "../copyOnSelect";
import { getTerminalSelectionForClipboard } from "../normalizeTerminalSelection";
import {
  getHistoryPreviewSelectionFromRoot,
  requestHistoryPreviewHide,
  selectHistoryPreviewAll,
  findHistoryPreviewOverlay,
} from "../runtime/terminalHistoryScrollOverride";

type BroadcastPasteRefs = {
  sourceSessionId: string;
  sessionRef: RefObject<string | null>;
  isBroadcastEnabledRef?: RefObject<boolean | undefined>;
  onBroadcastInputRef?: RefObject<((data: string, sourceSessionId: string) => void) | undefined>;
  passwordPromptActiveRef?: RefObject<boolean | undefined>;
};

export const broadcastTerminalPasteData = (
  data: string,
  {
    sourceSessionId,
    sessionRef,
    isBroadcastEnabledRef,
    onBroadcastInputRef,
    passwordPromptActiveRef,
  }: BroadcastPasteRefs,
): boolean => {
  if (
    passwordPromptActiveRef?.current !== true
    && sessionRef.current
    && isBroadcastEnabledRef?.current
    && onBroadcastInputRef?.current
  ) {
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
  passwordPromptActiveRef,
  isLocalConnection,
  supportsRemoteImagePaste,
  autoUploadClipboardImageOnPasteRef,
  clearWipesScrollbackRef,
  normalizeTextOnCopyRef,
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
  passwordPromptActiveRef?: RefObject<boolean | undefined>;
  isLocalConnection: boolean;
  supportsRemoteImagePaste: boolean;
  /** When true, paste auto-uploads a clipboard image (remote sessions only). */
  autoUploadClipboardImageOnPasteRef?: RefObject<boolean | undefined>;
  clearWipesScrollbackRef?: RefObject<boolean | undefined>;
  /** When false, copy uses raw getSelection(). Default true when unset. */
  normalizeTextOnCopyRef?: RefObject<boolean | undefined>;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
    clearSessionPtyBuffer?: (sessionId: string) => void;
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
      passwordPromptActiveRef,
    });
  }, [isBroadcastEnabledRef, onBroadcastInputRef, passwordPromptActiveRef, sessionRef, sourceSessionId]);

  const onCopy = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const selection = getHistoryPreviewSelectionFromRoot(term.element?.parentElement)
      || getTerminalSelectionForClipboard(
        term,
        normalizeTextOnCopyRef?.current ?? true,
      );
    if (selection) {
      navigator.clipboard.writeText(selection);
    }
  }, [normalizeTextOnCopyRef, termRef]);

  const onPaste = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    requestHistoryPreviewHide(term.element?.parentElement);
    term.focus();
    try {
      const bridge = netcattyBridge.get();
      await handleTerminalClipboardPaste({
        bridge,
        autoUploadClipboardImage:
          supportsRemoteImagePaste && autoUploadClipboardImageOnPasteRef?.current === true,
        clipboardImageBridge: bridge ?? undefined,
        getRemoteCwd,
        isLocalConnection,
        isSensitiveInput: () => passwordPromptActiveRef?.current === true,
        onClipboardImageUploadResult,
        readClipboardText: () => navigator.clipboard.readText(),
        scrollOnPaste: scrollOnPasteRef?.current ?? false,
        onPasteData: broadcastUserPasteData,
        sessionId: sessionRef.current,
        scrollToBottomAfterProgrammaticInput,
        terminalBackend,
        term,
      });
    } catch (err) {
      logger.warn("Failed to paste from clipboard", err);
    }
  }, [
    autoUploadClipboardImageOnPasteRef,
    broadcastUserPasteData,
    getRemoteCwd,
    isLocalConnection,
    onClipboardImageUploadResult,
    passwordPromptActiveRef,
    sessionRef,
    supportsRemoteImagePaste,
    termRef,
    scrollOnPasteRef,
    scrollToBottomAfterProgrammaticInput,
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
        isSensitiveInput: () => passwordPromptActiveRef?.current === true,
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
    passwordPromptActiveRef,
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
    const selection = getHistoryPreviewSelectionFromRoot(term.element?.parentElement)
      || getTerminalSelectionForClipboard(
        term,
        normalizeTextOnCopyRef?.current ?? true,
      );
    if (!selection || !sessionRef.current) return;
    requestHistoryPreviewHide(term.element?.parentElement);
    term.focus();
    pasteTextIntoTerminal(term, selection, {
      scrollOnPaste: scrollOnPasteRef?.current ?? false,
      onPasteData: broadcastUserPasteData,
    });
  }, [broadcastUserPasteData, normalizeTextOnCopyRef, sessionRef, termRef, scrollOnPasteRef]);

  const onSelectAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    pulseCopyOnSelectUserCommand(term);
    const previewOverlay = findHistoryPreviewOverlay(term.element?.parentElement);
    if (previewOverlay && selectHistoryPreviewAll(previewOverlay)) {
      onHasSelectionChange?.(true);
      return;
    }
    term.selectAll();
    onHasSelectionChange?.(true);
  }, [onHasSelectionChange, termRef]);

  const onClear = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    clearTerminalViewportAndSyncPty(term, {
      wipeScrollback: clearWipesScrollbackRef?.current ?? true,
      syncPty: () => {
        const id = sessionRef.current;
        if (id) {
          terminalBackend.clearSessionPtyBuffer?.(id);
        }
      },
    });
  }, [clearWipesScrollbackRef, sessionRef, termRef, terminalBackend]);

  const onSelectWord = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    pulseCopyOnSelectUserCommand(term);
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
