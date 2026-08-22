import { useSyncExternalStore } from 'react';

import type { Host, PortForwardingRule } from '../../domain/models';
import type { VaultSection } from '../../components/VaultView';
import type { KeyboardInteractiveRequest } from '../../components/KeyboardInteractiveModal';
import type { PassphraseRequest } from '../../components/PassphraseModal';
import type { FidoPromptRequest } from '../../components/FidoPromptModal';

type Listener = () => void;

/**
 * Dialog / queue / ephemeral UI owned outside the vault/session/settings
 * mega hooks. DialogsHost / VaultHost / TerminalHost subscribe here so
 * AppSideEffects never has to rebuild domain bags when a modal opens.
 *
 * `portForwardingRules` is published here as a thin derived slice: the PF
 * hook still lives in AppSideEffects (tray / sync / auto-start), but Hosts
 * must not receive a prepared terminal domain bag.
 */
export type AppLocalUiSnapshot = {
  isQuickSwitcherOpen: boolean;
  isCreateWorkspaceOpen: boolean;
  addToWorkspaceDialog:
    | { mode: 'append'; workspaceId: string }
    | { mode: 'create' }
    | null;
  quickSearch: string;
  protocolSelectHost: Host | null;
  navigateToSection: VaultSection | null;
  deepLinkHostDraft: Host | null;
  ephemeralHosts: readonly Host[];
  portForwardingRules: readonly PortForwardingRule[];
  keyboardInteractiveQueue: readonly KeyboardInteractiveRequest[];
  passphraseQueue: readonly PassphraseRequest[];
  fidoPromptQueue: readonly FidoPromptRequest[];
  deleteHostConfirm: { hostId: string; name: string } | null;
  vaultFocusRequest: unknown;
  openNoteRequest: unknown;
  emptyVaultConflict: unknown;
};

export const EMPTY_APP_LOCAL_UI: AppLocalUiSnapshot = Object.freeze({
  isQuickSwitcherOpen: false,
  isCreateWorkspaceOpen: false,
  addToWorkspaceDialog: null,
  quickSearch: '',
  protocolSelectHost: null,
  navigateToSection: null,
  deepLinkHostDraft: null,
  ephemeralHosts: Object.freeze([]) as readonly Host[],
  portForwardingRules: Object.freeze([]) as readonly PortForwardingRule[],
  keyboardInteractiveQueue: Object.freeze([]) as readonly KeyboardInteractiveRequest[],
  passphraseQueue: Object.freeze([]) as readonly PassphraseRequest[],
  fidoPromptQueue: Object.freeze([]) as readonly FidoPromptRequest[],
  deleteHostConfirm: null,
  vaultFocusRequest: null,
  openNoteRequest: null,
  emptyVaultConflict: null,
});
class AppLocalUiStore {
  private snapshot: AppLocalUiSnapshot = EMPTY_APP_LOCAL_UI;
  private listeners = new Set<Listener>();

  getSnapshot = (): AppLocalUiSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSnapshot(next: AppLocalUiSnapshot): void {
    const prev = this.snapshot;
    if (
      prev.isQuickSwitcherOpen === next.isQuickSwitcherOpen
      && prev.isCreateWorkspaceOpen === next.isCreateWorkspaceOpen
      && prev.addToWorkspaceDialog === next.addToWorkspaceDialog
      && prev.quickSearch === next.quickSearch
      && prev.protocolSelectHost === next.protocolSelectHost
      && prev.navigateToSection === next.navigateToSection
      && prev.deepLinkHostDraft === next.deepLinkHostDraft
      && prev.ephemeralHosts === next.ephemeralHosts
      && prev.portForwardingRules === next.portForwardingRules
      && prev.keyboardInteractiveQueue === next.keyboardInteractiveQueue
      && prev.passphraseQueue === next.passphraseQueue
      && prev.fidoPromptQueue === next.fidoPromptQueue
      && prev.deleteHostConfirm === next.deleteHostConfirm
      && prev.vaultFocusRequest === next.vaultFocusRequest
      && prev.openNoteRequest === next.openNoteRequest
      && prev.emptyVaultConflict === next.emptyVaultConflict
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

export const appLocalUiStore = new AppLocalUiStore();

export function publishAppLocalUi(snapshot: AppLocalUiSnapshot): void {
  appLocalUiStore.setSnapshot(snapshot);
}

export function getAppLocalUiSnapshot(): AppLocalUiSnapshot {
  return appLocalUiStore.getSnapshot();
}

export function subscribeAppLocalUi(listener: Listener): () => void {
  return appLocalUiStore.subscribe(listener);
}

export function useAppLocalUiStore(): AppLocalUiSnapshot {
  return useSyncExternalStore(
    subscribeAppLocalUi,
    getAppLocalUiSnapshot,
    getAppLocalUiSnapshot,
  );
}
