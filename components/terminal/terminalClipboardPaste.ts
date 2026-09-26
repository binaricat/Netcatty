import type { Terminal as XTerm } from "@xterm/xterm";

import {
  handleRemoteClipboardImageUpload,
  type RemoteClipboardImageBridge,
  type RemoteClipboardImageUploadResult,
} from "./clipboardImagePaste";
import { extractRootPathsFromClipboardFiles, AUTO_RUN_SNIPPET_LINE_DELAY_MS } from "./terminalHelpers";
import { dispatchTerminalLinePaste, pasteTextIntoTerminal } from "./runtime/terminalUserPaste";
import { sanitizeTerminalInput } from "./runtime/terminalInputSanitize";
import {
  getMultilinePasteInfo,
  shouldConfirmMultilinePaste,
  type MultilinePasteConfirmAction,
  type MultilinePasteInfo,
} from "../../domain/terminalPasteConfirm";
import { normalizeLineEndings } from "../../lib/utils";
import { logger } from "../../lib/logger";

/** ASCII Ctrl+V - forwarded so nested TUIs can run their own image-paste bindings. */
export const LOCAL_CLIPBOARD_IMAGE_CTRL_V = "\u0016";

type ClipboardFileBridge = Pick<
  Partial<NetcattyBridge>,
  "readClipboardFiles" | "hasClipboardImage"
>;

export type MultilinePasteConfirmRequestFn = (
  info: MultilinePasteInfo & { text: string; onClose?: () => void },
) => Promise<{ action: MultilinePasteConfirmAction; text?: string }>;

/**
 * The line-by-line backend writes chunks ending at a line separator with a
 * trailing `\r`, but leaves the final chunk unterminated when the source text
 * does not end with a newline — and only splits into CR-normalized chunks when
 * there is more than one line. Ensure the last line always ends with `\r` so
 * it is executed too, even for single-line input.
 */
const withFinalLineTerminator = (data: string): string => {
  if (data.length === 0) return data;
  // The backend's delayed-write path only emits CR-normalized chunks when
  // splitting produces more than one chunk, so a single trailing LF would
  // be written verbatim and leave the command unsubmitted on the
  // network-device CLIs this feature targets. Convert it to CR even when
  // only one line remains.
  if (data.endsWith("\n")) return `${data.slice(0, -1)}\r`;
  return `${data}\r`;
};

/**
 * Gate for the multi-line paste confirmation dialog (#3398). When enabled and
 * the clipboard text reaches the configured line threshold, the paste waits
 * for the user to choose send / send-line-by-line / cancel.
 */
export type MultilinePasteConfirmGate = {
  enabled: boolean;
  minLines: number;
  /** Opens the confirm dialog; resolves with the chosen action + preview text. */
  requestConfirm?: MultilinePasteConfirmRequestFn;
};

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
  confirmMultilinePaste?: MultilinePasteConfirmGate;
  getCurrentSessionId?: () => string | null | undefined;
  getRemoteCwd?: () => Promise<string | null | undefined>;
  isLocalConnection: boolean;
  isSensitiveInput?: () => boolean;
  onClipboardImageUploadResult?: (result: RemoteClipboardImageUploadResult) => void;
  onPasteData?: (data: string, options?: { lineDelayMs?: number }) => boolean | void;
  readClipboardText: () => Promise<string>;
  scrollOnPaste?: boolean;
  scrollToBottomAfterProgrammaticInput?: (data: string) => void;
  sessionId: string | null | undefined;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean; lineDelayMs?: number }) => void;
  };
  term: Pick<XTerm, "paste" | "scrollToBottom"> & Partial<Pick<XTerm, "focus">>;
};

type MultilineGatedPasteOptions = {
  confirmMultilinePaste?: MultilinePasteConfirmGate;
  /**
   * Returns the live backend session id. The confirmation dialog can stay
   * open across a disconnect / auto-reconnect, so callers backed by a
   * session ref should provide this so the line-by-line send is
   * revalidated (or dropped) after the dialog resolves.
   */
  getCurrentSessionId?: () => string | null | undefined;
  isSensitiveInput?: () => boolean;
  onPasteData?: (data: string, options?: { lineDelayMs?: number }) => boolean | void;
  scrollOnPaste?: boolean;
  scrollToBottomAfterProgrammaticInput?: (data: string) => void;
  sessionId: string | null | undefined;
  terminalBackend: {
    writeToSession: (sessionId: string, data: string, options?: { automated?: boolean; sensitive?: boolean; lineDelayMs?: number }) => void;
  };
  term: Pick<XTerm, "paste" | "scrollToBottom"> & Partial<Pick<XTerm, "focus">>;
};

