"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const {
  createScpBackend,
  createSshExecAdapters,
  createTransferFromAbortSignal,
} = require("./scpBackend.cjs");
const {
  buildFileControlLine,
  buildAck,
  SCP_OK,
} = require("./scpProtocol.cjs");

function createMockStream() {
  const ee = new EventEmitter();
  ee.writable = true;
  ee.readable = true;
  ee.stderr = new EventEmitter();
  ee._chunks = [];
  ee.write = (buf, cb) => {
    ee._chunks.push(Buffer.from(buf));
    ee.emit("_write", Buffer.from(buf));
    if (typeof cb === "function") cb();
    return true;
  };
  ee.end = (cb) => {
    ee.emit("end");
    if (typeof cb === "function") cb();
  };
  ee.close = () => {
    ee.emit("close");
  };
  ee.destroy = () => {
    ee.emit("close");
  };
  ee.pushFromRemote = (buf) => {
    ee.emit("data", Buffer.from(buf));
  };
  return ee;
}

describe("scpBackend browse/manage with fake exec", () => {
  let commands;
  let backend;

  beforeEach(() => {
    commands = [];
    backend = createScpBackend({
      exec: async (command) => {
        commands.push({ type: "exec", command });
        if (command.includes("mkdir")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("rm ") || command.includes("rmdir")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("mv ")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("chmod ")) return { stdout: "", stderr: "", code: 0 };
        if (command.includes("$HOME") || command.includes('printf "B64:"') || command.includes('printf "RAW:')) {
          const b64 = Buffer.from("/home/test", "utf8").toString("base64");
          return { stdout: `B64:${b64}\n`, stderr: "", code: 0 };
        }
        if (command.includes("for f in")) {
          const name = Buffer.from("readme.txt").toString("base64");
          const dir = Buffer.from("docs").toString("base64");
          return {
            stdout: `f|-rw-r--r--|5|1700000000|${name}\nd|drwxr-xr-x|0|1700000001|${dir}\n`,
            stderr: "",
            code: 0,
          };
        }
        if (command.includes("wc -c") || command.includes("if [ ! -e")) {
          // stat command
          return {
            stdout: "f|-rw-r--r--|5|1700000000|/home/test/readme.txt\n",
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        commands.push({ type: "execStream", command });
        const stream = createMockStream();
        setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
        stream.on("_write", (buf) => {
          const text = buf.toString("utf8");
          if (text.startsWith("C") || (buf.length === 1 && buf[0] === 0x00)) {
            setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          }
        });
        return stream;
      },
    });
  });

  it("lists directory entries via shell", async () => {
    const entries = await backend.list("/home/test");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, "readme.txt");
    assert.equal(entries[0].type, "file");
    assert.equal(entries[1].name, "docs");
    assert.equal(entries[1].type, "directory");
    assert.ok(commands.some((c) => c.command.includes("cd '/home/test'")));
  });

  it("resolves symlink linkTarget so directory links are navigable", async () => {
    backend = createScpBackend({
      exec: async (command) => {
        commands.push({ type: "exec", command });
        if (command.includes("for f in") || command.includes("cd ")) {
          const link = Buffer.from("shared").toString("base64");
          const fileLink = Buffer.from("alias.txt").toString("base64");
          return {
            stdout:
              `l|lrwxrwxrwx|0|1700000000|${link}\n` +
              `l|lrwxrwxrwx|0|1700000000|${fileLink}\n`,
            stderr: "",
            code: 0,
          };
        }
        // resolveSymlinkTargetType probes
        if (command.includes("/home/test/shared") || command.includes("shared")) {
          if (command.includes('echo directory') || command.includes("[ -d")) {
            return { stdout: "directory\n", stderr: "", code: 0 };
          }
        }
        if (command.includes("alias.txt")) {
          return { stdout: "file\n", stderr: "", code: 0 };
        }
        return { stdout: "file\n", stderr: "", code: 0 };
      },
      execStream: async () => createMockStream(),
    });
    const entries = await backend.list("/home/test");
    assert.equal(entries.length, 2);
    const shared = entries.find((e) => e.name === "shared");
    const alias = entries.find((e) => e.name === "alias.txt");
    assert.equal(shared?.type, "symlink");
    assert.equal(shared?.linkTarget, "directory");
    assert.equal(alias?.type, "symlink");
    assert.equal(alias?.linkTarget, "file");
  });

  it("mkdir rename delete and chmod issue quoted shell commands", async () => {
    await backend.mkdir("/tmp/a b/c");
    await backend.rename("/tmp/a b/c", "/tmp/a b/d");
    await backend.remove("/tmp/a b/d", { recursive: true });
    await backend.chmod("/tmp/file", "644");
    await backend.chmod("/tmp/zero-mode", 0);
    assert.ok(commands.some((c) => c.command.includes("mkdir -p -- '/tmp/a b/c'")));
    assert.ok(commands.some((c) => c.command.includes("mv -- '/tmp/a b/c' '/tmp/a b/d'")));
    assert.ok(commands.some((c) => c.command.includes("rm -rf -- '/tmp/a b/d'")));
    assert.ok(commands.some((c) => c.command.includes("chmod 644 -- '/tmp/file'")));
    assert.ok(commands.some((c) => c.command.includes("chmod 000 -- '/tmp/zero-mode'")));
  });

  it("unlinks without a directory probe or recursive delete", async () => {
    await backend.unlink("/tmp/a b/link");
    const matching = commands.filter((c) => c.command.includes("/tmp/a b/link"));
    assert.equal(matching.length, 1);
    assert.match(matching[0].command, /rm -f -- '\/tmp\/a b\/link'/);
    assert.doesNotMatch(matching[0].command, /rm -rf/);
    assert.doesNotMatch(matching[0].command, /rmdir/);
  });

  it("stats a remote path", async () => {
    const st = await backend.stat("/home/test/readme.txt");
    assert.equal(st.size, 5);
    assert.equal(st.isDirectory, false);
    const statCommand = commands.find((entry) => entry.command.includes("if [ ! -e"))?.command || "";
    assert.match(statCommand, /\[ ! -L "\$p" \]/, "broken symlinks must not be reported as missing");
  });

  it("reports ENOENT when the stat command exits 2 with an ENOENT marker", async () => {
    const missingBackend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "ENOENT\n", code: 2 }),
      execStream: async () => createMockStream(),
    });
    await assert.rejects(
      () => missingBackend.stat("/home/test/gone.txt"),
      (err) => err.code === "ENOENT" && err.message === "No such file",
    );
  });

  it("does not mask an empty exec response as ENOENT in stat", async () => {
    const emptyBackend = createScpBackend({
      // Simulates the reporter's case: the exec channel returns no output at
      // all (e.g. channel negotiation failure) — not a missing file.
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => createMockStream(),
    });
    await assert.rejects(
      () => emptyBackend.stat("/home/test/readme.txt"),
      (err) => {
        assert.equal(err.code, "EMPTY_RESPONSE");
        assert.match(err.message, /empty response/);
        assert.ok(!(err instanceof Error && err.message === "No such file"));
        return true;
      },
    );
  });

  it("surfaces stderr and exit code when the stat command fails without output", async () => {
    const failingBackend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "sh: syntax error\n", code: 1 }),
      execStream: async () => createMockStream(),
    });
    await assert.rejects(
      () => failingBackend.stat("/home/test/readme.txt"),
      (err) => {
        assert.equal(err.code, "EMPTY_RESPONSE");
        assert.match(err.message, /exit 1/);
        assert.match(err.message, /syntax error/);
        assert.equal(err.exitCode, 1);
        assert.equal(err.stderr, "sh: syntax error");
        return true;
      },
    );
  });

  it("resolves home directory", async () => {
    const home = await backend.homeDir();
    assert.equal(home, "/home/test");
  });

  it("falls back to gb18030 when $HOME bytes are not valid UTF-8", async () => {
    const iconv = require("iconv-lite");
    const pathBytes = Buffer.concat([
      Buffer.from("/home/", "utf8"),
      iconv.encode("用户", "gb18030"),
    ]);
    const b64 = pathBytes.toString("base64");
    let detected = null;
    backend = createScpBackend({
      exec: async (command) => {
        if (command.includes("$HOME") || command.includes('printf "B64:"')) {
          return { stdout: `B64:${b64}\n`, stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async () => createMockStream(),
    });
    const home = await backend.homeDir({
      encoding: "utf-8",
      onDetectedEncoding: (enc) => {
        detected = enc;
      },
    });
    assert.equal(home, "/home/用户");
    assert.equal(detected, "gb18030");
  });
});

it("SCP in-memory reads reject a grown file from its protocol header", async () => {
  const stream = createMockStream();
  let ackCount = 0;
  stream.on("_write", (buf) => {
    if (!(buf.length === 1 && buf[0] === SCP_OK)) return;
    ackCount += 1;
    if (ackCount === 1) {
      setImmediate(() => stream.pushFromRemote(
        buildFileControlLine({ mode: 0o644, size: 5, name: "grown.bin" }),
      ));
    } else if (ackCount === 2) {
      setImmediate(() => stream.pushFromRemote(
        Buffer.concat([Buffer.from("ABCDE"), Buffer.from([0x00])]),
      ));
    }
  });
  const backend = createScpBackend({
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    execStream: async () => stream,
  });

  await assert.rejects(
    backend.readFile("/remote/grown.bin", { maxBytes: 4 }),
    /too large.*4 bytes.*download/i,
  );
  assert.equal(ackCount, 1, "oversized content must not be acknowledged for transfer");
});

describe("scpBackend upload/download with fake scp streams", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("uploads a local file through scp -t handshake and reports progress", async () => {
    const localFile = path.join(tmpDir, "local.txt");
    fs.writeFileSync(localFile, "hello-scp");
    const written = [];
    let progressCalls = [];

    const backend = createScpBackend({
      exec: async (command) => {
        if (command.includes("mkdir")) return { stdout: "", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        assert.match(command, /scp -t -- /);
        const stream = createMockStream();
        // Delay ready ACK until after waitForAck attaches (setImmediate > microtask).
        setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
        stream.on("_write", (buf) => {
          written.push(Buffer.from(buf));
          const text = buf.toString("utf8");
          // ACK after control line and after trailing NUL
          if (text.startsWith("C") || (buf.length === 1 && buf[0] === 0x00)) {
            setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          }
        });
        return stream;
      },
    });

    const transfer = { cancelled: false, abort: null };
    await backend.uploadFile(localFile, "/remote/dir/local.txt", {
      transfer,
      onProgress: (t, total) => progressCalls.push([t, total]),
    });

    const joined = Buffer.concat(written).toString("utf8");
    assert.match(joined, /C0[0-7]{3} 9 local\.txt\n/);
    assert.ok(joined.includes("hello-scp"));
    assert.ok(progressCalls.length > 0);
    assert.equal(progressCalls[progressCalls.length - 1][0], 9);
  });

  it("uploads from a caller-provided verified read stream", async () => {
    const localFile = path.join(tmpDir, "local.txt");
    fs.writeFileSync(localFile, "local-data");
    const verifiedPayload = Buffer.from("safe-stream");
    const written = [];
    let opened = 0;
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
        stream.on("_write", (buf) => {
          written.push(Buffer.from(buf));
          const text = buf.toString("utf8");
          if (text.startsWith("C") || (buf.length === 1 && buf[0] === 0x00)) {
            setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          }
        });
        return stream;
      },
    });

    await backend.uploadFile(localFile, "/remote/local.txt", {
      fileSize: verifiedPayload.length,
      openReadStream() {
        opened += 1;
        return Readable.from([verifiedPayload]);
      },
    });

    const joined = Buffer.concat(written);
    assert.equal(opened, 1);
    assert.equal(joined.includes(verifiedPayload), true);
    assert.equal(joined.includes(Buffer.from("local-data")), false);
  });

  it("rejects verified read streams whose bytes do not match the declared size", async () => {
    const localFile = path.join(tmpDir, "local.txt");
    fs.writeFileSync(localFile, "local-data");

    async function runCase(payload, expectedSize, message) {
      const backend = createScpBackend({
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        execStream: async () => {
          const stream = createMockStream();
          setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          stream.on("_write", (buf) => {
            const text = buf.toString("utf8");
            if (text.startsWith("C")) {
              setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
            }
          });
          return stream;
        },
      });
      await assert.rejects(
        backend.uploadFile(localFile, "/remote/local.txt", {
          fileSize: expectedSize,
          openReadStream: () => Readable.from([Buffer.from(payload)]),
        }),
        message,
      );
    }

    await runCase("short", 10, /ended early/);
    await runCase("too-many-bytes", 5, /exceeded its declared size/);
  });

  it("waits for verified read cleanup before returning a stream error", async () => {
    const localFile = path.join(tmpDir, "local.txt");
    fs.writeFileSync(localFile, "local-data");
    let resolveCleanup;
    const cleanup = new Promise((resolve) => { resolveCleanup = resolve; });
    let uploadSettled = false;
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
        stream.on("_write", (buf) => {
          if (buf.toString("utf8").startsWith("C")) {
            setImmediate(() => stream.pushFromRemote(Buffer.from([SCP_OK])));
          } else if (buf.toString("utf8") === "local-data") {
            setImmediate(() => {
              stream.emit("error", new Error("remote write failed"));
            });
          }
        });
        return stream;
      },
    });
    let uploadError = null;
    const running = backend.uploadFile(localFile, "/remote/local.txt", {
      fileSize: 10,
      openReadStream: () => ({
        stream: Readable.from([Buffer.from("local-data")]),
        completed: cleanup,
      }),
    }).then(
      () => { uploadSettled = true; },
      (err) => {
        uploadSettled = true;
        uploadError = err;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(uploadSettled, false);
    resolveCleanup();
    await running;
    assert.match(uploadError?.message || "", /remote write failed/);
  });

  it("downloads via scp -f parser into a local file", async () => {
    const localOut = path.join(tmpDir, "out.bin");
    const payload = Buffer.from("ABCD");
    const backend = createScpBackend({
      exec: async (command) => {
        if (command.includes("if [ ! -e")) {
          return { stdout: "f|-rw-r--r--|4|1700000000|/remote/x.bin\n", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
      execStream: async (command) => {
        assert.match(command, /scp -f -- /);
        const stream = createMockStream();
        let ackCount = 0;
        stream.on("_write", (buf) => {
          if (!(buf[0] === SCP_OK && buf.length === 1)) return;
          ackCount += 1;
          if (ackCount === 1) {
            // Client ready → send control
            setImmediate(() => {
              stream.pushFromRemote(buildFileControlLine({ mode: 0o644, size: 4, name: "x.bin" }));
            });
          } else if (ackCount === 2) {
            // Client accepted control → send data + trailing NUL
            setImmediate(() => {
              stream.pushFromRemote(Buffer.concat([payload, Buffer.from([0x00])]));
            });
          }
        });
        return stream;
      },
    });

    const progress = [];
    const result = await backend.downloadFile("/remote/x.bin", localOut, {
      fileSize: 4,
      onProgress: (t, total) => progress.push([t, total]),
    });
    assert.equal(fs.readFileSync(localOut).toString(), "ABCD");
    assert.ok(progress.length > 0);
    assert.deepEqual(result, { fileSize: 4, transferred: 4 });
  });

  it("cleans AbortSignal listeners after successful, failed, and early-closed downloads", async () => {
    const runCase = async (outcome) => {
      const listeners = new Set();
      let addCalls = 0;
      let removeCalls = 0;
      const signal = {
        aborted: false,
        addEventListener(type, listener) {
          if (type !== "abort") return;
          addCalls += 1;
          listeners.add(listener);
        },
        removeEventListener(type, listener) {
          if (type !== "abort") return;
          removeCalls += 1;
          listeners.delete(listener);
        },
      };
      const sshClient = {
        exec(_command, callback) {
          if (outcome === "sync-throw") throw new Error("session already closed");
          const stream = createMockStream();
          if (outcome === "success") {
            let ackCount = 0;
            stream.on("_write", (buf) => {
              if (!(buf.length === 1 && buf[0] === SCP_OK)) return;
              ackCount += 1;
              if (ackCount === 1) {
                setImmediate(() => stream.pushFromRemote(
                  buildFileControlLine({ mode: 0o644, size: 4, name: "x.bin" }),
                ));
              } else if (ackCount === 2) {
                setImmediate(() => stream.pushFromRemote(
                  Buffer.concat([Buffer.from("ABCD"), Buffer.from([0x00])]),
                ));
              }
            });
          } else if (outcome === "failure") {
            stream.on("_write", () => setImmediate(() => stream.emit("error", new Error("remote failed"))));
          }
          callback(null, stream);
          if (outcome === "early-close") stream.close();
        },
      };
      const backend = createScpBackend(createSshExecAdapters(sshClient));
      if (outcome === "success") {
        assert.deepEqual(await backend.readFile("/remote/x.bin", { signal }), Buffer.from("ABCD"));
      } else {
        await assert.rejects(
          () => backend.readFile("/remote/x.bin", { signal }),
          outcome === "failure"
            ? /remote failed/
            : outcome === "sync-throw"
              ? /session already closed/
              : /closed before protocol setup/,
        );
      }
      assert.equal(addCalls, 1, `${outcome}: expected one abort listener`);
      assert.equal(removeCalls, 1, `${outcome}: expected one abort listener cleanup`);
      assert.equal(listeners.size, 0, `${outcome}: abort listener leaked`);
    };

    await runCase("success");
    await runCase("failure");
    await runCase("early-close");
    await runCase("sync-throw");
  });

  it("rejects signal-only upload cancellation during the exec handoff", async () => {
    const controller = new AbortController();
    const stream = createMockStream();
    let deliverStream = null;
    const sshClient = {
      exec(_command, callback) {
        deliverStream = () => callback(null, stream);
      },
    };
    const backend = createScpBackend(createSshExecAdapters(sshClient));
    const upload = backend.uploadBuffer(Buffer.from("payload"), "file.bin", {
      signal: controller.signal,
    });
    assert.equal(typeof deliverStream, "function");

    controller.abort();
    deliverStream();

    await assert.rejects(
      () => Promise.race([
        upload,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 500)),
      ]),
      /cancel|abort/i,
    );
    assert.equal(stream._chunks.length, 0);
  });

  it("rejects signal-only upload cancellation when exec never calls back", async () => {
    const controller = new AbortController();
    let invalidations = 0;
    const sshClient = {
      exec() {
        // Deliberately never calls back: cancellation must settle the pending
        // execStream promise without waiting for an SSH channel.
      },
      destroy() { invalidations += 1; },
    };
    const backend = createScpBackend(createSshExecAdapters(sshClient));
    const upload = backend.uploadBuffer(Buffer.from("payload"), "file.bin", {
      signal: controller.signal,
    });
    controller.abort();

    await assert.rejects(
      () => Promise.race([
        upload,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 500)),
      ]),
      /cancel|abort/i,
    );
    assert.equal(invalidations, 1);
  });

  it("rejects upload streams that close or error before ACK listeners attach", async () => {
    const runCase = async (outcome) => {
      const sshClient = {
        exec(_command, callback) {
          const stream = createMockStream();
          callback(null, stream);
          if (outcome === "close") stream.close();
          else stream.emit("error", new Error("remote failed during handoff"));
        },
      };
      const backend = createScpBackend(createSshExecAdapters(sshClient));
      await assert.rejects(
        () => Promise.race([
          backend.uploadBuffer(Buffer.from("payload"), "file.bin"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("handoff timed out")), 500)),
        ]),
        outcome === "close" ? /closed before waiting for ACK/ : /remote failed during handoff/,
      );
    };

    await runCase("close");
    await runCase("error");
  });

  it("cancel aborts an in-flight upload", async () => {
    const localFile = path.join(tmpDir, "big.bin");
    fs.writeFileSync(localFile, Buffer.alloc(1024, 7));

    const transfer = { cancelled: false, abort: null };
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        // Never send ACK — upload blocks in waitForAck until cancelled.
        return stream;
      },
    });

    const uploadPromise = backend.uploadFile(localFile, "/remote/big.bin", { transfer });
    await new Promise((r) => setTimeout(r, 30));
    transfer.cancelled = true;
    if (typeof transfer.abort === "function") transfer.abort();
    await assert.rejects(() => uploadPromise, /cancel/i);
  });

  it("download settles when abort closes the stream before parser listeners attach", async () => {
    const localOut = path.join(tmpDir, "race-closed.bin");
    const transfer = { cancelled: false, abort: null };
    let sawAbortInstall = false;
    Object.defineProperty(transfer, "abort", {
      configurable: true,
      enumerable: true,
      get() {
        return this._abort;
      },
      set(fn) {
        this._abort = fn;
        if (sawAbortInstall || typeof fn !== "function") return;
        sawAbortInstall = true;
        // Simulate cancelTransfer winning immediately after abort is wired and
        // closing the stream before downloadToWritable attaches parser listeners.
        this.cancelled = true;
        queueMicrotask(() => {
          try { fn(); } catch { /* ignore */ }
        });
      },
    });

    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => createMockStream(),
    });

    await assert.rejects(
      () => backend.downloadFile("/remote/x.bin", localOut, {
        fileSize: 4,
        transfer,
      }),
      /cancel/i,
    );
  });

  it("AbortSignal via createTransferFromAbortSignal cancels in-flight upload (AI path)", async () => {
    const localFile = path.join(tmpDir, "sig.bin");
    fs.writeFileSync(localFile, Buffer.alloc(512, 1));
    const controller = new AbortController();
    const transfer = createTransferFromAbortSignal(controller.signal);
    assert.equal(transfer.cancelled, false);

    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => createMockStream(), // no ACK
    });

    const uploadPromise = backend.uploadFile(localFile, "/remote/sig.bin", { transfer });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    assert.equal(transfer.cancelled, true);
    await assert.rejects(() => uploadPromise, /cancel/i);
    transfer.detachAbortSignal?.();
  });

  it("createTransferFromAbortSignal marks already-aborted signals", () => {
    const controller = new AbortController();
    controller.abort();
    const transfer = createTransferFromAbortSignal(controller.signal);
    assert.equal(transfer.cancelled, true);
    assert.equal(createTransferFromAbortSignal(null), null);
  });

  it("list aborts when AbortSignal fires during shell exec", async () => {
    const controller = new AbortController();
    const backend = createScpBackend({
      exec: (_command, options = {}) => new Promise((resolve, reject) => {
        const signal = options.signal;
        if (signal?.aborted) {
          reject(new Error("Transfer cancelled"));
          return;
        }
        const onAbort = () => reject(new Error("Transfer cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
        // Never resolve until aborted (simulates hung remote).
      }),
      execStream: async () => createMockStream(),
    });
    const listPromise = backend.list("/tmp", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await assert.rejects(() => listPromise, /cancel/i);
  });
});
