import {
  clearPendingApprovalIds,
  registerExternalApproval,
} from './approvalGate';

export type CodexApprovalDecision = 'once' | 'session' | 'reject' | 'cancel';
export type CodexCommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | Record<string, unknown>;

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  /** When true, the UI collects multiple option labels for one question. */
  multiple?: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export type CodexAppServerInteraction =
  | {
      interactionId: string;
      source: 'codex-app-server';
      kind: 'command' | 'file-change' | 'permissions';
      requestId: string;
      chatSessionId: string;
      itemId?: string;
      toolName: string;
      args: Record<string, unknown>;
      availableDecisions?: CodexCommandApprovalDecision[];
    }
  | {
      interactionId: string;
      source: 'codex-app-server';
      kind: 'user-input';
      requestId: string;
      chatSessionId: string;
      itemId?: string;
      questions: CodexUserInputQuestion[];
      autoResolutionMs?: number | null;
    };

type InteractionListener = (interaction: CodexAppServerInteraction) => void;
type ClearedListener = (interactionIds: string[]) => void;

const pendingInteractions = new Map<string, CodexAppServerInteraction>();
const listeners = new Set<InteractionListener>();
const clearedListeners = new Set<ClearedListener>();

function registerCodexApproval(
  interaction: Extract<CodexAppServerInteraction, { kind: 'command' | 'file-change' | 'permissions' }>,
): void {
  const allowSession = interaction.kind === 'command'
    ? interaction.availableDecisions?.includes('acceptForSession') === true
    : true;
  registerExternalApproval({
    toolCallId: interaction.interactionId,
    itemId: interaction.itemId,
    toolName: interaction.toolName,
    args: interaction.args,
    chatSessionId: interaction.chatSessionId,
    source: 'codex-app-server',
    approvalType: interaction.kind,
    allowSession,
  }, (resolution) => {
    const decision: CodexApprovalDecision = resolution.cancelled
      ? 'cancel'
      : resolution.approved
        ? resolution.scope
        : 'reject';
    void respondCodexApproval(interaction.interactionId, decision).catch((error) => {
      console.error('[Codex App Server] Failed to respond to approval:', error);
      if (pendingInteractions.has(interaction.interactionId)) registerCodexApproval(interaction);
    });
  });
}

function notifyCleared(interactionIds: string[]): void {
  if (interactionIds.length === 0) return;
  for (const listener of clearedListeners) {
    try { listener(interactionIds); } catch { /* ignore listener failures */ }
  }
}

export function setupCodexAppServerInteractionBridge(): () => void {
  const bridge = (window as unknown as {
    netcatty?: {
      onCodexAppServerInteractionRequest?: (
        cb: (payload: CodexAppServerInteraction) => void,
      ) => () => void;
      onCodexAppServerInteractionCleared?: (
        cb: (payload: { interactionIds: string[] }) => void,
      ) => () => void;
    };
  }).netcatty;
  if (!bridge?.onCodexAppServerInteractionRequest) return () => {};

  const unsubscribeRequest = bridge.onCodexAppServerInteractionRequest((interaction) => {
    if (!interaction?.interactionId) return;
    pendingInteractions.set(interaction.interactionId, interaction);
    if (interaction.kind !== 'user-input') {
      registerCodexApproval(interaction);
      return;
    }
    for (const listener of listeners) {
      try { listener(interaction); } catch { /* ignore listener failures */ }
    }
  });
  const unsubscribeCleared = bridge.onCodexAppServerInteractionCleared?.((payload) => {
    const cleared: string[] = [];
    for (const interactionId of payload?.interactionIds || []) {
      if (pendingInteractions.delete(interactionId)) cleared.push(interactionId);
    }
    clearPendingApprovalIds(cleared);
    notifyCleared(cleared);
  });
  return () => {
    unsubscribeRequest();
    unsubscribeCleared?.();
  };
}

export function onCodexAppServerInteraction(listener: InteractionListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function onCodexAppServerInteractionCleared(listener: ClearedListener): () => void {
  clearedListeners.add(listener);
  return () => { clearedListeners.delete(listener); };
}

export function replayPendingCodexAppServerInteractions(listener: InteractionListener): void {
  for (const interaction of pendingInteractions.values()) {
    if (interaction.kind !== 'user-input') continue;
    try { listener(interaction); } catch { /* ignore listener failures */ }
  }
}

async function respond(payload: Record<string, unknown>): Promise<void> {
  const interactionId = String(payload.interactionId || '');
  if (!interactionId) return;
  const bridge = (window as unknown as {
    netcatty?: {
      respondCodexAppServerInteraction?: (
        response: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }).netcatty;
  if (!bridge?.respondCodexAppServerInteraction) {
    throw new Error('Codex App Server interaction bridge is unavailable');
  }
  const result = await bridge.respondCodexAppServerInteraction(payload) as { ok?: boolean; error?: string } | undefined;
  if (result?.ok === false) {
    throw new Error(result.error || 'Failed to respond to Codex App Server interaction');
  }
  pendingInteractions.delete(interactionId);
  notifyCleared([interactionId]);
}

export function respondCodexApproval(
  interactionId: string,
  decision: CodexApprovalDecision,
): Promise<void> {
  return respond({ interactionId, decision });
}

export function respondCodexUserInput(
  interactionId: string,
  answers: Record<string, { answers: string[] }>,
): Promise<void> {
  return respond({ interactionId, answers });
}
