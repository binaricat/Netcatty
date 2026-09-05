import { resolveSftpTransferConcurrency } from "../../../domain/sftpTransferConcurrency";

export {
  DEFAULT_SFTP_FILE_TRANSFER_CONCURRENCY,
  MAX_SFTP_FILE_TRANSFER_CONCURRENCY,
  MIN_SFTP_FILE_TRANSFER_CONCURRENCY,
  resolveSftpTransferConcurrency,
} from "../../../domain/sftpTransferConcurrency";

/**
 * Bounded parallel directory listings while walking a folder tree.
 * SFTP has no recursive LIST; FileZilla/WinSCP still walk one dir at a time on
 * a single control channel. We pipeline several OPENDIR/READDIR requests so
 * wide trees discover total file counts much faster without a second full scan.
 * Keep this modest - listing shares the transfer SFTP session with file I/O.
 */
export const DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY = 4;
export const MIN_SFTP_DIRECTORY_LISTING_CONCURRENCY = 1;
export const MAX_SFTP_DIRECTORY_LISTING_CONCURRENCY = 8;

/** Default on: skip size+mtime matches like rsync's generator. */
export const DEFAULT_SFTP_SKIP_UNCHANGED = true;

export function resolveSftpDirectoryListingConcurrency(
  readStoredValue?: () => number | null | undefined,
): number {
  const stored = readStoredValue?.();
  return stored != null &&
    stored >= MIN_SFTP_DIRECTORY_LISTING_CONCURRENCY &&
    stored <= MAX_SFTP_DIRECTORY_LISTING_CONCURRENCY
    ? stored
    : DEFAULT_SFTP_DIRECTORY_LISTING_CONCURRENCY;
}

export function resolveSftpSkipUnchangedEnabled(
  readStoredValue: () => boolean | null | undefined,
): boolean {
  const stored = readStoredValue();
  return stored == null ? DEFAULT_SFTP_SKIP_UNCHANGED : stored;
}

export async function runSftpTransferWorkers<T>(
  items: T[],
  readStoredConcurrency: () => number | null | undefined,
  worker: (item: T, index: number) => Promise<void>,
  options?: {
    /**
     * Called before claiming the next queue index. Folder pause must wait here
     * so a worker that just finished soft-drain cannot claim the next file
     * while the parent is still latched (claim-before-wait started new work).
     */
    beforeClaim?: () => Promise<void>;
  },
): Promise<void> {
  const concurrency = resolveSftpTransferConcurrency(readStoredConcurrency);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const runNext = async () => {
    while (!failed && nextIndex < items.length) {
      try {
        // Wait BEFORE claiming so pause does not leave a claimed-but-not-started
        // index that arms as soon as soft-drain finishes the previous file.
        if (options?.beforeClaim) {
          await options.beforeClaim();
        }
        if (failed || nextIndex >= items.length) return;
        const index = nextIndex++;
        await worker(items[index], index);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runNext(),
  );
  // Settle every started worker before propagating - Promise.all would reject
  // while siblings keep claiming files after the caller releases leases.
  await Promise.all(workers);
  if (failed) throw firstError;
}

/** Run workers over a queue with an explicit concurrency (not settings-backed). */
export async function runBoundedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options?: {
    beforeClaim?: () => Promise<void>;
  },
): Promise<void> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  if (items.length === 0) return;
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const runNext = async () => {
    while (!failed && nextIndex < items.length) {
      try {
        if (options?.beforeClaim) {
          await options.beforeClaim();
        }
        // Re-check after beforeClaim: a sibling may have failed while we waited.
        if (failed || nextIndex >= items.length) return;
        const index = nextIndex++;
        await worker(items[index], index);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
        return;
      }
    }
  };
  // Settle every started worker before propagating - Promise.all would reject
  // while siblings keep claiming directories / transferring after the caller cleans up.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  if (failed) throw firstError;
}
