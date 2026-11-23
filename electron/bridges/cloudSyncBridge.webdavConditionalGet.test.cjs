const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { handleWebdavDownload, handleWebdavUpload } = require("./cloudSyncBridge.cjs");

const file = { meta: { version: 1 }, payload: "encrypted-vault" };

async function startServer(t, { etag = '"v1"' } = {}) {
  const state = { file, etag, bodyGets: 0, conditions: [], files: new Map() };
  const server = http.createServer((req, res) => {
    if (req.method === "PROPFIND") {
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response>
        <d:href>${req.url}</d:href><d:propstat><d:prop><d:resourcetype/>
        </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
        </d:response></d:multistatus>`);
    } else if (req.method === "GET") {
      state.conditions.push(req.headers["if-none-match"]);
      if (state.etag && req.headers["if-none-match"] === state.etag) {
        res.writeHead(304, { ETag: state.etag });
        res.end();
        return;
      }
      state.bodyGets++;
      res.writeHead(200, state.etag ? { ETag: state.etag } : {});
      res.end(JSON.stringify(state.file));
    } else if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        state.files.set(req.url, JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(201);
        res.end();
      });
    } else if (req.method === "MOVE") {
      state.file = state.files.get(req.url);
      state.etag = '"uploaded"';
      res.writeHead(201);
      res.end();
    } else {
      res.writeHead(405);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    state,
    config: { endpoint: `http://127.0.0.1:${server.address().port}`, authType: "basic" },
  };
}

test("unchanged WebDAV ETag returns not-modified without a body GET (#4311)", async (t) => {
  const { state, config } = await startServer(t);
  const result = await handleWebdavDownload(config, '"v1"');
  assert.equal(state.bodyGets, 0);
  assert.deepEqual(state.conditions, ['"v1"']);
  assert.equal(result.notModified, true);
  assert.equal(result.syncedFile, null);
});

test("changed WebDAV ETag downloads the new vault and returns its ETag", async (t) => {
  const { state, config } = await startServer(t, { etag: '"v2"' });
  state.file = { ...file, payload: "new-vault" };
  const result = await handleWebdavDownload(config, '"v1"');
  assert.equal(state.bodyGets, 1);
  assert.deepEqual(result.syncedFile, state.file);
  assert.equal(result.etag, '"v2"');
});

test("WebDAV without a stored ETag downloads once and returns the fresh ETag", async (t) => {
  const { state, config } = await startServer(t);
  const result = await handleWebdavDownload(config);
  assert.equal(state.bodyGets, 1);
  assert.deepEqual(result.syncedFile, file);
  assert.equal(result.etag, '"v1"');
  await handleWebdavDownload(config, result.etag);
  assert.equal(state.bodyGets, 1);
});

test("WebDAV without server validators keeps downloading for correctness", async (t) => {
  const { state, config } = await startServer(t, { etag: null });
  const result = await handleWebdavDownload(config, '"old"');
  assert.deepEqual(result.syncedFile, file);
  assert.equal(result.etag, undefined);
  await handleWebdavDownload(config, result.etag);
  assert.equal(state.bodyGets, 2);
});

test("WebDAV upload returns the verification GET ETag so the next inspect skips", async (t) => {
  const { state, config } = await startServer(t);
  const result = await handleWebdavUpload(config, { ...file, payload: "uploaded-vault" });
  assert.equal(result.etag, '"uploaded"');
  const bodyGets = state.bodyGets;
  const inspection = await handleWebdavDownload(config, result.etag);
  assert.equal(inspection.notModified, true);
  assert.equal(state.bodyGets, bodyGets);
});
