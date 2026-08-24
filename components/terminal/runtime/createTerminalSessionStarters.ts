import type { Terminal as XTerm } from "@xterm/xterm";
import type { ProviderValidationIssue } from "@netcatty/plugin-contract";
import { logger } from "../../../lib/logger";
import type { Host, SSHKey } from "../../../types";
import type { TerminalSessionExitEvent } from "../../../application/state/resolveTerminalSessionExitIntent";
import { setTerminalBootEpoch } from "../../../domain/terminalBootEpoch";
import type { TerminalSessionStartersContext } from "./createTerminalSessionStarters.types";
export type {
  PendingAuth,
  SessionLogConfig,
  TerminalSessionDataMeta,
  TerminalSessionStartersContext,
} from "./createTerminalSessionStarters.types";
export { normalizeStartupCommandDelay, splitStartupCommandLines } from "./terminalStartupCommands";
import {
  acknowledgeDroppedTerminalDisplayBytes,
  attachSessionToTerminal,
  buildTermEnv,
  closeOrphanBackendSession,
  createBootAttemptGuard,
  getFlowController,
  notePendingOutputScrollIfEnabled,
  resetTerminalLineTimestampState,
  tryAttachSessionToTerminal,
  writeSessionData,
  writeTerminalLine,
} from "./terminalSessionAttachment";
import { teardownTerminalOutputPipeline } from "./terminalOutputPipeline";
import { resetTerminalSyncBlockFilter } from "./terminalSyncBlockFilter";
import { flushTerminalWriteCoalescer } from "./terminalWriteCoalescer";
import { isConnectionTokenCurrent, registerConnectionToken, runDistroDetection } from "./terminalDistroDetection";
import { resolveStartupCommand, scheduleStartupCommand } from "./terminalStartupCommands";
import { markPromptLineBreakCommandPending } from "./promptLineBreak";
import {
  isEncryptedCredentialPlaceholder,
  sanitizeCredentialValue,
} from "../../../domain/credentials";
import { resolveBridgeSshAgentAuth, resolveHostAuth } from "../../../domain/sshAuth";
import {
  resolveHostKeepalive,
  resolveTelnetPassword,
  resolveTelnetPort,
  resolveTelnetUsername,
} from "../../../domain/host";
import {
  findIncompleteProxyIdentityId,
  findMissingProxyIdentityId,
  formatIncompleteProxyIdentityMessage,
  formatMissingProxyIdentityMessage,
  hasUnreadableProxyCredential,
  hasUsableProxyConfig,
  resolveProxyConfigAuth,
} from "../../../domain/proxyProfiles";
import {
  advanceMonotonicConnectionProgress,
  resolveHopConnectionProgress,
} from "../connectionProgress";
import { hasConnectionPassedTcpDial } from "../connectionTimeouts";
import { resolveHostSshConnectionTimeouts } from "../../../domain/sshConnectionTimeouts";
import { isPluginHostProtocol, sanitizePluginConnection } from "../../../domain/pluginConnection";

const TELNET_SESSION_REPLACED_ERROR = "Telnet session start was replaced";
const JUMP_HOST_AUTH_FAILED_PREFIX = "Jump host authentication failed";

const createPluginConnectionRequestId = (): string => {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  return `plugin-connection-${randomId}`.slice(0, 128);
};

const formatPluginDiagnosticLines = (
  diagnostics: ReadonlyArray<ProviderValidationIssue> | undefined,
): string[] => (diagnostics ?? [])
  .map((issue) => `[Plugin ${issue.severity}] ${issue.message}`);

const formatPluginConnectionExitMessage = (event: TerminalSessionExitEvent): string => {
  const lines = [
    event.error
      ? `[Plugin connection closed: ${event.error}]`
      : "[Plugin connection closed]",
    ...formatPluginDiagnosticLines(event.diagnostics),
  ];
  return `\r\n${lines.join("\r\n")}`;
};

