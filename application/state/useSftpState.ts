import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileConflict,
  Host,
  SftpConnection,
  SftpFileEntry,
  SSHKey,
  TransferDirection,
  TransferStatus,
  TransferTask,
} from "../../domain/models";

// Helper functions
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "--";
  const units = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
};

const formatDate = (timestamp: number): string => {
  if (!timestamp) return "--";
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const getFileExtension = (name: string): string => {
  if (name === "..") return "folder";
  const ext = name.split(".").pop()?.toLowerCase();
  return ext || "file";
};

// Check if path is Windows-style
const isWindowsPath = (path: string): boolean => /^[A-Za-z]:/.test(path);

const joinPath = (base: string, name: string): string => {
  if (isWindowsPath(base)) {
    // Windows path
    const normalizedBase = base.replace(/[\\/]+$/, ""); // Remove trailing slashes
    return `${normalizedBase}\\${name}`;
  }
  // Unix path
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
};

const getParentPath = (path: string): string => {
  if (isWindowsPath(path)) {
    // Windows path
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return parts[0] || "C:"; // Return drive root
    parts.pop();
    return parts.join("\\");
  }
  // Unix path
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
};

const getFileName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "";
};

export interface SftpPane {
  connection: SftpConnection | null;
  files: SftpFileEntry[];
  loading: boolean;
  reconnecting: boolean;
  error: string | null;
  selectedFiles: Set<string>;
  filter: string;
}

