import test from "node:test";
import assert from "node:assert/strict";
import type { Host, Identity } from "./models";
import {
  listPasswordPromptFillCandidates,
  resolveDefaultPasswordPromptFillPassword,
} from "./passwordPromptAssist";

const baseHost = (overrides: Partial<Host> = {}): Host =>
  ({
    id: "h1",
    label: "Prod",
    hostname: "prod.example",
    port: 22,
    username: "alice",
    protocol: "ssh",
    ...overrides,
  }) as Host;

const identity = (overrides: Partial<Identity> & Pick<Identity, "id">): Identity =>
  ({
    label: overrides.label ?? overrides.id,
    username: overrides.username ?? "user",
    authMethod: overrides.authMethod ?? "password",
    created: overrides.created ?? 1,
    ...overrides,
  }) as Identity;

test("listPasswordPromptFillCandidates includes host password first", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ password: "host-secret" }),
    keys: [],
    identities: [],
  });
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    {
      id: candidates[0].id,
      source: candidates[0].source,
      label: candidates[0].label,
      username: candidates[0].username,
      password: candidates[0].password,
    },
    {
      id: "host",
      source: "host",
      label: "Prod",
      username: "alice",
      password: "host-secret",
    },
  );
});

test("listPasswordPromptFillCandidates includes password identities", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ password: "host-secret" }),
    keys: [],
    identities: [
      identity({ id: "i-root", label: "Root", username: "root", password: "root-secret", order: 2 }),
      identity({ id: "i-bob", label: "Bob", username: "bob", password: "bob-secret", order: 1 }),
    ],
  });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].id, "host");
  assert.equal(candidates[1].id, "identity:i-bob");
  assert.equal(candidates[2].id, "identity:i-root");
  assert.equal(candidates[1].password, "bob-secret");
});

test("listPasswordPromptFillCandidates skips key-only identities and placeholders", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ password: "enc:v1:djEwAAAA" }),
    keys: [],
    identities: [
      identity({ id: "key", authMethod: "key", password: undefined }),
      identity({ id: "bad", password: "enc:v1:djEwAAAA" }),
      identity({ id: "ok", password: "ok-secret" }),
    ],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "identity:ok");
});

test("listPasswordPromptFillCandidates respects host savePassword opt-out", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ password: "host-secret", savePassword: false }),
    keys: [],
    identities: [identity({ id: "i1", password: "id-secret" })],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, "identity:i1");
});

test("listPasswordPromptFillCandidates dedupes identical passwords", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ password: "same" }),
    keys: [],
    identities: [identity({ id: "i1", label: "Same as host", password: "same" })],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "host");
});

test("listPasswordPromptFillCandidates resolves host password from referenced identity", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ password: undefined, identityId: "i1" }),
    keys: [],
    identities: [identity({ id: "i1", username: "alice", password: "via-identity" })],
  });
  // Host resolves via identityId → host candidate; identity also listed but
  // same password is deduped, so only one entry remains (host first).
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "host");
  assert.equal(candidates[0].password, "via-identity");
});

test("listPasswordPromptFillCandidates uses the resolved identity username for host row", () => {
  const candidates = listPasswordPromptFillCandidates({
    host: baseHost({ username: "stale-host-user", password: undefined, identityId: "i-root" }),
    keys: [],
    identities: [identity({ id: "i-root", username: "root", password: "root-secret", label: "Root ID" })],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, "host");
  assert.equal(candidates[0].username, "root");
  assert.equal(candidates[0].password, "root-secret");
});

test("resolveDefaultPasswordPromptFillPassword prefers host", () => {
  assert.equal(
    resolveDefaultPasswordPromptFillPassword([
      { id: "host", source: "host", label: "H", password: "h" },
      { id: "identity:x", source: "identity", label: "X", password: "x" },
    ]),
    "h",
  );
  assert.equal(
    resolveDefaultPasswordPromptFillPassword([
      { id: "identity:x", source: "identity", label: "X", password: "x" },
    ]),
    "x",
  );
  assert.equal(resolveDefaultPasswordPromptFillPassword([]), undefined);
});
