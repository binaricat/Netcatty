/// <reference lib="webworker" />

import { importVaultHostFiles } from "../services/vaultImportBatch";
import type {
  VaultImportWorkerRequest,
  VaultImportWorkerResponse,
} from "../services/vaultImportWorkerClient";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: VaultImportWorkerResponse) => {
  workerScope.postMessage(message);
};

workerScope.addEventListener("message", async (event: MessageEvent<VaultImportWorkerRequest>) => {
  if (event.data.type !== "import") return;

  try {
    post({ type: "progress", progress: { stage: "reading", percent: 10 } });
    const result = await importVaultHostFiles({
      format: event.data.format,
      files: event.data.files,
      relativePaths: event.data.relativePaths,
      encoding: event.data.encoding,
      onProgress: ({ completedFiles, totalFiles, fileName }) => {
        post({
          type: "progress",
          progress: {
            stage: "parsing",
            percent: 10 + Math.round((completedFiles / Math.max(1, totalFiles)) * 50),
            completedFiles,
            totalFiles,
            currentFileName: fileName,
          },
        });
      },
    });
    post({ type: "result", result });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : "Vault import failed.",
    });
  }
});
