/**
 * Minimal in-memory IndexedDB stub covering the exact subset used by
 * `aiSessionIdbStorage.ts`: open + upgrade (createObjectStore), readonly
 * getAll/get, readwrite put/delete/clear, and meta-store records. Not a
 * general-purpose IDB implementation — extend deliberately if the wrapper
 * grows new usage.
 */

type Resolve = () => void;

const microtask2 = (fn: Resolve) => {
  queueMicrotask(() => queueMicrotask(fn));
};

export class FakeRequest<T> {
  onsuccess: ((this: FakeRequest<T>, ev?: unknown) => void) | null = null;
  onerror: ((this: FakeRequest<T>, ev?: unknown) => void) | null = null;
  onupgradeneeded: ((this: FakeRequest<T>, ev?: unknown) => void) | null = null;
  result: T;
  error: Error | null = null;

  constructor(result: T, mode: 'immediate' | 'upgrade' | 'failure' = 'immediate', error?: Error) {
    this.result = result;
    if (mode === 'failure') {
      this.error = error ?? new Error('fake idb failure');
      queueMicrotask(() => this.onerror?.(this));
      return;
    }
    queueMicrotask(() => {
      if (mode === 'upgrade') this.onupgradeneeded?.(this);
      this.onsuccess?.(this);
    });
  }
}

interface StoreSpec {
  name: string;
  keyPath: string;
}

export class FakeObjectStore {
  /** Instrumentation for per-record write assertions. */
  putCount = 0;
  deleteCount = 0;

  constructor(
    public readonly spec: StoreSpec,
    public readonly records: Map<string, unknown>,
  ) {}

  put(value: unknown): FakeRequest<IDBValidKey> {
    this.putCount += 1;
    const key = (value as Record<string, unknown>)[this.spec.keyPath] as string;
    this.records.set(key, value);
    return new FakeRequest(key);
  }

  delete(key: IDBValidKey): FakeRequest<undefined> {
    this.deleteCount += 1;
    this.records.delete(String(key));
    return new FakeRequest(undefined);
  }

  clear(): FakeRequest<undefined> {
    this.records.clear();
    return new FakeRequest(undefined);
  }

  get(key: IDBValidKey): FakeRequest<unknown> {
    return new FakeRequest(this.records.get(String(key)));
  }

  getAll(): FakeRequest<unknown[]> {
    return new FakeRequest(Array.from(this.records.values()));
  }
}

export class FakeTransaction {
  oncomplete: Resolve | null = null;
  onabort: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  error: Error | null = null;

  constructor(
    private readonly database: FakeIndexedDb,
    private readonly storeName: string,
    private readonly fail: boolean,
  ) {
    microtask2(() => {
      if (this.fail) {
        this.error = new Error('fake transaction failure');
        this.onerror?.(this);
        this.onabort?.(this);
        return;
      }
      this.oncomplete?.();
    });
  }

  objectStore(name: string): FakeObjectStore {
    if (name !== this.storeName) {
      throw new Error(`fake idb: transaction opened for "${this.storeName}", not "${name}"`);
    }
    return this.database.getOrCreateStore(name);
  }
}

export class FakeIndexedDb {
  /** DOMStringList-like: the wrapper calls `.contains()` (browser IDB API). */
  readonly objectStoreNames = new Set<string>() as Set<string> & { contains(name: string): boolean };

  constructor() {
    this.objectStoreNames.contains = (name: string) => this.objectStoreNames.has(name);
  }

  private readonly storeSpecs = new Map<string, string>();
  private readonly records = new Map<string, Map<string, unknown>>();
  /** Instrumentation per store: { put, delete } counters. */
  readonly opCounts = new Map<string, { put: number; delete: number }>();
  onclose: (() => void) | null = null;
  onversionchange: (() => void) | null = null;

  createObjectStore(name: string, options?: { keyPath?: string }) {
    this.objectStoreNames.add(name);
    this.storeSpecs.set(name, options?.keyPath ?? 'key');
    return { name };
  }

  getOrCreateStore(name: string): FakeObjectStore {
    if (!this.storeSpecs.has(name)) {
      this.storeSpecs.set(name, 'key');
      this.objectStoreNames.add(name);
    }
    if (!this.records.has(name)) this.records.set(name, new Map());
    const spec = { name, keyPath: this.storeSpecs.get(name)! };
    const store = new FakeObjectStore(spec, this.records.get(name)!);
    const counts = this.opCounts.get(name) ?? { put: 0, delete: 0 };
    // Aggregate counts lazily via proxy-free bookkeeping on each op.
    const originalPut = store.put.bind(store);
    store.put = (value: unknown) => {
      counts.put += 1;
      this.opCounts.set(name, counts);
      return originalPut(value);
    };
    const originalDelete = store.delete.bind(store);
    store.delete = (key: IDBValidKey) => {
      counts.delete += 1;
      this.opCounts.set(name, counts);
      return originalDelete(key);
    };
    return store;
  }

  transaction(storeName: string, _mode?: string): FakeTransaction {
    return new FakeTransaction(this, storeName, false);
  }

  close() {
    this.onclose?.();
  }

  /** Direct read for assertions (bypasses the async wrapper). */
  dumpStore(name: string): unknown[] {
    return Array.from(this.records.get(name)?.values() ?? []);
  }
}

export interface FakeIndexedDbHandle {
  db: FakeIndexedDb;
  openCount: number;
  restore: () => void;
}

export function installFakeIndexedDb(options: { failOpen?: boolean; failOpenTimes?: number; onOperation?: (storeName: string, op: 'put' | 'delete') => void } = {}): FakeIndexedDbHandle {
  const previous = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const handle: FakeIndexedDbHandle = {
    db: new FakeIndexedDb(),
    openCount: 0,
    restore: () => {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = previous;
    },
  };
  if (options.onOperation) {
    const onOperation = options.onOperation;
    const originalGet = handle.db.getOrCreateStore.bind(handle.db);
    handle.db.getOrCreateStore = (name: string) => {
      const store = originalGet(name);
      const originalPut = store.put.bind(store);
      store.put = (value: unknown) => {
        onOperation(name, 'put');
        return originalPut(value);
      };
      const originalDelete = store.delete.bind(store);
      store.delete = (key: IDBValidKey) => {
        onOperation(name, 'delete');
        return originalDelete(key);
      };
      return store;
    };
  }
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open(_name: string, _version: number) {
      handle.openCount += 1;
      if (options.failOpen) {
        return new FakeRequest<IDBDatabase>(null as unknown as IDBDatabase, 'failure', new Error('fake open failure'));
      }
      if (options.failOpenTimes != null && handle.openCount <= options.failOpenTimes) {
        // Fail only the first N opens, then recover (boot-retry scenarios).
        return new FakeRequest<IDBDatabase>(null as unknown as IDBDatabase, 'failure', new Error('fake open failure'));
      }
      return new FakeRequest<IDBDatabase>(handle.db as unknown as IDBDatabase, 'upgrade');
    },
  };
  return handle;
}
