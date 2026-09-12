import type { TransferTask } from "../../../domain/models";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

type StreamResult = { error?: string; cancelled?: boolean; superseded?: boolean } | undefined;

/** A live waiter owns bounded settlement evidence; persisted history stays compact. */
export async function runTransferAndWaitForOwner(
  task: TransferTask,
  start: () => Promise<StreamResult>,
  shouldAbort: () => boolean,
  pausedAtResume?: TransferTask,
): Promise<StreamResult> {
  // Register before admission/start: an owner may finish while dispatch waits for resume.
  let observation = sftpTransferCenterStore.observeTaskSettlement(task);
  try {
    for (;;) {
      if (shouldAbort()) throw new Error("Transfer cancelled");
      const admission = sftpTransferCenterStore.admitTaskRun(task, pausedAtResume);
      if (admission === "cancelled") throw new Error("Transfer cancelled");
      if (admission === "completed" || observation.read()?.status === "completed") return {};
      if (admission === "conflict") throw new Error("Transfer identity changed before dispatch");
      if (admission === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Admission begins a new attempt; discard any previous failed settlement.
    observation.dispose();
    observation = sftpTransferCenterStore.observeTaskSettlement(task);
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