/**
 * Paste `text` into the terminal, routing through the multi-line paste
 * confirmation dialog when enabled (#3398). Shared by clipboard paste,
 * the context-menu Paste Selection action and the pasteSelection shortcut
 * so every user-initiated paste path honors the same review gate.
 */
export async function pasteTextWithMultilineConfirm(
  text: string,
  {
    confirmMultilinePaste,
    getCurrentSessionId,
    isSensitiveInput,
    onPasteData,
    scrollOnPaste = false,
    scrollToBottomAfterProgrammaticInput,
    sessionId,
    terminalBackend,
    term,
  }: MultilineGatedPasteOptions,
): Promise<void> {
  if (!sessionId) return;
  const session: string = sessionId;
  // Snapshot the sensitive classification before any await: the confirm
  // dialog can stay open while remote output or a reconnect clears
  // passwordPromptActiveRef, and re-evaluating after the await would
  // downgrade a paste made at a password prompt to nonsensitive (enabling
  // broadcast fan-out and input logging of the secret).
  const sensitive = isSensitiveInput?.() === true;
  // Multi-line paste confirmation (#3398): network-device CLIs (Cisco IOS,
  // Huawei VRP, H3C Comware) execute every pasted line immediately and have
  // no bracketed-paste protection, so let the user review before sending.
  // Applied to non-empty text and whitespace-only text alike, so a blank
  // multi-line clipboard cannot silently submit Enter presses at a prompt.
  if (
    confirmMultilinePaste?.enabled
    && shouldConfirmMultilinePaste(text, { minLines: confirmMultilinePaste.minLines })
  ) {
    const decision = confirmMultilinePaste.requestConfirm
      ? await confirmMultilinePaste.requestConfirm({ ...getMultilinePasteInfo(text), text, onClose: () => term.focus?.() })
      : null;
    if (!decision || decision.action === "cancel") return;
    const currentSessionId = getCurrentSessionId ? getCurrentSessionId() : session;
    if (!currentSessionId) return;
    const confirmedSensitive = sensitive || isSensitiveInput?.() === true;
    if (decision.action === "line-by-line") {
      // An explicitly emptied preview means "send nothing"; only a missing
      // value falls back to the original clipboard text.
      const lineData = withFinalLineTerminator(normalizeLineEndings(sanitizeTerminalInput(decision.text ?? text)));
      if (!lineData) return;
      const lineOptions = {
        lineDelayMs: AUTO_RUN_SNIPPET_LINE_DELAY_MS,
        sensitive: confirmedSensitive,
        broadcast: !confirmedSensitive && !!onPasteData,
      };
      if (!dispatchTerminalLinePaste(term, lineData, lineOptions)) {
        terminalBackend.writeToSession(currentSessionId, lineData, {
          automated: false,
          lineDelayMs: lineOptions.lineDelayMs,
          sensitive: lineOptions.sensitive,
        });
      }
      // The mounted runtime broadcasts each acknowledged line with fresh guards.
      // Without a runtime there is no receipt owner, so fallback sends only to
      // the source rather than enqueueing an unchecked batch on peers.
      scrollToBottomAfterProgrammaticInput?.(lineData);
      return;
    }
    pasteTextIntoTerminal(term, decision.text ?? text, {
      scrollOnPaste,
      // Same post-await race as above: never fan a sensitive paste out to
      // broadcast peers via onPasteData.
      onPasteData: confirmedSensitive ? undefined : onPasteData,
      // Carry the pre-dialog sensitivity snapshot through the normal Send
      // path too: term.paste's input handler recomputes `sensitive` from the
      // live password-prompt ref, which the dialog await may have cleared.
      sensitive: confirmedSensitive,
    });
    return;
  }
  pasteTextIntoTerminal(term, text, {
    scrollOnPaste,
    onPasteData,
  });
}

export async function handleTerminalClipboardPaste({
  bridge,
  autoUploadClipboardImage = false,
  clipboardImageBridge,
  confirmMultilinePaste,
  getCurrentSessionId,
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
    await pasteTextWithMultilineConfirm(text, {
      confirmMultilinePaste,
      getCurrentSessionId,
      isSensitiveInput,
      onPasteData,
      scrollOnPaste,
      scrollToBottomAfterProgrammaticInput,
      sessionId,
      terminalBackend,
      term,
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
  // local clipboard image is present. Multi-line whitespace still goes through
  // the confirmation gate so it cannot bypass the review dialog (#3398).
  if (text && sessionId) {
    await pasteTextWithMultilineConfirm(text, {
      confirmMultilinePaste,
      getCurrentSessionId,
      isSensitiveInput,
      onPasteData,
      scrollOnPaste,
      scrollToBottomAfterProgrammaticInput,
      sessionId,
      terminalBackend,
      term,
    });
  }
}