export const useSftpState = (hosts: Host[], keys: SSHKey[]) => {
  // Connections
  const [leftPane, setLeftPane] = useState<SftpPane>({
    connection: null,
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    selectedFiles: new Set(),
    filter: "",
  });

  const [rightPane, setRightPane] = useState<SftpPane>({
    connection: null,
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    selectedFiles: new Set(),
    filter: "",
  });

  // Transfer management
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const [conflicts, setConflicts] = useState<FileConflict[]>([]);

  // SFTP session refs
  const sftpSessionsRef = useRef<Map<string, string>>(new Map()); // connectionId -> sftpId

  // Progress simulation refs
  const progressIntervalsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Simulate progress for a transfer (used when real progress callbacks aren't available)
  const startProgressSimulation = useCallback(
    (taskId: string, estimatedBytes: number) => {
      // Clear any existing interval for this task
      const existing = progressIntervalsRef.current.get(taskId);
      if (existing) clearInterval(existing);

      // Estimate transfer speed based on file size (simulate realistic speeds)
      // Smaller files: faster perceived progress, larger files: slower but steady
      const baseSpeed = Math.max(50000, Math.min(500000, estimatedBytes / 10)); // 50KB/s to 500KB/s base
      const variability = 0.3; // 30% speed variation

      let transferred = 0;
      const interval = setInterval(() => {
        // Add some randomness to simulate real network conditions
        const speedFactor = 1 + (Math.random() - 0.5) * variability;
        const chunkSize = Math.floor(baseSpeed * speedFactor * 0.1); // Update every 100ms
        transferred = Math.min(transferred + chunkSize, estimatedBytes);

        setTransfers((prev) =>
          prev.map((t) => {
            if (t.id !== taskId || t.status !== "transferring") return t;
            return {
              ...t,
              transferredBytes: transferred,
              totalBytes: estimatedBytes,
              speed: chunkSize * 10, // Convert to per-second
            };
          }),
        );

        // If we've reached the estimated size, slow down to show we're finishing
        if (transferred >= estimatedBytes * 0.95) {
          clearInterval(interval);
          progressIntervalsRef.current.delete(taskId);
        }
      }, 100);

      progressIntervalsRef.current.set(taskId, interval);
    },
    [],
  );

  const stopProgressSimulation = useCallback((taskId: string) => {
    const interval = progressIntervalsRef.current.get(taskId);
    if (interval) {
      clearInterval(interval);
      progressIntervalsRef.current.delete(taskId);
    }
  }, []);

  // Check if an error indicates a stale/lost SFTP session
  const isSessionError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("session not found") ||
      msg.includes("sftp session") ||
      msg.includes("not found") ||
      msg.includes("closed") ||
      msg.includes("connection reset")
    );
  };

  // Ref to track pending reconnections to avoid multiple reconnect attempts
  const reconnectingRef = useRef<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  // Store last connected host info for reconnection
  const lastConnectedHostRef = useRef<{
    left: Host | "local" | null;
    right: Host | "local" | null;
  }>({
    left: null,
    right: null,
  });

  // Handle session error - will trigger auto-reconnect if host info is available
  const handleSessionError = useCallback(
    (side: "left" | "right", _error: Error) => {
      const pane = side === "left" ? leftPane : rightPane;
      const setPane = side === "left" ? setLeftPane : setRightPane;

      if (pane.connection) {
        // Clean up stale session reference
        sftpSessionsRef.current.delete(pane.connection.id);
      }

      // Check if we have host info to attempt reconnection
      const lastHost = lastConnectedHostRef.current[side];
      if (lastHost && pane.files.length > 0 && !reconnectingRef.current[side]) {
        // We have files displayed, try to auto-reconnect
        reconnectingRef.current[side] = true;
        setPane((prev) => ({
          ...prev,
          reconnecting: true,
          error: "Connection lost. Reconnecting...",
        }));
      } else {
        // No host info or empty files, just clear the connection
        setPane({
          connection: null,
          files: [],
          loading: false,
          reconnecting: false,
          error: "SFTP session lost. Please reconnect.",
          selectedFiles: new Set(),
          filter: "",
        });
      }
    },
    [leftPane, rightPane],
  );

  // Cleanup on unmount
  useEffect(() => {
    // Capture refs at effect creation time to use in cleanup
    const sessionsRef = sftpSessionsRef.current;
    const intervalsRef = progressIntervalsRef.current;

    return () => {
      // Clear all SFTP sessions
      sessionsRef.forEach(async (sftpId) => {
        try {
          await window.nebula?.closeSftp(sftpId);
        } catch {
          // Ignore errors when closing SFTP sessions during cleanup
        }
      });
      // Clear all progress simulation intervals
      intervalsRef.forEach((interval) => {
        clearInterval(interval);
      });
      intervalsRef.clear();
    };
  }, []);

  // Track if initial auto-connect has been done
  const initialConnectDoneRef = useRef(false);

  // Get host credentials
  const getHostCredentials = useCallback(
    (host: Host) => {
      const key = host.identityFileId
        ? keys.find((k) => k.id === host.identityFileId)
        : null;
      return {
        hostname: host.hostname,
        username: host.username,
        port: host.port || 22,
        password: host.password,
        privateKey: key?.privateKey,
      };
    },
    [keys],
  );

  // Connect to a host
  const connect = useCallback(
    async (side: "left" | "right", host: Host | "local") => {
      const currentPane = side === "left" ? leftPane : rightPane;
      const setPane = side === "left" ? setLeftPane : setRightPane;
      const connectionId = `${side}-${Date.now()}`;

      // Save host info for potential reconnection
      lastConnectedHostRef.current[side] = host;

      // First, disconnect any existing connection
      if (currentPane.connection && !currentPane.connection.isLocal) {
        const oldSftpId = sftpSessionsRef.current.get(
          currentPane.connection.id,
        );
        if (oldSftpId) {
          try {
            await window.nebula?.closeSftp(oldSftpId);
          } catch {
            // Ignore errors when closing stale SFTP sessions
          }
          sftpSessionsRef.current.delete(currentPane.connection.id);
        }
      }

      if (host === "local") {
        // Local filesystem connection
        // Try to get home directory from backend, fallback to platform-specific default
        let homeDir = await window.nebula?.getHomeDir?.();
        if (!homeDir) {
          // Detect platform and use appropriate default
          const isWindows = navigator.platform.toLowerCase().includes("win");
          homeDir = isWindows ? "C:\\Users\\damao" : "/Users/damao";
        }

        const connection: SftpConnection = {
          id: connectionId,
          hostId: "local",
          hostLabel: "Local",
          isLocal: true,
          status: "connected",
          currentPath: homeDir,
          homeDir,
        };

        setPane((prev) => ({
          ...prev,
          connection,
          loading: true,
          reconnecting: false,
          error: null,
        }));

        try {
          const files = await listLocalFiles(homeDir);
          // Clear reconnecting flag on success
          reconnectingRef.current[side] = false;
          setPane((prev) => ({
            ...prev,
            files,
            loading: false,
            reconnecting: false,
          }));
        } catch (err) {
          reconnectingRef.current[side] = false;
          setPane((prev) => ({
            ...prev,
            error:
              err instanceof Error ? err.message : "Failed to list directory",
            loading: false,
            reconnecting: false,
          }));
        }
      } else {
        // Remote SFTP connection
        const connection: SftpConnection = {
          id: connectionId,
          hostId: host.id,
          hostLabel: host.label,
          isLocal: false,
          status: "connecting",
          currentPath: "/",
        };

        setPane((prev) => ({
          ...prev,
          connection,
          loading: true,
          reconnecting: prev.reconnecting, // Preserve reconnecting state during connection
          error: null,
          files: prev.reconnecting ? prev.files : [], // Keep files if reconnecting
        }));

        try {
          const credentials = getHostCredentials(host);
          const sftpId = await window.nebula?.openSftp({
            sessionId: `sftp-${connectionId}`,
            ...credentials,
          });

          if (!sftpId) throw new Error("Failed to open SFTP session");

          sftpSessionsRef.current.set(connectionId, sftpId);

          // Try to get home directory, default to /
          let startPath = "/";
          try {
            const homeFiles = await window.nebula?.listSftp(
              sftpId,
              `/home/${credentials.username}`,
            );
            if (homeFiles) startPath = `/home/${credentials.username}`;
          } catch {
            try {
              const rootFiles = await window.nebula?.listSftp(sftpId, "/root");
              if (rootFiles) startPath = "/root";
            } catch {
              // Fallback path not available, use default
            }
          }

          const files = await listRemoteFiles(sftpId, startPath);

          // Clear reconnecting flag on success
          reconnectingRef.current[side] = false;

          setPane((prev) => ({
            ...prev,
            connection: prev.connection
              ? {
                  ...prev.connection,
                  status: "connected",
                  currentPath: startPath,
                  homeDir: startPath,
                }
              : null,
            files,
            loading: false,
            reconnecting: false,
          }));
        } catch (err) {
          reconnectingRef.current[side] = false;
          setPane((prev) => ({
            ...prev,
            connection: prev.connection
              ? {
                  ...prev.connection,
                  status: "error",
                  error:
                    err instanceof Error ? err.message : "Connection failed",
                }
              : null,
            error: err instanceof Error ? err.message : "Connection failed",
            loading: false,
            reconnecting: false,
          }));
        }
      }
    },
    [getHostCredentials, leftPane, rightPane],
  );

  // Auto-connect left pane to local filesystem on first mount
  useEffect(() => {
    if (!initialConnectDoneRef.current && !leftPane.connection) {
      initialConnectDoneRef.current = true;
      // Use setTimeout to ensure connect is defined before calling
      setTimeout(() => {
        connect("left", "local");
      }, 0);
    }
  }, [connect, leftPane.connection]);

  // Auto-reconnect when reconnecting flag is set
  useEffect(() => {
    const attemptReconnect = async (side: "left" | "right") => {
      const lastHost = lastConnectedHostRef.current[side];
      if (lastHost && reconnectingRef.current[side]) {
        // Small delay before reconnecting
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (reconnectingRef.current[side]) {
          connect(side, lastHost);
        }
      }
    };

    if (leftPane.reconnecting && reconnectingRef.current.left) {
      attemptReconnect("left");
    }
    if (rightPane.reconnecting && reconnectingRef.current.right) {
      attemptReconnect("right");
    }
  }, [leftPane.reconnecting, rightPane.reconnecting, connect]);

  // Disconnect
  const disconnect = useCallback(
    async (side: "left" | "right") => {
      const pane = side === "left" ? leftPane : rightPane;
      const setPane = side === "left" ? setLeftPane : setRightPane;

      // Clear reconnection state
      reconnectingRef.current[side] = false;
      lastConnectedHostRef.current[side] = null;

      if (pane.connection && !pane.connection.isLocal) {
        const sftpId = sftpSessionsRef.current.get(pane.connection.id);
        if (sftpId) {
          try {
            await window.nebula?.closeSftp(sftpId);
          } catch {
            // Ignore errors when closing SFTP session during disconnect
          }
          sftpSessionsRef.current.delete(pane.connection.id);
        }
      }

      setPane({
        connection: null,
        files: [],
        loading: false,
        reconnecting: false,
        error: null,
        selectedFiles: new Set(),
        filter: "",
      });
    },
    [leftPane, rightPane],
  );

  // Mock local file data for development (when backend is not available)
  const getMockLocalFiles = (path: string): SftpFileEntry[] => {
    // Normalize path for matching (handle both Windows and Unix paths)
    const normPath = path.replace(/\\/g, "/").replace(/\/$/, "") || "/";

    const mockData: Record<string, SftpFileEntry[]> = {
      // Unix-style paths
      "/": [
        {
          name: "Users",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "Applications",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
        {
          name: "System",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 259200000,
          lastModifiedFormatted: formatDate(Date.now() - 259200000),
        },
      ],
      "/Users": [
        {
          name: "damao",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "Shared",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
      ],
      "/Users/damao": [
        {
          name: "Desktop",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 1800000,
          lastModifiedFormatted: formatDate(Date.now() - 1800000),
        },
        {
          name: "Documents",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 7200000,
          lastModifiedFormatted: formatDate(Date.now() - 7200000),
        },
        {
          name: "Downloads",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "Pictures",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
        {
          name: "Projects",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 900000,
          lastModifiedFormatted: formatDate(Date.now() - 900000),
        },
      ],
      // Windows-style paths (normalized to forward slashes for matching)
      "C:": [
        {
          name: "Users",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "Program Files",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
        {
          name: "Windows",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 259200000,
          lastModifiedFormatted: formatDate(Date.now() - 259200000),
        },
      ],
      "C:/Users": [
        {
          name: "damao",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "Public",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "Default",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
      ],
      "C:/Users/damao": [
        {
          name: "Desktop",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 1800000,
          lastModifiedFormatted: formatDate(Date.now() - 1800000),
        },
        {
          name: "Documents",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 7200000,
          lastModifiedFormatted: formatDate(Date.now() - 7200000),
        },
        {
          name: "Downloads",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "Pictures",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
        {
          name: "Projects",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 900000,
          lastModifiedFormatted: formatDate(Date.now() - 900000),
        },
      ],
      "C:/Users/damao/Desktop": [
        {
          name: "Netcatty",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 300000,
          lastModifiedFormatted: formatDate(Date.now() - 300000),
        },
        {
          name: "notes.txt",
          type: "file",
          size: 2048,
          sizeFormatted: "2 KB",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "screenshot.png",
          type: "file",
          size: 1048576,
          sizeFormatted: "1 MB",
          lastModified: Date.now() - 43200000,
          lastModifiedFormatted: formatDate(Date.now() - 43200000),
        },
      ],
      "C:/Users/damao/Desktop/Netcatty": [
        {
          name: "src",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 600000,
          lastModifiedFormatted: formatDate(Date.now() - 600000),
        },
        {
          name: "package.json",
          type: "file",
          size: 1536,
          sizeFormatted: "1.5 KB",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "README.md",
          type: "file",
          size: 4096,
          sizeFormatted: "4 KB",
          lastModified: Date.now() - 7200000,
          lastModifiedFormatted: formatDate(Date.now() - 7200000),
        },
        {
          name: "tsconfig.json",
          type: "file",
          size: 512,
          sizeFormatted: "512 Bytes",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
      ],
      "C:/Users/damao/Documents": [
        {
          name: "Work",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "Personal",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
        {
          name: "report.pdf",
          type: "file",
          size: 2097152,
          sizeFormatted: "2 MB",
          lastModified: Date.now() - 259200000,
          lastModifiedFormatted: formatDate(Date.now() - 259200000),
        },
      ],
      "C:/Users/damao/Downloads": [
        {
          name: "installer.exe",
          type: "file",
          size: 52428800,
          sizeFormatted: "50 MB",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "archive.zip",
          type: "file",
          size: 10485760,
          sizeFormatted: "10 MB",
          lastModified: Date.now() - 7200000,
          lastModifiedFormatted: formatDate(Date.now() - 7200000),
        },
        {
          name: "document.pdf",
          type: "file",
          size: 524288,
          sizeFormatted: "512 KB",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
      ],
      "C:/Users/damao/Projects": [
        {
          name: "webapp",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 1800000,
          lastModifiedFormatted: formatDate(Date.now() - 1800000),
        },
        {
          name: "scripts",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 43200000,
          lastModifiedFormatted: formatDate(Date.now() - 43200000),
        },
      ],
      "/Users/damao/Desktop": [
        {
          name: "Netcatty",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 300000,
          lastModifiedFormatted: formatDate(Date.now() - 300000),
        },
        {
          name: "notes.txt",
          type: "file",
          size: 2048,
          sizeFormatted: "2 KB",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "screenshot.png",
          type: "file",
          size: 1048576,
          sizeFormatted: "1 MB",
          lastModified: Date.now() - 43200000,
          lastModifiedFormatted: formatDate(Date.now() - 43200000),
        },
      ],
      "/Users/damao/Desktop/Netcatty": [
        {
          name: "src",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 600000,
          lastModifiedFormatted: formatDate(Date.now() - 600000),
        },
        {
          name: "package.json",
          type: "file",
          size: 1536,
          sizeFormatted: "1.5 KB",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "README.md",
          type: "file",
          size: 4096,
          sizeFormatted: "4 KB",
          lastModified: Date.now() - 7200000,
          lastModifiedFormatted: formatDate(Date.now() - 7200000),
        },
        {
          name: "tsconfig.json",
          type: "file",
          size: 512,
          sizeFormatted: "512 Bytes",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
      ],
      "/Users/damao/Documents": [
        {
          name: "Work",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
        {
          name: "Personal",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 172800000,
          lastModifiedFormatted: formatDate(Date.now() - 172800000),
        },
        {
          name: "report.pdf",
          type: "file",
          size: 2097152,
          sizeFormatted: "2 MB",
          lastModified: Date.now() - 259200000,
          lastModifiedFormatted: formatDate(Date.now() - 259200000),
        },
      ],
      "/Users/damao/Downloads": [
        {
          name: "installer.exe",
          type: "file",
          size: 52428800,
          sizeFormatted: "50 MB",
          lastModified: Date.now() - 3600000,
          lastModifiedFormatted: formatDate(Date.now() - 3600000),
        },
        {
          name: "archive.zip",
          type: "file",
          size: 10485760,
          sizeFormatted: "10 MB",
          lastModified: Date.now() - 7200000,
          lastModifiedFormatted: formatDate(Date.now() - 7200000),
        },
        {
          name: "document.pdf",
          type: "file",
          size: 524288,
          sizeFormatted: "512 KB",
          lastModified: Date.now() - 86400000,
          lastModifiedFormatted: formatDate(Date.now() - 86400000),
        },
      ],
      "/Users/damao/Projects": [
        {
          name: "webapp",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 1800000,
          lastModifiedFormatted: formatDate(Date.now() - 1800000),
        },
        {
          name: "scripts",
          type: "directory",
          size: 0,
          sizeFormatted: "--",
          lastModified: Date.now() - 43200000,
          lastModifiedFormatted: formatDate(Date.now() - 43200000),
        },
      ],
    };
    return mockData[normPath] || [];
  };

  // List local files
  const listLocalFiles = async (path: string): Promise<SftpFileEntry[]> => {
    const rawFiles = await window.nebula?.listLocalDir?.(path);
    if (!rawFiles) {
      // Fallback mock for development
      return getMockLocalFiles(path);
    }

    return rawFiles.map((f) => ({
      name: f.name,
      type: f.type as "file" | "directory" | "symlink",
      size: parseInt(f.size) || 0,
      sizeFormatted: f.size,
      lastModified: new Date(f.lastModified).getTime(),
      lastModifiedFormatted: f.lastModified,
    }));
  };

  // List remote files
  const listRemoteFiles = async (
    sftpId: string,
    path: string,
  ): Promise<SftpFileEntry[]> => {
    const rawFiles = await window.nebula?.listSftp(sftpId, path);
    if (!rawFiles) return [];

    return rawFiles.map((f) => ({
      name: f.name,
      type: f.type as "file" | "directory" | "symlink",
      size: parseInt(f.size) || 0,
      sizeFormatted: f.size,
      lastModified: new Date(f.lastModified).getTime(),
      lastModifiedFormatted: f.lastModified,
    }));
  };

  // Navigate to path
  const navigateTo = useCallback(
    async (side: "left" | "right", path: string) => {
      const pane = side === "left" ? leftPane : rightPane;
      const setPane = side === "left" ? setLeftPane : setRightPane;

      if (!pane.connection) return;

      setPane((prev) => ({ ...prev, loading: true, error: null }));

      try {
        let files: SftpFileEntry[];

        if (pane.connection.isLocal) {
          files = await listLocalFiles(path);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            // Session lost - clear connection state
            setPane({
              connection: null,
              files: [],
              loading: false,
              reconnecting: false,
              error: "SFTP session lost. Please reconnect.",
              selectedFiles: new Set(),
              filter: "",
            });
            return;
          }

          try {
            files = await listRemoteFiles(sftpId, path);
          } catch (err) {
            // Check if it's a session error
            const errorMsg =
              err instanceof Error ? err.message : "Unknown error";
            if (
              errorMsg.includes("session") ||
              errorMsg.includes("not found") ||
              errorMsg.includes("closed")
            ) {
              // Clean up stale session reference
              sftpSessionsRef.current.delete(pane.connection.id);
              setPane({
                connection: null,
                files: [],
                loading: false,
                reconnecting: false,
                error: "SFTP session expired. Please reconnect.",
                selectedFiles: new Set(),
                filter: "",
              });
              return;
            }
            throw err;
          }
        }

        setPane((prev) => ({
          ...prev,
          connection: prev.connection
            ? { ...prev.connection, currentPath: path }
            : null,
          files,
          loading: false,
          selectedFiles: new Set(),
        }));
      } catch (err) {
        setPane((prev) => ({
          ...prev,
          error:
            err instanceof Error ? err.message : "Failed to list directory",
          loading: false,
        }));
      }
    },
    [leftPane, rightPane],
  );

  // Refresh current directory
  const refresh = useCallback(
    async (side: "left" | "right") => {
      const pane = side === "left" ? leftPane : rightPane;
      if (pane.connection) {
        await navigateTo(side, pane.connection.currentPath);
      }
    },
    [leftPane, rightPane, navigateTo],
  );

  // Navigate up
  const navigateUp = useCallback(
    async (side: "left" | "right") => {
      const pane = side === "left" ? leftPane : rightPane;
      if (!pane.connection) return;

      const currentPath = pane.connection.currentPath;
      // Check if we're at root (Unix "/" or Windows "C:")
      const isAtRoot =
        currentPath === "/" || /^[A-Za-z]:[\\/]?$/.test(currentPath);

      if (!isAtRoot) {
        const parentPath = getParentPath(currentPath);
        await navigateTo(side, parentPath);
      }
    },
    [leftPane, rightPane, navigateTo],
  );

  // Open file/directory
  const openEntry = useCallback(
    async (side: "left" | "right", entry: SftpFileEntry) => {
      const pane = side === "left" ? leftPane : rightPane;
      if (!pane.connection) return;

      if (entry.name === "..") {
        await navigateUp(side);
        return;
      }

      if (entry.type === "directory") {
        const newPath = joinPath(pane.connection.currentPath, entry.name);
        await navigateTo(side, newPath);
      }
      // TODO: Handle file open/preview
    },
    [leftPane, rightPane, navigateTo, navigateUp],
  );

  // Selection management
  const toggleSelection = useCallback(
    (side: "left" | "right", fileName: string, multiSelect: boolean) => {
      const setPane = side === "left" ? setLeftPane : setRightPane;

      setPane((prev) => {
        const newSelection = new Set(multiSelect ? prev.selectedFiles : []);
        if (newSelection.has(fileName)) {
          newSelection.delete(fileName);
        } else {
          newSelection.add(fileName);
        }
        return { ...prev, selectedFiles: newSelection };
      });
    },
    [],
  );

  // Range selection for shift-click
  // Now accepts the actual file names to select directly from the UI
  const rangeSelect = useCallback(
    (side: "left" | "right", fileNames: string[]) => {
      const setPane = side === "left" ? setLeftPane : setRightPane;

      const newSelection = new Set<string>();
      for (const name of fileNames) {
        if (name && name !== "..") {
          newSelection.add(name);
        }
      }

      setPane((prev) => ({ ...prev, selectedFiles: newSelection }));
    },
    [],
  );

  const clearSelection = useCallback((side: "left" | "right") => {
    const setPane = side === "left" ? setLeftPane : setRightPane;
    setPane((prev) => ({ ...prev, selectedFiles: new Set() }));
  }, []);

  const selectAll = useCallback(
    (side: "left" | "right") => {
      const pane = side === "left" ? leftPane : rightPane;
      const setPane = side === "left" ? setLeftPane : setRightPane;

      setPane((prev) => ({
        ...prev,
        selectedFiles: new Set(
          pane.files.filter((f) => f.name !== "..").map((f) => f.name),
        ),
      }));
    },
    [leftPane, rightPane],
  );

  // Filter
  const setFilter = useCallback((side: "left" | "right", filter: string) => {
    const setPane = side === "left" ? setLeftPane : setRightPane;
    setPane((prev) => ({ ...prev, filter }));
  }, []);

  // Create directory
  const createDirectory = useCallback(
    async (side: "left" | "right", name: string) => {
      const pane = side === "left" ? leftPane : rightPane;
      if (!pane.connection) return;

      const fullPath = joinPath(pane.connection.currentPath, name);

      try {
        if (pane.connection.isLocal) {
          await window.nebula?.mkdirLocal?.(fullPath);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            handleSessionError(side, new Error("SFTP session not found"));
            return;
          }
          await window.nebula?.mkdirSftp(sftpId, fullPath);
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [leftPane, rightPane, refresh, handleSessionError],
  );

  // Delete files
  const deleteFiles = useCallback(
    async (side: "left" | "right", fileNames: string[]) => {
      const pane = side === "left" ? leftPane : rightPane;
      if (!pane.connection) return;

      try {
        for (const name of fileNames) {
          const fullPath = joinPath(pane.connection.currentPath, name);

          if (pane.connection.isLocal) {
            await window.nebula?.deleteLocalFile?.(fullPath);
          } else {
            const sftpId = sftpSessionsRef.current.get(pane.connection.id);
            if (!sftpId) {
              handleSessionError(side, new Error("SFTP session not found"));
              return;
            }
            await window.nebula?.deleteSftp?.(sftpId, fullPath);
          }
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [leftPane, rightPane, refresh, handleSessionError],
  );

  // Rename file
  const renameFile = useCallback(
    async (side: "left" | "right", oldName: string, newName: string) => {
      const pane = side === "left" ? leftPane : rightPane;
      if (!pane.connection) return;

      const oldPath = joinPath(pane.connection.currentPath, oldName);
      const newPath = joinPath(pane.connection.currentPath, newName);

      try {
        if (pane.connection.isLocal) {
          await window.nebula?.renameLocalFile?.(oldPath, newPath);
        } else {
          const sftpId = sftpSessionsRef.current.get(pane.connection.id);
          if (!sftpId) {
            handleSessionError(side, new Error("SFTP session not found"));
            return;
          }
          await window.nebula?.renameSftp?.(sftpId, oldPath, newPath);
        }
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        throw err;
      }
    },
    [leftPane, rightPane, refresh, handleSessionError],
  );

  // Transfer files
  const startTransfer = useCallback(
    async (
      sourceFiles: { name: string; isDirectory: boolean }[],
      sourceSide: "left" | "right",
      targetSide: "left" | "right",
    ) => {
      const sourcePane = sourceSide === "left" ? leftPane : rightPane;
      const targetPane = targetSide === "left" ? leftPane : rightPane;

      if (!sourcePane.connection || !targetPane.connection) return;

      const sourcePath = sourcePane.connection.currentPath;
      const targetPath = targetPane.connection.currentPath;

      // Get SFTP session ID if remote
      const sourceSftpId = sourcePane.connection.isLocal
        ? null
        : sftpSessionsRef.current.get(sourcePane.connection.id);

      // Create transfer tasks with actual file sizes
      const newTasks: TransferTask[] = [];

      for (const file of sourceFiles) {
        const direction: TransferDirection =
          sourcePane.connection!.isLocal && !targetPane.connection!.isLocal
            ? "upload"
            : !sourcePane.connection!.isLocal && targetPane.connection!.isLocal
              ? "download"
              : "remote-to-remote";

        // Get actual file size from source
        let fileSize = 0;
        if (!file.isDirectory) {
          try {
            const fullPath = joinPath(sourcePath, file.name);
            if (sourcePane.connection!.isLocal) {
              const stat = await window.nebula?.statLocal?.(fullPath);
              if (stat) fileSize = stat.size;
            } else if (sourceSftpId) {
              const stat = await window.nebula?.statSftp?.(
                sourceSftpId,
                fullPath,
              );
              if (stat) fileSize = stat.size;
            }
          } catch {
            // If stat fails, we'll use estimate later
          }
        }

        newTasks.push({
          id: crypto.randomUUID(),
          fileName: file.name,
          sourcePath: joinPath(sourcePath, file.name),
          targetPath: joinPath(targetPath, file.name),
          sourceConnectionId: sourcePane.connection!.id,
          targetConnectionId: targetPane.connection!.id,
          direction,
          status: "pending" as TransferStatus,
          totalBytes: fileSize,
          transferredBytes: 0,
          speed: 0,
          startTime: Date.now(),
          isDirectory: file.isDirectory,
        });
      }

      setTransfers((prev) => [...prev, ...newTasks]);

      // Process transfers
      for (const task of newTasks) {
        await processTransfer(task, sourcePane, targetPane);
      }
    },
    [leftPane, rightPane],
  );

  // Process a single transfer
  const processTransfer = async (
    task: TransferTask,
    sourcePane: SftpPane,
    targetPane: SftpPane,
  ) => {
    const updateTask = (updates: Partial<TransferTask>) => {
      setTransfers((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, ...updates } : t)),
      );
    };

    // Get actual file size if not already known
    let actualFileSize = task.totalBytes;
    if (!task.isDirectory && actualFileSize === 0) {
      try {
        const sourceSftpId = sourcePane.connection?.isLocal
          ? null
          : sftpSessionsRef.current.get(sourcePane.connection!.id);

        if (sourcePane.connection?.isLocal) {
          const stat = await window.nebula?.statLocal?.(task.sourcePath);
          if (stat) actualFileSize = stat.size;
        } else if (sourceSftpId) {
          const stat = await window.nebula?.statSftp?.(
            sourceSftpId,
            task.sourcePath,
          );
          if (stat) actualFileSize = stat.size;
        }
      } catch {
        // Ignore stat errors, use estimate
      }
    }

    // Estimate file size for progress simulation (use a reasonable default if unknown)
    const estimatedSize =
      actualFileSize > 0
        ? actualFileSize
        : task.isDirectory
          ? 1024 * 1024 // 1MB estimate for directories
          : 256 * 1024; // 256KB default for files

    // Check if streaming transfer is available (will provide real progress)
    const hasStreamingTransfer = !!window.nebula?.startStreamTransfer;

    updateTask({
      status: "transferring",
      totalBytes: estimatedSize,
      transferredBytes: 0,
      startTime: Date.now(),
    });

    // Only use simulated progress for directories or when streaming is not available
    const useSimulatedProgress = task.isDirectory || !hasStreamingTransfer;
    if (useSimulatedProgress) {
      startProgressSimulation(task.id, estimatedSize);
    }

    try {
      const sourceSftpId = sourcePane.connection?.isLocal
        ? null
        : sftpSessionsRef.current.get(sourcePane.connection!.id);
      const targetSftpId = targetPane.connection?.isLocal
        ? null
        : sftpSessionsRef.current.get(targetPane.connection!.id);

      // Check if file already exists at target (conflict detection)
      // Skip if user already resolved conflict with replace/duplicate
      if (!task.isDirectory && !task.skipConflictCheck) {
        let targetExists = false;
        let existingStat: { size: number; mtime: number } | null = null;
        let sourceStat: { size: number; mtime: number } | null = null;

        // Get source file stat for accurate size and mtime
        try {
          if (sourcePane.connection?.isLocal) {
            const stat = await window.nebula?.statLocal?.(task.sourcePath);
            if (stat) {
              sourceStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          } else if (sourceSftpId && window.nebula?.statSftp) {
            const stat = await window.nebula.statSftp(
              sourceSftpId,
              task.sourcePath,
            );
            if (stat) {
              sourceStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          }
        } catch {
          // Use estimated size if stat fails
        }

        // Get target file stat to check for conflict
        try {
          if (targetPane.connection?.isLocal) {
            const stat = await window.nebula?.statLocal?.(task.targetPath);
            if (stat) {
              targetExists = true;
              existingStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          } else if (targetSftpId && window.nebula?.statSftp) {
            const stat = await window.nebula.statSftp(
              targetSftpId,
              task.targetPath,
            );
            if (stat) {
              targetExists = true;
              existingStat = {
                size: stat.size,
                mtime: stat.lastModified || Date.now(),
              };
            }
          }
        } catch {
          // File doesn't exist, no conflict
        }

        if (targetExists && existingStat) {
          // Stop progress simulation while waiting for user decision
          stopProgressSimulation(task.id);

          // Add conflict for user to resolve
          const newConflict: FileConflict = {
            transferId: task.id,
            fileName: task.fileName,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            existingSize: existingStat.size,
            newSize: sourceStat?.size || estimatedSize, // Use actual source size
            existingModified: existingStat.mtime,
            newModified: sourceStat?.mtime || Date.now(), // Use actual source mtime
          };
          setConflicts((prev) => [...prev, newConflict]);
          updateTask({
            status: "pending",
            totalBytes: sourceStat?.size || estimatedSize,
          }); // Wait for user decision
          return;
        }
      }

      if (task.isDirectory) {
        // Handle directory transfer recursively
        await transferDirectory(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
        );
      } else {
        // Handle file transfer
        await transferFile(
          task,
          sourceSftpId,
          targetSftpId,
          sourcePane.connection!.isLocal,
          targetPane.connection!.isLocal,
        );
      }

      // Stop progress simulation (only if it was started)
      if (useSimulatedProgress) {
        stopProgressSimulation(task.id);
      }

      // Get the current state of the task to use accurate totalBytes
      setTransfers((prev) =>
        prev.map((t) => {
          if (t.id !== task.id) return t;
          return {
            ...t,
            status: "completed" as TransferStatus,
            endTime: Date.now(),
            transferredBytes: t.totalBytes, // Use actual totalBytes from state
            speed: 0,
          };
        }),
      );

      // Refresh target pane
      const targetSide = targetPane === leftPane ? "left" : "right";
      await refresh(targetSide as "left" | "right");
    } catch (err) {
      // Stop progress simulation on failure (only if it was started)
      if (useSimulatedProgress) {
        stopProgressSimulation(task.id);
      }
      updateTask({
        status: "failed",
        error: err instanceof Error ? err.message : "Transfer failed",
        endTime: Date.now(),
        speed: 0,
      });
    }
  };

  // Transfer a single file using streaming with real progress
  const transferFile = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean,
  ): Promise<void> => {
    // Try to use streaming transfer if available
    if (window.nebula?.startStreamTransfer) {
      return new Promise((resolve, reject) => {
        const options = {
          transferId: task.id,
          sourcePath: task.sourcePath,
          targetPath: task.targetPath,
          sourceType: sourceIsLocal ? ("local" as const) : ("sftp" as const),
          targetType: targetIsLocal ? ("local" as const) : ("sftp" as const),
          sourceSftpId: sourceSftpId || undefined,
          targetSftpId: targetSftpId || undefined,
          totalBytes: task.totalBytes || undefined,
        };

        const onProgress = (
          transferred: number,
          total: number,
          speed: number,
        ) => {
          setTransfers((prev) =>
            prev.map((t) => {
              if (t.id !== task.id) return t;
              // Check if cancelled
              if (t.status === "cancelled") return t;
              return {
                ...t,
                transferredBytes: transferred,
                totalBytes: total || t.totalBytes,
                speed,
              };
            }),
          );
        };

        const onComplete = () => {
          resolve();
        };

        const onError = (error: string) => {
          reject(new Error(error));
        };

        window.nebula!.startStreamTransfer!(
          options,
          onProgress,
          onComplete,
          onError,
        ).catch(reject);
      });
    }

    // Fallback to legacy transfer (read all then write all)
    let content: ArrayBuffer | string;

    // Read from source
    if (sourceIsLocal) {
      content =
        (await window.nebula?.readLocalFile?.(task.sourcePath)) ||
        new ArrayBuffer(0);
    } else if (sourceSftpId) {
      if (window.nebula?.readSftpBinary) {
        content = await window.nebula.readSftpBinary(
          sourceSftpId,
          task.sourcePath,
        );
      } else {
        content =
          (await window.nebula?.readSftp(sourceSftpId, task.sourcePath)) || "";
      }
    } else {
      throw new Error("No source connection");
    }

    // Write to target
    if (targetIsLocal) {
      if (content instanceof ArrayBuffer) {
        await window.nebula?.writeLocalFile?.(task.targetPath, content);
      } else {
        const encoder = new TextEncoder();
        await window.nebula?.writeLocalFile?.(
          task.targetPath,
          encoder.encode(content).buffer,
        );
      }
    } else if (targetSftpId) {
      if (content instanceof ArrayBuffer && window.nebula?.writeSftpBinary) {
        await window.nebula.writeSftpBinary(
          targetSftpId,
          task.targetPath,
          content,
        );
      } else {
        const text =
          content instanceof ArrayBuffer
            ? new TextDecoder().decode(content)
            : content;
        await window.nebula?.writeSftp(targetSftpId, task.targetPath, text);
      }
    } else {
      throw new Error("No target connection");
    }
  };

  // Transfer a directory
  const transferDirectory = async (
    task: TransferTask,
    sourceSftpId: string | null,
    targetSftpId: string | null,
    sourceIsLocal: boolean,
    targetIsLocal: boolean,
  ) => {
    // Create target directory
    if (targetIsLocal) {
      await window.nebula?.mkdirLocal?.(task.targetPath);
    } else if (targetSftpId) {
      await window.nebula?.mkdirSftp(targetSftpId, task.targetPath);
    }

    // List source directory
    let files: SftpFileEntry[];
    if (sourceIsLocal) {
      files = await listLocalFiles(task.sourcePath);
    } else if (sourceSftpId) {
      files = await listRemoteFiles(sourceSftpId, task.sourcePath);
    } else {
      throw new Error("No source connection");
    }

    // Transfer each item
    for (const file of files) {
      if (file.name === "..") continue;

      const childTask: TransferTask = {
        ...task,
        id: crypto.randomUUID(),
        fileName: file.name,
        sourcePath: joinPath(task.sourcePath, file.name),
        targetPath: joinPath(task.targetPath, file.name),
        isDirectory: file.type === "directory",
        parentTaskId: task.id,
      };

      if (file.type === "directory") {
        await transferDirectory(
          childTask,
          sourceSftpId,
          targetSftpId,
          sourceIsLocal,
          targetIsLocal,
        );
      } else {
        await transferFile(
          childTask,
          sourceSftpId,
          targetSftpId,
          sourceIsLocal,
          targetIsLocal,
        );
      }
    }
  };

  // Cancel transfer
  // This will stop the streaming transfer at the backend level if supported
  const cancelTransfer = useCallback(
    async (transferId: string) => {
      // Stop progress simulation (for directory transfers or fallback mode)
      stopProgressSimulation(transferId);

      // Mark as cancelled
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId
            ? {
                ...t,
                status: "cancelled" as TransferStatus,
                endTime: Date.now(),
              }
            : t,
        ),
      );

      // Remove from conflicts if present
      setConflicts((prev) => prev.filter((c) => c.transferId !== transferId));

      // Cancel at backend level if streaming transfer is in progress
      if (window.nebula?.cancelTransfer) {
        try {
          await window.nebula.cancelTransfer(transferId);
        } catch (err) {
          console.warn("Failed to cancel transfer at backend:", err);
        }
      }
    },
    [stopProgressSimulation],
  );

  // Retry failed transfer
  const retryTransfer = useCallback(
    async (transferId: string) => {
      const task = transfers.find((t) => t.id === transferId);
      if (!task) return;

      const sourcePane = task.sourceConnectionId.startsWith("left")
        ? leftPane
        : rightPane;
      const targetPane = task.targetConnectionId.startsWith("left")
        ? leftPane
        : rightPane;

      if (sourcePane.connection && targetPane.connection) {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId
              ? { ...t, status: "pending" as TransferStatus, error: undefined }
              : t,
          ),
        );
        await processTransfer(task, sourcePane, targetPane);
      }
    },
    [transfers, leftPane, rightPane],
  );

  // Clear completed transfers
  const clearCompletedTransfers = useCallback(() => {
    setTransfers((prev) =>
      prev.filter((t) => t.status !== "completed" && t.status !== "cancelled"),
    );
  }, []);

  // Dismiss transfer
  const dismissTransfer = useCallback((transferId: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== transferId));
  }, []);

  // Handle file conflict
  const resolveConflict = useCallback(
    async (conflictId: string, action: "replace" | "skip" | "duplicate") => {
      const conflict = conflicts.find((c) => c.transferId === conflictId);
      if (!conflict) return;

      // Remove from conflicts list
      setConflicts((prev) => prev.filter((c) => c.transferId !== conflictId));

      // Find the task
      const task = transfers.find((t) => t.id === conflictId);
      if (!task) return;

      if (action === "skip") {
        // Mark as cancelled
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === conflictId
              ? { ...t, status: "cancelled" as TransferStatus }
              : t,
          ),
        );
        return;
      }

      // For replace or duplicate, we need to update the task and re-process
      let updatedTask = { ...task };

      if (action === "duplicate") {
        // Generate new name and update task
        const ext = task.fileName.includes(".")
          ? "." + task.fileName.split(".").pop()
          : "";
        const baseName = task.fileName.includes(".")
          ? task.fileName.slice(0, task.fileName.lastIndexOf("."))
          : task.fileName;
        const newName = `${baseName} (copy)${ext}`;
        const newTargetPath = task.targetPath.replace(task.fileName, newName);
        updatedTask = {
          ...task,
          fileName: newName,
          targetPath: newTargetPath,
          skipConflictCheck: true, // Skip check for new name
        };
      } else if (action === "replace") {
        // For replace, we just need to skip the conflict check
        updatedTask = {
          ...task,
          skipConflictCheck: true, // User explicitly chose to replace
        };
      }

      // Update task status and re-process
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === conflictId
            ? { ...updatedTask, status: "pending" as TransferStatus }
            : t,
        ),
      );

      // Find source and target panes and re-process transfer
      const sourcePane = updatedTask.sourceConnectionId.startsWith("left")
        ? leftPane
        : rightPane;
      const targetPane = updatedTask.targetConnectionId.startsWith("left")
        ? leftPane
        : rightPane;

      if (sourcePane.connection && targetPane.connection) {
        // Small delay to ensure state is updated
        setTimeout(async () => {
          await processTransfer(updatedTask, sourcePane, targetPane);
        }, 100);
      }
    },
    [conflicts, transfers, leftPane, rightPane],
  );

  // Get filtered files
  const getFilteredFiles = (pane: SftpPane): SftpFileEntry[] => {
    const term = pane.filter.trim().toLowerCase();
    if (!term) return pane.files;
    return pane.files.filter(
      (f) => f.name === ".." || f.name.toLowerCase().includes(term),
    );
  };

  // Get active transfers count
  const activeTransfersCount = transfers.filter(
    (t) => t.status === "pending" || t.status === "transferring",
  ).length;

  // Change file permissions (SFTP only)
  const changePermissions = useCallback(
    async (
      side: "left" | "right",
      filePath: string,
      mode: string, // octal string like "755"
    ) => {
      const pane = side === "left" ? leftPane : rightPane;
      if (!pane.connection || pane.connection.isLocal) {
        console.warn("Cannot change permissions on local files");
        return;
      }

      const sftpId = sftpSessionsRef.current.get(pane.connection.id);
      if (!sftpId || !window.nebula?.chmodSftp) {
        handleSessionError(side, new Error("SFTP session not found"));
        return;
      }

      try {
        await window.nebula.chmodSftp(sftpId, filePath, mode);
        await refresh(side);
      } catch (err) {
        if (isSessionError(err)) {
          handleSessionError(side, err as Error);
          return;
        }
        console.error("Failed to change permissions:", err);
      }
    },
    [leftPane, rightPane, refresh, handleSessionError],
  );

  return {
    // Panes
    leftPane,
    rightPane,
    getFilteredFiles,

    // Connection
    connect,
    disconnect,

    // Navigation
    navigateTo,
    navigateUp,
    refresh,
    openEntry,

    // Selection
    toggleSelection,
    rangeSelect,
    clearSelection,
    selectAll,
    setFilter,

    // File operations
    createDirectory,
    deleteFiles,
    renameFile,
    changePermissions,

    // Transfers
    transfers,
    activeTransfersCount,
    startTransfer,
    cancelTransfer,
    retryTransfer,
    clearCompletedTransfers,
    dismissTransfer,

    // Conflicts
    conflicts,
    resolveConflict,

    // Helpers
    formatFileSize,
    formatDate,
    getFileExtension,
    joinPath,
    getParentPath,
    getFileName,
  };
};
