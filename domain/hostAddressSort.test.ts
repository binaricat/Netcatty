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

test("compareHostAddresses sorts IPv6 hexadecimal words numerically", () => {
  assert.deepEqual(["2001:db8::10", "2001:db8::f", "2001:db8::2"].sort(compareHostAddresses), ["2001:db8::2", "2001:db8::f", "2001:db8::10"]);
  assert.equal(compareHostAddresses("[2001:db8::f]", "2001:0db8:0:0:0:0:0:000f"), 0);
  assert.equal(compareHostAddresses("fe80::1%eth0", "fe80::1%eth1"), 0);
  assert.equal(compareHostAddresses("::ffff:192.0.2.1", "::ffff:c000:201"), 0);
  assert.ok(compareHostAddresses("::", "::1") < 0);
});

test("compareHostAddresses orders mixed address families before hostnames", () => {
  assert.deepEqual(["host2", "2001:db8::1", "10.0.0.2", "host1", "::1"].sort(compareHostAddresses), ["10.0.0.2", "::1", "2001:db8::1", "host1", "host2"]);
  assert.ok(compareHostAddresses("::1", "not:an:ip") < 0);
});
