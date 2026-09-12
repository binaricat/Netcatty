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

const parsePasswordKey = (raw: string): { username?: string; hostname?: string } => {
  const stripped = raw.replace(/^[A-Za-z]+\d*:/, "");
  const at = stripped.lastIndexOf("@");
  if (at <= 0 || at === stripped.length - 1) return {};
  return {
    username: stripped.slice(0, at),
    hostname: stripped.slice(at + 1),
  };
};

const sameHost = (left: string | undefined, right: string | undefined): boolean => (
  Boolean(left && right && left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0)
);

const presentMasterPassword = (value: string | undefined): string | undefined => (
  value === undefined || value === "" ? undefined : value
);

const lookupPlaintext = (
  host: Host,
  passwords: Map<string, string>,
  credentialsByUser: Map<string, string[]>,
): string | undefined => {
  const username = host.username?.trim();
  const hostname = host.hostname;
  const port = host.port ?? 22;
  if (username) {
    const exactKeys = [
      `${username}@${hostname}`,
      `ssh${port}:${username}@${hostname}`,
      `ssh:${username}@${hostname}`,
    ];
    for (const key of exactKeys) {
      const value = passwords.get(key);
      if (value) return value;
    }
  }

  const hostMatches: string[] = [];
  for (const [key, value] of passwords) {
    const parsed = parsePasswordKey(key);
    if (!sameHost(parsed.hostname, hostname)) continue;
    if (username && parsed.username && parsed.username !== username) continue;
    if (username && parsed.username === username) return value;
    hostMatches.push(value);
  }
  if (!username && hostMatches.length === 1) return hostMatches[0];

  if (username) {
    const named = credentialsByUser.get(username);
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
    return { ...host, password, savePassword: true };
  });

  if (attached === 0) {
    issues.push({
      level: "warning",
      message: "Decrypted MobaXterm passwords, but none matched the imported SSH sessions.",
    });
  }

  return { hosts: nextHosts, issues, attached };
};
