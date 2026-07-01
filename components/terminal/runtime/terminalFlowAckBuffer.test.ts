import assert from "node:assert/strict";
import test from "node:test";

import { FLOW_CHAR_COUNT_ACK_SIZE } from "./terminalFlowConstants.ts";
import {
  ackTerminalSessionFlow,
  clearTerminalSessionFlowAck,
  createFlowAckBuffer,
  flushTerminalSessionFlowAck,
} from "./terminalFlowAckBuffer.ts";

test("createFlowAckBuffer emits fixed-size batches like VS Code AckDataBufferer", () => {
  const acked: number[] = [];
  const buffer = createFlowAckBuffer((bytes) => acked.push(bytes));

  buffer.ack(FLOW_CHAR_COUNT_ACK_SIZE);
  assert.deepEqual(acked, []);

  buffer.ack(1);
  assert.deepEqual(acked, [FLOW_CHAR_COUNT_ACK_SIZE]);

  buffer.ack(FLOW_CHAR_COUNT_ACK_SIZE);
  assert.deepEqual(acked, [FLOW_CHAR_COUNT_ACK_SIZE, FLOW_CHAR_COUNT_ACK_SIZE]);

  buffer.ack(FLOW_CHAR_COUNT_ACK_SIZE + 1);
  assert.deepEqual(acked, [
    FLOW_CHAR_COUNT_ACK_SIZE,
    FLOW_CHAR_COUNT_ACK_SIZE,
    FLOW_CHAR_COUNT_ACK_SIZE,
  ]);
});

test("flushTerminalSessionFlowAck drains the remainder", () => {
  const acked: number[] = [];
  const buffer = createFlowAckBuffer((bytes) => acked.push(bytes), 100);

  buffer.ack(250);
  assert.deepEqual(acked, [100, 100]);
  buffer.flush();
  assert.deepEqual(acked, [100, 100, 50]);
});

test("ackTerminalSessionFlow batches per session", () => {
  const acked: Array<{ sessionId: string; bytes: number }> = [];
  const backend = {
    ackSessionFlow: (sessionId: string, bytes: number) => {
      acked.push({ sessionId, bytes });
    },
  };

  ackTerminalSessionFlow(backend, "sess-a", FLOW_CHAR_COUNT_ACK_SIZE + 1);
  ackTerminalSessionFlow(backend, "sess-b", 10);
  flushTerminalSessionFlowAck("sess-a");
  flushTerminalSessionFlowAck("sess-b");

  assert.deepEqual(acked, [
    { sessionId: "sess-a", bytes: FLOW_CHAR_COUNT_ACK_SIZE },
    { sessionId: "sess-a", bytes: 1 },
    { sessionId: "sess-b", bytes: 10 },
  ]);

  clearTerminalSessionFlowAck("sess-a");
  clearTerminalSessionFlowAck("sess-b");
});