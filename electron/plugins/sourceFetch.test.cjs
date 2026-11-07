"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSourceFetch, isPublicAddress } = require("./sourceFetch.cjs");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

test("source transport refuses non-public resolution before any HTTP request", async () => {
  let requests = 0;
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.64.1.1", "224.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(address), false);
    const fetch = createSourceFetch("https://example.com", { resolve4: async () => [address], request() { requests++; } });
    await assert.rejects(fetch("https://example.com/v1/snapshot.json"), /non-public/);
  }
  assert.equal(requests, 0);
  assert.equal(isPublicAddress("1.1.1.1"), true);
});

test("static resources cannot redirect requests to unrelated origins or arbitrary paths", async () => {
  let resolutions = 0;
  const fetch = createSourceFetch("https://example.com", { resolve4: async () => { resolutions++; return ["1.1.1.1"]; } });
  for (const value of ["https://other.com/v1/snapshot.json", "https://example.com/admin", "https://example.com/assets/%2e%2e/secret", "https://example.com/v1/snapshot.json?token=secret", "https://user:pass@example.com/v1/snapshot.json"]) await assert.rejects(fetch(value));
  assert.equal(resolutions, 0);
});

test("the HTTPS connection uses the checked address without a second DNS lookup or credentials", async () => {
  let resolutions = 0;
  const fetch = createSourceFetch("https://example.com", {
    resolve4: async () => { resolutions++; return resolutions === 1 ? ["1.1.1.1"] : ["127.0.0.1"]; },
    request(url, options, callback) {
      assert.equal(url.hostname, "example.com");
      assert.equal(options.agent, false);
      assert.equal(options.headers.cookie, undefined);
      assert.equal(options.headers.authorization, undefined);
      options.lookup("example.com", { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "1.1.1.1", family: 4 }]);
      });
      const response = Readable.from([Buffer.from("synthetic metadata")]);
      response.statusCode = 200; response.headers = {};
      callback(response);
      return new EventEmitter();
    },
  });
  assert.equal(await (await fetch("https://example.com/v1/snapshot.json")).text(), "synthetic metadata");
  assert.equal(resolutions, 1);
});
