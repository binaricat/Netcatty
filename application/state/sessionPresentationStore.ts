import { useSyncExternalStore } from 'react';

import type { CodingCliProviderId } from '../../domain/codingCliProviders';

export type SessionPresentation = {
  dynamicTitle?: string | null;
  promptHostname?: string | null;
  promptHostnameFromJumpServer?: boolean | null;
  codingCliProviderId?: CodingCliProviderId | null;
};

type Listener = () => void;

/** Encode undefined / null / present distinctly for useSyncExternalStore snapshots. */
function encodePresentationField(value: string | boolean | null | undefined): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  return `v:${value}`;
}

/**
 * Presentation-only session chrome (tab title / coding-CLI icon) separate from
 * structural session identity used by TerminalLayer pane equality.
 */
class SessionPresentationStore {
  private bySession = new Map<string, SessionPresentation>();
  private version = 0;
  private listeners = new Set<Listener>();

  getVersion = (): number => this.version;

  getPresentation = (sessionId: string): SessionPresentation | undefined =>
    this.bySession.get(sessionId);

  /**
   * Stable per-session snapshot for useSyncExternalStore. Global listeners still
   * fire on any change, but React skips re-render when this string is unchanged
   * for the subscribed sessionId (Object.is).
   *
   * Encodes undefined / null / value distinctly so a null tombstone is not
   * Object.is-equal to a missing field (both used to collapse to '').
   */
  getSessionSnapshot = (sessionId: string): string => {
    const presentation = this.bySession.get(sessionId);
    if (!presentation) return '';
    return `${encodePresentationField(presentation.dynamicTitle)}\0${encodePresentationField(presentation.promptHostname)}\0${encodePresentationField(presentation.promptHostnameFromJumpServer)}\0${encodePresentationField(presentation.codingCliProviderId)}`;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setPresentation(sessionId: string, patch: SessionPresentation): void {
    const prev = this.bySession.get(sessionId) ?? {};
    const next: SessionPresentation = { ...prev, ...patch };
    // Distinguish missing (undefined) from explicit clear (null) so the first
    // tombstone is stored even when the session snapshot still has a stale
    // title/provider and the store had no prior entry.
    if (
      prev.dynamicTitle === next.dynamicTitle
      && prev.promptHostname === next.promptHostname
      && prev.promptHostnameFromJumpServer === next.promptHostnameFromJumpServer
      && prev.codingCliProviderId === next.codingCliProviderId
    ) {
      return;
    }
    this.bySession.set(sessionId, next);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  clearSession(sessionId: string): void {
    if (!this.bySession.has(sessionId)) return;
    this.bySession.delete(sessionId);
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  prune(validSessionIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of this.bySession.keys()) {
      if (!validSessionIds.has(id)) {
        this.bySession.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

export const sessionPresentationStore = new SessionPresentationStore();

export function publishSessionDynamicTitle(sessionId: string, title: string | null): void {
  sessionPresentationStore.setPresentation(sessionId, { dynamicTitle: title });
}

export function publishSessionCodingCliProvider(
  sessionId: string,
  providerId: CodingCliProviderId | null,
): void {
  sessionPresentationStore.setPresentation(sessionId, { codingCliProviderId: providerId });
}

export function publishSessionPromptHost(
  sessionId: string,
  hostname: string | null,
  options: { fromJumpServer?: boolean } = {},
): void {
  sessionPresentationStore.setPresentation(sessionId, {
    promptHostname: hostname,
    promptHostnameFromJumpServer: hostname && options.fromJumpServer === true ? true : null,
  });
}

type SessionWithPresentation = {
  id: string;
  dynamicTitle?: string;
  promptHostname?: string;
  promptHostnameFromJumpServer?: boolean;
  codingCliProviderId?: CodingCliProviderId;
};

/**
 * Overlay live presentation chrome onto a session snapshot.
 * Used by TopTabs, focus sidebar, and pane chrome so title/provider updates
 * stay live without structural setSessions thrash.
 */
export function applySessionPresentation<T extends SessionWithPresentation>(session: T): T {
  const presentation = sessionPresentationStore.getPresentation(session.id);
  if (!presentation) return session;
  const nextTitle = presentation.dynamicTitle === undefined
    ? session.dynamicTitle
    : (presentation.dynamicTitle ?? undefined);
  const nextPromptHost = presentation.promptHostname === undefined
    ? session.promptHostname
    : (presentation.promptHostname ?? undefined);
  const nextPromptHostFromJumpServer = presentation.promptHostnameFromJumpServer === undefined
    ? session.promptHostnameFromJumpServer
    : (presentation.promptHostnameFromJumpServer ?? undefined);
  const nextProvider = presentation.codingCliProviderId === undefined
    ? session.codingCliProviderId
    : (presentation.codingCliProviderId ?? undefined);
  if (
    nextTitle === session.dynamicTitle
    && nextPromptHost === session.promptHostname
    && nextPromptHostFromJumpServer === session.promptHostnameFromJumpServer
    && nextProvider === session.codingCliProviderId
  ) {
    return session;
  }
  return {
    ...session,
    dynamicTitle: nextTitle,
    promptHostname: nextPromptHost,
    promptHostnameFromJumpServer: nextPromptHostFromJumpServer,
    codingCliProviderId: nextProvider,
  };
}

/** Subscribe to live title/provider chrome version for multi-session consumers. */
export function useSessionPresentationVersion(): number {
  return useSyncExternalStore(
    sessionPresentationStore.subscribe,
    sessionPresentationStore.getVersion,
    sessionPresentationStore.getVersion,
  );
}

/**
 * Per-session presentation snapshot. Other sessions' title updates notify the
 * store but do not re-render this consumer when its own snapshot is unchanged.
 */
export function useSessionPresentationSnapshot(sessionId: string): string {
  return useSyncExternalStore(
    sessionPresentationStore.subscribe,
    () => sessionPresentationStore.getSessionSnapshot(sessionId),
    () => sessionPresentationStore.getSessionSnapshot(sessionId),
  );
}

/** Session snapshot with live presentation overlay applied (single session). */
export function usePresentedSession<T extends SessionWithPresentation>(session: T): T {
  useSessionPresentationSnapshot(session.id);
  return applySessionPresentation(session);
}
