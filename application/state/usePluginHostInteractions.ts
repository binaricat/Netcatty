import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostInteractionPrompt, HostInteractionRequest, HostInteractionResponse } from '@netcatty/plugin-contract';
import { readPluginTerminalSelection } from '../../infrastructure/plugins/terminalSelectionRegistry';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export function usePluginHostInteractions() {
  type UiPrompt = Omit<HostInteractionPrompt, 'request'> & { request: HostInteractionRequest };
  const [prompt, setPrompt] = useState<UiPrompt | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef<UiPrompt | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onPluginInteraction || !bridge.setPluginInteractionReady) return;
    const unsubscribe = bridge.onPluginInteraction((event) => {
      if ('closed' in event) {
        if (current.current?.requestId !== event.requestId) return;
        current.current = null; setPrompt(null);
      } else {
        if (event.request.kind.startsWith('vault.')) return;
        current.current = event as UiPrompt;
        if (event.request.kind === 'terminal.selection.read' && event.phase === 'request') {
          setPrompt(null);
          try {
            const selection = readPluginTerminalSelection(event.terminalSessionId ?? '', event.terminalRendererId ?? '');
            void bridge.respondPluginInteraction?.({ requestId: event.requestId, actionToken: event.actionToken, action: 'preview', value: selection }).catch(() => {
              void bridge.respondPluginInteraction?.({ requestId: event.requestId, actionToken: event.actionToken, action: 'cancel' }).catch(() => {});
            });
          } catch { void bridge.respondPluginInteraction?.({ requestId: event.requestId, actionToken: event.actionToken, action: 'cancel' }).catch(() => {}); }
        } else setPrompt(event as UiPrompt);
        setValue(event.request.kind === 'input' ? event.request.initialValue ?? '' : event.request.kind === 'terminal.input.propose' ? event.request.text : '');
      }
      pending.current = false; setBusy(false); setError(false);
    });
    void bridge.setPluginInteractionReady(true).catch(() => {});
    return () => {
      current.current = null;
      unsubscribe();
      void bridge.setPluginInteractionReady?.(false).catch(() => {});
    };
  }, []);
  const respond = useCallback(async (action: HostInteractionResponse['action']) => {
    const active = current.current;
    if (!active || pending.current) return;
    pending.current = true; setBusy(true); setError(false);
    try {
      const bridge = netcattyBridge.require();
      if (!bridge.respondPluginInteraction) throw new Error('Host interactions unavailable');
      const selection = action === 'preview' && active.request.kind === 'terminal.selection.read'
        ? readPluginTerminalSelection(active.terminalSessionId ?? '', active.terminalRendererId ?? '') : undefined;
      const accepted = await bridge.respondPluginInteraction({
        requestId: active.requestId, actionToken: active.actionToken, action,
        ...(selection === undefined ? {} : { value: selection }),
        ...(action === 'submit' && (active.request.kind === 'input' || active.request.kind === 'quickPick') ? { value } : {}),
      });
      if (!accepted && current.current?.actionToken === active.actionToken) {
        current.current = null; setPrompt(null);
      }
    } catch {
      if (current.current?.actionToken === active.actionToken) setError(true);
    } finally {
      if (current.current?.actionToken === active.actionToken) { pending.current = false; setBusy(false); }
    }
  }, [value]);
  return { prompt, value, setValue, error, busy, respond };
}
