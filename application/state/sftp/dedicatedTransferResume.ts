import { runTransferAndWaitForOwner } from "./waitForTransferOwner";
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings, TransferTask } from "../../../domain/models";
import { validateTransferResumeSource } from "../../../domain/sftpTransferCenter";
import { STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY } from "../../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../../infrastructure/persistence/localStorageAdapter";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { buildSftpHostCredentials } from "./useSftpHostCredentials";
import {
  getSftpTransferResourceKeys,
  globalSftpTransferScheduler,
  unlimitedSftpSchedulerAdmission,
} from "./globalTransferScheduler";
import { runWithTransferRetry } from "./transferRetry";
import { runSftpTransferWorkers } from "./transferConcurrency";
import { getParentPath, joinPath, joinTransferTargetPath } from "./utils";
import {
  accountSftpDirectoryEntries,
  claimSftpDirectoryVisit,
  compareDirectoryTraversalPaths,
  createDirectoryManifestAccumulator,
  createSftpDirectoryTraversalBudget,
  createDirectoryEntryIdentity,
  createEmptyDirectoryResumeCheckpoint,
  isValidDirectoryResumeCheckpoint,
  releaseSftpDirectoryVisit,
  shouldFollowSftpSymlinkDirectory,
  type SftpDirectoryTraversalBudget,
} from "../../../domain/sftpDirectoryCheckpoint";
import {
  isMissingDirectoryReplacePathError,
  promoteDirectoryReplaceStage as promoteDirectoryReplacePaths,
} from "./directoryReplacePromotion";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

export interface DedicatedResumeDeps {
  hosts: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  knownHosts?: readonly KnownHost[];
  terminalSettings?: Pick<TerminalSettings, "verifyHostKeys" | "keepaliveInterval" | "keepaliveCountMax">;
}

export interface DedicatedResumeProgress {
  transferred: number;
  total: number;
  speed: number;
  checkpointBytes?: number;
  resumeStage?: TransferTask["resumeStage"];
  downloadCheckpointBytes?: number;
  uploadCheckpointBytes?: number;
  sourceFingerprint?: string;
}

export type DedicatedResumeResult = {
  success: boolean;
  error?: string;
  /** Leave the task in attention (e.g. source changed) instead of plain failed. */
  needsAttention?: boolean;
  /** Clear checkpoint so the next resume starts this file from zero. */
  resetCheckpoint?: boolean;
};

export type DedicatedResumeOptions = {
  children?: readonly TransferTask[];
  onChildUpdate?: (child: TransferTask) => void;
  onDirectoryCheckpointUpdate?: (checkpoint: TransferTask["directoryResumeCheckpoint"]) => void;
  shouldAbort?: () => boolean;
};

/** Cap concurrent vault SSH opens across Resume All stampede. */
export const MAX_CONCURRENT_DEDICATED_SESSION_OPENS = 2;

let dedicatedOpenSlots = 0;
const dedicatedOpenWaiters: Array<() => void> = [];

export async function withDedicatedSessionOpenSlot<T>(work: () => Promise<T>): Promise<T> {
  while (dedicatedOpenSlots >= MAX_CONCURRENT_DEDICATED_SESSION_OPENS) {
    await new Promise<void>((resolve) => {
      dedicatedOpenWaiters.push(resolve);
    });
  }
  dedicatedOpenSlots += 1;
  try {
    return await work();
  } finally {
    dedicatedOpenSlots -= 1;
    const next = dedicatedOpenWaiters.shift();
    next?.();
  }
}

/** Test helper — reset open-slot state between unit tests. */
export function resetDedicatedSessionOpenGateForTests(): void {
  dedicatedOpenSlots = 0;
  dedicatedOpenWaiters.length = 0;
}

/**
 * Resolve the recorded endpoint, never a same-named replacement. Legacy tasks
 * without an id may use label/hostname only when exactly one host matches.
 */
export function resolveHostForTransferEndpoint(
  hosts: readonly Host[],
  hostId?: string,
  hostLabel?: string,
): Host | null {
  if (hostId) {
    return hosts.find((host) => host.id === hostId) ?? null;
  }
  const needle = (hostLabel || "").trim().toLowerCase();
  if (!needle) return null;
  const matches = hosts.filter((host) => {
    const label = (host.label || "").trim().toLowerCase();
    const hostname = (host.hostname || "").trim().toLowerCase();
    return label === needle || hostname === needle;
  });
  return matches.length === 1 ? matches[0] : null;
}

export type OpenTransferSftpSessionOptions = {
  /**
   * Prefer a live terminal SSH transport (borrow a lease + open SFTP channel).
   * Safe for bulk transfers when the main-process transport registry holds a
   * transfer/sftp lease: closing the terminal tab returns only the shell lease
   * and does not tear down the shared transport until this SFTP handle closes.
   */
  sourceSessionId?: string;
  /**
   * When true (default), open an independent SSH/SFTP session from vault
   * credentials. When false, try sourceSessionId first (shared transport).
   */
  dedicated?: boolean;
};

/**
 * Open a transfer-owned SFTP session.
 * Default is a dedicated vault connection for restart/resume. With
 * dedicated:false it uses the unified transport registry, preferring the
 * specified terminal transport when available and otherwise reusing/dialing by
 * endpoint without forcing a second physical SSH connection.
 */
export async function openTransferSftpSession(
  host: Host,
  deps: DedicatedResumeDeps,
  options?: OpenTransferSftpSessionOptions,
): Promise<string> {
  return withDedicatedSessionOpenSlot(async () => {
    const bridge = netcattyBridge.get();
    if (!bridge?.openSftp) throw new Error("SFTP bridge unavailable");

    const wantDedicated = options?.dedicated !== false;
    const credentials = buildSftpHostCredentials({
      host,
      hosts: [...deps.hosts],
      keys: [...deps.keys],
      identities: [...deps.identities],
      knownHosts: deps.knownHosts ? [...deps.knownHosts] : undefined,
      terminalSettings: deps.terminalSettings,
    });
    // Shared transport path: open an SFTP channel on the already-authenticated
    // terminal connection. The transport registry lease keeps the conn alive
    // after the shell tab closes until this sftpId is closed.
    if (
      !wantDedicated
      && options?.sourceSessionId
      && bridge.openSftpForSession
    ) {
      try {
        const sftpId = await bridge.openSftpForSession(options.sourceSessionId, credentials);
        if (sftpId) return sftpId;
      } catch {
        // Fall through to vault credentials.
      }
    }

    // Restart/resume owns an independent SSH dial. Normal pooled transfer opens
    // leave reuseTransport enabled so the main-process registry can reuse an
    // authenticated endpoint even when no terminal tab exists.
    const openOpts = wantDedicated
      ? { ...credentials, reuseTransport: false as const }
      : credentials;

    // The main-process auth driver owns method ordering, fallback, MFA and
    // retry. A renderer-side key-then-password retry performs a second full SSH
    // dial and can repeat interactive authentication.
    return bridge.openSftp(openOpts);
  });
}

