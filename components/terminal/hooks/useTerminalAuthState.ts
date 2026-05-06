import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { Host, TerminalSession } from "../../../types";
import type { PendingAuth } from "../runtime/createTerminalSessionStarters";
import type { TerminalAuthMethod } from "../TerminalAuthDialog";
import { logger } from "../../../lib/logger";

export const useTerminalAuthState = ({
  host,
  pendingAuthRef,
  termRef,
  onUpdateHost,
  onStartSession,
  setStatus,
  setProgressLogs,
}: {
  host: Host;
  pendingAuthRef: RefObject<PendingAuth>;
  termRef: RefObject<XTerm | null>;
  onUpdateHost?: (host: Host) => void;
  onStartSession: (term: XTerm) => void;
  setStatus: (status: TerminalSession["status"]) => void;
  setProgressLogs: (next: string[] | ((prev: string[]) => string[])) => void;
}) => {
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authRetryMessage, setAuthRetryMessage] = useState<string | null>(null);
  const [authUsername, setAuthUsername] = useState(host.username || "root");
  const [authMethod, setAuthMethod] = useState<TerminalAuthMethod>("password");
  const [authPassword, setAuthPassword] = useState("");
  const [authKeyId, setAuthKeyId] = useState<string | null>(null);
  const [authPassphrase, setAuthPassphrase] = useState("");
  const [showAuthPassword, setShowAuthPassword] = useState(false);
  const [showAuthPassphrase, setShowAuthPassphrase] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(true);

  useEffect(() => {
    setNeedsAuth(false);
    setAuthRetryMessage(null);
    setAuthUsername(host.username || "root");
    setAuthPassword("");
    setAuthKeyId(null);
    setAuthPassphrase("");
    setShowAuthPassword(false);
    setShowAuthPassphrase(false);
    setSaveCredentials(true);
  }, [host.id, host.username]);

  const isValid = useMemo(() => {
    if (!authUsername.trim()) return false;
    if (authMethod === "password") return authPassword.trim().length > 0;
    if (authMethod === "key" || authMethod === "certificate") return !!authKeyId;
    return false;
  }, [authKeyId, authMethod, authPassword, authUsername]);

  const resetForRetry = useCallback(() => {
    setNeedsAuth(false);
    setAuthRetryMessage(null);
    pendingAuthRef.current = null;
  }, [pendingAuthRef]);

  const submit = useCallback(
    (opts?: { saveToHost?: boolean }) => {
      if (!isValid) return;

      pendingAuthRef.current = {
        authMethod,
        username: authUsername,
        password: authMethod === "password" ? authPassword : undefined,
        keyId:
          authMethod === "key" || authMethod === "certificate"
            ? (authKeyId ?? undefined)
            : undefined,
        passphrase:
          authMethod === "key" || authMethod === "certificate"
            ? authPassphrase || undefined
            : undefined,
      };

      const shouldSave = opts?.saveToHost ?? saveCredentials;
      if (shouldSave && onUpdateHost) {
        const updatedHost: Host = {
          ...host,
          username: authUsername,
          authMethod: authMethod,
          password: authMethod === "password" ? authPassword : undefined,
          identityFileId:
            authMethod === "key" || authMethod === "certificate"
              ? (authKeyId ?? undefined)
              : undefined,
        };
        onUpdateHost(updatedHost);
      }

      setNeedsAuth(false);
      setAuthRetryMessage(null);
      setStatus("connecting");
      setProgressLogs(["Authenticating with provided credentials..."]);

      const term = termRef.current;
      if (!term) return;

      try {
        term.clear?.();
      } catch (err) {
        logger.warn("Failed to clear terminal", err);
      }

      onStartSession(term);
    },
    [
      authKeyId,
      authMethod,
      authPassphrase,
      authPassword,
      authUsername,
      host,
      isValid,
      onStartSession,
      onUpdateHost,
      pendingAuthRef,
      saveCredentials,
      setProgressLogs,
      setStatus,
      termRef,
    ],
  );

  return {
    needsAuth,
    setNeedsAuth,
    authRetryMessage,
    setAuthRetryMessage,
    authUsername,
    setAuthUsername,
    authMethod,
    setAuthMethod,
    authPassword,
    setAuthPassword,
    authKeyId,
    setAuthKeyId,
    authPassphrase,
    setAuthPassphrase,
    showAuthPassword,
    setShowAuthPassword,
    showAuthPassphrase,
    setShowAuthPassphrase,
    saveCredentials,
    setSaveCredentials,
    isValid,
    resetForRetry,
    submit,
  };
};
