import { globalTraceStore } from './traceStore';
import { stopAgentTurn } from './agentStop';
import type { AgentBackend, AgentEvent, AgentEventListener } from './types';
import { ToolOutputStore } from './toolOutputStore';
import { ToolResultDedup } from './toolResultDedup';
import type { TurnDriver, TurnInput, TurnResult } from './turnDrivers/types';

let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  return `turn-${Date.now()}-${turnCounter}`;
}

interface ActiveTurn {
  turnId: string;
  backend: AgentBackend;
  driver: TurnDriver;
}

export interface AgentRuntimeOptions {
  drivers: TurnDriver[];
  traceStore?: typeof globalTraceStore;
}

export class AgentRuntime {
  private readonly drivers = new Map<AgentBackend, TurnDriver>();
  private readonly listeners = new Set<AgentEventListener>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly activeTurnPromises = new Map<string, Promise<TurnResult>>();
  private readonly toolOutputStores = new Map<string, ToolOutputStore>();
  private readonly traceStore: typeof globalTraceStore;

  constructor(options: AgentRuntimeOptions) {
    for (const driver of options.drivers) {
      this.drivers.set(driver.backend, driver);
    }
    this.traceStore = options.traceStore ?? globalTraceStore;
  }

  getToolOutputStore(chatSessionId: string): ToolOutputStore {
    let store = this.toolOutputStores.get(chatSessionId);
    if (!store) {
      store = new ToolOutputStore();
      this.toolOutputStores.set(chatSessionId, store);
    }
    return store;
  }

  clearChatSession(chatSessionId: string): void {
    this.toolOutputStores.get(chatSessionId)?.prune(chatSessionId);
    this.toolOutputStores.delete(chatSessionId);
  }

  async waitForActiveTurn(chatSessionId: string): Promise<void> {
    await this.activeTurnPromises.get(chatSessionId)?.catch(() => {});
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const driver = this.drivers.get(input.backend);
    if (!driver) {
      throw new Error(`No TurnDriver registered for backend "${input.backend}"`);
    }

    const chatSessionId = input.chatSessionId;
    const priorTurn = this.activeTurnPromises.get(chatSessionId);
    if (priorTurn) {
      await priorTurn.catch(() => {});
    }

    const turnPromise = this.runTurnInternal(input, driver);
    this.activeTurnPromises.set(chatSessionId, turnPromise);
    try {
      return await turnPromise;
    } finally {
      if (this.activeTurnPromises.get(chatSessionId) === turnPromise) {
        this.activeTurnPromises.delete(chatSessionId);
      }
    }
  }

  private async runTurnInternal(input: TurnInput, driver: TurnDriver): Promise<TurnResult> {
    const turnId = nextTurnId();
    const chatSessionId = input.chatSessionId;
    const toolOutputStore = this.getToolOutputStore(chatSessionId);
    const toolResultDedup = new ToolResultDedup();
    toolResultDedup.beginTurn();

    this.activeTurns.set(chatSessionId, {
      turnId,
      backend: input.backend,
      driver,
    });

    const emit = (
      partial: Omit<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'>
        & Partial<Pick<AgentEvent, 'turnId' | 'sessionId' | 'chatSessionId' | 'backend' | 'timestamp'>>,
    ) => {
      const event = {
        id: partial.id,
        type: partial.type,
        sessionId: partial.sessionId ?? chatSessionId,
        chatSessionId: partial.chatSessionId ?? chatSessionId,
        backend: partial.backend ?? input.backend,
        timestamp: partial.timestamp ?? Date.now(),
        turnId: partial.turnId ?? turnId,
        ...partial,
      } as AgentEvent;
      this.traceStore.append(event);
      for (const listener of this.listeners) {
        listener(event);
      }
    };

    emit({
      id: `turn-start-${turnId}`,
      type: 'turn_start',
      backendLabel: input.backend === 'external-sdk'
        ? ('agentConfig' in input ? input.agentConfig.name : undefined)
        : 'catty',
    } as AgentEvent);

    let reason: TurnResult['reason'] = 'completed';

    try {
      await driver.run(input, {
        turnId,
        chatSessionId,
        sessionId: chatSessionId,
        backend: input.backend,
        signal: input.signal,
        emit,
        toolOutputStore,
        toolResultDedup,
      });
      if (input.signal.aborted) {
        reason = 'aborted';
      }
    } catch (err) {
      reason = 'error';
      emit({
        id: `turn-error-${turnId}`,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      } as AgentEvent);
      throw err;
    } finally {
      emit({
        id: `turn-end-${turnId}`,
        type: 'turn_end',
        reason,
      } as AgentEvent);
      this.activeTurns.delete(chatSessionId);
    }

    return { turnId, reason };
  }

  async stopTurn(chatSessionId: string, reason: 'user' | 'slash' = 'user'): Promise<void> {
    const active = this.activeTurns.get(chatSessionId);
    active?.driver.abort?.(chatSessionId);
    await stopAgentTurn({
      chatSessionId,
      reason,
      backend: active?.backend ?? 'catty',
    });
    await this.waitForActiveTurn(chatSessionId);
  }
}
