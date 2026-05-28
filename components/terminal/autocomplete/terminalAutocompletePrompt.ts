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

