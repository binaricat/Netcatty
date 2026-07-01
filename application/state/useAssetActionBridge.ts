import { useEffect, useRef } from 'react';
import type { Host, TerminalSession } from '../../domain/models';
import {
  handleAssetActionOp,
  registerAssetActionHandler,
  setupAssetActionBridge,
  type AssetActionDeps,
} from '../../infrastructure/ai/assetActionBridgeClient';

export interface UseAssetActionBridgeInput {
  hosts: Host[];
  sessions: TerminalSession[];
  resolveEffectiveHost: (host: Host) => Host;
  openHost: AssetActionDeps['openHost'];
  connectHost: AssetActionDeps['connectHost'];
  closeSession: AssetActionDeps['closeSession'];
  focusSession: AssetActionDeps['focusSession'];
}

export function useAssetActionBridge(input: UseAssetActionBridgeInput): void {
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    registerAssetActionHandler(async (op, params) => {
      const current = inputRef.current;
      return handleAssetActionOp(op, params, {
        getHosts: () => current.hosts,
        getSessions: () => current.sessions,
        resolveEffectiveHost: current.resolveEffectiveHost,
        openHost: current.openHost,
        connectHost: current.connectHost,
        closeSession: current.closeSession,
        focusSession: current.focusSession,
      });
    });
    return () => {
      registerAssetActionHandler(null);
    };
  }, []);

  useEffect(() => setupAssetActionBridge(), []);
}
