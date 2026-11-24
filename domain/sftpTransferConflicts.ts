import type { TransferTask } from "./models";

/** Statuses that still hold or may soon hold the destination path. */
export const SFTP_PATH_CONFLICT_ACTIVE_STATUSES: ReadonlySet<TransferTask["status"]> = new Set([
  "pending",
  "queued",
  "transferring",
  "pausing",
  "paused",
]);

type DestinationRef = Pick<
  TransferTask,
  "targetPath" | "targetConnectionId" | "targetHostId" | "targetConnectionKey" | "targetHostLabel"
>;

/**
 * Local filesystem destinations share one identity: Save As / downloadToLocal
 * use the `"local"` sentinel, while dual-pane transfers store an ephemeral pane
 * connection id with targetHostLabel "Local". Treat both as the same endpoint so
 * concurrent writers to one absolute path still conflict.
 */
export function isLocalTransferDestination(ref: DestinationRef): boolean {
  if (ref.targetConnectionId === "local" || ref.targetConnectionKey === "local") {
    return true;
  }
  // Dual-pane local rows: labeled Local, no remote host/key, pane connection id.
  return ref.targetHostLabel === "Local" && !ref.targetHostId && !ref.targetConnectionKey;
}

/**
 * Stable destination endpoint identity. Prefer connection key / host id so two
 * sessions to the same host still collide; fall back to connection id (covers
 * the local sentinel and single-session remotes). Local FS destinations are
 * normalized so pane id and `"local"` compare equal.
 */
export function sameTransferDestinationEndpoint(
  a: DestinationRef,
  b: DestinationRef,
): boolean {
  if (isLocalTransferDestination(a) && isLocalTransferDestination(b)) {
    return true;
  }
  if (isLocalTransferDestination(a) || isLocalTransferDestination(b)) {
    return false;
  }
  if (a.targetConnectionKey && b.targetConnectionKey) {
    return a.targetConnectionKey === b.targetConnectionKey;
  }
  if (a.targetHostId && b.targetHostId) {
    return a.targetHostId === b.targetHostId;
  }
  return a.targetConnectionId === b.targetConnectionId;
}

/**
 * Canonical destination path for conflict checks. Mirrors
 * `normalizeSftpPathForCompare` so Windows local paths with different casing or
 * separators still collide; POSIX paths stay case-sensitive aside from trailing
 * slash stripping.
 */
export function normalizeTransferTargetPathForCompare(path: string): string {
  if (/^[A-Za-z]:/.test(path)) {
    const withBackslashes = path.replace(/\//g, "\\");
    if (/^[A-Za-z]:\\?$/.test(withBackslashes)) {
      return withBackslashes.toLowerCase();
    }
    return withBackslashes.replace(/[\\]+$/, "").toLowerCase();
  }
  if (path === "/") return "/";
  return path.replace(/\/+$/, "");
}

function sameTransferTargetPath(a: string, b: string): boolean {
  return normalizeTransferTargetPathForCompare(a) === normalizeTransferTargetPathForCompare(b);
}

function isTransferTargetPathDescendant(existingPath: string, candidatePath: string): boolean {
  const existing = normalizeTransferTargetPathForCompare(existingPath);
  const candidate = normalizeTransferTargetPathForCompare(candidatePath);
  if (!existing || existing === candidate) return false;

  const separator = /^[a-z]:/.test(existing) ? "\\" : "/";
  const descendantPrefix = existing.endsWith(separator) ? existing : `${existing}${separator}`;
  return candidate.startsWith(descendantPrefix);
}

function touchesTarget(task: TransferTask, predicate: (path: string) => boolean): boolean {
  return task.packedTargetPaths ? task.packedTargetPaths.some(predicate) : predicate(task.targetPath);
}

/**
 * Find another active transfer that reserves the candidate destination. File
 * tasks reserve their exact path; directory tasks reserve their path and all
 * descendants because recursive transfer children may not exist in the task
 * list yet. Incoming directories also conflict with any active descendant already
 * writing under that tree (the reverse of an existing directory reserving
 * children). Concurrent writers (especially local .part + rename) race and
 * corrupt output; endpoint identity avoids treating identical path strings on
 * different hosts as the same destination.
 */
export function findActivePathConflict(
  tasks: readonly TransferTask[],
  candidate: Pick<TransferTask, "id"> & DestinationRef & Pick<Partial<TransferTask>, "isDirectory">,
): TransferTask | undefined {
  const conflictsAtEndpoint = (task: TransferTask) => (
    task.id !== candidate.id
    && sameTransferDestinationEndpoint(task, candidate)
    && SFTP_PATH_CONFLICT_ACTIVE_STATUSES.has(task.status)
  );

  return tasks.find((task) => (
    conflictsAtEndpoint(task)
    && touchesTarget(task, (path) => sameTransferTargetPath(path, candidate.targetPath))
  )) ?? tasks.find((task) => (
    conflictsAtEndpoint(task)
    && task.isDirectory
    && touchesTarget(task, (path) => isTransferTargetPathDescendant(path, candidate.targetPath))
  )) ?? (candidate.isDirectory
    ? tasks.find((task) => (
      conflictsAtEndpoint(task)
      && touchesTarget(task, (path) => isTransferTargetPathDescendant(candidate.targetPath, path))
    ))
    : undefined);
}

export function pathConflictMessage(existing: Pick<TransferTask, "fileName" | "status">): string {
  const label = existing.fileName || "file";
  if (existing.status === "paused") {
    return `Another transfer for "${label}" is paused. Resume or cancel it first.`;
  }
  return `Another transfer for "${label}" is already in progress.`;
}
