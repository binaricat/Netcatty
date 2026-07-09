import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

import terminalFlowConstantsJson from "../../../infrastructure/config/terminalFlowConstants.json";
import {
  FLOW_CHAR_COUNT_ACK_SIZE,
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
  MAX_PENDING_WRITE_COALESCE_BYTES,
  MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
  MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES,
  TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS,
  TERMINAL_LONG_LINE_PRESSURE_BYTES,
  XTERM_WRITE_CALLBACK_BATCH_BYTES,
  XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
} from "./terminalFlowConstants.ts";
import { createOutputFlowController } from "./outputFlowController.ts";

const require = createRequire(import.meta.url);
const sharedConstantsCjs = require("../../../infrastructure/config/terminalFlowConstants.cjs") as typeof terminalFlowConstantsJson;

test("renderer flow constants match shared terminalFlowConstants.json", () => {
  assert.equal(FLOW_HIGH_WATER_MARK, terminalFlowConstantsJson.FLOW_HIGH_WATER_MARK);
  assert.equal(FLOW_LOW_WATER_MARK, terminalFlowConstantsJson.FLOW_LOW_WATER_MARK);
  assert.equal(FLOW_CHAR_COUNT_ACK_SIZE, terminalFlowConstantsJson.FLOW_CHAR_COUNT_ACK_SIZE);
  assert.equal(
    MAX_PENDING_WRITE_COALESCE_BYTES,
    terminalFlowConstantsJson.MAX_PENDING_WRITE_COALESCE_BYTES,
  );
  assert.equal(
    MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
    terminalFlowConstantsJson.MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD,
  );
  assert.equal(
    MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
    terminalFlowConstantsJson.MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES,
  );
  assert.equal(
    MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
    terminalFlowConstantsJson.MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES,
  );
  assert.equal(
    MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES,
    terminalFlowConstantsJson.MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES,
  );
  assert.equal(
    TERMINAL_LONG_LINE_PRESSURE_BYTES,
    terminalFlowConstantsJson.TERMINAL_LONG_LINE_PRESSURE_BYTES,
  );
  assert.equal(
    TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS,
    terminalFlowConstantsJson.TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS,
  );
  assert.equal(
    XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
    terminalFlowConstantsJson.XTERM_WRITE_CALLBACK_FAST_PATH_MAX_BYTES,
  );
  assert.equal(
    XTERM_WRITE_CALLBACK_BATCH_BYTES,
    terminalFlowConstantsJson.XTERM_WRITE_CALLBACK_BATCH_BYTES,
  );
  assert.deepEqual(sharedConstantsCjs, terminalFlowConstantsJson);
  assert.ok(FLOW_CHAR_COUNT_ACK_SIZE <= FLOW_LOW_WATER_MARK);
  assert.ok(MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD < MAX_PENDING_WRITE_COALESCE_BYTES);
});

test("terminal flood limits keep interactive acks responsive", () => {
  assert.ok(FLOW_LOW_WATER_MARK <= 8 * 1024);
  assert.ok(FLOW_CHAR_COUNT_ACK_SIZE <= 4 * 1024);
  // Flood coalesce must stay below bulk so TUI frames can interleave, but stay
  // large enough that plain-text dumps (#1961) do not collapse into 8KB shards.
  assert.ok(MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD <= 256 * 1024);
  assert.ok(MAX_PENDING_WRITE_COALESCE_BYTES_FLOOD >= 64 * 1024);
  assert.ok(MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES <= FLOW_HIGH_WATER_MARK);
  assert.ok(MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES <= 4 * 1024);
  assert.ok(MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES <= FLOW_HIGH_WATER_MARK);
  // Drain enough per event-loop turn that a 1MB high-water backlog does not
  // require dozens of setTimeout(0) yields before SSH can resume.
  assert.ok(MAX_TERMINAL_WRITE_QUEUE_DRAIN_BYTES >= 128 * 1024);
  assert.ok(TERMINAL_LONG_LINE_PRESSURE_BYTES >= MAX_TERMINAL_UNBROKEN_WRITE_CHUNK_BYTES);
  assert.ok(TERMINAL_AUX_LONG_LINE_SCAN_LIMIT_CHARS >= TERMINAL_LONG_LINE_PRESSURE_BYTES);
  assert.ok(XTERM_WRITE_CALLBACK_BATCH_BYTES <= FLOW_HIGH_WATER_MARK);
});

