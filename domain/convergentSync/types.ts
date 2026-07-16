export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export interface VersionVector {
  [deviceId: string]: number;
}

export interface DotOriginIndex {
  [deviceId: string]: Record<string, string>;
}

export interface Dot {
  deviceId: string;
  counter: number;
}

export interface HybridLogicalClock {
  wallTime: number;
  logical: number;
}

interface RegisterCandidateBase {
  dot: Dot;
  /** Dots observed in this register before this candidate was written. */
  context: Dot[];
  hlc: HybridLogicalClock;
}

export interface RegisterValueCandidate<T extends JsonValue = JsonValue>
  extends RegisterCandidateBase {
  value: T;
  tombstone?: false;
}

export interface RegisterTombstoneCandidate extends RegisterCandidateBase {
  tombstone: true;
}

export type RegisterCandidate<T extends JsonValue = JsonValue> =
  | RegisterValueCandidate<T>
  | RegisterTombstoneCandidate;

export interface MultiValueRegister<T extends JsonValue = JsonValue> {
  candidates: RegisterCandidate<T>[];
}

export type CollectionPosition = string | number;

export interface ConvergentEntityState {
  presence: MultiValueRegister<boolean>;
  position?: MultiValueRegister<CollectionPosition>;
  fields: Record<string, MultiValueRegister>;
}

export interface ConvergentCollectionState {
  entities: Record<string, ConvergentEntityState>;
}

export interface ConvergentStringEntryState {
  presence: MultiValueRegister<boolean>;
  position?: MultiValueRegister<CollectionPosition>;
}

export interface ConvergentStringCollectionState {
  entries: Record<string, ConvergentStringEntryState>;
}

/**
 * Pure CRDT state. The encrypted protocol envelope is introduced separately;
 * this type deliberately contains no provider, persistence, or UI concerns.
 */
export interface ConvergentSyncStateV2 {
  schemaVersion: 2;
  vector: VersionVector;
  /** Register identity for every allocated device counter. */
  dotOrigins: DotOriginIndex;
  hlc: HybridLogicalClock;
  collections: Record<string, ConvergentCollectionState>;
  settings: Record<string, MultiValueRegister>;
  stringCollections: Record<string, ConvergentStringCollectionState>;
}

/**
 * A register candidate stored in the encrypted cloud envelope. Winner values
 * that already exist in the adjacent materialized v1 snapshot may be omitted
 * and reconstructed during hydration. Structural values (presence and
 * position) remain inline so the envelope is self-describing.
 */
export type ConvergentEnvelopeCandidate<T extends JsonValue = JsonValue> =
  | RegisterTombstoneCandidate
  | (Omit<RegisterValueCandidate<T>, 'value'> & {
      value?: T;
      materialized?: true;
    });

export interface ConvergentEnvelopeRegister<T extends JsonValue = JsonValue> {
  candidates: ConvergentEnvelopeCandidate<T>[];
}

export interface ConvergentEnvelopeEntityState {
  presence: ConvergentEnvelopeRegister<boolean>;
  position?: ConvergentEnvelopeRegister<CollectionPosition>;
  fields: Record<string, ConvergentEnvelopeRegister>;
}

export interface ConvergentEnvelopeCollectionState {
  entities: Record<string, ConvergentEnvelopeEntityState>;
}

export interface ConvergentEnvelopeStringEntryState {
  presence: ConvergentEnvelopeRegister<boolean>;
  position?: ConvergentEnvelopeRegister<CollectionPosition>;
}

export interface ConvergentEnvelopeStringCollectionState {
  entries: Record<string, ConvergentEnvelopeStringEntryState>;
}

export interface ConvergentEnvelopeStateV2 {
  vector: VersionVector;
  dotOrigins: DotOriginIndex;
  hlc: HybridLogicalClock;
  collections: Record<string, ConvergentEnvelopeCollectionState>;
  settings: Record<string, ConvergentEnvelopeRegister>;
  stringCollections: Record<string, ConvergentEnvelopeStringCollectionState>;
}

/**
 * Stored inside the AES-256-GCM encrypted SyncPayload. Plaintext metadata only
 * advertises `syncSchemaVersion: 2`; candidate values never leave ciphertext.
 */
export interface ConvergentSyncEnvelopeV2 {
  schemaVersion: 2;
  encoding: 'materialized-winner-v1';
  state: ConvergentEnvelopeStateV2;
}

export type RegisterAddress =
  | {
    kind: 'entity-presence';
    collection: string;
    entityId: string;
  }
  | {
    kind: 'entity-position';
    collection: string;
    entityId: string;
  }
  | {
    kind: 'entity-field';
    collection: string;
    entityId: string;
    field: string;
  }
  | {
    kind: 'setting';
    path: string[];
  }
  | {
    kind: 'string-entry-presence';
    collection: string;
    value: string;
  }
  | {
    kind: 'string-entry-position';
    collection: string;
    value: string;
  };

export type ConvergentConflictAddress = RegisterAddress | {
  kind: 'setting-structure';
  paths: string[][];
};

export type ConvergentMutation =
  | {
    kind: 'entity-upsert';
    collection: string;
    entityId: string;
    value: JsonObject;
    position?: CollectionPosition;
  }
  | {
    kind: 'entity-field-set';
    collection: string;
    entityId: string;
    field: string;
    value: JsonValue;
  }
  | {
    kind: 'entity-field-delete';
    collection: string;
    entityId: string;
    field: string;
  }
  | {
    kind: 'entity-delete';
    collection: string;
    entityId: string;
  }
  | {
    kind: 'setting-set';
    path: string[];
    value: JsonValue;
  }
  | {
    kind: 'setting-delete';
    path: string[];
  }
  | {
    kind: 'string-entry-add';
    collection: string;
    value: string;
    position?: CollectionPosition;
  }
  | {
    kind: 'string-entry-delete';
    collection: string;
    value: string;
  }
  | {
    kind: 'resolve-register';
    address: RegisterAddress;
    value?: JsonValue;
    tombstone?: boolean;
  };

export interface ConvergentConflictCandidate {
  dot: Dot;
  hlc: HybridLogicalClock;
  tombstone: boolean;
  value?: JsonValue;
  /** Present when candidates from multiple setting leaf paths conflict. */
  settingPath?: string[];
  selected: boolean;
}

export interface ConvergentFieldConflict {
  address: ConvergentConflictAddress;
  candidates: ConvergentConflictCandidate[];
}

export interface MaterializedConvergentSyncState {
  collections: Record<string, JsonObject[]>;
  settings: JsonObject;
  stringCollections: Record<string, string[]>;
  conflicts: ConvergentFieldConflict[];
}

export class ConvergentSyncInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvergentSyncInvariantError';
  }
}
