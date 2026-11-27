"use strict";

/**
 * Pure EBML / WebM Info.Duration patcher.
 *
 * Chromium's MediaRecorder produces streaming WebM files without a Duration
 * element inside Segment -> Info, causing `<video>` players to show Infinity
 * duration until scrubbed to the end. This module patches or inserts the
 * `Duration` (0x4489) element in-place (when already present) or by rewriting
 * only the Segment/Info header while streaming the remaining clusters so even
 * multi-hundred-MB recordings use minimal memory.
 */

const fs = require("node:fs");
const { pipeline } = require("node:stream/promises");

const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_INFO = 0x1549a966;
const EBML_ID_CLUSTER = 0x1f43b675;
const EBML_ID_TIMESTAMPSCALE = 0x2ad7b1;
const EBML_ID_DURATION = 0x4489;
const EBML_ID_VOID = 0xec;

const DEFAULT_TIMESTAMPSCALE_NS = 1_000_000; // 1 ms per tick

function readVintId(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || offset + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + buf[offset + i];
  }
  return { id: value, length };
}

function readVintSize(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > buf.length) return null;

  const firstDataBits = first & (mask - 1);
  let allOnes = firstDataBits === mask - 1;
  let value = BigInt(firstDataBits);
  for (let i = 1; i < length; i += 1) {
    const byte = buf[offset + i];
    if (byte !== 0xff) allOnes = false;
    value = (value << 8n) | BigInt(byte);
  }
  if (allOnes) {
    return { size: null, unknown: true, length };
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return { size: Number(value), unknown: false, length };
}

