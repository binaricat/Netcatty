import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

export const useClipboardBackend = () => {
  const readClipboardText = useCallback(async (): Promise<string> => {
    const bridge = netcattyBridge.get();
    if (!bridge?.readClipboardText) throw new Error("clipboard bridge unavailable");

    const text = await bridge.readClipboardText();
    return typeof text === "string" ? text : "";
  }, []);

  const writeClipboardText = useCallback(async (text: string): Promise<boolean> => {
    const bridge = netcattyBridge.get();
    if (!bridge?.writeClipboardText) return false;
    return await bridge.writeClipboardText(text) === true;
  }, []);

  return { readClipboardText, writeClipboardText };
};
