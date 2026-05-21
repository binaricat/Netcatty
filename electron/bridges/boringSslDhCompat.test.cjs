const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  installBoringSslDhCompat,
  MODP_GROUP_PRIMES,
} = require("./boringSslDhCompat.cjs");

test("falls back to an explicit-prime DH when the runtime lacks a named group", () => {
  // Simulate BoringSSL: the named lookup throws "Unknown DH group".
  const target = {
    createDiffieHellmanGroup(name) {
      throw new Error(`Unknown DH group: ${name}`);
    },
  };
  assert.equal(installBoringSslDhCompat(target), true);

  const dh = target.createDiffieHellmanGroup("modp2");
  // The fallback group uses the exact RFC 2409 group1 prime.
  assert.equal(dh.getPrime("hex").toUpperCase(), MODP_GROUP_PRIMES.modp2);

  // And it performs a real, correct DH exchange.
  const peer = crypto.createDiffieHellman(
    Buffer.from(MODP_GROUP_PRIMES.modp2, "hex"),
    Buffer.from([2]),
  );
  const ourPublic = dh.generateKeys();
  const peerPublic = peer.generateKeys();
  assert.ok(dh.computeSecret(peerPublic).equals(peer.computeSecret(ourPublic)));
});

test("uses the runtime's group when the name resolves (no fallback)", () => {
  let calls = 0;
  const sentinel = Symbol("native-group");
  const target = {
    createDiffieHellmanGroup() {
      calls += 1;
      return sentinel;
    },
  };
  installBoringSslDhCompat(target);

  assert.equal(target.createDiffieHellmanGroup("modp2"), sentinel);
  assert.equal(calls, 1);
});

test("rethrows the original error for groups it cannot back", () => {
  const target = {
    createDiffieHellmanGroup() {
      throw new Error("Unknown DH group");
    },
  };
  installBoringSslDhCompat(target);

  assert.throws(() => target.createDiffieHellmanGroup("modp-nonexistent"), /Unknown DH group/);
});

test("install is idempotent", () => {
  const target = {
    createDiffieHellmanGroup() {
      return null;
    },
  };
  assert.equal(installBoringSslDhCompat(target), true);
  assert.equal(installBoringSslDhCompat(target), false);
});

test("on this (OpenSSL) runtime the real modp2 still works through the shim", () => {
  // Sanity check against the actual crypto module: installing must not break the
  // normal path where the runtime resolves the group by name.
  const localCrypto = require("node:crypto");
  installBoringSslDhCompat(localCrypto);
  const dh = localCrypto.createDiffieHellmanGroup("modp2");
  assert.equal(dh.getPrime("hex").toUpperCase(), MODP_GROUP_PRIMES.modp2);
});
