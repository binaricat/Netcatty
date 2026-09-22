import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useRef } from "react";
import type { RefObject } from "react";
import { requestMultilinePasteConfirm } from "../../../application/state/multilinePasteConfirmStore";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import type { MultilinePasteConfirmGate } from "../terminalClipboardPaste";
import type { TerminalBroadcastInputOptions } from "../terminalHelpers";
import { clearTerminalViewportAndSyncPty } from "../clearTerminalViewport";
import {
  handleRemoteClipboardImageUpload,
  type RemoteClipboardImageUploadResult,
} from "../clipboardImagePaste";
import { handleTerminalClipboardPaste, pasteTextWithMultilineConfirm } from "../terminalClipboardPaste";
import { pulseCopyOnSelectUserCommand } from "../copyOnSelect";
import { getTerminalSelectionForClipboard } from "../normalizeTerminalSelection";
import {
  getHistoryPreviewSelectionFromRoot,
  requestHistoryPreviewHide,
  selectHistoryPreviewAll,
  findHistoryPreviewOverlay,
} from "../runtime/terminalHistoryScrollOverride";

import { readTerminalScreenText } from "../terminalContextBuffer";
import { shouldBroadcastDuringSensitivePrompt } from "../../../domain/terminalBroadcast";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { toast } from "../../ui/toast";

type BroadcastPasteRefs = {
  sourceSessionId: string;
  sessionRef: RefObject<string | null>;
  isBroadcastEnabledRef?: RefObject<boolean | undefined>;
  onBroadcastInputRef?: RefObject<
    ((data: string, sourceSessionId: string, options?: TerminalBroadcastInputOptions) => void) | undefined
  >;
  passwordPromptActiveRef?: RefObject<boolean | undefined>;
  broadcastPasswordBypassRef?: RefObject<boolean | undefined>;
};

export const broadcastTerminalPasteData = (
  data: string,
  {
    sourceSessionId,
    sessionRef,
    isBroadcastEnabledRef,
    onBroadcastInputRef,
    passwordPromptActiveRef,
    broadcastPasswordBypassRef,
  }: BroadcastPasteRefs,
  options?: TerminalBroadcastInputOptions,
): boolean => {
  if (
    shouldBroadcastDuringSensitivePrompt({
      sensitivePromptActive: passwordPromptActiveRef?.current === true,
      broadcastPasswordBypass: broadcastPasswordBypassRef?.current === true,
    })
    && sessionRef.current
    && isBroadcastEnabledRef?.current
    && onBroadcastInputRef?.current
  ) {
    // Bypassed password fan-out (#3488): when the prompt itself is sensitive,
    // tag the payload so peer writes keep input interceptors skipped.
    const dispatchingFromPasswordPrompt = passwordPromptActiveRef?.current === true;
    onBroadcastInputRef.current(
      data,
      sourceSessionId,
      dispatchingFromPasswordPrompt ? { ...options, sourceSensitive: true } : options,
    );
    return true;
  }
  return false;
};

