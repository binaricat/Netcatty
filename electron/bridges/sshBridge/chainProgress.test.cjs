const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatChainHopAddress,
  resolveChainHopAddress,
  resolveChainTargetLabel,
} = require("./chainProgress.cjs");

test("formatChainHopAddress formats host:port and brackets bare IPv6", () => {
  assert.equal(formatChainHopAddress("10.0.0.5", 22), "10.0.0.5:22");
  assert.equal(formatChainHopAddress("bastion.example.com", 2222), "bastion.example.com:2222");
  assert.equal(formatChainHopAddress("10.0.0.5"), "10.0.0.5:22");
  assert.equal(formatChainHopAddress("fd00::5", 22), "[fd00::5]:22");
  assert.equal(formatChainHopAddress("[fd00::5]", 22), "[fd00::5]:22");
});

test("resolveChainHopAddress maps each hop of a long chain to its own address", () => {
  const jumps = [
    { hostname: "a.example.com", port: 22 },
    { hostname: "b.example.com", port: 2201 },
    { hostname: "fd00::c" },
  ];
  assert.equal(resolveChainHopAddress(jumps, "10.0.0.5", 22, 1), "a.example.com:22");
  assert.equal(resolveChainHopAddress(jumps, "10.0.0.5", 22, 2), "b.example.com:2201");
  assert.equal(resolveChainHopAddress(jumps, "10.0.0.5", 22, 3), "[fd00::c]:22");
  // The hop after the last jump host is the target.
  assert.equal(resolveChainHopAddress(jumps, "10.0.0.5", 22, 4), "10.0.0.5:22");
  // A direct connection only has the target.
  assert.equal(resolveChainHopAddress(undefined, "10.0.0.5", 2222, 1), "10.0.0.5:2222");
});

test("resolveChainTargetLabel names a chained target by its label, not its address", () => {
  assert.equal(
    resolveChainTargetLabel({ hostname: "10.0.0.5", hostLabel: "Prod DB" }, true),
    "Prod DB",
  );
  assert.equal(resolveChainTargetLabel({ hostname: "10.0.0.5", label: "Prod DB" }, true), "Prod DB");
  // Unlabeled target falls back to its address.
  assert.equal(resolveChainTargetLabel({ hostname: "10.0.0.5", hostLabel: "" }, true), "10.0.0.5");
  // Direct connections keep the address (unchanged behavior).
  assert.equal(
    resolveChainTargetLabel({ hostname: "10.0.0.5", hostLabel: "Prod DB" }, false),
    "10.0.0.5",
  );
});
