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

/** Timeout of distro detection task */
const DISTRO_DETECT_TIMEOUT = 8000; // ms

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
  onSessionData: (sessionId: string, cb: (data: string) => void) => () => void;
  onSessionExit: (
    sessionId: string,
    cb: (evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void,
  ) => () => void;
  onChainProgress: (
    cb: (hop: number, total: number, label: string, status: string) => void,
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
    onExitMessage?: (evt: { exitCode?: number; signal?: number }) => string;
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
    term.writeln(opts?.onExitMessage?.(evt) ?? "\r\n[session closed]");

    if (ctx.onTerminalDataCapture && ctx.serializeAddonRef.current) {
      try {
        const terminalData = ctx.serializeAddonRef.current.serialize();
        ctx.onTerminalDataCapture(ctx.sessionId, terminalData);
      } catch (err) {
        logger.warn("Failed to serialize terminal data:", err);
      }
    }

    ctx.onSessionExit?.(ctx.sessionId, evt);
  });
};

const runDistroDetection = async (
  ctx: TerminalSessionStartersContext,
  auth: { username: string; password?: string; key?: SSHKey; passphrase?: string },
) => {
  if (!ctx.terminalBackend.execAvailable()) return;
  try {
    const res = await ctx.terminalBackend.execCommand({
      hostname: ctx.host.hostname,
      username: auth.username || "root",
      port: ctx.host.port || 22,
      password: auth.password,
      privateKey: auth.key?.privateKey,
      passphrase: auth.passphrase ?? auth.key?.passphrase,
      command: "cat /etc/os-release 2>/dev/null || uname -a",
      timeout: DISTRO_DETECT_TIMEOUT,
    });
    const data = `${res.stdout || ""}\n${res.stderr || ""}`;
    const idMatch = data.match(/^ID="?([\w-]+)"?$/im);
    const distro = idMatch
      ? idMatch[1]
      : (data.split(/\s+/)[0] || "").toLowerCase();
    if (distro) ctx.onOsDetected?.(ctx.host.id, distro);
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
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

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
    let usedKey: SSHKey | undefined;
    let usedPassword: string | undefined;

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

      const hasEncryptedJumpCredential =
        isEncryptedCredentialPlaceholder(rawJumpPassword) ||
        isEncryptedCredentialPlaceholder(rawJumpPrivateKey) ||
        isEncryptedCredentialPlaceholder(rawJumpPassphrase);

      if (hasEncryptedJumpCredential && !jumpPassword && !jumpPrivateKey) {
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
      };
    });

    if (hasEncryptedProxyPassword && !proxyConfig?.password && proxyConfig?.username) {
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
      ctx.setProgressLogs((prev) => [
        ...prev,
        `Starting chain connection (${totalHops} hops)...`,
      ]);

      const unsub = ctx.terminalBackend.onChainProgress((hop, total, label, status) => {
        ctx.setChainProgress({
          currentHop: hop,
          totalHops: total,
          currentHostLabel: label,
        });
        ctx.setProgressLogs((prev) => [
          ...prev,
          `Chain ${hop} of ${total}: ${label} - ${status}`,
        ]);
        const hopProgress = (hop / total) * 80 + 10;
        ctx.setProgressValue(Math.min(95, hopProgress));
      });
      if (unsub) unsubscribeChainProgress = unsub;
    }

    try {
      const termEnv = buildTermEnv(ctx.host, ctx.terminalSettings);

      // DEBUG: Log key info for troubleshooting
      console.log("[Terminal] Starting SSH session with key info:", {
        keyId: key?.id,
        keyLabel: key?.label,
        keySource: key?.source,
        hasPublicKey: !!key?.publicKey,
        hasPrivateKey: !!key?.privateKey,
      });

      const startAttempt = async (attempt: {
        password?: string;
        key?: SSHKey;
      }): Promise<string> => {
        return ctx.terminalBackend.startSSHSession({
          sessionId: ctx.sessionId,
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
          legacyAlgorithms: ctx.host.legacyAlgorithms,
          cols: term.cols,
          rows: term.rows,
          charset: ctx.host.charset,
          env: termEnv,
          proxy: proxyConfig,
          jumpHosts: jumpHosts.length > 0 ? jumpHosts : undefined,
          keepaliveInterval: ctx.terminalSettings?.keepaliveInterval,
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
          usedKey = key;
        } catch (err) {
          if (isAuthError(err) && hasPassword) {
            ctx.setProgressLogs((prev) => [
              ...prev,
              "Key auth failed. Trying password...",
            ]);
            id = await startAttempt({ password: effectivePassword });
            usedPassword = effectivePassword;
          } else {
            throw err;
          }
        }
      } else {
        id = await startAttempt({ password: effectivePassword });
        usedPassword = effectivePassword;
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

    setTimeout(
      () =>
        void runDistroDetection(ctx, {
          username: effectiveUsername,
          password: usedPassword,
          key: usedKey,
          passphrase: effectivePassphrase,
        }),
      600,
    );
  };

  const startTelnet = async (term: XTerm) => {
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

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
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

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
    try {
      term.clear?.();
    } catch (err) {
      logger.warn("Failed to clear terminal before connect", err);
    }

    if (!ctx.terminalBackend.localAvailable()) {
      ctx.setError("Local shell bridge unavailable. Please run the desktop build.");
      term.writeln(
        "\r\n[Local shell bridge unavailable. Please run the desktop build to spawn a local terminal.]",
      );
      ctx.updateStatus("disconnected");
      return;
    }

    try {
      // Get local shell configuration from terminal settings
      const localShell = ctx.terminalSettings?.localShell;
      const localStartDir = ctx.terminalSettings?.localStartDir;

      const id = await ctx.terminalBackend.startLocalSession({
        sessionId: ctx.sessionId,
        cols: term.cols,
        rows: term.rows,
        shell: localShell,
        cwd: localStartDir,
        env: {
          TERM: ctx.terminalSettings?.terminalEmulationType ?? "xterm-256color",
        },
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
