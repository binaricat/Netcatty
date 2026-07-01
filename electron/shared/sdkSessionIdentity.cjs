"use strict";

const SDK_SESSION_ID_PREFIX = "netcatty-sdk-session:";

function encodeSdkSessionIdentity(sessionId, sdkBackend, binPath) {
  if (!sessionId || !sdkBackend) return sessionId;
  const payload = {
    v: 1,
    id: sessionId,
    backend: sdkBackend,
    binPath: binPath || "",
  };
  return `${SDK_SESSION_ID_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

function parseSdkSessionIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith(SDK_SESSION_ID_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw.slice(SDK_SESSION_ID_PREFIX.length)));
    if (!parsed || parsed.v !== 1 || !parsed.id || !parsed.backend) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  SDK_SESSION_ID_PREFIX,
  encodeSdkSessionIdentity,
  parseSdkSessionIdentity,
};
