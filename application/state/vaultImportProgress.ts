export type VaultImportProgressStage =
  | "reading"
  | "parsing"
  | "preparing"
  | "saving"
  | "complete"
  | "failed";

export interface VaultImportProgress {
  status: "running" | "complete" | "error";
  stage: VaultImportProgressStage;
  percent: number;
  formatLabel: string;
  fileName: string;
  completedFiles?: number;
  totalFiles?: number;
  currentFileName?: string;
  imported?: number;
  skipped?: number;
  duplicates?: number;
  error?: string;
}

export function countVaultImportDuplicates({
  importedHostCount,
  newHostCount,
  fileDuplicateCount,
  managed,
}: {
  importedHostCount: number;
  newHostCount: number;
  fileDuplicateCount: number;
  managed: boolean;
}): number {
  const existingDuplicateCount = managed
    ? 0
    : Math.max(0, importedHostCount - newHostCount);
  return fileDuplicateCount + existingDuplicateCount;
}

export async function ensureVaultImportPersisted(
  persisted: boolean | void,
  errorMessage: string,
  onPersisted?: () => unknown | Promise<unknown>,
  onPersistenceFailed?: () => unknown | Promise<unknown>,
): Promise<void> {
  if (persisted === false) {
    await onPersistenceFailed?.();
    throw new Error(errorMessage);
  }
  await onPersisted?.();
}

const importFieldMatches = (left: unknown, right: unknown): boolean => (
  JSON.stringify(left) === JSON.stringify(right)
);

const hostMatchesAppliedImport = (currentHost: Host, appliedHost: Host): boolean => {
  const { order: _currentOrder, ...currentComparable } = currentHost;
  const { order: _appliedOrder, ...appliedComparable } = appliedHost;
  return importFieldMatches(currentComparable, appliedComparable);
};

export function rollbackVaultImportedHosts({
  currentHosts,
  baselineHosts,
  appliedHosts,
}: {
  currentHosts: Host[];
  baselineHosts: Host[];
  appliedHosts: Host[];
}): Host[] {
  const baselineById = new Map(baselineHosts.map((host) => [host.id, host]));
  const appliedById = new Map(appliedHosts.map((host) => [host.id, host]));
  const addedHostIds = new Set(
    appliedHosts.filter((host) => !baselineById.has(host.id)).map((host) => host.id),
  );

  return currentHosts.flatMap((currentHost) => {
    if (addedHostIds.has(currentHost.id)) {
      const appliedHost = appliedById.get(currentHost.id);
      return appliedHost && hostMatchesAppliedImport(currentHost, appliedHost)
        ? []
        : [currentHost];
    }
    const baselineHost = baselineById.get(currentHost.id);
    const appliedHost = appliedById.get(currentHost.id);
    if (!baselineHost || !appliedHost) return [currentHost];

    const fieldNames = new Set([
      ...Object.keys(baselineHost),
      ...Object.keys(appliedHost),
    ] as Array<keyof Host>);
    const changedFields = [...fieldNames].filter((field) => (
      !importFieldMatches(baselineHost[field], appliedHost[field])
    ));
    if (changedFields.length === 0) return [currentHost];
    if (changedFields.some((field) => (
      !importFieldMatches(currentHost[field], appliedHost[field])
    ))) {
      return [currentHost];
    }

    const restored = { ...currentHost } as Host & Record<string, unknown>;
    for (const field of changedFields) {
      if (Object.prototype.hasOwnProperty.call(baselineHost, field)) {
        restored[field] = baselineHost[field];
      } else {
        delete restored[field];
      }
    }
    return [restored];
  });
}

interface VaultImportPaintWaitOptions {
  requestFrame?: (callback: () => void) => unknown;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export function waitForVaultImportProgressPaint({
  requestFrame = typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame(callback)
    : undefined,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}: VaultImportPaintWaitOptions = {}): Promise<void> {
  return new Promise((resolve) => {
    let completed = false;
    let timer: unknown;
    const complete = () => {
      if (completed) return;
      completed = true;
      if (timer !== undefined) clearTimer(timer);
      resolve();
    };

    timer = setTimer(complete, 100);
    requestFrame?.(complete);
  });
}
import type { Host } from "../../domain/models";
