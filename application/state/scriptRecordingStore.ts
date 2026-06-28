type ScriptRecordingSnapshot = {
  sessionId: string | null;
  isPaused: boolean;
};

type Listener = () => void;

let snapshot: ScriptRecordingSnapshot = { sessionId: null, isPaused: false };
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getScriptRecordingSnapshot(): ScriptRecordingSnapshot {
  return snapshot;
}

export function subscribeScriptRecording(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setScriptRecordingState(sessionId: string | null, isPaused = false): void {
  if (snapshot.sessionId === sessionId && snapshot.isPaused === isPaused) return;
  snapshot = { sessionId, isPaused };
  emit();
}
