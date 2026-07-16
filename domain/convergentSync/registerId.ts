import type { RegisterAddress } from './types';

/** Collision-free identity persisted for causal-origin validation. */
export function registerId(address: RegisterAddress): string {
  switch (address.kind) {
    case 'entity-presence':
      return JSON.stringify([address.kind, address.collection, address.entityId]);
    case 'entity-position':
      return JSON.stringify([address.kind, address.collection, address.entityId]);
    case 'entity-field':
      return JSON.stringify([
        address.kind,
        address.collection,
        address.entityId,
        address.field,
      ]);
    case 'setting':
      return JSON.stringify([address.kind, ...address.path]);
    case 'string-entry-presence':
      return JSON.stringify([address.kind, address.collection, address.value]);
    case 'string-entry-position':
      return JSON.stringify([address.kind, address.collection, address.value]);
  }
}