async function closeDedicatedSftpSession(sftpId: string | undefined): Promise<void> {
  if (!sftpId) return;
  try {
    await netcattyBridge.get()?.closeSftp?.(sftpId);
  } catch {
    // Best-effort cleanup of transfer-owned sessions.
  }
}

export type TransferEndpointKind = {
  isDownload: boolean;
  isUpload: boolean;
  isRemoteToRemote: boolean;
};

/** Classify transfer endpoints for dedicated resume (local↔remote and SFTP↔SFTP). */
export function classifyDedicatedResumeEndpoints(
  task: Pick<TransferTask, "direction" | "sourceHostId" | "targetHostId" | "sourceConnectionId" | "targetConnectionId">,
): TransferEndpointKind {
  const isRemoteToRemote = task.direction === "remote-to-remote"
    || (!!task.sourceHostId && !!task.targetHostId
      && task.sourceConnectionId !== "local"
      && task.targetConnectionId !== "local");
  if (isRemoteToRemote) {
    return { isDownload: false, isUpload: false, isRemoteToRemote: true };
  }
  const isDownload = task.direction === "download"
    || (!!task.sourceHostId && !task.targetHostId)
    || (task.targetConnectionId === "local" && !!task.sourceHostId);
  const isUpload = task.direction === "upload"
    || (!!task.targetHostId && !task.sourceHostId)
    || (task.sourceConnectionId === "local" && !!task.targetHostId);
  return { isDownload, isUpload, isRemoteToRemote: false };
}

export type DirectoryResumeFilePlan = {
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  size: number;
  lastModified?: number;
  directoryEntryIndex?: number;
  directoryEntryIdentity?: string;
};

const DIRECTORY_RESUME_SYNC_BUDGET_MS = 8;
const DIRECTORY_RESUME_YIELD_CHECK_INTERVAL = 128;

function directoryResumeNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

