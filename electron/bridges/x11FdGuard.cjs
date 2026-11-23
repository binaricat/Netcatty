const { Transform } = require("node:stream");

const DEFAULT_HIDDEN_EXTENSIONS = Object.freeze(["DRI3", "MIT-SHM"]);
const EMPTY = Buffer.alloc(0);

function readUInt16(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function pad4(length) {
  return Math.ceil(length / 4) * 4;
}

// Retain only the header we need; large request/reply bodies stream through.
function collectHeader(state, length, chunk, offset) {
  const count = Math.min(Math.max(0, length - state.header.length), chunk.length - offset);
  if (count > 0) {
    state.header = Buffer.concat([state.header, chunk.subarray(offset, offset + count)]);
  }
  return offset + count;
}

class RequestTracker extends Transform {
  constructor(shared) {
    super();
    this.shared = shared;
    this.setup = true;
    this.header = EMPTY;
    this.remaining = 0;
    this.sequence = 0;
  }

  _transform(chunk, _encoding, callback) {
    const shared = this.shared;
    let offset = 0;
    while (offset < chunk.length && shared.enabled) {
      if (this.remaining > 0) {
        const count = Math.min(this.remaining, chunk.length - offset);
        offset += count;
        this.remaining -= count;
        continue;
      }

      if (this.setup) {
        offset = collectHeader(this, 1, chunk, offset);
        if (this.header[0] !== 0x6c && this.header[0] !== 0x42) {
          shared.enabled = false;
          break;
        }
        shared.littleEndian = this.header[0] === 0x6c;
        offset = collectHeader(this, 12, chunk, offset);
        if (this.header.length < 12) break;
        this.remaining = pad4(readUInt16(this.header, 6, shared.littleEndian))
          + pad4(readUInt16(this.header, 8, shared.littleEndian));
        this.header = EMPTY;
        this.setup = false;
        continue;
      }

      offset = collectHeader(this, 4, chunk, offset);
      if (this.header.length < 4) break;
      let words = readUInt16(this.header, 2, shared.littleEndian);
      const headerLength = words === 0 ? 8 : 4;
      if (headerLength === 8) {
        offset = collectHeader(this, 8, chunk, offset);
        if (this.header.length < 8) break;
        words = readUInt32(this.header, 4, shared.littleEndian);
      }
      const total = words * 4;
      if (total < headerLength) {
        shared.enabled = false;
        break;
      }

      let name;
      const nameOffset = headerLength + 4;
      if (this.header[0] === 98 && total >= nameOffset) { // QueryExtension
        offset = collectHeader(this, nameOffset, chunk, offset);
        if (this.header.length < nameOffset) break;
        const nameLength = readUInt16(this.header, headerLength, shared.littleEndian);
        if (nameLength <= shared.maxNameLength && nameOffset + pad4(nameLength) <= total) {
          offset = collectHeader(this, nameOffset + nameLength, chunk, offset);
          if (this.header.length < nameOffset + nameLength) break;
          name = this.header.toString("latin1", nameOffset, nameOffset + nameLength);
        }
      }

      this.sequence = (this.sequence + 1) & 0xffff;
      // Do not let an unanswered query affect an unrelated request after wrap.
      shared.pending.delete(this.sequence);
      if (shared.hidden.has(name)) shared.pending.set(this.sequence, name);
      this.remaining = total - this.header.length;
      this.header = EMPTY;
    }
    callback(null, chunk);
  }
}

class ReplyFilter extends Transform {
  constructor(shared) {
    super();
    this.shared = shared;
    this.setup = true;
    this.header = EMPTY;
    this.remaining = 0;
  }

  _transform(chunk, _encoding, callback) {
    const shared = this.shared;
    let offset = 0;
    while (offset < chunk.length) {
      if (!shared.enabled) {
        this.push(this.header);
        this.header = EMPTY;
        this.push(chunk.subarray(offset));
        break;
      }
      if (this.remaining > 0) {
        const count = Math.min(this.remaining, chunk.length - offset);
        this.push(chunk.subarray(offset, offset + count));
        offset += count;
        this.remaining -= count;
        continue;
      }

      offset = collectHeader(this, this.setup ? 8 : 4, chunk, offset);
      if (this.header.length < (this.setup ? 8 : 4)) break;
      if (this.setup) {
        this.remaining = readUInt16(this.header, 6, shared.littleEndian) * 4;
        this.setup = false;
      } else {
        const type = this.header[0];
        let total = 32; // Errors and ordinary events are fixed size.
        if (type === 1 || (type & 0x7f) === 35) { // Reply or GenericEvent
          offset = collectHeader(this, 8, chunk, offset);
          if (this.header.length < 8) break;
          total += readUInt32(this.header, 4, shared.littleEndian) * 4;
        }
        if (type === 0 || type === 1) {
          const sequence = readUInt16(this.header, 2, shared.littleEndian);
          const name = shared.pending.get(sequence);
          if (name !== undefined) {
            if (type === 1) {
              offset = collectHeader(this, 9, chunk, offset);
              if (this.header.length < 9) break;
              if (this.header[8] !== 0) {
                this.header[8] = 0; // QueryExtension.present = False
                if (!shared.warned) {
                  shared.warned = true;
                  shared.logger.warn?.(`[X11] hiding ${name}: forwarding cannot carry file descriptors`);
                }
              }
            }
            shared.pending.delete(sequence);
          }
        }
        this.remaining = total - this.header.length;
      }
      this.push(this.header);
      this.header = EMPTY;
    }
    callback();
  }

  _flush(callback) {
    callback(null, this.header);
  }
}

// SCM_RIGHTS descriptors cannot travel over an SSH byte stream. Hide extensions
// that require them so clients select a supported rendering path instead.
function createX11FdGuard(options = {}) {
  const hidden = new Set(options.hiddenExtensions ?? DEFAULT_HIDDEN_EXTENSIONS);
  const shared = {
    enabled: hidden.size > 0,
    hidden,
    maxNameLength: Math.max(0, ...Array.from(hidden, (name) => name.length)),
    littleEndian: true,
    pending: new Map(),
    warned: false,
    logger: options.logger || console,
  };
  return { toServer: new RequestTracker(shared), toClient: new ReplyFilter(shared) };
}

module.exports = { createX11FdGuard, DEFAULT_HIDDEN_EXTENSIONS };
