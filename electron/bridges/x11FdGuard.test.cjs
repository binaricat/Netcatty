const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createX11FdGuard, DEFAULT_HIDDEN_EXTENSIONS } = require("./x11FdGuard.cjs");

function writeUInt16(buffer, value, offset, endian) {
  buffer[endian === "l" ? "writeUInt16LE" : "writeUInt16BE"](value, offset);
}

function writeUInt32(buffer, value, offset, endian) {
  buffer[endian === "l" ? "writeUInt32LE" : "writeUInt32BE"](value, offset);
}

function setupRequest(endian = "l") {
  const packet = Buffer.alloc(24, 0xab);
  packet[0] = endian.charCodeAt(0);
  writeUInt16(packet, 11, 2, endian);
  writeUInt16(packet, 3, 6, endian);
  writeUInt16(packet, 5, 8, endian);
  return packet;
}

function setupReply(endian = "l", status = 1) {
  const packet = Buffer.alloc(20, 0xcd);
  packet[0] = status;
  writeUInt16(packet, 11, 2, endian);
  writeUInt16(packet, 3, 6, endian);
  return packet;
}

function request(name, { endian = "l", big = false, opcode = 98 } = {}) {
  const nameBytes = Buffer.from(name, "latin1");
  const prefix = big ? 12 : 8;
  const packet = Buffer.alloc(prefix + Math.ceil(nameBytes.length / 4) * 4);
  packet[0] = opcode;
  writeUInt16(packet, big ? 0 : packet.length / 4, 2, endian);
  if (big) writeUInt32(packet, packet.length / 4, 4, endian);
  writeUInt16(packet, nameBytes.length, big ? 8 : 4, endian);
  nameBytes.copy(packet, prefix);
  return packet;
}

function reply(sequence, { endian = "l", type = 1, present = 1, extra = 0 } = {}) {
  const packet = Buffer.alloc(32 + extra, 0xef);
  packet[0] = type;
  writeUInt16(packet, sequence, 2, endian);
  writeUInt32(packet, extra / 4, 4, endian);
  packet[8] = present;
  return packet;
}

function withoutPresent(packet) {
  const copy = Buffer.from(packet);
  copy[8] = 0;
  return copy;
}

function chunks(buffer, size) {
  if (!size) return [buffer];
  const result = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    result.push(buffer.subarray(offset, offset + size));
  }
  return result;
}

async function exchange(uplink, downlink, { chunkSize, ...options } = {}) {
  const warnings = [];
  const guard = createX11FdGuard({ logger: { warn: (message) => warnings.push(message) }, ...options });
  const sent = [];
  const received = [];
  guard.toServer.on("data", (chunk) => sent.push(chunk));
  guard.toClient.on("data", (chunk) => received.push(chunk));
  const ended = Promise.all([once(guard.toServer, "end"), once(guard.toClient, "end")]);
  for (const chunk of chunks(uplink, chunkSize)) guard.toServer.write(chunk);
  for (const chunk of chunks(downlink, chunkSize)) guard.toClient.write(chunk);
  guard.toServer.end();
  guard.toClient.end();
  await ended;
  assert.deepEqual(Buffer.concat(sent), uplink, "uplink must stay byte-identical");
  return { received: Buffer.concat(received), warnings };
}

for (const endian of ["l", "B"]) {
  for (const chunkSize of [undefined, 1]) {
    test(`default guard hides only DRI3 and MIT-SHM (${endian}, chunks ${chunkSize || "coalesced"})`, async () => {
      assert.deepEqual(DEFAULT_HIDDEN_EXTENSIONS, ["DRI3", "MIT-SHM"]);
      const names = ["DRI3", "GLX", "MIT-SHM", "RENDER", "dri3", "DRI3-extra", ""];
      const replies = names.map((_, index) => reply(index + 1, { endian }));
      const uplink = Buffer.concat([setupRequest(endian), ...names.map((name) => request(name, { endian }))]);
      const downlink = Buffer.concat([setupReply(endian), ...replies]);
      const expected = Buffer.concat([setupReply(endian), ...replies.map((packet, index) => (
        index === 0 || index === 2 ? withoutPresent(packet) : packet
      ))]);
      const result = await exchange(uplink, downlink, { chunkSize });
      assert.deepEqual(result.received, expected);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /^\[X11\] hiding DRI3/);
      assert.deepEqual(downlink, Buffer.concat([setupReply(endian), ...replies]), "input buffers must stay unchanged");
    });
  }

  test(`BIG-REQUESTS use the extended header offsets (${endian})`, async () => {
    const queries = [
      request("DRI3", { endian, big: true }),
      request("MIT-SHM", { endian, big: true }),
      request("GLX", { endian, big: true }),
      request("DRI3", { endian }),
    ];
    const replies = queries.map((_, index) => reply(index + 1, { endian }));
    const result = await exchange(
      Buffer.concat([setupRequest(endian), ...queries]),
      Buffer.concat([setupReply(endian), ...replies]),
      { chunkSize: 1 },
    );
    assert.deepEqual(result.received, Buffer.concat([
      setupReply(endian), withoutPresent(replies[0]), withoutPresent(replies[1]), replies[2], withoutPresent(replies[3]),
    ]));
  });
}

