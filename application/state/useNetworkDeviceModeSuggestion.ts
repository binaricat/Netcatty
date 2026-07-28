import { useCallback, useEffect, useState } from 'react';

import { getEffectiveHostDistro, shouldSuggestNetworkDeviceMode } from '../../domain/host';
import { isSavedVaultHost } from '../../domain/ephemeralHosts';
import { resolveEffectiveTerminalProtocol } from '../../domain/terminalProtocol';
import type { Host } from '../../domain/models';
import {
  isNetworkDeviceSuggestionHandled,
  markNetworkDeviceSuggestionShown,
  resolveNetworkDeviceSuggestion,
  subscribeNetworkDeviceSuggestionHandled,
} from './networkDeviceModeSuggestion';

export interface NetworkDeviceModeSuggestion {
  /** Whether the one-line tip should be rendered for this session. */
  visible: boolean;
  /** User accepted: persist + hide, then run the caller's enable side effects. */
  enable: () => void;
  /** User dismissed: persist + hide. */
  dismiss: () => void;
}

/**
 * Owns the lifecycle of the "enable Network Device Mode" suggestion for a single
 * terminal session: eligibility, the once-per-host persistence boundary, and
 * cross-pane/window synchronization. Components consume `visible`/`enable`/
 * `dismiss` and keep their own view/side-effect glue (host update, toast).
 *
 * `visible` is a latch rather than a live predicate: once we decide to show the
 * tip we record the display (which also suppresses reconnects and other panes)
 * and keep it visible until the user acts, the host is classified elsewhere, or
 * another surface resolves it.
 */
export function useNetworkDeviceModeSuggestion({
  host,
  connected,
  canUpdateHost,
  onEnable,
}: {
  host: Host;
  connected: boolean;
  canUpdateHost: boolean;
  onEnable: () => void;
}): NetworkDeviceModeSuggestion {
  const [visible, setVisible] = useState(false);

  // Reset on host change and hide when the suggestion is resolved elsewhere
  // (another pane or window) for this host. Declared before the eligibility
  // effect so, on mount, the reset (a no-op false->false) runs first and cannot
  // clobber the latch the eligibility effect sets below.
  useEffect(() => {
    setVisible(false);
    return subscribeNetworkDeviceSuggestionHandled((changedHostId) => {
      if (changedHostId === host.id) setVisible(false);
    });
  }, [host.id]);

  useEffect(() => {
    if (visible) return;
    // Enabling writes back through onEnable, which only lands for vault hosts.
    // Skip when updates can't persist: the detached popup (no host updates) and
    // ephemeral deep-link hosts (not in the vault array).
    if (!connected || !canUpdateHost || !isSavedVaultHost(host)) return;
    const eligible = shouldSuggestNetworkDeviceMode({
      host,
      detectedDistro: getEffectiveHostDistro(host),
      alreadyHandled: isNetworkDeviceSuggestionHandled(host.id),
      // Match the Host Details toggle: only plain SSH (not Mosh/ET/serial/etc.).
      effectiveProtocol: resolveEffectiveTerminalProtocol(host),
    });
    if (!eligible) return;
    // Record the display silently so reconnects and later-mounting panes stay
    // quiet, but this instance keeps the tip until the user acts.
    markNetworkDeviceSuggestionShown(host.id);
    setVisible(true);
  }, [visible, connected, canUpdateHost, host]);

  useEffect(() => {
    // The mode may be enabled from another surface (Host Details, a synced
    // pane) while the tip is latched open; drop it as soon as the host is
    // already classified so we don't keep offering an enabled action.
    if (host.deviceType === 'network') setVisible(false);
  }, [host.deviceType]);

  const dismiss = useCallback(() => {
    resolveNetworkDeviceSuggestion(host.id);
    setVisible(false);
  }, [host.id]);

  const enable = useCallback(() => {
    resolveNetworkDeviceSuggestion(host.id);
    setVisible(false);
    onEnable();
  }, [host.id, onEnable]);

  return { visible, enable, dismiss };
}
