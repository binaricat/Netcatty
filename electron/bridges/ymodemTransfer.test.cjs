const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  YMODEM,
  createYmodemFileInfoPacket,
  createYmodemDataPackets,
  createYmodemEndSessionPacket,
  sendYmodemCancel,
  sendYmodemBuffer,
} = require("./ymodemTransfer.cjs");

class FakeSerialPort extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(buffer, callback) {
    this.writes.push(Buffer.from(buffer));
    callback?.();
    return true;
  }

  drain(callback) {
    callback?.();
  }
}

test("builds a YMODEM file info packet with filename, size, and CRC", () => {
  const packet = createYmodemFileInfoPacket({
    filename: "/tmp/firmware.bin",
    size: 1234,
    mtime: 0o1234567,
  });

  assert.equal(packet.length, 133);
  assert.equal(packet[0], YMODEM.SOH);
  assert.equal(packet[1], 0);
  assert.equal(packet[2], 0xff);
  assert.equal(packet.subarray(3, 15).toString("ascii"), "firmware.bin");
  assert.equal(packet[15], 0);
  assert.match(packet.subarray(16, 32).toString("ascii"), /^1234 1234567/);
  assert.notEqual(packet.readUInt16BE(packet.length - 2), 0);
});

test("uses a 1K file info packet when metadata fills a 128 byte packet", () => {
  const packet = createYmodemFileInfoPacket({
    filename: `${"a".repeat(117)}`,
    size: 1,
    mtime: 0,
  });

  assert.equal(packet.length, 1029);
  assert.equal(packet[0], YMODEM.STX);
});

test("builds 1K data packets padded like terminal YMODEM senders", () => {
  const packets = createYmodemDataPackets(Buffer.from("abc"));

  assert.equal(packets.length, 1);
  assert.equal(packets[0].length, 1029);
  assert.equal(packets[0][0], YMODEM.STX);
  assert.equal(packets[0][1], 1);
  assert.equal(packets[0][2], 0xfe);
  assert.equal(packets[0].subarray(3, 6).toString("ascii"), "abc");
  assert.equal(packets[0][6], 0x1a);
});

test("ignores a lone cancel byte without dropping the following receiver response", async () => {
  const serial = new FakeSerialPort();
  const transfer = sendYmodemBuffer(serial, {
    filename: "firmware.bin",
    buffer: Buffer.from("abc"),
    timeoutMs: 200,
  });

  serial.emit("data", Buffer.from([YMODEM.CRC16]));
  await waitForWrites(serial, 1);

  serial.emit("data", Buffer.from([YMODEM.CAN, YMODEM.ACK, YMODEM.CRC16]));
  await waitForWrites(serial, 2);
  assert.equal(serial.writes[1][0], YMODEM.STX);

  serial.emit("data", Buffer.from([YMODEM.ACK]));
  await waitForWrites(serial, 3);

  serial.emit("data", Buffer.from([YMODEM.ACK, YMODEM.CRC16]));
  await waitForWrites(serial, 4);

  serial.emit("data", Buffer.from([YMODEM.ACK]));
  await transfer;
});

test("resends the file info packet when the receiver NAKs before data", async () => {
  const serial = new FakeSerialPort();
  const transfer = sendYmodemBuffer(serial, {
    filename: "firmware.bin",
    buffer: Buffer.from("abc"),
    timeoutMs: 200,
  });

  serial.emit("data", Buffer.from([YMODEM.CRC16]));
  await waitForWrites(serial, 1);
  assert.equal(serial.writes[0][0], YMODEM.SOH);

  serial.emit("data", Buffer.from([YMODEM.ACK, YMODEM.NAK]));
  await waitForWrites(serial, 2);
  assert.equal(serial.writes[1][0], YMODEM.SOH);

  serial.emit("data", Buffer.from([YMODEM.ACK, YMODEM.CRC16]));
  await waitForWrites(serial, 3);
  assert.equal(serial.writes[2][0], YMODEM.STX);

  serial.emit("data", Buffer.from([YMODEM.ACK]));
  await waitForWrites(serial, 4);

  serial.emit("data", Buffer.from([YMODEM.ACK, YMODEM.CRC16]));
  await waitForWrites(serial, 5);

  serial.emit("data", Buffer.from([YMODEM.ACK]));
  await transfer;
});

test("sends with the Tera Term compatible YMODEM handshake", async () => {
  const serial = new FakeSerialPort();
  const transfer = sendYmodemBuffer(serial, {
    filename: "firmware.bin",
    buffer: Buffer.from("abc"),
    timeoutMs: 200,
  });

  serial.emit("data", Buffer.from([YMODEM.CRC16]));
  await waitForWrites(serial, 1);
  assert.equal(serial.writes[0][0], YMODEM.SOH);

  serial.emit("data", Buffer.from([YMODEM.ACK, YMODEM.CRC16]));
  await waitForWrites(serial, 2);
  assert.equal(serial.writes[1][0], YMODEM.STX);

  serial.emit("data", Buffer.from([YMODEM.ACK]));
  await waitForWrites(serial, 3);
  assert.deepEqual([...serial.writes[2]], [YMODEM.EOT]);

  serial.emit("data", Buffer.from([YMODEM.NAK]));
  await waitForWrites(serial, 4);
  assert.deepEqual([...serial.writes[3]], [YMODEM.EOT]);

  serial.emit("data", Buffer.from([YMODEM.ACK, YMODEM.CRC16]));
  await waitForWrites(serial, 5);
  assert.deepEqual(serial.writes[4], createYmodemEndSessionPacket());

  serial.emit("data", Buffer.from([YMODEM.ACK]));
  const result = await transfer;
  assert.deepEqual(result, {
    fileName: "firmware.bin",
    totalBytes: 3,
    writtenBytes: 3,
    packetsSent: 2,
  });
  assert.equal(serial.listenerCount("data"), 0);
});

test("fails immediately when the serial port closes during transfer", async () => {
  const serial = new FakeSerialPort();
  const transfer = sendYmodemBuffer(serial, {
    filename: "firmware.bin",
    buffer: Buffer.from("abc"),
    timeoutMs: 5_000,
  });

  serial.emit("data", Buffer.from([YMODEM.CRC16]));
  await waitForWrites(serial, 1);
  serial.emit("close");

  await assert.rejects(transfer, /Serial port closed during YMODEM transfer/);
  assert.equal(serial.listenerCount("data"), 0);
});

test("sends the Tera Term style cancel sequence", async () => {
  const serial = new FakeSerialPort();

  await sendYmodemCancel(serial);

  assert.deepEqual(
    [...serial.writes[0]],
    [
      YMODEM.CAN,
      YMODEM.CAN,
      YMODEM.CAN,
      YMODEM.CAN,
      YMODEM.CAN,
      YMODEM.BACKSPACE,
      YMODEM.BACKSPACE,
      YMODEM.BACKSPACE,
      YMODEM.BACKSPACE,
      YMODEM.BACKSPACE,
    ],
  );
});

function waitForWrites(serial, count) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (serial.writes.length >= count) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 500) {
        reject(new Error(`Timed out waiting for ${count} serial writes`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}