test("an empty hide list is byte-identical and a custom list replaces the defaults", async () => {
  const uplink = Buffer.concat([setupRequest(), request("DRI3"), request("MIT-SHM"), request("GLX")]);
  const replies = [reply(1), reply(2), reply(3)];
  const downlink = Buffer.concat([setupReply(), ...replies]);
  const disabled = await exchange(uplink, downlink, { hiddenExtensions: [], chunkSize: 1 });
  assert.deepEqual(disabled.received, downlink);
  assert.deepEqual(disabled.warnings, []);
  const custom = await exchange(uplink, downlink, { hiddenExtensions: ["GLX"], chunkSize: 1 });
  assert.deepEqual(custom.received, Buffer.concat([setupReply(), replies[0], replies[1], withoutPresent(replies[2])]));
  assert.equal(custom.warnings.length, 1);
  assert.match(custom.warnings[0], /hiding GLX/);
});

test("errors, unrelated replies, ordinary events and variable GenericEvents preserve sequence isolation", async () => {
  const uplink = Buffer.concat([setupRequest(), request("DRI3"), request("GLX"), request("MIT-SHM")]);
  const error = reply(1, { type: 0 });
  const afterError = reply(1);
  const unrelated = reply(2, { extra: 64 });
  const event = reply(3, { type: 12 });
  const generic = reply(3, { type: 35, extra: 48 });
  const sentGeneric = reply(3, { type: 0x80 | 35, extra: 12 });
  const hidden = reply(3);
  const repeated = reply(3);
  const prefix = [setupReply(), error, afterError, unrelated, event, generic, sentGeneric];
  const result = await exchange(uplink, Buffer.concat([...prefix, hidden, repeated]), { chunkSize: 1 });
  assert.deepEqual(result.received, Buffer.concat([...prefix, withoutPresent(hidden), repeated]));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /hiding MIT-SHM/);
});

test("absent extensions and failed queries do not log", async () => {
  const uplink = Buffer.concat([setupRequest(), request("DRI3"), request("MIT-SHM")]);
  const downlink = Buffer.concat([setupReply(), reply(1, { present: 0 }), reply(2, { type: 0 })]);
  const result = await exchange(uplink, downlink, { chunkSize: 1 });
  assert.deepEqual(result.received, downlink);
  assert.deepEqual(result.warnings, []);
});

test("request bodies are skipped without mistaking embedded queries for requests", async () => {
  const body = Buffer.alloc(128 * 1024);
  request("DRI3").copy(body, 0);
  const large = Buffer.alloc(8 + body.length);
  large[0] = 18; // ChangeProperty, using BIG-REQUESTS framing
  large.writeUInt32LE(large.length / 4, 4);
  body.copy(large, 8);
  const uplink = Buffer.concat([setupRequest(), large, request("MIT-SHM")]);
  const visible = reply(1, { extra: 128 * 1024 });
  const hidden = reply(2);
  const result = await exchange(uplink, Buffer.concat([setupReply(), visible, hidden]), { chunkSize: 17 });
  assert.deepEqual(result.received, Buffer.concat([setupReply(), visible, withoutPresent(hidden)]));
});

test("sequence wrap hides new queries and clears stale entries on reused sequences", async () => {
  const noOp = Buffer.from([127, 0, 1, 0]);
  const queries = [request("DRI3"), Buffer.concat(Array(65534).fill(noOp)), request("MIT-SHM"), noOp, request("DRI3")];
  const stale = reply(1);
  const wrapped = reply(0);
  const hidden = reply(2);
  const result = await exchange(
    Buffer.concat([setupRequest(), ...queries]),
    Buffer.concat([setupReply(), wrapped, stale, hidden]),
    { chunkSize: 13 },
  );
  assert.deepEqual(result.received, Buffer.concat([setupReply(), withoutPresent(wrapped), stale, withoutPresent(hidden)]));
});

test("setup failures and truncated headers flush unchanged", async () => {
  for (const status of [0, 2]) {
    const downlink = setupReply("B", status);
    const result = await exchange(setupRequest("B"), downlink, { chunkSize: 1 });
    assert.deepEqual(result.received, downlink);
  }
  const shortSetup = await exchange(setupRequest(), setupReply().subarray(0, 5), { chunkSize: 1 });
  assert.deepEqual(shortSetup.received, setupReply().subarray(0, 5));
  const partial = Buffer.concat([setupReply(), reply(1).subarray(0, 7)]);
  const result = await exchange(Buffer.concat([setupRequest(), request("DRI3")]), partial, { chunkSize: 1 });
  assert.deepEqual(result.received, partial);
});

test("non-X11 payloads pass through unchanged", async () => {
  const result = await exchange(Buffer.from("remote"), Buffer.from("local"), { chunkSize: 1 });
  assert.equal(result.received.toString(), "local");
});
