import type { MutableRefObject } from "react";

export interface TerminalBootAttemptRefs {
  bootTokenRef: MutableRefObject<symbol | null>;
  isBootActiveRef: MutableRefObject<boolean>;
}

export const beginTerminalBootAttempt = (
  refs: TerminalBootAttemptRefs,
  description = "terminal-boot",
): symbol => {
  const token = Symbol(description);
  refs.bootTokenRef.current = token;
  refs.isBootActiveRef.current = true;
  return token;
};

export const invalidateTerminalBootAttempt = (refs: TerminalBootAttemptRefs): void => {
  refs.isBootActiveRef.current = false;
  refs.bootTokenRef.current = null;
};

export const isTerminalBootAttemptCurrent = (
  refs: TerminalBootAttemptRefs,
  token: symbol,
): boolean => refs.isBootActiveRef.current && refs.bootTokenRef.current === token;
