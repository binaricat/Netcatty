import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import type { RemoteFile, SftpFilenameEncoding } from "../../types";

export const useSftpBackend = () => {
  const openSftp = useCallback(async (options: NetcattySSHOptions) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openSftp) throw new Error("SFTP bridge unavailable");
    return bridge.openSftp(options);
  }, []);

  const closeSftp = useCallback(async (sftpId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.closeSftp) throw new Error("SFTP bridge unavailable");
    return bridge.closeSftp(sftpId);
  }, []);

  const listSftp = useCallback(async (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listSftp) throw new Error("SFTP bridge unavailable");
    return bridge.listSftp(sftpId, path, encoding);
  }, []);

  const readSftp = useCallback(async (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.readSftp) throw new Error("SFTP bridge unavailable");
    return bridge.readSftp(sftpId, path, encoding);
  }, []);

  const readSftpBinary = useCallback(async (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.readSftpBinary) throw new Error("readSftpBinary unavailable");
    return bridge.readSftpBinary(sftpId, path, encoding);
  }, []);

  const writeSftp = useCallback(async (sftpId: string, path: string, content: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.writeSftp) throw new Error("SFTP bridge unavailable");
    return bridge.writeSftp(sftpId, path, content, encoding);
  }, []);

  const writeSftpBinary = useCallback(async (sftpId: string, path: string, content: ArrayBuffer, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.writeSftpBinary) throw new Error("writeSftpBinary unavailable");
    return bridge.writeSftpBinary(sftpId, path, content, encoding);
  }, []);

  const writeSftpBinaryWithProgress = useCallback(
    async (
      sftpId: string,
      path: string,
      content: ArrayBuffer,
      transferId: string,
      encoding?: SftpFilenameEncoding,
      onProgress?: (transferred: number, total: number, speed: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void,
    ) => {
      const bridge = netcattyBridge.get();
      if (!bridge?.writeSftpBinaryWithProgress) return undefined;
      return bridge.writeSftpBinaryWithProgress(
        sftpId,
        path,
        content,
        transferId,
        encoding,
        onProgress,
        onComplete,
        onError,
      );
    },
    [],
  );

  const mkdirSftp = useCallback(async (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.mkdirSftp) throw new Error("mkdirSftp unavailable");
    return bridge.mkdirSftp(sftpId, path, encoding);
  }, []);

  const deleteSftp = useCallback(async (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.deleteSftp) throw new Error("deleteSftp unavailable");
    return bridge.deleteSftp(sftpId, path, encoding);
  }, []);

  const renameSftp = useCallback(async (sftpId: string, oldPath: string, newPath: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.renameSftp) throw new Error("renameSftp unavailable");
    return bridge.renameSftp(sftpId, oldPath, newPath, encoding);
  }, []);

  const statSftp = useCallback(async (sftpId: string, path: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.statSftp) throw new Error("statSftp unavailable");
    return bridge.statSftp(sftpId, path, encoding);
  }, []);

  const chmodSftp = useCallback(async (sftpId: string, path: string, mode: string, encoding?: SftpFilenameEncoding) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.chmodSftp) throw new Error("chmodSftp unavailable");
    return bridge.chmodSftp(sftpId, path, mode, encoding);
  }, []);

  const listLocalDir = useCallback(async (path: string): Promise<RemoteFile[]> => {
    const bridge = netcattyBridge.get();
    if (!bridge?.listLocalDir) throw new Error("listLocalDir unavailable");
    return bridge.listLocalDir(path);
  }, []);

  const readLocalFile = useCallback(async (path: string): Promise<ArrayBuffer> => {
    const bridge = netcattyBridge.get();
    if (!bridge?.readLocalFile) throw new Error("readLocalFile unavailable");
    return bridge.readLocalFile(path);
  }, []);

  const writeLocalFile = useCallback(async (path: string, content: ArrayBuffer) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.writeLocalFile) throw new Error("writeLocalFile unavailable");
    return bridge.writeLocalFile(path, content);
  }, []);

  const deleteLocalFile = useCallback(async (path: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.deleteLocalFile) throw new Error("deleteLocalFile unavailable");
    return bridge.deleteLocalFile(path);
  }, []);

  const renameLocalFile = useCallback(async (oldPath: string, newPath: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.renameLocalFile) throw new Error("renameLocalFile unavailable");
    return bridge.renameLocalFile(oldPath, newPath);
  }, []);

  const mkdirLocal = useCallback(async (path: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.mkdirLocal) throw new Error("mkdirLocal unavailable");
    return bridge.mkdirLocal(path);
  }, []);

  const statLocal = useCallback(async (path: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.statLocal) throw new Error("statLocal unavailable");
    return bridge.statLocal(path);
  }, []);

  const getHomeDir = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.getHomeDir) return undefined;
    return bridge.getHomeDir();
  }, []);

  const startStreamTransfer = useCallback(
    async (
      options: Parameters<NonNullable<NetcattyBridge["startStreamTransfer"]>>[0],
      onProgress?: (transferred: number, total: number, speed: number) => void,
      onComplete?: () => void,
      onError?: (error: string) => void,
    ) => {
      const bridge = netcattyBridge.get();
      if (!bridge?.startStreamTransfer) return undefined;
      return bridge.startStreamTransfer(options, onProgress, onComplete, onError);
    },
    [],
  );

  const cancelTransfer = useCallback(async (transferId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.cancelTransfer) return undefined;
    return bridge.cancelTransfer(transferId);
  }, []);

  const cancelSftpUpload = useCallback(async (transferId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.cancelSftpUpload) return undefined;
    return bridge.cancelSftpUpload(transferId);
  }, []);

  const onTransferProgress = useCallback((transferId: string, cb: Parameters<NonNullable<NetcattyBridge["onTransferProgress"]>>[1]) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onTransferProgress) return undefined;
    return bridge.onTransferProgress(transferId, cb);
  }, []);

  const selectApplication = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectApplication) return undefined;
    return bridge.selectApplication();
  }, []);

  const showSaveDialog = useCallback(async (
    defaultPath: string,
    filters?: Array<{ name: string; extensions: string[] }>
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.showSaveDialog) return null;
    return bridge.showSaveDialog(defaultPath, filters);
  }, []);

  const downloadSftpToTempAndOpen = useCallback(async (
    sftpId: string,
    remotePath: string,
    fileName: string,
    appPath: string,
    options?: { enableWatch?: boolean; encoding?: SftpFilenameEncoding }
  ): Promise<{ localTempPath: string; watchId?: string }> => {
    const bridge = netcattyBridge.get();
    if (!bridge?.downloadSftpToTemp || !bridge?.openWithApplication) {
      throw new Error("Download to temp / open with unavailable");
    }
    
    // Download the file to temp
    console.log("[SFTPBackend] Downloading file to temp", { sftpId, remotePath, fileName });
    const tempPath = await bridge.downloadSftpToTemp(sftpId, remotePath, fileName, options?.encoding);
    console.log("[SFTPBackend] File downloaded to temp", { tempPath });
    
    // Register temp file for cleanup when SFTP session closes (regardless of auto-sync setting)
    if (bridge.registerTempFile) {
      try {
        await bridge.registerTempFile(sftpId, tempPath);
      } catch (err) {
        console.warn("[SFTPBackend] Failed to register temp file for cleanup:", err);
      }
    }
    
    // Open with the selected application
    console.log("[SFTPBackend] Opening with application", { tempPath, appPath });
    await bridge.openWithApplication(tempPath, appPath);
    console.log("[SFTPBackend] Application launched");
    
    // Start file watching if enabled
    let watchId: string | undefined;
    console.log("[SFTPBackend] Auto-sync enabled check", { enableWatch: options?.enableWatch, hasStartFileWatch: !!bridge.startFileWatch });
    if (options?.enableWatch && bridge.startFileWatch) {
      try {
        console.log("[SFTPBackend] Starting file watch", { tempPath, remotePath, sftpId });
        const result = await bridge.startFileWatch(tempPath, remotePath, sftpId, options?.encoding);
        watchId = result.watchId;
        console.log("[SFTPBackend] File watch started successfully", { watchId, tempPath, remotePath });
      } catch (err) {
        console.warn("[SFTPBackend] Failed to start file watch:", err);
        // Don't fail the operation if watching fails
      }
    } else {
      console.log("[SFTPBackend] File watching not enabled or not available");
    }
    
    return { localTempPath: tempPath, watchId };
  }, []);

  return {
    openSftp,
    closeSftp,
    listSftp,
    readSftp,
    readSftpBinary,
    writeSftp,
    writeSftpBinary,
    writeSftpBinaryWithProgress,
    mkdirSftp,
    deleteSftp,
    renameSftp,
    statSftp,
    chmodSftp,

    listLocalDir,
    readLocalFile,
    writeLocalFile,
    deleteLocalFile,
    renameLocalFile,
    mkdirLocal,
    statLocal,
    getHomeDir,

    startStreamTransfer,
    cancelTransfer,
    cancelSftpUpload,
    onTransferProgress,
    selectApplication,
    showSaveDialog,
    downloadSftpToTempAndOpen,
  };
};
