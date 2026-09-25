import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTransferPoolKey,
  createTransferConnectionPool,
  createTransferPoolKeyCache,
  DEFAULT_MAX_IDLE_TRANSFER_CONNECTIONS,
  DEFAULT_TRANSFER_CONNECTIONS_PER_HOST,
  DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS,
} from "./transferConnectionPool.ts";

function createFakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; deadline: number }>();
  return {
    now: () => current,
    setTimeoutFn(callback: () => void, delayMs: number) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, deadline: current + Math.max(0, delayMs) });
      return id;
    },
    clearTimeoutFn(id: unknown) {
      timers.delete(id as number);
    },
    advance(ms: number) {
      current += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.deadline <= current)
          .sort((left, right) => left[1].deadline - right[1].deadline)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].callback();
      }
    },
  };
}

test("transfer pool key cache resolves a host identity only once and retries failures", async () => {
  let builds = 0;
  let inputBuilds = 0;
  let failFirst = true;
  const cache = createTransferPoolKeyCache(async (input) => {
    builds += 1;
    if (failFirst) {
      failFirst = false;
      throw new Error("temporary identity failure");
    }
    return `key:${input.hostId}`;
  });
  const host = {};
  const createInput = () => {
    inputBuilds += 1;
    return { hostId: "h1" };
  };

  await assert.rejects(cache.get(host, createInput), /temporary identity failure/);
  assert.equal(await cache.get(host, createInput), "key:h1");
  assert.equal(await cache.get(host, createInput), "key:h1");
  assert.equal(builds, 2, "a rejected identity must be evicted and rebuilt once");
  assert.equal(inputBuilds, 2, "cached calls must skip credential construction too");

  assert.equal(await cache.get({}, createInput), "key:h1");
  assert.equal(builds, 3, "different host objects must not share identity promises");
});

test("buildTransferPoolKey includes endpoint when hostname is known", async () => {
  assert.equal(
    await buildTransferPoolKey({ hostId: "h1", hostname: "vault.example", port: 22, username: "root" }),
    "host:h1|ep:vault.example:22:root:ssh:nosudo",
  );
  // Same hostId with session override must not share the vault pool key.
  assert.equal(
    await buildTransferPoolKey({ hostId: "h1", hostname: "override.example", port: 2222, username: "ubuntu" }),
    "host:h1|ep:override.example:2222:ubuntu:ssh:nosudo",
  );
  assert.equal(
    await buildTransferPoolKey({ hostname: "ci.example", port: 22, username: "root" }),
    "ep:ci.example:22:root:ssh:nosudo",
  );
  assert.equal(await buildTransferPoolKey({ hostId: "h1" }), "host:h1");
});

test("buildTransferPoolKey separates every transport security identity", async () => {
  const connectionOptions = {
    hostname: "target.example",
    port: 22,
    username: "root",
    password: "secret-a",
    keepaliveInterval: 30,
    algorithmOverrides: { kex: ["curve25519-sha256"] },
    jumpHosts: [{ hostname: "jump-a", port: 22, username: "jump" }],
    verifyHostKeys: true,
    knownHosts: [{
      id: "known-a",
      hostname: "target.example",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "AAAA",
      fingerprint: "a",
      discoveredAt: 0,
    }],
  } as unknown as NetcattySSHOptions;
  const base = {
    hostId: "h1",
    hostname: "target.example",
    port: 22,
    username: "root",
    connectionOptions,
  };
  const key = await buildTransferPoolKey(base);
  const variant = (overrides: Partial<NetcattySSHOptions>): NetcattySSHOptions => ({
    ...connectionOptions,
    ...overrides,
  });
  const variants: NetcattySSHOptions[] = [
    variant({ password: "secret-b" }),
    variant({ keepaliveInterval: 60 }),
    variant({ algorithmOverrides: { kex: ["diffie-hellman-group14-sha256"] } }),
    variant({ jumpHosts: [{ hostname: "jump-b", port: 22, username: "jump" }] }),
    variant({ proxy: { type: "socks5", host: "proxy-b", port: 1080 } as NetcattySSHOptions["proxy"] }),
    variant({ verifyHostKeys: false }),
    variant({ knownHosts: [{
      id: "known-b",
      hostname: "target.example",
      port: 22,
      keyType: "ssh-ed25519",
      publicKey: "BBBB",
      fingerprint: "b",
      discoveredAt: 0,
    }] }),
  ];
  for (const connectionOptions of variants) {
    assert.notEqual(await buildTransferPoolKey({ ...base, connectionOptions }), key);
  }
});

