const fs = require("node:fs");
const path = require("node:path");

const YMODEM = Object.freeze({
  SOH: 0x01,
  STX: 0x02,
  EOT: 0x04,
  ACK: 0x06,
  NAK: 0x15,
  CAN: 0x18,
  CRC16: 0x43,
  BACKSPACE: 0x08,
  PACKET_SIZE_128: 128,
  PACKET_SIZE_1024: 1024,
});

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_LIMIT = 10;
const YMODEM_CANCEL_SEQUENCE = Buffer.from([
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
]);

class YmodemTransferError extends Error {
  constructor(message, code = "YMODEM_TRANSFER_ERROR") {
    super(message);
    this.name = "YmodemTransferError";
    this.code = code;
  }
}

function crc16Xmodem(buffer, start = 0, length = buffer.length - start) {
  let crc = 0;
  for (let i = start; i < start + length; i += 1) {
    let code = ((crc >>> 8) ^ buffer[i]) & 0xff;
    code ^= code >>> 4;
    crc = ((crc << 8) ^ (code << 12) ^ (code << 5) ^ code) & 0xffff;
  }
  return crc;
}

function createPacket(header, blockNumber, payload) {
  const size = payload.length;
  const packet = Buffer.alloc(3 + size + 2, 0x00);
  packet[0] = header;
  packet[1] = blockNumber & 0xff;
  packet[2] = 0xff - packet[1];
  payload.copy(packet, 3);
  packet.writeUInt16BE(crc16Xmodem(packet, 3, size), packet.length - 2);
  return packet;
}

function createYmodemFileInfoPacket({ filename, size, mtime = 0, mode = 0o100644 }) {
  const baseName = path.basename(filename || "file");
  const metadata = `${baseName}\0${size} ${Math.trunc(mtime).toString(8)} ${mode.toString(8)}`;
  const metadataBytes = Buffer.from(metadata, "utf8");
  const packetSize = metadataBytes.length >= YMODEM.PACKET_SIZE_128
    ? YMODEM.PACKET_SIZE_1024
    : YMODEM.PACKET_SIZE_128;
  const payload = Buffer.alloc(packetSize, 0x00);
  metadataBytes.copy(payload, 0, 0, Math.min(metadataBytes.length, packetSize));
  return createPacket(
    packetSize === YMODEM.PACKET_SIZE_1024 ? YMODEM.STX : YMODEM.SOH,
    0,
    payload,
  );
}

function createYmodemDataPackets(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  const packets = [];
  let blockNumber = 1;
  for (let offset = 0; offset < buffer.length; offset += YMODEM.PACKET_SIZE_1024) {
    const payload = Buffer.alloc(YMODEM.PACKET_SIZE_1024, 0x1a);
    buffer.copy(payload, 0, offset, Math.min(offset + YMODEM.PACKET_SIZE_1024, buffer.length));
    packets.push(createPacket(YMODEM.STX, blockNumber, payload));
    blockNumber = (blockNumber + 1) & 0xff;
  }
  return packets;
}

function createYmodemEndSessionPacket() {
  return createPacket(YMODEM.SOH, 0, Buffer.alloc(YMODEM.PACKET_SIZE_128, 0x00));
}

function writeAndDrain(serialPort, buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      if (err) {
        settled = true;
        reject(err);
        return;
      }
      if (typeof serialPort.drain !== "function") {
        settled = true;
        resolve();
        return;
      }
      serialPort.drain((drainErr) => {
        if (settled) return;
        settled = true;
        drainErr ? reject(drainErr) : resolve();
      });
    };

    try {
      serialPort.write(buffer, done);
    } catch (error) {
      reject(error);
    }
  });
}

function createSerialByteReader(serialPort, abortSignal) {
  const queue = [];
  const waiters = [];

  const rejectAll = (error) => {
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const onData = (chunk) => {
    for (const byte of Buffer.from(chunk)) {
      if (waiters.length) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(byte);
      } else {
        queue.push(byte);
      }
    }
  };

  const onAbort = () => {
    rejectAll(new YmodemTransferError("YMODEM transfer cancelled", "YMODEM_CANCELLED"));
  };
  const onError = (error) => {
    rejectAll(error instanceof Error ? error : new Error(String(error)));
  };
  const onClose = () => {
    rejectAll(new YmodemTransferError("Serial port closed during YMODEM transfer", "YMODEM_SERIAL_CLOSED"));
  };

  serialPort.on("data", onData);
  serialPort.on?.("error", onError);
  serialPort.on?.("close", onClose);
  abortSignal?.addEventListener?.("abort", onAbort, { once: true });

  return {
    unreadByte(byte) {
      queue.unshift(byte);
    },
    readByte(timeoutMs) {
      if (abortSignal?.aborted) {
        return Promise.reject(new YmodemTransferError("YMODEM transfer cancelled", "YMODEM_CANCELLED"));
      }
      if (queue.length) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new YmodemTransferError("Timed out waiting for YMODEM receiver", "YMODEM_TIMEOUT"));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    cleanup() {
      serialPort.off("data", onData);
      serialPort.off?.("error", onError);
      serialPort.off?.("close", onClose);
      abortSignal?.removeEventListener?.("abort", onAbort);
      rejectAll(new YmodemTransferError("YMODEM reader closed", "YMODEM_CLOSED"));
    },
  };
}

function sendYmodemCancel(serialPort) {
  if (!serialPort || typeof serialPort.write !== "function") return Promise.resolve();
  return writeAndDrain(serialPort, YMODEM_CANCEL_SEQUENCE).catch(() => {});
}

