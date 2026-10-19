"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSocks5RequestParser } = require("./socks5Request.cjs");

function harness() {
  const events = [];
  const parser = createSocks5RequestParser({
    onConnect: (host, port, remainder) => events.push({ host, port, remainder: [...remainder] }),
    onFailure: (code) => events.push({ failure: code }),
  });
  parser.onGreeting = () => events.push({ greeting: true });
  return { parser, events };
}

test("SOCKS5 parses split greeting and domain request with retained page bytes", () => {
  const { parser, events } = harness();
  parser.push(Buffer.from([5]));
  parser.push(Buffer.from([1, 0, 5, 1, 0, 3, 9, 108, 111]));
  parser.push(Buffer.from("calhost"));
  parser.push(Buffer.from([0, 80, 71, 69, 84]));
  assert.deepEqual(events, [
    { greeting: true },
    { host: "localhost", port: 80, remainder: [71, 69, 84] },
  ]);
});

test("SOCKS5 accepts IPv4 and IPv6 CONNECT targets", () => {
  const ipv4 = harness();
  ipv4.parser.push(Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
  assert.equal(ipv4.events[1].host, "127.0.0.1");
  const ipv6 = harness();
  ipv6.parser.push(Buffer.from([5, 1, 0, 5, 1, 0, 4, ...Array(15).fill(0), 1, 1, 187]));
  assert.equal(ipv6.events[1].host, "0:0:0:0:0:0:0:1");
  assert.equal(ipv6.events[1].port, 443);
});

test("SOCKS5 refuses unsupported commands and oversized handshakes", () => {
  const command = harness();
  command.parser.push(Buffer.from([5, 1, 0, 5, 3, 0, 1, 127, 0, 0, 1, 0, 80]));
  assert.deepEqual(command.events.at(-1), { failure: 7 });
  const oversized = harness();
  oversized.parser.push(Buffer.alloc(1025, 5));
  assert.deepEqual(oversized.events, [{ failure: 1 }]);
});
