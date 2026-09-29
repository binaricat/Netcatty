import type { SftpFilenameEncoding } from "../../../domain/models/sftp";
import type { RemoteFile } from "../../../domain/models/workspace";
import { getFileName, getParentPath } from "./utils";

export type DownloadSourceSnapshot = {
  /** Unknown for stat-less SCP files and links; the transfer reads its wire size. */
  size: number | undefined;
  isDirectory: boolean;
};

type StatSftp = (
  sftpId: string,
  path: string,
  encoding?: SftpFilenameEncoding,
) => Promise<SftpStatResult>;
type ListSftp = (
  sftpId: string,
  path: string,
  encoding?: SftpFilenameEncoding,
) => Promise<RemoteFile[]>;

const sourceUnavailable = () => new Error("Cannot verify the current remote source before download");

/** A stale listing must never supply the size or type of a new download. */
export const resolveDownloadSourceSnapshot = async (
  statSftp: StatSftp | undefined,
  sftpId: string,
  sourcePath: string,
  encoding: SftpFilenameEncoding | undefined,
  listSftp?: ListSftp,
): Promise<DownloadSourceSnapshot> => {
  if (!statSftp) throw sourceUnavailable();

  let stat: SftpStatResult | null;
  try {
    stat = await statSftp(sftpId, sourcePath, encoding);
  } catch (cause) {
    throw new Error("Cannot verify the current remote source before download", { cause });
  }

  if (!stat) {
    throw sourceUnavailable();
  }
  if (stat.type === "directory") return { size: 0, isDirectory: true };
  if (stat.type === "symlink") {
    // SFTP STAT follows links; legacy SCP describes the link node. Re-list its
    // parent to resolve the current target kind rather than trusting the pane.
    if (!listSftp) throw sourceUnavailable();
    let entries: RemoteFile[];
    try {
      entries = await listSftp(sftpId, getParentPath(sourcePath), encoding);
    } catch (cause) {
      throw new Error("Cannot verify the current remote source before download", { cause });
    }
    const current = entries.find((entry) => entry.name === getFileName(sourcePath));
    if (current?.type !== "symlink"
      || (current.linkTarget !== "file" && current.linkTarget !== "directory")) {
      throw sourceUnavailable();
    }
    // The link's own size is never a valid file plan; SCP's wire header is.
    return { size: undefined, isDirectory: current.linkTarget === "directory" };
  }
  if (stat.type !== "file") throw sourceUnavailable();
  if (stat.sizeKnown === false) return { size: undefined, isDirectory: false };
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw sourceUnavailable();
  return { size: stat.size, isDirectory: false };
};
