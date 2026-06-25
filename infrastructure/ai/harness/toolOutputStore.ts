export interface ToolOutputHandle {
  id: string;
  capabilityId: string;
  sessionId?: string;
  totalChars: number;
  preview: string;
  storedAt: number;
  fullContent: string;
}

export interface StoreToolOutputInput {
  chatSessionId: string;
  capabilityId: string;
  content: string;
  sessionId?: string;
  previewChars?: number;
}

export interface ReadToolOutputInput {
  handleId: string;
  mode?: 'head' | 'tail' | 'full';
  maxChars?: number;
}

let handleCounter = 0;

function nextHandleId(): string {
  handleCounter += 1;
  return `tool-output-${Date.now()}-${handleCounter}`;
}

export class ToolOutputStore {
  private readonly bySession = new Map<string, Map<string, ToolOutputHandle>>();

  store(input: StoreToolOutputInput): ToolOutputHandle {
    const previewChars = input.previewChars ?? 240;
    const handle: ToolOutputHandle = {
      id: nextHandleId(),
      capabilityId: input.capabilityId,
      sessionId: input.sessionId,
      totalChars: input.content.length,
      preview: input.content.slice(0, previewChars),
      storedAt: Date.now(),
      fullContent: input.content,
    };
    const sessionMap = this.bySession.get(input.chatSessionId) ?? new Map<string, ToolOutputHandle>();
    sessionMap.set(handle.id, handle);
    this.bySession.set(input.chatSessionId, sessionMap);
    return handle;
  }

  get(handleId: string, chatSessionId?: string): ToolOutputHandle | undefined {
    if (chatSessionId) {
      return this.bySession.get(chatSessionId)?.get(handleId);
    }
    for (const sessionMap of this.bySession.values()) {
      const handle = sessionMap.get(handleId);
      if (handle) return handle;
    }
    return undefined;
  }

  listPendingHandles(chatSessionId: string): ToolOutputHandle[] {
    return [...(this.bySession.get(chatSessionId)?.values() ?? [])];
  }

  read(input: ReadToolOutputInput, chatSessionId?: string): string | null {
    const handle = this.get(input.handleId, chatSessionId);
    if (!handle) return null;
    const maxChars = input.maxChars ?? 12_000;
    const mode = input.mode ?? 'head';
    const content = handle.fullContent;
    if (mode === 'full') {
      return content.length <= maxChars ? content : content.slice(0, maxChars);
    }
    if (mode === 'tail') {
      return content.length <= maxChars ? content : content.slice(-maxChars);
    }
    return content.slice(0, maxChars);
  }

  prune(chatSessionId: string): void {
    this.bySession.delete(chatSessionId);
  }
}

export const globalToolOutputStore = new ToolOutputStore();
