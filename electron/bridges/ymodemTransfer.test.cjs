const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  YMODEM,
  createYmodemFileInfoPacket,
  createYmodemDataPackets,
  createYmodemEndSessionPacket,
  receiveYmodemFiles,
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

test("receives a YMODEM file into the selected directory", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ymodem-receive-"));
  try {
    const serial = new FakeSerialPort();
    const transfer = receiveYmodemFiles(serial, {
      destinationDir: targetDir,
      timeoutMs: 200,
    });

    await waitForWrites(serial, 1);
    assert.deepEqual([...serial.writes[0]], [YMODEM.CRC16]);

    serial.emit("data", createYmodemFileInfoPacket({
      filename: "device.log",
      size: 3,
      mtime: 0,
    }));
    await waitForWrites(serial, 3);
    assert.deepEqual([...serial.writes[1]], [YMODEM.ACK]);
    assert.deepEqual([...serial.writes[2]], [YMODEM.CRC16]);

    serial.emit("data", createYmodemDataPackets(Buffer.from("abc"))[0]);
    await waitForWrites(serial, 4);
    assert.deepEqual([...serial.writes[3]], [YMODEM.ACK]);

    serial.emit("data", Buffer.from([YMODEM.EOT]));
    await waitForWrites(serial, 5);
    assert.deepEqual([...serial.writes[4]], [YMODEM.NAK]);

    serial.emit("data", Buffer.from([YMODEM.EOT]));
    await waitForWrites(serial, 7);
    assert.deepEqual([...serial.writes[5]], [YMODEM.ACK]);
    assert.deepEqual([...serial.writes[6]], [YMODEM.CRC16]);

    serial.emit("data", createYmodemEndSessionPacket());
    await waitForWrites(serial, 8);
    assert.deepEqual([...serial.writes[7]], [YMODEM.ACK]);

    const result = await transfer;
    assert.deepEqual(result, {
      files: [{
        fileName: "device.log",
        filePath: path.join(targetDir, "device.log"),
        totalBytes: 3,
        writtenBytes: 3,
      }],
      fileCount: 1,
      totalBytes: 3,
      writtenBytes: 3,
      fileName: "device.log",
      filePath: path.join(targetDir, "device.log"),
    });
    assert.equal(fs.readFileSync(path.join(targetDir, "device.log"), "utf8"), "abc");
    assert.equal(serial.listenerCount("data"), 0);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test("rejects an incomplete received file and removes the partial file", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ymodem-short-"));
  try {
    const serial = new FakeSerialPort();
    const transfer = receiveYmodemFiles(serial, {
      destinationDir: targetDir,
      timeoutMs: 200,
    });
    const rejectedTransfer = assert.rejects(transfer, /incomplete/i);

    await waitForWrites(serial, 1);
    serial.emit("data", createYmodemFileInfoPacket({
      filename: "short.log",
      size: 1500,
      mtime: 0,
    }));
    await waitForWrites(serial, 3);

    serial.emit("data", createYmodemDataPackets(Buffer.alloc(1024, 0x61))[0]);
    await waitForWrites(serial, 4);

    serial.emit("data", Buffer.from([YMODEM.EOT]));
    await waitForWrites(serial, 5);
    serial.emit("data", Buffer.from([YMODEM.EOT]));
    await waitForWrites(serial, 6);

    await rejectedTransfer;
    assert.equal(fs.existsSync(path.join(targetDir, "short.log")), false);
    assert.equal(serial.listenerCount("data"), 0);
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test("does not delete an existing file if creating the receive target fails", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ymodem-race-"));
  const targetPath = path.join(targetDir, "race.log");
  const originalOpen = fs.promises.open;
  try {
    fs.promises.open = async (filePath, flags, ...args) => {
      if (filePath === targetPath && flags === "wx") {
        fs.writeFileSync(targetPath, "existing");
        const error = new Error("file exists");
        error.code = "EEXIST";
        throw error;
      }
      return originalOpen.call(fs.promises, filePath, flags, ...args);
    };

    const serial = new FakeSerialPort();
    const transfer = receiveYmodemFiles(serial, {
      destinationDir: targetDir,
      timeoutMs: 200,
    });
    const rejectedTransfer = assert.rejects(transfer, /file exists/i);

    await waitForWrites(serial, 1);
    serial.emit("data", createYmodemFileInfoPacket({
      filename: "race.log",
      size: 3,
      mtime: 0,
    }));
    await waitForWrites(serial, 3);

    await rejectedTransfer;
    assert.equal(fs.readFileSync(targetPath, "utf8"), "existing");
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
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
