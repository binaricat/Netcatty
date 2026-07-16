import {
  compareDots,
  compareHybridLogicalClocks,
  compareStrings,
  dotKey,
} from './clock';
import { canonicalJsonString, cloneJson } from './json';
import {
  ConvergentSyncInvariantError,
  type Dot,
  type HybridLogicalClock,
  type JsonValue,
  type MultiValueRegister,
  type RegisterCandidate,
} from './types';

export function isTombstoneCandidate(
  candidate: RegisterCandidate,
): candidate is Extract<RegisterCandidate, { tombstone: true }> {
  return candidate.tombstone === true;
}

export function cloneCandidate<T extends JsonValue>(
  candidate: RegisterCandidate<T>,
): RegisterCandidate<T> {
  const base = {
    dot: {
      deviceId: candidate.dot.deviceId,
      counter: candidate.dot.counter,
    },
    context: candidate.context.map((dot) => ({
      deviceId: dot.deviceId,
      counter: dot.counter,
    })),
    hlc: {
      wallTime: candidate.hlc.wallTime,
      logical: candidate.hlc.logical,
    },
  };
  if (isTombstoneCandidate(candidate)) {
    return { ...base, tombstone: true };
  }
  return { ...base, value: cloneJson(candidate.value) };
}

export function createRegisterCandidate<T extends JsonValue>(options: {
  dot: Dot;
  context: Dot[];
  hlc: HybridLogicalClock;
  value?: T;
  tombstone?: boolean;
}): RegisterCandidate<T> {
  const base = {
    dot: {
      deviceId: options.dot.deviceId,
      counter: options.dot.counter,
    },
    context: options.context.map((dot) => ({
      deviceId: dot.deviceId,
      counter: dot.counter,
    })),
    hlc: {
      wallTime: options.hlc.wallTime,
      logical: options.hlc.logical,
    },
  };
  if (options.tombstone) {
    if (options.value !== undefined) {
      throw new ConvergentSyncInvariantError('A tombstone candidate cannot contain a value');
    }
    return { ...base, tombstone: true };
  }
  if (options.value === undefined) {
    throw new ConvergentSyncInvariantError('A non-tombstone candidate requires a value');
  }
  return { ...base, value: cloneJson(options.value) };
}

function canonicalContext(context: Dot[]): string {
  return JSON.stringify(
    context
      .map((dot) => ({ deviceId: dot.deviceId, counter: dot.counter }))
      .sort(compareDots),
  );
}

function candidateFingerprint(candidate: RegisterCandidate): string {
  return JSON.stringify({
    dot: {
      deviceId: candidate.dot.deviceId,
      counter: candidate.dot.counter,
    },
    context: canonicalContext(candidate.context),
    hlc: {
      wallTime: candidate.hlc.wallTime,
      logical: candidate.hlc.logical,
    },
    tombstone: isTombstoneCandidate(candidate),
    value: isTombstoneCandidate(candidate)
      ? undefined
      : canonicalJsonString(candidate.value),
  });
}

function assertEquivalentCandidates(
  left: RegisterCandidate,
  right: RegisterCandidate,
): void {
  if (candidateFingerprint(left) !== candidateFingerprint(right)) {
    throw new ConvergentSyncInvariantError(
      `Dot ${dotKey(left.dot)} has conflicting candidate payloads`,
    );
  }
}

function candidateDominates(
  winner: RegisterCandidate,
  candidate: RegisterCandidate,
): boolean {
  return winner.context.some((dot) => dotKey(dot) === dotKey(candidate.dot));
}

export function registerCausalContext(
  register: MultiValueRegister | undefined,
): Dot[] {
  const context = new Map<string, Dot>();
  const observe = (dot: Dot) => {
    context.set(dotKey(dot), {
      deviceId: dot.deviceId,
      counter: dot.counter,
    });
  };
  for (const candidate of register?.candidates ?? []) {
    candidate.context.forEach(observe);
    observe(candidate.dot);
  }
  return [...context.values()].sort(compareDots);
}

export function compareRegisterCandidates(
  left: RegisterCandidate,
  right: RegisterCandidate,
): number {
  const leftTombstone = isTombstoneCandidate(left);
  const rightTombstone = isTombstoneCandidate(right);
  if (leftTombstone !== rightTombstone) return leftTombstone ? -1 : 1;

  const clockOrder = compareHybridLogicalClocks(left.hlc, right.hlc);
  if (clockOrder !== 0) return clockOrder;

  const deviceOrder = compareStrings(left.dot.deviceId, right.dot.deviceId);
  if (deviceOrder !== 0) return deviceOrder;
  return left.dot.counter - right.dot.counter;
}

export function compareCandidatesByDot(
  left: RegisterCandidate,
  right: RegisterCandidate,
): number {
  return compareDots(left.dot, right.dot);
}

export function selectRegisterWinner<T extends JsonValue>(
  register: MultiValueRegister<T> | undefined,
): RegisterCandidate<T> | undefined {
  if (!register || register.candidates.length === 0) return undefined;
  return register.candidates.reduce((winner, candidate) =>
    compareRegisterCandidates(candidate, winner) > 0 ? candidate : winner,
  );
}

export function mergeMultiValueRegisters<T extends JsonValue>(
  left: MultiValueRegister<T> | undefined,
  right: MultiValueRegister<T> | undefined,
): MultiValueRegister<T> | undefined {
  const leftCandidates = left?.candidates ?? [];
  const rightCandidates = right?.candidates ?? [];
  const leftContext = registerCausalContext(left);
  const rightContext = registerCausalContext(right);
  const leftByDot = new Map(leftCandidates.map((candidate) => [dotKey(candidate.dot), candidate]));
  const rightByDot = new Map(rightCandidates.map((candidate) => [dotKey(candidate.dot), candidate]));
  const candidates: RegisterCandidate<T>[] = [];

  for (const key of new Set([...leftByDot.keys(), ...rightByDot.keys()])) {
    const leftCandidate = leftByDot.get(key);
    const rightCandidate = rightByDot.get(key);

    if (leftCandidate && rightCandidate) {
      assertEquivalentCandidates(leftCandidate, rightCandidate);
      candidates.push(cloneCandidate(leftCandidate));
    } else if (
      leftCandidate
      && !rightContext.some((dot) => dotKey(dot) === dotKey(leftCandidate.dot))
    ) {
      candidates.push(cloneCandidate(leftCandidate));
    } else if (
      rightCandidate
      && !leftContext.some((dot) => dotKey(dot) === dotKey(rightCandidate.dot))
    ) {
      candidates.push(cloneCandidate(rightCandidate));
    }
  }

  const maximal = candidates.filter((candidate, index) =>
    !candidates.some((other, otherIndex) =>
      index !== otherIndex && candidateDominates(other, candidate),
    ),
  );

  if (maximal.length === 0) return undefined;
  maximal.sort(compareCandidatesByDot);
  return { candidates: maximal };
}

export function registerHasConflict(register: MultiValueRegister): boolean {
  if (register.candidates.length < 2) return false;
  const distinctValues = new Set(
    register.candidates.map((candidate) =>
      isTombstoneCandidate(candidate)
        ? '<tombstone>'
        : canonicalJsonString(candidate.value),
    ),
  );
  return distinctValues.size > 1;
}
