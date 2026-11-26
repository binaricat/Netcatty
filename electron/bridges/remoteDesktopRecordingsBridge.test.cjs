"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EBML_ID_CLUSTER,
  EBML_ID_INFO,
  EBML_ID_SEGMENT,
  EBML_ID_TIMESTAMPSCALE,
  encodeVintSize,
  patchWebmDuration,
  patchWebmDurationFile,
  readWebmDurationMs,
} = require("./webmDurationPatch.cjs");

const {
  createRemoteDesktopRecordingsBridge,
  isValidRecordingId,
  parseByteRange,
  sanitizeExportFileName,
} = require("./remoteDesktopRecordingsBridge.cjs");

function buildElement(idBytes, payload) {
  const idBuf = Buffer.from(idBytes);
  const sizeBuf = encodeVintSize(payload.length);
  return Buffer.concat([idBuf, sizeBuf, payload]);
}

function buildMinimalWebm({ includeDuration = false, initialDurationMs = 0, unknownSegment = true } = {}) {
  // EBML Header (0x1A45DFA3) with minimal DocType "webm"
  const docType = buildElement([0x42, 0x82], Buffer.from("webm", "ascii"));
  const ebmlHeader = buildElement([0x1a, 0x45, 0xdf, 0xa3], docType);

  // Info children: TimestampScale = 1_000_000 (0x0F4240)
  const tsScalePayload = Buffer.from([0x0f, 0x42, 0x40]);
  const tsScaleEl = buildElement([0x2a, 0xd7, 0xb1], tsScalePayload);
  const infoChildren = [tsScaleEl];
  if (includeDuration) {
    const durBuf = Buffer.alloc(8);
    durBuf.writeDoubleBE(initialDurationMs, 0);
    infoChildren.push(buildElement([0x44, 0x89], durBuf));
  }
  const infoEl = buildElement([0x15, 0x49, 0xa9, 0x66], Buffer.concat(infoChildren));

  // Minimal Cluster element following Info
  const clusterEl = buildElement([0x1f, 0x43, 0xb6, 0x75], Buffer.from([0xe7, 0x81, 0x00, 0xaa, 0xbb, 0xcc]));

  const segId = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const segBody = Buffer.concat([infoEl, clusterEl]);
  const segSize = unknownSegment
    ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    : encodeVintSize(segBody.length);

  return Buffer.concat([ebmlHeader, segId, segSize, segBody]);
}

test("webmDurationPatch inserts Info.Duration when missing and updates in-place when present", () => {
  assert.equal(EBML_ID_SEGMENT, 0x18538067);
  assert.equal(EBML_ID_INFO, 0x1549a966);
  assert.equal(EBML_ID_CLUSTER, 0x1f43b675);
  assert.equal(EBML_ID_TIMESTAMPSCALE, 0x2ad7b1);

  // Case 1: Streaming MediaRecorder WebM (unknown Segment size, no Duration)
  const rawMissing = buildMinimalWebm({ includeDuration: false, unknownSegment: true });
  assert.equal(readWebmDurationMs(rawMissing), null);

  const patched = patchWebmDuration(rawMissing, 12345);
  assert.equal(readWebmDurationMs(patched), 12345);
  assert.equal(patched.length, rawMissing.length + 11);

  // Case 2: Finite Segment size, no Duration
  const finiteMissing = buildMinimalWebm({ includeDuration: false, unknownSegment: false });
  const patchedFinite = patchWebmDuration(finiteMissing, 67890);
  assert.equal(readWebmDurationMs(patchedFinite), 67890);

  // Case 3: Existing Duration overwritten in-place without length change
  const rawExisting = buildMinimalWebm({ includeDuration: true, initialDurationMs: 100 });
  assert.equal(readWebmDurationMs(rawExisting), 100);
  const updated = patchWebmDuration(rawExisting, 45678);
  assert.equal(readWebmDurationMs(updated), 45678);
  assert.equal(updated.length, rawExisting.length);
});

test("patchWebmDurationFile patches file on disk preserving trailing payload", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-webm-patch-"));
  try {
    const filePath = path.join(tmpDir, "sample.webm");
    const webm = buildMinimalWebm({ includeDuration: false, unknownSegment: true });
    const tail = Buffer.alloc(1024, 0x5a);
    await fs.promises.writeFile(filePath, Buffer.concat([webm, tail]));

    const res = await patchWebmDurationFile(filePath, 9876);
    assert.equal(res.patched, true);
    assert.equal(res.bytesDelta, 11);

    const after = await fs.promises.readFile(filePath);
    assert.equal(readWebmDurationMs(after), 9876);
    assert.deepEqual(after.subarray(after.length - tail.length), tail);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});

