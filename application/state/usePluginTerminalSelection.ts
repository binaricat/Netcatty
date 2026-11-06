import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import { getTerminalSelectionForClipboard } from '../../components/terminal/normalizeTerminalSelection';
import { publishTerminalSelectionTarget, registerTerminalSelectionSource } from '../../infrastructure/plugins/terminalSelectionRegistry';

type SelectionState = {
  sessionId: string | null;
  bootEpoch: number;
  term: Terminal | null;
  visible: boolean;
  isFocusedPane: boolean | undefined;
  connected: boolean;
  sensitive: boolean;
  normalize: boolean;
  label: string;
};

// No retained snapshots, PTY adapter, recorder, or AI context reader enters here.
export function createPluginTerminalSelectionSource(readState: () => SelectionState, instanceId: string) {
  const target = () => {
    const state = readState();
    // Undefined means solo/Focus mode; only a visible selected split pane may use true.
    if (state.visible !== true || state.isFocusedPane === false || state.connected !== true || state.sensitive !== false
      || !state.sessionId || !state.term || state.term.element?.isConnected !== true) return null;
    return { sessionId: state.sessionId, rendererId: `${instanceId}:${state.bootEpoch}`, label: state.label.slice(0, 160) || 'Terminal' };
  };
  return {
    target,
    read() {
      if (!target()) throw new Error('The selected terminal is unavailable');
      const { term, normalize } = readState();
      const range = term!.getSelectionPosition();
      // Refuse a large range before asking xterm to materialize its text.
      if (!range || Math.abs(range.end.y - range.start.y) * term!.cols + Math.abs(range.end.x - range.start.x) > 4096) {
        throw new Error('Select a bounded terminal range first');
      }
      return getTerminalSelectionForClipboard(term!, normalize);
    },
  };
}

export function usePluginTerminalSelection(key: string, readState: () => SelectionState, lifecycle: string) {
  const latest = useRef(readState);
  latest.current = readState;
  const instance = useRef<string | null>(null);
  if (instance.current === null) instance.current = crypto.randomUUID();
  useEffect(() => registerTerminalSelectionSource(key, createPluginTerminalSelectionSource(() => latest.current(), instance.current!)), [key]);
  // The target getter reads current refs. Publication revokes old renderer/boot identities.
  useEffect(() => { publishTerminalSelectionTarget(); }, [lifecycle]);
}
