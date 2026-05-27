import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveDefaultAlgorithms,
  SUPPORTED_ALGORITHMS_BY_CATEGORY,
} from "./sshAlgorithmList.ts";

test("effectiveDefaultAlgorithms (modern) never seeds legacy SHA-1 KEX", () => {
  const result = effectiveDefaultAlgorithms(false);
  assert.ok(!result.kex.includes("diffie-hellman-group1-sha1"));
  assert.ok(!result.kex.includes("diffie-hellman-group14-sha1"));
  assert.ok(!result.kex.includes("diffie-hellman-group-exchange-sha1"));
  // Modern KEX still present.
  assert.ok(result.kex.includes("curve25519-sha256"));
  assert.ok(result.kex.includes("diffie-hellman-group14-sha256"));
});

test("effectiveDefaultAlgorithms (modern) never seeds CBC / arcfour / MD5", () => {
  const result = effectiveDefaultAlgorithms(false);
  for (const algo of result.cipher) {
    assert.ok(!algo.endsWith("-cbc"), `${algo} is a CBC cipher and should not be in modern defaults`);
    assert.ok(!algo.startsWith("arcfour"), `${algo} (arcfour) should not be in modern defaults`);
    assert.ok(algo !== "3des-cbc", "3des-cbc is legacy");
  }
  for (const algo of result.hmac) {
    assert.ok(!algo.includes("md5"), `${algo} should not be in modern defaults`);
  }
});

test("effectiveDefaultAlgorithms (legacy) appends sha1 KEX, CBC, and ssh-dss", () => {
  const modern = effectiveDefaultAlgorithms(false);
  const legacy = effectiveDefaultAlgorithms(true);

  // Every modern algorithm is still present.
  for (const category of Object.keys(modern) as (keyof typeof modern)[]) {
    for (const algo of modern[category]) {
      assert.ok(legacy[category].includes(algo), `${algo} missing from legacy ${category}`);
    }
  }

  assert.ok(legacy.kex.includes("diffie-hellman-group14-sha1"));
  assert.ok(legacy.kex.includes("diffie-hellman-group1-sha1"));
  assert.ok(legacy.cipher.includes("aes128-cbc"));
  assert.ok(legacy.cipher.includes("3des-cbc"));
  assert.ok(legacy.serverHostKey.includes("ssh-dss"));
});

test("effectiveDefaultAlgorithms output is a subset of SUPPORTED_ALGORITHMS_BY_CATEGORY", () => {
  for (const enabled of [false, true]) {
    const result = effectiveDefaultAlgorithms(enabled);
    for (const category of Object.keys(result) as (keyof typeof result)[]) {
      const supported = SUPPORTED_ALGORITHMS_BY_CATEGORY[category];
      for (const algo of result[category]) {
        assert.ok(supported.includes(algo), `${algo} (${category}) not in supported list`);
      }
    }
  }
});
