import { Host, HostChainConfig, HostProtocol } from "./models";
import { isEncryptedCredentialPlaceholder } from "./credentials";
import { sanitizeHost } from "./host";
import { hasMacKeychainAgentDirectives } from "./sshAuth";
import {
  buildVaultHostFromDraft,
  buildVaultHostMergeKey,
  type VaultHostKeyPassphrase,
  type VaultHostDraftProtocol,
} from "./vaultHostCreate";

export { buildVaultHostMergeKey } from "./vaultHostCreate";
import { parseQuickConnectInput } from "./quickConnect";
import { findExactHeaderIndex, findHeaderIndex, parseCsv } from "./vaultImport/csvUtils";
import { decodeCsvKeyPath, decodeCsvPassphrase } from "./vaultImport/csvCredentialFields";
export {
  exportHostsToCsvWithStats,
  getVaultCsvTemplate,
  resolveVaultCsvHostKeyPath,
} from "./vaultImport/csvExport";

interface ParsedJumpHost {
  hostname: string;
  username?: string;
  port?: number;
}

const parseJumpHostSpec = (spec: string): ParsedJumpHost | null => {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return null;

  if (trimmed.startsWith("ssh://")) {
    try {
      const url = new URL(trimmed);
      return {
        hostname: url.hostname,
        username: url.username || undefined,
        port: url.port ? parseInt(url.port, 10) : undefined,
      };
    } catch {
      return null;
    }
  }

  let username: string | undefined;
  let hostname: string;
  let port: number | undefined;
  let rest = trimmed;

  const atIndex = rest.indexOf("@");
  if (atIndex !== -1) {
    username = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
  }

  if (rest.startsWith("[")) {
    const bracketEnd = rest.indexOf("]");
    if (bracketEnd !== -1) {
      hostname = rest.slice(1, bracketEnd);
      const portPart = rest.slice(bracketEnd + 1);
      if (portPart.startsWith(":")) {
        const p = parseInt(portPart.slice(1), 10);
        if (Number.isFinite(p) && p >= 1 && p <= 65535) port = p;
      }
    } else {
      hostname = rest;
    }
  } else {
    const colonIndex = rest.lastIndexOf(":");
    if (colonIndex !== -1) {
      const portStr = rest.slice(colonIndex + 1);
      const p = parseInt(portStr, 10);
      if (Number.isFinite(p) && p >= 1 && p <= 65535) {
        port = p;
        hostname = rest.slice(0, colonIndex);
      } else {
        hostname = rest;
      }
    } else {
      hostname = rest;
    }
  }

  if (!hostname) return null;
  return { hostname, username, port };
};
const parseProxyJump = (value: string): ParsedJumpHost[] => {
  if (!value || value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseJumpHostSpec)
    .filter((h): h is ParsedJumpHost => h !== null);
};

export type VaultImportFormat =
  | "putty"
  | "mobaxterm"
  | "csv"
  | "securecrt"
  | "ssh_config";

export const VAULT_IMPORT_FORMATS: VaultImportFormat[] = [
  "csv",
  "putty",
  "mobaxterm",
  "securecrt",
  "ssh_config",
];

type VaultImportIssueLevel = "warning" | "error";

export interface VaultImportIssue {
  level: VaultImportIssueLevel;
  message: string;
}

export interface VaultImportStats {
  parsed: number;
  imported: number;
  skipped: number;
  duplicates: number;
}

export interface VaultImportResult {
  hosts: Host[];
  groups: string[];
  issues: VaultImportIssue[];
  stats: VaultImportStats;
  keyPassphrases?: VaultHostKeyPassphrase[];
  keyPassphraseCandidates?: VaultHostKeyPassphrase[];
}

