import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { SettingsFocusTarget } from "./settingsFocus";

export type SettingsFocusRequest = SettingsFocusTarget & {
  nonce: number;
};

type SettingsFocusContextValue = {
  request: SettingsFocusRequest | null;
  requestFocus: (target: SettingsFocusTarget) => void;
  clearFocus: () => void;
};

const SettingsFocusContext = createContext<SettingsFocusContextValue | null>(null);

export function SettingsFocusProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<SettingsFocusRequest | null>(null);

  const requestFocus = useCallback((target: SettingsFocusTarget) => {
    setRequest({
      ...target,
      nonce: Date.now(),
    });
  }, []);

  const clearFocus = useCallback(() => {
    setRequest(null);
  }, []);

  const value = useMemo(
    () => ({ request, requestFocus, clearFocus }),
    [request, requestFocus, clearFocus],
  );

  return (
    <SettingsFocusContext.Provider value={value}>
      {children}
    </SettingsFocusContext.Provider>
  );
}

export function useSettingsFocus(): SettingsFocusContextValue {
  const ctx = useContext(SettingsFocusContext);
  if (!ctx) {
    throw new Error("useSettingsFocus must be used within SettingsFocusProvider");
  }
  return ctx;
}

export function useOptionalSettingsFocus(): SettingsFocusContextValue | null {
  return useContext(SettingsFocusContext);
}
