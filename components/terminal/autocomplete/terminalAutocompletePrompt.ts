import {
  isNonPromptLine,
  reconcilePromptWithExternalCommand,
  type PromptDetectionResult,
} from "./promptDetector";
import { computeLivePreviewWrite } from "./livePreviewSequence";

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

  // Prefer the keystroke buffer when it is reliably aligned with the remote
  // echo as a shared prefix in either direction:
  // - buffer ahead of echo (typing faster than SSH echo)
  // - echo ahead of buffer (partial/full backspace while echo still lags)
  // Without the second case, a lagging echo of deleted characters would keep
  // driving completions/accept (e.g. typed `gi` + echo `git` → accept
  // ` status` → remote `gi status`). An unreliable empty buffer is different:
  // history recall / cursor moves clear the buffer without meaning the line
  // is empty, so fall through to prompt.userInput there.
  if (
    typedBufferReliable &&
    (typedBuffer.startsWith(prompt.userInput) ||
      prompt.userInput.startsWith(typedBuffer))
  ) {
    return typedBuffer;
  }

  return prompt.userInput;
}

/**
 * Whether an in-flight completion result still belongs to the active query.
 *
 * Live preview rewrites the typed buffer to the highlighted candidate, so a
 * naive `currentInput === queryInput` check would drop late path listings
 * while a preview row remains selected.
 */
export function isSameAutocompleteQuery(options: {
  queryInput: string;
  currentInput: string | null;
  previewActive: boolean;
  previewBaseline: string;
}): boolean {
  if (options.currentInput === null) return false;
  if (options.currentInput === options.queryInput) return true;
  return options.previewActive && options.previewBaseline === options.queryInput;
}

/**
 * Keystrokes that rewrite the remote command line to `candidate`.
 *
 * Must use the same echo-lag-aware baseline as suggestion matching: the remote
 * shell already has the typed buffer, even when local echo still shows a short
 * prefix. Using lagging `prompt.userInput` here would append a duplicate tail
 * (e.g. typed `systemctl` + echo `s` + accept → send `ystemctl …`).
 */
export function computeAutocompleteAcceptWrite(options: {
  prompt: PromptDetectionResult;
  typedBuffer: string;
  typedBufferReliable: boolean;
  candidate: string;
  os: string;
  execute?: boolean;
  allowLineReplacement?: boolean;
}): string | null {
  const currentLine = resolveAutocompleteQueryInput(
    options.prompt,
    options.typedBuffer,
    options.typedBufferReliable,
  );
  if (currentLine === null) return null;

  const allowLineReplacement = options.allowLineReplacement !== false;
  if (
    !options.candidate.startsWith(currentLine) &&
    !allowLineReplacement
  ) {
    return null;
  }

  const body = computeLivePreviewWrite({
    currentLine,
    candidate: options.candidate,
    os: options.os,
  });
  if (!options.execute) return body;
  return body ? `${body}\r` : "\r";
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

