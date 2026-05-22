const { createClient, AuthType } = require("webdav");
const https = require("https");
const {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const SYNC_FILE_NAME = "netcatty-vault.json";

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

const buildWebdavClient = (config) => {
  if (!config) throw new Error("Missing WebDAV config");
  const endpoint = normalizeEndpoint(config.endpoint);
  const extraOpts = {};
  if (config.allowInsecure) {
    extraOpts.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }
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

const buildS3Client = (config) =>
  new S3Client({
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
  });

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
    code: error?.code || error?.name,
    status: error?.$metadata?.httpStatusCode,
  };
  return buildError(`S3 ${operation} failed: ${message}`, details);
};

const handleWebdavInitialize = async (config) => {
  try {
    const client = buildWebdavClient(config);
    const path = getWebdavPath();
    await client.exists(path);
    return { resourceId: path };
  } catch (error) {
    throw wrapWebdavError("initialize", error, config);
  }
};

const handleWebdavUpload = async (config, syncedFile) => {
  try {
    const client = buildWebdavClient(config);
    const path = getWebdavPath();
    await client.putFileContents(path, JSON.stringify(syncedFile), { overwrite: true });
    return { resourceId: path };
  } catch (error) {
    throw wrapWebdavError("upload", error, config);
  }
};

const handleWebdavDownload = async (config) => {
  try {
    const client = buildWebdavClient(config);
    const path = getWebdavPath();
    const exists = await client.exists(path);
    if (!exists) return { syncedFile: null };
    const data = await client.getFileContents(path, { format: "text" });
    if (!data) return { syncedFile: null };
    return { syncedFile: JSON.parse(String(data)) };
  } catch (error) {
    throw wrapWebdavError("download", error, config);
  }
};

const handleWebdavDelete = async (config) => {
  try {
    const client = buildWebdavClient(config);
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
  if (!config) throw new Error("Missing S3 config");
  const client = buildS3Client(config);
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
        status: error?.$metadata?.httpStatusCode,
      });
    } else {
      throw wrapS3Error("initialize", error, config);
    }
  }
  return { resourceId: key };
};

const handleS3Upload = async (config, syncedFile) => {
  if (!config) throw new Error("Missing S3 config");
  const client = buildS3Client(config);
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
  if (!config) throw new Error("Missing S3 config");
  const client = buildS3Client(config);
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
  if (!config) throw new Error("Missing S3 config");
  const client = buildS3Client(config);
  const key = getS3ObjectKey(config);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (error) {
    if (isS3NotFound(error)) return { ok: true };
    throw wrapS3Error("delete", error, config);
  }
  return { ok: true };
};

const registerHandlers = (ipcMain) => {
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
  buildBasicAuthHeader,
  buildS3Client,
};
