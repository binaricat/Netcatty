import React, { useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useI18n } from "../../application/i18n/I18nProvider";
import type { Host, SSHKey } from "../../types";
import type { RemoteDesktopProbeResult } from "../../domain/hostConnectionTest";
import { formatHostPort } from "../../domain/host";
import { cn } from "../../lib/utils";
import { RdpProtocolIcon, VncProtocolIcon } from "../icons/RemoteDesktopIcons";
import { getProtocolBadgeClass } from "../protocolVisuals";
import { trustKnownRemoteDesktopCert } from "../remoteDesktop/knownRemoteDesktopCerts";
import { Button } from "../ui/button";
import { TerminalConnectionDialog } from "../terminal/TerminalConnectionDialog";
import type { TerminalAuthMethod } from "../terminal/TerminalAuthDialog";
import type { useHostConnectionTest } from "../../application/state/useHostConnectionTest";

type HostConnectionTest = ReturnType<typeof useHostConnectionTest>;

const RDP_SECURITY_LABELS: Record<NonNullable<RemoteDesktopProbeResult["rdpSecurity"]>, string> = {
  nla: "NLA / CredSSP",
  "nla-ext": "NLA / CredSSP Extended",
  tls: "TLS",
  rdstls: "RDSTLS",
  rdp: "Standard RDP",
};

const RemoteDesktopProbeSummaryCard: React.FC<{
  probe: RemoteDesktopProbeResult;
  certHost: string;
  onTrusted: () => void;
}> = ({ probe, certHost, onTrusted }) => {
  const isRdp = probe.protocol === "rdp";
  const cert = probe.cert;

  const handleTrust = () => {
    if (!cert) return;
    const info = {
      fingerprintSha256: cert.fingerprintSha256,
      ...(cert.subject ? { subject: cert.subject } : {}),
      ...(cert.issuer ? { issuer: cert.issuer } : {}),
      ...(cert.validFrom ? { validFrom: cert.validFrom } : {}),
      ...(cert.validTo ? { validTo: cert.validTo } : {}),
    } as Parameters<typeof trustKnownRemoteDesktopCert>[3];
    trustKnownRemoteDesktopCert(probe.protocol, certHost, probe.port, info);
    onTrusted();
  };

  return (
    <div
      data-testid="remote-desktop-probe-summary"
      className="rounded-lg border border-border/50 bg-background/50 p-3 space-y-2.5 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              getProtocolBadgeClass(probe.protocol),
            )}
          >
            {isRdp ? <RdpProtocolIcon size={11} /> : <VncProtocolIcon size={11} />}
            {probe.protocol.toUpperCase()}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground truncate">
            {formatHostPort(probe.host, probe.port)}
          </span>
        </div>
        {probe.rttMs != null && (
          <span
            data-testid="remote-desktop-probe-rtt"
            className="shrink-0 rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-600 dark:text-emerald-400 tabular-nums"
          >
            {probe.rttMs} ms
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-1.5 text-[11px]">
        {isRdp && probe.rdpSecurity && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Security</span>
            <span className="font-medium text-foreground">
              {RDP_SECURITY_LABELS[probe.rdpSecurity] ?? probe.rdpSecurity}
            </span>
          </div>
        )}
        {!isRdp && probe.rfbVersion && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">RFB Banner</span>
            <span className="font-mono font-medium text-foreground">{probe.rfbVersion}</span>
          </div>
        )}
        {!isRdp && probe.vncSecurityTypes && probe.vncSecurityTypes.length > 0 && (
          <div className="flex items-start justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Security Types</span>
            <div className="flex flex-wrap justify-end gap-1">
              {probe.vncSecurityTypes.map((sec) => (
                <span
                  key={`${sec.id}-${sec.name}`}
                  className="rounded border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                >
                  {sec.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {(probe.tlsVersion || probe.tlsCipher) && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">TLS</span>
            <span className="font-mono text-[10px] text-foreground truncate">
              {[probe.tlsVersion, probe.tlsCipher].filter(Boolean).join(" · ")}
            </span>
          </div>
        )}
      </div>

      {cert && (
        <div className="rounded-md border border-border/50 bg-muted/30 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium text-muted-foreground">SHA-256 Certificate</span>
            {cert.trustStatus === "trusted" ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <ShieldCheck size={12} /> Trusted
              </span>
            ) : cert.trustStatus === "changed" ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-destructive">
                <ShieldAlert size={12} /> Changed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <ShieldQuestion size={12} /> First Seen
              </span>
            )}
          </div>
          <div className="font-mono text-[10px] leading-4 text-foreground break-all select-all">
            {cert.fingerprintSha256}
          </div>
          {(cert.subject || cert.issuer) && (
            <div className="text-[10px] text-muted-foreground truncate">
              {cert.subject || cert.issuer}
            </div>
          )}
          {(cert.trustStatus === "first-seen" || cert.trustStatus === "changed") && (
            <div className="pt-1 flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-6 px-2.5 text-[10px] gap-1"
                data-testid="remote-desktop-trust-fingerprint"
                onClick={handleTrust}
              >
                <CheckCircle2 size={11} />
                Trust Fingerprint
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

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
        protocolOverride={state.activeProtocol !== "ssh" ? state.activeProtocol : undefined}
        summaryContent={
          state.probeResult && state.probeResult.ok ? (
            <RemoteDesktopProbeSummaryCard
              probe={state.probeResult}
              certHost={host.hostname || state.probeResult.host}
              onTrusted={test.markProbeCertTrusted}
            />
          ) : undefined
        }
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
