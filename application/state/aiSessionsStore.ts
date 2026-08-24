import { useSyncExternalStore } from 'react';

import type { AISession } from '../../infrastructure/ai/types';
import { draftsByScopeEqualIgnoringAllComposerText } from './aiDraftState';
import type { DraftsByScope, PanelViewByScope } from './aiStateSnapshots';

type Listener = () => void;

export type AISessionsSnapshot = {
  sessions: readonly AISession[];
  activeSessionIdMap: Readonly<Record<string, string | null>>;
  draftsByScope: DraftsByScope;
  panelViewByScope: PanelViewByScope;
};

const EMPTY_SESSIONS: readonly AISession[] = Object.freeze([]);
const EMPTY_MAP: Readonly<Record<string, string | null>> = Object.freeze({});
const EMPTY_DRAFTS: DraftsByScope = Object.freeze({});
const EMPTY_PANEL: PanelViewByScope = Object.freeze({});

export const EMPTY_AI_SESSIONS_SNAPSHOT: AISessionsSnapshot = Object.freeze({
  sessions: EMPTY_SESSIONS,
  activeSessionIdMap: EMPTY_MAP,
  draftsByScope: EMPTY_DRAFTS,
  panelViewByScope: EMPTY_PANEL,
});

/**
 * Hot AI chat state — streaming message updates must not invalidate
 * slow AI config Context consumers (providers, permissions, etc.).
 */
class AISessionsStore {
  private snapshot: AISessionsSnapshot = EMPTY_AI_SESSIONS_SNAPSHOT;
  private listeners = new Set<Listener>();

  getSnapshot = (): AISessionsSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSnapshot(next: AISessionsSnapshot): void {
    if (
      this.snapshot.sessions === next.sessions
      && this.snapshot.activeSessionIdMap === next.activeSessionIdMap
      && this.snapshot.draftsByScope === next.draftsByScope
      && this.snapshot.panelViewByScope === next.panelViewByScope
    ) {
      return;
    }
    const textOnlyDraftChange =
      this.snapshot.sessions === next.sessions
      && this.snapshot.activeSessionIdMap === next.activeSessionIdMap
      && this.snapshot.panelViewByScope === next.panelViewByScope
      && draftsByScopeEqualIgnoringAllComposerText(
        this.snapshot.draftsByScope,
        next.draftsByScope,
      );
    this.snapshot = next;
    if (textOnlyDraftChange) return;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const aiSessionsStore = new AISessionsStore();

export function publishAISessionsSnapshot(snapshot: AISessionsSnapshot): void {
  aiSessionsStore.setSnapshot(snapshot);
}

export function getAISessionsSnapshot(): AISessionsSnapshot {
  return aiSessionsStore.getSnapshot();
}

export function subscribeAISessions(listener: Listener): () => void {
  return aiSessionsStore.subscribe(listener);
}

export function useAISessionsStore(): AISessionsSnapshot {
  return useSyncExternalStore(
    subscribeAISessions,
    getAISessionsSnapshot,
    getAISessionsSnapshot,
  );
}
