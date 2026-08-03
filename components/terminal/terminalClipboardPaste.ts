import type { Terminal as XTerm } from "@xterm/xterm";

import {
  handleRemoteClipboardImageUpload,
  type RemoteClipboardImageBridge,
  type RemoteClipboardImageUploadResult,
} from "./clipboardImagePaste";
import { extractRootPathsFromClipboardFiles } from "./terminalHelpers";
import { pasteTextIntoTerminal } from "./runtime/terminalUserPaste";

type ClipboardFileBridge = Pick<Partial<NetcattyBridge>, "readClipboardFiles">;

type TerminalClipboardPasteOptions = {
  bridge?: ClipboardFileBridge;
  /**
   * When true, a clipboard image is uploaded to the remote host (SFTP) and
   * the remote path is pasted, instead of falling back to a text paste.
   * Callers should only enable this for connections that support remote
   * image paste; the upload no-ops unless a session id is provided.
   */
  autoUploadClipboardImage?: boolean;
  clipboardImageBridge?: RemoteClipboardImageBridge;
  getRemoteCwd?: () => Promise<string | null | undefined>;
  isLocalConnection: boolean;
  isSensitiveInput?: () => boolean;
  onClipboardImageUploadResult?: (result: RemoteClipboardImageUploadResult) => void;
  onPasteData?: (data: string) => boolean | void;
  readClipboardText: () => Promise<string>;
  scrollOnPaste?: boolean;
  scrollToBottomAfterProgrammaticInput?: (data: string) => void;
  sessionId: string | null | undefined;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean }) => void;
  };
  term: Pick<XTerm, "paste" | "scrollToBottom"> & Partial<Pick<XTerm, "focus">>;
};

export async function handleTerminalClipboardPaste({
  bridge,
  autoUploadClipboardImage = false,
  clipboardImageBridge,
  getRemoteCwd,
  isLocalConnection,
  isSensitiveInput,
  onClipboardImageUploadResult,
  onPasteData,
  readClipboardText,
  scrollOnPaste = false,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  terminalBackend,
  term,
}: TerminalClipboardPasteOptions): Promise<void> {
  // Image-first: when enabled and a remote session is active, a clipboard
  // image triggers the SFTP upload flow. "no-image" means the clipboard
  // holds text/files instead, so we silently continue to the normal paste.
  if (autoUploadClipboardImage && sessionId && !isLocalConnection) {
    try {
      const result = await handleRemoteClipboardImageUpload({
        bridge: clipboardImageBridge,
        getRemoteCwd: getRemoteCwd ?? (async () => undefined),
        isSensitiveInput,
        sessionId,
        terminalBackend,
        term,
        scrollToBottomAfterProgrammaticInput,
      });
      if (result.ok === true) {
        onClipboardImageUploadResult?.(result);
        return;
      }
      if (result.reason !== "no-image" && result.reason !== "unsupported") {
        onClipboardImageUploadResult?.(result);
        return;
      }
    } catch {
      // The clipboard image was already read successfully above, so any throw
      // here means the upload itself failed (e.g. SFTP cannot be opened for
      // the session). Surface the same error as the context-menu action
      // instead of silently pasting unrelated clipboard content.
      onClipboardImageUploadResult?.({ ok: false, reason: "upload-failed" });
      return;
    }
  }

  const readClipboardFiles = bridge?.readClipboardFiles;
  if (isLocalConnection && readClipboardFiles) {
    try {
      const files = await readClipboardFiles();
      if (files.length > 0 && sessionId) {
        const paths = extractRootPathsFromClipboardFiles(files);
        if (paths.length > 0) {
          const pathsText = paths.join(" ");
          terminalBackend.writeToSession(sessionId, pathsText, {
            sensitive: isSensitiveInput?.() === true,
          });
          scrollToBottomAfterProgrammaticInput?.(pathsText);
          term.focus?.();
          return;
        }
      }
    } catch {
      // Fall through to text paste.
    }
  }

  const text = await readClipboardText();
  if (text && sessionId) {
    pasteTextIntoTerminal(term, text, {
      scrollOnPaste,
      onPasteData,
    });
  }
}
