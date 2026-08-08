import {
  isNonPromptLine,
  reconcilePromptWithExternalCommand,
  type PromptDetectionResult,
} from "./promptDetector";

const THEMED_PROMPT_MARKERS = /[❯❮→➜➤⟩»›]/;

function hasStandardShellPromptTerminator(promptText: string): boolean {
  return /[$#%>]$/.test(promptText.trimEnd());
}

function isSingleThemedPromptTerminator(promptText: string): boolean {
  const trimmed = promptText.trim();
  if (trimmed.length !== 1) return false;
  const code = trimmed.charCodeAt(0);
  return THEMED_PROMPT_MARKERS.test(trimmed) || (code >= 0xE000 && code <= 0xF8FF);
}

function isThemedPromptPathToken(token: string): boolean {
  return (
    token === "~" ||
    token.startsWith("~/") ||
    token.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(token) ||
    token.includes("\\")
  );
}

function hasThemedPromptDecorationInInput(prompt: PromptDetectionResult): boolean {
  const hasThemedPromptMarker =
    THEMED_PROMPT_MARKERS.test(prompt.promptText) ||
    Array.from(prompt.promptText).some((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0xE000 && code <= 0xF8FF;
    });
  if (hasThemedPromptMarker && hasStandardShellPromptTerminator(prompt.promptText)) {
    return false;
  }
  if (hasThemedPromptMarker && isSingleThemedPromptTerminator(prompt.promptText)) {
    const firstToken = prompt.userInput.trimStart().match(/^\S+/)?.[0] ?? "";
    return (
      (prompt.userInput.startsWith(" ") || isThemedPromptPathToken(firstToken)) &&
      /\S+\s+\S/.test(prompt.userInput)
    );
  }
  return hasThemedPromptMarker && /\S+\s+\S/.test(prompt.userInput);
}

/**
 * Command-line text used for autocomplete matching (popup / ghost).
 *
 * Enter recording keeps a stricter echo-alignment policy so short lagging
 * prefixes are not committed as history. Autocomplete can safely prefer the
 * reliable keystroke buffer when it is ahead of the remote shell echo —
 * otherwise high-latency SSH drops local history/fig matches until the user
 * pauses and the echo catches up (#2830).
 */
export function resolveAutocompleteQueryInput(
  prompt: PromptDetectionResult,
  typedBuffer: string,
  typedBufferReliable: boolean,
): string | null {
  if (!prompt.isAtPrompt) return null;

  if (
    typedBufferReliable &&
    typedBuffer.length > 0 &&
    typedBuffer.startsWith(prompt.userInput)
  ) {
    return typedBuffer;
  }

  return prompt.userInput;
}

export function getCommandToRecordOnEnter(
  livePrompt: PromptDetectionResult,
  alignedTyped: string | null,
  typedBuffer: string,
  typedBufferReliable: boolean,
): string | null {
  if (!livePrompt.isAtPrompt) return null;
  const alignedCommand = alignedTyped?.trim();
  if (alignedCommand) return alignedCommand;

  const reliableTypedCommand = typedBufferReliable ? typedBuffer.trim() : "";
  if (reliableTypedCommand) {
    const reconciledPrompt = reconcilePromptWithExternalCommand(
      livePrompt,
      reliableTypedCommand,
    );
    if (reconciledPrompt) return reliableTypedCommand;
  }

  const liveCommand = livePrompt.userInput.trim();
  if (!liveCommand && reliableTypedCommand) {
    return isNonPromptLine(`${livePrompt.promptText}${reliableTypedCommand}`)
      ? null
      : reliableTypedCommand;
  }
  if (!liveCommand) return null;
  if (!typedBufferReliable && hasThemedPromptDecorationInInput(livePrompt)) return null;

  const liveInputMayIncludePromptDecoration =
    typedBufferReliable &&
    typedBuffer.trim().length > 0 &&
    liveCommand !== typedBuffer.trim() &&
    liveCommand.endsWith(typedBuffer.trim());
  if (liveInputMayIncludePromptDecoration) return null;

  const liveInputMayBeLagging =
    typedBufferReliable &&
    typedBuffer.trim().length > 0 &&
    typedBuffer.length > livePrompt.userInput.length &&
    typedBuffer.startsWith(livePrompt.userInput);
  if (liveInputMayBeLagging) return null;

  if (typedBufferReliable && hasThemedPromptDecorationInInput(livePrompt)) return null;

  return liveCommand;
}