async function yieldDirectoryResumeWork(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function indexDirectoryResumeFiles(files: DirectoryResumeFilePlan[]): Promise<DirectoryResumeFilePlan[]> {
  const sorted = [...files]
    .sort((left, right) => compareDirectoryTraversalPaths(left.relativePath, right.relativePath));
  if (sorted.length >= DIRECTORY_RESUME_YIELD_CHECK_INTERVAL) {
    await yieldDirectoryResumeWork();
  }
  const indexed = new Array<DirectoryResumeFilePlan>(sorted.length);
  let sliceStartedAt = directoryResumeNow();
  for (let directoryEntryIndex = 0; directoryEntryIndex < sorted.length; directoryEntryIndex += 1) {
    const file = sorted[directoryEntryIndex]!;
    indexed[directoryEntryIndex] = {
      ...file,
      directoryEntryIndex,
      directoryEntryIdentity: createDirectoryEntryIdentity({
        sourcePath: file.sourcePath,
        targetPath: file.targetPath,
        size: file.size,
        lastModified: file.lastModified,
      }),
    };
    if (
      directoryEntryIndex > 0
      && directoryEntryIndex % DIRECTORY_RESUME_YIELD_CHECK_INTERVAL === 0
      && directoryResumeNow() - sliceStartedAt >= DIRECTORY_RESUME_SYNC_BUDGET_MS
    ) {
      await yieldDirectoryResumeWork();
      sliceStartedAt = directoryResumeNow();
    }
  }
  return indexed;
}

export async function validateDirectoryResumeCheckpoint(
  parent: Pick<TransferTask, "directoryResumeCheckpoint">,
  planned: readonly DirectoryResumeFilePlan[],
): Promise<boolean> {
  const checkpoint = parent.directoryResumeCheckpoint;
  if (!isValidDirectoryResumeCheckpoint(checkpoint)) return false;
  if (checkpoint.coveredEntries > planned.length) return false;
  const rebuilt = checkpoint.version === 1
    ? {
      version: 1 as const,
      coveredEntries: 0,
      completedEntries: 0,
      manifestHash: "0".repeat(64),
    }
    : createEmptyDirectoryResumeCheckpoint();
  const manifest = createDirectoryManifestAccumulator(rebuilt);
  let sliceStartedAt = directoryResumeNow();
  for (let index = 0; index < checkpoint.coveredEntries; index += 1) {
    const identity = planned[index]?.directoryEntryIdentity;
    if (!identity) return false;
    manifest.append(identity);
    rebuilt.coveredEntries += 1;
    if (
      index > 0
      && index % DIRECTORY_RESUME_YIELD_CHECK_INTERVAL === 0
      && directoryResumeNow() - sliceStartedAt >= DIRECTORY_RESUME_SYNC_BUDGET_MS
    ) {
      await yieldDirectoryResumeWork();
      sliceStartedAt = directoryResumeNow();
    }
  }
  rebuilt.manifestHash = manifest.digest();
  return rebuilt.manifestHash === checkpoint.manifestHash;
}

async function migrateLegacyDirectoryResumeCheckpoint(
  checkpoint: NonNullable<TransferTask["directoryResumeCheckpoint"]>,
  planned: readonly DirectoryResumeFilePlan[],
): Promise<NonNullable<TransferTask["directoryResumeCheckpoint"]>> {
  if (checkpoint.version !== 1) return checkpoint;
  const migrated = createEmptyDirectoryResumeCheckpoint();
  const manifest = createDirectoryManifestAccumulator(migrated);
  let sliceStartedAt = directoryResumeNow();
  for (let index = 0; index < checkpoint.coveredEntries; index += 1) {
    const identity = planned[index]?.directoryEntryIdentity;
    if (!identity) throw new Error("Directory resume manifest is incomplete");
    manifest.append(identity);
    migrated.coveredEntries += 1;
    if (
      index > 0
      && index % DIRECTORY_RESUME_YIELD_CHECK_INTERVAL === 0
      && directoryResumeNow() - sliceStartedAt >= DIRECTORY_RESUME_SYNC_BUDGET_MS
    ) {
      await yieldDirectoryResumeWork();
      sliceStartedAt = directoryResumeNow();
    }
  }
  migrated.manifestHash = manifest.digest();
  migrated.completedEntries = checkpoint.completedEntries;
  return migrated;
}

/**
 * Destination root for directory resume. Replace-mode parents write under
 * `stagedTargetPath` until the full tree is ready to promote.
 */
export function resolveDirectoryResumeTargetRoot(
  parent: Pick<TransferTask, "targetPath" | "stagedTargetPath" | "replaceExistingTarget">,
): string {
  if (parent.stagedTargetPath) return parent.stagedTargetPath;
  return parent.targetPath;
}

/** Match a planned file to a persisted child by exact source+target paths. */
export function findPersistedChildForResumeFile(
  children: readonly Pick<TransferTask, "id" | "status" | "sourcePath" | "targetPath" | "checkpointBytes" | "transferredBytes" | "resumeStage" | "downloadCheckpointBytes" | "uploadCheckpointBytes" | "sourceFingerprint" | "totalBytes" | "sourceLastModified">[],
  file: Pick<DirectoryResumeFilePlan, "sourcePath" | "targetPath">,
) {
  const exact = children.find((child) =>
    child.sourcePath === file.sourcePath && child.targetPath === file.targetPath
  );
  return exact ?? null;
}

type PersistedResumeChild = Pick<
  TransferTask,
  "id" | "status" | "sourcePath" | "targetPath" | "checkpointBytes" | "transferredBytes"
    | "resumeStage" | "downloadCheckpointBytes" | "uploadCheckpointBytes" | "sourceFingerprint"
    | "totalBytes" | "sourceLastModified"
>;

/** Build once per directory resume; every planned-file match is then O(1). */
export function createPersistedResumeChildLookup(
  children: readonly PersistedResumeChild[],
): (file: Pick<DirectoryResumeFilePlan, "sourcePath" | "targetPath">) => PersistedResumeChild | null {
  const exactBySource = new Map<string, Map<string, PersistedResumeChild>>();
  for (const child of children) {
    let targets = exactBySource.get(child.sourcePath);
    if (!targets) {
      targets = new Map();
      exactBySource.set(child.sourcePath, targets);
    }
    if (!targets.has(child.targetPath)) targets.set(child.targetPath, child);
  }
  return (file) => exactBySource.get(file.sourcePath)?.get(file.targetPath)
    ?? null;
}

export function shouldSkipCompletedResumeChild(
  child: Pick<TransferTask, "status"> | null | undefined,
): boolean {
  return child?.status === "completed";
}

/** Classify validateTransferResumeSource failures for UX (retry from 0 vs hard fail). */
export function classifyResumeSourceValidationError(message: string | null | undefined): {
  kind: "ok" | "restart" | "modified" | "fatal";
  message: string | null;
} {
  if (!message) return { kind: "ok", message: null };
  if (/beyond the current source size|size changed/i.test(message)) {
    return { kind: "restart", message };
  }
  if (/modified while the transfer was paused/i.test(message)) {
    return { kind: "modified", message };
  }
  return { kind: "fatal", message };
}

/**
 * Resume a transfer by opening dedicated SFTP session(s) (not tied to any UI
 * panel). Used after app restart or when the original browse connection is gone.
 *
 * - Single files: stream resume from checkpoint
 * - Directories: re-walk tree, skip completed children, concurrent file resume
 * - SFTP↔SFTP: open source + target dedicated sessions
 */
export async function resumeTransferWithDedicatedSession(
  task: TransferTask,
  deps: DedicatedResumeDeps,
  onProgress?: (progress: DedicatedResumeProgress) => void,
  options?: DedicatedResumeOptions,
): Promise<DedicatedResumeResult> {
  if (task.isDirectory) {
    return resumeDirectoryWithDedicatedSession(task, deps, onProgress, options);
  }
  return resumeSingleFileWithDedicatedSession(task, deps, onProgress, options?.shouldAbort);
}

type ResolvedEndpoints = {
  isDownload: boolean;
  isUpload: boolean;
  isRemoteToRemote: boolean;
  sourceHost: Host | null;
  targetHost: Host | null;
  /** Live terminal/SFTP session to borrow when vault/ephemeral host is missing. */
  sourceSessionId?: string;
  targetSessionId?: string;
  resourceKeys: string[];
};

/**
 * True for live terminal/SSH session ids that openSftpForSession can resolve.
 * SFTP pane connection ids are `left-<uuid>` / `right-<uuid>` (createSftpConnectionId)
 * and must not be passed to openSftpForSession.
 */
export function isUsableTransferSessionId(sessionId: string | undefined): sessionId is string {
  if (!sessionId || sessionId === "local" || sessionId === "agent") return false;
  if (/^(left|right)-/i.test(sessionId)) return false;
  return true;
}

function missingHostError(label: string): string {
  return `Cannot find host "${label}" in your vault. Re-add the host or start a new transfer.`;
}

/**
 * Resolve remote endpoints for hard reconnect.
 *
 * Prefer vault/ephemeral host credentials **and** always attach any still-live
 * terminal/SFTP connection ids so open can borrow the shared SSH transport
 * instead of forcing a second full dial. When the host is missing entirely
 * (quick-connect without save), session id alone is enough to reopen a channel.
 */
export function resolveResumeHosts(
  task: TransferTask,
  deps: DedicatedResumeDeps,
): { ok: true; endpoints: ResolvedEndpoints } | { ok: false; error: string } {
  const kind = classifyDedicatedResumeEndpoints(task);
  // Prefer live sessions even when the host is known — hard resume should
  // reuse the open terminal transport (openSftpForSession / parked registry).
  const liveSourceSessionId = isUsableTransferSessionId(task.sourceConnectionId)
    ? task.sourceConnectionId
    : undefined;
  const liveTargetSessionId = isUsableTransferSessionId(task.targetConnectionId)
    ? task.targetConnectionId
    : undefined;

  if (kind.isRemoteToRemote) {
    const sourceHost = resolveHostForTransferEndpoint(deps.hosts, task.sourceHostId, task.sourceHostLabel);
    const targetHost = resolveHostForTransferEndpoint(deps.hosts, task.targetHostId, task.targetHostLabel);
    if ((!sourceHost && !liveSourceSessionId) || (!targetHost && !liveTargetSessionId)) {
      const missing = !sourceHost && !liveSourceSessionId
        ? (task.sourceHostLabel || task.sourceHostId || "source")
        : (task.targetHostLabel || task.targetHostId || "target");
      return { ok: false, error: missingHostError(missing) };
    }
    return {
      ok: true,
      endpoints: {
        ...kind,
        sourceHost,
        targetHost,
        sourceSessionId: liveSourceSessionId,
        targetSessionId: liveTargetSessionId,
        resourceKeys: getSftpTransferResourceKeys({
          sourceHostId: sourceHost?.id ?? task.sourceHostId,
          targetHostId: targetHost?.id ?? task.targetHostId,
        }),
      },
    };
  }

  if (!kind.isDownload && !kind.isUpload) {
    return {
      ok: false,
      error: "Unsupported transfer endpoints for dedicated resume.",
    };
  }

  const remoteHost = kind.isDownload
    ? resolveHostForTransferEndpoint(deps.hosts, task.sourceHostId, task.sourceHostLabel)
    : resolveHostForTransferEndpoint(deps.hosts, task.targetHostId, task.targetHostLabel);
  const remoteSessionId = kind.isDownload ? liveSourceSessionId : liveTargetSessionId;

  if (!remoteHost && !remoteSessionId) {
    const label = kind.isDownload
      ? (task.sourceHostLabel || task.sourceHostId || "source")
      : (task.targetHostLabel || task.targetHostId || "target");
    return { ok: false, error: missingHostError(label) };
  }

  return {
    ok: true,
    endpoints: {
      ...kind,
      sourceHost: kind.isDownload ? remoteHost : null,
      targetHost: kind.isUpload ? remoteHost : null,
      sourceSessionId: kind.isDownload ? remoteSessionId : undefined,
      targetSessionId: kind.isUpload ? remoteSessionId : undefined,
      resourceKeys: getSftpTransferResourceKeys({
        sourceHostId: kind.isDownload ? (remoteHost?.id ?? task.sourceHostId) : undefined,
        targetHostId: kind.isUpload ? (remoteHost?.id ?? task.targetHostId) : undefined,
      }),
    },
  };
}

async function openSessionBackedSftp(sessionId: string): Promise<string> {
  const bridge = netcattyBridge.get();
  if (!bridge?.openSftpForSession) {
    throw new Error("Session-backed SFTP open is unavailable");
  }
  const sftpId = await bridge.openSftpForSession(sessionId);
  if (!sftpId) throw new Error("Could not open SFTP on the existing server session");
  return sftpId;
}

/**
 * Open a hard-reconnect SFTP channel the same way the transfer pool does:
 * prefer a live terminal session, otherwise open with transport reuse so we
 * attach to a parked/shared SSH conn instead of a cold dedicated dial.
 */
async function openRemoteEndpoint(
  host: Host | null,
  sessionId: string | undefined,
  deps: DedicatedResumeDeps,
): Promise<string> {
  if (host) {
    return openTransferSftpSession(host, deps, {
      dedicated: false,
      sourceSessionId: sessionId,
    });
  }
  if (sessionId) return openSessionBackedSftp(sessionId);
  throw new Error("No remote host or session for dedicated resume");
}

async function openEndpointSessions(
  endpoints: ResolvedEndpoints,
  deps: DedicatedResumeDeps,
): Promise<{ sourceSftpId?: string; targetSftpId?: string }> {
  if (endpoints.isRemoteToRemote) {
    // Open sequentially under the open-slot gate so we never hold 2×N dials.
    const sourceSftpId = await openRemoteEndpoint(
      endpoints.sourceHost,
      endpoints.sourceSessionId,
      deps,
    );
    try {
      const targetSftpId = await openRemoteEndpoint(
        endpoints.targetHost,
        endpoints.targetSessionId,
        deps,
      );
      return { sourceSftpId, targetSftpId };
    } catch (error) {
      await closeDedicatedSftpSession(sourceSftpId);
      throw error;
    }
  }
  if (endpoints.isDownload) {
    return {
      sourceSftpId: await openRemoteEndpoint(
        endpoints.sourceHost,
        endpoints.sourceSessionId,
        deps,
      ),
    };
  }
  if (endpoints.isUpload) {
    return {
      targetSftpId: await openRemoteEndpoint(
        endpoints.targetHost,
        endpoints.targetSessionId,
        deps,
      ),
    };
  }
  throw new Error("No remote host for dedicated resume");
}

async function resumeSingleFileWithDedicatedSession(
  task: TransferTask,
  deps: DedicatedResumeDeps,
  onProgress?: (progress: DedicatedResumeProgress) => void,
  shouldAbort?: () => boolean,
): Promise<DedicatedResumeResult> {
  const bridge = netcattyBridge.get();
  if (!bridge?.startStreamTransfer) {
    return { success: false, error: "Transfer bridge unavailable" };
  }

  const resolved = resolveResumeHosts(task, deps);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { endpoints } = resolved;

  let sourceSftpId: string | undefined;
  let targetSftpId: string | undefined;
  try {
    const result = await globalSftpTransferScheduler.run(
      "dedicated-resume",
      task.id,
      endpoints.resourceKeys,
      // Folder concurrency is for in-folder fan-out only. Dedicated reconnect of
      // a single top-level task must not wait behind that host admission cap.
      unlimitedSftpSchedulerAdmission,
      async () => {
        if (shouldAbort?.()) throw new Error("Transfer cancelled");
        await runWithTransferRetry(async (attempt) => {
          if (shouldAbort?.()) throw new Error("Transfer cancelled");
          if (attempt > 0) {
            await closeDedicatedSftpSession(sourceSftpId);
            await closeDedicatedSftpSession(targetSftpId);
            sourceSftpId = undefined;
            targetSftpId = undefined;
          }
          if (!sourceSftpId && !targetSftpId) {
            const opened = await openEndpointSessions(endpoints, deps);
            sourceSftpId = opened.sourceSftpId;
            targetSftpId = opened.targetSftpId;
          }

          const sourceType = endpoints.isUpload ? "local" as const : "sftp" as const;
          const targetType = endpoints.isDownload ? "local" as const : "sftp" as const;

          const sourceStat = sourceType === "sftp" && sourceSftpId
            ? await bridge.statSftp?.(sourceSftpId, task.sourcePath, "auto")
            : sourceType === "local"
              ? await bridge.statLocal?.(task.sourcePath)
              : null;
          if (!sourceStat) throw new Error("Source is unavailable");
          {
            // Remote download sources may grow append-only (live logs); keep the
            // planned snapshot size and existing checkpoint instead of restarting.
            const allowSourceGrowth = sourceType === "sftp";
            const validationError = validateTransferResumeSource(task, {
              size: sourceStat.size,
              lastModified: sourceStat.lastModified,
            }, { allowSourceGrowth });
            const classified = classifyResumeSourceValidationError(validationError);
            if (classified.kind === "modified") {
              const err = new Error(classified.message || validationError || "Source modified");
              (err as Error & { dedicatedAttention?: boolean; resetCheckpoint?: boolean }).dedicatedAttention = true;
              (err as Error & { resetCheckpoint?: boolean }).resetCheckpoint = true;
              throw err;
            }
            if (classified.kind === "restart") {
              // Source shrunk/grew — restart this file from byte 0.
              task = { ...task, checkpointBytes: 0, transferredBytes: 0, totalBytes: sourceStat.size };
            } else if (classified.kind === "fatal") {
              throw new Error(classified.message || validationError || "Resume validation failed");
            }
          }

          const streamResult = await bridge.startStreamTransfer!({
            transferId: task.id,
            sourcePath: task.sourcePath,
            targetPath: task.targetPath,
            sourceType,
            targetType,
            sourceSftpId,
            targetSftpId,
            sourceHostId: endpoints.sourceHost?.id,
            targetHostId: endpoints.targetHost?.id,
            totalBytes: Number.isFinite(task.totalBytes)
              ? task.totalBytes
              : undefined,
            resumable: task.resumable !== false,
            checkpointBytes: task.checkpointBytes ?? task.transferredBytes ?? 0,
            resumeStage: task.resumeStage,
            downloadCheckpointBytes: task.downloadCheckpointBytes,
            uploadCheckpointBytes: task.uploadCheckpointBytes,
            sourceFingerprint: task.sourceFingerprint,
            skipAdmission: true,
          });

          if (streamResult?.superseded === true) {
            // Live same-id owner still running; wait for terminal events only.
            for (;;) {
              if (shouldAbort?.()) throw new Error("Transfer cancelled");
              const latest = sftpTransferCenterStore.getTask(task.id);
              const status = latest?.status;
              if (status === "completed") break;
              if (status === "failed") throw new Error(latest?.error || "Transfer failed");
              if (status === "cancelled") throw new Error("Transfer cancelled");
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } else if (streamResult?.error || streamResult?.cancelled) {
            throw new Error(streamResult.error || "Transfer cancelled");
          }
        }, { retries: 1, delayMs: 600 });
        return { transferId: task.id };
      },
    );

    if (result?.error) {
      throw new Error(result.error);
    }
    return { success: true };
  } catch (error) {
    const err = error as Error & { dedicatedAttention?: boolean; resetCheckpoint?: boolean };
    return {
      success: false,
      error: err instanceof Error ? err.message : String(error),
      needsAttention: !!err.dedicatedAttention,
      resetCheckpoint: !!err.resetCheckpoint,
    };
  } finally {
    await closeDedicatedSftpSession(sourceSftpId);
    await closeDedicatedSftpSession(targetSftpId);
  }
}

type DirectoryResumeTraversal = {
  files: DirectoryResumeFilePlan[];
  directoryRelativePaths: string[];
};

async function listRemoteFilesRecursive(
  sftpId: string,
  rootPath: string,
  relativePrefix = "",
  followSymlinkDirectories = false,
  symlinkDepth = 0,
  shouldAbort?: () => boolean,
  traversalBudget?: SftpDirectoryTraversalBudget,
): Promise<DirectoryResumeTraversal> {
  if (shouldAbort?.()) throw new Error("Transfer cancelled");
  const bridge = netcattyBridge.get();
  if (!bridge?.listSftp) throw new Error("SFTP list unavailable");
  const traversal = traversalBudget ?? createSftpDirectoryTraversalBudget();
  const canonicalPath = await bridge.realpathSftp?.(sftpId, rootPath, "auto")
    .catch(() => rootPath) ?? rootPath;
  const claimedCanonicalPath = claimSftpDirectoryVisit(traversal, canonicalPath);
  if (!claimedCanonicalPath) {
    return { files: [], directoryRelativePaths: [] };
  }
  try {
    const entries = (await bridge.listSftp(sftpId, rootPath, "auto"))
      .filter((entry) => entry?.name && entry.name !== "." && entry.name !== "..");
    accountSftpDirectoryEntries(traversal, entries.length);
    if (shouldAbort?.()) throw new Error("Transfer cancelled");
    const files: DirectoryResumeFilePlan[] = [];
    const directoryRelativePaths: string[] = [];
    for (const entry of entries) {
      if (shouldAbort?.()) throw new Error("Transfer cancelled");
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const fullPath = joinPath(rootPath, entry.name);
      const isDirectory = entry.type === "directory";
      const isFollowedSymlinkDirectory = followSymlinkDirectories
        && entry.type === "symlink"
        && entry.linkTarget === "directory"
        && shouldFollowSftpSymlinkDirectory(symlinkDepth);
      if (isDirectory || isFollowedSymlinkDirectory) {
        directoryRelativePaths.push(relativePath);
        const nested = await listRemoteFilesRecursive(
          sftpId,
          fullPath,
          relativePath,
          followSymlinkDirectories,
          isFollowedSymlinkDirectory ? symlinkDepth + 1 : symlinkDepth,
          shouldAbort,
          traversal,
        );
        for (const nestedFile of nested.files) files.push(nestedFile);
        for (const nestedDirectory of nested.directoryRelativePaths) {
          directoryRelativePaths.push(nestedDirectory);
        }
        continue;
      }
      if (entry.type === "directory") continue;
      const sizeRaw = entry.size as unknown;
      const size = typeof sizeRaw === "number"
        ? sizeRaw
        : Number.parseInt(String(sizeRaw ?? "0"), 10) || 0;
      const mtimeRaw = entry.lastModified as unknown;
      const lastModified = typeof mtimeRaw === "number"
        ? mtimeRaw
        : (Number.parseInt(String(mtimeRaw ?? ""), 10) || undefined);
      files.push({
        relativePath,
        sourcePath: fullPath,
        targetPath: "",
        size,
        lastModified,
      });
    }
    return { files, directoryRelativePaths };
  } finally {
    releaseSftpDirectoryVisit(traversal, claimedCanonicalPath);
  }
}

function normalizeLocalTreeRelativePath(sourceRoot: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const rootName = sourceRoot.replace(/\\/g, "/").replace(/\/+$/g, "").split("/").pop() ?? "";
  if (!rootName) return normalized;
  if (normalized === rootName) return "";
  return normalized.startsWith(`${rootName}/`) ? normalized.slice(rootName.length + 1) : normalized;
}

async function collectDirectoryResumeFiles(
  parent: TransferTask,
  endpoints: ResolvedEndpoints,
  sourceSftpId: string | undefined,
  shouldAbort?: () => boolean,
): Promise<{ files: DirectoryResumeFilePlan[]; directoryTargetPaths: string[] }> {
  const bridge = netcattyBridge.get();
  const destRoot = resolveDirectoryResumeTargetRoot(parent);
  if (shouldAbort?.()) throw new Error("Transfer cancelled");

  // Upload: local source tree.
  if (endpoints.isUpload) {
    if (!bridge?.listLocalTree) {
      throw new Error("Local folder listing is unavailable for upload resume");
    }
    const localEntries = await bridge.listLocalTree(parent.sourcePath);
    if (shouldAbort?.()) throw new Error("Transfer cancelled");
    const normalizedEntries = localEntries.map((entry) => ({
      ...entry,
      normalizedRelativePath: normalizeLocalTreeRelativePath(parent.sourcePath, entry.relativePath),
    }));
    const files = await indexDirectoryResumeFiles(normalizedEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        relativePath: entry.normalizedRelativePath,
        sourcePath: entry.localPath,
        targetPath: joinTransferTargetPath(destRoot, entry.normalizedRelativePath),
        size: entry.size,
        lastModified: entry.lastModified,
      })));
    return {
      files,
      directoryTargetPaths: normalizedEntries
        .filter((entry) => entry.type === "directory" && !!entry.normalizedRelativePath)
        .map((entry) => joinTransferTargetPath(destRoot, entry.normalizedRelativePath)),
    };
  }

  // Download or remote-to-remote: list remote source.
  if (!sourceSftpId) throw new Error("Source SFTP session missing for directory resume");
  const remote = await listRemoteFilesRecursive(
    sourceSftpId,
    parent.sourcePath,
    "",
    endpoints.isDownload,
    0,
    shouldAbort,
  );
  const files = await indexDirectoryResumeFiles(remote.files.map((file) => ({
      ...file,
      targetPath: joinTransferTargetPath(destRoot, file.relativePath),
    })));
  return {
    files,
    directoryTargetPaths: remote.directoryRelativePaths.map((relativePath) => (
      joinTransferTargetPath(destRoot, relativePath)
    )),
  };
}

