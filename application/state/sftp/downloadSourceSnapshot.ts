import type { SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models/sftp";

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

const sourceUnavailable = () => new Error("Cannot verify the current remote source before download");

/** A stale listing must never supply the size or type of a new download. */
export const resolveDownloadSourceSnapshot = async (
  statSftp: StatSftp | undefined,
  sftpId: string,
  sourcePath: string,
  encoding: SftpFilenameEncoding | undefined,
  listedSymlinkTarget?: SftpFileEntry["linkTarget"],
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
    // SFTP STAT follows links, but legacy SCP reports the link node. Its
    // listing resolves the target kind; SCP's wire header verifies file bytes.
    if (listedSymlinkTarget !== "file" && listedSymlinkTarget !== "directory") {
      throw sourceUnavailable();
    }
    return { size: undefined, isDirectory: listedSymlinkTarget === "directory" };
  }
  if (stat.type !== "file") throw sourceUnavailable();
  if (stat.sizeKnown === false) return { size: undefined, isDirectory: false };
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw sourceUnavailable();
  return { size: stat.size, isDirectory: false };
};
