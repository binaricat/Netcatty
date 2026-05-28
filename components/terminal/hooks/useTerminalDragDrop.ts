import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useRef, useState } from "react";

import { logger } from "../../../lib/logger";
import { extractDropEntries } from "../../../lib/sftpFileUtils";
import type { Host, TerminalSession } from "../../../types";
import { toast } from "../../ui/toast";
import {
  extractRootPathsFromDropEntries,
  type TerminalProps,
} from "../terminalHelpers";

interface UseTerminalDragDropOptions {
  host: Host;
  isLocalConnection: boolean;
  onOpenSftp?: TerminalProps["onOpenSftp"];
  resolveSftpInitialPath: () => Promise<string | undefined>;
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  sessionId: string;
  sessionRef: React.MutableRefObject<string | null>;
  status: TerminalSession["status"];
  t: (key: string) => string;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean }) => void;
  };
  termRef: React.MutableRefObject<XTerm | null>;
}

export function useTerminalDragDrop({
  host,
  isLocalConnection,
  onOpenSftp,
  resolveSftpInitialPath,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  sessionRef,
  status,
  t,
  terminalBackend,
  termRef,
}: UseTerminalDragDropOptions) {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    if (!e.dataTransfer.types.includes("Files")) {
      return;
    }

    if (status !== "connected") {
      toast.error(t("terminal.dragDrop.notConnected"), t("terminal.dragDrop.errorTitle"));
      return;
    }

    try {
      const dropEntries = await extractDropEntries(e.dataTransfer);

      if (dropEntries.length === 0) {
        return;
      }

      if (isLocalConnection) {
        const paths = extractRootPathsFromDropEntries(dropEntries);

        if (paths.length > 0 && termRef.current && sessionRef.current) {
          const pathsText = paths.join(" ");
          terminalBackend.writeToSession(sessionRef.current, pathsText);
          scrollToBottomAfterProgrammaticInput(pathsText);
          termRef.current.focus();
        }
      } else if (onOpenSftp) {
        const initialPath = await resolveSftpInitialPath();
        onOpenSftp(host, initialPath, dropEntries, sessionId);
      }
    } catch (error) {
      logger.error("Failed to handle file drop", error);
      toast.error(t("terminal.dragDrop.errorMessage"), t("terminal.dragDrop.errorTitle"));
    }
  };

  return {
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    isDraggingOver,
  };
}
