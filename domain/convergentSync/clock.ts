import type {
  Dot,
  HybridLogicalClock,
  VersionVector,
} from './types';
import { ConvergentSyncInvariantError } from './types';
import { getOwnRecordValue, setOwnRecordValue } from './record';

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareDots(left: Dot, right: Dot): number {
  const deviceOrder = compareStrings(left.deviceId, right.deviceId);
  return deviceOrder !== 0 ? deviceOrder : left.counter - right.counter;
}

export function dotKey(dot: Dot): string {
  return `${dot.deviceId}:${dot.counter}`;
}

export function observesDot(vector: VersionVector, dot: Dot): boolean {
  return (getOwnRecordValue(vector, dot.deviceId) ?? 0) >= dot.counter;
}

export function mergeVersionVectors(
  left: VersionVector,
  right: VersionVector,
): VersionVector {
  const merged: VersionVector = {};
  const deviceIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const deviceId of [...deviceIds].sort()) {
    const counter = Math.max(
      getOwnRecordValue(left, deviceId) ?? 0,
      getOwnRecordValue(right, deviceId) ?? 0,
    );
    if (counter > 0) setOwnRecordValue(merged, deviceId, counter);
  }
  return merged;
}

export function compareHybridLogicalClocks(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): number {
  if (left.wallTime !== right.wallTime) return left.wallTime - right.wallTime;
  return left.logical - right.logical;
}

export function maxHybridLogicalClock(
  left: HybridLogicalClock,
  right: HybridLogicalClock,
): HybridLogicalClock {
  return compareHybridLogicalClocks(left, right) >= 0
    ? { ...left }
    : { ...right };
}

export function tickHybridLogicalClock(
  current: HybridLogicalClock,
  now: number,
): HybridLogicalClock {
  const safeNow = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  if (!Number.isSafeInteger(safeNow)) {
    throw new ConvergentSyncInvariantError('Hybrid logical clock wall time is out of range');
  }
  if (safeNow > current.wallTime) {
    return { wallTime: safeNow, logical: 0 };
  }
  if (current.logical >= Number.MAX_SAFE_INTEGER) {
    throw new ConvergentSyncInvariantError('Hybrid logical clock counter exhausted');
  }
  return { wallTime: current.wallTime, logical: current.logical + 1 };
}
