const https = require("https");
const {
  resolveOutboundHttpAgent,
} = require("./httpNetworkProxyAgent.cjs");

// webdav and the AWS SDK pull in ~140 modules (~110 ms) that are only needed
// once a WebDAV/S3 sync actually runs, so load them on first use instead of at
// startup (this bridge is registered before the main window loads).
let webdavModule = null;
const loadWebdav = () => (webdavModule ??= require("webdav"));
let s3Module = null;
const loadS3 = () => (s3Module ??= require("@aws-sdk/client-s3"));
let nodeHttpHandlerModule = null;
const loadNodeHttpHandler = () => (nodeHttpHandlerModule ??= require("@smithy/node-http-handler"));

const SYNC_FILE_NAME = "netcatty-vault.json";

/**
 * Some WebDAV servers (esp. lightweight / local ones) overwrite existing
 * files without truncating when the new body is shorter. That leaves trailing
 * non-whitespace bytes from the previous longer body and breaks JSON.parse
 * (#2223).
 *
 * Strategy:
 * 1) Prefer fixed-name temp PUT + MOVE (atomic, exact size) when supported.
 * 2) Otherwise in-place PUT padded with spaces to at least the previous
 *    length, then re-read and verify JSON. Retry with a larger pad if a
 *    concurrent writer grew the file (stale-length race). JSON.parse
 *    ignores trailing whitespace, so the canonical path never needs DELETE.
 */
const serializeSyncedFileBody = (syncedFile) =>
  Buffer.from(JSON.stringify(syncedFile), "utf8");

const safeDeleteWebdavPath = async (client, path) => {
  try {
    if (await client.exists(path)) {
      await client.deleteFile(path);
    }
  } catch {
    // Best-effort cleanup only (temp files).
  }
};

/** Pad body with spaces so non-truncating PUTs cannot leave garbage. */
const padBodyToAtLeast = (bodyBuffer, minLength) => {
  if (!minLength || minLength <= bodyBuffer.length) return bodyBuffer;
  return Buffer.concat([bodyBuffer, Buffer.alloc(minLength - bodyBuffer.length, 0x20)]);
};

/**
 * Strict upload check: remote must be exactly the intended body, optionally
 * followed only by whitespace. Do NOT use parseSyncedFileJson here — that
 * helper intentionally recovers trailing garbage on download.
 */
const remoteMatchesUploadedBody = (remoteText, bodyBuffer) => {
  const bodyText = bodyBuffer.toString("utf8");
  if (!remoteText.startsWith(bodyText)) return false;
  return /^\s*$/.test(remoteText.slice(bodyText.length));
};

