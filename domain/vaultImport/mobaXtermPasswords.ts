import type { Host } from "../models";
import { decryptMobaStoredSecret } from "./mobaXtermCrypto";

type VaultImportIssue = { level: "warning" | "error"; message: string };

export interface MobaXtermIniSections {
  passwords: Map<string, string>;
  credentials: Map<string, { username: string; ciphertext: string }>;
  sessionP?: string;
  sysUsername?: string;
  sysHostname?: string;
  passwordsInRegistry: boolean;
  hasSesspass: boolean;
}

export interface AttachMobaXtermPasswordsOptions {
  masterPassword?: string;
}

const parsePasswordKey = (
  raw: string,
): { protocol?: string; port?: number; username?: string; hostname?: string } => {
  const prefixMatch = raw.match(/^([A-Za-z]+)(\d*):(.*)$/);
  const protocol = prefixMatch ? prefixMatch[1].toLowerCase() : undefined;
  const portStr = prefixMatch?.[2];
  const port = portStr ? Number.parseInt(portStr, 10) : undefined;
  const stripped = prefixMatch ? prefixMatch[3] : raw;

  const at = stripped.lastIndexOf("@");
  if (at === 0 && stripped.length > 1) {
    return {
      protocol,
      port: Number.isFinite(port) ? port : undefined,
      hostname: stripped.slice(1),
    };
  }
  if (at > 0 && at < stripped.length - 1) {
    return {
      protocol,
      port: Number.isFinite(port) ? port : undefined,
      username: stripped.slice(0, at),
      hostname: stripped.slice(at + 1),
    };
  }
  if (at === -1 && stripped.length > 0 && protocol) {
    return {
      protocol,
      port: Number.isFinite(port) ? port : undefined,
      hostname: stripped,
    };
  }
  return {};
};

const sameHost = (left: string | undefined, right: string | undefined): boolean => (
  Boolean(left && right && left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0)
);

const presentMasterPassword = (value: string | undefined): string | undefined => (
  value === undefined || value === "" ? undefined : value
);

const protocolPrefixForHost = (host: Host): { prefix: string; defaultPort: number } => {
  if (host.protocol === "rdp") return { prefix: "rdp", defaultPort: 3389 };
  if (host.protocol === "vnc") return { prefix: "vnc", defaultPort: 5900 };
  return { prefix: "ssh", defaultPort: 22 };
};

const lookupPlaintext = (
  host: Host,
  passwords: Map<string, string>,
  credentialsByUser: Map<string, string[]>,
): string | undefined => {
  const username = host.username?.trim();
  const domain = host.protocol === "rdp" ? host.rdpConfig?.domain?.trim() : undefined;
  const domainUsername = domain && username ? `${domain}\\${username}` : undefined;
  const hostname = host.hostname;
  const { prefix, defaultPort } = protocolPrefixForHost(host);
  const port = host.port ?? defaultPort;

  const exactKeys: string[] = [];
  if (domainUsername) {
    exactKeys.push(
      `${domainUsername}@${hostname}`,
      `${prefix}${port}:${domainUsername}@${hostname}`,
      `${prefix}:${domainUsername}@${hostname}`,
    );
  }
  if (username) {
    exactKeys.push(
      `${username}@${hostname}`,
      `${prefix}${port}:${username}@${hostname}`,
      `${prefix}:${username}@${hostname}`,
    );
  } else if (prefix === "vnc" || prefix === "rdp") {
    exactKeys.push(
      `${prefix}${port}:${hostname}`,
      `${prefix}:${hostname}`,
      `${prefix}${port}:@${hostname}`,
      `${prefix}:@${hostname}`,
    );
  }

  for (const key of exactKeys) {
    const value = passwords.get(key);
    if (value) return value;
  }

  const hostMatches: string[] = [];
  for (const [key, value] of passwords) {
    const parsed = parsePasswordKey(key);
    if (parsed.protocol && parsed.protocol !== prefix) continue;
    if (!sameHost(parsed.hostname, hostname)) continue;
    if (username && parsed.username) {
      if (parsed.username === username || (domainUsername && parsed.username === domainUsername)) {
        return value;
      }
      continue;
    }
    if (!username && parsed.username) continue;
    hostMatches.push(value);
  }
  if (!username && hostMatches.length === 1) return hostMatches[0];

  if (username) {
    const named = credentialsByUser.get(username)
      ?? (domainUsername ? credentialsByUser.get(domainUsername) : undefined);
    if (named?.length === 1) return named[0];
  }
  return undefined;
};