const isAuthFailureMessage = (message: string): boolean => {
  const normalized = message.toLowerCase();
  return normalized.includes("all configured authentication methods failed") ||
    normalized.includes("authentication failed") ||
    normalized.includes("too many authentication failures") ||
    /permission denied\s*\(/.test(normalized) ||
    normalized.includes("no authentication methods available");
};

const isJumpHostAuthError = (err: unknown, message: string): boolean =>
  Boolean(
    err instanceof Error &&
    (err as Error & { isJumpHostAuthError?: boolean }).isJumpHostAuthError,
  ) || message.includes(JUMP_HOST_AUTH_FAILED_PREFIX);

export const getMissingChainHostIds = (
  host: Host,
  resolvedChainHosts: Host[],
): string[] => {
  const requestedIds = host.hostChain?.hostIds ?? [];
  if (requestedIds.length === 0) return [];
  const resolvedIds = new Set(resolvedChainHosts.map((chainHost) => chainHost.id));
  return requestedIds.filter((hostId) => !resolvedIds.has(hostId));
};

/**
 * Cancellation handle for one boot attempt. The mount effect owns the
 * controller and aborts it in cleanup, so a start that is still awaiting the
 * bridge stops counting as the current attempt and closes any session it wins.
 */
export type TerminalSessionStartOptions = {
  signal?: AbortSignal;
};

export const createTerminalSessionStarters = (ctx: TerminalSessionStartersContext) => {
  const globalTerminalSettings = {
    verifyHostKeys: true,
    keepaliveInterval: 30,
    keepaliveCountMax: 10,
    ...(ctx.terminalSettings ?? {}),
  };
  let fallbackDisposeTelnetEchoMode: (() => void) | null = null;

  const tr = (key: string, fallback: string): string => {
    const translated = ctx.t?.(key);
    if (!translated || translated === key) return fallback;
    return translated;
  };

  const abortSessionStartAfterUnmount = () => {
    ctx.updateStatus("disconnected");
    ctx.setProgressValue(0);
    ctx.setChainProgress(null);
  };

  const createAttemptGuards = (options?: TerminalSessionStartOptions) => {
    const bootEpoch = ctx.bootEpochRef?.current ?? 0;
    const isBootEpochCurrent = createBootAttemptGuard(ctx);
    // An aborted boot is never the current attempt, so every existing guard
    // (orphan close, attach refusal, UI suppression) also covers cancellation.
    const isCurrentAttempt = () => options?.signal?.aborted !== true && isBootEpochCurrent();
    return {
      bootEpoch,
      isCurrentAttempt,
      ignoreStaleAttemptUi: () => !isCurrentAttempt(),
    };
  };

  const consumeRestoreCwdIntent = (term: XTerm, id: string): void => {
    const intent = ctx.restoreCwdIntentRef?.current;
    if (!intent) return;
    ctx.restoreCwdIntentRef.current = null;
    ctx.setProgressLogs((prev) => [...prev, tr("terminal.restore.cwdLog", `Restoring working directory: ${intent.cwd}`)
      .replace("{cwd}", intent.cwd)]);
    ctx.terminalBackend.writeToSession(id, `${intent.command}\r`, { automated: true });
    ctx.onRestoreCwdIntentConsumed?.(intent.cwd);
    markPromptLineBreakCommandPending(ctx.promptLineBreakStateRef, term, intent.command);
  };

  const resolveSavedSudoAutofillPassword = (): string | undefined => {
    const pendingAuth = ctx.pendingAuthRef.current;
    if (pendingAuth?.savedToHost && pendingAuth.password) {
      return sanitizeCredentialValue(pendingAuth.password);
    }
    if (ctx.sudoAutofillPasswordRef) {
      return sanitizeCredentialValue(ctx.sudoAutofillPasswordRef.current);
    }
    return sanitizeCredentialValue(ctx.sudoAutofillPassword);
  };

  const resolveSudoAutofillCandidates = () =>
    ctx.sudoAutofillCandidatesRef?.current ?? ctx.sudoAutofillCandidates ?? [];

  const clearTelnetEchoMode = ({ resetLocalEcho = true }: { resetLocalEcho?: boolean } = {}) => {
    ctx.disposeTelnetEchoModeRef?.current?.();
    if (ctx.disposeTelnetEchoModeRef) ctx.disposeTelnetEchoModeRef.current = null;
    fallbackDisposeTelnetEchoMode?.();
    fallbackDisposeTelnetEchoMode = null;
    if (resetLocalEcho && ctx.telnetLocalEchoRef) ctx.telnetLocalEchoRef.current = false;
  };

  const attachTelnetEchoMode = (
    backendSessionId: string,
    { resetLocalEcho = true }: { resetLocalEcho?: boolean } = {},
  ) => {
    if (ctx.host.protocol !== "telnet") return;
    if (!ctx.telnetLocalEchoRef || !ctx.terminalBackend.onTelnetEchoMode) return;
    clearTelnetEchoMode({ resetLocalEcho });
    if (resetLocalEcho) ctx.telnetLocalEchoRef.current = false;
    let receivedLiveUpdate = false;
    const dispose = ctx.terminalBackend.onTelnetEchoMode(
      backendSessionId,
      (evt) => {
        receivedLiveUpdate = true;
        ctx.telnetLocalEchoRef!.current = Boolean(evt.localEcho);
      },
    ) ?? null;
    void ctx.terminalBackend.getTelnetEchoMode?.(backendSessionId).then((mode) => {
      if (!receivedLiveUpdate && mode?.success) {
        ctx.telnetLocalEchoRef!.current = Boolean(mode.localEcho);
      }
    }).catch(() => {});
    if (ctx.disposeTelnetEchoModeRef) {
      ctx.disposeTelnetEchoModeRef.current = dispose;
    } else {
      fallbackDisposeTelnetEchoMode = dispose;
    }
  };

  const startSSH = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    // Correlate host-key prompts with this boot so a superseded start cannot
    // reopen approval UI after disconnect → reconnect.
    setTerminalBootEpoch(ctx.sessionId, bootEpoch);
    if (!ctx.terminalBackend.backendAvailable()) {
      ctx.setError("Native SSH bridge unavailable. Launch via Electron app.");
      writeTerminalLine(
        ctx,
        term,
        "\r\n[netcatty SSH bridge unavailable. Please run the desktop build to connect.]",
      );
      ctx.updateStatus("disconnected");
      return;
    }
    ctx.setIsConnectionAwaitingUserInput?.(false);

    const missingChainHostIds = getMissingChainHostIds(ctx.host, ctx.resolvedChainHosts);
    if (missingChainHostIds.length > 0) {
      const base = tr(
        "terminal.auth.jumpHostMissing",
        "A configured jump host is missing. Open host settings and repair the jump host chain.",
      );
      const suffix = missingChainHostIds.length > 2
        ? ` +${missingChainHostIds.length - 2}`
        : "";
      const message = `${base} (${missingChainHostIds.slice(0, 2).join(", ")}${suffix})`;
      ctx.setNeedsAuth(false);
      ctx.setAuthRetryMessage(null);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }

    const pendingAuth = ctx.pendingAuthRef.current;
    const resolvedAuth = resolveHostAuth({
      host: ctx.host,
      keys: ctx.keys,
      identities: ctx.identities,
      override: pendingAuth
        ? {
          authMethod: pendingAuth.authMethod,
          username: pendingAuth.username,
          password: pendingAuth.password,
          keyId: pendingAuth.keyId,
          passphrase: pendingAuth.passphrase,
        }
        : null,
    });

    const effectiveUsername = resolvedAuth.username || "root";
    const key = resolvedAuth.key;
    const effectivePassword = sanitizeCredentialValue(resolvedAuth.password);
    const effectivePassphrase = sanitizeCredentialValue(resolvedAuth.passphrase);
    const hasEncryptedPrimaryPassword = isEncryptedCredentialPlaceholder(resolvedAuth.password);
    const hasEncryptedPrimaryKey = isEncryptedCredentialPlaceholder(key?.privateKey);

    const isAuthError = (err: unknown): boolean => {
      if (!(err instanceof Error)) return false;
      return isAuthFailureMessage(err.message);
    };

    if (ctx.host.proxyProfileId && !ctx.host.proxyConfig) {
      const message = `Saved proxy for host "${ctx.host.label || ctx.host.hostname}" is missing. Open host settings and select a valid proxy.`;
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    if (findMissingProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
      const message = formatMissingProxyIdentityMessage(ctx.host.label || ctx.host.hostname);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    if (findIncompleteProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
      const message = formatIncompleteProxyIdentityMessage(ctx.host.label || ctx.host.hostname);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    const proxyConfig = ctx.host.proxyConfig
      ? resolveProxyConfigAuth(ctx.host.proxyConfig, ctx.identities)
      : undefined;

    const jumpHostsWithUnavailableCredentials: string[] = [];
    const unresolvedJumpProxyHost = ctx.resolvedChainHosts.find((jumpHost) => jumpHost.proxyProfileId && !jumpHost.proxyConfig);
    if (unresolvedJumpProxyHost) {
      const message = `Saved proxy for jump host "${unresolvedJumpProxyHost.label || unresolvedJumpProxyHost.hostname}" is missing. Open host settings and select a valid proxy.`;
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    const unresolvedJumpProxyIdentityHost = ctx.resolvedChainHosts.find((jumpHost) =>
      findMissingProxyIdentityId(jumpHost.proxyConfig, ctx.identities),
    );
    if (unresolvedJumpProxyIdentityHost) {
      const message = formatMissingProxyIdentityMessage(
        unresolvedJumpProxyIdentityHost.label || unresolvedJumpProxyIdentityHost.hostname,
      );
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    const incompleteJumpProxyIdentityHost = ctx.resolvedChainHosts.find((jumpHost) =>
      findIncompleteProxyIdentityId(jumpHost.proxyConfig, ctx.identities),
    );
    if (incompleteJumpProxyIdentityHost) {
      const message = formatIncompleteProxyIdentityMessage(
        incompleteJumpProxyIdentityHost.label || incompleteJumpProxyIdentityHost.hostname,
      );
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    const jumpHosts = ctx.resolvedChainHosts.map<NetcattyJumpHost>((jumpHost, index) => {
      const jumpAuth = resolveHostAuth({
        host: jumpHost,
        keys: ctx.keys,
        identities: ctx.identities,
      });
      const jumpKey = jumpAuth.key;
      const rawJumpPassword = jumpAuth.password;
      const rawJumpPrivateKey = jumpKey?.privateKey;
      const rawJumpPassphrase = jumpAuth.passphrase || jumpKey?.passphrase;
      const jumpPassword = sanitizeCredentialValue(rawJumpPassword);
      const jumpPrivateKey = sanitizeCredentialValue(rawJumpPrivateKey);
      const jumpPassphrase = sanitizeCredentialValue(rawJumpPassphrase);
      const jumpAllowsLocalIdentityFallback = !jumpAuth.keyId;
      const jumpReferenceKeyPath = jumpAuth.authMethod === "password"
        ? undefined
        : jumpKey?.source === 'reference' ? jumpKey.filePath : undefined;
      const jumpIdentityFilePaths = jumpAuth.authMethod === "password"
        ? undefined
        : jumpReferenceKeyPath
          ? [jumpReferenceKeyPath]
          : jumpAllowsLocalIdentityFallback
            ? jumpHost.identityFilePaths
            : undefined;
      const jumpAgentAuth = resolveBridgeSshAgentAuth(jumpHost, jumpKey, jumpAuth.authMethod);
      const hasJumpKeyMaterial = Boolean(
        jumpAgentAuth.useSshAgent || jumpPrivateKey || jumpIdentityFilePaths?.length,
      );
      const hasConfiguredJumpProxyEndpoint =
        index === 0 &&
        hasUsableProxyConfig(jumpHost.proxyConfig);
      const hasEncryptedJumpProxyCredential =
        hasConfiguredJumpProxyEndpoint &&
        hasUnreadableProxyCredential(jumpHost.proxyConfig, ctx.identities);

      const hasEncryptedJumpCredential =
        isEncryptedCredentialPlaceholder(rawJumpPassword) ||
        isEncryptedCredentialPlaceholder(rawJumpPrivateKey) ||
        isEncryptedCredentialPlaceholder(rawJumpPassphrase);

      if (hasEncryptedJumpProxyCredential || (
        jumpAuth.authMethod !== "auto"
        && hasEncryptedJumpCredential
        && !jumpPassword
        && !hasJumpKeyMaterial
      )) {
        jumpHostsWithUnavailableCredentials.push(jumpHost.label || jumpHost.hostname);
      }

      // Resolve keepalive for THIS hop. Each jump host carries its own
      // override toggle, so a bastion that is a router (interval=0) can
      // coexist with a cloud target host (interval=30) in the same chain.
      const hopKeepalive = resolveHostKeepalive(jumpHost, globalTerminalSettings);
      const hopConnectionTimeouts = resolveHostSshConnectionTimeouts(jumpHost);

      return {
        hostname: jumpHost.hostname,
        hostId: jumpHost.id,
        port: jumpHost.port || 22,
        username: jumpAuth.username || "root",
        authMethod: jumpAuth.authMethod,
        requiresMfa: !!jumpHost.requiresMfa,
        password: jumpPassword,
        privateKey: jumpKey?.source === 'reference' ? undefined : jumpPrivateKey,
        certificate: jumpKey?.certificate,
        passphrase: jumpPassphrase,
        publicKey: jumpKey?.publicKey,
        keyId: jumpAuth.keyId,
        keySource: jumpKey?.source,
        label: jumpHost.label,
        proxy: hasUsableProxyConfig(jumpHost.proxyConfig)
          ? resolveProxyConfigAuth(jumpHost.proxyConfig, ctx.identities)
          : undefined,
        identityFilePaths: jumpIdentityFilePaths,
        ...jumpAgentAuth,
        keepaliveInterval: hopKeepalive.interval,
        keepaliveCountMax: hopKeepalive.countMax,
        sshTcpConnectTimeoutMs: hopConnectionTimeouts.tcpConnectTimeoutSeconds * 1000,
        sshAuthReadyTimeoutMs: hopConnectionTimeouts.authReadyTimeoutSeconds * 1000,
        verifyHostKeys: globalTerminalSettings.verifyHostKeys,
        legacyAlgorithms: jumpHost.legacyAlgorithms,
        skipEcdsaHostKey: jumpHost.skipEcdsaHostKey,
        algorithmOverrides: jumpHost.algorithms,
      };
    });

    const usesTargetProxyForFirstHop = !!proxyConfig && !jumpHosts[0]?.proxy;
    if (usesTargetProxyForFirstHop && hasUnreadableProxyCredential(ctx.host.proxyConfig, ctx.identities)) {
      const message = tr(
        "terminal.auth.proxyCredentialsUnavailable",
        "Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.",
      );
      ctx.setNeedsAuth(false);
      ctx.setAuthRetryMessage(null);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }

    if (jumpHostsWithUnavailableCredentials.length > 0) {
      const jumpList = jumpHostsWithUnavailableCredentials.slice(0, 2).join(", ");
      const suffix =
        jumpHostsWithUnavailableCredentials.length > 2
          ? ` +${jumpHostsWithUnavailableCredentials.length - 2}`
          : "";
      const base = tr(
        "terminal.auth.jumpCredentialsUnavailable",
        "A jump host has saved credentials that cannot be decrypted on this device. Open host settings and re-enter them.",
      );
      const message = `${base} (${jumpList}${suffix})`;
      ctx.setNeedsAuth(false);
      ctx.setAuthRetryMessage(null);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }

    const totalHops = jumpHosts.length + 1;
    let unsubscribeChainProgress: (() => void) | undefined;

    ctx.setIsConnectionPastTcpDial?.(false);
    if (jumpHosts.length > 0) {
      ctx.setChainProgress({
        currentHop: 1,
        totalHops,
        currentHostLabel:
          jumpHosts[0]?.label || jumpHosts[0]?.hostname || ctx.host.hostname,
        connectionPhase: 'connecting',
      });
    }

    {
      const unsub = ctx.terminalBackend.onChainProgress((sid, hop, total, label, status, error) => {
        // P1: Only process events for this session
        if (sid !== ctx.sessionId) return;
        // Disconnect/reconnect can leave two SSH starts sharing this UI
        // sessionId; ignore progress from the superseded boot attempt.
        if (!isCurrentAttempt()) return;

        // P3: Only show chain progress UI for multi-hop connections
        if (total > 1) {
          ctx.setChainProgress({
            currentHop: hop,
            totalHops: total,
            currentHostLabel: label,
            connectionPhase: status,
          });
        }

        // Build human-readable log line
        let logLine: string;
        const prefix = total > 1 ? `[${hop}/${total}] ` : '';

        switch (status) {
          case 'connecting':
            logLine = `${prefix}${tr("terminal.progress.connecting", "Connecting to")} ${label}...`;
            break;
          case 'tcp-connected':
            logLine = `${prefix}${label} - ${tr("terminal.progress.tcpConnected", "TCP connected")}`;
            break;
          case 'authenticating':
            logLine = `${prefix}${label} - ${tr("terminal.progress.keyExchangeComplete", "Key exchange complete")}`;
            break;
          case 'auth-attempt':
            if (error?.endsWith('rejected')) {
              logLine = `${prefix}${label} - ✗ ${error}`;
            } else if (error === 'all methods exhausted') {
              logLine = `${prefix}${label} - ✗ All authentication methods exhausted`;
            } else if (error === 'waiting for user input...' || error === 'user responded') {
              logLine = `${prefix}${label} - ${error}`;
            } else {
              logLine = `${prefix}${label} - ${tr("terminal.progress.trying", "Trying")} ${error}...`;
            }
            break;
          case 'authenticated':
            logLine = `${prefix}${label} - ${tr("terminal.progress.authenticated", "Authenticated")}`;
            break;
          case 'connected':
            logLine = `${prefix}${label} - ${tr("terminal.progress.connected", "Connected")}`;
            break;
          case 'forwarding':
            logLine = `${prefix}${label} - ${tr("terminal.progress.forwarding", "Forwarding")}...`;
            break;
          case 'shell':
            logLine = `${prefix}${tr("terminal.progress.openingShell", "Opening shell")}...`;
            break;
          case 'error':
            logLine = `${prefix}${label} - ${tr("terminal.progress.error", "Error")}${error ? `: ${error}` : ''}`;
            break;
          default:
            logLine = `${prefix}${label} - ${status}${error ? `: ${error}` : ''}`;
        }

        if (status === 'connecting' || status === 'forwarding') {
          ctx.setIsConnectionPastTcpDial?.(false);
        }
        if (status === 'auth-attempt' && error === 'waiting for user input...') {
          ctx.setIsConnectionAwaitingUserInput?.(true);
        } else if (status === 'auth-attempt' && error === 'user responded') {
          ctx.setIsConnectionAwaitingUserInput?.(false);
        } else if (status === 'authenticated' || status === 'connected' || status === 'shell' || status === 'error') {
          ctx.setIsConnectionAwaitingUserInput?.(false);
        }
        if (hasConnectionPassedTcpDial(status)) {
          ctx.setIsConnectionPastTcpDial?.(true);
        }

        ctx.setProgressLogs((prev) => [...prev, logLine]);
        const hopProgress = resolveHopConnectionProgress(hop, total);
        ctx.setProgressValue((prev) => advanceMonotonicConnectionProgress(prev, hopProgress));
      });
      if (unsub) unsubscribeChainProgress = unsub;
    }

    try {
      const termEnv = buildTermEnv(ctx.host, ctx.terminalSettings);

      const authMethod = resolvedAuth.authMethod;
      const allowsLocalIdentityFallback = !resolvedAuth.keyId;
      const targetReferenceKeyPath = key?.source === 'reference' ? key.filePath : undefined;
      const targetIdentityFilePaths = authMethod === "password"
        ? undefined
        : targetReferenceKeyPath
          ? [targetReferenceKeyPath]
          : allowsLocalIdentityFallback
            ? ctx.host.identityFilePaths
            : undefined;

      let sourceReuseAttemptedWithinStart = false;
      const startAttempt = async (attempt: {
        password?: string;
        key?: SSHKey;
        useIdentityFiles?: boolean;
        useSshAgent?: boolean;
      }): Promise<string> => {
        const sourceSessionId = ctx.reuseConnectionFromSessionIdRef?.current;
        const sourceReuseAttempted = ctx.reuseConnectionSourceAttemptedRef?.current
          ?? sourceReuseAttemptedWithinStart;
        const isFallbackAfterSourceReuse = sourceReuseAttempted && !sourceSessionId;
        if (ctx.reuseConnectionFromSessionIdRef) {
          ctx.reuseConnectionFromSessionIdRef.current = undefined;
        }
        if (sourceSessionId) {
          sourceReuseAttemptedWithinStart = true;
          if (ctx.reuseConnectionSourceAttemptedRef) {
            ctx.reuseConnectionSourceAttemptedRef.current = true;
          }
        }
        ctx.setConnectionReuseAttemptSourceId?.(sourceSessionId);
        ctx.setIsConnectionAwaitingUserInput?.(false);
        ctx.setIsConnectionPastTcpDial?.(false);
        // Resolve keepalive per-host: a host can opt into its own values
        // (e.g. set interval=0 on an embedded device whose SSH stack
        // doesn't reply to keepalive@openssh.com) while everything else
        // inherits the cloud-friendly global setting.
        const keepalive = resolveHostKeepalive(
          ctx.host,
          globalTerminalSettings,
        );
        const connectionTimeouts = resolveHostSshConnectionTimeouts(ctx.host);
        const requiresFreshSshConnection = ctx.shouldUseFreshSshConnection?.() === true;
        const startedSessionId = await ctx.terminalBackend.startSSHSession({
          sessionId: ctx.sessionId,
          hostLabel: ctx.host.label,
          hostname: ctx.host.hostname,
          hostId: ctx.host.id,
          username: effectiveUsername,
          authMethod,
          requiresMfa: !!ctx.host.requiresMfa,
          port: ctx.host.port || 22,
          password: attempt.password,
          privateKey: attempt.key?.source === 'reference' ? undefined : sanitizeCredentialValue(attempt.key?.privateKey),
          certificate: attempt.key?.certificate,
          publicKey: attempt.key?.publicKey,
          keyId: attempt.key?.id,
          keySource: attempt.key?.source,
          passphrase: attempt.key
            ? (effectivePassphrase || sanitizeCredentialValue(attempt.key.passphrase))
            : undefined,
          agentForwarding: ctx.host.agentForwarding,
          x11Forwarding: ctx.host.x11Forwarding,
          x11Display: ctx.terminalSettings?.x11Display,
          legacyAlgorithms: ctx.host.legacyAlgorithms,
          skipEcdsaHostKey: ctx.host.skipEcdsaHostKey,
          algorithmOverrides: ctx.host.algorithms,
          cols: term.cols,
          rows: term.rows,
          charset: ctx.host.charset,
          // Persist for session-backed SFTP opens (AI tools / clipboard paste).
          sftpFileProtocol: ctx.host.sftpFileProtocol || "auto",
          env: termEnv,
          proxy: proxyConfig,
          jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
          keepaliveInterval: keepalive.interval,
          keepaliveCountMax: keepalive.countMax,
          sshTcpConnectTimeoutMs: connectionTimeouts.tcpConnectTimeoutSeconds * 1000,
          sshAuthReadyTimeoutMs: connectionTimeouts.authReadyTimeoutSeconds * 1000,
          verifyHostKeys: globalTerminalSettings.verifyHostKeys,
          bootEpoch,
          sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
          sshDebugLogEnabled: ctx.sshDebugLogEnabled,
          identityFilePaths: attempt.useIdentityFiles ? targetIdentityFilePaths : undefined,
          ...resolveBridgeSshAgentAuth(
            attempt.useSshAgent === false
              ? { ...ctx.host, useSshAgent: false }
              : ctx.host,
            attempt.key,
            authMethod,
          ),
          knownHosts: ctx.knownHosts,
          sudoAutofillPassword: resolveSavedSudoAutofillPassword(),
          // Ask the bridge to reuse the source tab's authenticated connection
          // (issue #1204). Only honored on the very first connect attempt; the
          // bridge silently falls back to a fresh connection if the source is
          // gone, so reconnect/retry after the source closed still works.
          sourceSessionId,
          // Connect-time automation must see the complete login sequence. An
          // explicit Copy/Split keeps its source-session reuse contract, while
          // an ordinary open bypasses endpoint/idle transport reuse.
          reuseTransport: !sourceSessionId && (requiresFreshSshConnection || isFallbackAfterSourceReuse)
            ? false
            : undefined,
          skipShellPidDiscovery: ctx.isNetworkDevice === true,
        });
        if (!requiresFreshSshConnection) {
          ctx.onConnectAutomationSnapshotCommitted?.();
        }
        sourceReuseAttemptedWithinStart = false;
        if (ctx.reuseConnectionSourceAttemptedRef) {
          ctx.reuseConnectionSourceAttemptedRef.current = false;
        }
        return startedSessionId;
      };

      let id: string;
      // Respect explicit auth method selection - don't use key if password auth was explicitly selected
      const usesSystemAgent = resolveBridgeSshAgentAuth(ctx.host, key, authMethod).useSshAgent === true;
      const hasKeyMaterial = usesSystemAgent || (
        (!!sanitizeCredentialValue(key?.privateKey) || !!targetIdentityFilePaths?.length)
        && (authMethod !== 'password' || ctx.host.useSshAgent === true)
      );
      const hasPassword = !!effectivePassword;

      const needsCredentialReentry =
        (authMethod === "password" && hasEncryptedPrimaryPassword && !hasPassword) ||
        (authMethod !== "password" && authMethod !== "auto" && hasEncryptedPrimaryKey && !hasKeyMaterial && !hasPassword);

      if (needsCredentialReentry) {
        if (unsubscribeChainProgress) unsubscribeChainProgress();
        ctx.setError(null);
        ctx.setNeedsAuth(true);
        ctx.setAuthRetryMessage(
          tr(
            "terminal.auth.credentialsUnavailable",
            "Saved credentials cannot be decrypted on this device. Please re-enter and save them again.",
          ),
        );
        ctx.setAuthPassword("");
        ctx.setProgressLogs((prev) => [
          ...prev,
          tr(
            "terminal.auth.credentialsUnavailable",
            "Saved credentials cannot be decrypted on this device. Please re-enter and save them again.",
          ),
        ]);
        ctx.setStatus("connecting");
        ctx.setChainProgress(null);
        return;
      }

      if (!hasKeyMaterial && authMethod !== "password" && hasEncryptedPrimaryKey && hasPassword) {
        ctx.setProgressLogs((prev) => [
          ...prev,
          tr(
            "terminal.auth.keyUnavailableFallbackPassword",
            "Saved SSH key is unavailable on this device. Falling back to password authentication.",
          ),
        ]);
      }


      if (hasKeyMaterial) {
        try {
          id = await startAttempt({ key, password: hasPassword ? effectivePassword : undefined, useIdentityFiles: true });
        } catch (err) {
          if (isAuthError(err) && hasPassword) {
            // Disconnect/reconnect may have invalidated this boot; do not
            // launch a password fallback that cannot be cleaned up yet.
            if (!isCurrentAttempt()) throw err;
            ctx.setProgressLogs((prev) => [
              ...prev,
              "Key auth failed. Trying password...",
            ]);
            id = await startAttempt({ password: effectivePassword, useSshAgent: false });
          } else {
            throw err;
          }
        }
      } else {
        id = await startAttempt({ password: effectivePassword });
      }

      if (unsubscribeChainProgress) unsubscribeChainProgress();
      // A superseded start may still resolve after reconnect; do not clear the
      // replacement's MFA wait / connection-timeout state, and do not close the
      // shared sessionId while the newer boot is active.
      if (!isCurrentAttempt()) {
        closeOrphanBackendSession(ctx, id, { bootEpoch });
        return;
      }
      ctx.setIsConnectionAwaitingUserInput?.(false);

      if (!tryAttachSessionToTerminal(ctx, term, id, {
        isCurrentAttempt,
        bootEpoch,
        onConnected: () => ctx.setChainProgress(null),
        onExitMessage: (evt) =>
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        sudoAutofillPassword: resolveSavedSudoAutofillPassword(),
        sudoAutofillCandidates: resolveSudoAutofillCandidates(),
      })) {
        // Only the current attempt may clear UI; a stale attach must not
        // disconnect a newer reconnect that already re-armed boot.
        if (isCurrentAttempt()) abortSessionStartAfterUnmount();
        return;
      }

      consumeRestoreCwdIntent(term, id);
      scheduleStartupCommand(ctx, term, id);

      // Run OS detection only after successful connection. Mint a fresh
      // token for this specific connection attempt and register it as
      // the current one for this sessionId slot; any previous timer
      // scheduled against an earlier token will see the replacement
      // and bail out. The detection function re-checks the token after
      // every async await so a reconnect mid-probe is also caught.
      {
        const connectionToken = registerConnectionToken(id);
        setTimeout(() => {
          if (!isConnectionTokenCurrent(id, connectionToken)) return;
          void runDistroDetection(ctx, id, connectionToken);
        }, 600);
      }
    } catch (err) {
      // Always drop this attempt's progress listener; only the current
      // boot may reset shared reconnect/UI state that a replacement owns.
      if (unsubscribeChainProgress) unsubscribeChainProgress();
      if (ignoreStaleAttemptUi()) return;
      ctx.setChainProgress(null);
      ctx.setIsConnectionAwaitingUserInput?.(false);
      ctx.setIsConnectionPastTcpDial?.(false);

      const message = err instanceof Error ? err.message : String(err);
      const authError = isAuthError(err);

      if (isJumpHostAuthError(err, message)) {
        ctx.setNeedsAuth(false);
        ctx.setAuthRetryMessage(null);
        ctx.setAuthPassword("");
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[Failed to start SSH: ${message}]`);
        ctx.updateStatus("disconnected");
      } else if (authError) {
        ctx.setError(null);
        ctx.setNeedsAuth(true);
        ctx.setAuthRetryMessage(
          tr(
            "terminal.auth.retryMessage",
            "Authentication failed. Please check your credentials and try again.",
          ),
        );
        ctx.setAuthPassword("");
        ctx.setProgressLogs((prev) => [
          ...prev,
          tr("terminal.auth.retryLog", "Authentication failed. Please try again."),
        ]);
        ctx.setStatus("connecting");
      } else {
        ctx.setNeedsAuth(false);
        ctx.setAuthRetryMessage(null);
        ctx.setAuthPassword("");
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[Failed to start SSH: ${message}]`);
        ctx.updateStatus("disconnected");
      }
    }
  };

  const startTelnet = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    if (!ctx.terminalBackend.telnetAvailable()) {
      ctx.setError("Telnet bridge unavailable. Please run the desktop build.");
      writeTerminalLine(ctx, term, "\r\n[Telnet bridge unavailable. Please run the desktop build.]");
      ctx.updateStatus("disconnected");
      return;
    }

    if (ctx.host.proxyProfileId && !ctx.host.proxyConfig) {
      const message = `Saved proxy for host "${ctx.host.label || ctx.host.hostname}" is missing. Open host settings and select a valid proxy.`;
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    if (findMissingProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
      const message = formatMissingProxyIdentityMessage(ctx.host.label || ctx.host.hostname);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    if (findIncompleteProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
      const message = formatIncompleteProxyIdentityMessage(ctx.host.label || ctx.host.hostname);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }

    if (hasUsableProxyConfig(ctx.host.proxyConfig)) {
      const message = "Telnet does not support proxy connections. Use SSH for this host or remove the proxy from this connection.";
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }

    let disposeAutoLoginComplete: (() => void) | undefined;
    let disposeAutoLoginCancelled: (() => void) | undefined;
    let cancelPendingStartupCommand: (() => void) | undefined;
    const disposeAutoLoginListener = () => {
      disposeAutoLoginComplete?.();
      disposeAutoLoginComplete = undefined;
    };
    const disposeAutoLoginCancelListener = () => {
      disposeAutoLoginCancelled?.();
      disposeAutoLoginCancelled = undefined;
    };
    const cleanupTelnetStartupWait = () => {
      disposeAutoLoginListener();
      disposeAutoLoginCancelListener();
      cancelPendingStartupCommand?.();
      cancelPendingStartupCommand = undefined;
    };
    const cleanupTelnetSession = () => {
      cleanupTelnetStartupWait();
      clearTelnetEchoMode();
    };
    try {
      const telnetEnv = buildTermEnv(ctx.host, ctx.terminalSettings);
      const telnetIdentity = ctx.host.telnetIdentityId
        ? ctx.identities.find((identity) => identity.id === ctx.host.telnetIdentityId)
        : undefined;
      if (ctx.host.telnetIdentityId && !telnetIdentity) {
        const message = "Telnet identity is missing. Open host settings and select a valid identity.";
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[${message}]`);
        ctx.updateStatus("disconnected");
        return;
      }
      if (telnetIdentity && (!telnetIdentity.username?.trim() || telnetIdentity.password === undefined)) {
        const message = "Telnet identity must include a username and password. Open host settings and select a password identity.";
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[${message}]`);
        ctx.updateStatus("disconnected");
        return;
      }
      const telnetUsername = telnetIdentity
        ? telnetIdentity.username?.trim()
        : resolveTelnetUsername(ctx.host);
      const rawTelnetPassword = telnetIdentity
        ? telnetIdentity.password
        : resolveTelnetPassword(ctx.host);
      const telnetPassword = sanitizeCredentialValue(rawTelnetPassword);
      const hasTelnetPasswordForAutoLogin = rawTelnetPassword !== undefined;
      if (isEncryptedCredentialPlaceholder(rawTelnetPassword)) {
        const message = tr(
          "terminal.auth.credentialsUnavailable",
          "Saved credentials cannot be decrypted on this device. Please re-enter and save them again.",
        );
        ctx.setNeedsAuth(false);
        ctx.setAuthRetryMessage(null);
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[${message}]`);
        ctx.updateStatus("disconnected");
        return;
      }
      const commandToRun = resolveStartupCommand(ctx);
      const waitsForAutoLogin = Boolean(
        commandToRun &&
        (telnetUsername || hasTelnetPasswordForAutoLogin) &&
        ctx.terminalBackend.onTelnetAutoLoginComplete,
      );
      let telnetSessionId = ctx.sessionId;
      if (waitsForAutoLogin) {
        disposeAutoLoginComplete = ctx.terminalBackend.onTelnetAutoLoginComplete?.(
          ctx.sessionId,
          (evt) => {
            if (
              Number.isFinite(bootEpoch)
              && Number.isFinite(evt?.bootEpoch)
              && evt.bootEpoch !== bootEpoch
            ) {
              return;
            }
            disposeAutoLoginListener();
            cancelPendingStartupCommand = scheduleStartupCommand(ctx, term, telnetSessionId, () => {
              cancelPendingStartupCommand = undefined;
              disposeAutoLoginCancelListener();
            });
          },
        );
        disposeAutoLoginCancelled = ctx.terminalBackend.onTelnetAutoLoginCancelled?.(
          ctx.sessionId,
          (evt) => {
            if (
              Number.isFinite(bootEpoch)
              && Number.isFinite(evt?.bootEpoch)
              && evt.bootEpoch !== bootEpoch
            ) {
              return;
            }
            cleanupTelnetStartupWait();
          },
        );
      }
      attachTelnetEchoMode(ctx.sessionId);
      const id = await ctx.terminalBackend.startTelnetSession({
        sessionId: ctx.sessionId,
        protocol: ctx.host.protocol,
        hostname: ctx.host.hostname,
        port: resolveTelnetPort(ctx.host),
        username: telnetUsername,
        password: telnetPassword,
        cols: term.cols,
        rows: term.rows,
        charset: ctx.host.charset,
        env: telnetEnv,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
        bootEpoch,
      });
      telnetSessionId = id;
      if (id !== ctx.sessionId) {
        attachTelnetEchoMode(id);
      }

      if (!tryAttachSessionToTerminal(ctx, term, id, {
        isCurrentAttempt,
        bootEpoch,
        onExitMessage: (evt) =>
          `\r\n[Telnet session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        onExit: cleanupTelnetSession,
      })) {
        cleanupTelnetSession();
        if (isCurrentAttempt()) abortSessionStartAfterUnmount();
        return;
      }

      // Many telnet endpoints (especially no-auth devices) stay silent until
      // the client sends data. Mark connected once the socket session is
      // attached so the connection overlay dismisses and keyboard input works
      // (issue #1632).
      ctx.updateStatus("connected");
      ctx.setProgressValue(100);

      if (waitsForAutoLogin) {
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(TELNET_SESSION_REPLACED_ERROR)) {
        cleanupTelnetStartupWait();
        return;
      }
      cleanupTelnetSession();
      if (ignoreStaleAttemptUi()) return;
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[Failed to start Telnet: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  const startMosh = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    if (!ctx.terminalBackend.moshAvailable()) {
      ctx.setError("Mosh bridge unavailable. Please run the desktop build.");
      writeTerminalLine(ctx, term, "\r\n[Mosh bridge unavailable. Please run the desktop build.]");
      ctx.updateStatus("disconnected");
      return;
    }

    // Hoisted so the catch path can dispose a ready subscription registered
    // before startMoshSession resolves.
    let disposeMoshReady: (() => void) | undefined;
    let cancelPendingStartupCommand: (() => void) | undefined;

    try {
      const stopMosh = (message: string) => {
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[${message}]`);
        ctx.updateStatus("disconnected");
      };

      if (ctx.host.proxyProfileId && !ctx.host.proxyConfig) {
        stopMosh(`Saved proxy for host "${ctx.host.label || ctx.host.hostname}" is missing. Open host settings and select a valid proxy.`);
        return;
      }
      if (findMissingProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
        stopMosh(formatMissingProxyIdentityMessage(ctx.host.label || ctx.host.hostname));
        return;
      }
      if (findIncompleteProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
        stopMosh(formatIncompleteProxyIdentityMessage(ctx.host.label || ctx.host.hostname));
        return;
      }

      const hasConfiguredJumpHostChain =
        (ctx.host.hostChain?.hostIds?.length || 0) > 0 ||
        ctx.resolvedChainHosts.length > 0;
      if (hasConfiguredJumpHostChain) {
        stopMosh("Mosh does not support jump host chains. Use SSH for this host or remove the jump hosts from this connection.");
        return;
      }

      const unresolvedJumpProxyHost = ctx.resolvedChainHosts.find((jumpHost) => jumpHost.proxyProfileId && !jumpHost.proxyConfig);
      if (unresolvedJumpProxyHost) {
        stopMosh(`Saved proxy for jump host "${unresolvedJumpProxyHost.label || unresolvedJumpProxyHost.hostname}" is missing. Open host settings and select a valid proxy.`);
        return;
      }

      const hasConfiguredProxy =
        hasUsableProxyConfig(ctx.host.proxyConfig) ||
        ctx.resolvedChainHosts.some((jumpHost) => hasUsableProxyConfig(jumpHost.proxyConfig));
      if (hasConfiguredProxy) {
        stopMosh("Mosh does not support proxy connections. Use SSH for this host or remove the proxy from this connection.");
        return;
      }

      const pendingAuth = ctx.pendingAuthRef.current;
      const resolvedAuth = resolveHostAuth({
        host: ctx.host,
        keys: ctx.keys,
        identities: ctx.identities,
        override: pendingAuth
          ? {
            authMethod: pendingAuth.authMethod,
            username: pendingAuth.username,
            password: pendingAuth.password,
            keyId: pendingAuth.keyId,
            passphrase: pendingAuth.passphrase,
          }
          : null,
      });
      const effectivePassword = sanitizeCredentialValue(resolvedAuth.password);
      const effectivePassphrase = sanitizeCredentialValue(resolvedAuth.passphrase);
      const authMethod = resolvedAuth.authMethod;
      const key = authMethod === "password" ? undefined : resolvedAuth.key;
      const hasEncryptedPrimaryPassword = isEncryptedCredentialPlaceholder(resolvedAuth.password);
      const hasEncryptedPrimaryKey = isEncryptedCredentialPlaceholder(resolvedAuth.key?.privateKey);
      const allowsLocalIdentityFallback = !resolvedAuth.keyId;
      const moshReferenceKeyPath = key?.source === 'reference' ? key.filePath : undefined;
      const moshIdentityFilePaths = authMethod === "password"
        ? undefined
        : moshReferenceKeyPath
          ? [moshReferenceKeyPath]
          : allowsLocalIdentityFallback
            ? ctx.host.identityFilePaths
            : undefined;
      const moshAgentAuth = resolveBridgeSshAgentAuth(ctx.host, key, authMethod);
      const usesSystemAgent = moshAgentAuth.useSshAgent === true;
      const hasKeyMaterial = usesSystemAgent || (
        (!!sanitizeCredentialValue(key?.privateKey) || !!moshIdentityFilePaths?.length)
        && (authMethod !== "password" || ctx.host.useSshAgent === true)
      );
      const hasPassword = !!effectivePassword;
      const needsCredentialReentry =
        (authMethod === "password" && hasEncryptedPrimaryPassword && !hasPassword) ||
        (authMethod !== "password" && authMethod !== "auto" && hasEncryptedPrimaryKey && !hasKeyMaterial && !hasPassword);

      if (needsCredentialReentry) {
        ctx.setError(null);
        ctx.setNeedsAuth(true);
        ctx.setAuthRetryMessage(
          tr(
            "terminal.auth.credentialsUnavailable",
            "Saved credentials cannot be decrypted on this device. Please re-enter and save them again.",
          ),
        );
        ctx.setAuthPassword("");
        ctx.setStatus("connecting");
        return;
      }

      const moshEnv = buildTermEnv(ctx.host, ctx.terminalSettings);

      // Defer startup commands until mosh-client is ready. The backend
      // handshake uses an ephemeral SSH PTY first; writing too early lands
      // input on that PTY and is lost on the swap (issue #2199).
      //
      // Do not gate status=connected on ready: interactive password/OTP
      // prompts during the SSH handshake need the overlay dismissed so the
      // user can type into the terminal. Scripts wait on moshShellReady in
      // Terminal.tsx instead.
      //
      // Subscribe BEFORE startMoshSession: a fast passwordless handshake can
      // emit ready before the await returns, and the event is not replayed.
      let sessionAttached = false;
      let moshReadyFired = false;
      let attachedSessionId = ctx.sessionId;
      const cleanupMoshStartupWait = () => {
        disposeMoshReady?.();
        disposeMoshReady = undefined;
        cancelPendingStartupCommand?.();
        cancelPendingStartupCommand = undefined;
      };
      const runMoshStartup = () => {
        disposeMoshReady?.();
        disposeMoshReady = undefined;
        cancelPendingStartupCommand = scheduleStartupCommand(ctx, term, attachedSessionId, () => {
          cancelPendingStartupCommand = undefined;
        });
      };
      const onMoshReady = (evt?: { sessionId: string; bootEpoch?: number }) => {
        if (
          Number.isFinite(bootEpoch)
          && Number.isFinite(evt?.bootEpoch)
          && evt.bootEpoch !== bootEpoch
        ) {
          return;
        }
        moshReadyFired = true;
        if (sessionAttached) {
          runMoshStartup();
        }
      };

      if (ctx.terminalBackend.onMoshSessionReady) {
        disposeMoshReady = ctx.terminalBackend.onMoshSessionReady(ctx.sessionId, onMoshReady);
      }

      const id = await ctx.terminalBackend.startMoshSession({
        sessionId: ctx.sessionId,
        hostname: ctx.host.hostname,
        username: resolvedAuth.username || "root",
        authMethod,
        requiresMfa: !!ctx.host.requiresMfa,
        password: effectivePassword,
        privateKey: (usesSystemAgent && !key?.certificate) || key?.source === 'reference' ? undefined : sanitizeCredentialValue(key?.privateKey),
        certificate: key?.certificate,
        keyId: key?.id,
        passphrase: key && (!usesSystemAgent || Boolean(key.certificate))
          ? (effectivePassphrase || sanitizeCredentialValue(key.passphrase))
          : undefined,
        identityFilePaths: moshIdentityFilePaths,
        ...moshAgentAuth,
        port: ctx.host.port || 22,
        moshServerPath: ctx.host.moshServerPath,
        agentForwarding: ctx.host.agentForwarding,
        // Forwarded for the host-info stats companion SSH connection (#1198):
        // Mosh's own handshake uses the system ssh (which reads ~/.ssh/config),
        // but Netcatty's ssh2 companion needs these to match the host's
        // negotiation on legacy / ECDSA-restricted servers.
        legacyAlgorithms: ctx.host.legacyAlgorithms,
        skipEcdsaHostKey: ctx.host.skipEcdsaHostKey,
        algorithmOverrides: ctx.host.algorithms,
        // Lets the stats companion verify the host key before sending a saved
        // password (#1198), so it never discloses it to an unvetted host.
        knownHosts: ctx.knownHosts,
        verifyHostKeys: globalTerminalSettings.verifyHostKeys,
        sudoAutofillPassword: resolveSavedSudoAutofillPassword(),
        cols: term.cols,
        rows: term.rows,
        charset: ctx.host.charset,
        env: moshEnv,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
        bootEpoch,
      });
      attachedSessionId = id;

      if (!tryAttachSessionToTerminal(ctx, term, id, {
        isCurrentAttempt,
        bootEpoch,
        onExitMessage: (evt) =>
          `\r\n[Mosh session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        // Real backend exit only — do not chain onto disposeExitRef, because
        // hibernate detaches exit listeners without closing the session and
        // would otherwise cancel a still-pending startup command.
        onExit: cleanupMoshStartupWait,
        sudoAutofillPassword: resolveSavedSudoAutofillPassword(),
        sudoAutofillCandidates: resolveSudoAutofillCandidates(),
      })) {
        cleanupMoshStartupWait();
        if (isCurrentAttempt()) abortSessionStartAfterUnmount();
        return;
      }
      sessionAttached = true;

      if (ctx.terminalBackend.onMoshSessionReady) {
        if (moshReadyFired) {
          runMoshStartup();
        }
      } else {
        // Older bridges without the ready event: keep previous behavior.
        scheduleStartupCommand(ctx, term, id);
      }
    } catch (err) {
      // Drop any pre-start ready subscription if handshake never attached.
      disposeMoshReady?.();
      disposeMoshReady = undefined;
      cancelPendingStartupCommand?.();
      cancelPendingStartupCommand = undefined;
      if (ignoreStaleAttemptUi()) return;
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[Failed to start Mosh: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  const startEt = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    if (!ctx.terminalBackend.etAvailable()) {
      ctx.setError("EternalTerminal bridge unavailable. Please run the desktop build.");
      writeTerminalLine(ctx, term, "\r\n[EternalTerminal bridge unavailable. Please run the desktop build.]");
      ctx.updateStatus("disconnected");
      return;
    }

    try {
      const stopEt = (message: string) => {
        ctx.setError(message);
        writeTerminalLine(ctx, term, `\r\n[${message}]`);
        ctx.updateStatus("disconnected");
      };

      if (ctx.host.proxyProfileId && !ctx.host.proxyConfig) {
        stopEt(`Saved proxy for host "${ctx.host.label || ctx.host.hostname}" is missing. Open host settings and select a valid proxy.`);
        return;
      }
      if (findMissingProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
        stopEt(formatMissingProxyIdentityMessage(ctx.host.label || ctx.host.hostname));
        return;
      }
      if (findIncompleteProxyIdentityId(ctx.host.proxyConfig, ctx.identities)) {
        stopEt(formatIncompleteProxyIdentityMessage(ctx.host.label || ctx.host.hostname));
        return;
      }

      if (hasUsableProxyConfig(ctx.host.proxyConfig)) {
        stopEt(tr(
          "terminal.et.proxyUnsupported",
          "EternalTerminal does not currently support Netcatty proxy settings. Use SSH or remove the proxy for this host.",
        ));
        return;
      }

      // Enforce the "at most one jump host" rule on the *configured* chain, not
      // just the resolved list. A second hop whose host ID fails to resolve
      // would otherwise slip past a resolved-length check and silently drop to
      // a single (or zero) hop.
      const configuredChainHostCount = ctx.host.hostChain?.hostIds?.length ?? 0;
      if (configuredChainHostCount > 1 || ctx.resolvedChainHosts.length > 1) {
        stopEt(tr(
          "terminal.et.multiJumpUnsupported",
          "EternalTerminal currently supports at most one jump host in Netcatty.",
        ));
        return;
      }

      // Mirror startSSH: if a configured jump host could not be resolved (its
      // host ID is missing/invalid), fail loudly instead of silently falling
      // back to a direct connection that may reach the wrong target.
      const missingChainHostIds = getMissingChainHostIds(ctx.host, ctx.resolvedChainHosts);
      if (missingChainHostIds.length > 0) {
        const base = tr(
          "terminal.auth.jumpHostMissing",
          "A configured jump host is missing. Open host settings and repair the jump host chain.",
        );
        const suffix = missingChainHostIds.length > 2
          ? ` +${missingChainHostIds.length - 2}`
          : "";
        stopEt(`${base} (${missingChainHostIds.slice(0, 2).join(", ")}${suffix})`);
        return;
      }

      const unresolvedJumpProxyHost = ctx.resolvedChainHosts.find((jumpHost) => jumpHost.proxyProfileId && !jumpHost.proxyConfig);
      if (unresolvedJumpProxyHost) {
        stopEt(`Saved proxy for jump host "${unresolvedJumpProxyHost.label || unresolvedJumpProxyHost.hostname}" is missing. Open host settings and select a valid proxy.`);
        return;
      }
      const unresolvedJumpProxyIdentityHost = ctx.resolvedChainHosts.find((jumpHost) =>
        findMissingProxyIdentityId(jumpHost.proxyConfig, ctx.identities),
      );
      if (unresolvedJumpProxyIdentityHost) {
        stopEt(formatMissingProxyIdentityMessage(
          unresolvedJumpProxyIdentityHost.label || unresolvedJumpProxyIdentityHost.hostname,
        ));
        return;
      }
      const incompleteJumpProxyIdentityHost = ctx.resolvedChainHosts.find((jumpHost) =>
        findIncompleteProxyIdentityId(jumpHost.proxyConfig, ctx.identities),
      );
      if (incompleteJumpProxyIdentityHost) {
        stopEt(formatIncompleteProxyIdentityMessage(
          incompleteJumpProxyIdentityHost.label || incompleteJumpProxyIdentityHost.hostname,
        ));
        return;
      }

      const pendingAuth = ctx.pendingAuthRef.current;
      const resolvedAuth = resolveHostAuth({
        host: ctx.host,
        keys: ctx.keys,
        identities: ctx.identities,
        override: pendingAuth
          ? {
            authMethod: pendingAuth.authMethod,
            username: pendingAuth.username,
            password: pendingAuth.password,
            keyId: pendingAuth.keyId,
            passphrase: pendingAuth.passphrase,
          }
          : null,
      });
      const effectivePassword = sanitizeCredentialValue(resolvedAuth.password);
      const effectivePassphrase = sanitizeCredentialValue(resolvedAuth.passphrase);
      const authMethod = resolvedAuth.authMethod;
      const key = authMethod === "password" ? undefined : resolvedAuth.key;
      const hasEncryptedPrimaryPassword = isEncryptedCredentialPlaceholder(resolvedAuth.password);
      const hasEncryptedPrimaryKey = isEncryptedCredentialPlaceholder(resolvedAuth.key?.privateKey);
      const allowsLocalIdentityFallback = !resolvedAuth.keyId;
      const etReferenceKeyPath = key?.source === 'reference' ? key.filePath : undefined;
      const etIdentityFilePaths = authMethod === "password"
        ? undefined
        : etReferenceKeyPath
          ? [etReferenceKeyPath]
          : allowsLocalIdentityFallback
            ? ctx.host.identityFilePaths
            : undefined;
      const etAgentAuth = resolveBridgeSshAgentAuth(ctx.host, key, authMethod);
      const usesSystemAgent = etAgentAuth.useSshAgent === true;
      const hasKeyMaterial = usesSystemAgent || (
        (!!sanitizeCredentialValue(key?.privateKey) || !!etIdentityFilePaths?.length)
        && (authMethod !== "password" || ctx.host.useSshAgent === true)
      );
      const hasPassword = !!effectivePassword;
      const needsCredentialReentry =
        (authMethod === "password" && hasEncryptedPrimaryPassword && !hasPassword) ||
        (authMethod !== "password" && authMethod !== "auto" && hasEncryptedPrimaryKey && !hasKeyMaterial && !hasPassword);

      if (needsCredentialReentry) {
        ctx.setError(null);
        ctx.setNeedsAuth(true);
        ctx.setAuthRetryMessage(
          tr(
            "terminal.auth.credentialsUnavailable",
            "Saved credentials cannot be decrypted on this device. Please re-enter and save them again.",
          ),
        );
        ctx.setAuthPassword("");
        ctx.setStatus("connecting");
        return;
      }

      const jumpHostsWithUnavailableCredentials: string[] = [];
      const unsupportedJumpProxies: string[] = [];
      const jumpHosts = ctx.resolvedChainHosts.map<NetcattyJumpHost>((jumpHost) => {
        const jumpAuth = resolveHostAuth({
          host: jumpHost,
          keys: ctx.keys,
          identities: ctx.identities,
        });
        const jumpKey = jumpAuth.key;
        const rawJumpPassword = jumpAuth.password;
        const rawJumpPrivateKey = jumpKey?.privateKey;
        const rawJumpPassphrase = jumpAuth.passphrase || jumpKey?.passphrase;
        const jumpPassword = sanitizeCredentialValue(rawJumpPassword);
        const jumpPrivateKey = sanitizeCredentialValue(rawJumpPrivateKey);
        const jumpPassphrase = sanitizeCredentialValue(rawJumpPassphrase);

        if (hasUsableProxyConfig(jumpHost.proxyConfig)) {
          unsupportedJumpProxies.push(jumpHost.label || jumpHost.hostname);
        }

        const hasEncryptedJumpCredential =
          isEncryptedCredentialPlaceholder(rawJumpPassword) ||
          isEncryptedCredentialPlaceholder(rawJumpPrivateKey) ||
          isEncryptedCredentialPlaceholder(rawJumpPassphrase);
        const jumpAgentAuth = resolveBridgeSshAgentAuth(jumpHost, jumpKey, jumpAuth.authMethod);
        if (
          jumpAuth.authMethod !== "auto"
          && hasEncryptedJumpCredential
          && !jumpPassword
          && !jumpPrivateKey
          && !jumpPassphrase
          && !jumpAgentAuth.useSshAgent
        ) {
          jumpHostsWithUnavailableCredentials.push(jumpHost.label || jumpHost.hostname);
        }

        // Mirror startSSH: a reference key lives on disk, so forward its path as
        // an IdentityFile instead of dropping it (privateKey is undefined for
        // reference keys). Without this, ET jump-host key auth silently falls
        // back to defaults even when a valid key is selected.
        const jumpAllowsLocalIdentityFallback = !jumpAuth.keyId;
        const jumpReferenceKeyPath = jumpAuth.authMethod === "password"
          ? undefined
          : jumpKey?.source === 'reference' ? jumpKey.filePath : undefined;
        const jumpIdentityFilePaths = jumpAuth.authMethod === "password"
          ? undefined
          : jumpReferenceKeyPath
            ? [jumpReferenceKeyPath]
            : jumpAllowsLocalIdentityFallback
              ? jumpHost.identityFilePaths
              : undefined;

        return {
          hostname: jumpHost.hostname,
          hostId: jumpHost.id,
          port: jumpHost.port || 22,
          // ET server port on this bastion: the bridge tunnels the ET socket to
          // the jumphost's etserver, so a custom etPort must be forwarded or it
          // defaults to 2022 and the connection fails.
          etPort: jumpHost.etPort,
          username: jumpAuth.username || "root",
          authMethod: jumpAuth.authMethod,
          password: jumpPassword,
          privateKey: (jumpAgentAuth.useSshAgent && !jumpKey?.certificate) || jumpKey?.source === 'reference' ? undefined : jumpPrivateKey,
          certificate: jumpKey?.certificate,
          passphrase: jumpAgentAuth.useSshAgent && !jumpKey?.certificate ? undefined : jumpPassphrase,
          keyId: jumpAuth.keyId,
          keySource: jumpKey?.source,
          label: jumpHost.label,
          identityFilePaths: jumpIdentityFilePaths,
          ...jumpAgentAuth,
        };
      });

      if (unsupportedJumpProxies.length > 0) {
        stopEt(tr(
          "terminal.et.proxyUnsupported",
          "EternalTerminal does not currently support Netcatty proxy settings. Use SSH or remove the proxy for this host.",
        ));
        return;
      }

      if (jumpHostsWithUnavailableCredentials.length > 0) {
        const jumpList = jumpHostsWithUnavailableCredentials.slice(0, 2).join(", ");
        const suffix = jumpHostsWithUnavailableCredentials.length > 2
          ? ` +${jumpHostsWithUnavailableCredentials.length - 2}`
          : "";
        const base = tr(
          "terminal.auth.jumpCredentialsUnavailable",
          "A jump host has saved credentials that cannot be decrypted on this device. Open host settings and re-enter them.",
        );
        stopEt(`${base} (${jumpList}${suffix})`);
        return;
      }

      const etEnv = buildTermEnv(ctx.host, ctx.terminalSettings);
      const id = await ctx.terminalBackend.startEtSession({
        sessionId: ctx.sessionId,
        hostname: ctx.host.hostname,
        hostId: ctx.host.id,
        username: resolvedAuth.username || "root",
        password: effectivePassword,
        privateKey: (usesSystemAgent && !key?.certificate) || key?.source === 'reference' ? undefined : sanitizeCredentialValue(key?.privateKey),
        certificate: key?.certificate,
        keyId: key?.id,
        passphrase: key && (!usesSystemAgent || Boolean(key.certificate))
          ? (effectivePassphrase || sanitizeCredentialValue(key.passphrase))
          : undefined,
        authMethod,
        identityFilePaths: etIdentityFilePaths,
        ...etAgentAuth,
        port: ctx.host.port || 22,
        etPort: ctx.host.etPort,
        legacyAlgorithms: ctx.host.legacyAlgorithms,
        skipEcdsaHostKey: ctx.host.skipEcdsaHostKey,
        algorithmOverrides: ctx.host.algorithms,
        knownHosts: ctx.knownHosts,
        verifyHostKeys: globalTerminalSettings.verifyHostKeys,
        jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
        agentForwarding: ctx.host.agentForwarding,
        sudoAutofillPassword: resolveSavedSudoAutofillPassword(),
        cols: term.cols,
        rows: term.rows,
        charset: ctx.host.charset,
        env: etEnv,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
        bootEpoch,
      });

      if (!tryAttachSessionToTerminal(ctx, term, id, {
        isCurrentAttempt,
        bootEpoch,
        onExitMessage: (evt) =>
          `\r\n[EternalTerminal session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        sudoAutofillPassword: resolveSavedSudoAutofillPassword(),
        sudoAutofillCandidates: resolveSudoAutofillCandidates(),
      })) {
        // Only the current attempt may clear UI; a stale attach must not
        // disconnect a newer reconnect that already re-armed boot.
        if (isCurrentAttempt()) abortSessionStartAfterUnmount();
        return;
      }

      scheduleStartupCommand(ctx, term, id);

      // ET sessions are full remote shells, so run OS detection like SSH for
      // server stats / distro icons.
      {
        const connectionToken = registerConnectionToken(id);
        setTimeout(() => {
          if (!isConnectionTokenCurrent(id, connectionToken)) return;
          void runDistroDetection(ctx, id, connectionToken);
        }, 600);
      }
    } catch (err) {
      if (ignoreStaleAttemptUi()) return;
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[Failed to start EternalTerminal: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  const startPluginConnection = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    if (!ctx.terminalBackend.pluginConnectionAvailable()) {
      ctx.setError("Plugin connection bridge unavailable. Please run the desktop build with Plugin Development enabled.");
      writeTerminalLine(ctx, term, "\r\n[Plugin connection bridge unavailable.]");
      ctx.updateStatus("disconnected");
      return;
    }
    if (!isPluginHostProtocol(ctx.host.protocol)) {
      ctx.setError("Plugin connection protocol is invalid.");
      ctx.updateStatus("disconnected");
      return;
    }
    const connection = sanitizePluginConnection(ctx.host.pluginConnection, ctx.host.protocol);
    if (!connection) {
      const message = "Plugin connection configuration is missing or invalid. Open host settings and select an installed connection Provider.";
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }
    const requestId = createPluginConnectionRequestId();
    const startController = new AbortController();
    let pendingCancelReleased = false;
    let bootMonitorTimer: ReturnType<typeof setTimeout> | null = null;
    const previousDisposeExit = ctx.disposeExitRef.current;
    const clearBootMonitor = () => {
      if (bootMonitorTimer === null) return;
      clearTimeout(bootMonitorTimer);
      bootMonitorTimer = null;
    };
    const cancelPendingStart = () => {
      previousDisposeExit?.();
      if (pendingCancelReleased) return;
      pendingCancelReleased = true;
      clearBootMonitor();
      startController.abort(new DOMException("Plugin connection request was cancelled", "AbortError"));
      if (ctx.terminalBackend.cancelPluginExtensionRequest) {
        try {
          const cancelPromise = Promise.resolve(
            ctx.terminalBackend.cancelPluginExtensionRequest(requestId),
          ).catch((err) => {
            logger.warn("Failed to cancel pending plugin connection request", err);
          });
          ctx.trackSessionCleanup?.(cancelPromise);
        } catch (err) {
          logger.warn("Failed to cancel pending plugin connection request", err);
        }
      }
    };
    const scheduleBootMonitor = () => {
      if (pendingCancelReleased) return;
      bootMonitorTimer = setTimeout(() => {
        bootMonitorTimer = null;
        if (pendingCancelReleased) return;
        if (!isCurrentAttempt()) {
          cancelPendingStart();
          return;
        }
        scheduleBootMonitor();
      }, 50);
    };
    // The mount effect aborts its boot controller before the async teardown
    // runs, so forward that straight to the in-flight extension request.
    const onBootAborted = () => cancelPendingStart();
    const releasePendingStartCancellation = () => {
      options?.signal?.removeEventListener("abort", onBootAborted);
      if (ctx.disposeExitRef.current === cancelPendingStart) {
        ctx.disposeExitRef.current = previousDisposeExit;
      }
      pendingCancelReleased = true;
      clearBootMonitor();
    };
    ctx.disposeExitRef.current = cancelPendingStart;
    options?.signal?.addEventListener("abort", onBootAborted, { once: true });
    scheduleBootMonitor();
    try {
      const startPromise = ctx.terminalBackend.startPluginConnection({
        requestId,
        sessionId: ctx.sessionId,
        protocol: ctx.host.protocol,
        hostLabel: ctx.host.label,
        hostname: ctx.host.hostname,
        providerId: connection.providerId,
        configuration: connection.configuration,
        columns: term.cols,
        rows: term.rows,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
        ...(connection.authenticationProviderId
          ? { authenticationProviderId: connection.authenticationProviderId }
          : {}),
        ...(connection.credentialId
          ? { credential: { kind: "credential" as const, id: connection.credentialId } }
          : {}),
        signal: startController.signal,
      });
      // Disconnect may cancel before this settles; reconnect must wait until
      // finishExternalSession cleared the shared sessionId registration.
      ctx.trackSessionCleanup?.(startPromise);
      const opened = await startPromise;
      releasePendingStartCancellation();
      if (!isCurrentAttempt()) {
        closeOrphanBackendSession(ctx, opened.sessionId, { bootEpoch });
        return;
      }
      if (startController.signal.aborted) {
        closeOrphanBackendSession(ctx, opened.sessionId, { bootEpoch });
        abortSessionStartAfterUnmount();
        return;
      }
      const id = opened.sessionId;
      if (opened.diagnostics.length > 0) {
        ctx.setProgressLogs((previous) => [
          ...previous,
          ...formatPluginDiagnosticLines(opened.diagnostics),
        ]);
      }
      let startupScheduled = false;
      const schedulePluginStartup = () => {
        if (startupScheduled) return;
        startupScheduled = true;
        scheduleStartupCommand(ctx, term, id);
      };
      if (!tryAttachSessionToTerminal(ctx, term, id, {
        isCurrentAttempt,
        bootEpoch,
        onExitMessage: formatPluginConnectionExitMessage,
        requireExplicitConnectionReady: true,
        onConnected: (meta) => {
          if (meta?.pluginConnectionReady === true) schedulePluginStartup();
        },
      })) {
        // Only the current attempt may clear UI; a stale attach must not
        // disconnect a newer reconnect that already re-armed boot.
        if (isCurrentAttempt()) abortSessionStartAfterUnmount();
        return;
      }
      if (opened.status === "connected") {
        ctx.updateStatus("connected");
        schedulePluginStartup();
      }
    } catch (error) {
      releasePendingStartCancellation();
      if (ignoreStaleAttemptUi()) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.setError(message);
      writeTerminalLine(ctx, term, "\r\n[Failed to start plugin connection. See connection details.]");
      ctx.updateStatus("disconnected");
    }
  };

  const startLocal = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    if (!ctx.terminalBackend.localAvailable()) {
      ctx.setError("Local shell bridge unavailable. Please run the desktop build.");
      writeTerminalLine(
        ctx,
        term,
        "\r\n[Local shell bridge unavailable. Please run the desktop build to spawn a local terminal.]",
      );
      ctx.updateStatus("disconnected");
      return;
    }

    try {
      // Per-session shell (from QuickSwitcher discovery or split/copy) takes priority.
      // The global terminalSettings.localShell may contain a shell ID (e.g., "wsl-ubuntu")
      // which was already resolved to command+args and stored on the session object by App.tsx.
      // Only pass shell/shellArgs when we have concrete per-session values;
      // otherwise omit them so the backend uses its own default shell detection.
      const sessionShell = ctx.host.localShell;
      const sessionShellArgs = ctx.host.localShellArgs;
      const localStartDir = ctx.host.localStartDir || ctx.terminalSettings?.localStartDir;

      const id = await ctx.terminalBackend.startLocalSession({
        sessionId: ctx.sessionId,
        cols: term.cols,
        rows: term.rows,
        shell: sessionShell || undefined,
        shellArgs: sessionShellArgs || undefined,
        cwd: localStartDir,
        env: {
          TERM: ctx.terminalSettings?.terminalEmulationType ?? "xterm-256color",
        },
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
        bootEpoch,
      });

      if (!isCurrentAttempt()) {
        closeOrphanBackendSession(ctx, id, { bootEpoch });
        return;
      }

      ctx.sessionRef.current = id;
      const flow = getFlowController(ctx, term);
      teardownTerminalOutputPipeline(ctx, term, id, flow);
      flushTerminalWriteCoalescer(term);
      resetTerminalSyncBlockFilter(term);
      resetTerminalLineTimestampState(term);
      ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(
        id,
        (chunk, meta) => {
          const pluginPipelineIngressBytes = Number.isFinite(meta?.pluginPipelineIngressBytes)
            ? Math.max(0, Number(meta.pluginPipelineIngressBytes))
            : chunk.length;
          if (!chunk && pluginPipelineIngressBytes > 0) {
            acknowledgeDroppedTerminalDisplayBytes(ctx, pluginPipelineIngressBytes);
          } else {
            writeSessionData(ctx, term, chunk, pluginPipelineIngressBytes, meta);
          }
          ctx.onTerminalOutput?.(chunk, meta);
          if (!ctx.hasConnectedRef.current) {
            ctx.updateStatus("connected");
            setTimeout(() => {
              if (ctx.isVisibleRef?.current === false) {
                notePendingOutputScrollIfEnabled(ctx);
                return;
              }
              if (!ctx.fitAddonRef.current) return;
              try {
                ctx.fitAddonRef.current.fit();
                if (ctx.sessionRef.current) {
                  ctx.terminalBackend.resizeSession(ctx.sessionRef.current, term.cols, term.rows);
                }
              } catch (err) {
                logger.warn("Post-connect fit failed", err);
              }
            }, 100);
          }
        },
        { replayBacklog: true },
      );

      ctx.disposeExitRef.current = ctx.terminalBackend.onSessionExit(id, async (evt) => {
        ctx.updateStatus("disconnected");
        const exitMessage = `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`;
        writeTerminalLine(ctx, term, exitMessage);

        logger.info("[Terminal] Session exit, capturing data", {
          sessionId: ctx.sessionId,
          hasCallback: !!ctx.onTerminalDataCapture,
          hasSerializeAddon: !!ctx.serializeAddonRef.current,
        });

        if (ctx.onTerminalDataCapture && ctx.serializeAddonRef.current) {
          try {
            await ctx.prepareKeywordHighlightSerialization?.();
            const terminalData = ctx.serializeAddonRef.current.serialize();
            logger.info("[Terminal] Serialized terminal data", {
              sessionId: ctx.sessionId,
              dataLength: terminalData.length,
            });
            ctx.onTerminalDataCapture(ctx.sessionId, terminalData);
          } catch (err) {
            logger.warn("Failed to serialize terminal data:", err);
          }
        }

        ctx.onSessionExit?.(ctx.sessionId, evt);
      });

      ctx.onSessionAttached?.(id);
      consumeRestoreCwdIntent(term, id);
      scheduleStartupCommand(ctx, term, id);
    } catch (err) {
      if (ignoreStaleAttemptUi()) return;
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[Failed to start local shell: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  // Start Serial session
  const startSerial = async (term: XTerm, options?: TerminalSessionStartOptions) => {
    if (options?.signal?.aborted) return;
    const { isCurrentAttempt, ignoreStaleAttemptUi, bootEpoch } = createAttemptGuards(options);
    if (!ctx.serialConfig) {
      ctx.setError("No serial configuration provided");
      writeTerminalLine(ctx, term, "\r\n[Error: No serial configuration provided]");
      ctx.updateStatus("disconnected");
      return;
    }

    try {
      logger.info("[Serial] Starting serial session", {
        port: ctx.serialConfig.path,
        baudRate: ctx.serialConfig.baudRate,
      });

      const id = await ctx.terminalBackend.startSerialSession({
        sessionId: ctx.sessionId,
        path: ctx.serialConfig.path,
        baudRate: ctx.serialConfig.baudRate,
        dataBits: ctx.serialConfig.dataBits,
        stopBits: ctx.serialConfig.stopBits,
        parity: ctx.serialConfig.parity,
        flowControl: ctx.serialConfig.flowControl,
        charset: ctx.host.charset,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
        bootEpoch,
      });

      if (!tryAttachSessionToTerminal(ctx, term, id, {
        isCurrentAttempt,
        bootEpoch,
        onExitMessage: (evt) =>
          `\r\n[serial port closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        // Convert lone LF to CRLF to prevent "staircase effect" in serial terminals
        convertLfToCrlf: true,
      })) {
        // Only the current attempt may clear UI; a stale attach must not
        // disconnect a newer reconnect that already re-armed boot.
        if (isCurrentAttempt()) abortSessionStartAfterUnmount();
        return;
      }

      // Serial connection is established once the session is attached to the terminal.
      ctx.updateStatus("connected");
      ctx.setProgressValue(100);
      writeTerminalLine(ctx, term, `[Connected to ${ctx.serialConfig.path} at ${ctx.serialConfig.baudRate} baud]`);
    } catch (err) {
      if (ignoreStaleAttemptUi()) return;
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      writeTerminalLine(ctx, term, `\r\n[Failed to connect to serial port: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  const reattachSession = (term: XTerm) => {
    const id = ctx.sessionRef.current;
    if (!id) return false;
    ctx.disposeDataRef.current?.();
    ctx.disposeDataRef.current = null;
    ctx.disposeExitRef.current?.();
    ctx.disposeExitRef.current = null;
    const isSerial = ctx.host.protocol === "serial" || ctx.host.id?.startsWith("serial-");
    attachSessionToTerminal(ctx, term, id, {
      convertLfToCrlf: isSerial,
      sudoAutofillPassword: ctx.sudoAutofillPassword,
      sudoAutofillCandidates: resolveSudoAutofillCandidates(),
    });
    attachTelnetEchoMode(id, { resetLocalEcho: false });
    ctx.hasConnectedRef.current = true;
    return true;
  };

  return { startSSH, startTelnet, startMosh, startEt, startPluginConnection, startLocal, startSerial, reattachSession };
};
