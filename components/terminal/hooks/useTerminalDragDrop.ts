import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useRef, useState } from "react";

import { logger } from "../../../lib/logger";
import {
  buildZmodemDragDropFiles,
  buildZmodemDragDropUploadCommand,
  containsZmodemRzMissingMarker,
  createZmodemRzMissingToken,
  supportsZmodemDragDropSftpFallback,
  supportsZmodemTerminalDragDrop,
  type ZmodemDragDropFile,
} from "../../../lib/zmodemDragDrop";
import { extractDropEntries, type DropEntry } from "../../../lib/sftpFileUtils";
import type { Host, TerminalSession } from "../../../types";
import { toast } from "../../ui/toast";
import {
  extractRootPathsFromDropEntries,
  type TerminalProps,
} from "../terminalHelpers";

interface UseTerminalDragDropOptions {
  host: Host;
  isLocalConnection: boolean;
  isNetworkDevice?: boolean;
  onOpenSftp?: TerminalProps["onOpenSftp"];
  resolveSftpInitialPath: (options?: { preferFreshBackend?: boolean }) => Promise<string | undefined>;
  scrollToBottomAfterProgrammaticInput: (data: string) => void;
  sessionId: string;
  sessionRef: React.MutableRefObject<string | null>;
  status: TerminalSession["status"];
  t: (key: string) => string;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean }) => void;
    cancelZmodem?: (sessionId: string, options?: { interrupt?: boolean }) => void;
    onSessionData?: (sessionId: string, cb: (chunk: string) => void) => () => void;
    onZmodemEvent?: (
      sessionId: string,
      cb: (event: { type: string; transferType?: string }) => void,
    ) => () => void;
    startZmodemDragDropUpload?: (
      sessionId: string,
      files: ZmodemDragDropFile[],
      uploadCommand?: string,
    ) => Promise<{ success: boolean; error?: string }>;
  };
  isSensitiveInput?: () => boolean;
  rzMissingFallbackTimeoutMs?: number;
  termRef: React.MutableRefObject<XTerm | null>;
}

const RZ_MISSING_FALLBACK_TIMEOUT_MS = 2500;

export async function resolveTerminalDropUploadInitialPath(
  resolveSftpInitialPath: UseTerminalDragDropOptions["resolveSftpInitialPath"],
): Promise<string | undefined> {
  return resolveSftpInitialPath({ preferFreshBackend: true });
}

function createRzMissingWatcher({
  sessionId,
  terminalBackend,
  token,
  timeoutMs = RZ_MISSING_FALLBACK_TIMEOUT_MS,
}: {
  sessionId: string;
  terminalBackend: Pick<UseTerminalDragDropOptions["terminalBackend"], "onSessionData" | "onZmodemEvent">;
  token: string;
  timeoutMs?: number;
}): { promise: Promise<"missing" | "detected" | "timeout">; stop: () => void } {
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";
  let unsubscribeData: (() => void) | undefined;
  let unsubscribeZmodem: (() => void) | undefined;
  let settle: (result: "missing" | "detected" | "timeout") => void = () => {};

  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    unsubscribeData?.();
    unsubscribeData = undefined;
    unsubscribeZmodem?.();
    unsubscribeZmodem = undefined;
  };

  const promise = new Promise<"missing" | "detected" | "timeout">((resolve) => {
    settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    unsubscribeData = terminalBackend.onSessionData?.(sessionId, (chunk) => {
      buffer = `${buffer}${chunk}`.slice(-512);
      if (containsZmodemRzMissingMarker(buffer, token)) {
        settle("missing");
      }
    });

    unsubscribeZmodem = terminalBackend.onZmodemEvent?.(sessionId, (event) => {
      if (event.type === "detect" && event.transferType === "upload") {
        settle("detected");
      }
    });

    timeout = setTimeout(() => settle("timeout"), timeoutMs);
  });

  return {
    promise,
    stop: () => settle("detected"),
  };
}

