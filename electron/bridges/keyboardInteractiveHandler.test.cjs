const test = require("node:test");
const assert = require("node:assert/strict");

const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");

test("keyboard-interactive responses from the wrong renderer are rejected and kept pending", () => {
  const finishCalls = [];
  const requestId = keyboardInteractiveHandler.generateRequestId("test");
  keyboardInteractiveHandler.storeRequest(requestId, (responses) => {
    finishCalls.push(responses);
  }, 101, "session-1");

  const wrongResult = keyboardInteractiveHandler.handleResponse(
    { sender: { id: 202 } },
    { requestId, responses: ["wrong"] },
  );
  assert.deepEqual(wrongResult, { success: false, error: "Wrong sender" });
  assert.deepEqual(finishCalls, []);
  assert.equal(keyboardInteractiveHandler.getRequests().has(requestId), true);

  const correctResult = keyboardInteractiveHandler.handleResponse(
    { sender: { id: 101 } },
    { requestId, responses: ["correct"] },
  );
  assert.deepEqual(correctResult, { success: true });
  assert.deepEqual(finishCalls, [["correct"]]);
  assert.equal(keyboardInteractiveHandler.getRequests().has(requestId), false);
});
