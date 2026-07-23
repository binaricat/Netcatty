import type { Terminal as XTerm } from "@xterm/xterm";

import { extractRootPathsFromClipboardFiles } from "./terminalHelpers";
import { pasteTextIntoTerminal } from "./runtime/terminalUserPaste";

type ClipboardFileBridge = Pick<Partial<NetcattyBridge>, "readClipboardFiles">;

type TerminalClipboardPasteOptions = {
  bridge?: ClipboardFileBridge;
  isLocalConnection: boolean;
  isSensitiveInput?: () => boolean;
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
  isLocalConnection,
  isSensitiveInput,
  onPasteData,
  readClipboardText,
  scrollOnPaste = false,
  scrollToBottomAfterProgrammaticInput,
  sessionId,
  terminalBackend,
  term,
}: TerminalClipboardPasteOptions): Promise<void> {
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
