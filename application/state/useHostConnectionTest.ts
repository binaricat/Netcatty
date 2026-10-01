import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupConfig, Host, Identity, KnownHost, ProxyProfile, SSHKey, TerminalSettings } from "../../domain/models";
import type { HostKeyInfo } from "../../domain/hostKey";
import { toHostKeyInfo } from "../../domain/hostKey";
import { createKnownHostFromHostKeyInfo } from "../../domain/knownHosts";
import { resolveHostSshConnectionTimeouts } from "../../domain/sshConnectionTimeouts";
import {
  buildHostConnectionTestPlan,
  formatConnectionTestProgressLog,
  type HostConnectionTestAuthOverride,
} from "../../domain/hostConnectionTest";
import { useTerminalBackend } from "./useTerminalBackend";

export type ChainProgress = {
  currentHop: number;
  totalHops: number;
  currentHostLabel: string;
  connectionPhase: string;
} | null;

export type HostKeyVerificationState = {
  requestId: string;
  hostKeyInfo: HostKeyInfo;
};

export type HostConnectionTestStatus = "idle" | "connecting" | "connected" | "disconnected";

export type HostConnectionTestState = {
  status: HostConnectionTestStatus;
  error: string | null;
  needsAuth: boolean;
  progressValue: number;
  chainProgress: ChainProgress;
  progressLogs: string[];
  hostKeyVerification: HostKeyVerificationState | null;
  timeLeft: number;
  isAwaitingUserInput: boolean;
  isCancelling: boolean;
};

export type HostConnectionTestInput = {
  host: Host;
  hosts: Host[];
  keys: SSHKey[];
  identities?: Identity[];
  knownHosts?: KnownHost[];
  groupConfigs?: GroupConfig[];
  proxyProfiles?: ProxyProfile[];
  terminalSettings?: TerminalSettings;
  onAddKnownHost?: (knownHost: KnownHost) => void;
};

