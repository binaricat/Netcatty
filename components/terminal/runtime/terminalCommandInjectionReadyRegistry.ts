export interface TerminalCommandInjectionReadyOptions {
  /** Keep a typed draft. Sensitive prompts, alt-screen, and non-prompts still block. */
  allowDraft?: boolean;
}

export interface TerminalPromptDraftContext {
  promptText: string;
  userInput: string;
  pendingTypedInput: string;
}

const commandInjectionReadyReaders = new Map<
  string,
  (options?: TerminalCommandInjectionReadyOptions) => boolean
>();

const promptDraftReaders = new Map<
  string,
  () => TerminalPromptDraftContext | null
>();

export function registerTerminalCommandInjectionReadyReader(
  sessionId: string,
  reader: (options?: TerminalCommandInjectionReadyOptions) => boolean,
  draftReader?: () => TerminalPromptDraftContext | null,
): () => void {
  commandInjectionReadyReaders.set(sessionId, reader);
  if (draftReader) {
    promptDraftReaders.set(sessionId, draftReader);
  } else {
    promptDraftReaders.delete(sessionId);
  }
  return () => {
    if (commandInjectionReadyReaders.get(sessionId) === reader) {
      commandInjectionReadyReaders.delete(sessionId);
    }
    if (draftReader && promptDraftReaders.get(sessionId) === draftReader) {
      promptDraftReaders.delete(sessionId);
    }
  };
}

/** True when the live terminal reports a shell prompt ready for injection. */
export function isTerminalReadyForCommandInjection(
  sessionId: string,
  options?: TerminalCommandInjectionReadyOptions,
): boolean {
  return commandInjectionReadyReaders.get(sessionId)?.(options) === true;
}

/** Return the current prompt and draft text up to the cursor for a live terminal. */
export function getTerminalPromptDraftContext(
  sessionId: string,
): TerminalPromptDraftContext | null {
  return promptDraftReaders.get(sessionId)?.() ?? null;
}
