import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';

import { useEditorTabChromeList } from '../../state/editorTabStore';
import { getAppHandlers, subscribeAppHandlers } from '../appHandlersBridge';
import {
  publishAppShellDomainSlice,
  publishAppShellOverlays,
} from '../appShellPropsStore';
import { useAppLocalUiStore } from '../appLocalUiStore';

/**
 * Dialogs island: local dialog/queue state from `appLocalUiStore`. The quick
 * switcher owns its query and host results (QuickSwitcherOverlay), so typing
 * there no longer republishes this bag.
 * Assembles dialogs + overlays field-by-field — never spreads a prepared bag.
 */
export function DialogsHost() {
  const local = useAppLocalUiStore();
  const editorTabs = useEditorTabChromeList();
  const handlers = useSyncExternalStore(
    subscribeAppHandlers,
    getAppHandlers,
    getAppHandlers,
  );

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
      resolveEmptyVaultConflict: handlers.resolveEmptyVaultConflict,
      setAddToWorkspaceDialog: handlers.setAddToWorkspaceDialog,
      setIsCreateWorkspaceOpen: handlers.setIsCreateWorkspaceOpen,
      setIsQuickSwitcherOpen: handlers.setIsQuickSwitcherOpen,
      setProtocolSelectHost: handlers.setProtocolSelectHost,
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