const CONNECTION_TIMEOUT_MS = 120000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useHostConnectionTest(input: HostConnectionTestInput) {
  const {
    host,
    hosts,
    keys,
    identities = [],
    knownHosts,
    groupConfigs = [],
    proxyProfiles = [],
    terminalSettings,
    onAddKnownHost,
  } = input;
  const backend = useTerminalBackend();

  const [status, setStatus] = useState<HostConnectionTestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [chainProgress, setChainProgress] = useState<ChainProgress>(null);
  const [progressLogs, setProgressLogs] = useState<string[]>([]);
  const [hostKeyVerification, setHostKeyVerification] = useState<HostKeyVerificationState | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [isAwaitingUserInput, setIsAwaitingUserInput] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const bootEpochRef = useRef(0);
  const pendingHostKeyRequestIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);

  const resetState = useCallback(() => {
    setError(null);
    setNeedsAuth(false);
    setProgressValue(0);
    setChainProgress(null);
    setProgressLogs([]);
    setHostKeyVerification(null);
    setIsAwaitingUserInput(false);
    setIsCancelling(false);
    setTimeLeft(0);
    pendingHostKeyRequestIdRef.current = null;
  }, []);

  const clearSession = useCallback(() => {
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sessionId && !disposedRef.current) {
      void backend.cancelTestConnection(sessionId).catch(() => {});
    }
  }, [backend]);

  // Unmount cleanup. The per-attempt subscriptions below dispose themselves via
  // their own effect returns; nothing here touches them.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  // Subscribe to chain progress for the active attempt.
  useEffect(() => {
    const unsub = backend.onChainProgress?.((sessionId, hop, total, label, phase, phaseError) => {
      if (sessionId !== sessionIdRef.current) return;
      if (total > 1) {
        setChainProgress({
          currentHop: hop,
          totalHops: total,
          currentHostLabel: label,
          connectionPhase: phase,
        });
      }
      setProgressLogs((prev) => [
        ...prev,
        formatConnectionTestProgressLog({ hop, total, label, phase, error: phaseError }),
      ]);
      const hopProgress = (hop / total) * 80 + 10;
      setProgressValue((prev) => Math.max(prev, Math.min(95, hopProgress)));
      setIsAwaitingUserInput(phase === "auth-attempt" && phaseError === "waiting for user input...");
    });
    return () => unsub?.();
  }, [backend]);

  // Subscribe to host-key verification for the active attempt.
  useEffect(() => {
    const unsub = backend.onHostKeyVerification?.((request) => {
      if (request.sessionId !== sessionIdRef.current) return;
      pendingHostKeyRequestIdRef.current = request.requestId;
      setHostKeyVerification({
        requestId: request.requestId,
        hostKeyInfo: toHostKeyInfo(request),
      });
    });
    return () => unsub?.();
  }, [backend]);

  const respondHostKey = useCallback(
    (requestId: string, accept: boolean, addToKnownHosts: boolean, hostKeyInfo: HostKeyInfo) => {
      if (accept && addToKnownHosts && onAddKnownHost) {
        onAddKnownHost(createKnownHostFromHostKeyInfo(hostKeyInfo));
      }
      void backend.respondHostKeyVerification(requestId, accept, addToKnownHosts);
      pendingHostKeyRequestIdRef.current = null;
      setHostKeyVerification(null);
    },
    [backend, onAddKnownHost],
  );

  const handleHostKeyContinue = useCallback(() => {
    if (!hostKeyVerification) return;
    respondHostKey(hostKeyVerification.requestId, true, false, hostKeyVerification.hostKeyInfo);
  }, [hostKeyVerification, respondHostKey]);

  const handleHostKeyAddAndContinue = useCallback(() => {
    if (!hostKeyVerification) return;
    respondHostKey(hostKeyVerification.requestId, true, true, hostKeyVerification.hostKeyInfo);
  }, [hostKeyVerification, respondHostKey]);

  const handleHostKeyClose = useCallback(() => {
    if (!hostKeyVerification) return;
    respondHostKey(hostKeyVerification.requestId, false, false, hostKeyVerification.hostKeyInfo);
  }, [hostKeyVerification, respondHostKey]);

  const startTest = useCallback(
    async (authOverride?: HostConnectionTestAuthOverride | null) => {
      clearSession();
      resetState();

      const sessionId = crypto.randomUUID();
      const bootEpoch = (bootEpochRef.current += 1);
      sessionIdRef.current = sessionId;

      const plan = buildHostConnectionTestPlan({
        host,
        hosts,
        keys,
        identities,
        knownHosts,
        groupConfigs,
        proxyProfiles,
        terminalSettings: terminalSettings
          ? {
              keepaliveInterval: terminalSettings.keepaliveInterval,
              keepaliveCountMax: terminalSettings.keepaliveCountMax,
              verifyHostKeys: terminalSettings.verifyHostKeys,
            }
          : undefined,
        sessionId,
        bootEpoch,
        authOverride,
      });

      if (!plan.ok) {
        setError(plan.error);
        setStatus("disconnected");
        return;
      }

      if (plan.needsCredentialReentry) {
        setNeedsAuth(true);
        setStatus("connecting");
        return;
      }

      setStatus("connecting");
      setIsAwaitingUserInput(false);

      try {
        await backend.testConnection(plan.options);
        if (disposedRef.current || sessionIdRef.current !== sessionId) return;
        setProgressValue(100);
        setChainProgress(null);
        setStatus("connected");
      } catch (err) {
        if (disposedRef.current || sessionIdRef.current !== sessionId) return;
        setError(messageOf(err));
        setStatus("disconnected");
      }
    },
    [
      backend,
      clearSession,
      groupConfigs,
      host,
      hosts,
      identities,
      keys,
      knownHosts,
      proxyProfiles,
      resetState,
      terminalSettings,
    ],
  );

  const submitAuth = useCallback(
    (auth: HostConnectionTestAuthOverride) => {
      void startTest(auth);
    },
    [startTest],
  );

  const cancelTest = useCallback(() => {
    setIsCancelling(true);
    // Reject any pending host-key prompt so the dial fails fast, then clear
    // this attempt's session. An in-flight TCP/auth dial without a prompt
    // settles on its own (it is not registered as a terminal session).
    if (pendingHostKeyRequestIdRef.current) {
      void backend.respondHostKeyVerification(pendingHostKeyRequestIdRef.current, false, false);
      pendingHostKeyRequestIdRef.current = null;
      setHostKeyVerification(null);
    }
    clearSession();
    setStatus("idle");
    setNeedsAuth(false);
    setError(null);
  }, [backend, clearSession]);

  // Connection timeout countdown + gentle progress while connecting.
  useEffect(() => {
    if (status !== "connecting" || needsAuth || hostKeyVerification || isAwaitingUserInput) {
      return;
    }
    const timeouts = resolveHostSshConnectionTimeouts(host);
    const authReadyTimeoutMs = timeouts.authReadyTimeoutSeconds * 1000 || CONNECTION_TIMEOUT_MS;
    setTimeLeft(authReadyTimeoutMs / 1000);
    const countdown = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    const timeout = setTimeout(() => {
      setError("Connection timed out. Please try again.");
      setStatus("disconnected");
    }, authReadyTimeoutMs);
    const prog = setInterval(() => {
      setProgressValue((prev) => {
        if (prev >= 95) return prev;
        const remaining = 95 - prev;
        return Math.min(95, prev + Math.max(1, remaining * 0.15));
      });
    }, 200);
    return () => {
      clearInterval(countdown);
      clearTimeout(timeout);
      clearInterval(prog);
    };
  }, [status, needsAuth, hostKeyVerification, isAwaitingUserInput, host]);

  return {
    state: {
      status,
      error,
      needsAuth,
      progressValue,
      chainProgress,
      progressLogs,
      hostKeyVerification,
      timeLeft,
      isAwaitingUserInput,
      isCancelling,
    } satisfies HostConnectionTestState,
    startTest,
    submitAuth,
    cancelTest,
    retry: () => void startTest(),
    handleHostKeyContinue,
    handleHostKeyAddAndContinue,
    handleHostKeyClose,
  };
}