async function readExpected(reader, expected, timeoutMs, label) {
  for (;;) {
    const byte = await reader.readByte(timeoutMs);
    if (byte === YMODEM.CAN) {
      const next = await reader.readByte(1_000).catch(() => null);
      if (next === YMODEM.CAN) {
        throw new YmodemTransferError("YMODEM transfer cancelled by receiver", "YMODEM_REMOTE_CANCELLED");
      }
      if (next !== null) {
        reader.unreadByte?.(next);
      }
      continue;
    }
    if (expected.includes(byte)) return byte;
    if (byte === YMODEM.CRC16 && expected.includes(YMODEM.CRC16)) return byte;
    if (byte === YMODEM.NAK && expected.includes(YMODEM.NAK)) return byte;
    if (byte === YMODEM.ACK && expected.includes(YMODEM.ACK)) return byte;
    if (byte === YMODEM.CRC16 || byte === YMODEM.ACK || byte === YMODEM.NAK) continue;
    throw new YmodemTransferError(`Unexpected YMODEM byte while waiting for ${label}: 0x${byte.toString(16)}`);
  }
}

async function sendPacketWithRetry({ serialPort, reader, packet, timeoutMs, retryLimit, onProgress }) {
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    await writeAndDrain(serialPort, packet);
    onProgress?.();
    const response = await readExpected(reader, [YMODEM.ACK, YMODEM.NAK], timeoutMs, "packet ACK");
    if (response === YMODEM.ACK) return;
  }
  throw new YmodemTransferError("YMODEM receiver rejected the packet too many times", "YMODEM_RETRY_LIMIT");
}

async function sendYmodemBuffer(serialPort, {
  filename,
  buffer,
  mtime = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryLimit = DEFAULT_RETRY_LIMIT,
  abortSignal,
  onProgress,
} = {}) {
  if (!serialPort) {
    throw new YmodemTransferError("Serial session is not available", "YMODEM_NO_SERIAL");
  }
  const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const dataPackets = createYmodemDataPackets(fileBuffer);
  const packets = [
    createYmodemFileInfoPacket({ filename, size: fileBuffer.length, mtime }),
    ...dataPackets,
  ];
  const reader = createSerialByteReader(serialPort, abortSignal);
  let packetsSent = 0;

  try {
    await readExpected(reader, [YMODEM.CRC16], timeoutMs, "initial receiver request");
    await sendPacketWithRetry({
      serialPort,
      reader,
      packet: packets[0],
      timeoutMs,
      retryLimit,
      onProgress: () => {
        packetsSent += 1;
        onProgress?.({ transferredBytes: 0, totalBytes: fileBuffer.length, stage: "header" });
      },
    });

    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
      const response = await readExpected(reader, [YMODEM.CRC16, YMODEM.NAK], timeoutMs, "data receiver request");
      if (response === YMODEM.CRC16) break;
      await sendPacketWithRetry({
        serialPort,
        reader,
        packet: packets[0],
        timeoutMs,
        retryLimit,
        onProgress: () => {
          packetsSent += 1;
          onProgress?.({ transferredBytes: 0, totalBytes: fileBuffer.length, stage: "header" });
        },
      });
      if (attempt === retryLimit - 1) {
        throw new YmodemTransferError("YMODEM receiver did not request data after header", "YMODEM_RETRY_LIMIT");
      }
    }

    for (let i = 1; i < packets.length; i += 1) {
      await sendPacketWithRetry({
        serialPort,
        reader,
        packet: packets[i],
        timeoutMs,
        retryLimit,
        onProgress: () => {
          packetsSent += 1;
          onProgress?.({
            transferredBytes: Math.min(i * YMODEM.PACKET_SIZE_1024, fileBuffer.length),
            totalBytes: fileBuffer.length,
            stage: "data",
          });
        },
      });
    }

    await writeAndDrain(serialPort, Buffer.from([YMODEM.EOT]));
    const eotResponse = await readExpected(reader, [YMODEM.NAK, YMODEM.ACK], timeoutMs, "first EOT response");
    if (eotResponse === YMODEM.NAK) {
      await writeAndDrain(serialPort, Buffer.from([YMODEM.EOT]));
      await readExpected(reader, [YMODEM.ACK], timeoutMs, "second EOT ACK");
    }

    await readExpected(reader, [YMODEM.CRC16], timeoutMs, "end session request");
    await sendPacketWithRetry({
      serialPort,
      reader,
      packet: createYmodemEndSessionPacket(),
      timeoutMs,
      retryLimit,
    });

    onProgress?.({
      transferredBytes: fileBuffer.length,
      totalBytes: fileBuffer.length,
      stage: "complete",
    });

    return {
      fileName: path.basename(filename || "file"),
      totalBytes: fileBuffer.length,
      writtenBytes: fileBuffer.length,
      packetsSent,
    };
  } finally {
    reader.cleanup();
  }
}

async function sendYmodemFile(serialPort, filePath, options = {}) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) {
    throw new YmodemTransferError("Selected path is not a file", "YMODEM_NOT_FILE");
  }
  const buffer = await fs.promises.readFile(filePath);
  return sendYmodemBuffer(serialPort, {
    ...options,
    filename: filePath,
    buffer,
    mtime: Math.floor(stat.mtimeMs / 1000),
  });
}

module.exports = {
  YMODEM,
  YmodemTransferError,
  crc16Xmodem,
  createYmodemFileInfoPacket,
  createYmodemDataPackets,
  createYmodemEndSessionPacket,
  sendYmodemCancel,
  sendYmodemBuffer,
  sendYmodemFile,
};
