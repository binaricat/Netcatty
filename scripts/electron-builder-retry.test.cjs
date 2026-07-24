const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");

test("electron-builder classifies Fetch API 5xx responses as retryable", async () => {
  const modulePath = require.resolve("app-builder-lib/out/util/electronGet.js");
  const localRequire = createRequire(modulePath);
  const runtime = localRequire("builder-util-runtime");
  const retryDescriptor = Object.getOwnPropertyDescriptor(runtime, "retry");
  let retryOptions;

  Object.defineProperty(runtime, "retry", {
    configurable: true,
    value: async (_task, options) => {
      retryOptions = options;
      throw new Error("retry-probe");
    },
  });
  delete require.cache[modulePath];

  try {
    const electronGet = require(modulePath);
    await assert.rejects(
      electronGet.downloadElectronArtifactZip({
        version: "99.99.99",
        platformName: "darwin",
        arch: "x64",
        artifactName: "electron-retry-probe",
      }),
      /retry-probe/,
    );

    assert.equal(retryOptions.shouldRetry({ response: { status: 504 } }), true);
    assert.equal(retryOptions.shouldRetry({ response: { statusCode: 503 } }), true);
    assert.equal(retryOptions.shouldRetry({ response: { status: 404 } }), false);
    assert.equal(retryOptions.shouldRetry({ code: "ECONNRESET" }), true);
  } finally {
    Object.defineProperty(runtime, "retry", retryDescriptor);
    delete require.cache[modulePath];
  }
});