export function mergeVaultImportIssues(
  ...groups: ReadonlyArray<ReadonlyArray<VaultImportIssue>>
): VaultImportIssue[] {
  const seen = new Set<string>();
  return groups.flatMap((issues) => issues.filter((issue) => {
    const key = `${issue.level}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

const DEFAULT_SSH_PORT = 22;

const normalizeGroupPath = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, "/");
  const parts = normalized.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join("/");
};

const normalizeProtocol = (
  raw: string | undefined,
): Exclude<HostProtocol, "mosh" | "et"> | undefined => {
  const s = raw?.trim().toLowerCase();
  if (!s) return undefined;
  if (s === "ssh" || s === "ssh2" || s === "ssh-2") return "ssh";
  if (s === "telnet") return "telnet";
  if (s === "local") return "local";
  return undefined;
};

const parsePort = (raw: string | undefined): number | undefined => {
  const s = raw?.trim();
  if (!s) return undefined;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return undefined;
  return n;
};

const splitTags = (raw: string | undefined): string[] => {
  const s = raw?.trim();
  if (!s) return [];
  return s
    .split(/[,;，]/g)
    .map((t) => t.trim())
    .filter(Boolean);
};

const hostKey = buildVaultHostMergeKey;

const normalizeKeyPathKey = (keyPath: string): string => {
  const isWindowsPath = /^[A-Za-z]:[\\/]/u.test(keyPath) || /^[\\/]{2}/u.test(keyPath);
  return isWindowsPath ? keyPath.replace(/\\/g, "/").toLowerCase() : keyPath;
};

const createHost = (input: {
  label?: string;
  hostname: string;
  username?: string;
  password?: string;
  keyPath?: string;
  port?: number;
  protocol?: VaultHostDraftProtocol;
  group?: string;
  tags?: string[];
  notes?: string;
}): Host => {
  const built = buildVaultHostFromDraft(input);
  if (!built.ok) {
    throw new Error(built.error);
  }
  return built.host;
};

const dedupeHosts = (hosts: Host[]): { hosts: Host[]; duplicates: number } => {
  const seen = new Map<string, Host>();
  let duplicates = 0;

  for (const host of hosts) {
    const key = hostKey(host);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, host);
      continue;
    }
    duplicates++;
    const mergedTags = Array.from(new Set([...(existing.tags ?? []), ...(host.tags ?? [])]));
    existing.tags = mergedTags;
    if (!existing.password && host.password) existing.password = host.password;
    if (!existing.identityFilePaths?.some((path) => path.trim()) && host.identityFilePaths?.length) {
      existing.identityFilePaths = host.identityFilePaths;
      existing.authMethod = host.authMethod;
      existing.authPolicyVersion = host.authPolicyVersion;
      existing.useSshAgent = host.useSshAgent;
    }
    if (existing.group == null && host.group != null) existing.group = host.group;
    if (existing.label === existing.hostname && host.label && host.label !== host.hostname) {
      existing.label = host.label;
    }
  }

  return { hosts: Array.from(seen.values()), duplicates };
};

const uniq = (items: string[]) => Array.from(new Set(items.filter(Boolean)));

const looksLikeHostnameToken = (token: string): boolean => {
  const qc = parseQuickConnectInput(token.trim());
  return qc !== null;
};

const parseTarget = (
  raw: string,
): { hostname: string; username?: string; port?: number; protocol?: Exclude<HostProtocol, "mosh" | "et"> } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // URL form: ssh://user@host:22
  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      const protocol = normalizeProtocol(url.protocol.replace(/:$/, ""));
      const hostname = url.hostname;
      const port = url.port ? parsePort(url.port) : undefined;
      const username = url.username || undefined;
      if (!hostname) return null;
      return { hostname, username, port, protocol };
    } catch {
      // fall through
    }
  }

  // host:proto form (seen in some CSV exports)
  const protoSuffixMatch = trimmed.match(/^(.*?)(?::|\s+)(ssh|ssh2|telnet|local)$/i);
  if (protoSuffixMatch) {
    const left = protoSuffixMatch[1].trim();
    const protocol = normalizeProtocol(protoSuffixMatch[2]);
    const base = parseQuickConnectInput(left);
    if (base) return { hostname: base.hostname, username: base.username, port: base.port, protocol };
  }

  const qc = parseQuickConnectInput(trimmed);
  if (qc) return { hostname: qc.hostname, username: qc.username, port: qc.port };
  return null;
};


const importFromCsv = (text: string): VaultImportResult => {
  const issues: VaultImportIssue[] = [];
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) {
    return {
      hosts: [],
      groups: [],
      issues: [{ level: "error", message: "CSV is empty." }],
      stats: { parsed: 0, imported: 0, skipped: 0, duplicates: 0 },
    };
  }

  const header = rows[0];
  const dataRows = rows.slice(1);

  const groupsIdx = findHeaderIndex(header, ["groups", "group", "folder", "path"]);
  const labelIdx = findHeaderIndex(header, ["label", "name"]);
  const tagsIdx = findHeaderIndex(header, ["tags", "tag"]);
  const notesIdx = findHeaderIndex(header, ["notes", "note", "remark", "description", "memo"]);
  const hostnameIdx = findHeaderIndex(header, ["hostname", "host", "server"]);
  const protocolIdx = findHeaderIndex(header, ["protocol", "proto", "scheme"]);
  const portIdx = findHeaderIndex(header, ["port"]);
  const usernameIdx = findHeaderIndex(header, ["username", "user", "login"]);
  const keyPathIdx = findExactHeaderIndex(header, ["keypath", "key path", "identityfile", "identity file"]);
  const explicitPassphraseIdx = findExactHeaderIndex(header, ["passphrase", "keypassphrase", "key passphrase"]);
  const passphraseIdx = keyPathIdx >= 0 ? explicitPassphraseIdx : -1;
  const exactPasswordIdx = findExactHeaderIndex(header, ["password", "pass", "passwd"]);
  const fuzzyNamedPasswordIdx = findHeaderIndex(header, ["password", "passwd"]);
  const fuzzyPassIdx = header.findIndex((value) => {
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (!normalized.startsWith("pass")) return false;
    if (!normalized.startsWith("passphrase")) return true;
    const suffix = normalized.slice("passphrase".length);
    return keyPathIdx < 0 && ["", "optional", "value"].includes(suffix);
  });
  const fuzzyPasswordIdx = fuzzyNamedPasswordIdx >= 0 ? fuzzyNamedPasswordIdx : fuzzyPassIdx;
  const passwordIdx = exactPasswordIdx >= 0
    ? exactPasswordIdx
    : keyPathIdx < 0 && explicitPassphraseIdx >= 0
      ? explicitPassphraseIdx
      : fuzzyPasswordIdx;

  if (hostnameIdx === -1) {
    return {
      hosts: [],
      groups: [],
      issues: [
        {
          level: "error",
          message:
            "CSV header must include a Hostname column (e.g. Hostname, Host).",
        },
      ],
      stats: { parsed: 0, imported: 0, skipped: 0, duplicates: 0 },
    };
  }

  const parsedHosts: Host[] = [];
  const keyPassphraseCandidates: Array<{
    hostKey: string;
    keyPathKey: string;
    keyPath: string;
    passphrase: string;
  }> = [];
  const keyPassphrasesByPath = new Map<string, {
    keyPath: string;
    passphrase?: string;
    conflict: boolean;
  }>();
  let parsed = 0;
  let skipped = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const hostnameRaw = (row[hostnameIdx] ?? "").trim();
    if (!hostnameRaw) continue;
    parsed++;

    const target = parseTarget(hostnameRaw);
    if (!target) {
      skipped++;
      issues.push({
        level: "warning",
        message: `CSV row ${i + 2}: invalid hostname value "${hostnameRaw}".`,
      });
      continue;
    }

    const group = groupsIdx >= 0 ? normalizeGroupPath(row[groupsIdx]) : undefined;
    const label = labelIdx >= 0 ? row[labelIdx] : undefined;
    const tags = tagsIdx >= 0 ? splitTags(row[tagsIdx]) : [];
    const notesRaw = notesIdx >= 0 ? row[notesIdx] : undefined;
    const notes = notesRaw?.trim() || undefined;
    const protocol =
      normalizeProtocol(protocolIdx >= 0 ? row[protocolIdx] : undefined) ??
      target.protocol ??
      "ssh";
    const port = parsePort(portIdx >= 0 ? row[portIdx] : undefined) ?? target.port;
    const username = (usernameIdx >= 0 ? row[usernameIdx] : undefined)?.trim() || target.username;
    const password = (passwordIdx >= 0 ? row[passwordIdx] : undefined) || undefined;
    const keyPathRaw = (keyPathIdx >= 0 ? row[keyPathIdx] : undefined)?.trim();
    const keyPath = keyPathRaw ? decodeCsvKeyPath(keyPathRaw) : undefined;
    const passphraseRaw = (passphraseIdx >= 0 ? row[passphraseIdx] : undefined) || undefined;
    const decodedPassphrase = passphraseRaw ? decodeCsvPassphrase(passphraseRaw) : undefined;
    const passphrase = decodedPassphrase && !isEncryptedCredentialPlaceholder(decodedPassphrase)
      ? decodedPassphrase
      : undefined;

    if (decodedPassphrase && isEncryptedCredentialPlaceholder(decodedPassphrase)) {
      issues.push({
        level: "warning",
        message: `CSV row ${i + 2}: Passphrase was ignored because encrypted credential values cannot be imported.`,
      });
    }

    if (passphrase && !keyPath) {
      issues.push({
        level: "warning",
        message: `CSV row ${i + 2}: Passphrase was ignored because KeyPath is empty.`,
      });
    }

    const host = createHost({
      label,
      hostname: target.hostname,
      username,
      password,
      keyPath,
      port,
      protocol,
      group,
      tags,
      notes,
    });
    parsedHosts.push(host);
    if (keyPath && passphrase) {
      const keyPathKey = normalizeKeyPathKey(keyPath);
      const stored = keyPassphrasesByPath.get(keyPathKey);
      if (!stored) {
        keyPassphrasesByPath.set(keyPathKey, { keyPath, passphrase, conflict: false });
      } else if (stored.passphrase !== passphrase && !stored.conflict) {
        stored.conflict = true;
        issues.push({
          level: "warning",
          message: `CSV contains conflicting passphrases for KeyPath "${keyPath}"; no passphrase was saved for that path.`,
        });
      }
      keyPassphraseCandidates.push({
        hostKey: buildVaultHostMergeKey(host),
        keyPathKey,
        keyPath,
        passphrase,
      });
    }
  }

  const { hosts, duplicates } = dedupeHosts(parsedHosts);
  const keyPassphrases = hosts.flatMap((host) => {
    const selectedKeyPath = host.identityFilePaths?.find((path) => path.trim())?.trim();
    if (!selectedKeyPath) return [];
    const selectedKeyPathKey = normalizeKeyPathKey(selectedKeyPath);
    const candidate = keyPassphraseCandidates.find((entry) => (
      entry.hostKey === buildVaultHostMergeKey(host)
      && entry.keyPathKey === selectedKeyPathKey
    ));
    const entry = candidate ? keyPassphrasesByPath.get(candidate.keyPathKey) : undefined;
    return entry?.passphrase && !entry.conflict
      ? [{ hostId: host.id, keyPath: entry.keyPath, passphrase: entry.passphrase }]
      : [];
  });
  const allKeyPassphraseCandidates = hosts.flatMap((host) => {
    return keyPassphraseCandidates
      .filter((entry) => entry.hostKey === buildVaultHostMergeKey(host))
      .map((entry) => ({
        hostId: host.id,
        keyPath: entry.keyPath,
        passphrase: entry.passphrase,
      }));
  });
  const groups = uniq(hosts.map((h) => h.group).filter(Boolean) as string[]);
  return {
    hosts,
    groups,
    issues,
    keyPassphrases,
    keyPassphraseCandidates: allKeyPassphraseCandidates,
    stats: {
      parsed,
      imported: hosts.length,
      skipped,
      duplicates,
    },
  };
};

const decodeRegString = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const inner = trimmed.slice(1, -1);
  return inner.replace(/\\\\/g, "\\").replace(/\\"/g, '"');
};

const parseDword = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  const m = trimmed.match(/^dword:([0-9a-fA-F]{8})$/);
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return undefined;
  return n;
};

const decodePuttySessionName = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const importFromPuttyReg = (text: string): VaultImportResult => {
  const issues: VaultImportIssue[] = [];
  const lines = text.split(/\r?\n/);

  type Session = {
    name: string;
    hostname?: string;
    username?: string;
    port?: number;
    protocol?: Exclude<HostProtocol, "mosh" | "et">;
  };

  const sessions: Session[] = [];
  let current: Session | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sectionMatch = trimmed.match(
      /^\[HKEY_(?:CURRENT_USER|LOCAL_MACHINE)\\Software\\SimonTatham\\PuTTY\\Sessions\\(.+)\]$/i,
    );
    if (sectionMatch) {
      if (current) sessions.push(current);
      current = { name: decodePuttySessionName(sectionMatch[1]) };
      continue;
    }

    if (!current) continue;

    const kvMatch = trimmed.match(/^"([^"]+)"=(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const value = kvMatch[2];

    if (key === "HostName") current.hostname = decodeRegString(value);
    else if (key === "UserName") current.username = decodeRegString(value);
    else if (key === "PortNumber") current.port = parseDword(value);
    else if (key === "Protocol") current.protocol = normalizeProtocol(decodeRegString(value));
  }
  if (current) sessions.push(current);

  const parsedHosts: Host[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const s of sessions) {
    if (!s.hostname) continue;
    parsed++;
    const protocol = s.protocol ?? "ssh";
    if (protocol !== "ssh" && protocol !== "telnet") {
      skipped++;
      issues.push({
        level: "warning",
        message: `PuTTY session "${s.name}": unsupported protocol.`,
      });
      continue;
    }
    parsedHosts.push(
      createHost({
        label: s.name,
        hostname: s.hostname,
        username: s.username,
        port: s.port ?? (protocol === "ssh" ? DEFAULT_SSH_PORT : 23),
        protocol,
      }),
    );
  }

  const { hosts, duplicates } = dedupeHosts(parsedHosts);
  return {
    hosts,
    groups: [],
    issues,
    stats: { parsed, imported: hosts.length, skipped, duplicates },
  };
};

const importFromSshConfig = (text: string): VaultImportResult => {
  const issues: VaultImportIssue[] = [];
  const lines = text.split(/\r?\n/);

  type Block = {
    patterns: string[];
    hostname?: string;
    username?: string;
    port?: number;
    proxyJump?: string;
    identityFiles?: string[];
    identityAgent?: string;
    identitiesOnly?: boolean;
    addKeysToAgent?: string;
    useKeychain?: boolean;
    forwardX11?: boolean;
  };

  const blocks: Block[] = [];
  let current: Block | null = null;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    const cleaned = line.replace(/#.*/, "").trim();
    if (!cleaned) continue;

    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const keyword = tokens[0]?.toLowerCase();
    if (!keyword) continue;

    if (keyword === "host") {
      flush();
      current = { patterns: tokens.slice(1) };
      continue;
    }

    if (keyword === "match") {
      flush();
      continue;
    }

    if (!current) continue;

    const value = tokens.slice(1).join(" ");
    if (!value) continue;

    if (keyword === "hostname") current.hostname = value;
    else if (keyword === "user") current.username = value;
    else if (keyword === "port") current.port = parsePort(value);
    else if (keyword === "proxyjump") current.proxyJump = value;
    else if (keyword === "forwardx11") current.forwardX11 = value.toLowerCase() === "yes";
    else if (keyword === "identityagent") current.identityAgent = value.replace(/^["']|["']$/g, "");
    else if (keyword === "identitiesonly") current.identitiesOnly = value.toLowerCase() === "yes";
    else if (keyword === "addkeystoagent") current.addKeysToAgent = value.toLowerCase();
    else if (keyword === "usekeychain") current.useKeychain = value.toLowerCase() === "yes";
    else if (keyword === "identityfile") {
      if (!current.identityFiles) current.identityFiles = [];
      // Remove surrounding quotes (ssh_config allows quoted paths with spaces)
      const unquoted = value.replace(/^["']|["']$/g, "");
      current.identityFiles.push(unquoted);
    }
  }

  flush();

  const parsedHosts: Host[] = [];
  // Use hostname+port as key instead of host.id to survive deduplication
  const hostProxyJumpMap = new Map<string, string>();
  let parsed = 0;
  let skipped = 0;

  const isWildcardPattern = (p: string) => /[*?]/.test(p) || p === "!" || p.startsWith("!");

  // Helper to create a stable key for ProxyJump mapping
  const makeHostKey = (hostname: string, port?: number) =>
    `${hostname.toLowerCase()}:${port ?? 22}`;

  for (const block of blocks) {
    const patterns = block.patterns.filter((p) => p && !isWildcardPattern(p));
    if (patterns.length === 0) continue;

    for (const pat of patterns) {
      parsed++;
      const hostname = block.hostname ?? pat;
      if (!looksLikeHostnameToken(hostname)) {
        skipped++;
        issues.push({
          level: "warning",
          message: `ssh_config: skipped host "${pat}" (invalid hostname).`,
        });
        continue;
      }

      const host = createHost({
        label: pat,
        hostname,
        username: block.username,
        port: block.port,
        protocol: "ssh",
      });

      // Attach IdentityFile paths if present
      if (block.identityFiles && block.identityFiles.length > 0) {
        host.identityFilePaths = [...block.identityFiles];
      }
      if (block.identityAgent !== undefined) {
        host.identityAgent = block.identityAgent;
      }
      if (block.identitiesOnly !== undefined) {
        host.identitiesOnly = block.identitiesOnly;
      }
      if (block.addKeysToAgent !== undefined) {
        host.addKeysToAgent = block.addKeysToAgent;
      }
      if (block.useKeychain !== undefined) {
        host.useKeychain = block.useKeychain;
      }
      const identityAgentEnabled = block.identityAgent !== undefined
        && block.identityAgent.toLowerCase() !== "none";
      const identityAgentDisabled = block.identityAgent?.toLowerCase() === "none";
      // The #2119 macOS pattern relies on AddKeysToAgent + UseKeychain without
      // declaring IdentityAgent. Treat that pair as an agent-backed login so
      // the bridge can ask Apple's ssh-add to load the configured IdentityFile.
      // AddKeysToAgent alone still keeps direct-key semantics on other setups.
      const macKeychainAgentEnabled = hasMacKeychainAgentDirectives(block);
      if (!identityAgentDisabled && (identityAgentEnabled || macKeychainAgentEnabled)) {
        host.useSshAgent = true;
      } else if (identityAgentDisabled) {
        host.useSshAgent = false;
      }
      if (block.forwardX11 !== undefined) {
        host.x11Forwarding = block.forwardX11;
      }

      parsedHosts.push(host);

      // Store ProxyJump using hostname key (survives deduplication)
      if (block.proxyJump && block.proxyJump.toLowerCase() !== "none") {
        const hostKey = makeHostKey(hostname, block.port);
        hostProxyJumpMap.set(hostKey, block.proxyJump);
      }
    }
  }

  const { hosts: dedupedHosts, duplicates } = dedupeHosts(parsedHosts);

  const hostnameToId = new Map<string, string>();
  const labelToId = new Map<string, string>();
  for (const host of dedupedHosts) {
    hostnameToId.set(host.hostname.toLowerCase(), host.id);
    labelToId.set(host.label.toLowerCase(), host.id);
  }

  const resolveJumpHostToId = (jumpHost: ParsedJumpHost): string | null => {
    const hostnameKey = jumpHost.hostname.toLowerCase();
    if (labelToId.has(hostnameKey)) return labelToId.get(hostnameKey)!;
    if (hostnameToId.has(hostnameKey)) return hostnameToId.get(hostnameKey)!;
    return null;
  };

  // Collect inline hosts separately to avoid modifying array during iteration
  const inlineHosts: Host[] = [];

  // Process ProxyJump for each host (iterate over a copy to avoid issues)
  const hostsToProcess = [...dedupedHosts];
  for (const host of hostsToProcess) {
    const hostKey = makeHostKey(host.hostname, host.port);
    const proxyJumpValue = hostProxyJumpMap.get(hostKey);
    if (!proxyJumpValue) continue;

    const jumpHosts = parseProxyJump(proxyJumpValue);
    if (jumpHosts.length === 0) continue;

    const resolvedIds: string[] = [];
    const unresolvedJumps: string[] = [];

    for (const jumpHost of jumpHosts) {
      const existingId = resolveJumpHostToId(jumpHost);
      if (existingId) {
        // Avoid duplicate IDs in the chain
        if (!resolvedIds.includes(existingId)) {
          resolvedIds.push(existingId);
        }
      } else {
        // Check if we already created an inline host for this
        const inlineKey = jumpHost.hostname.toLowerCase();
        let inlineId = hostnameToId.get(inlineKey);

        if (!inlineId) {
          const inlineHost = createHost({
            label: jumpHost.hostname,
            hostname: jumpHost.hostname,
            username: jumpHost.username,
            port: jumpHost.port,
            protocol: "ssh",
          });
          inlineHosts.push(inlineHost);
          hostnameToId.set(inlineHost.hostname.toLowerCase(), inlineHost.id);
          labelToId.set(inlineHost.label.toLowerCase(), inlineHost.id);
          inlineId = inlineHost.id;
          unresolvedJumps.push(jumpHost.hostname);
        }

        if (!resolvedIds.includes(inlineId)) {
          resolvedIds.push(inlineId);
        }
      }
    }

    if (resolvedIds.length > 0) {
      // Cycle detection: check if this host appears in its own chain
      if (resolvedIds.includes(host.id)) {
        issues.push({
          level: "warning",
          message: `ssh_config: detected circular reference in ProxyJump for "${host.label}", skipping chain.`,
        });
        continue;
      }

      const hostChain: HostChainConfig = { hostIds: resolvedIds };
      host.hostChain = hostChain;
    }

    if (unresolvedJumps.length > 0) {
      issues.push({
        level: "warning",
        message: `ssh_config: created inline jump host(s) for "${host.label}": ${unresolvedJumps.join(", ")}`,
      });
    }
  }

  // Add inline hosts to the final result
  const allHosts = [...dedupedHosts, ...inlineHosts];

  // Deep cycle detection: check for indirect cycles (A -> B -> C -> A)
  const detectCycle = (hostId: string, visited: Set<string>): boolean => {
    if (visited.has(hostId)) return true;
    visited.add(hostId);
    const host = allHosts.find(h => h.id === hostId);
    if (host?.hostChain?.hostIds) {
      for (const chainId of host.hostChain.hostIds) {
        if (detectCycle(chainId, visited)) return true;
      }
    }
    visited.delete(hostId);
    return false;
  };

  // Remove chains that form cycles
  for (const host of allHosts) {
    if (host.hostChain?.hostIds && host.hostChain.hostIds.length > 0) {
      if (detectCycle(host.id, new Set())) {
        issues.push({
          level: "warning",
          message: `ssh_config: detected circular dependency in jump chain for "${host.label}", removing chain.`,
        });
        delete host.hostChain;
      }
    }
  }

  return {
    hosts: allHosts,
    groups: [],
    issues,
    stats: { parsed, imported: allHosts.length, skipped, duplicates },
  };
};

const importFromSecureCrt = (text: string, fileName?: string): VaultImportResult => {
  const issues: VaultImportIssue[] = [];
  const lines = text.split(/\r?\n/);

  type Session = {
    label?: string;
    hostname?: string;
    username?: string;
    port?: number;
    protocol?: Exclude<HostProtocol, "mosh" | "et">;
  };

  const sessions: Session[] = [];
  let current: Session = {};

  const flush = () => {
    if (current.hostname) sessions.push(current);
    current = {};
  };

  const parseSecureCrtPort = (raw: string): number | undefined => {
    const trimmed = raw.trim().replace(/^"+|"+$/g, "");
    if (!trimmed) return undefined;
    if (/^[0-9a-fA-F]{8}$/.test(trimmed)) {
      const n = parseInt(trimmed, 16);
      if (Number.isFinite(n) && n >= 1 && n <= 65535) return n;
    }
    return parsePort(trimmed);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const kv = trimmed.match(/^[SDB]:"([^"]+)"=(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    const rawValue = kv[2].trim();
    const value = rawValue.replace(/^"+|"+$/g, "");

    if (key === "Hostname") {
      if (current.hostname) flush();
      current.hostname = value;
    } else if (key === "Username") {
      current.username = value;
    } else if (key === "Port") {
      current.port = parseSecureCrtPort(value);
    } else if (key === "Protocol Name") {
      const p = normalizeProtocol(value);
      current.protocol = p;
    } else if (key === "Session Name") {
      current.label = value;
    }
  }
  flush();

  const parsedHosts: Host[] = [];
  let parsed = 0;
  let skipped = 0;

  const fallbackLabel =
    fileName?.replace(/\.[^.]+$/, "") || "SecureCRT Session";

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (!s.hostname) continue;
    parsed++;
    const protocol = s.protocol ?? "ssh";
    if (protocol !== "ssh" && protocol !== "telnet") {
      skipped++;
      issues.push({
        level: "warning",
        message: `SecureCRT session: unsupported protocol.`,
      });
      continue;
    }

    const label = s.label || (sessions.length > 1 ? `${fallbackLabel} ${i + 1}` : fallbackLabel);
    parsedHosts.push(
      createHost({
        label,
        hostname: s.hostname,
        username: s.username,
        port: s.port ?? (protocol === "ssh" ? DEFAULT_SSH_PORT : 23),
        protocol,
      }),
    );
  }

  const { hosts, duplicates } = dedupeHosts(parsedHosts);
  return {
    hosts,
    groups: [],
    issues,
    stats: { parsed, imported: hosts.length, skipped, duplicates },
  };
};

const importFromMobaXterm = (text: string): VaultImportResult => {
  const issues: VaultImportIssue[] = [];
  const lines = text.split(/\r?\n/);

  type Entry = { section: string; key: string; value: string };
  const entries: Entry[] = [];
  const sectionGroups = new Map<string, string | undefined>();

  let section = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(";") || trimmed.startsWith("#")) continue;

    const mSection = trimmed.match(/^\[(.+)\]$/);
    if (mSection) {
      section = mSection[1];
      continue;
    }

    const mKv = trimmed.match(/^([^=]+)=(.*)$/);
    if (!mKv) continue;
    const key = mKv[1].trim();
    const value = mKv[2].trim();
    const isBookmarkSection = /^bookmarks(?:_\d+)?$/i.test(section.trim());

    if (isBookmarkSection && key.toLowerCase() === "subrep") {
      sectionGroups.set(section, normalizeGroupPath(value));
      continue;
    }
    if (isBookmarkSection && key.toLowerCase() === "imgnum") continue;

    entries.push({ section, key, value });
  }

  const candidateEntries = entries.filter((e) =>
    /^(?:sessions|bookmarks(?:_\d+)?|bookmarks2|bookmark)$/i.test(e.section.trim()),
  );

  const parsedHosts: Host[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const e of candidateEntries) {
    const rawKey = e.key;
    const rawValue = e.value;
    if (!rawKey || !rawValue) continue;

    parsed++;

    const isBookmarkSection = /^bookmarks(?:_\d+)?$/i.test(e.section.trim());
    const hasBookmarkGroup = sectionGroups.has(e.section);
    const keyParts = rawKey.replace(/\\/g, "/").split("/").filter(Boolean);
    const label = isBookmarkSection && hasBookmarkGroup
      ? rawKey
      : keyParts[keyParts.length - 1] || rawKey;
    const group = isBookmarkSection && hasBookmarkGroup
      ? sectionGroups.get(e.section)
      : keyParts.length > 1
        ? keyParts.slice(0, -1).join("/")
        : undefined;

    let protocol: Exclude<HostProtocol, "mosh" | "et"> | undefined;
    let hostname: string | undefined;
    let username: string | undefined;
    let port: number | undefined;

    const outerFields = rawValue.split("#");
    const sessionFields = outerFields.length >= 3 ? outerFields[2].split("%") : [];
    const sessionType = sessionFields[0]?.trim();
    const isStandardSession = /^(?:;\s*logout)?\s*#\d+(?:#|$)/i.test(rawValue);

    if (isStandardSession) {
      if (!/^\d+$/.test(sessionType ?? "")) {
        skipped++;
        issues.push({
          level: "warning",
          message: `MobaXterm entry "${label}": invalid session type.`,
        });
        continue;
      }
      if (sessionType !== "0" && sessionType !== "7") {
        skipped++;
        issues.push({
          level: "warning",
          message: `MobaXterm entry "${label}": unsupported session type.`,
        });
        continue;
      }

      protocol = "ssh";
      hostname = sessionFields[1]?.trim() || undefined;
      port = parsePort(sessionFields[2]);
      const rawUsername = sessionFields[3]?.trim();
      username = rawUsername && rawUsername !== "<default>" ? rawUsername : undefined;
    } else {
      // Retain support for the simpler token layouts accepted by older imports.
      const tokens = rawValue
        .split("#")
        .map((t) => t.trim())
        .filter(Boolean);

      if (tokens.length > 0) {
        protocol =
          normalizeProtocol(tokens[0]) ??
          tokens.map((t) => normalizeProtocol(t)).find(Boolean);

        for (const tok of tokens) {
          const target = parseTarget(tok.replace(/^ssh:/i, "").trim());
          if (target) {
            hostname = target.hostname;
            username = target.username ?? username;
            port = target.port ?? port;
            protocol = target.protocol ?? protocol;
            break;
          }
        }

        const numericPort = tokens.map((t) => parsePort(t)).find(Boolean);
        if (numericPort) port = numericPort;

        if (!username) {
          const userToken = tokens.find((t) => t.includes("@"));
          if (userToken) username = userToken.split("@")[0];
        }
      }
    }

    if (!hostname) {
      skipped++;
      issues.push({
        level: "warning",
        message: `MobaXterm entry "${label}": missing hostname.`,
      });
      continue;
    }

    parsedHosts.push(
      createHost({
        label,
        hostname,
        username,
        port,
        protocol: protocol ?? "ssh",
        group,
      }),
    );
  }

  const { hosts, duplicates } = dedupeHosts(parsedHosts);
  const groups = uniq(hosts.map((h) => h.group).filter(Boolean) as string[]);
  return {
    hosts,
    groups,
    issues,
    stats: { parsed, imported: hosts.length, skipped, duplicates },
  };
};

export const importVaultHostsFromText = (
  format: VaultImportFormat,
  text: string,
  options?: { fileName?: string },
): VaultImportResult => {
  const input = text ?? "";
  switch (format) {
    case "csv":
      return importFromCsv(input);
    case "putty":
      return importFromPuttyReg(input);
    case "ssh_config":
      return importFromSshConfig(input);
    case "securecrt":
      return importFromSecureCrt(input, options?.fileName);
    case "mobaxterm":
      return importFromMobaXterm(input);
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
};

export function detectVaultImportFormat(text: string): VaultImportFormat | null {
  const input = (text ?? "").trim();
  if (!input) return null;

  if (
    /Windows Registry Editor Version/i.test(input)
    || /\\Software\\SimonTatham\\PuTTY\\Sessions/i.test(input)
  ) {
    return "putty";
  }

  const hasMobaBookmarkSection = /^\[Bookmarks(?:_\d+)?\]\s*$/im.test(input);
  const hasMobaBookmarkMetadata = /^SubRep=.*$/im.test(input) && /^ImgNum=\d+\s*$/im.test(input);
  const hasMobaSessionLine = /^[^=\r\n]+=\s*(?:; logout)?\s*#\d+#\d+%[^%\r\n]+%\d+/im.test(input);
  if (
    /\[MobaXterm\]/i.test(input)
    || (hasMobaBookmarkSection && (hasMobaBookmarkMetadata || hasMobaSessionLine))
  ) {
    return "mobaxterm";
  }

  if (/^Host\s+/m.test(input) && (/^\s+HostName\s+/m.test(input) || /^\s+User\s+/m.test(input))) {
    return "ssh_config";
  }

  if (/S:"Hostname"/m.test(input) && (/S:"Username"/m.test(input) || /D:"\[Sessions\]/i.test(input))) {
    return "securecrt";
  }

  const firstLine = input.split(/\r?\n/, 1)[0] ?? "";
  if (
    /hostname|host(name)?|server/i.test(firstLine)
    && (firstLine.includes(",") || firstLine.includes("\t"))
  ) {
    return "csv";
  }

  return null;
}

export function applyVaultHostImport(
  existingHosts: Host[],
  existingGroups: string[],
  importResult: VaultImportResult,
  options?: { skipDuplicates?: boolean },
): {
  hosts: Host[];
  customGroups: string[];
  addedCount: number;
  skippedExistingCount: number;
  addedHosts: Host[];
} {
  const skipDuplicates = options?.skipDuplicates !== false;
  const existingKeys = new Set(existingHosts.map(buildVaultHostMergeKey));
  let newHosts = importResult.hosts;
  let skippedExistingCount = 0;

  if (skipDuplicates) {
    newHosts = importResult.hosts.filter((host) => {
      const duplicate = existingKeys.has(buildVaultHostMergeKey(host));
      if (duplicate) skippedExistingCount++;
      return !duplicate;
    });
  }

  const customGroups = Array.from(
    new Set([
      ...existingGroups,
      ...importResult.groups,
      ...newHosts.map((host) => host.group).filter(Boolean),
    ]),
  ) as string[];

  return {
    hosts: [...existingHosts, ...newHosts].map(sanitizeHost),
    customGroups,
    addedCount: newHosts.length,
    skippedExistingCount,
    addedHosts: newHosts,
  };
}

export async function resolveVaultImportKeyPassphraseConflicts(
  entries: VaultHostKeyPassphrase[],
  resolveAliases: (keyPath: string) => Promise<string[]>,
  eligibleHostIds?: ReadonlySet<string>,
  eligibleKeyPathsByHostId?: ReadonlyMap<string, string>,
): Promise<{ keyPassphrases: VaultHostKeyPassphrase[]; issues: VaultImportIssue[] }> {
  const groups: Array<{
    aliases: Set<string>;
    entries: VaultHostKeyPassphrase[];
  }> = [];

  for (const entry of entries) {
    const aliases = new Set((await resolveAliases(entry.keyPath)).map(normalizeKeyPathKey));
    aliases.add(normalizeKeyPathKey(entry.keyPath));
    const eligibleKeyPath = eligibleKeyPathsByHostId?.get(entry.hostId);
    if (eligibleKeyPath) {
      const eligibleAliases = new Set(
        (await resolveAliases(eligibleKeyPath)).map(normalizeKeyPathKey),
      );
      eligibleAliases.add(normalizeKeyPathKey(eligibleKeyPath));
      if (![...aliases].some((alias) => eligibleAliases.has(alias))) continue;
    } else if (eligibleKeyPathsByHostId && eligibleHostIds?.has(entry.hostId)) {
      continue;
    }
    const matching = groups.filter((group) => (
      [...aliases].some((alias) => group.aliases.has(alias))
    ));
    const mergedAliases = new Set([
      ...aliases,
      ...matching.flatMap((group) => [...group.aliases]),
    ]);
    const mergedEntries = [
      ...matching.flatMap((group) => group.entries),
      entry,
    ];
    for (const group of matching) {
      groups.splice(groups.indexOf(group), 1);
    }
    groups.push({ aliases: mergedAliases, entries: mergedEntries });
  }

  const keyPassphrases: VaultHostKeyPassphrase[] = [];
  const issues: VaultImportIssue[] = [];
  for (const group of groups) {
    const passphrases = new Set(group.entries.map((entry) => entry.passphrase));
    if (passphrases.size > 1) {
      issues.push({
        level: "warning",
        message: `CSV contains conflicting passphrases for KeyPath "${group.entries[0].keyPath}"; no passphrase was saved for that path.`,
      });
    } else {
      const selected = eligibleHostIds
        ? group.entries.find((entry) => eligibleHostIds.has(entry.hostId))
        : group.entries[0];
      if (selected) keyPassphrases.push(selected);
    }
  }
  return { keyPassphrases, issues };
}

export interface VaultExistingKeyPassphraseRead {
  values: string[];
  unreadable: boolean;
}

export async function filterVaultImportKeyPassphrasesAgainstExisting(
  entries: VaultHostKeyPassphrase[],
  readExisting: (keyPath: string) => Promise<VaultExistingKeyPassphraseRead>,
): Promise<{ keyPassphrases: VaultHostKeyPassphrase[]; issues: VaultImportIssue[] }> {
  const keyPassphrases: VaultHostKeyPassphrase[] = [];
  const issues: VaultImportIssue[] = [];
  for (const entry of entries) {
    const existing = await readExisting(entry.keyPath);
    if (existing.unreadable) {
      issues.push({
        level: "warning",
        message: `Could not verify the existing saved passphrase for KeyPath "${entry.keyPath}"; the imported passphrase was not saved.`,
      });
      continue;
    }
    if (existing.values.some((value) => value !== entry.passphrase)) {
      issues.push({
        level: "warning",
        message: `CSV passphrase conflicts with an existing saved passphrase for KeyPath "${entry.keyPath}"; the existing passphrase was kept.`,
      });
      continue;
    }
    keyPassphrases.push(entry);
  }
  return { keyPassphrases, issues };
}
