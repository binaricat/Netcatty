import type {
  VaultImportFormat,
  VaultImportResult,
} from "../../domain/vaultImport";

import type { VaultImportFileEncoding } from "./vaultImportFile";

export type VaultImportWorkerStage = "reading" | "parsing";

export interface VaultImportWorkerProgress {
  stage: VaultImportWorkerStage;
  percent: number;
  completedFiles?: number;
  totalFiles?: number;
  currentFileName?: string;
}

export type VaultImportWorkerRequest = {
  type: "import";
  format: VaultImportFormat;
  files: File[];
  relativePaths: string[];
  encoding: VaultImportFileEncoding | undefined;
  masterPassword?: string;
};

export type VaultImportWorkerResponse =
  | { type: "progress"; progress: VaultImportWorkerProgress }
  | { type: "result"; result: VaultImportResult }
  | { type: "error"; message: string };

type VaultImportWorkerEvent = MessageEvent<VaultImportWorkerResponse> | ErrorEvent;
type VaultImportWorkerListener = (event: VaultImportWorkerEvent) => void;

export interface VaultImportWorkerLike {
  addEventListener(type: "message" | "error", listener: VaultImportWorkerListener): void;
  removeEventListener(type: "message" | "error", listener: VaultImportWorkerListener): void;
  postMessage(message: VaultImportWorkerRequest): void;
  terminate(): void;
}

interface ImportVaultHostsInWorkerOptions {
  format: VaultImportFormat;
  files: File[];
  encoding?: VaultImportFileEncoding;
  masterPassword?: string;
  signal?: AbortSignal;
  createWorker?: () => VaultImportWorkerLike;
  onProgress?: (progress: VaultImportWorkerProgress) => void;
}

const createVaultImportWorker = (): VaultImportWorkerLike => (
  new Worker(new URL("../workers/vaultImport.worker.ts", import.meta.url), {
    type: "module",
  })
);

export function importVaultHostsInWorker({
  format,
  files,
  encoding,
  masterPassword,
  signal,
  createWorker = createVaultImportWorker,
  onProgress,
}: ImportVaultHostsInWorkerOptions): Promise<VaultImportResult> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Vault import cancelled.", "AbortError"));
  }
  const worker = createWorker();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleWorkerError);
      signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
    };

    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Vault import cancelled.", "AbortError"));
    };

    const handleMessage: VaultImportWorkerListener = (event) => {
      const message = (event as MessageEvent<VaultImportWorkerResponse>).data;
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      cleanup();
      if (message.type === "result") {
        resolve(message.result);
        return;
      }
      reject(new Error(message.message));
    };

    const handleWorkerError: VaultImportWorkerListener = (event) => {
      cleanup();
      const message = event instanceof ErrorEvent && event.message
        ? event.message
        : "Vault import worker failed.";
      reject(new Error(message));
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleWorkerError);
    signal?.addEventListener("abort", handleAbort, { once: true });
    worker.postMessage({
      type: "import",
      format,
      files,
      relativePaths: files.map((file) => file.webkitRelativePath),
      encoding,
      ...(masterPassword ? { masterPassword } : {}),
    });
  });
}