test("pool opens at most maxPerHost channels and multiplexes when busy", async () => {
  let opens = 0;
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 2,
    closeSession: async (id) => { closed.push(id); },
  });

  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  const b = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(a.sftpId, b.sftpId);

  // Third transfer reuses least-loaded connection (both size 1 → first by age).
  const c = await pool.acquire("host:a", "t3", open);
  assert.equal(opens, 2);
  assert.ok(c.sftpId === a.sftpId || c.sftpId === b.sftpId);

  a.release();
  b.release();
  c.release();

  assert.equal(closed.length, 0);
  assert.equal(pool.getStats("host:a").connections, 2);
  assert.equal(pool.getStats("host:a").idle, 2);

  const d = await pool.acquire("host:a", "t4", open);
  assert.equal(opens, 2, "the next small file must reuse a short-idle channel");
  d.release();
  await pool.closeAll();
  assert.equal(closed.length, 2);
});

test("different hosts get independent channel pools", async () => {
  let opens = 0;
  const pool = createTransferConnectionPool({ maxPerHost: 1 });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  const b = await pool.acquire("host:b", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(a.sftpId, b.sftpId);
  a.release();
  b.release();
});

test("failed opens do not retain empty host pool keys", async () => {
  const pool = createTransferConnectionPool({ maxPerHost: 1 });

  for (let index = 0; index < 100; index += 1) {
    await assert.rejects(
      pool.acquire(`host:failed-${index}`, `transfer-${index}`, async () => {
        throw new Error("connection failed");
      }),
      /connection failed/,
    );
  }

  assert.equal(pool.getStats().poolKeys, 0);
  assert.equal(pool.getStats().pendingOpenLocks, 0);
});

test("sequential small files reuse one channel until the short idle TTL expires", async () => {
  const clock = createFakeClock();
  const closed: string[] = [];
  let opens = 0;
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    idleTtlMs: 5_000,
    closeSession: async (id) => { closed.push(id); },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const open = async () => `sftp-${++opens}`;

  const first = await pool.acquire("host:x", "file-1", open);
  first.release();
  assert.equal(pool.getStats("host:x").idle, 1);
  assert.deepEqual(closed, []);

  for (let index = 2; index <= 100; index += 1) {
    const next = await pool.acquire("host:x", `file-${index}`, open);
    assert.equal(next.sftpId, first.sftpId);
    next.release();
  }
  assert.equal(opens, 1);

  clock.advance(4_999);
  assert.deepEqual(closed, []);
  clock.advance(1);
  assert.deepEqual(closed, ["sftp-1"]);
  assert.equal(pool.getStats("host:x").connections, 0);
});

test("a pool slot retains its SFTP session for the whole directory walk", async () => {
  const clock = createFakeClock();
  const retained: string[] = [];
  const released: string[] = [];
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    idleTtlMs: 5_000,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    retainSession: async (sftpId, leaseId) => { retained.push(`${sftpId}:${leaseId}`); },
    releaseSession: async (sftpId, leaseId) => { released.push(`${sftpId}:${leaseId}`); },
    closeSession: async (sftpId) => { closed.push(sftpId); },
  });

  const root = await pool.acquire("host:folder", "directory-root", async () => "sftp-folder");
  const child = await pool.acquire("host:folder", "directory-child", async () => {
    throw new Error("must reuse the retained directory session");
  });

  assert.deepEqual(retained, ["sftp-folder:pool:sftp-folder"]);
  child.release();
  assert.deepEqual(released, [], "finishing one child must not release the pool session");
  root.release();
  assert.deepEqual(released, [], "the idle reuse window still owns the session");

  clock.advance(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(released, ["sftp-folder:pool:sftp-folder"]);
  assert.deepEqual(closed, ["sftp-folder"]);
});