test("isValidRecordingId and sanitizeExportFileName reject traversal and unsafe characters", () => {
  assert.equal(isValidRecordingId("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isValidRecordingId("../etc/passwd"), false);
  assert.equal(isValidRecordingId("123e4567-e89b-12d3-a456-426614174000.webm"), false);
  assert.equal(isValidRecordingId("not-a-uuid"), false);

  assert.equal(
    sanitizeExportFileName("../../evil:name?.webm", "abc"),
    "evil_name_.webm",
  );
  assert.equal(
    sanitizeExportFileName("prod-rdp-2026", "abc"),
    "prod-rdp-2026.webm",
  );
});

test("parseByteRange handles valid, open-ended, suffix, and invalid ranges", () => {
  assert.deepEqual(parseByteRange("bytes=0-9", 100), { ok: true, start: 0, end: 9 });
  assert.deepEqual(parseByteRange("bytes=50-", 100), { ok: true, start: 50, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-20", 100), { ok: true, start: 80, end: 99 });
  assert.deepEqual(parseByteRange("bytes=90-500", 100), { ok: true, start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=100-120", 100), { ok: false, unsatisfied: true });
  assert.deepEqual(parseByteRange("bytes=50-10", 100), { ok: false, unsatisfied: true });
  assert.deepEqual(parseByteRange("items=0-5", 100), { ok: false, unsatisfied: true });
});

test("remoteDesktopRecordingsBridge end-to-end: streaming write, duration patch, 206 Range, export, delete, and GC protecting saved logs", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nc-rec-bridge-"));
  const exportTarget = path.join(tmpDir, "exported.webm");

  try {
    const recordingsDir = path.join(tmpDir, "recordings");
    const openedPaths = [];
    const bridge = createRemoteDesktopRecordingsBridge({
      recordingsDir,
      launchToken: "test-launch-token-123",
      dialog: {
        showSaveDialog: async () => ({ canceled: false, filePath: exportTarget }),
      },
      shell: {
        openPath: async (p) => {
          openedPaths.push(p);
          return "";
        },
      },
    });

    // 1. Begin -> append chunks -> finish with EBML duration patch
    const { recordingId } = await bridge.begin({
      mimeType: "video/webm;codecs=vp9,opus",
      hostLabel: "win-prod",
      protocol: "rdp",
    });
    assert.equal(isValidRecordingId(recordingId), true);

    const webm = buildMinimalWebm({ includeDuration: false, unknownSegment: true });
    const mid = Math.floor(webm.length / 2);
    const r1 = await bridge.append({ recordingId, chunk: new Uint8Array(webm.subarray(0, mid)) });
    assert.equal(r1.bytesWritten, mid);
    const r2 = await bridge.append({ recordingId, chunk: new Uint8Array(webm.subarray(mid)) });
    assert.equal(r2.bytesWritten, webm.length);

    const finished = await bridge.finish({
      recordingId,
      durationMs: 42000,
      hasAudio: true,
    });
    assert.equal(finished.recordingId, recordingId);
    assert.equal(finished.durationMs, 42000);
    assert.equal(finished.bytes, webm.length + 11);
    assert.equal(
      finished.playbackUrl,
      `netcatty-media://recording/${recordingId}?token=test-launch-token-123`,
    );

    const diskBytes = await fs.promises.readFile(path.join(recordingsDir, `${recordingId}.webm`));
    assert.equal(readWebmDurationMs(diskBytes), 42000);

    // 2. getPlaybackUrl
    const urlInfo = await bridge.getPlaybackUrl({ recordingId });
    assert.equal(urlInfo.exists, true);
    assert.equal(urlInfo.bytes, finished.bytes);
    assert.equal(urlInfo.url, finished.playbackUrl);

    // Path traversal rejected
    const badUrl = await bridge.getPlaybackUrl({ recordingId: "../secret" });
    assert.deepEqual(badUrl, { url: null, exists: false });

    // 3. HTTP 206 Range streaming handler
    // Bad token -> 403
    const forbidden = await bridge.handleMediaProtocolRequest({
      url: `netcatty-media://recording/${recordingId}?token=wrong`,
      method: "GET",
      headers: new Headers(),
    });
    assert.equal(forbidden.status, 403);

    // Non-UUID -> 400
    const badReq = await bridge.handleMediaProtocolRequest({
      url: `netcatty-media://recording/..%2Fetc%2Fpasswd?token=test-launch-token-123`,
      method: "GET",
      headers: new Headers(),
    });
    assert.equal(badReq.status, 400);

    // Full 200 GET
    const fullResp = await bridge.handleMediaProtocolRequest({
      url: finished.playbackUrl,
      method: "GET",
      headers: new Headers(),
    });
    assert.equal(fullResp.status, 200);
    assert.equal(fullResp.headers.get("content-type"), "video/webm");
    assert.equal(fullResp.headers.get("accept-ranges"), "bytes");
    const fullBody = Buffer.from(await fullResp.arrayBuffer());
    assert.deepEqual(fullBody, diskBytes);

    // Partial 206 GET
    const rangeResp = await bridge.handleMediaProtocolRequest({
      url: finished.playbackUrl,
      method: "GET",
      headers: new Headers({ Range: "bytes=4-15" }),
    });
    assert.equal(rangeResp.status, 206);
    assert.equal(rangeResp.headers.get("content-range"), `bytes 4-15/${diskBytes.length}`);
    assert.equal(rangeResp.headers.get("content-length"), "12");
    const rangeBody = Buffer.from(await rangeResp.arrayBuffer());
    assert.deepEqual(rangeBody, diskBytes.subarray(4, 16));

    // Unsatisfiable Range -> 416
    const badRangeResp = await bridge.handleMediaProtocolRequest({
      url: finished.playbackUrl,
      method: "GET",
      headers: new Headers({ Range: `bytes=${diskBytes.length + 50}-` }),
    });
    assert.equal(badRangeResp.status, 416);

    // 4. Export via copyFile
    const exp = await bridge.exportRecording({}, {
      recordingId,
      defaultFileName: "win-prod_rdp.webm",
    });
    assert.deepEqual(exp, { saved: true, filePath: exportTarget });
    const exportedBytes = await fs.promises.readFile(exportTarget);
    assert.deepEqual(exportedBytes, diskBytes);

    // 5. Open folder & stats
    const folderRes = await bridge.openFolder();
    assert.equal(folderRes.ok, true);
    assert.deepEqual(openedPaths, [recordingsDir]);

    const stats1 = await bridge.getStats();
    assert.equal(stats1.count, 1);
    assert.equal(stats1.totalBytes, diskBytes.length);

    // 6. Quota & retention GC protects bookmarked/saved logs
    const { recordingId: rec2 } = await bridge.begin({ protocol: "vnc" });
    await bridge.append({ recordingId: rec2, chunk: Buffer.alloc(200, 0x11) });
    await bridge.finish({ recordingId: rec2, durationMs: 5000 });

    const { recordingId: rec3 } = await bridge.begin({ protocol: "vnc" });
    await bridge.append({ recordingId: rec3, chunk: Buffer.alloc(200, 0x22) });
    await bridge.finish({ recordingId: rec3, durationMs: 5000 });

    // Set mtimes: recordingId (oldest, protected), rec2 (middle, evictable), rec3 (newest, evictable)
    const now = Date.now();
    await fs.promises.utimes(path.join(recordingsDir, `${recordingId}.webm`), (now - 100_000) / 1000, (now - 100_000) / 1000);
    await fs.promises.utimes(path.join(recordingsDir, `${rec2}.webm`), (now - 50_000) / 1000, (now - 50_000) / 1000);
    await fs.promises.utimes(path.join(recordingsDir, `${rec3}.webm`), (now - 10_000) / 1000, (now - 10_000) / 1000);

    // Quota smaller than total (diskBytes + 400) but large enough for diskBytes + 200
    const gcRes = await bridge.runGc({
      maxBytes: diskBytes.length + 220,
      protectedIds: [recordingId],
    });
    assert.equal(gcRes.deleted, 1);
    assert.equal((await bridge.getPlaybackUrl({ recordingId })).exists, true);
    assert.equal((await bridge.getPlaybackUrl({ recordingId: rec2 })).exists, false);
    assert.equal((await bridge.getPlaybackUrl({ recordingId: rec3 })).exists, true);

    // 7. Abort cleans up .part file
    const { recordingId: recAborted } = await bridge.begin({ protocol: "rdp" });
    await bridge.append({ recordingId: recAborted, chunk: Buffer.from([1, 2, 3]) });
    const abortRes = await bridge.abort({ recordingId: recAborted });
    assert.equal(abortRes.ok, true);
    assert.equal(fs.existsSync(path.join(recordingsDir, `${recAborted}.webm.part`)), false);

    // 8. deleteMany + clearAll
    const delManyRes = await bridge.deleteMany({ recordingIds: [rec3, "../traversal"] });
    assert.equal(delManyRes.deleted, 1);

    const clearRes = await bridge.clearAll({ protectedIds: [recordingId] });
    assert.equal(clearRes.deleted, 0);
    assert.equal((await bridge.getPlaybackUrl({ recordingId })).exists, true);

    const clearAllUnprotected = await bridge.clearAll({});
    assert.equal(clearAllUnprotected.deleted, 1);
    const finalStats = await bridge.getStats();
    assert.equal(finalStats.count, 0);
    assert.equal(finalStats.totalBytes, 0);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
});