export const attachMobaXtermPasswords = (
  hosts: Host[],
  sections: MobaXtermIniSections,
  options: AttachMobaXtermPasswordsOptions = {},
): { hosts: Host[]; issues: VaultImportIssue[]; attached: number } => {
  const issues: VaultImportIssue[] = [];
  const masterPassword = presentMasterPassword(options.masterPassword);
  const hasCiphertext = sections.passwords.size > 0 || sections.credentials.size > 0;

  if (sections.passwordsInRegistry && !hasCiphertext) {
    issues.push({
      level: "warning",
      message: "MobaXterm saved passwords in the Windows registry, so this file has no credentials to import.",
    });
    return { hosts, issues, attached: 0 };
  }

  if (!hasCiphertext) return { hosts, issues, attached: 0 };

  if (!masterPassword && sections.hasSesspass) {
    issues.push({
      level: "warning",
      message: "This MobaXterm file encrypts saved passwords with a master password. Enter it to import credentials.",
    });
    return { hosts, issues, attached: 0 };
  }

  const decryptedPasswords = new Map<string, string>();
  let failed = 0;
  for (const [key, ciphertext] of sections.passwords) {
    const parsed = parsePasswordKey(key);
    const plaintext = decryptMobaStoredSecret({
      ciphertext,
      masterPassword,
      sessionP: sections.sessionP,
      sysUsername: sections.sysUsername,
      sysHostname: sections.sysHostname,
      connUsername: parsed.username,
      connHostname: parsed.hostname,
    });
    if (plaintext) decryptedPasswords.set(key, plaintext);
    else failed++;
  }

  const credentialsByUser = new Map<string, string[]>();
  for (const credential of sections.credentials.values()) {
    const plaintext = decryptMobaStoredSecret({
      ciphertext: credential.ciphertext,
      masterPassword,
      sessionP: sections.sessionP,
    });
    if (!plaintext) {
      failed++;
      continue;
    }
    const current = credentialsByUser.get(credential.username) ?? [];
    current.push(plaintext);
    credentialsByUser.set(credential.username, current);
  }

  if (masterPassword && failed > 0) {
    issues.push({
      level: "warning",
      message: "Could not decrypt MobaXterm passwords. Check the master password and try again.",
    });
    return { hosts, issues, attached: 0 };
  }

  if (failed > 0 && decryptedPasswords.size === 0 && credentialsByUser.size === 0) {
    issues.push({
      level: "warning",
      message: "Could not decrypt MobaXterm passwords from this file.",
    });
    return { hosts, issues, attached: 0 };
  }

  if (failed > 0) {
    issues.push({
      level: "warning",
      message: `Skipped ${failed} MobaXterm password(s) that could not be decrypted.`,
    });
  }

  let attached = 0;
  const nextHosts = hosts.map((host) => {
    const password = lookupPlaintext(host, decryptedPasswords, credentialsByUser);
    if (!password) return host;
    attached++;
    if (host.protocol === "rdp" || host.protocol === "vnc") {
      return {
        ...host,
        password,
        savePassword: true,
        authMethod: "password" as const,
        authPolicyVersion: 1 as const,
      };
    }
    return { ...host, password, savePassword: true };
  });

  if (attached === 0) {
    issues.push({
      level: "warning",
      message: "Decrypted MobaXterm passwords, but none matched the imported sessions.",
    });
  }

  return { hosts: nextHosts, issues, attached };
};
