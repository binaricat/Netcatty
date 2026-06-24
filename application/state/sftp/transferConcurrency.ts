export const DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY = 2;
export const MIN_SFTP_FILE_TRANSFER_CONCURRENCY = 1;
export const MAX_SFTP_FILE_TRANSFER_CONCURRENCY = 16;

export function resolveSftpTransferConcurrency(readStoredValue: () => number | null | undefined): number {
  const stored = readStoredValue();
  return stored != null &&
    stored >= MIN_SFTP_FILE_TRANSFER_CONCURRENCY &&
    stored <= MAX_SFTP_FILE_TRANSFER_CONCURRENCY
    ? stored
    : DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY;
}

export async function runSftpTransferWorkers<T>(
  items: T[],
  readStoredConcurrency: () => number | null | undefined,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const concurrency = resolveSftpTransferConcurrency(readStoredConcurrency);
  let nextIndex = 0;

  const runNext = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runNext(),
  );
  await Promise.all(workers);
}
