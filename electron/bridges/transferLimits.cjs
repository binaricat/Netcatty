"use strict";

// ssh2's fastPut/fastGet send multiple SFTP read/write requests in parallel.
// Keep defaults conservative so one file transfer does not monopolize a shared
// SSH/SFTP path used by interactive terminals.
const TRANSFER_CHUNK_SIZE = 512 * 1024;
const TRANSFER_CONCURRENCY = 4;

module.exports = {
  TRANSFER_CHUNK_SIZE,
  TRANSFER_CONCURRENCY,
};
