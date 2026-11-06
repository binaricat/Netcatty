// Intentionally limited browser example, not a general database driver. Supports
// protocol 4.1, mysql_native_password, and exactly one fixed text result column.
// The fixture account's server-side SELECT grant enforces access control.
export const READ_QUERY = "SELECT value FROM plugin_demo.example_result LIMIT 1";
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder("utf-8", { fatal: true });
const MAX_PACKET = 64 * 1024 - 1;
const MAX_TOTAL = 512 * 1024;
const CLIENT_FLAGS = 1 | 4 | 8 | 0x200 | 0x2000 | 0x8000 | 0x80000;

function reject() { throw new Error("Unsupported or invalid example database response"); }
function concat(...chunks) {
  const value = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; }
  return value;
}
function zeroText(text) { return concat(encoder.encode(text), Uint8Array.of(0)); }
function uint32(value) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

class Cursor {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  take(length) {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.length) reject();
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  byte() { return this.take(1)[0]; }
  short() { const bytes = this.take(2); return bytes[0] | (bytes[1] << 8); }
  text() {
    const end = this.bytes.indexOf(0, this.offset);
    if (end === -1) reject();
    const result = decoder.decode(this.take(end - this.offset));
    this.byte();
    return result;
  }
  lengthText() {
    const marker = this.byte();
    if (marker === 0xfb) return null;
    const length = marker < 0xfb ? marker : marker === 0xfc ? this.short() : reject();
    if (length > 4096) reject();
    return decoder.decode(this.take(length));
  }
}

class Packets {
  constructor(stream) { this.stream = stream; this.pending = new Uint8Array(); this.offset = 0; this.total = 0; this.packets = 0; }
  async exact(length) {
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      if (this.offset === this.pending.length) {
        this.pending = await this.stream.read();
        this.offset = 0;
        if (!(this.pending instanceof Uint8Array) || !this.pending.length || this.pending.length > 64 * 1024) reject();
        this.total += this.pending.length;
        if (this.total > MAX_TOTAL) reject();
      }
      const count = Math.min(length - offset, this.pending.length - this.offset);
      result.set(this.pending.subarray(this.offset, this.offset + count), offset);
      this.offset += count;
      offset += count;
    }
    return result;
  }
  async read(sequence) {
    if (++this.packets > 32) reject();
    const header = await this.exact(4);
    const length = header[0] | (header[1] << 8) | (header[2] << 16);
    if (!length || length > MAX_PACKET || header[3] !== sequence) reject();
    const payload = await this.exact(length);
    // Never display peer-provided errors, which may echo user input or secrets.
    if (payload[0] === 0xff) throw new Error("Example database server rejected the request");
    return payload;
  }
  async write(bytes, sequence) {
    if (bytes.length > MAX_PACKET) reject();
    await this.stream.write(concat(Uint8Array.of(bytes.length & 255, (bytes.length >>> 8) & 255, 0, sequence), bytes));
  }
}

async function authentication(password, nonce) {
  if (!password.length) return new Uint8Array();
  const digest = async (bytes) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", bytes));
  const passwordBytes = encoder.encode(password);
  let first;
  let second;
  let third;
  try {
    first = await digest(passwordBytes);
    second = await digest(first);
    third = await digest(concat(nonce, second));
    return first.map((byte, index) => byte ^ third[index]);
  } finally {
    passwordBytes.fill(0);
    first?.fill(0);
    second?.fill(0);
    third?.fill(0);
  }
}

function greeting(bytes) {
  const cursor = new Cursor(bytes);
  if (cursor.byte() !== 10) reject();
  cursor.text();
  cursor.take(4);
  const nonceFirst = cursor.take(8);
  if (cursor.byte() !== 0) reject();
  const lower = cursor.short();
  cursor.byte();
  cursor.short();
  const upper = cursor.short();
  const capabilities = lower | (upper << 16);
  const authLength = cursor.byte();
  // MariaDB clears bit zero to identify its extended dialect. This example
  // sends CLIENT_MYSQL (bit zero) and uses only the common 4.1 protocol.
  const required = CLIENT_FLAGS & ~1;
  if ((capabilities & required) !== required || authLength !== 21) reject();
  cursor.take(10);
  const nonceSecond = cursor.take(13);
  if (nonceSecond[12] !== 0 || cursor.text() !== "mysql_native_password") reject();
  return concat(nonceFirst, nonceSecond.subarray(0, 12));
}

/** stream is a plugin-owned browser adapter over the generic host byte stream. */
async function queryFixedExample(stream, username, sessionPassword, database, query) {
  if (!/^[A-Za-z0-9_]{1,32}$/u.test(username) || typeof sessionPassword !== "string" || sessionPassword.length > 256) {
    throw new Error("Enter the disposable fixture username and session password");
  }
  const packets = new Packets(stream);
  try {
    const nonce = greeting(await packets.read(0));
    const token = await authentication(sessionPassword, nonce);
    sessionPassword = "";
    try {
      await packets.write(concat(uint32(CLIENT_FLAGS), uint32(MAX_PACKET), Uint8Array.of(45), new Uint8Array(23),
        zeroText(username), Uint8Array.of(token.length), token, zeroText(database), zeroText("mysql_native_password")), 1);
    } finally { token.fill(0); nonce.fill(0); }
    if ((await packets.read(2))[0] !== 0) reject();
    await packets.write(concat(Uint8Array.of(3), encoder.encode(query)), 0);
    const count = await packets.read(1);
    if (count.length !== 1 || count[0] !== 1) reject();
    const column = new Cursor(await packets.read(2));
    for (let index = 0; index < 4; index++) column.lengthText();
    if (column.lengthText() !== "value") reject();
    const eof = await packets.read(3);
    if (eof[0] !== 0xfe || eof.length >= 9) reject();
    const row = new Cursor(await packets.read(4));
    const value = row.lengthText();
    if (row.offset !== row.bytes.length) reject();
    const end = await packets.read(5);
    if (end[0] !== 0xfe || end.length >= 9) reject();
    return { columns: ["value"], rows: [[value]] };
  } finally {
    sessionPassword = "";
    await stream.close();
  }
}

export function queryExample(stream, username, sessionPassword) {
  return queryFixedExample(stream, username, sessionPassword, "plugin_demo", READ_QUERY);
}

// This second fixed profile is a public third-party acceptance candidate.
// No caller can supply a database, query, username, or password to this entry.
export function queryRfamReadOnly(stream) {
  return queryFixedExample(stream, "rfamro", "", "Rfam", "SELECT 1 AS value");
}
