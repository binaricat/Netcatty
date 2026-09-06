import type { TransferTask } from "../../../domain/models";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

type StreamResult = { error?: string; cancelled?: boolean; superseded?: boolean } | undefined;

/** A live waiter owns bounded settlement evidence; persisted history stays compact. */
export async function runTransferAndWaitForOwner(
  task: TransferTask,
  start: () => Promise<StreamResult>,
  shouldAbort: () => boolean,
): Promise<StreamResult> {
  // Register before start: a replacement owner can finish before our reply.
  const observation = sftpTransferCenterStore.observeTaskSettlement(task);
  try {
    const result = await start();
    if (!result?.superseded) return result;
    for (;;) {
      if (shouldAbort()) throw new Error("Transfer cancelled");
      const latest = observation.read();
      if (latest?.status === "completed") return { ...result, superseded: false };
      if (latest?.status === "failed") throw new Error(latest.error || "Transfer failed");
      if (latest?.status === "cancelled") throw new Error("Transfer cancelled");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    observation.dispose();
  }
}
