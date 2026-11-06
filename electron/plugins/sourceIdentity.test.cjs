"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { OFFICIAL_SOURCE, LOCAL_SOURCE, canonicalSourceOrigin, thirdPartySource, assertSource, privateOwner } = require("./sourceIdentity.cjs");

test("renames preserve source identity; public plugin IDs do not define private ownership", () => {
  const a = thirdPartySource("First", "https://EXAMPLE.com/v1/snapshot.json");
  const renamed = thirdPartySource("Renamed", "https://example.com/");
  assert.equal(a.id, renamed.id);
  const owners = [a, thirdPartySource("Other", "https://other.example.com"), OFFICIAL_SOURCE, LOCAL_SOURCE].map((source) => privateOwner(source, "example.plugin"));
  assert.equal(new Set(owners).size, 4);
  assert.equal(privateOwner(a, "example.plugin"), privateOwner(renamed, "example.plugin"));
  assert.throws(() => privateOwner(a, owners[0]));
});

test("remote metadata cannot promote a source to official or local", () => {
  const source = thirdPartySource("Netcatty", "https://example.com");
  for (const kind of ["official", "local"]) assert.throws(() => assertSource({ ...source, kind }));
  assert.throws(() => assertSource({ ...source, id: "official" }));
  assert.throws(() => thirdPartySource("Mirror", "https://plugins.netcatty.app"));
});

test("source addresses exclude secrets, ambiguous paths and local literals", () => {
  for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com?token=x", "https://example.com/#x", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://a.local", "https://example.com:8443", "https://example.com/../v1/snapshot.json", "https://example.com/%2e", "https://example.com\\@other.com", "https://example.com."]) {
    assert.throws(() => canonicalSourceOrigin(url), url);
  }
});
