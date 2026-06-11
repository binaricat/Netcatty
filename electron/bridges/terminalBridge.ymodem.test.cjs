const test = require("node:test");
const assert = require("node:assert/strict");

const terminalBridge = require("./terminalBridge.cjs");
const { YMODEM } = require("./ymodemTransfer.cjs");

function makeSerialPort() {
  return {
    writes: [],
    write(data, callback) {
      this.writes.push(Buffer.isBuffer(data) ? Buffer.from(data) : data);
      callback?.();
      return true;
    },
    drain(callback) {
      callback?.();
    },
  };
}

test("YMODEM transfer blocks normal serial input and Ctrl+C sends cancel bytes", () => {
  const sessions = new Map();
  const serialPort = makeSerialPort();
  const abortController = new AbortController();
  sessions.set("serial-1", {
    type: "serial",
    protocol: "serial",
    serialPort,
    ymodemActive: true,
    ymodemAbortController: abortController,
  });
  terminalBridge.init({ sessions, electronModule: {} });

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "serial-1", data: "show version\r" });
  assert.equal(serialPort.writes.length, 0);

  terminalBridge.writeToSession({ sender: {} }, { sessionId: "serial-1", data: "\x03" });
  assert.deepEqual(
    [...serialPort.writes[0]],
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
  assert.equal(abortController.signal.aborted, true);
});

test("YMODEM send is refused while ZMODEM owns the same serial session", async () => {
  const sessions = new Map();
  sessions.set("serial-1", {
    type: "serial",
    protocol: "serial",
    serialPort: makeSerialPort(),
    zmodemSentry: {
      isActive() {
        return true;
      },
    },
  });
  terminalBridge.init({ sessions, electronModule: {} });

  const result = await terminalBridge.sendSerialYmodem({ sender: {} }, {
    sessionId: "serial-1",
    filePath: "/tmp/firmware.bin",
  });

  assert.equal(result.success, false);
  assert.match(result.error, /file transfer is already in progress/);
});
