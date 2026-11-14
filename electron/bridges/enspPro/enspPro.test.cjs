"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EnspPlatformClient,
  EnspPlatformError,
  createCookieJar,
  normalizeHost,
} = require("./platform.cjs");
const {
  encodeClientFrame,
  parseStompFrames,
  stompFrame,
} = require("./console.cjs");

test("normalizeHost accepts a full URL and drops the scheme and trailing slash", () => {
  assert.equal(normalizeHost("https://192.168.31.211/"), "192.168.31.211");
  assert.equal(normalizeHost("http://10.0.0.1:8443"), "10.0.0.1:8443");
  assert.equal(normalizeHost("  192.168.31.11  "), "192.168.31.11");
});

test("the cookie jar merges set-cookie headers and keeps the last value per name", () => {
  const jar = createCookieJar();
  jar.absorb({ getSetCookie: () => ["JSESSIONID=abc; Path=/; HttpOnly", "csrfToken=one; Path=/"] });
  jar.absorb({ getSetCookie: () => ["csrfToken=two; Path=/"] });
  assert.equal(jar.size, 2);
  assert.match(jar.header(), /JSESSIONID=abc/);
  assert.match(jar.header(), /csrfToken=two/);
  assert.doesNotMatch(jar.header(), /csrfToken=one/);
});

test("sandbox pages flatten into the sandbox and device lists the dialog needs", async () => {
  const client = new EnspPlatformClient({ host: "192.168.31.211", port: 8443 });
  client.listSandboxes = async () => ([
    {
      id: 1,
      name: "11",
      status: 1,
      devices: [
        { id: 1, name: "CE-1", hostIp: "127.0.0.1", deviceType: { name: "CE" } },
        { id: 2, name: "AR-1", hostIp: "127.0.0.2" },
      ],
    },
  ]);
  const { sandboxes, devices } = await client.listDevices();
  assert.equal(sandboxes.length, 1);
  assert.equal(sandboxes[0].name, "11");
  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], {
    sandboxId: 1,
    sandboxName: "11",
    nodeId: 1,
    name: "CE-1",
    deviceType: "CE",
    status: null,
    hostIp: "127.0.0.1",
    manageIp: "",
  });
  assert.equal(devices[1].deviceType, "");
});

test("STOMP frames put the body after a blank line and terminate with NUL", () => {
  const frame = stompFrame("SEND", { destination: "/app/console/message/1/1" }, "show version\r");
  assert.match(frame, /^SEND\n/);
  assert.match(frame, /destination:\/app\/console\/message\/1\/1/);
  assert.match(frame, /content-length:\d+/);
  assert.match(frame, /content-type:text\/plain;charset=UTF-8/);
  assert.ok(frame.endsWith("\0"));
  assert.ok(frame.includes("\n\nshow version\r\0"));
});

test("a frame without a body has no content-length header", () => {
  const frame = stompFrame("CONNECT", { host: "192.168.31.211", "heart-beat": "0,0" });
  assert.doesNotMatch(frame, /content-length/);
  assert.ok(frame.endsWith("\n\n\0"));
});

test("parseStompFrames reads one SockJS message per entry and strips the NUL", () => {
  const frames = parseStompFrames([
    "CONNECTED\nversion:1.2\nuser-name:1\n\n\u0000",
    "MESSAGE\ndestination:/user/topic/console/message/1/1\n\nPassword:\u0000",
    "true",
  ]);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].command, "CONNECTED");
  assert.equal(frames[0].headers.version, "1.2");
  assert.equal(frames[1].command, "MESSAGE");
  assert.equal(frames[1].body, "Password:");
  assert.equal(frames[2].command, "true");
});

test("parseStompFrames tolerates a header-only frame without a body", () => {
  const frames = parseStompFrames(["HEARTBEAT\n\n"]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].command, "HEARTBEAT");
  assert.equal(frames[0].body, "");
});

test("client frames are masked, text-opcode and carry the payload", () => {
  const frame = encodeClientFrame('["hello"]');
  assert.equal(frame[0] & 0x0f, 0x1, "opcode should be text");
  assert.equal(frame[0] & 0x80, 0x80, "FIN bit should be set");
  assert.equal(frame[1] & 0x80, 0x80, "client frames must be masked");
  const length = frame[1] & 0x7f;
  const mask = frame.subarray(2, 6);
  const payload = Buffer.from(frame.subarray(6, 6 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  assert.equal(payload.toString("utf8"), '["hello"]');
});

test("platform errors keep the server message so the dialog can show it", () => {
  const error = new EnspPlatformError("eNSP Pro login failed: 您尚未登录", { stage: "login", status: 401 });
  assert.equal(error.name, "EnspPlatformError");
  assert.deepEqual(error.details, { stage: "login", status: 401 });
  assert.match(error.message, /您尚未登录/);
  assert.equal(new EnspPlatformError("no details").details, null);
});