function encodeVintSize(value, minWidth = 1) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid EBML VINT size: ${value}`);
  }
  const big = BigInt(value);
  let width = Math.max(1, minWidth);
  while (width <= 8) {
    const dataBits = 7 * width;
    // All-1s value is reserved for "unknown size", so max finite value is (2^dataBits - 2).
    const maxFinite = (1n << BigInt(dataBits)) - 2n;
    if (big <= maxFinite) break;
    width += 1;
  }
  if (width > 8) {
    throw new RangeError(`EBML VINT size exceeds 8-byte limit: ${value}`);
  }
  const out = Buffer.alloc(width);
  let remaining = big;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  out[0] |= 1 << (8 - width);
  return out;
}

function readUintBE(buf, offset, length) {
  if (length <= 0 || length > 8 || offset + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + buf[offset + i];
  }
  return value;
}

function buildDurationElement(durationTicks) {
  const out = Buffer.alloc(11);
  out[0] = 0x44;
  out[1] = 0x89;
  out[2] = 0x88; // VINT size = 8
  out.writeDoubleBE(durationTicks, 3);
  return out;
}

/**
 * Inspect the WebM EBML header/Segment/Info layout within `buf`.
 */
function inspectWebmInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  let pos = 0;
  let segment = null;
  while (pos < buf.length) {
    const idInfo = readVintId(buf, pos);
    if (!idInfo) return null;
    const sizeInfo = readVintSize(buf, pos + idInfo.length);
    if (!sizeInfo) return null;
    const dataStart = pos + idInfo.length + sizeInfo.length;
    if (idInfo.id === EBML_ID_SEGMENT) {
      segment = {
        offset: pos,
        sizeOffset: pos + idInfo.length,
        sizeLength: sizeInfo.length,
        size: sizeInfo.size,
        unknownSize: sizeInfo.unknown,
        dataStart,
        end: sizeInfo.unknown ? buf.length : Math.min(buf.length, dataStart + sizeInfo.size),
      };
      break;
    }
    if (sizeInfo.unknown) return null;
    pos = dataStart + sizeInfo.size;
  }

  if (!segment) return null;

  let cursor = segment.dataStart;
  while (cursor < segment.end) {
    const idInfo = readVintId(buf, cursor);
    if (!idInfo) break;
    const sizeInfo = readVintSize(buf, cursor + idInfo.length);
    if (!sizeInfo) break;
    const dataStart = cursor + idInfo.length + sizeInfo.length;
    if (idInfo.id === EBML_ID_INFO) {
      if (sizeInfo.unknown || dataStart + sizeInfo.size > buf.length) {
        return null;
      }
      const infoEnd = dataStart + sizeInfo.size;
      let timestampScale = DEFAULT_TIMESTAMPSCALE_NS;
      let durationEl = null;
      let voidEl = null;

      let childPos = dataStart;
      while (childPos < infoEnd) {
        const cId = readVintId(buf, childPos);
        if (!cId) break;
        const cSize = readVintSize(buf, childPos + cId.length);
        if (!cSize || cSize.unknown) break;
        const cDataStart = childPos + cId.length + cSize.length;
        const cEnd = cDataStart + cSize.size;
        if (cEnd > infoEnd) break;

        if (cId.id === EBML_ID_TIMESTAMPSCALE) {
          const parsedScale = readUintBE(buf, cDataStart, cSize.size);
          if (parsedScale && parsedScale > 0) {
            timestampScale = parsedScale;
          }
        } else if (cId.id === EBML_ID_DURATION && (cSize.size === 4 || cSize.size === 8)) {
          durationEl = {
            offset: childPos,
            dataStart: cDataStart,
            dataLength: cSize.size,
            value: cSize.size === 8
              ? buf.readDoubleBE(cDataStart)
              : buf.readFloatBE(cDataStart),
          };
        } else if (cId.id === EBML_ID_VOID && !voidEl && cEnd - childPos >= 11) {
          voidEl = {
            offset: childPos,
            end: cEnd,
            totalLength: cEnd - childPos,
          };
        }

        childPos = cEnd;
      }

      return {
        segment,
        info: {
          offset: cursor,
          sizeOffset: cursor + idInfo.length,
          sizeLength: sizeInfo.length,
          size: sizeInfo.size,
          dataStart,
          end: infoEnd,
        },
        timestampScale,
        durationEl,
        voidEl,
      };
    }

    if (idInfo.id === EBML_ID_CLUSTER) {
      // Info precedes clusters in valid WebM streams.
      break;
    }
    if (sizeInfo.unknown) break;
    cursor = dataStart + sizeInfo.size;
  }

  return null;
}

/**
 * Read WebM Duration in milliseconds from a Buffer, or null if absent/invalid.
 */
function readWebmDurationMs(buf) {
  const layout = inspectWebmInfo(buf);
  if (!layout || !layout.durationEl) return null;
  const ticks = layout.durationEl.value;
  if (!Number.isFinite(ticks) || ticks < 0) return null;
  return (ticks * layout.timestampScale) / 1_000_000;
}

/**
 * Return a new Buffer with `Info.Duration` patched to `durationMs`, or the
 * original Buffer unchanged if the input is not a patchable WebM buffer.
 */
function patchWebmDuration(buf, durationMs) {
  if (!Buffer.isBuffer(buf) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return buf;
  }
  const layout = inspectWebmInfo(buf);
  if (!layout) return buf;

  const durationTicks = (durationMs * 1_000_000) / layout.timestampScale;

  // Fast path 1: Duration element already exists -> overwrite float in-place.
  if (layout.durationEl) {
    const out = Buffer.from(buf);
    if (layout.durationEl.dataLength === 8) {
      out.writeDoubleBE(durationTicks, layout.durationEl.dataStart);
    } else {
      out.writeFloatBE(durationTicks, layout.durationEl.dataStart);
    }
    return out;
  }

  const durationBytes = buildDurationElement(durationTicks);

  // Fast path 2: Replace a Void padding element inside Info without shifting offsets.
  if (layout.voidEl) {
    const remaining = layout.voidEl.totalLength - durationBytes.length;
    if (remaining === 0 || remaining >= 2) {
      const out = Buffer.from(buf);
      durationBytes.copy(out, layout.voidEl.offset);
      if (remaining >= 2) {
        const voidStart = layout.voidEl.offset + durationBytes.length;
        const sizeBytes = encodeVintSize(remaining - 2, 1);
        if (1 + sizeBytes.length <= remaining) {
          const payloadLen = remaining - 1 - sizeBytes.length;
          const adjustedSize = encodeVintSize(payloadLen, sizeBytes.length);
          if (adjustedSize.length === sizeBytes.length) {
            out[voidStart] = EBML_ID_VOID;
            adjustedSize.copy(out, voidStart + 1);
            out.fill(0, voidStart + 1 + adjustedSize.length, layout.voidEl.end);
            return out;
          }
        }
      } else {
        return out;
      }
    }
  }

  // Insertion path: append Duration at the end of Info and update Info (and finite Segment) sizes.
  const newInfoDataSize = layout.info.size + durationBytes.length;
  const newInfoSizeVint = encodeVintSize(newInfoDataSize, layout.info.sizeLength);
  const infoGrowth = durationBytes.length + (newInfoSizeVint.length - layout.info.sizeLength);

  const parts = [];
  if (!layout.segment.unknownSize && typeof layout.segment.size === "number") {
    const newSegmentSize = layout.segment.size + infoGrowth;
    const newSegmentSizeVint = encodeVintSize(newSegmentSize, layout.segment.sizeLength);
    parts.push(
      buf.subarray(0, layout.segment.sizeOffset),
      newSegmentSizeVint,
      buf.subarray(layout.segment.dataStart, layout.info.sizeOffset),
    );
  } else {
    parts.push(buf.subarray(0, layout.info.sizeOffset));
  }

  parts.push(
    newInfoSizeVint,
    buf.subarray(layout.info.dataStart, layout.info.end),
    durationBytes,
    buf.subarray(layout.info.end),
  );

  return Buffer.concat(parts);
}

/**
 * Patch `Info.Duration` in a WebM file on disk with O(64 KB) memory usage.
 * Returns `{ patched: boolean, bytesDelta: number }`.
 */
async function patchWebmDurationFile(filePath, durationMs) {
  if (typeof filePath !== "string" || !filePath || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { patched: false, bytesDelta: 0 };
  }

  const HEADER_PROBE_BYTES = 64 * 1024;
  const handle = await fs.promises.open(filePath, "r+");
  let stat;
  let headerBuf;
  try {
    stat = await handle.stat();
    const readLen = Math.min(stat.size, HEADER_PROBE_BYTES);
    if (readLen < 12) return { patched: false, bytesDelta: 0 };
    headerBuf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(headerBuf, 0, readLen, 0);
    headerBuf = headerBuf.subarray(0, bytesRead);

    const layout = inspectWebmInfo(headerBuf);
    if (!layout) {
      return { patched: false, bytesDelta: 0 };
    }

    const durationTicks = (durationMs * 1_000_000) / layout.timestampScale;

    // In-place overwrite when Duration element already exists.
    if (layout.durationEl) {
      const floatBuf = Buffer.alloc(layout.durationEl.dataLength);
      if (layout.durationEl.dataLength === 8) {
        floatBuf.writeDoubleBE(durationTicks, 0);
      } else {
        floatBuf.writeFloatBE(durationTicks, 0);
      }
      await handle.write(floatBuf, 0, floatBuf.length, layout.durationEl.dataStart);
      return { patched: true, bytesDelta: 0 };
    }
  } finally {
    await handle.close();
  }

  // Need to insert Duration element into Info -> stream-rewrite to a temp file and atomically replace.
  const layout = inspectWebmInfo(headerBuf);
  if (!layout) return { patched: false, bytesDelta: 0 };

  const prefixPatched = patchWebmDuration(headerBuf.subarray(0, layout.info.end), durationMs);
  const bytesDelta = prefixPatched.length - layout.info.end;
  if (bytesDelta === 0) {
    // Void-replacement in-place succeeded without size change.
    const fh = await fs.promises.open(filePath, "r+");
    try {
      await fh.write(prefixPatched, 0, prefixPatched.length, 0);
    } finally {
      await fh.close();
    }
    return { patched: true, bytesDelta: 0 };
  }

  const tmpPath = `${filePath}.dur`;
  try {
    const outStream = fs.createWriteStream(tmpPath, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      outStream.once("error", reject);
      if (outStream.write(prefixPatched)) {
        resolve();
      } else {
        outStream.once("drain", resolve);
      }
    });

    if (layout.info.end < stat.size) {
      const tailStream = fs.createReadStream(filePath, { start: layout.info.end });
      await pipeline(tailStream, outStream);
    } else {
      await new Promise((resolve, reject) => {
        outStream.once("error", reject);
        outStream.end(resolve);
      });
    }

    await fs.promises.rename(tmpPath, filePath);
    return { patched: true, bytesDelta };
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

module.exports = {
  EBML_ID_SEGMENT,
  EBML_ID_INFO,
  EBML_ID_CLUSTER,
  EBML_ID_TIMESTAMPSCALE,
  EBML_ID_DURATION,
  EBML_ID_VOID,
  readVintId,
  readVintSize,
  encodeVintSize,
  inspectWebmInfo,
  readWebmDurationMs,
  patchWebmDuration,
  patchWebmDurationFile,
};
