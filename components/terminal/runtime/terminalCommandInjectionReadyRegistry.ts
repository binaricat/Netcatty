const commandInjectionReadyReaders = new Map<string, () => boolean>();

export function registerTerminalCommandInjectionReadyReader(
  sessionId: string,
  reader: () => boolean,
): () => void {
  commandInjectionReadyReaders.set(sessionId, reader);
  return () => {
    if (commandInjectionReadyReaders.get(sessionId) === reader) {
      commandInjectionReadyReaders.delete(sessionId);
    }
  };
}

/** True when the live terminal reports an idle shell prompt ready for injection. */
export function isTerminalReadyForCommandInjection(sessionId: string): boolean {
  return commandInjectionReadyReaders.get(sessionId)?.() === true;
}
