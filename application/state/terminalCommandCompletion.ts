type Listener = (sessionId: string) => void;
const listeners = new Set<Listener>();

/** Renderer-local fan-out of the terminal's existing completion detection. */
export function publishTerminalCommandCompletion(sessionId: string): void {
  for (const listener of listeners) listener(sessionId);
}

export function subscribeTerminalCommandCompletion(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