test("terminal bulk output limits preserve large renderer write batches", () => {
  const bulkWriteFloorBytes = 1024 * 1024;
  assert.ok(
    MAX_PENDING_WRITE_COALESCE_BYTES >= bulkWriteFloorBytes,
    `MAX_PENDING_WRITE_COALESCE_BYTES (${MAX_PENDING_WRITE_COALESCE_BYTES}) should keep multi-MB tail output in large batches`,
  );
  assert.ok(
    MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES >= bulkWriteFloorBytes,
    `MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES (${MAX_TERMINAL_PLAIN_WRITE_CHUNK_BYTES}) should not split bulk plain output into small writes`,
  );
});

test("terminal flow allows a large TUI repaint before applying back-pressure", () => {
  const events: string[] = [];
  const controller = createOutputFlowController({
    highWaterMark: FLOW_HIGH_WATER_MARK,
    lowWaterMark: FLOW_LOW_WATER_MARK,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });

  const tuiFrameBytes = 80 * 1024;
  const chunkBytes = 4 * 1024;
  for (let received = 0; received < tuiFrameBytes; received += chunkBytes) {
    controller.received(chunkBytes);
  }

  assert.deepEqual(events, []);
});

test("flow high-water mark stays clear of the ssh2 channel window (issue #1961)", () => {
  // Pausing the source stream for SSH means calling ssh2 channel pause(),
  // which stops the remote from sending until resume() + a full round-trip.
  // ssh2's own channel window is 2MB (WINDOW_THRESHOLD 1MB), so a small
  // high-water mark makes Netcatty pause/resume dozens of times during a
  // multi-MB dump (e.g. `tail -2000f big.log`). Each cycle costs ~1 RTT, so
  // on a WAN link the dump crawls (reported ~20s vs ~2s in other clients).
  // Keep the high-water mark near the ssh2 window so bulk output flows in a
  // handful of pause cycles instead of dozens.
  const SSH2_CHANNEL_WINDOW_THRESHOLD_BYTES = 1024 * 1024;
  assert.ok(
    FLOW_HIGH_WATER_MARK >= SSH2_CHANNEL_WINDOW_THRESHOLD_BYTES,
    `FLOW_HIGH_WATER_MARK (${FLOW_HIGH_WATER_MARK}) should be at least the ssh2 window threshold (${SSH2_CHANNEL_WINDOW_THRESHOLD_BYTES})`,
  );

  // A 4MB bulk dump should trigger only a few pause cycles, not dozens.
  const events: string[] = [];
  const controller = createOutputFlowController({
    highWaterMark: FLOW_HIGH_WATER_MARK,
    lowWaterMark: FLOW_LOW_WATER_MARK,
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
  });
  const totalBytes = 4 * 1024 * 1024;
  const chunkBytes = 32 * 1024; // ssh2 PACKET_SIZE
  let delivered = 0;
  let pauses = 0;
  for (let sent = 0; sent < totalBytes; sent += chunkBytes) {
    controller.received(chunkBytes);
    if (controller.isPaused()) {
      pauses += 1;
      // Renderer catches up and drains the backlog before the source resumes.
      controller.written(controller.pendingBytes());
      delivered = sent + chunkBytes;
    }
  }
  controller.written(totalBytes - delivered);
  assert.ok(pauses <= 8, `expected few pause cycles for a 4MB dump, got ${pauses}`);
});