/** Atomically promote a replace-mode staged directory to the final target path. */
function expectedDirectoryReplaceStage(parent: Pick<TransferTask, "id" | "targetPath">): string {
  const safeId = String(parent.id).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${parent.targetPath}.netcatty-${safeId}.part`;
}

function assertSafeDirectoryReplaceStage(parent: TransferTask): void {
  if (
    parent.stagedTargetPath
    && parent.stagedTargetPath !== expectedDirectoryReplaceStage(parent)
  ) {
    throw new Error("Unsafe replacement stage path in saved transfer history");
  }
}

async function promoteDirectoryReplaceStage(
  parent: TransferTask,
  endpoints: ResolvedEndpoints,
  targetSftpId: string | undefined,
): Promise<void> {
  const staged = parent.stagedTargetPath;
  if (!staged || staged === parent.targetPath) return;
  assertSafeDirectoryReplaceStage(parent);
  const bridge = netcattyBridge.get();
  if (!bridge) throw new Error("Transfer bridge unavailable");
  const safeId = String(parent.id).replace(/[^A-Za-z0-9_-]/g, "_");
  const backupPath = `${parent.targetPath}.netcatty-${safeId}.backup`;
  if (endpoints.isDownload) {
    if (!bridge.statLocal || !bridge.renameLocalFile || !bridge.deleteLocalFile) {
      throw new Error("Local directory replacement is unavailable");
    }
    await promoteDirectoryReplacePaths({
      targetPath: parent.targetPath,
      stagedPath: staged,
      backupPath,
      statPath: bridge.statLocal,
      renamePath: bridge.renameLocalFile,
      deletePath: bridge.deleteLocalFile,
    });
    return;
  }
  if (!targetSftpId) throw new Error("Target SFTP session missing for directory promote");
  if (!bridge.statSftp || !bridge.renameSftp || !bridge.deleteSftp) {
    throw new Error("Remote directory replacement is unavailable");
  }
  await promoteDirectoryReplacePaths({
    targetPath: parent.targetPath,
    stagedPath: staged,
    backupPath,
    statPath: (candidate) => bridge.statSftp!(targetSftpId, candidate, "auto"),
    renamePath: (source, target) => bridge.renameSftp!(targetSftpId, source, target, "auto"),
    deletePath: (candidate) => bridge.deleteSftp!(targetSftpId, candidate, "auto"),
  });
}

async function ensureLocalDir(dirPath: string): Promise<void> {
  if (!dirPath) return;
  const mkdirLocal = netcattyBridge.get()?.mkdirLocal;
  if (!mkdirLocal) throw new Error("Local directory creation is unavailable");
  await mkdirLocal(dirPath);
}

async function ensureRemoteDir(sftpId: string, dirPath: string): Promise<void> {
  if (!dirPath || dirPath === "/") return;
  const mkdirSftp = netcattyBridge.get()?.mkdirSftp;
  if (!mkdirSftp) throw new Error("Remote directory creation is unavailable");
  await mkdirSftp(sftpId, dirPath, "auto");
}

function isMissingTransferPathError(error: unknown): boolean {
  return isMissingDirectoryReplacePathError(error);
}

async function resetDirectoryReplaceStage(
  parent: TransferTask,
  endpoints: ResolvedEndpoints,
  targetSftpId: string | undefined,
): Promise<void> {
  const staged = parent.stagedTargetPath;
  if (!staged || staged === parent.targetPath) return;
  assertSafeDirectoryReplaceStage(parent);
  const bridge = netcattyBridge.get();
  if (!bridge) throw new Error("Transfer bridge unavailable");

  try {
    if (endpoints.isDownload) {
      if (!bridge.deleteLocalFile) throw new Error("Local directory replacement is unavailable");
      if (bridge.statLocal && !await bridge.statLocal(staged)) return;
      await bridge.deleteLocalFile(staged);
      return;
    }
    if (!targetSftpId || !bridge.deleteSftp) {
      throw new Error("Remote directory replacement is unavailable");
    }
    if (bridge.statSftp && !await bridge.statSftp(targetSftpId, staged, "auto")) return;
    await bridge.deleteSftp(targetSftpId, staged, "auto");
  } catch (error) {
    if (!isMissingTransferPathError(error)) throw error;
  }
}

async function resumeDirectoryWithDedicatedSession(
  parent: TransferTask,
  deps: DedicatedResumeDeps,
  onProgress?: (progress: DedicatedResumeProgress) => void,
  options?: DedicatedResumeOptions,
): Promise<DedicatedResumeResult> {
  // Fresh recovery authorizes only pauses already present at its entry. Keep
  // row references so a newer cross-window pause invalidates that permission.
  const pausedAtResume = new Map(sftpTransferCenterStore.getSnapshot().tasks
    .filter((child) => child.parentTaskId === parent.id && child.status === "paused")
    .map((child) => [child.id, child]));
  const bridge = netcattyBridge.get();
  if (!bridge?.startStreamTransfer) {
    return { success: false, error: "Transfer bridge unavailable" };
  }

  const resolved = resolveResumeHosts(parent, deps);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { endpoints } = resolved;

  const existingChildren = options?.children ?? [];
  let sourceSftpId: string | undefined;
  let targetSftpId: string | undefined;
  let completedCount = existingChildren.filter((child) => child.status === "completed").length;
  let failedCount = 0;
  let attentionCount = 0;
  let totalFiles = Math.max(parent.totalBytes, existingChildren.length, 0);

  const bumpParentProgress = (speed = 0) => {
    onProgress?.({
      transferred: completedCount,
      total: totalFiles,
      speed,
      checkpointBytes: completedCount,
    });
  };

  try {
    const result = await globalSftpTransferScheduler.run(
      "dedicated-resume",
      parent.id,
      endpoints.resourceKeys,
      // Parent walk admits freely; per-file fan-out still uses folder concurrency.
      unlimitedSftpSchedulerAdmission,
      async () => {
        if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");
        const opened = await openEndpointSessions(endpoints, deps);
        sourceSftpId = opened.sourceSftpId;
        targetSftpId = opened.targetSftpId;

        const traversal = await collectDirectoryResumeFiles(
          parent,
          endpoints,
          sourceSftpId,
          options?.shouldAbort,
        );
        const planned = traversal.files;
        totalFiles = planned.length;
        const hasCompactCheckpoint = isValidDirectoryResumeCheckpoint(parent.directoryResumeCheckpoint);
        // Compact identities keep size+mtime so a rewrite/truncate fails closed.
        // Append-only growth of an already-covered remote file invalidates the
        // prefix and retransfers those entries — safer than path-only proofs.
        const compactCheckpointValid = hasCompactCheckpoint
          && await validateDirectoryResumeCheckpoint(parent, planned);
        if (
          compactCheckpointValid
          && parent.directoryResumeCheckpoint?.version === 1
          && !parent.stagedTargetPath
        ) {
          const migrated = await migrateLegacyDirectoryResumeCheckpoint(
            parent.directoryResumeCheckpoint,
            planned,
          );
          parent = { ...parent, directoryResumeCheckpoint: migrated };
          options?.onDirectoryCheckpointUpdate?.(migrated);
        }
        // File checkpoints intentionally do not persist an unbounded directory
        // path list. Consequently they cannot prove that an empty directory was
        // not deleted at the source. Rebuild every interrupted replace stage so
        // promotion is an exact snapshot; ordinary copy/resume still reuses its
        // compact file checkpoint.
        const resetReplaceStage = !!parent.stagedTargetPath;
        const reusableCompactCheckpoint = compactCheckpointValid && !resetReplaceStage;
        if ((hasCompactCheckpoint && !compactCheckpointValid) || resetReplaceStage) {
          // Fail closed: a changed/reordered source invalidates the whole compact
          // prefix. Persist the reset before retransferring so another restart
          // cannot reuse stale completion state.
          options?.onDirectoryCheckpointUpdate?.(undefined);
        }
        if (resetReplaceStage) {
          // A stage is an exact replacement snapshot. Without a valid manifest,
          // retained files in it cannot be distinguished from files deleted at
          // the source since the interrupted attempt, so rebuild it from empty.
          await resetDirectoryReplaceStage(parent, endpoints, targetSftpId);
        }
        const destRoot = resolveDirectoryResumeTargetRoot(parent);
        if (endpoints.isDownload) await ensureLocalDir(destRoot);
        if (targetSftpId) await ensureRemoteDir(targetSftpId, destRoot);
        for (const directoryPath of traversal.directoryTargetPaths) {
          if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");
          if (endpoints.isDownload) await ensureLocalDir(directoryPath);
          else if (targetSftpId) await ensureRemoteDir(targetSftpId, directoryPath);
        }
        const compactedCompleted = reusableCompactCheckpoint
          ? parent.directoryResumeCheckpoint!.completedEntries
          : 0;
        const retainedCompleted = !resetReplaceStage && (!hasCompactCheckpoint || compactCheckpointValid)
          ? existingChildren.filter((child) => child.status === "completed").length
          : 0;
        completedCount = compactedCompleted + retainedCompleted;
        bumpParentProgress(0);

        const findPersistedChild = createPersistedResumeChildLookup(existingChildren);
        const pending = planned.filter((file) => {
          const persisted = findPersistedChild(file);
          if (
            shouldSkipCompletedResumeChild(persisted)
            && !resetReplaceStage
            && (!hasCompactCheckpoint || compactCheckpointValid)
          ) return false;
          return !(
            reusableCompactCheckpoint
            && (file.directoryEntryIndex ?? Number.MAX_SAFE_INTEGER)
              < parent.directoryResumeCheckpoint!.coveredEntries
            && !persisted
          );
        });

        await runSftpTransferWorkers(
          pending,
          () => localStorageAdapter.readNumber(STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY),
          async (file) => {
            if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");

            const persisted = findPersistedChild(file);
            if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");

            const childId = persisted?.id ?? crypto.randomUUID();
            const resetPersistedCheckpoint = resetReplaceStage
              || (hasCompactCheckpoint && !compactCheckpointValid);
            // Prefer the original planned snapshot size for interrupted download
            // children. Fresh traversal `file.size` may already include appends
            // (live logs); re-planning to the grown size breaks growth-aware
            // resume validation and restarts the file incorrectly.
            const plannedTotalBytes = !resetPersistedCheckpoint
              && endpoints.isDownload
              && Number.isFinite(persisted?.totalBytes)
              ? Math.max(0, Number(persisted?.totalBytes) || 0)
              : (file.size || persisted?.totalBytes || 0);
            let childBase: TransferTask = {
              ...parent,
              ...persisted,
              id: childId,
              fileName: file.relativePath.split("/").pop() || file.relativePath,
              originalFileName: file.relativePath.split("/").pop() || file.relativePath,
              sourcePath: file.sourcePath,
              targetPath: file.targetPath,
              parentTaskId: parent.id,
              isDirectory: false,
              progressMode: "bytes",
              ownerId: "dedicated-resume",
              status: "transferring",
              totalBytes: plannedTotalBytes,
              transferredBytes: resetPersistedCheckpoint
                ? 0
                : (persisted?.checkpointBytes ?? persisted?.transferredBytes ?? 0),
              speed: 0,
              startTime: persisted?.startTime ?? Date.now(),
              endTime: undefined,
              error: undefined,
              reconnectRequired: false,
              phase: "transferring",
              resumable: parent.resumable !== false,
              checkpointBytes: resetPersistedCheckpoint
                ? 0
                : (persisted?.checkpointBytes ?? persisted?.transferredBytes ?? 0),
              resumeStage: resetPersistedCheckpoint ? undefined : persisted?.resumeStage,
              downloadCheckpointBytes: resetPersistedCheckpoint ? undefined : persisted?.downloadCheckpointBytes,
              uploadCheckpointBytes: resetPersistedCheckpoint ? undefined : persisted?.uploadCheckpointBytes,
              sourceFingerprint: resetPersistedCheckpoint ? undefined : persisted?.sourceFingerprint,
              sourceLastModified: resetPersistedCheckpoint
                ? file.lastModified
                : (persisted?.sourceLastModified ?? file.lastModified),
              directoryEntryIndex: file.directoryEntryIndex,
              directoryEntryIdentity: file.directoryEntryIdentity,
              conflict: undefined,
            };

            if (endpoints.isDownload) {
              await ensureLocalDir(getParentPath(file.targetPath));
            }
            if (targetSftpId) await ensureRemoteDir(targetSftpId, getParentPath(file.targetPath));

            try {
              if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");

              const sourceType = endpoints.isUpload ? "local" as const : "sftp" as const;
              const targetType = endpoints.isDownload ? "local" as const : "sftp" as const;

              const sourceStat = sourceType === "sftp" && sourceSftpId
                ? await bridge.statSftp?.(sourceSftpId, file.sourcePath, "auto")
                : sourceType === "local"
                  ? await bridge.statLocal?.(file.sourcePath)
                  : null;
              if (!sourceStat) {
                throw new Error("Source is unavailable");
              }
              const allowSourceGrowth = sourceType === "sftp";
              const validationError = validateTransferResumeSource(childBase, {
                size: sourceStat.size,
                lastModified: sourceStat.lastModified,
              }, { allowSourceGrowth });
              const classified = classifyResumeSourceValidationError(validationError);
              if (classified.kind === "restart") {
                childBase = {
                  ...childBase,
                  checkpointBytes: 0,
                  transferredBytes: 0,
                  totalBytes: sourceStat.size,
                  sourceLastModified: sourceStat.lastModified,
                };
              } else if (classified.kind === "modified") {
                attentionCount += 1;
                options?.onChildUpdate?.({
                  ...childBase,
                  status: "attention",
                  error: classified.message || validationError || "Source was modified",
                  speed: 0,
                  reconnectRequired: false,
                  phase: undefined,
                  retryable: true,
                });
                return;
              } else if (classified.kind === "fatal") {
                throw new Error(classified.message || validationError || "Resume validation failed");
              } else {
                // Keep the planned snapshot size for growing remote downloads so
                // we do not re-plan the whole file mid-resume. Preserve explicit
                // zero-byte plans (`||` would incorrectly promote to grown size).
                const plannedBytes = Number(childBase.totalBytes);
                const hasPlannedBytes = Number.isFinite(plannedBytes) && plannedBytes >= 0;
                childBase = {
                  ...childBase,
                  totalBytes: allowSourceGrowth
                    ? (hasPlannedBytes ? plannedBytes : sourceStat.size)
                    : (sourceStat.size || childBase.totalBytes),
                  sourceLastModified: allowSourceGrowth
                    && hasPlannedBytes
                    && sourceStat.size > plannedBytes
                    ? (childBase.sourceLastModified ?? sourceStat.lastModified)
                    : (sourceStat.lastModified ?? childBase.sourceLastModified),
                };
              }

              // Re-check abort after async stat before inserting a transferring child.
              if (options?.shouldAbort?.()) throw new Error("Transfer cancelled");
              options?.onChildUpdate?.(childBase);

              const streamResult = await runTransferAndWaitForOwner(childBase, () => bridge.startStreamTransfer!({
                transferId: childId,
                // Lifecycle events must carry the current identity even while
                // large-history renderer child updates remain batched.
                parentTaskId: childBase.parentTaskId,
                directoryEntryIndex: childBase.directoryEntryIndex,
                directoryEntryIdentity: childBase.directoryEntryIdentity,
                sourcePath: file.sourcePath,
                targetPath: file.targetPath,
                sourceType,
                targetType,
                sourceSftpId,
                targetSftpId,
                sourceHostId: endpoints.sourceHost?.id,
                targetHostId: endpoints.targetHost?.id,
                totalBytes: Number.isFinite(childBase.totalBytes)
                  ? childBase.totalBytes
                  : (file.size || undefined),
                resumable: parent.resumable !== false,
                checkpointBytes: childBase.checkpointBytes ?? 0,
                resumeStage: childBase.resumeStage,
                downloadCheckpointBytes: childBase.downloadCheckpointBytes,
                uploadCheckpointBytes: childBase.uploadCheckpointBytes,
                sourceFingerprint: childBase.sourceFingerprint,
                skipAdmission: true,
              }), () => options?.shouldAbort?.() === true, pausedAtResume.get(childId));

              if (streamResult?.error || streamResult?.cancelled) {
                throw new Error(streamResult.error || "Transfer cancelled");
              }

              completedCount += 1;
              options?.onChildUpdate?.({
                ...childBase,
                status: "completed",
                transferredBytes: Number.isFinite(childBase.totalBytes)
                  ? childBase.totalBytes
                  : (file.size || childBase.transferredBytes),
                speed: 0,
                endTime: Date.now(),
                error: undefined,
                reconnectRequired: false,
                phase: undefined,
              });
              bumpParentProgress(0);
            } catch (error) {
              if (options?.shouldAbort?.() || /cancelled|canceled/i.test(error instanceof Error ? error.message : String(error))) {
                throw error instanceof Error ? error : new Error(String(error));
              }
              failedCount += 1;
              options?.onChildUpdate?.({
                ...childBase,
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
                speed: 0,
                endTime: Date.now(),
                reconnectRequired: false,
                phase: undefined,
              });
            }
          },
        );

        return { transferId: parent.id };
      },
    );

    if (result?.error) throw new Error(result.error);

    if (attentionCount > 0 && failedCount === 0 && completedCount + attentionCount >= totalFiles) {
      return {
        success: false,
        needsAttention: true,
        error: attentionCount === 1
          ? "Source was modified for 1 file — review and retry"
          : `Source was modified for ${attentionCount} files — review and retry`,
      };
    }
    if (failedCount > 0 || attentionCount > 0) {
      return {
        success: false,
        needsAttention: attentionCount > 0 && failedCount === 0,
        error: [
          failedCount > 0
            ? (failedCount === totalFiles
              ? `All ${failedCount} files failed to resume`
              : `${failedCount} of ${totalFiles} files failed to resume`)
            : null,
          attentionCount > 0 ? `${attentionCount} file(s) need attention (source changed)` : null,
        ].filter(Boolean).join("; "),
      };
    }
    // Full success — promote replace-mode stage onto the final target path.
    if (parent.stagedTargetPath) {
      await promoteDirectoryReplaceStage(parent, endpoints, targetSftpId);
      // Partial upsert only — do not re-publish a stale full parent snapshot
      // (would clobber live transferredBytes / totalBytes from patchTask).
      options?.onChildUpdate?.({
        id: parent.id,
        stagedTargetPath: undefined,
        replaceExistingTarget: undefined,
      } as TransferTask);
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeDedicatedSftpSession(sourceSftpId);
    await closeDedicatedSftpSession(targetSftpId);
  }
}
