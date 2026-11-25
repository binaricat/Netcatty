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

  const listDrives = useCallback(async () => {
    return await netcattyBridge.get()?.listDrives?.() ?? [];
  }, []);

  const openPath = useCallback(async (path: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openPath) throw new Error("openPath unavailable");
    return bridge.openPath(path);
  }, []);

  const cancelTransfer = useCallback(async (transferId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.cancelTransfer) return undefined;
    return bridge.cancelTransfer(transferId);
  }, []);

  const pauseTransfer = useCallback(async (transferId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.pauseTransfer) return { success: false, reason: "Pause unavailable" };
    return bridge.pauseTransfer(transferId);
  }, []);

  const resumeTransfer = useCallback(async (transferId: string) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.resumeTransfer) return { success: false, reason: "Resume unavailable" };
    return bridge.resumeTransfer(transferId);
  }, []);

  const selectApplication = useCallback(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectApplication) return undefined;
    return bridge.selectApplication();
  }, []);

  const showSaveDialog = useCallback(async (
    defaultPath: string,
    filters?: Array<{ name: string; extensions: string[] }>,
    directoryOptions?: NetcattyDialogDirectoryOptions,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.showSaveDialog) return null;
    return bridge.showSaveDialog(defaultPath, filters, directoryOptions);
  }, []);

  const selectDirectory = async (
    title?: string,
    defaultPath?: string,
    directoryOptions?: NetcattyDialogDirectoryOptions,
  ) => {
    const bridge = netcattyBridge.get();
    if (!bridge?.selectDirectory) return null;
    return bridge.selectDirectory(title, defaultPath, directoryOptions);
  };

  return {
    openSftp,
    closeSftp,
    listSftp,
    readSftp,
    readSftpBinary,
    writeSftp,
    writeSftpBinary,
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
    listDrives,
    openPath,

    cancelTransfer,
    pauseTransfer,
    resumeTransfer,
    selectApplication,
    showSaveDialog,
    selectDirectory,
  };
};
