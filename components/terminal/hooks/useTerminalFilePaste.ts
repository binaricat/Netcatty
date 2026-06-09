import type { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect } from "react";

import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { logger } from "../../../lib/logger";
import type { TerminalSession } from "../../../types";
import { extractRootPathsFromClipboardFiles } from "../terminalHelpers";

interface UseTerminalFilePasteOptions {
  isLocalConnection: boolean;
  status: TerminalSession["status"];
  termRef: React.MutableRefObject<XTerm | null>;
  sessionRef: React.MutableRefObject<string | null>;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function useTerminalFilePaste({
  isLocalConnection,
  status,
  termRef,
  sessionRef,
  terminalBackend,
  scrollToBottomAfterProgrammaticInput,
  containerRef,
}: UseTerminalFilePasteOptions) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handlePaste = (event: ClipboardEvent) => {
      if (!isLocalConnection || status !== "connected") return;

      const bridge = netcattyBridge.get();
      if (!bridge?.readClipboardFiles) return;

      void (async () => {
        try {
          const files = await bridge.readClipboardFiles!();
          if (files.length === 0) return;

          event.preventDefault();
          event.stopPropagation();

          const paths = extractRootPathsFromClipboardFiles(files);
          if (paths.length === 0 || !sessionRef.current) return;

          const pathsText = paths.join(" ");
          terminalBackend.writeToSession(sessionRef.current, pathsText);
          scrollToBottomAfterProgrammaticInput(pathsText);
          termRef.current?.focus();
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
    containerRef,
    isLocalConnection,
    scrollToBottomAfterProgrammaticInput,
    sessionRef,
    status,
    terminalBackend,
    termRef,
  ]);
}
