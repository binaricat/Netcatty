export const DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY = 6;
export const MIN_SFTP_FILE_TRANSFER_CONCURRENCY = 1;
export const MAX_SFTP_FILE_TRANSFER_CONCURRENCY = 16;

export function resolveSftpTransferConcurrency(
  readStoredValue: () => number | null | undefined,
): number {
  const stored = readStoredValue();
  return Number.isInteger(stored) &&
    stored != null &&
    stored >= MIN_SFTP_FILE_TRANSFER_CONCURRENCY &&
    stored <= MAX_SFTP_FILE_TRANSFER_CONCURRENCY
    ? stored
    : DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY;
}
