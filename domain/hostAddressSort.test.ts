import test from "node:test";
import assert from "node:assert/strict";

import { compareHostAddresses } from "./hostAddressSort.ts";

test("compareHostAddresses sorts IPv4 numerically", () => {
  const addresses = ["10.0.0.10", "10.0.0.2", "192.168.1.1", "10.0.0.1"];
  const sorted = [...addresses].sort(compareHostAddresses);
  assert.deepEqual(sorted, ["10.0.0.1", "10.0.0.2", "10.0.0.10", "192.168.1.1"]);
});

test("compareHostAddresses places IPv4 before hostnames", () => {
  assert.ok(compareHostAddresses("10.0.0.1", "db.example.com") < 0);
  assert.ok(compareHostAddresses("db.example.com", "10.0.0.1") > 0);
});

test("compareHostAddresses sorts hostnames with numeric awareness", () => {
  const names = ["host10.example.com", "host2.example.com", "host1.example.com"];
  const sorted = [...names].sort(compareHostAddresses);
  assert.deepEqual(sorted, [
    "host1.example.com",
    "host2.example.com",
    "host10.example.com",
  ]);
});

test("compareHostAddresses treats equal addresses as equal", () => {
  assert.equal(compareHostAddresses("10.0.0.1", "10.0.0.1"), 0);
  assert.equal(compareHostAddresses(" 10.0.0.1 ", "10.0.0.1"), 0);
});