test("default max per host is FileZilla-like (2)", () => {
  assert.equal(DEFAULT_TRANSFER_CONNECTIONS_PER_HOST, 2);
  assert.equal(DEFAULT_TRANSFER_CONNECTION_IDLE_TTL_MS, 5_000);
  assert.equal(DEFAULT_MAX_IDLE_TRANSFER_CONNECTIONS, 16);
});

test("global idle cap evicts the oldest host channel", async () => {
  const clock = createFakeClock();
  const closed: string[] = [];
  let opens = 0;
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    maxIdleConnections: 2,
    idleTtlMs: 60_000,
    closeSession: async (id) => { closed.push(id); },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const open = async () => `sftp-${++opens}`;

  for (const [index, hostKey] of ["host:a", "host:b", "host:c"].entries()) {
    const lease = await pool.acquire(hostKey, `file-${index}`, open);
    lease.release();
    clock.advance(1);
  }

  assert.deepEqual(closed, ["sftp-1"]);
  assert.equal(pool.getStats().connections, 2);
  assert.equal(pool.getStats().idle, 2);
  assert.equal(pool.getStats().poolKeys, 2);
});

test("concurrent acquires do not exceed maxPerHost", async () => {
  let opens = 0;
  let inFlightOpens = 0;
  let maxInFlightOpens = 0;
  const pool = createTransferConnectionPool({ maxPerHost: 2 });
  const open = async () => {
    inFlightOpens += 1;
    maxInFlightOpens = Math.max(maxInFlightOpens, inFlightOpens);
    await new Promise((r) => setTimeout(r, 10));
    opens += 1;
    inFlightOpens -= 1;
    return `sftp-${opens}`;
  };

  const leases = await Promise.all([
    pool.acquire("host:a", "t1", open),
    pool.acquire("host:a", "t2", open),
    pool.acquire("host:a", "t3", open),
    pool.acquire("host:a", "t4", open),
  ]);

  assert.equal(opens, 2);
  assert.ok(maxInFlightOpens <= 2);
  const ids = new Set(leases.map((l) => l.sftpId));
  assert.equal(ids.size, 2);
  for (const lease of leases) lease.release();
});

test("per-host open serialization state survives queued work and is released after the last waiter", async () => {
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  const secondFinished = new Promise<void>((resolve) => { finishSecond = resolve; });
  const pool = createTransferConnectionPool({ maxPerHost: 2 });
  let opens = 0;
  const open = async () => {
    opens += 1;
    if (opens === 1) {
      markFirstStarted();
      await firstFinished;
    } else {
      markSecondStarted();
      await secondFinished;
    }
    return `sftp-ephemeral-${opens}`;
  };

  const firstAcquiring = pool.acquire("host:ephemeral", "t1", open);
  await firstStarted;
  const secondAcquiring = pool.acquire("host:ephemeral", "t2", open);
  assert.equal(pool.getStats("host:ephemeral").pendingOpenLocks, 1);

  finishFirst();
  const firstLease = await firstAcquiring;
  await secondStarted;
  assert.equal(
    pool.getStats("host:ephemeral").pendingOpenLocks,
    1,
    "the first opener must not clear a later waiter's serialization state",
  );

  finishSecond();
  const secondLease = await secondAcquiring;
  assert.equal(pool.getStats("host:ephemeral").pendingOpenLocks, 0);
  firstLease.release();
  secondLease.release();
});

test("busy first channel causes a second open (FileZilla style)", async () => {
  let opens = 0;
  const pool = createTransferConnectionPool({ maxPerHost: 2 });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const first = await pool.acquire("host:a", "t1", open);
  assert.equal(opens, 1);

  // First is still held → open a second dedicated channel.
  const second = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(first.sftpId, second.sftpId);

  first.release();
  second.release();
});

