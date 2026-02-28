import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Host, RemoteFile } from "../../../types";
import { logger } from "../../../lib/logger";
import { toast } from "../../ui/toast";

interface UseSftpModalSessionParams {
  open: boolean;
  host: Host;
  credentials: {
    username?: string;
    hostname: string;
    port?: number;
    password?: string;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: "generated" | "imported";
    proxy?: NetcattyProxyConfig;
    jumpHosts?: NetcattyJumpHost[];
    sftpSudo?: boolean;
    legacyAlgorithms?: boolean;
  };
  initialPath?: string;
  isLocalSession: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
  openSftp: (params: {
    sessionId: string;
    hostname: string;
    username: string;
    port: number;
    password?: string;
    privateKey?: string;
    certificate?: string;
    passphrase?: string;
    publicKey?: string;
    keyId?: string;
    keySource?: "generated" | "imported";
    proxy?: NetcattyProxyConfig;
    jumpHosts?: NetcattyJumpHost[];
    sudo?: boolean;
    legacyAlgorithms?: boolean;
  }) => Promise<string>;
  closeSftp: (sftpId: string) => Promise<void>;
  listSftp: (sftpId: string, path: string) => Promise<RemoteFile[]>;
  listLocalDir: (path: string) => Promise<RemoteFile[]>;
  getHomeDir: () => Promise<string | null>;
  onClearSelection: () => void;
}

interface UseSftpModalSessionResult {
  currentPath: string;
  setCurrentPath: (path: string) => void;
  files: RemoteFile[];
  setFiles: (files: RemoteFile[]) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  reconnecting: boolean;
  ensureSftp: () => Promise<string>;
  loadFiles: (path: string, options?: { force?: boolean }) => Promise<void>;
  closeSftpSession: () => Promise<void>;
  localHomeRef: React.MutableRefObject<string | null>;
}

