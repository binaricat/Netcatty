import type { Terminal as XTerm } from "@xterm/xterm";

import {
  handleRemoteClipboardImageUpload,
  type RemoteClipboardImageBridge,
  type RemoteClipboardImageUploadResult,
} from "./clipboardImagePaste";
import { extractRootPathsFromClipboardFiles } from "./terminalHelpers";
import { pasteTextIntoTerminal } from "./runtime/terminalUserPaste";
import { logger } from "../../lib/logger";

/** ASCII Ctrl+V - forwarded so nested TUIs can run their own image-paste bindings. */
export const LOCAL_CLIPBOARD_IMAGE_CTRL_V = "\u0016";

type ClipboardFileBridge = Pick<
  Partial<NetcattyBridge>,
  "readClipboardFiles" | "hasClipboardImage"
>;

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

  let text = "";
  try {
    text = await readClipboardText();
  } catch (error) {
    // Text read failed (permissions / image-only clipboard quirks). Treat as
    // empty so local image probe can still forward Ctrl+V.
    logger.warn("Failed to read clipboard text for terminal paste", error);
  }
  // Prefer real text paste. Whitespace-only is deferred until after the local
  // image probe so screenshot clipboards that also carry blank text/plain can
  // still forward Ctrl+V for nested TUIs.
  if (text.trim() && sessionId) {
    pasteTextIntoTerminal(term, text, {
      scrollOnPaste,
      onPasteData,
    });
    return;
  }

  // Local image-only clipboard: Electron's Edit>Paste turns Ctrl+V into a
  // paste event, so TUI apps (Claude Code chat:imagePaste, etc.) never see
  // the chord. Forward raw Ctrl+V; the app can then read the OS clipboard
  // via xclip/wl-paste. Skip remote sessions - the image is not on the host.
  if (isLocalConnection && sessionId && bridge?.hasClipboardImage) {
    try {
      if (await bridge.hasClipboardImage()) {
        terminalBackend.writeToSession(sessionId, LOCAL_CLIPBOARD_IMAGE_CTRL_V, {
          sensitive: isSensitiveInput?.() === true,
        });
        scrollToBottomAfterProgrammaticInput?.(LOCAL_CLIPBOARD_IMAGE_CTRL_V);
        term.focus?.();
        return;
      }
    } catch {
      // Clipboard probe failed; fall through to whitespace text paste if any.
    }
  }

  // Preserve intentional whitespace-only pastes (indent / newline) when no
  // local clipboard image is present.
  if (text && sessionId) {
    pasteTextIntoTerminal(term, text, {
      scrollOnPaste,
      onPasteData,
    });
  }
}
