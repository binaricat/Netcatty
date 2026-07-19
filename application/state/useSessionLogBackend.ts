import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";

type ManualStartPayload = {
  sessionId: string;
  sessionName?: string;
  preferredDirectory?: string;
  format?: "txt" | "raw" | "html";
  timestampsEnabled?: boolean;
  initialLine?: string;
};

type ManualStopPayload = {
  sessionId: string;
};

type ManualStatusPayload = {
  sessionId: string;
};

export const useSessionLogBackend = () => {
  const startManualSessionLog = useCallback(async (payload: ManualStartPayload) => {
    const bridge = netcattyBridge.get();
    return bridge?.startManualSessionLog?.(payload) ?? { success: false, started: false, error: "Session log bridge unavailable" };
  }, []);

  const stopManualSessionLog = useCallback(async (payload: ManualStopPayload) => {
    const bridge = netcattyBridge.get();
    return bridge?.stopManualSessionLog?.(payload) ?? { success: false, stopped: false, error: "Session log bridge unavailable" };
  }, []);

  const getManualSessionLogStatus = useCallback(async (payload: ManualStatusPayload) => {
    const bridge = netcattyBridge.get();
    return bridge?.getManualSessionLogStatus?.(payload) ?? { success: false, isLogging: false, error: "Session log bridge unavailable" };
  }, []);

  return { startManualSessionLog, stopManualSessionLog, getManualSessionLogStatus };
};