export async function handleTerminalDropEntries({
  dropEntries,
  host,
  isLocalConnection,
  isNetworkDevice = false,
  onOpenSftp,
  resolveSftpInitialPath,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  sessionRef,
  terminalBackend,
  isSensitiveInput,
  rzMissingFallbackTimeoutMs,
  termRef,
}: Pick<
  UseTerminalDragDropOptions,
  | "host"
  | "isLocalConnection"
  | "isNetworkDevice"
  | "onOpenSftp"
  | "resolveSftpInitialPath"
  | "scrollToBottomAfterProgrammaticInput"
  | "sessionId"
  | "sessionRef"
  | "terminalBackend"
  | "isSensitiveInput"
  | "rzMissingFallbackTimeoutMs"
  | "termRef"
> & {
  dropEntries: DropEntry[];
}): Promise<void> {
  if (dropEntries.length === 0) {
    return;
  }

  if (isLocalConnection) {
    const paths = extractRootPathsFromDropEntries(dropEntries);

    if (paths.length > 0 && termRef.current && sessionRef.current) {
      const pathsText = paths.join(" ");
      terminalBackend.writeToSession(sessionRef.current, pathsText, {
        sensitive: isSensitiveInput?.() === true,
      });
      scrollToBottomAfterProgrammaticInput(pathsText);
      termRef.current.focus();
    }
    return;
  }

  const requiresSftpForDirectoryDrop = dropEntries.some((entry) => (
    entry.isDirectory || /[\\/]/.test(entry.relativePath)
  ));

  if (
    requiresSftpForDirectoryDrop
    && onOpenSftp
    && supportsZmodemDragDropSftpFallback(host)
  ) {
    const initialPath = await resolveTerminalDropUploadInitialPath(resolveSftpInitialPath);
    onOpenSftp(host, initialPath, dropEntries, sessionId);
  } else if (supportsZmodemTerminalDragDrop(host, isNetworkDevice)) {
    const files = await buildZmodemDragDropFiles(dropEntries);
    if (files.length === 0) {
      throw new Error("No files to upload");
    }

    if (!terminalBackend.startZmodemDragDropUpload) {
      throw new Error("ZMODEM drag-drop upload is unavailable");
    }

    const shouldFallbackToSftpWhenRzMissing = Boolean(
      onOpenSftp
      && supportsZmodemDragDropSftpFallback(host)
      && terminalBackend.onSessionData
      && terminalBackend.cancelZmodem,
    );
    const rzMissingToken = shouldFallbackToSftpWhenRzMissing
      ? createZmodemRzMissingToken()
      : undefined;
    const rzMissingWatcher = rzMissingToken
      ? createRzMissingWatcher({
        sessionId,
        terminalBackend,
        token: rzMissingToken,
        timeoutMs: rzMissingFallbackTimeoutMs,
      })
      : undefined;
    const uploadCommand = rzMissingToken
      ? buildZmodemDragDropUploadCommand(rzMissingToken)
      : undefined;

    let result: { success: boolean; error?: string };
    try {
      result = await terminalBackend.startZmodemDragDropUpload(sessionId, files, uploadCommand);
    } catch (error) {
      rzMissingWatcher?.stop();
      throw error;
    }
    if (!result.success) {
      rzMissingWatcher?.stop();
      throw new Error(result.error || "ZMODEM upload failed");
    }

    const fallbackResult = rzMissingWatcher ? await rzMissingWatcher.promise : "detected";
    if (fallbackResult === "missing" || fallbackResult === "timeout") {
      terminalBackend.cancelZmodem?.(sessionId, { interrupt: fallbackResult === "timeout" });
      const initialPath = await resolveTerminalDropUploadInitialPath(resolveSftpInitialPath);
      onOpenSftp?.(host, initialPath, dropEntries, sessionId);
    }
  } else if (onOpenSftp) {
    const initialPath = await resolveTerminalDropUploadInitialPath(resolveSftpInitialPath);
    onOpenSftp(host, initialPath, dropEntries, sessionId);
  }
}

export function useTerminalDragDrop({
  host,
  isLocalConnection,
  isNetworkDevice = false,
  onOpenSftp,
  resolveSftpInitialPath,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  sessionRef,
  status,
  t,
  terminalBackend,
  isSensitiveInput,
  rzMissingFallbackTimeoutMs,
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
      await handleTerminalDropEntries({
        dropEntries,
        host,
        isLocalConnection,
        isNetworkDevice,
        onOpenSftp,
        resolveSftpInitialPath,
        scrollToBottomAfterProgrammaticInput,
        sessionId,
        sessionRef,
        terminalBackend,
        isSensitiveInput,
        rzMissingFallbackTimeoutMs,
        termRef,
      });
    } catch (error) {
      logger.error("Failed to handle file drop", error);
      const message = error instanceof Error && error.message === "No files to upload"
        ? t("terminal.dragDrop.noFiles")
        : t("terminal.dragDrop.errorMessage");
      toast.error(message, t("terminal.dragDrop.errorTitle"));
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
