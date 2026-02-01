import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export const useKeychainBackend = () => {
  const generateKeyPair = useCallback(async (options: { type: "RSA" | "ECDSA" | "ED25519"; bits?: number; comment?: string }) => {
    const bridge = netcattyBridge.get();
    return bridge?.generateKeyPair?.(options);
  }, []);

  const execCommand = useCallback(async (options: {
    hostname: string;
    username: string;
    port?: number;
    password?: string;
    privateKey?: string;
    command: string;
    timeout?: number;
    enableKeyboardInteractive?: boolean;
    sessionId?: string;
  }) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.execCommand) throw new Error("execCommand unavailable");
    return bridge.execCommand(options);
  }, []);

  return { generateKeyPair, execCommand };
};

