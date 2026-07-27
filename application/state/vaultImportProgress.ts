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

export function ensureVaultImportPersisted(
  persisted: boolean | void,
  errorMessage: string,
  onPersisted?: () => void,
): void {
  if (persisted === false) throw new Error(errorMessage);
  onPersisted?.();
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
