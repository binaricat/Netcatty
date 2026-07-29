import type { CodexUserInputQuestion } from './codexAppServerInteractions';

export type OpenCodeQuestionInteraction = {
  interactionId: string;
  source: 'opencode';
  kind: 'user-input';
  requestId: string;
  chatSessionId: string;
  questions: CodexUserInputQuestion[];
};

type InteractionListener = (interaction: OpenCodeQuestionInteraction) => void;
type ClearedListener = (interactionIds: string[]) => void;

const pendingInteractions = new Map<string, OpenCodeQuestionInteraction>();
const listeners = new Set<InteractionListener>();
const clearedListeners = new Set<ClearedListener>();

function notifyCleared(interactionIds: string[]): void {
  if (interactionIds.length === 0) return;
  for (const listener of clearedListeners) {
    try { listener(interactionIds); } catch { /* ignore listener failures */ }
  }
}

export function setupOpenCodeQuestionInteractionBridge(): () => void {
  const bridge = (window as unknown as {
    netcatty?: {
      onOpenCodeQuestionRequest?: (
        cb: (payload: OpenCodeQuestionInteraction) => void,
      ) => () => void;
      onOpenCodeQuestionCleared?: (
        cb: (payload: { interactionIds: string[] }) => void,
      ) => () => void;
    };
  }).netcatty;
  if (!bridge?.onOpenCodeQuestionRequest) return () => {};

  const unsubscribeRequest = bridge.onOpenCodeQuestionRequest((interaction) => {
    if (!interaction?.interactionId || interaction.kind !== 'user-input') return;
    pendingInteractions.set(interaction.interactionId, interaction);
    for (const listener of listeners) {
      try { listener(interaction); } catch { /* ignore listener failures */ }
    }
  });
  const unsubscribeCleared = bridge.onOpenCodeQuestionCleared?.((payload) => {
    const cleared: string[] = [];
    for (const interactionId of payload?.interactionIds || []) {
      if (pendingInteractions.delete(interactionId)) cleared.push(interactionId);
    }
    notifyCleared(cleared);
  });
  return () => {
    unsubscribeRequest();
    unsubscribeCleared?.();
  };
}

export function onOpenCodeQuestionInteraction(listener: InteractionListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function onOpenCodeQuestionInteractionCleared(listener: ClearedListener): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

export function replayPendingOpenCodeQuestionInteractions(listener: InteractionListener): void {
  for (const interaction of pendingInteractions.values()) {
    try { listener(interaction); } catch { /* ignore listener failures */ }
  }
}

export async function respondOpenCodeQuestion(
  interactionId: string,
  answers: Record<string, { answers: string[] }> | null,
  options?: { reject?: boolean },
): Promise<void> {
  const id = String(interactionId || '');
  if (!id) return;
  const bridge = (window as unknown as {
    netcatty?: {
      respondOpenCodeQuestion?: (
        response: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }).netcatty;
  if (!bridge?.respondOpenCodeQuestion) {
    throw new Error('OpenCode question bridge is unavailable');
  }
  const reject = options?.reject === true
    || answers == null
    || Object.keys(answers).length === 0;
  const result = await bridge.respondOpenCodeQuestion({
    interactionId: id,
    answers: reject ? undefined : answers,
    reject,
  }) as { ok?: boolean; error?: string } | undefined;
  if (result?.ok === false) {
    throw new Error(result.error || 'Failed to respond to OpenCode question');
  }
  pendingInteractions.delete(id);
  notifyCleared([id]);
}
