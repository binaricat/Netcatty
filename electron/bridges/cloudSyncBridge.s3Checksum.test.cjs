const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildS3Client,
} = require("./cloudSyncBridge.cjs");

const config = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "netcatty-test",
  accessKeyId: "access",
  secretAccessKey: "secret",
  forcePathStyle: true,
};

test("S3 client only sends request checksums when required", async () => {
  const client = buildS3Client(config);
  assert.equal(await client.config.requestChecksumCalculation(), "WHEN_REQUIRED");
});

test("S3 client only validates response checksums when required", async () => {
  const client = buildS3Client(config);
  assert.equal(await client.config.responseChecksumValidation(), "WHEN_REQUIRED");
});
