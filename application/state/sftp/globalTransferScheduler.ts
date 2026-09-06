import { resolveSftpTransferConcurrency } from "../../../domain/sftpTransferConcurrency";

type LimitReader = () => number | null | undefined;

interface ScheduledJob<T> {
  ownerId: string;
  taskId: string;
  resourceKeys: string[];
  priority: number;
  readLimit: LimitReader;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export interface GlobalSftpTransferScheduler {
  run<T>(ownerId: string, taskId: string, resourceKeys: readonly string[], readLimit: LimitReader, work: () => Promise<T>): Promise<T>;
  prioritize(taskId: string): void;
  pause(taskId: string): boolean;
  resume(taskId: string): boolean;
  cancel(taskId: string): boolean;
}

function normalizeLimit(value: number | null | undefined): number {
  return resolveSftpTransferConcurrency(() => value);
}

export function getSftpTransferResourceKeys(input: {
  sourceHostId?: string;
  targetHostId?: string;
  sourceSftpId?: string;
  targetSftpId?: string;
}): string[] {
  const keys = [
    input.sourceHostId ? `host:${input.sourceHostId}` : input.sourceSftpId ? `session:${input.sourceSftpId}` : null,
    input.targetHostId ? `host:${input.targetHostId}` : input.targetSftpId ? `session:${input.targetSftpId}` : null,
  ].filter((key): key is string => Boolean(key));
  return [...new Set(keys.length > 0 ? keys : ["local"])];
}

export function createGlobalSftpTransferScheduler(): GlobalSftpTransferScheduler {
  const queue: Array<ScheduledJob<unknown>> = [];
  const activeByResource = new Map<string, number>();
  let lastOwnerId: string | null = null;
  let prioritySequence = 0;
  const pausedJobs = new Map<string, ScheduledJob<unknown>>();
  let pumpScheduled = false;
  let startsSinceYield = 0;

  const schedulePump = () => {
    if (pumpScheduled || queue.length === 0) return;
    pumpScheduled = true;
    const run = () => {
      pumpScheduled = false;
      pump();
    };
    // Coalesce a discovery/enqueue burst into one scan. Periodically yield to
    // input/paint as well, including when many tiny jobs resolve immediately.
    if (startsSinceYield >= 64) {
      startsSinceYield = 0;
      setTimeout(run, 0);
    } else {
      queueMicrotask(run);
    }
  };

  const normalizeResourceKeys = (keys: readonly string[]) => [...new Set(keys.length > 0 ? keys : ["local"])];
  const canRun = (job: ScheduledJob<unknown>) => {
    const limit = normalizeLimit(job.readLimit());
    return job.resourceKeys.every((key) => (activeByResource.get(key) ?? 0) < limit);
  };
  const adjustActive = (job: ScheduledJob<unknown>, delta: 1 | -1) => {
    for (const key of job.resourceKeys) {
      const next = (activeByResource.get(key) ?? 0) + delta;
      if (next > 0) activeByResource.set(key, next);
      else activeByResource.delete(key);
    }
  };

  const pump = () => {
    while (queue.length > 0) {
      let index = -1;
      for (let candidateIndex = 0; candidateIndex < queue.length; candidateIndex += 1) {
        const candidate = queue[candidateIndex];
        if (!canRun(candidate)) continue;
        const selected = queue[index];
        if (!selected || candidate.priority > selected.priority || (
          candidate.priority === selected.priority
          && selected.ownerId === lastOwnerId
          && candidate.ownerId !== lastOwnerId
        )) index = candidateIndex;
      }
      if (index < 0) return;
      const [job] = queue.splice(index, 1);
      if (!job) return;
      adjustActive(job, 1);
      lastOwnerId = job.ownerId;
      startsSinceYield += 1;
      void (async () => job.work())().then(job.resolve, job.reject).finally(() => {
        adjustActive(job, -1);
        schedulePump();
      });
      if (startsSinceYield >= 64) {
        schedulePump();
        return;
      }
    }
  };

  return {
    run<T>(ownerId: string, taskId: string, resourceKeys: readonly string[], readLimit: LimitReader, work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ ownerId, taskId, resourceKeys: normalizeResourceKeys(resourceKeys), priority: 0, readLimit, work, resolve, reject } as ScheduledJob<unknown>);
        if (queue.length === 1 && !pumpScheduled && startsSinceYield < 64) pump();
        else schedulePump();
      });
    },
    prioritize(taskId: string) {
      const job = queue.find((candidate) => candidate.taskId === taskId) ?? pausedJobs.get(taskId);
      if (!job) return;
      prioritySequence += 1;
      job.priority = prioritySequence;
      schedulePump();
    },
    pause(taskId: string) {
      const index = queue.findIndex((job) => job.taskId === taskId);
      if (index < 0) return false;
      const [job] = queue.splice(index, 1);
      if (!job) return false;
      pausedJobs.set(taskId, job);
      return true;
    },
    resume(taskId: string) {
      const job = pausedJobs.get(taskId);
      if (!job) return false;
      pausedJobs.delete(taskId);
      queue.push(job);
      schedulePump();
      return true;
    },
    cancel(taskId: string) {
      const queueIndex = queue.findIndex((job) => job.taskId === taskId);
      const job = queueIndex >= 0 ? queue.splice(queueIndex, 1)[0] : pausedJobs.get(taskId);
      if (!job) return false;
      pausedJobs.delete(taskId);
      job.reject(new Error("Transfer cancelled"));
      schedulePump();
      return true;
    },
  };
}

export const globalSftpTransferScheduler = createGlobalSftpTransferScheduler();

/** Host admission unlimited — folder fan-out is capped separately by workers. */
export const unlimitedSftpSchedulerAdmission = (): number => Number.POSITIVE_INFINITY;
