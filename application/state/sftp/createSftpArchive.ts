import type {
  SftpArchiveCreationOptions,
  SftpArchiveCreationResult,
  SftpArchiveCreationTarget,
} from "../../../domain/sftpArchiveCreation";
import type { SftpPane } from "./types";
import { logger } from "../../../lib/logger";

interface CreateSftpArchiveParams {
  getPane: () => Pick<SftpPane, "id" | "connection" | "filenameEncoding">;
  target: SftpArchiveCreationTarget;
  options: SftpArchiveCreationOptions;
  bridge: Pick<NetcattyBridge, "createSftpArchive"> | undefined;
  getSftpIdForConnection?: (connectionId: string) => string | undefined;
  refresh: (paneId: string) => Promise<void>;
  t: (key: string) => string;
}

/** Bind the selected files to the pane/connection that opened the dialog. */
export async function createSftpArchiveForPane({
  getPane, target, options, bridge, getSftpIdForConnection, refresh, t,
}: CreateSftpArchiveParams): Promise<SftpArchiveCreationResult> {
  const pane = getPane();
  if (pane.id !== target.paneId || pane.connection?.id !== target.connectionId) {
    throw new Error(t("sftp.archive.connectionChanged"));
  }
  const sftpId = getSftpIdForConnection?.(target.connectionId);
  if (pane.connection.isLocal || !sftpId || !bridge?.createSftpArchive) {
    throw new Error(t("sftp.archive.unavailable"));
  }
  const result = await bridge.createSftpArchive(sftpId, options, pane.filenameEncoding);
  if (!result.success) return result;

  // A tab switch during compression must not refresh an unrelated connection.
  const current = getPane();
  if (current.id === target.paneId && current.connection?.id === target.connectionId) {
    try {
      await refresh(target.paneId);
    } catch (error) {
      // The archive has already been published. A listing failure must not
      // invite the user to repeat a successful operation (or overwrite it).
      logger.warn("[SFTP] Archive created but directory refresh failed:", error);
    }
  }
  return result;
}
