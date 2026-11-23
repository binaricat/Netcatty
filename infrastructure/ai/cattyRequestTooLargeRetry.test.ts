import test from "node:test";
import assert from "node:assert/strict";

import {
  createCattyAnthropicSignatureRetryError,
  createCattyRequestTooLargeRetryError,
  hadToolProgressBeforeRequestTooLarge,
} from "./cattyRequestTooLargeRetry.ts";
import { isInvalidAnthropicThinkingSignatureError } from "./errorClassifier.ts";

test("createCattyRequestTooLargeRetryError marks 413 retry errors after tool progress", () => {
  const source = Object.assign(new Error("HTTP 413 Request Entity Too Large"), {
    status: 413,
    responseBody: "<html>too large</html>",
  });

  const retryError = createCattyRequestTooLargeRetryError(source, true);

  assert.equal(retryError.statusCode, 413);
  assert.equal(retryError.status, 413);
  assert.equal(retryError.responseBody, "<html>too large</html>");
  assert.equal(retryError.cause, source);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), true);
});

test("hadToolProgressBeforeRequestTooLarge is false when no tool progress was recorded", () => {
  const retryError = createCattyRequestTooLargeRetryError("HTTP 413", false);

  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), false);
  assert.equal(hadToolProgressBeforeRequestTooLarge(new Error("HTTP 413")), false);
});

test("createCattyAnthropicSignatureRetryError preserves classifier fields and tool progress", () => {
  const source = Object.assign(
    new Error("Invalid signature in thinking block. The block is bound to a different conversation."),
    {
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Invalid signature in thinking block. The block is bound to a different conversation.",
        },
      }),
    },
  );

  const retryError = createCattyAnthropicSignatureRetryError(source, true);

  assert.equal(retryError.statusCode, 400);
  assert.equal(retryError.responseBody, source.responseBody);
  assert.equal(retryError.cause, source);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), true);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});

test("createCattyAnthropicSignatureRetryError defaults status 400 and no progress", () => {
  const retryError = createCattyAnthropicSignatureRetryError(
    "Invalid signature in thinking block. The block is bound to a different conversation.",
    false,
  );

  assert.equal(retryError.statusCode, 400);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), false);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});

test("createCattyAnthropicSignatureRetryError preserves plain-object SSE signature message", () => {
  const source = {
    type: "invalid_request_error",
    message: "Invalid signature in thinking block",
    status: 400,
  };

  const retryError = createCattyAnthropicSignatureRetryError(source, false);

  assert.equal(retryError.message, "Invalid signature in thinking block");
  assert.notEqual(retryError.message, "[object Object]");
  assert.equal(retryError.statusCode, 400);
  assert.equal(retryError.status, 400);
  assert.equal(retryError.cause, source);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});

test("createCattyAnthropicSignatureRetryError preserves plain-object message with statusCode", () => {
  const source = {
    type: "invalid_request_error",
    message: "Invalid signature in thinking block. The block is bound to a different conversation.",
    statusCode: 400,
  };

  const retryError = createCattyAnthropicSignatureRetryError(source, true);

  assert.equal(
    retryError.message,
    "Invalid signature in thinking block. The block is bound to a different conversation.",
  );
  assert.equal(retryError.statusCode, 400);
  assert.equal(hadToolProgressBeforeRequestTooLarge(retryError), true);
  assert.equal(isInvalidAnthropicThinkingSignatureError(retryError), true);
});
