import type { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect } from "react";

import { requestMultilinePasteConfirm } from "../../../application/state/multilinePasteConfirmStore";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import type { TerminalSession } from "../../../types";
import type { RemoteClipboardImageUploadResult } from "../clipboardImagePaste";
import type { MultilinePasteConfirmGate } from "../terminalClipboardPaste";
import { handleTerminalClipboardPaste } from "../terminalClipboardPaste";

interface UseTerminalFilePasteOptions {
  isLocalConnection: boolean;
  status: TerminalSession["status"];
  termRef: React.MutableRefObject<XTerm | null>;
  sessionRef: React.MutableRefObject<string | null>;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean }) => void;
  };
  isSensitiveInput?: () => boolean;
  scrollOnPasteRef?: React.RefObject<boolean>;
  /** Live #3488 bypass probe; forwarded to the multiline-confirm gate. */
  broadcastPasswordBypassRef?: React.RefObject<boolean | undefined>;
  onPasteData?: (data: string, options?: { lineDelayMs?: number; sensitive?: boolean }) => boolean | void;
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Remote sessions only: auto-upload a clipboard image on paste. */
  autoUploadClipboardImage?: boolean;
  /** Multi-line paste confirmation gate (#3398); undefined keeps confirm off. */
  multilinePasteConfirmRef?: React.RefObject<Omit<MultilinePasteConfirmGate, "requestConfirm"> | undefined>;
  getRemoteCwd?: () => Promise<string | null | undefined>;
  onClipboardImageUploadResult?: (result: RemoteClipboardImageUploadResult) => void;
}

export function useTerminalFilePaste({
  isLocalConnection,
  status,
  termRef,
  sessionRef,
  terminalBackend,
  isSensitiveInput,
  scrollOnPasteRef,
  broadcastPasswordBypassRef,
  onPasteData,
  scrollToBottomAfterProgrammaticInput,
  containerRef,
  autoUploadClipboardImage = false,
  multilinePasteConfirmRef,
  getRemoteCwd,
  onClipboardImageUploadResult,
}: UseTerminalFilePasteOptions) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePaste = (event: ClipboardEvent) => {
      if (status !== "connected") return;

      const bridge = netcattyBridge.get();

      const wantsImageUpload =
        autoUploadClipboardImage && !isLocalConnection && !!bridge?.readClipboardImage;
      const canHandleLocalPaste =
        isLocalConnection && !!(bridge?.readClipboardFiles || bridge?.hasClipboardImage);
      // The multi-line paste confirmation (#3398) must also intercept plain
      // remote keyboard pastes; otherwise xterm's default handler would send
      // the lines without the safety dialog when neither image upload nor
      // local file handling applies.
      //
      // Windows clipboard history (Win+V) can deliver the picked item with an
      // empty paste event: the picker writes the system clipboard while the
      // window is unfocused and Chromium still serves its stale (empty)
      // clipboard view on the synthetic paste (#3582). Intercept these events
      // and re-read through the main-process bridge, which sees the live
      // system clipboard.
      const eventText = event.clipboardData?.getData("text/plain") ?? "";
      const emptyPasteEventRecovery = !eventText && !!bridge?.readClipboardText;
      const shouldInterceptPaste =
        wantsImageUpload
        || canHandleLocalPaste
        || !!multilinePasteConfirmRef?.current?.enabled
        || emptyPasteEventRecovery;
      if (!shouldInterceptPaste) return;

      // ⚡ Must call preventDefault SYNCHRONOUSLY — the event lifecycle
      // is synchronous; calling it after an await is too late and the
      // browser will have already performed the default paste action.
      event.preventDefault();
      event.stopPropagation();

      void (async () => {
        try {
          const term = termRef.current;
          if (!term) return;
          await handleTerminalClipboardPaste({
            bridge,
            autoUploadClipboardImage: wantsImageUpload,
            clipboardImageBridge: bridge ?? undefined,
            confirmMultilinePaste: multilinePasteConfirmRef?.current
              ? { ...multilinePasteConfirmRef.current, requestConfirm: requestMultilinePasteConfirm }
              : undefined,
            // The confirm dialog can outlive the captured session (disconnect
            // / auto-reconnect), so revalidate against the live session ref
            // like the context-menu and shortcut callers do.
            getCurrentSessionId: () => sessionRef.current,
            getRemoteCwd,
            isLocalConnection,
            isSensitiveInput,
            // Forward the #3488 bypass probe so a paste confirmed at a
            // sensitive prompt still fans out to broadcast peers, matching
            // the context-menu and shortcut paste paths.
            broadcastPasswordBypass: () => broadcastPasswordBypassRef?.current === true,
            onClipboardImageUploadResult,
            readClipboardText: async () => {
              if (eventText) return eventText;
              // Prefer the main-process bridge: the renderer's clipboard view
              // can lag behind a Windows clipboard history write (#3582).
              try {
                const bridged = await bridge?.readClipboardText?.();
                if (typeof bridged === "string" && bridged.length > 0) return bridged;
              } catch (err) {
                logger.warn("Bridge clipboard read failed; falling back to navigator", err);
              }
              return navigator.clipboard.readText();
            },
            scrollOnPaste: scrollOnPasteRef?.current ?? false,
            onPasteData,
            sessionId: sessionRef.current,
            terminalBackend,
            term,
            scrollToBottomAfterProgrammaticInput,
          });
        } catch (error) {
          logger.error("Failed to handle file paste", error);
        }
      })();
    };

    container.addEventListener("paste", handlePaste, true);
    return () => {
      container.removeEventListener("paste", handlePaste, true);
    };
  }, [
    autoUploadClipboardImage,
    broadcastPasswordBypassRef,
    containerRef,
    multilinePasteConfirmRef,
    getRemoteCwd,
    isLocalConnection,
    isSensitiveInput,
    onClipboardImageUploadResult,
    onPasteData,
    scrollOnPasteRef,
    scrollToBottomAfterProgrammaticInput,
    sessionRef,
    status,
    terminalBackend,
    termRef,
  ]);
}
