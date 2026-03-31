/**
 * Secure Field Adapter — Renderer-side helpers for field-level encryption
 *
 * Encrypts / decrypts individual sensitive fields within domain models before
 * they are written to (or after they are read from) localStorage.
 *
 * The heavy lifting is done by Electron's safeStorage via the credential
 * bridge IPC.  When the bridge is unavailable (web fallback, tests) every
 * function degrades to a no-op — values pass through unmodified.
 */

import type { GroupConfig, Host, Identity, SSHKey } from "../../domain/models";
import type { ProviderConnection, S3Config, WebDAVConfig } from "../../domain/sync";
import { netcattyBridge } from "../services/netcattyBridge";

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

const bridge = () => netcattyBridge.get();

export async function encryptField(value: string | undefined): Promise<string | undefined> {
  if (!value) return value;
  const b = bridge();
  if (!b?.credentialsEncrypt) return value;
  return b.credentialsEncrypt(value);
}

export async function decryptField(value: string | undefined): Promise<string | undefined> {
  if (!value) return value;
  const b = bridge();
  if (!b?.credentialsDecrypt) return value;
  return b.credentialsDecrypt(value);
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export async function encryptHostSecrets(host: Host): Promise<Host> {
  const out = { ...host };
  out.password = await encryptField(out.password);
  out.telnetPassword = await encryptField(out.telnetPassword);
  if (out.proxyConfig?.password) {
    out.proxyConfig = { ...out.proxyConfig, password: await encryptField(out.proxyConfig.password) };
  }
  return out;
}

export async function decryptHostSecrets(host: Host): Promise<Host> {
  const out = { ...host };
  out.password = await decryptField(out.password);
  out.telnetPassword = await decryptField(out.telnetPassword);
  if (out.proxyConfig?.password) {
    out.proxyConfig = { ...out.proxyConfig, password: await decryptField(out.proxyConfig.password) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSHKey
// ---------------------------------------------------------------------------

export async function encryptKeySecrets(key: SSHKey): Promise<SSHKey> {
  const out = { ...key };
  out.passphrase = await encryptField(out.passphrase);
  out.privateKey = (await encryptField(out.privateKey)) ?? "";
  return out;
}

export async function decryptKeySecrets(key: SSHKey): Promise<SSHKey> {
  const out = { ...key };
  out.passphrase = await decryptField(out.passphrase);
  out.privateKey = (await decryptField(out.privateKey)) ?? "";
  return out;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export async function encryptIdentitySecrets(identity: Identity): Promise<Identity> {
  const out = { ...identity };
  out.password = await encryptField(out.password);
  return out;
}

export async function decryptIdentitySecrets(identity: Identity): Promise<Identity> {
  const out = { ...identity };
  out.password = await decryptField(out.password);
  return out;
}

// ---------------------------------------------------------------------------
// GroupConfig
// ---------------------------------------------------------------------------

export async function encryptGroupConfigSecrets(config: GroupConfig): Promise<GroupConfig> {
  const out = { ...config };
  out.password = await encryptField(out.password);
  out.telnetPassword = await encryptField(out.telnetPassword);
  if (out.proxyConfig?.password) {
    out.proxyConfig = { ...out.proxyConfig, password: await encryptField(out.proxyConfig.password) };
  }
  return out;
}

export async function decryptGroupConfigSecrets(config: GroupConfig): Promise<GroupConfig> {
  const out = { ...config };
  out.password = await decryptField(out.password);
  out.telnetPassword = await decryptField(out.telnetPassword);
  if (out.proxyConfig?.password) {
    out.proxyConfig = { ...out.proxyConfig, password: await decryptField(out.proxyConfig.password) };
  }
  return out;
}

export function encryptGroupConfigs(configs: GroupConfig[]): Promise<GroupConfig[]> {
  return Promise.all(configs.map(encryptGroupConfigSecrets));
}

export function decryptGroupConfigs(configs: GroupConfig[]): Promise<GroupConfig[]> {
  return Promise.all(configs.map(decryptGroupConfigSecrets));
}

// ---------------------------------------------------------------------------
// Provider Connection (Cloud Sync)
// ---------------------------------------------------------------------------

export async function encryptProviderSecrets(conn: ProviderConnection): Promise<ProviderConnection> {
  const out = { ...conn };

  if (out.tokens) {
    const t = { ...out.tokens };
    t.accessToken = (await encryptField(t.accessToken)) ?? "";
    t.refreshToken = await encryptField(t.refreshToken);
    out.tokens = t;
  }

  if (out.config) {
    // WebDAV — use authType (required field unique to WebDAVConfig) as discriminator
    // so that token-auth configs (which may lack a password key after JSON round-trip)
    // still get their token field encrypted.
    if ("authType" in out.config) {
      const c = { ...out.config } as WebDAVConfig;
      c.password = await encryptField(c.password);
      c.token = await encryptField(c.token);
      out.config = c;
    }
    // S3
    if ("secretAccessKey" in out.config) {
      const c = { ...out.config } as S3Config;
      c.secretAccessKey = (await encryptField(c.secretAccessKey)) ?? "";
      c.sessionToken = await encryptField(c.sessionToken);
      out.config = c;
    }
  }

  return out;
}

export async function decryptProviderSecrets(conn: ProviderConnection): Promise<ProviderConnection> {
  const out = { ...conn };

  if (out.tokens) {
    const t = { ...out.tokens };
    t.accessToken = (await decryptField(t.accessToken)) ?? "";
    t.refreshToken = await decryptField(t.refreshToken);
    out.tokens = t;
  }

  if (out.config) {
    if ("authType" in out.config) {
      const c = { ...out.config } as WebDAVConfig;
      c.password = await decryptField(c.password);
      c.token = await decryptField(c.token);
      out.config = c;
    }
    if ("secretAccessKey" in out.config) {
      const c = { ...out.config } as S3Config;
      c.secretAccessKey = (await decryptField(c.secretAccessKey)) ?? "";
      c.sessionToken = await decryptField(c.sessionToken);
      out.config = c;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Batch helpers
// ---------------------------------------------------------------------------

export function encryptHosts(hosts: Host[]): Promise<Host[]> {
  return Promise.all(hosts.map(encryptHostSecrets));
}

export function decryptHosts(hosts: Host[]): Promise<Host[]> {
  return Promise.all(hosts.map(decryptHostSecrets));
}

export function encryptKeys(keys: SSHKey[]): Promise<SSHKey[]> {
  return Promise.all(keys.map(encryptKeySecrets));
}

export function decryptKeys(keys: SSHKey[]): Promise<SSHKey[]> {
  return Promise.all(keys.map(decryptKeySecrets));
}

export function encryptIdentities(identities: Identity[]): Promise<Identity[]> {
  return Promise.all(identities.map(encryptIdentitySecrets));
}

export function decryptIdentities(identities: Identity[]): Promise<Identity[]> {
  return Promise.all(identities.map(decryptIdentitySecrets));
}
