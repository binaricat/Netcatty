import type { UploadResult } from "../../lib/uploadService.types";

export type ReportSftpUploadResultsOptions = {
  results: readonly UploadResult[];
  t: (key: string, params?: Record<string, string | number>) => string;
  toast: {
    success: (message: string, title?: string) => void;
    error: (message: string, title?: string) => void;
    info: (message: string, title?: string) => void;
  };
  /** Optional single-item success message override (e.g. folder name). */
  successMessage?: string;
  /** Exact remote directory selected for a terminal-drop upload. */
  targetPath?: string;
};

/**
 * Shared toast reporting for external SFTP uploads.
 * Never shows "Uploaded files: 0" as a success toast.
 */
export function reportSftpUploadResults({
  results,
  t,
  toast,
  successMessage,
  targetPath,
}: ReportSftpUploadResultsOptions): void {
  const withTargetPath = (message: string): string => (
    targetPath ? `${message} (${targetPath})` : message
  );
  if (results.some((result) => result.cancelled)) {
    toast.info(t("sftp.upload.cancelled"), "SFTP");
    return;
  }

  const failed = results.filter((result) => !result.success && !result.cancelled);
  const succeeded = results.filter((result) => result.success);

  if (failed.length > 0) {
    for (const item of failed) {
      const errorMsg = item.error ? ` - ${item.error}` : "";
      toast.error(
        `${t("sftp.error.uploadFailed")}: ${item.fileName || t("sftp.upload")}${errorMsg}`,
        "SFTP",
      );
    }
    // Also mention partial success when some files made it.
    if (succeeded.length > 0) {
      toast.info(
        withTargetPath(
          t("sftp.upload.partialSuccess", { success: succeeded.length, failed: failed.length }),
        ),
        "SFTP",
      );
    }
    return;
  }

  if (succeeded.length === 0) {
    // Empty drop / no uploadable files — not a green "success".
    toast.info(t("sftp.upload.noFiles"), "SFTP");
    return;
  }

  if (successMessage) {
    toast.success(withTargetPath(successMessage), "SFTP");
    return;
  }

  const message = succeeded.length === 1
    ? `${t("sftp.upload")}: ${succeeded[0]?.fileName ?? ""}`
    : `${t("sftp.uploadFiles")}: ${succeeded.length}`;
  toast.success(withTargetPath(message), "SFTP");
}
