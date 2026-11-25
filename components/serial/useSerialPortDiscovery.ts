import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTerminalBackend } from "../../application/state/useTerminalBackend";
import type { SerialPortInfo } from "../SerialAdvancedOptions";
import type { ComboboxOption } from "../ui/combobox";

export interface UseSerialPortDiscoveryOptions {
  /** Whether discovery should automatically load ports (e.g. dialog `open`). Defaults to `true`. */
  enabled?: boolean;
  /** Optional callback invoked when ports are discovered (e.g. auto-selecting the first port in SerialConnectModal). */
  onPortsLoaded?: (ports: SerialPortInfo[]) => void;
}

export interface UseSerialPortDiscoveryResult {
  ports: SerialPortInfo[];
  portOptions: ComboboxOption[];
  isLoadingPorts: boolean;
  loadPorts: () => Promise<void>;
}

export function useSerialPortDiscovery(
  options: UseSerialPortDiscoveryOptions = {},
): UseSerialPortDiscoveryResult {
  const { enabled = true, onPortsLoaded } = options;
  const terminalBackend = useTerminalBackend();
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [isLoadingPorts, setIsLoadingPorts] = useState(false);

  const onPortsLoadedRef = useRef(onPortsLoaded);
  onPortsLoadedRef.current = onPortsLoaded;

  const loadPorts = useCallback(async () => {
    setIsLoadingPorts(true);
    try {
      const result = await terminalBackend.listSerialPorts();
      setPorts(result);
      onPortsLoadedRef.current?.(result);
    } catch (err) {
      console.error("[Serial] Failed to list ports:", err);
    } finally {
      setIsLoadingPorts(false);
    }
  }, [terminalBackend]);

  useEffect(() => {
    if (enabled) {
      void loadPorts();
    }
  }, [enabled, loadPorts]);

  const portOptions: ComboboxOption[] = useMemo(
    () =>
      ports.map((port) => ({
        value: port.path,
        label: port.path,
        sublabel: port.manufacturer || undefined,
      })),
    [ports],
  );

  return {
    ports,
    portOptions,
    isLoadingPorts,
    loadPorts,
  };
}
