import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';

import { getHostSearchMatch } from '../../../lib/searchMatcher';
import type { Host } from '../../../types';
import { useEditorTabChromeList } from '../../state/editorTabStore';
import { useVaultSnapshot } from '../../state/vaultSnapshotStore';
import { getAppHandlers, subscribeAppHandlers } from '../appHandlersBridge';
import {
  publishAppShellDomainSlice,
  publishAppShellOverlays,
} from '../appShellPropsStore';
import { useAppLocalUiStore } from '../appLocalUiStore';

const EMPTY_HOST_RESULTS: Host[] = [];

/**
 * Dialogs island: local dialog/queue state from `appLocalUiStore`, plus a
 * selective vault hosts subscription for quick-search results when open.
 * Assembles dialogs + overlays field-by-field — never spreads a prepared bag.
 */
export function DialogsHost() {
  const local = useAppLocalUiStore();
  const vault = useVaultSnapshot();
  const editorTabs = useEditorTabChromeList();
  const handlers = useSyncExternalStore(
    subscribeAppHandlers,
    getAppHandlers,
    getAppHandlers,
  );

  const quickResults = useMemo(() => {
    if (!local.isQuickSwitcherOpen) return EMPTY_HOST_RESULTS;
    const term = local.quickSearch.trim();
    if (!term) return vault.hosts as Host[];
    return (vault.hosts as Host[])
      .map((host) => ({ host, match: getHostSearchMatch(term, host) }))
      .filter((entry) => entry.match.matched)
      .sort((left, right) => {
        if (left.match.score !== right.match.score) {
          return right.match.score - left.match.score;
        }
        return left.host.label.localeCompare(right.host.label);
      })
      .map((entry) => entry.host);
  }, [local.isQuickSwitcherOpen, local.quickSearch, vault.hosts]);

  const dialogsDomain = useMemo(() => {
    if (!handlers) return null;
    return {
      addToWorkspaceDialog: local.addToWorkspaceDialog,
      clearAndRemoveSource: handlers.clearAndRemoveSource,
      clearAndRemoveSources: handlers.clearAndRemoveSources,
      editorTabs,
      emptyVaultConflict: local.emptyVaultConflict,
      handleHostConnectWithProtocolCheck: handlers.handleHostConnectWithProtocolCheck,
      handleKeyboardInteractiveCancel: handlers.handleKeyboardInteractiveCancel,
      handleKeyboardInteractiveSubmit: handlers.handleKeyboardInteractiveSubmit,
      handlePassphraseCancel: handlers.handlePassphraseCancel,
      handlePassphraseSkip: handlers.handlePassphraseSkip,
      handlePassphraseSubmit: handlers.handlePassphraseSubmit,
      handleFidoPromptCancel: handlers.handleFidoPromptCancel,
      handleFidoPromptSubmit: handlers.handleFidoPromptSubmit,
      handleProtocolSelect: handlers.handleProtocolSelect,
      handleRequestCloseEditorTabRef: handlers.handleRequestCloseEditorTabRef,
      isCreateWorkspaceOpen: local.isCreateWorkspaceOpen,
      isQuickSwitcherOpen: local.isQuickSwitcherOpen,
      keyboardInteractiveQueue: local.keyboardInteractiveQueue,
      passphraseQueue: local.passphraseQueue,
      fidoPromptQueue: local.fidoPromptQueue,
      protocolSelectHost: local.protocolSelectHost,
      quickResults,
      quickSearch: local.quickSearch,
      resolveEmptyVaultConflict: handlers.resolveEmptyVaultConflict,
      setAddToWorkspaceDialog: handlers.setAddToWorkspaceDialog,
      setIsCreateWorkspaceOpen: handlers.setIsCreateWorkspaceOpen,
      setIsQuickSwitcherOpen: handlers.setIsQuickSwitcherOpen,
      setProtocolSelectHost: handlers.setProtocolSelectHost,
      setQuickSearch: handlers.setQuickSearch,
    };
  }, [
    editorTabs,
    handlers,
    local.addToWorkspaceDialog,
    local.emptyVaultConflict,
    local.isCreateWorkspaceOpen,
    local.isQuickSwitcherOpen,
    local.keyboardInteractiveQueue,
    local.passphraseQueue,
    local.fidoPromptQueue,
    local.protocolSelectHost,
    local.quickSearch,
    quickResults,
  ]);

  const overlays = useMemo(() => {
    if (!handlers) return null;
    return {
      onAddKnownHost: handlers.handleAddKnownHost as (knownHost: never) => void,
      deleteHostConfirm: local.deleteHostConfirm,
      onCancelDeleteHost: handlers.handleCancelDeleteHost as () => void,
      onConfirmDeleteHost: handlers.handleConfirmDeleteHost as () => void,
    };
  }, [handlers, local.deleteHostConfirm]);

  useLayoutEffect(() => {
    if (dialogsDomain) publishAppShellDomainSlice('dialogs', dialogsDomain);
    if (overlays) publishAppShellOverlays(overlays as never);
  }, [dialogsDomain, overlays]);

  return null;
}
