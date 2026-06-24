import test from "node:test";
import assert from "node:assert/strict";

import { createSessionRestoreStorage } from "./sessionRestoreStorage.ts";
import type { SessionRestorePayload } from "../../domain/sessionRestore.ts";

const payload: SessionRestorePayload = {
  version: 1,
  savedAt: 1,
  activeTabId: "vault",
  tabOrder: [],
  sessions: [],
  workspaces: [],
};

test("session restore storage reads a valid payload", () => {
  const backing = new Map<string, unknown>();
  const storage = createSessionRestoreStorage({
    read: <T,>(key: string): T | null => (backing.get(key) as T) ?? null,
    write: <T,>(key: string, value: T): boolean => {
      backing.set(key, value);
      return true;
    },
    remove: (key: string) => {
      backing.delete(key);
    },
  });

  storage.write(payload);
  assert.deepEqual(storage.read(), payload);
});

test("session restore storage removes invalid payloads", () => {
  const backing = new Map<string, unknown>([["netcatty_session_restore_v1", { version: 999 }]]);
  const storage = createSessionRestoreStorage({
    read: <T,>(key: string): T | null => (backing.get(key) as T) ?? null,
    write: () => true,
    remove: (key: string) => {
      backing.delete(key);
    },
  });

  assert.equal(storage.read(), null);
  assert.equal(backing.has("netcatty_session_restore_v1"), false);
});

test("session restore storage removes malformed payloads that pass shallow checks", () => {
  const backing = new Map<string, unknown>([[
    "netcatty_session_restore_v1",
    {
      version: 1,
      savedAt: 1,
      activeTabId: "vault",
      tabOrder: [],
      sessions: [null],
      workspaces: [],
    },
  ]]);
  const storage = createSessionRestoreStorage({
    read: <T,>(key: string): T | null => (backing.get(key) as T) ?? null,
    write: () => true,
    remove: (key: string) => {
      backing.delete(key);
    },
  });

  assert.equal(storage.read(), null);
  assert.equal(backing.has("netcatty_session_restore_v1"), false);
});

test("session restore storage sanitizes payloads before writing", () => {
  const backing = new Map<string, unknown>();
  const storage = createSessionRestoreStorage({
    read: <T,>(key: string): T | null => (backing.get(key) as T) ?? null,
    write: <T,>(key: string, value: T): boolean => {
      backing.set(key, value);
      return true;
    },
    remove: (key: string) => {
      backing.delete(key);
    },
  });

  storage.write({
    ...payload,
    sessions: [{
      id: "s1",
      hostId: "h1",
      hostLabel: "Host 1",
      hostname: "example.test",
      username: "root",
      status: "connected",
    }],
    tabOrder: ["s1"],
    activeTabId: "s1",
  } as unknown as SessionRestorePayload);

  assert.equal(storage.read()?.sessions[0].status, "disconnected");
});