test("a replacement opened while the last old holder releases stays tracked and closable", async () => {
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 2,
    idleTtlMs: 0,
    closeSession: async (id) => { closed.push(id); },
  });
  const first = await pool.acquire("host:release-during-open", "t1", async () => "sftp-old");

  let finishReplacementOpen!: () => void;
  const replacementOpenGate = new Promise<void>((resolve) => {
    finishReplacementOpen = resolve;
  });
  let replacementOpenStarted!: () => void;
  const replacementStarted = new Promise<void>((resolve) => {
    replacementOpenStarted = resolve;
  });
  const replacementPromise = pool.acquire(
    "host:release-during-open",
    "t2",
    async () => {
      replacementOpenStarted();
      await replacementOpenGate;
      return "sftp-new";
    },
  );
  await replacementStarted;

  first.release();
  finishReplacementOpen();
  const replacement = await replacementPromise;

  assert.deepEqual(closed, ["sftp-old"]);
  assert.equal(pool.getStats("host:release-during-open").connections, 1);
  assert.equal(pool.getStats("host:release-during-open").holders, 1);

  replacement.release();
  assert.deepEqual(closed, ["sftp-old", "sftp-new"]);
  assert.equal(pool.getStats().connections, 0);
  assert.equal(pool.getStats().poolKeys, 0);
});

test("discard removes a dead session so next acquire reopens", async () => {
  let opens = 0;
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    closeSession: async (id) => { closed.push(id); },
  });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  assert.equal(opens, 1);
  a.discard();
  assert.equal(closed.length, 1);
  assert.equal(pool.getStats("host:a").connections, 0);

  const b = await pool.acquire("host:a", "t2", open);
  assert.equal(opens, 2);
  assert.notEqual(a.sftpId, b.sftpId);
  b.release();
});

test("cancellation returns a healthy channel, while a session error discards it", async () => {
  const clock = createFakeClock();
  const closed: string[] = [];
  let opens = 0;
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    idleTtlMs: 5_000,
    closeSession: async (id) => { closed.push(id); },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const open = async () => `sftp-${++opens}`;

  const cancelled = await pool.acquire("host:a", "cancelled-transfer", open);
  cancelled.release();
  assert.equal(pool.getStats("host:a").idle, 1);
  assert.deepEqual(closed, []);

  const next = await pool.acquire("host:a", "next-transfer", open);
  assert.equal(next.sftpId, cancelled.sftpId);
  assert.equal(opens, 1);
  next.discard();
  assert.deepEqual(closed, ["sftp-1"]);
  assert.equal(pool.getStats("host:a").connections, 0);

  const recovered = await pool.acquire("host:a", "recovered-transfer", open);
  assert.equal(recovered.sftpId, "sftp-2");
  recovered.release();
  clock.advance(5_000);
  assert.deepEqual(closed, ["sftp-1", "sftp-2"]);
});

test("closeIdle detaches only expired idle slots before awaiting close", async () => {
  let opens = 0;
  let closeStarted = 0;
  let now = 0;
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const pool = createTransferConnectionPool({
    maxPerHost: 1,
    idleTtlMs: 100,
    now: () => now,
    closeSession: async () => {
      closeStarted += 1;
      await closeGate;
    },
  });
  const open = async () => {
    opens += 1;
    return `sftp-${opens}`;
  };

  const a = await pool.acquire("host:a", "t1", open);
  assert.equal(opens, 1);
  a.release();
  assert.equal(await pool.closeIdle(now), 0);
  now = 100;
  const closing = pool.closeIdle(now);
  assert.equal(closeStarted, 1);
  assert.equal(pool.getStats().connections, 0, "expired slot must detach before close awaits");
  releaseClose();
  assert.equal(await closing, 1);
});

test("setIdleTtlMs reschedules parked channels and zero closes them immediately", async () => {
  const clock = createFakeClock();
  const closed: string[] = [];
  const pool = createTransferConnectionPool({
    idleTtlMs: 60_000,
    closeSession: async (id) => { closed.push(id); },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const lease = await pool.acquire("host:a", "t1", async () => "sftp-a");
  lease.release();
  pool.setIdleTtlMs(5_000);
  assert.equal(pool.getIdleTtlMs(), 5_000);
  clock.advance(4_999);
  assert.deepEqual(closed, []);
  pool.setIdleTtlMs(0);
  assert.deepEqual(closed, ["sftp-a"]);
  assert.equal(pool.getStats().connections, 0);
});
