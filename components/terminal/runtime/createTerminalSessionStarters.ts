import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { shouldScrollOnTerminalOutput } from "../../../domain/terminalScroll";
import { logger } from "../../../lib/logger";
import type { Host, Identity, SerialConfig, SSHKey, TerminalSession, TerminalSettings } from "../../../types";
import {
  isEncryptedCredentialPlaceholder,
  sanitizeCredentialValue,
} from "../../../domain/credentials";
import { resolveHostAuth } from "../../../domain/sshAuth";
import { detectVendorFromSshVersion } from "../../../domain/host";

/**
 * Per-connection token for stale-timer detection. The renderer reuses the
 * same sessionId across reconnects within a tab, so comparing sessionIds
 * cannot distinguish "the current attempt" from "a previous attempt on
 * the same slot". We assign each startSSH call a fresh token object and
 * store it in this module-local map, keyed by sessionId. A timer that
 * was scheduled under an older token will see a different value here and
 * bail out. The map entry for a sessionId is overwritten on each new
 * connect and stays around until the app exits — since there is only one
 * entry per active session, the memory cost is negligible.
 */
const connectionTokensBySessionId = new Map<string, object>();

const isConnectionTokenCurrent = (sessionId: string, token: object): boolean =>
  connectionTokensBySessionId.get(sessionId) === token;

type TerminalBackendApi = {
  backendAvailable: () => boolean;
  telnetAvailable: () => boolean;
  moshAvailable: () => boolean;
  localAvailable: () => boolean;
  serialAvailable: () => boolean;
  execAvailable: () => boolean;
  startSSHSession: (options: NetcattySSHOptions) => Promise<string>;
  startTelnetSession: (
    options: Parameters<NonNullable<NetcattyBridge["startTelnetSession"]>>[0],
  ) => Promise<string>;
  startMoshSession: (
    options: Parameters<NonNullable<NetcattyBridge["startMoshSession"]>>[0],
  ) => Promise<string>;
  startLocalSession: (
    options: Parameters<NonNullable<NetcattyBridge["startLocalSession"]>>[0],
  ) => Promise<string>;
  startSerialSession: (
    options: Parameters<NonNullable<NetcattyBridge["startSerialSession"]>>[0],
  ) => Promise<string>;
  execCommand: (options: Parameters<NetcattyBridge["execCommand"]>[0]) => Promise<{
    stdout?: string;
    stderr?: string;
  }>;
  getSessionRemoteInfo?: (sessionId: string) => Promise<{
    success: boolean;
    remoteSshVersion?: string;
    error?: string;
  }>;
  getSessionDistroInfo?: (sessionId: string) => Promise<{
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
  }>;
  onSessionData: (sessionId: string, cb: (data: string) => void) => () => void;
  onSessionExit: (
    sessionId: string,
    cb: (evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void,
  ) => () => void;
  onChainProgress: (
    cb: (sessionId: string, hop: number, total: number, label: string, status: string, error?: string) => void,
  ) => (() => void) | undefined;
  writeToSession: (sessionId: string, data: string) => void;
  resizeSession: (sessionId: string, cols: number, rows: number) => void;
};

export type PendingAuth = {
  authMethod: "password" | "key" | "certificate";
  username: string;
  password?: string;
  keyId?: string;
  passphrase?: string;
} | null;

type ChainProgressState = {
  currentHop: number;
  totalHops: number;
  currentHostLabel: string;
} | null;

export type SessionLogConfig = {
  enabled: boolean;
  directory: string;
  format: string;
};

export type TerminalSessionStartersContext = {
  host: Host;
  keys: SSHKey[];
  identities?: Identity[];
  resolvedChainHosts: Host[];
  sessionId: string;
  startupCommand?: string;
  noAutoRun?: boolean;
  terminalSettings?: TerminalSettings;
  terminalSettingsRef?: RefObject<TerminalSettings | undefined>;
  terminalBackend: TerminalBackendApi;
  serialConfig?: SerialConfig;
  sessionLog?: SessionLogConfig;
  isVisibleRef?: RefObject<boolean>;
  pendingOutputScrollRef?: RefObject<boolean>;

  sessionRef: RefObject<string | null>;
  hasConnectedRef: RefObject<boolean>;
  hasRunStartupCommandRef: RefObject<boolean>;
  disposeDataRef: RefObject<(() => void) | null>;
  disposeExitRef: RefObject<(() => void) | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  serializeAddonRef: RefObject<SerializeAddon | null>;
  pendingAuthRef: RefObject<PendingAuth>;

  updateStatus: (next: TerminalSession["status"]) => void;
  setStatus: Dispatch<SetStateAction<TerminalSession["status"]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNeedsAuth: Dispatch<SetStateAction<boolean>>;
  setAuthRetryMessage: Dispatch<SetStateAction<string | null>>;
  setAuthPassword: Dispatch<SetStateAction<string>>;
  setProgressLogs: Dispatch<SetStateAction<string[]>>;
  setProgressValue: Dispatch<SetStateAction<number>>;
  setChainProgress: Dispatch<SetStateAction<ChainProgressState>>;
  t?: (key: string) => string;

  onSessionAttached?: (sessionId: string) => void;
  onSessionExit?: (sessionId: string, evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void;
  onTerminalDataCapture?: (sessionId: string, data: string) => void;
  onOsDetected?: (hostId: string, distro: string) => void;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
};

const buildTermEnv = (host: Host, terminalSettings?: TerminalSettings) => {
  const env: Record<string, string> = {
    TERM: terminalSettings?.terminalEmulationType ?? "xterm-256color",
  };

  if (host.environmentVariables) {
    for (const { name, value } of host.environmentVariables) {
      if (name) env[name] = value;
    }
  }

  return env;
};

const handleTerminalOutputAutoScroll = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
) => {
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  if (!shouldScrollOnTerminalOutput(settings)) {
    return;
  }

  if (ctx.isVisibleRef?.current === false) {
    if (ctx.pendingOutputScrollRef) {
      ctx.pendingOutputScrollRef.current = true;
    }
    return;
  }

  term.scrollToBottom();
};

const writeSessionData = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  data: string,
) => {
  const settings = ctx.terminalSettingsRef?.current ?? ctx.terminalSettings;
  if (!shouldScrollOnTerminalOutput(settings)) {
    term.write(data);
    return;
  }

  term.write(data, () => {
    handleTerminalOutputAutoScroll(ctx, term);
  });
};

