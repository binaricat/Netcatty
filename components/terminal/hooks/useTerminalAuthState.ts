import type { Terminal as XTerm } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import type { Host, Identity, TerminalSession } from "../../../types";
import { listPasswordAuthIdentities } from "../../../domain/authIdentityPicker";
import type { PendingAuth } from "../runtime/createTerminalSessionStarters";
import type { TerminalAuthMethod } from "../TerminalAuthDialog";
import { logger } from "../../../lib/logger";

/**
 * Password auth is valid when the user typed something — including a single
 * space. SSH passwords may be whitespace-only; do not trim before this check
 * (issue #2036).
 */
export const isAuthPasswordProvided = (password: string): boolean =>
  password.length > 0;

export const buildSavedAuthHostUpdate = (
  host: Host,
  auth: {
    authMethod: TerminalAuthMethod;
    username: string;
    password: string;
    keyId: string | null;
    identityId?: string | null;
  },
): Host => ({
  ...host,
  username: auth.username,
  authMethod: auth.authMethod,
  password: auth.identityId ? undefined : auth.authMethod === "password" ? auth.password : undefined,
  savePassword: auth.authMethod === "password" ? true : host.savePassword,
  identityFileId:
    auth.authMethod === "key" || auth.authMethod === "certificate"
      ? (auth.keyId ?? undefined)
      : undefined,
  // An explicitly chosen saved identity remains linked to the host. Manual
  // credentials detach the stale identity; empty string prevents inheriting
  // an unrelated group identity on the next connection.
  identityId: auth.identityId || "",
});

export const useTerminalAuthState = ({
  host,
  identities,
  pendingAuthRef,
  termRef,
  onUpdateHost,
  onStartSession,
  setStatus,
  setProgressLogs,
}: {
  host: Host;
  identities: Identity[];
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
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
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
    setSelectedIdentityId(null);
    setAuthKeyId(null);
    setAuthPassphrase("");
    setShowAuthPassword(false);
    setShowAuthPassphrase(false);
    setSaveCredentials(true);
  }, [host.id, host.username]);

  const selectedIdentity = useMemo(() =>
    selectedIdentityId
      ? listPasswordAuthIdentities(identities).find((identity) => identity.id === selectedIdentityId && identity.username === authUsername)
      : undefined,
  [authUsername, identities, selectedIdentityId]);

  const isValid = useMemo(() => {
    if (!authUsername.trim()) return false;
    if (authMethod === "password") return Boolean(selectedIdentity) || isAuthPasswordProvided(authPassword);
    if (authMethod === "key" || authMethod === "certificate") return !!authKeyId;
    return false;
  }, [authKeyId, authMethod, authPassword, authUsername, selectedIdentity]);

  const updateAuthPassword = useCallback((password: string) => {
    setSelectedIdentityId(null);
    setAuthPassword(password);
  }, []);

  const updateAuthUsername = useCallback((username: string) => {
    setSelectedIdentityId(null);
    setAuthUsername(username);
  }, []);

  const selectIdentity = useCallback((identityId: string) => {
    const identity = listPasswordAuthIdentities(identities).find((item) => item.id === identityId);
    if (!identity) return;
    setAuthMethod("password");
    setAuthUsername(identity.username);
    setAuthPassword("");
    setShowAuthPassword(false);
    setSelectedIdentityId(identity.id);
  }, [identities]);

  const resetForRetry = useCallback(() => {
    setNeedsAuth(false);
    setAuthRetryMessage(null);
    pendingAuthRef.current = null;
  }, [pendingAuthRef]);

  const submit = useCallback(
    (opts?: { saveToHost?: boolean }) => {
      if (!isValid) return;

      const shouldSave = opts?.saveToHost ?? saveCredentials;
      const password = selectedIdentity?.password ?? authPassword;
      pendingAuthRef.current = {
        authMethod,
        username: authUsername,
        password: authMethod === "password" ? password : undefined,
        keyId:
          authMethod === "key" || authMethod === "certificate"
            ? (authKeyId ?? undefined)
            : undefined,
        passphrase:
          authMethod === "key" || authMethod === "certificate"
            ? authPassphrase || undefined
            : undefined,
        savedToHost: shouldSave && Boolean(onUpdateHost),
      };

      if (shouldSave && onUpdateHost) {
        onUpdateHost(
          buildSavedAuthHostUpdate(host, {
            authMethod,
            username: authUsername,
            password,
            keyId: authKeyId,
            identityId: authMethod === "password" ? selectedIdentity?.id : undefined,
          }),
        );
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
      selectedIdentity,
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
    setAuthUsername: updateAuthUsername,
    authMethod,
    setAuthMethod,
    authPassword,
    setAuthPassword: updateAuthPassword,
    selectedIdentityId,
    selectIdentity,
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
