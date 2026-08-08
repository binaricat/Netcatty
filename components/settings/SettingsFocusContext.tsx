import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { SettingsFocusTarget } from "./settingsFocus";

export type SettingsFocusRequest = SettingsFocusTarget & {
  nonce: number;
};

type SettingsFocusContextValue = {
  request: SettingsFocusRequest | null;
  requestFocus: (target: SettingsFocusTarget) => void;
  clearFocus: () => void;
  openSearch: () => void;
  registerOpenSearch: (opener: (() => void) | null) => void;
};

const SettingsFocusContext = createContext<SettingsFocusContextValue | null>(null);

export function SettingsFocusProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<SettingsFocusRequest | null>(null);
  const openSearchRef = useRef<(() => void) | null>(null);
  const nonceRef = useRef(0);

  const requestFocus = useCallback((target: SettingsFocusTarget) => {
    nonceRef.current += 1;
    setRequest({
      ...target,
      nonce: nonceRef.current,
    });
  }, []);

  const clearFocus = useCallback(() => {
    setRequest(null);
  }, []);

  const registerOpenSearch = useCallback((opener: (() => void) | null) => {
    openSearchRef.current = opener;
  }, []);

  const openSearch = useCallback(() => {
    openSearchRef.current?.();
  }, []);

  const value = useMemo(
    () => ({ request, requestFocus, clearFocus, openSearch, registerOpenSearch }),
    [request, requestFocus, clearFocus, openSearch, registerOpenSearch],
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
