import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { Host, SSHKey } from "../../types";
import { TerminalConnectionDialog } from "../terminal/TerminalConnectionDialog";
import type { TerminalAuthMethod } from "../terminal/TerminalAuthDialog";
import type { useHostConnectionTest } from "../../application/state/useHostConnectionTest";

type HostConnectionTest = ReturnType<typeof useHostConnectionTest>;

export interface HostConnectionTestDialogProps {
  open: boolean;
  onClose: () => void;
  host: Host;
  keys: SSHKey[];
  test: HostConnectionTest;
}

/**
 * Host-editor "test connection" overlay. It reuses the terminal's own
 * connection dialog verbatim (progress bar, per-hop chain header, auth prompt,
 * and host-key verification) and keeps it mounted on success so the final
 * "Connected" state shows through the same dialog with retry/close.
 */
export const HostConnectionTestDialog: React.FC<HostConnectionTestDialogProps> = ({
  open,
  onClose,
  host,
  keys,
  test,
}) => {
  const { t } = useI18n();
  const { state } = test;
  const [showLogs, setShowLogs] = useState(false);

  // Auth re-entry form state (shown when state.needsAuth is true).
  const [authMethod, setAuthMethod] = useState<TerminalAuthMethod>("password");
  const [authUsername, setAuthUsername] = useState(host.username || "root");
  const [authPassword, setAuthPassword] = useState("");
  const [authKeyId, setAuthKeyId] = useState<string | null>(null);
  const [authPassphrase, setAuthPassphrase] = useState("");
  const [showAuthPassphrase, setShowAuthPassphrase] = useState(false);
  const [showAuthPassword, setShowAuthPassword] = useState(false);

  const handleClose = () => {
    if (state.status === "connecting") {
      test.cancelTest();
    }
    setShowLogs(false);
    onClose();
  };

  const authIsValid =
    authMethod === "password" ? authPassword.length > 0 : Boolean(authKeyId);

  const submitAuth = () => {
    if (!authIsValid) return;
    test.submitAuth({
      authMethod,
      username: authUsername,
      ...(authMethod === "password"
        ? { password: authPassword }
        : { keyId: authKeyId ?? undefined, passphrase: authPassphrase || undefined }),
    });
  };

  if (!open) return null;

  const dialogStatus =
    state.status === "connecting"
      ? "connecting"
      : state.status === "connected"
        ? "connected"
        : "disconnected";

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      style={
        {
          // The terminal dialog's card/backdrop colors resolve through
          // --terminal-ui-bg/--terminal-ui-fg (full colors set inside a
          // terminal pane). Outside a terminal those variables are unset and
          // the fallback `var(--background)` is only a raw HSL triplet, which
          // is invalid inside color-mix() and silently drops the card border,
          // background, and backdrop dim. Pin them to the app theme here so
          // the reused dialog keeps its border/shadow/dim.
          "--terminal-ui-bg": "hsl(var(--background))",
          "--terminal-ui-fg": "hsl(var(--foreground))",
        } as React.CSSProperties
      }
    >
      <TerminalConnectionDialog
        host={host}
        status={dialogStatus}
        error={state.error}
        progressValue={state.progressValue}
        chainProgress={state.chainProgress}
        needsAuth={state.needsAuth}
        showLogs={showLogs}
        _setShowLogs={setShowLogs}
        keys={keys}
        authProps={{
          authMethod,
          setAuthMethod,
          authUsername,
          setAuthUsername,
          authPassword,
          setAuthPassword,
          authKeyId,
          setAuthKeyId,
          authPassphrase,
          setAuthPassphrase,
          showAuthPassphrase,
          setShowAuthPassphrase,
          showAuthPassword,
          setShowAuthPassword,
          authRetryMessage: state.needsAuth
            ? t("hostConnectionTest.credentialsUnavailable")
            : null,
          onSubmit: submitAuth,
          onSubmitWithoutSave: submitAuth,
          onCancel: handleClose,
          isValid: authIsValid,
        }}
        hostKeyVerification={
          state.hostKeyVerification
            ? {
                hostKeyInfo: state.hostKeyVerification.hostKeyInfo,
                onClose: test.handleHostKeyClose,
                onContinue: test.handleHostKeyContinue,
                onAddAndContinue: test.handleHostKeyAddAndContinue,
              }
            : undefined
        }
        progressProps={{
          timeLeft: state.timeLeft,
          isAwaitingUserInput: state.isAwaitingUserInput,
          isCancelling: state.isCancelling,
          progressLogs: state.progressLogs,
          onCancelConnect: handleClose,
          onCloseSession: handleClose,
          onRetry: () => void test.retry(),
          reconnectLabel: t("hostConnectionTest.retry"),
          closeLabel: t("common.close"),
        }}
      />
    </div>,
    document.body,
  );
};

export default HostConnectionTestDialog;