export const useTerminalContextActions = ({
  termRef,
  sourceSessionId,
  sessionName,
  sessionRef,
  onHasSelectionChange,
  scrollOnPasteRef,
  isBroadcastEnabledRef,
  onBroadcastInputRef,
  passwordPromptActiveRef,
  broadcastPasswordBypassRef,
  isLocalConnection,
  supportsRemoteImagePaste,
  autoUploadClipboardImageOnPasteRef,
  multilinePasteConfirmRef,
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
  sessionName?: string;
  onHasSelectionChange?: (hasSelection: boolean) => void;
  scrollOnPasteRef?: RefObject<boolean>;
  isBroadcastEnabledRef?: RefObject<boolean | undefined>;
  onBroadcastInputRef?: RefObject<
    ((data: string, sourceSessionId: string, options?: TerminalBroadcastInputOptions) => void) | undefined
  >;
  passwordPromptActiveRef?: RefObject<boolean | undefined>;
  broadcastPasswordBypassRef?: RefObject<boolean | undefined>;
  isLocalConnection: boolean;
  supportsRemoteImagePaste: boolean;
  /** When true, paste auto-uploads a clipboard image (remote sessions only). */
  autoUploadClipboardImageOnPasteRef?: RefObject<boolean | undefined>;
  /** Multi-line paste confirmation gate (#3398); undefined keeps confirm off. */
  multilinePasteConfirmRef?: RefObject<Omit<MultilinePasteConfirmGate, "requestConfirm"> | undefined>;
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
  const { t } = useI18n();
  const savingScreenRef = useRef(false);
  const onSaveScreen = useCallback(async () => {
    const term = termRef.current;
    if (!term || savingScreenRef.current) return;
    // Capture before opening the dialog: output may continue while it is open.
    const preview = findHistoryPreviewOverlay(term.element?.parentElement);
    const terminalData = preview?.textContent ?? readTerminalScreenText(term);
    savingScreenRef.current = true;
    try {
      const bridge = netcattyBridge.get();
      if (!bridge?.exportSessionLog) throw new Error("Screen export unavailable");
      const result = await bridge.exportSessionLog({
        terminalData,
        hostLabel: sessionName || "terminal-screen",
        hostname: "",
        startTime: Date.now(),
        format: "txt",
        plainText: true,
      });
      if (!result.success && !result.canceled) throw new Error("Screen export failed");
    } catch (err) {
      logger.warn("Failed to save terminal screen", err);
      toast.error(t("terminal.saveScreen.failed"));
    } finally {
      savingScreenRef.current = false;
    }
  }, [sessionName, t, termRef]);

  const broadcastUserPasteData = useCallback((data: string, options?: TerminalBroadcastInputOptions) => {
    return broadcastTerminalPasteData(data, {
      sourceSessionId,
      sessionRef,
      isBroadcastEnabledRef,
      onBroadcastInputRef,
      passwordPromptActiveRef,
      broadcastPasswordBypassRef,
    }, options);
  }, [isBroadcastEnabledRef, onBroadcastInputRef, passwordPromptActiveRef, broadcastPasswordBypassRef, sessionRef, sourceSessionId]);

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
        confirmMultilinePaste: multilinePasteConfirmRef?.current
          ? { ...multilinePasteConfirmRef.current, requestConfirm: requestMultilinePasteConfirm }
          : undefined,
        getCurrentSessionId: () => sessionRef.current,
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
    multilinePasteConfirmRef,
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

  const onPasteSelection = useCallback(async () => {
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
    // Route through the multi-line paste confirmation gate (#3398) so a
    // selected multi-line region cannot be sent without review, just like
    // the clipboard paste path.
    await pasteTextWithMultilineConfirm(selection, {
      confirmMultilinePaste: multilinePasteConfirmRef?.current
        ? { ...multilinePasteConfirmRef.current, requestConfirm: requestMultilinePasteConfirm }
        : undefined,
      getCurrentSessionId: () => sessionRef.current,
      isSensitiveInput: () => passwordPromptActiveRef?.current === true,
      onPasteData: broadcastUserPasteData,
      scrollOnPaste: scrollOnPasteRef?.current ?? false,
      scrollToBottomAfterProgrammaticInput,
      sessionId: sessionRef.current,
      terminalBackend,
      term,
    });
  }, [
    broadcastUserPasteData,
    multilinePasteConfirmRef,
    normalizeTextOnCopyRef,
    passwordPromptActiveRef,
    scrollToBottomAfterProgrammaticInput,
    sessionRef,
    termRef,
    scrollOnPasteRef,
    terminalBackend,
  ]);

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
    onSaveScreen,
    onCopy,
    onPaste,
    onUploadClipboardImage: supportsRemoteImagePaste ? onUploadClipboardImage : undefined,
    onPasteSelection,
    onSelectAll,
    onClear,
    onSelectWord,
  };
};