const readExistingByteLengthStrict = async (client, path) => {
  let exists = false;
  try {
    exists = await client.exists(path);
  } catch (error) {
    throw new Error(
      `WebDAV replace aborted: could not check existing file (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
  if (!exists) return 0;
  try {
    const existing = await client.getFileContents(path, { format: "text" });
    if (existing == null) return 0;
    return Buffer.byteLength(String(existing), "utf8");
  } catch (error) {
    throw new Error(
      `WebDAV replace aborted: could not read existing file length (${
        error instanceof Error ? error.message : String(error)
      })`
    );
  }
};

const readRemoteText = async (client, path) => {
  const remote = await client.getFileContents(path, { format: "text" });
  return String(remote ?? "");
};

const putWebdavFileReplacing = async (client, path, bodyBuffer) => {
  // Fixed temp name so failed cleanups cannot accumulate one full vault per sync.
  const tmpPath = `${path}.tmp`;

  // Optional atomic path: pad temp (in case a stale non-truncated .tmp remains),
  // MOVE into place, then strictly verify the destination.
  try {
    let tmpMinLen = 0;
    try {
      tmpMinLen = await readExistingByteLengthStrict(client, tmpPath);
    } catch {
      tmpMinLen = 0;
    }
    await client.putFileContents(tmpPath, padBodyToAtLeast(bodyBuffer, tmpMinLen), {
      overwrite: true,
    });
    await client.moveFile(tmpPath, path, { overwrite: true });
    const movedText = await readRemoteText(client, path);
    if (remoteMatchesUploadedBody(movedText, bodyBuffer)) {
      return;
    }
  } catch {
    // fall through to padded in-place PUT
  }
  await safeDeleteWebdavPath(client, tmpPath);

  // Keep the canonical path visible. Pad + strict verify so non-truncating
  // servers and concurrent writers that grow the remote cannot leave garbage.
  let minLen = await readExistingByteLengthStrict(client, path);
  for (let attempt = 0; attempt < 3; attempt++) {
    const payload = padBodyToAtLeast(bodyBuffer, minLen);
    await client.putFileContents(path, payload, { overwrite: true });
    let remoteText = "";
    try {
      remoteText = await readRemoteText(client, path);
    } catch (error) {
      throw new Error(
        `WebDAV upload verification failed: could not re-read file (${
          error instanceof Error ? error.message : String(error)
        })`
      );
    }
    if (remoteMatchesUploadedBody(remoteText, bodyBuffer)) {
      return;
    }
    minLen = Math.max(minLen, Buffer.byteLength(remoteText, "utf8"), bodyBuffer.length);
  }
  throw new Error(
    "WebDAV upload verification failed: remote file still does not match uploaded body after padded PUT"
  );
};

/**
 * Recover from trailing garbage left by non-truncating WebDAV PUT overwrites.
 * Node/V8 reports: "Unexpected non-whitespace character after JSON at position N".
 */
const parseSyncedFileJson = (raw) => {
  const text = String(raw ?? "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /Unexpected non-whitespace character after JSON at position (\d+)/i.exec(
      message
    );
    if (match) {
      const pos = Number(match[1]);
      if (Number.isFinite(pos) && pos > 0 && pos <= text.length) {
        return JSON.parse(text.slice(0, pos));
      }
    }
    throw error;
  }
};

let electronModuleRef = null;

const isHttpsEndpoint = (endpoint) => {
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return true;
  }
};

const resolveCloudSyncTransportAgent = async (targetUrl, allowInsecure = false) => {
  const session = electronModuleRef?.session?.defaultSession || null;
  const agent = await resolveOutboundHttpAgent(targetUrl, {
    session,
    rejectUnauthorized: allowInsecure ? false : undefined,
  });
  if (agent) return agent;
  if (allowInsecure && isHttpsEndpoint(targetUrl)) {
    return new https.Agent({ rejectUnauthorized: false });
  }
  return undefined;
};

const assignTransportAgent = (extraOpts, endpoint, agent) => {
  if (!agent) return;
  if (isHttpsEndpoint(endpoint)) {
    extraOpts.httpsAgent = agent;
  } else {
    extraOpts.httpAgent = agent;
  }
};

const normalizeEndpoint = (endpoint) => {
  const trimmed = String(endpoint || "").trim();
  if (!trimmed) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
};

const ensureLeadingSlash = (value) => (value.startsWith("/") ? value : `/${value}`);

const toBodyString = async (body) => {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (typeof body.transformToString === "function") {
    return await body.transformToString();
  }
  if (typeof body.on === "function") {
    return await new Promise((resolve, reject) => {
      let data = "";
      body.on("data", (chunk) => {
        data += chunk.toString();
      });
      body.on("end", () => resolve(data));
      body.on("error", reject);
    });
  }
  throw new Error("Unsupported S3 response body");
};

const buildError = (message, details) => {
  const err = new Error(message);
  err.cause = details;
  return err;
};

// Per RFC 7617, Basic Auth credentials must be UTF-8 encoded before base64.
// The upstream `webdav` package routes through `base-64`, which encodes as
// Latin1 — silently corrupting non-ASCII characters (e.g. `ö`, `ä`) and
// causing 401s against servers that follow the spec, like Hetzner Storage
// Box (#891). We build the header ourselves to avoid that path.
const buildBasicAuthHeader = (username, password) =>
  "Basic " +
  Buffer.from(`${username || ""}:${password || ""}`, "utf8").toString("base64");

const buildWebdavClient = async (config) => {
  if (!config) throw new Error("Missing WebDAV config");
  const { createClient, AuthType } = loadWebdav();
  const endpoint = normalizeEndpoint(config.endpoint);
  const extraOpts = {};
  const agent = await resolveCloudSyncTransportAgent(endpoint, Boolean(config.allowInsecure));
  assignTransportAgent(extraOpts, endpoint, agent);
  if (config.authType === "token") {
    return createClient(endpoint, {
      authType: AuthType.Token,
      token: {
        access_token: config.token || "",
        token_type: "Bearer",
      },
      ...extraOpts,
    });
  }
  if (config.authType === "digest") {
    return createClient(endpoint, {
      authType: AuthType.Digest,
      username: config.username || "",
      password: config.password || "",
      ...extraOpts,
    });
  }
  return createClient(endpoint, {
    authType: AuthType.None,
    headers: {
      Authorization: buildBasicAuthHeader(config.username, config.password),
    },
    ...extraOpts,
  });
};

const getWebdavPath = () => ensureLeadingSlash(SYNC_FILE_NAME);

const buildS3Client = async (config) => {
  const clientOptions = {
    region: config.region,
    endpoint: normalizeEndpoint(config.endpoint),
    forcePathStyle: config.forcePathStyle ?? true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
  };

  const endpoint = clientOptions.endpoint || "https://s3.amazonaws.com";
  const agent = await resolveCloudSyncTransportAgent(endpoint, Boolean(config.allowInsecure));
  if (agent) {
    const handlerOpts = isHttpsEndpoint(endpoint)
      ? { httpsAgent: agent }
      : { httpAgent: agent };
    const { NodeHttpHandler } = loadNodeHttpHandler();
    clientOptions.requestHandler = new NodeHttpHandler(handlerOpts);
  }

  const { S3Client } = loadS3();
  return new S3Client(clientOptions);
};

const getS3ObjectKey = (config) => {
  const prefix = String(config.prefix || "").trim().replace(/^\/+|\/+$/g, "");
  if (!prefix) return SYNC_FILE_NAME;
  return `${prefix}/${SYNC_FILE_NAME}`;
};

const isS3NotFound = (error) => error?.$metadata?.httpStatusCode === 404;
const isS3AccessDenied = (error) => error?.$metadata?.httpStatusCode === 403;

const wrapWebdavError = (operation, error, config) => {
  const message = error instanceof Error ? error.message : String(error);
  const details = {
    operation,
    endpoint: normalizeEndpoint(config?.endpoint),
    authType: config?.authType,
    status: error?.status || error?.response?.status,
    statusText: error?.statusText || error?.response?.statusText,
    url: error?.url || error?.response?.url,
    method: error?.method,
    code: error?.code,
  };
  return buildError(`WebDAV ${operation} failed: ${message}`, details);
};

const wrapS3Error = (operation, error, config) => {
  const message = error instanceof Error ? error.message : String(error);
  const details = {
    operation,
    endpoint: normalizeEndpoint(config?.endpoint),
    region: config?.region,
    bucket: config?.bucket,
    forcePathStyle: config?.forcePathStyle ?? true,
    allowInsecure: Boolean(config?.allowInsecure),
    code: error?.code || error?.name,
    status: error?.$metadata?.httpStatusCode,
  };
  return buildError(`S3 ${operation} failed: ${message}`, details);
};

const handleWebdavInitialize = async (config) => {
  try {
    const client = await buildWebdavClient(config);
    const path = getWebdavPath();
    await client.exists(path);
    return { resourceId: path };
  } catch (error) {
    throw wrapWebdavError("initialize", error, config);
  }
};

const handleWebdavUpload = async (config, syncedFile) => {
  try {
    const client = await buildWebdavClient(config);
    const path = getWebdavPath();
    const body = serializeSyncedFileBody(syncedFile);
    await putWebdavFileReplacing(client, path, body);
    return { resourceId: path };
  } catch (error) {
    throw wrapWebdavError("upload", error, config);
  }
};

const handleWebdavDownload = async (config) => {
  try {
    const client = await buildWebdavClient(config);
    const path = getWebdavPath();
    const exists = await client.exists(path);
    if (!exists) return { syncedFile: null };
    const data = await client.getFileContents(path, { format: "text" });
    if (!data) return { syncedFile: null };
    return { syncedFile: parseSyncedFileJson(data) };
  } catch (error) {
    throw wrapWebdavError("download", error, config);
  }
};

const handleWebdavDelete = async (config) => {
  try {
    const client = await buildWebdavClient(config);
    const path = getWebdavPath();
    const exists = await client.exists(path);
    if (!exists) return { ok: true };
    await client.deleteFile(path);
    return { ok: true };
  } catch (error) {
    throw wrapWebdavError("delete", error, config);
  }
};

const handleS3Initialize = async (config) => {
  const { HeadObjectCommand } = loadS3();
  if (!config) throw new Error("Missing S3 config");
  const client = await buildS3Client(config);
  const key = getS3ObjectKey(config);
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (error) {
    if (isS3NotFound(error)) {
      // Missing file is OK.
    } else if (isS3AccessDenied(error)) {
      throw buildError("S3 access denied", {
        operation: "initialize",
        endpoint: normalizeEndpoint(config.endpoint),
        region: config.region,
        bucket: config.bucket,
        forcePathStyle: config.forcePathStyle ?? true,
        allowInsecure: Boolean(config.allowInsecure),
        status: error?.$metadata?.httpStatusCode,
      });
    } else {
      throw wrapS3Error("initialize", error, config);
    }
  }
  return { resourceId: key };
};

const handleS3Upload = async (config, syncedFile) => {
  const { PutObjectCommand } = loadS3();
  if (!config) throw new Error("Missing S3 config");
  const client = await buildS3Client(config);
  const key = getS3ObjectKey(config);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: JSON.stringify(syncedFile),
        ContentType: "application/json",
      })
    );
  } catch (error) {
    throw wrapS3Error("upload", error, config);
  }
  return { resourceId: key };
};

const handleS3Download = async (config) => {
  const { GetObjectCommand } = loadS3();
  if (!config) throw new Error("Missing S3 config");
  const client = await buildS3Client(config);
  const key = getS3ObjectKey(config);
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key })
    );
    const text = await toBodyString(response.Body);
    if (!text) return { syncedFile: null };
    return { syncedFile: JSON.parse(text) };
  } catch (error) {
    if (isS3NotFound(error)) return { syncedFile: null };
    throw wrapS3Error("download", error, config);
  }
};

const handleS3Delete = async (config) => {
  const { DeleteObjectCommand } = loadS3();
  if (!config) throw new Error("Missing S3 config");
  const client = await buildS3Client(config);
  const key = getS3ObjectKey(config);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (error) {
    if (isS3NotFound(error)) return { ok: true };
    throw wrapS3Error("delete", error, config);
  }
  return { ok: true };
};

const registerHandlers = (ipcMain, electronModule) => {
  electronModuleRef = electronModule || null;
  ipcMain.handle("netcatty:cloudSync:webdav:initialize", async (_event, payload) => {
    return handleWebdavInitialize(payload?.config);
  });
  ipcMain.handle("netcatty:cloudSync:webdav:upload", async (_event, payload) => {
    return handleWebdavUpload(payload?.config, payload?.syncedFile);
  });
  ipcMain.handle("netcatty:cloudSync:webdav:download", async (_event, payload) => {
    return handleWebdavDownload(payload?.config);
  });
  ipcMain.handle("netcatty:cloudSync:webdav:delete", async (_event, payload) => {
    return handleWebdavDelete(payload?.config);
  });

  ipcMain.handle("netcatty:cloudSync:s3:initialize", async (_event, payload) => {
    return handleS3Initialize(payload?.config);
  });
  ipcMain.handle("netcatty:cloudSync:s3:upload", async (_event, payload) => {
    return handleS3Upload(payload?.config, payload?.syncedFile);
  });
  ipcMain.handle("netcatty:cloudSync:s3:download", async (_event, payload) => {
    return handleS3Download(payload?.config);
  });
  ipcMain.handle("netcatty:cloudSync:s3:delete", async (_event, payload) => {
    return handleS3Delete(payload?.config);
  });
};

module.exports = {
  registerHandlers,
  // Exposed for tests
  handleWebdavInitialize,
  handleWebdavUpload,
  handleWebdavDownload,
  parseSyncedFileJson,
  putWebdavFileReplacing,
  buildBasicAuthHeader,
  buildS3Client,
};
