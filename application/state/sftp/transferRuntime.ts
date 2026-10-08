/**
 * Process-level TransferRuntime — single control/execution surface for SFTP
 * bulk transfers.
 *
 * Contract (one entry for all callers — Global Center, panel queue, tests):
 *   start / enqueue  — register work in the store (no panel ownership required)
 *   pause / resume / cancel — process-global; soft control never needs a mounted owner
 *   subscribe / getSnapshot — observe runtime state
 *   runWalk — execute a directory/file walk that outlives React unmount
 *
 * Soft pause/resume of a live walk vs hard dedicated reconnect on dead/reconnect
 * rows are internal strategies of `resume`. Callers do not pick owner vs orphan
 * APIs. Panel hooks are enqueue + view only.
 */

import type { TransferTask } from "../../../domain/models";
import {
  sftpTransferCenterStore,
  type SftpTransferCenterSnapshot,
} from "../sftpTransferCenterStore";
import {
  isTransferWalkInFlight,
  registerTransferWalk,
  unregisterTransferWalk,
} from "./transferWalkRegistry";
import { settleTransferCancelTree } from "./transferCancelLatch";
import { settleTransferControlEpochTree } from "./transferControlEpoch";

export type TransferRuntimeSnapshot = SftpTransferCenterSnapshot;

export type TransferWalkRunner = () => Promise<void>;

export interface TransferRuntime {
  /** Observe store/runtime snapshot changes. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): TransferRuntimeSnapshot;
  getTask(taskId: string): TransferTask | undefined;

  /**
   * Insert or replace task rows (enqueue). Does not require a panel owner.
   * ownerId on the task is an origin label only, not control authority.
   */
  enqueue(tasks: readonly TransferTask[]): void;
  /** Patch a single task from the runtime writer path (progress / lifecycle). */
  patchTask(taskId: string, updates: Partial<TransferTask>): void;

  /** Soft-pause a live walk (process-global; no owner required). */
  pause(taskId: string): Promise<void>;
  /**
   * Resume: soft-unlatch when walk is in-flight; hard dedicated reconnect when
   * walk is dead / reconnectRequired. Single external operation.
   */
  resume(taskId: string): Promise<void>;
  /** Wait for backend cancellation requests; Resume remains fenced on walk settlement. */
  cancel(taskId: string): Promise<void>;

  /**
   * Run a transfer walk process-globally. Registers the walk before `runner`
   * starts and always unregisters on settle — survives panel unmount.
   * Concurrent starts on the same id no-op (existing walk wins).
   */
  runWalk(rootTaskId: string, runner: TransferWalkRunner): Promise<void>;
  isWalkInFlight(rootTaskId: string): boolean;
}

const inFlightRunPromises = new Map<string, Promise<void>>();

export function createTransferRuntime(
  store: typeof sftpTransferCenterStore = sftpTransferCenterStore,
): TransferRuntime {
  return {
    subscribe(listener) {
      return store.subscribe(listener);
    },
    getSnapshot() {
      return store.getSnapshot();
    },
    getTask(taskId) {
      return store.getSnapshot().tasks.find((task) => task.id === taskId);
    },
    enqueue(tasks) {
      store.upsertTasks(tasks);
    },
    patchTask(taskId, updates) {
      store.patchTask(taskId, updates);
    },
    pause(taskId) {
      return store.pause(taskId);
    },
    resume(taskId) {
      return store.resume(taskId);
    },
    cancel(taskId) {
      return store.cancel(taskId);
    },
    async runWalk(rootTaskId, runner) {
      const existing = inFlightRunPromises.get(rootTaskId);
      if (existing || isTransferWalkInFlight(rootTaskId)) {
        if (existing) await existing;
        return;
      }
      registerTransferWalk(rootTaskId);
      const run = (async () => {
        try {
          await runner();
        } finally {
          const childIds = store.getSnapshot().tasks
            .filter((task) => task.parentTaskId === rootTaskId)
            .map((task) => task.id);
          const relatedChildIds = settleTransferCancelTree(rootTaskId, childIds);
          settleTransferControlEpochTree(rootTaskId, relatedChildIds);
          unregisterTransferWalk(rootTaskId);
          if (inFlightRunPromises.get(rootTaskId) === run) {
            inFlightRunPromises.delete(rootTaskId);
          }
        }
      })();
      inFlightRunPromises.set(rootTaskId, run);
      await run;
    },
    isWalkInFlight(rootTaskId) {
      return isTransferWalkInFlight(rootTaskId) || inFlightRunPromises.has(rootTaskId);
    },
  };
}

/** Process-global singleton used by UI and panel hooks. */
export const transferRuntime = createTransferRuntime();

/** Test helper — clear in-flight run bookkeeping (walk registry is separate). */
export function resetTransferRuntimeRunsForTests(): void {
  inFlightRunPromises.clear();
}
