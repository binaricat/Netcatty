"use strict";

const fs = require("node:fs");
const net = require("node:net");

const { getCliDiscoveryFilePath } = require("./discoveryPath.cjs");
const { CAPABILITY_SURFACES } = require("../capabilities/constants.cjs");
const { createNdjsonRpcClient } = require("../capabilities/rpcTransport.cjs");

function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function loadDiscovery() {
  const discoveryPath = getCliDiscoveryFilePath();
  let raw;
  try {
    raw = fs.readFileSync(discoveryPath, "utf8");
  } catch (err) {
    throw createError(
      "APP_NOT_RUNNING",
      `Netcatty is not running or discovery file is missing at ${discoveryPath}. Start Netcatty first.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw createError(
      "DISCOVERY_INVALID",
      `Netcatty discovery file at ${discoveryPath} is invalid JSON.`,
    );
  }

  if (!parsed?.port || !parsed?.token) {
    throw createError(
      "DISCOVERY_INVALID",
      `Netcatty discovery file at ${discoveryPath} is missing required port/token fields.`,
    );
  }

  return parsed;
}

async function connectClient() {
  const discovery = loadDiscovery();
  const socket = await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: discovery.port }, () => resolve(sock));
    sock.setEncoding("utf8");
    sock.once("error", (err) => {
      reject(createError("CONNECT_FAILED", `Failed to connect to Netcatty TCP bridge: ${err?.message || err}`));
    });
  });

  const client = createNdjsonRpcClient({
    socket,
    surface: CAPABILITY_SURFACES.BUILTIN,
    createError,
    messages: {
      connectionClosed: "Connection to Netcatty TCP bridge closed.",
      connectionClosedWhileCall: "Connection to Netcatty TCP bridge is closed.",
      connectionError: (error) => `Connection to Netcatty TCP bridge failed: ${error?.message || error}`,
      rpcTimeout: (method, timeoutMs) => (
        `Timed out waiting for Netcatty RPC response to "${method}" after ${timeoutMs}ms.`
      ),
      writeFailed: (method, error) => (
        `Failed to send Netcatty RPC "${method}": ${error?.message || error}`
      ),
    },
  });

  const authResult = await client.call("auth/verify", { token: discovery.token });
  if (!authResult?.ok) {
    throw createError("AUTH_FAILED", "Failed to authenticate to Netcatty TCP bridge.");
  }

  try {
    const statusResult = await client.call("netcatty/getStatus", {});
    client.ingestBridgeStatus(statusResult);
  } catch {
    // Keep the default RPC timeout when bridge status cannot be fetched.
  }

  return {
    discovery,
    async call(method, params) {
      return await client.call(method, params);
    },
    close() {
      client.close();
    },
  };
}

module.exports = {
  connectClient,
  createError,
};