export const useSftpModalSession = ({
  open,
  host,
  credentials,
  initialPath,
  isLocalSession,
  t,
  openSftp,
  closeSftp,
  listSftp,
  listLocalDir,
  getHomeDir,
  onClearSelection,
}: UseSftpModalSessionParams): UseSftpModalSessionResult => {
  const [currentPath, setCurrentPath] = useState("/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const sftpIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const lastInitialPathRef = useRef<string | undefined>(undefined);
  const localHomeRef = useRef<string | null>(null);

  const reconnectingRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 3;

  const DIR_CACHE_TTL_MS = 10_000;
  const dirCacheRef = useRef<
    Map<string, { files: RemoteFile[]; timestamp: number }>
  >(new Map());
  const loadSeqRef = useRef(0);

  const ensureSftp = useCallback(async () => {
    if (isLocalSession) throw new Error("Local session does not use SFTP");
    if (sftpIdRef.current) return sftpIdRef.current;
    const sftpId = await openSftp({
      sessionId: `sftp-modal-${host.id}`,
      hostname: credentials.hostname,
      username: credentials.username || "root",
      port: credentials.port || 22,
      password: credentials.password,
      privateKey: credentials.privateKey,
      certificate: credentials.certificate,
      passphrase: credentials.passphrase,
      publicKey: credentials.publicKey,
      keyId: credentials.keyId,
      keySource: credentials.keySource,
      proxy: credentials.proxy,
      jumpHosts: credentials.jumpHosts,
      sudo: credentials.sftpSudo,
      legacyAlgorithms: credentials.legacyAlgorithms,
    });
    sftpIdRef.current = sftpId;
    return sftpId;
  }, [
    isLocalSession,
    host.id,
    credentials.hostname,
    credentials.username,
    credentials.port,
    credentials.password,
    credentials.privateKey,
    credentials.certificate,
    credentials.passphrase,
    credentials.publicKey,
    credentials.keyId,
    credentials.keySource,
    credentials.proxy,
    credentials.jumpHosts,
    credentials.sftpSudo,
    credentials.legacyAlgorithms,
    openSftp,
  ]);

  const closeSftpSession = useCallback(async () => {
    if (!isLocalSession && sftpIdRef.current) {
      try {
        await closeSftp(sftpIdRef.current);
      } catch {
        // Silently ignore close errors - connection may already be closed
      }
    }
    sftpIdRef.current = null;
  }, [closeSftp, isLocalSession]);

  const isSessionError = useCallback((err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("session not found") ||
      msg.includes("sftp session") ||
      msg.includes("not found") ||
      msg.includes("closed") ||
      msg.includes("connection reset") ||
      msg.includes("write after end") ||
      msg.includes("no response") ||
      msg.includes("client disconnected")
    );
  }, []);

  const handleSessionError = useCallback(async () => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    setReconnecting(true);
    reconnectAttemptsRef.current = 0;

    while (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
      try {
        reconnectAttemptsRef.current += 1;
        if (sftpIdRef.current) {
          try {
            await closeSftp(sftpIdRef.current);
          } catch {
            // ignore
          }
          sftpIdRef.current = null;
        }
        await ensureSftp();
        reconnectingRef.current = false;
        setReconnecting(false);
        return;
      } catch (err) {
        logger.warn(
          `[SFTP] Reconnect attempt ${reconnectAttemptsRef.current} failed`,
          err,
        );
        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          reconnectingRef.current = false;
          setReconnecting(false);
          toast.error(t("sftp.error.reconnectFailed"), "SFTP");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }, [closeSftp, ensureSftp, t]);

  const loadFiles = useCallback(
    async (path: string, options?: { force?: boolean }) => {
      const requestId = ++loadSeqRef.current;
      setLoading(true);
      onClearSelection();

      try {
        if (isLocalSession) {
          const list = await listLocalDir(path);
          if (requestId === loadSeqRef.current) {
            setFiles(list);
          }
          return;
        }

        const cacheKey = `${host.id}::${path}`;
        const cached = dirCacheRef.current.get(cacheKey);
        const isFresh =
          cached && Date.now() - cached.timestamp < DIR_CACHE_TTL_MS;
        if (cached && isFresh && !options?.force) {
          setFiles(cached.files);
          return;
        }

        const sftpId = await ensureSftp();
        const list = await listSftp(sftpId, path);
        if (requestId !== loadSeqRef.current) return;
        setFiles(list);
        dirCacheRef.current.set(cacheKey, {
          files: list,
          timestamp: Date.now(),
        });
      } catch (e) {
        if (!isLocalSession && isSessionError(e) && files.length > 0) {
          logger.info("[SFTP] Session lost, attempting to reconnect...");
          handleSessionError();
          return;
        }

        logger.error("Failed to load files", e);
        toast.error(
          e instanceof Error ? e.message : t("sftp.error.loadFailed"),
          "SFTP",
        );
        setFiles([]);
      } finally {
        if (loadSeqRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [ensureSftp, host.id, isLocalSession, listLocalDir, listSftp, t, isSessionError, handleSessionError, files.length, onClearSelection],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const cacheKey = `${host.id}::${currentPath}`;
    const cached = dirCacheRef.current.get(cacheKey);
    const isFresh = cached && Date.now() - cached.timestamp < DIR_CACHE_TTL_MS;
    if (!isFresh) {
      setFiles([]);
      onClearSelection();
    }
  }, [currentPath, host.id, onClearSelection, open]);

  useEffect(() => {
    if (open) {
      if (!initializedRef.current || lastInitialPathRef.current !== initialPath) {
        initializedRef.current = true;
        lastInitialPathRef.current = initialPath;
        onClearSelection();
        setLoading(true);

        if (isLocalSession) {
          (async () => {
            const homePath = await getHomeDir();
            localHomeRef.current = homePath ?? null;
            const startPath = initialPath || homePath || "/";
            try {
              const list = await listLocalDir(startPath);
              setCurrentPath(startPath);
              setFiles(list);
              dirCacheRef.current.set(`${host.id}::${startPath}`, {
                files: list,
                timestamp: Date.now(),
              });
            } catch (e) {
              toast.error(
                e instanceof Error ? e.message : t("sftp.error.loadFailed"),
                "SFTP",
              );
            } finally {
              setLoading(false);
            }
          })();
          return;
        }

        (async () => {
          const homePath = await getHomeDir();
          localHomeRef.current = homePath ?? null;
          if (initialPath) {
            try {
              const sftpId = await ensureSftp();
              const list = await listSftp(sftpId, initialPath);
              setCurrentPath(initialPath);
              setFiles(list);
              dirCacheRef.current.set(`${host.id}::${initialPath}`, {
                files: list,
                timestamp: Date.now(),
              });
              setLoading(false);
              return;
            } catch {
              logger.warn(
                `[SFTP] Initial path ${initialPath} not accessible, falling back to home`,
              );
            }
          }

          try {
            const sftpId = await ensureSftp();
            const list = await listSftp(sftpId, homePath || "/");
            setCurrentPath(homePath || "/");
            setFiles(list);
            dirCacheRef.current.set(`${host.id}::${homePath || "/"}`, {
              files: list,
              timestamp: Date.now(),
            });
            setLoading(false);
          } catch {
            logger.warn(`[SFTP] Home ${homePath} not accessible, using /`);
            try {
              const sftpId = await ensureSftp();
              const list = await listSftp(sftpId, "/");
              setCurrentPath("/");
              setFiles(list);
              dirCacheRef.current.set(`${host.id}::/`, {
                files: list,
                timestamp: Date.now(),
              });
            } catch (e) {
              logger.error("[SFTP] Failed to load root directory", e);
              toast.error(t("sftp.error.loadFailed"), "SFTP");
            } finally {
              setLoading(false);
            }
          }
        })();
        return;
      }
      void loadFiles(currentPath);
    } else {
      loadSeqRef.current += 1;
      void closeSftpSession();
      initializedRef.current = false;
    }
  }, [
    closeSftpSession,
    currentPath,
    ensureSftp,
    getHomeDir,
    host.id,
    initialPath,
    isLocalSession,
    listLocalDir,
    listSftp,
    loadFiles,
    onClearSelection,
    open,
    t,
  ]);

  useEffect(() => {
    return () => {
      void closeSftpSession();
    };
  }, [closeSftpSession]);

  return {
    currentPath,
    setCurrentPath,
    files,
    setFiles,
    loading,
    setLoading,
    reconnecting,
    ensureSftp,
    loadFiles,
    closeSftpSession,
    localHomeRef,
  };
};