const attachSessionToTerminal = (
  ctx: TerminalSessionStartersContext,
  term: XTerm,
  id: string,
  opts?: {
    onExitMessage?: (evt: { exitCode?: number; signal?: number; error?: string; reason?: string }) => string;
    onConnected?: () => void;
    // For serial: convert lone LF to CRLF to avoid "staircase effect"
    convertLfToCrlf?: boolean;
  },
) => {
  ctx.sessionRef.current = id;
  ctx.onSessionAttached?.(id);

  ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(id, (chunk) => {
    let data = chunk;
    // Convert lone LF (\n) to CRLF (\r\n) for proper terminal display
    // This prevents the "staircase effect" common in serial terminals
    if (opts?.convertLfToCrlf) {
      // Replace \n that is not preceded by \r with \r\n
      data = data.replace(/(?<!\r)\n/g, "\r\n");
    }
    writeSessionData(ctx, term, data);
    if (!ctx.hasConnectedRef.current) {
      ctx.updateStatus("connected");
      opts?.onConnected?.();
      setTimeout(() => {
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
  });

  ctx.disposeExitRef.current = ctx.terminalBackend.onSessionExit(id, (evt) => {
    ctx.updateStatus("disconnected");
    if (evt.error) {
      ctx.setError(evt.error);
    }
    term.writeln(opts?.onExitMessage?.(evt) ?? "\r\n[session closed]");

    if (ctx.onTerminalDataCapture && ctx.serializeAddonRef.current) {
      try {
        const terminalData = ctx.serializeAddonRef.current.serialize();
        ctx.onTerminalDataCapture(ctx.sessionId, terminalData);
      } catch (err) {
        logger.warn("Failed to serialize terminal data:", err);
      }
    }

    // Clean up the connection token for this sessionId so stale timers
    // that haven't fired yet will fail the isConnectionTokenCurrent check
    // (previously they would see the old token still in the map and pass).
    connectionTokensBySessionId.delete(ctx.sessionId);

    ctx.onSessionExit?.(ctx.sessionId, evt);
  });
};

const runDistroDetection = async (
  ctx: TerminalSessionStartersContext,
  sessionId: string,
  connectionToken: object,
) => {
  // Stale-session guard: the renderer reuses ctx.sessionId across
  // reconnects in the same tab, so comparing sessionIds is not enough.
  // We compare against a per-connection token instead; if a newer
  // connect attempt has run, it will have replaced the token in the
  // module-level map and this check will fail. Repeated after every
  // await because the session can change during an async call.
  const isStillCurrent = () => isConnectionTokenCurrent(sessionId, connectionToken);

  if (!isStillCurrent()) return;

  // Step 1: try to classify from the SSH server identification string
  // captured at handshake time. This is free (no extra channel) and
  // reliably identifies most network-device vendors (Cisco IOS, Huawei
  // VRP, HPE Comware, MikroTik, Fortinet, etc.) so we can skip the
  // POSIX-shell probe entirely for those hosts — which otherwise fails
  // and, on devices like Cisco / Juniper with AAA logging, generates an
  // extra session log entry per connect.
  try {
    if (ctx.terminalBackend.getSessionRemoteInfo && sessionId) {
      const info = await ctx.terminalBackend.getSessionRemoteInfo(sessionId);
      if (!isStillCurrent()) return;
      const vendor = detectVendorFromSshVersion(info?.remoteSshVersion);
      if (vendor) {
        ctx.onOsDetected?.(ctx.host.id, vendor);
        return;
      }
    }
  } catch (err) {
    logger.warn("SSH banner vendor detection failed", err);
  }

  if (!isStillCurrent()) return;

  // Step 2: unknown or generic OpenSSH/Dropbear — fall back to the
  // /etc/os-release probe to pick a distro-specific icon. We deliberately
  // use `getSessionDistroInfo` which runs the probe on the *existing*
  // SSH connection's exec channel instead of spinning up a brand new
  // SSH client the way `execCommand` would. That saves a full handshake
  // round-trip on every connect, and on OpenSSH-fronted network devices
  // that we couldn't identify from the banner (JUNOS, NX-OS, EOS) it
  // avoids one extra AAA session log entry per connect.
  try {
    if (ctx.terminalBackend.getSessionDistroInfo && sessionId) {
      const res = await ctx.terminalBackend.getSessionDistroInfo(sessionId);
      if (!isStillCurrent()) return;
      if (!res?.success) return;
      const data = `${res.stdout || ""}\n${res.stderr || ""}`;
      const idMatch = data.match(/^ID="?([\w-]+)"?$/im);
      const distro = idMatch
        ? idMatch[1]
        : (data.split(/\s+/)[0] || "").toLowerCase();
      if (distro) ctx.onOsDetected?.(ctx.host.id, distro);
    }
  } catch (err) {
    logger.warn("OS probe failed", err);
  }
};

export const createTerminalSessionStarters = (ctx: TerminalSessionStartersContext) => {
  const tr = (key: string, fallback: string): string => {
    const translated = ctx.t?.(key);
    if (!translated || translated === key) return fallback;
    return translated;
  };

  const startSSH = async (term: XTerm) => {
    if (!ctx.terminalBackend.backendAvailable()) {
      ctx.setError("Native SSH bridge unavailable. Launch via Electron app.");
      term.writeln(
        "\r\n[netcatty SSH bridge unavailable. Please run the desktop build to connect.]",
      );
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
      const msg = err.message.toLowerCase();
      return (
        msg.includes("authentication") ||
        msg.includes("auth") ||
        msg.includes("password") ||
        msg.includes("permission denied")
      );
    };

    const rawProxyPassword = ctx.host.proxyConfig?.password;
    const hasEncryptedProxyPassword = isEncryptedCredentialPlaceholder(rawProxyPassword);
    const proxyConfig = ctx.host.proxyConfig
      ? {
        type: ctx.host.proxyConfig.type,
        host: ctx.host.proxyConfig.host,
        port: ctx.host.proxyConfig.port,
        username: ctx.host.proxyConfig.username,
        password: sanitizeCredentialValue(rawProxyPassword),
      }
      : undefined;

    const jumpHostsWithUnavailableCredentials: string[] = [];
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
      const hasConfiguredJumpProxyEndpoint =
        index === 0 &&
        !!(jumpHost.proxyConfig?.host && jumpHost.proxyConfig?.port);
      const hasEncryptedJumpProxyCredential =
        hasConfiguredJumpProxyEndpoint &&
        Boolean(jumpHost.proxyConfig?.username) &&
        isEncryptedCredentialPlaceholder(jumpHost.proxyConfig?.password);

      const hasEncryptedJumpCredential =
        isEncryptedCredentialPlaceholder(rawJumpPassword) ||
        isEncryptedCredentialPlaceholder(rawJumpPrivateKey) ||
        isEncryptedCredentialPlaceholder(rawJumpPassphrase);

      if (hasEncryptedJumpProxyCredential || (hasEncryptedJumpCredential && !jumpPassword && !jumpPrivateKey)) {
        jumpHostsWithUnavailableCredentials.push(jumpHost.label || jumpHost.hostname);
      }

      return {
        hostname: jumpHost.hostname,
        port: jumpHost.port || 22,
        username: jumpAuth.username || "root",
        password: jumpPassword,
        privateKey: jumpPrivateKey,
        certificate: jumpKey?.certificate,
        passphrase: jumpPassphrase,
        publicKey: jumpKey?.publicKey,
        keyId: jumpAuth.keyId,
        keySource: jumpKey?.source,
        label: jumpHost.label,
        proxy: jumpHost.proxyConfig?.host && jumpHost.proxyConfig?.port
          ? {
            type: jumpHost.proxyConfig.type,
            host: jumpHost.proxyConfig.host,
            port: jumpHost.proxyConfig.port,
            username: jumpHost.proxyConfig.username,
            password: sanitizeCredentialValue(jumpHost.proxyConfig.password),
          }
          : undefined,
        identityFilePaths: jumpHost.identityFilePaths,
      };
    });

    const usesTargetProxyForFirstHop = !!proxyConfig && !jumpHosts[0]?.proxy;
    if (usesTargetProxyForFirstHop && hasEncryptedProxyPassword && !proxyConfig?.password && proxyConfig?.username) {
      const message = tr(
        "terminal.auth.proxyCredentialsUnavailable",
        "Proxy credentials cannot be decrypted on this device. Open host settings and re-enter the proxy password.",
      );
      ctx.setNeedsAuth(false);
      ctx.setAuthRetryMessage(null);
      ctx.setError(message);
      term.writeln(`\r\n[${message}]`);
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
      term.writeln(`\r\n[${message}]`);
      ctx.updateStatus("disconnected");
      return;
    }

    const totalHops = jumpHosts.length + 1;
    let unsubscribeChainProgress: (() => void) | undefined;

    if (jumpHosts.length > 0) {
      ctx.setChainProgress({
        currentHop: 1,
        totalHops,
        currentHostLabel:
          jumpHosts[0]?.label || jumpHosts[0]?.hostname || ctx.host.hostname,
      });
    }

    {
      const unsub = ctx.terminalBackend.onChainProgress((sid, hop, total, label, status, error) => {
        // P1: Only process events for this session
        if (sid !== ctx.sessionId) return;

        // P3: Only show chain progress UI for multi-hop connections
        if (total > 1) {
          ctx.setChainProgress({
            currentHop: hop,
            totalHops: total,
            currentHostLabel: label,
          });
        }

        // Build human-readable log line
        let logLine: string;
        const prefix = total > 1 ? `[${hop}/${total}] ` : '';

        switch (status) {
          case 'connecting':
            logLine = `${prefix}${tr("terminal.progress.connecting", "Connecting to")} ${label}...`;
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

        ctx.setProgressLogs((prev) => [...prev, logLine]);
        const hopProgress = (hop / total) * 80 + 10;
        ctx.setProgressValue(Math.min(95, hopProgress));
      });
      if (unsub) unsubscribeChainProgress = unsub;
    }

    try {
      const termEnv = buildTermEnv(ctx.host, ctx.terminalSettings);

      const startAttempt = async (attempt: {
        password?: string;
        key?: SSHKey;
      }): Promise<string> => {
        return ctx.terminalBackend.startSSHSession({
          sessionId: ctx.sessionId,
          hostLabel: ctx.host.label,
          hostname: ctx.host.hostname,
          username: effectiveUsername,
          port: ctx.host.port || 22,
          password: attempt.password,
          privateKey: attempt.key?.privateKey,
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
          cols: term.cols,
          rows: term.rows,
          charset: ctx.host.charset,
          env: termEnv,
          proxy: proxyConfig,
          jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
          keepaliveInterval: ctx.terminalSettings?.keepaliveInterval,
          sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
          // Only pass local key paths if no vault key is explicitly configured
          identityFilePaths: attempt.key ? undefined : ctx.host.identityFilePaths,
        });
      };

      let id: string;
      // Respect explicit auth method selection - don't use key if password auth was explicitly selected
      const authMethod = resolvedAuth.authMethod;
      const hasKeyMaterial = !!sanitizeCredentialValue(key?.privateKey) && authMethod !== 'password';
      const hasPassword = !!effectivePassword;

      const needsCredentialReentry =
        (authMethod === "password" && hasEncryptedPrimaryPassword && !hasPassword) ||
        (authMethod !== "password" && hasEncryptedPrimaryKey && !hasKeyMaterial && !hasPassword);

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
          id = await startAttempt({ key });
        } catch (err) {
          if (isAuthError(err) && hasPassword) {
            ctx.setProgressLogs((prev) => [
              ...prev,
              "Key auth failed. Trying password...",
            ]);
            id = await startAttempt({ password: effectivePassword });
          } else {
            throw err;
          }
        }
      } else {
        id = await startAttempt({ password: effectivePassword });
      }

      if (unsubscribeChainProgress) unsubscribeChainProgress();

      attachSessionToTerminal(ctx, term, id, {
        onConnected: () => ctx.setChainProgress(null),
        onExitMessage: (evt) =>
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
      });

      const commandToRun = ctx.startupCommand || ctx.host.startupCommand;
      if (commandToRun && !ctx.hasRunStartupCommandRef.current) {
        ctx.hasRunStartupCommandRef.current = true;
        const scheduledSessionId = id;
        setTimeout(() => {
          // Guard against stale timers: if the session changed (e.g. user
          // clicked Start Over quickly), skip to avoid double execution
          if (!ctx.sessionRef.current || ctx.sessionRef.current !== scheduledSessionId) return;
          const suffix = ctx.noAutoRun ? '' : '\r';
          ctx.terminalBackend.writeToSession(ctx.sessionRef.current, `${commandToRun}${suffix}`);
          if (!ctx.noAutoRun && ctx.onCommandExecuted) {
            ctx.onCommandExecuted(commandToRun, ctx.host.id, ctx.host.label, ctx.sessionId);
          }
        }, 600);
      }

      // Run OS detection only after successful connection. Mint a fresh
      // token for this specific connection attempt and register it as
      // the current one for this sessionId slot; any previous timer
      // scheduled against an earlier token will see the replacement
      // and bail out. The detection function re-checks the token after
      // every async await so a reconnect mid-probe is also caught.
      {
        const connectionToken = {};
        connectionTokensBySessionId.set(id, connectionToken);
        setTimeout(() => {
          if (!isConnectionTokenCurrent(id, connectionToken)) return;
          void runDistroDetection(ctx, id, connectionToken);
        }, 600);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const authError = isAuthError(err);

      if (authError) {
        ctx.setError(null);
        ctx.setNeedsAuth(true);
        ctx.setAuthRetryMessage(
          "Authentication failed. Please check your credentials and try again.",
        );
        ctx.setAuthPassword("");
        ctx.setProgressLogs((prev) => [
          ...prev,
          "Authentication failed. Please try again.",
        ]);
        ctx.setStatus("connecting");
      } else {
        ctx.setError(message);
        term.writeln(`\r\n[Failed to start SSH: ${message}]`);
        ctx.updateStatus("disconnected");
      }

      ctx.setChainProgress(null);
      if (unsubscribeChainProgress) unsubscribeChainProgress();
    }
  };

  const startTelnet = async (term: XTerm) => {
    if (!ctx.terminalBackend.telnetAvailable()) {
      ctx.setError("Telnet bridge unavailable. Please run the desktop build.");
      term.writeln("\r\n[Telnet bridge unavailable. Please run the desktop build.]");
      ctx.updateStatus("disconnected");
      return;
    }

    try {
      const telnetEnv = buildTermEnv(ctx.host, ctx.terminalSettings);
      const id = await ctx.terminalBackend.startTelnetSession({
        sessionId: ctx.sessionId,
        hostname: ctx.host.hostname,
        port: ctx.host.telnetPort || ctx.host.port || 23,
        cols: term.cols,
        rows: term.rows,
        charset: ctx.host.charset,
        env: telnetEnv,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
      });

      attachSessionToTerminal(ctx, term, id, {
        onExitMessage: (evt) =>
          `\r\n[Telnet session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      term.writeln(`\r\n[Failed to start Telnet: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  const startMosh = async (term: XTerm) => {
    if (!ctx.terminalBackend.moshAvailable()) {
      ctx.setError("Mosh bridge unavailable. Please run the desktop build.");
      term.writeln("\r\n[Mosh bridge unavailable. Please run the desktop build.]");
      ctx.updateStatus("disconnected");
      return;
    }

    try {
      const moshEnv = buildTermEnv(ctx.host, ctx.terminalSettings);
      const id = await ctx.terminalBackend.startMoshSession({
        sessionId: ctx.sessionId,
        hostname: ctx.host.hostname,
        username: ctx.host.username || "root",
        port: ctx.host.port || 22,
        moshServerPath: ctx.host.moshServerPath,
        agentForwarding: ctx.host.agentForwarding,
        cols: term.cols,
        rows: term.rows,
        charset: ctx.host.charset,
        env: moshEnv,
        sessionLog: ctx.sessionLog?.enabled ? ctx.sessionLog : undefined,
      });

      attachSessionToTerminal(ctx, term, id, {
        onExitMessage: (evt) =>
          `\r\n[Mosh session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
      });

      const commandToRun = ctx.startupCommand || ctx.host.startupCommand;
      if (commandToRun && !ctx.hasRunStartupCommandRef.current) {
        ctx.hasRunStartupCommandRef.current = true;
        const scheduledSessionId = id;
        setTimeout(() => {
          if (!ctx.sessionRef.current || ctx.sessionRef.current !== scheduledSessionId) return;
          const suffix = ctx.noAutoRun ? '' : '\r';
          ctx.terminalBackend.writeToSession(ctx.sessionRef.current, `${commandToRun}${suffix}`);
          if (!ctx.noAutoRun && ctx.onCommandExecuted) {
            ctx.onCommandExecuted(commandToRun, ctx.host.id, ctx.host.label, ctx.sessionId);
          }
        }, 600);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      term.writeln(`\r\n[Failed to start Mosh: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  const startLocal = async (term: XTerm) => {
    if (!ctx.terminalBackend.localAvailable()) {
      ctx.setError("Local shell bridge unavailable. Please run the desktop build.");
      term.writeln(
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
      const localStartDir = ctx.terminalSettings?.localStartDir;

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
      });

      ctx.sessionRef.current = id;
      ctx.disposeDataRef.current = ctx.terminalBackend.onSessionData(id, (chunk) => {
        writeSessionData(ctx, term, chunk);
        if (!ctx.hasConnectedRef.current) {
          ctx.updateStatus("connected");
          setTimeout(() => {
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
      });

      ctx.disposeExitRef.current = ctx.terminalBackend.onSessionExit(id, (evt) => {
        ctx.updateStatus("disconnected");
        term.writeln(
          `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        );

        logger.info("[Terminal] Session exit, capturing data", {
          sessionId: ctx.sessionId,
          hasCallback: !!ctx.onTerminalDataCapture,
          hasSerializeAddon: !!ctx.serializeAddonRef.current,
        });

        if (ctx.onTerminalDataCapture && ctx.serializeAddonRef.current) {
          try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      term.writeln(`\r\n[Failed to start local shell: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  // Start Serial session
  const startSerial = async (term: XTerm) => {
    if (!ctx.serialConfig) {
      ctx.setError("No serial configuration provided");
      term.writeln("\r\n[Error: No serial configuration provided]");
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
      });

      // Serial connection is established immediately when session starts
      // Update status right away since serial ports don't require handshake
      ctx.updateStatus("connected");
      ctx.setProgressValue(100);
      term.writeln(`[Connected to ${ctx.serialConfig.path} at ${ctx.serialConfig.baudRate} baud]`);

      attachSessionToTerminal(ctx, term, id, {
        onExitMessage: (evt) =>
          `\r\n[serial port closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`,
        // Convert lone LF to CRLF to prevent "staircase effect" in serial terminals
        convertLfToCrlf: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.setError(message);
      term.writeln(`\r\n[Failed to connect to serial port: ${message}]`);
      ctx.updateStatus("disconnected");
    }
  };

  return { startSSH, startTelnet, startMosh, startLocal, startSerial };
};
