"use strict";

// ssh2's fastPut/fastGet send multiple SFTP read/write requests in parallel.
// Keep defaults conservative so one file transfer does not monopolize a shared
// SSH/SFTP path used by interactive terminals.
//
// chunkSize must stay at ssh2's default (32KB). Larger values (e.g. 512KB) can
// exceed what some SFTP servers accept and silently produce truncated/corrupt
// remote files — see GitHub #2022 and ssh2-sftp-client's fastPut warnings.
const TRANSFER_CHUNK_SIZE = 32 * 1024;
const TRANSFER_CONCURRENCY = 4;

module.exports = {
  TRANSFER_CHUNK_SIZE,
  TRANSFER_CONCURRENCY,
};
