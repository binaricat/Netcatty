import type { TransferTask } from "../../../domain/models";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

/** The displaced invocation may fail its walk, but no longer owns the child row. */
export class TransferOwnerChangedError extends Error {}

export type TransferOwnerObservation = ReturnType<typeof sftpTransferCenterStore.observeTaskSettlement>;

type StreamResult = { error?: string; cancelled?: boolean; superseded?: boolean } | undefined;

/** A live waiter owns bounded settlement evidence; persisted history stays compact. */
export async function runTransferAndWaitForOwner(
  task: TransferTask,
  start: () => Promise<StreamResult>,
  shouldAbort: () => boolean,
  pausedAtResume?: TransferTask,
  completedAtRestart?: TransferTask,
  onOwnerChanged?: () => void,
  retainObservation?: (observation: TransferOwnerObservation) => boolean,
  existingObservation?: TransferOwnerObservation,
): Promise<StreamResult> {
  // Register before admission/start: an owner may finish while dispatch waits for resume.
  let observation = existingObservation ?? sftpTransferCenterStore.observeTaskSettlement(task, completedAtRestart, onOwnerChanged);
  try {
    for (;;) {
      if (shouldAbort()) throw new Error("Transfer cancelled");
      if (observation.hasIdentityConflict()) throw new TransferOwnerChangedError("Transfer identity changed before dispatch");
      const admission = sftpTransferCenterStore.admitTaskRun(task, pausedAtResume, completedAtRestart);
      if (admission === "cancelled") throw new Error("Transfer cancelled");
      if (admission === "completed" || observation.read()?.status === "completed") return {};
      if (admission === "conflict") throw new TransferOwnerChangedError("Transfer identity changed before dispatch");
      if (admission === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Admission begins a new attempt; discard any previous failed settlement.
    observation.dispose();
    observation = sftpTransferCenterStore.observeTaskSettlement(task, undefined, onOwnerChanged);
    const result = await start();
    if (observation.hasIdentityConflict()) throw new TransferOwnerChangedError("Transfer identity changed while waiting for its owner");
    if (!result?.superseded) return result;
    for (;;) {
      if (shouldAbort()) throw new Error("Transfer cancelled");
      if (observation.hasIdentityConflict()) throw new TransferOwnerChangedError("Transfer identity changed while waiting for its owner");
      const latest = observation.read();
      if (latest?.status === "completed") return { ...result, superseded: false };
      if (latest?.status === "failed") throw new Error(latest.error || "Transfer failed");
      if (latest?.status === "cancelled") throw new Error("Transfer cancelled");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } catch (error) {
    // A displaced invocation can reject instead of returning superseded. Its
    // transport error must not regain permission to write the winning row.
    if (observation.hasIdentityConflict()) throw new TransferOwnerChangedError("Transfer identity changed while waiting for its owner");
    throw error;
  } finally {
    // A deferred child update may outlive the invocation. Its caller must either
    // retain this evidence through the write or release it after handling exit.
    if (!retainObservation?.(observation)) observation.dispose();
  }
}
