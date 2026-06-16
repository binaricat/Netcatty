import type { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect } from "react";

import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import type { TerminalSession } from "../../../types";
import { extractRootPathsFromClipboardFiles } from "../terminalHelpers";
import { pasteTextIntoTerminal } from "../runtime/terminalUserPaste";
import { handleRemoteClipboardImagePaste } from "../clipboardImagePaste";

interface UseTerminalFilePasteOptions {
  isLocalConnection: boolean;
  supportsRemoteImagePaste: boolean;
  status: TerminalSession["status"];
  termRef: React.MutableRefObject<XTerm | null>;
  sessionRef: React.MutableRefObject<string | null>;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
  resolveSftpInitialPath: (options?: { preferFreshBackend?: boolean }) => Promise<string | undefined>;
  scrollOnPasteRef?: React.RefObject<boolean>;
  onPasteData?: (data: string) => boolean | void;
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useTerminalFilePaste({
  isLocalConnection,
  supportsRemoteImagePaste,
  status,
  termRef,
  sessionRef,
  terminalBackend,
  resolveSftpInitialPath,
  scrollOnPasteRef,
  onPasteData,
  scrollToBottomAfterProgrammaticInput,
  containerRef,
}: UseTerminalFilePasteOptions) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const fallbackToTextPaste = () => {
      const term = termRef.current;
      if (!term || !sessionRef.current) return;
      navigator.clipboard.readText().then((text) => {
        if (text) {
          pasteTextIntoTerminal(term, text, {
            scrollOnPaste: scrollOnPasteRef?.current ?? false,
            onPasteData,
          });
        }
      }).catch(() => {
        // clipboard access denied — silently ignore
      });
    };

    const handlePaste = (event: ClipboardEvent) => {
      if (status !== "connected") return;

      const bridge = netcattyBridge.get();

      if (supportsRemoteImagePaste && bridge?.readClipboardImage) {
        event.preventDefault();
        event.stopPropagation();

        void (async () => {
          try {
            const handled = await handleRemoteClipboardImagePaste({
              bridge,
              getRemoteCwd: () => resolveSftpInitialPath({ preferFreshBackend: true }),
              sessionId: sessionRef.current,
              terminalBackend,
              term: termRef.current,
              scrollToBottomAfterProgrammaticInput,
            });
            if (!handled) fallbackToTextPaste();
          } catch (error) {
            logger.error("Failed to handle remote image paste", error);
            fallbackToTextPaste();
          }
        })();
        return;
      }

      if (!isLocalConnection || !bridge?.readClipboardFiles) return;

      // ⚡ Must call preventDefault SYNCHRONOUSLY — the event lifecycle
      // is synchronous; calling it after an await is too late and the
      // browser will have already performed the default paste action.
      event.preventDefault();
      event.stopPropagation();

      void (async () => {
        try {
          const files = await bridge.readClipboardFiles!();
          if (files.length === 0) {
            fallbackToTextPaste();
            return;
          }

          const paths = extractRootPathsFromClipboardFiles(files);
          if (paths.length === 0 || !sessionRef.current) {
            fallbackToTextPaste();
            return;
          }

          const pathsText = paths.join(" ");
          terminalBackend.writeToSession(sessionRef.current, pathsText);
          scrollToBottomAfterProgrammaticInput(pathsText);
          termRef.current?.focus();
        } catch (error) {
          logger.error("Failed to handle file paste", error);
          fallbackToTextPaste();
        }
      })();
    };

    container.addEventListener("paste", handlePaste, true);
    return () => {
      container.removeEventListener("paste", handlePaste, true);
    };
  }, [
    containerRef,
    isLocalConnection,
    supportsRemoteImagePaste,
    onPasteData,
    resolveSftpInitialPath,
    scrollOnPasteRef,
    scrollToBottomAfterProgrammaticInput,
    sessionRef,
    status,
    terminalBackend,
    termRef,
  ]);
}
