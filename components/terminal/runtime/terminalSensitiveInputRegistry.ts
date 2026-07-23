const sensitiveInputReaders = new Map<string, () => boolean>();

export function registerTerminalSensitiveInputReader(
  sessionId: string,
  reader: () => boolean,
): () => void {
  sensitiveInputReaders.set(sessionId, reader);
  return () => {
    if (sensitiveInputReaders.get(sessionId) === reader) sensitiveInputReaders.delete(sessionId);
  };
}

export function isTerminalSensitiveInputActive(sessionId: string): boolean {
  return sensitiveInputReaders.get(sessionId)?.() === true;
}
