"use strict";

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { MAX_SECRET_BYTES } = require("./secretStore.cjs");

const ENCRYPTED_CREDENTIAL_PREFIX = "enc:v1:";
const MAX_CREDENTIAL_CATALOG_ENTRIES = 4_096;
const MAX_CREDENTIAL_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

function assertCredentialId(id) {
  if (typeof id !== "string" || id.length < 16 || id.length > 256 || id.includes("\0")) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential reference is invalid");
  }
  return id;
}

function decodeCiphertext(value) {
  if (typeof value !== "string" || !value.startsWith(ENCRYPTED_CREDENTIAL_PREFIX)) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential must use OS-backed encryption");
  }
  const encoded = value.slice(ENCRYPTED_CREDENTIAL_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential ciphertext is invalid");
  }
  const ciphertext = Buffer.from(encoded, "base64");
  if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_CREDENTIAL_CIPHERTEXT_BYTES) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential ciphertext is invalid or too large");
  }
  return ciphertext;
}

class PluginCredentialCatalog {
  constructor(options = {}) {
    this.safeStorage = options.safeStorage ?? null;
    this.records = new Map();
  }

  #assertAvailable() {
    const backend = this.safeStorage?.getSelectedStorageBackend?.();
    if (!this.safeStorage?.isEncryptionAvailable?.()
      || backend === "basic_text"
      || typeof this.safeStorage.decryptString !== "function") {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Secure OS-backed Vault credential decryption is unavailable",
      );
    }
  }

  isAvailable() {
    try { this.#assertAvailable(); return true; } catch { return false; }
  }

  update(entries) {
    if (!Array.isArray(entries) || entries.length > MAX_CREDENTIAL_CATALOG_ENTRIES) {
      throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential catalog is invalid or too large");
    }
    try {
      this.#assertAvailable();
    } catch (error) {
      this.records.clear();
      throw error;
    }
    const next = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).some((key) => key !== "id" && key !== "ciphertext")) {
        throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential catalog entry is invalid");
      }
      const id = assertCredentialId(entry.id);
      if (next.has(id)) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Vault credential catalog contains duplicate references");
      next.set(id, Buffer.from(decodeCiphertext(entry.ciphertext)));
    }
    this.records = next;
    return this.records.size;
  }

  async assertReference(reference) {
    const id = assertCredentialId(reference?.id);
    if (!this.records.has(id)) throw new PluginRpcError(RPC_ERRORS.notFound, "Vault credential reference was not found");
  }

  async resolve(reference) {
    this.#assertAvailable();
    const id = assertCredentialId(reference?.id);
    const ciphertext = this.records.get(id);
    if (!ciphertext) throw new PluginRpcError(RPC_ERRORS.notFound, "Vault credential reference was not found");
    let value;
    try { value = this.safeStorage.decryptString(Buffer.from(ciphertext)); }
    catch { throw new PluginRpcError(RPC_ERRORS.dataLoss, "Vault credential could not be decrypted"); }
    if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Vault credential is invalid or too large");
    }
    return value;
  }

  shutdown() {
    this.records.clear();
  }
}

module.exports = {
  ENCRYPTED_CREDENTIAL_PREFIX,
  MAX_CREDENTIAL_CATALOG_ENTRIES,
  PluginCredentialCatalog,
  assertCredentialId,
};
