import { Host, HostChainConfig, HostProtocol } from "./models";
import { parseQuickConnectInput } from "./quickConnect";

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

type VaultImportIssueLevel = "warning" | "error";

interface VaultImportIssue {
  level: VaultImportIssueLevel;
  message: string;
}

interface VaultImportStats {
  parsed: number;
  imported: number;
  skipped: number;
  duplicates: number;
}

interface VaultImportResult {
  hosts: Host[];
  groups: string[];
  issues: VaultImportIssue[];
  stats: VaultImportStats;
}

interface VaultCsvTemplateOptions {
  includeExampleRows?: boolean;
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
): Exclude<HostProtocol, "mosh"> | undefined => {
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

const hostKey = (h: Pick<Host, "hostname" | "port" | "username" | "protocol">) =>
  `${(h.protocol ?? "ssh").toLowerCase()}|${h.hostname.toLowerCase()}|${h.port}|${(h.username ?? "").toLowerCase()}`;

const createHost = (input: {
  label?: string;
  hostname: string;
  username?: string;
  port?: number;
  protocol?: Exclude<HostProtocol, "mosh">;
  group?: string;
  tags?: string[];
}): Host => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    label: input.label?.trim() || input.hostname,
    hostname: input.hostname.trim(),
    port: input.port ?? DEFAULT_SSH_PORT,
    username: input.username?.trim() ?? "",
    group: normalizeGroupPath(input.group),
    tags: (input.tags ?? []).filter(Boolean),
    os: "linux",
    protocol: input.protocol ?? "ssh",
    createdAt: now,
  };
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
): { hostname: string; username?: string; port?: number; protocol?: Exclude<HostProtocol, "mosh"> } | null => {
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

const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }

    field += ch;
  }

  row.push(field);
  rows.push(row);
  return rows;
};

const normalizeHeaderKey = (raw: string): string => {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
};

const findHeaderIndex = (headers: string[], candidates: string[]): number => {
  const normalized = headers.map((h) => normalizeHeaderKey(h));
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    for (let i = 0; i < normalized.length; i++) {
      const h = normalized[i];
      if (h === c || h.startsWith(c)) return i;
    }
  }
  return -1;
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
  const hostnameIdx = findHeaderIndex(header, ["hostname", "host", "server"]);
  const protocolIdx = findHeaderIndex(header, ["protocol", "proto", "scheme"]);
  const portIdx = findHeaderIndex(header, ["port"]);
  const usernameIdx = findHeaderIndex(header, ["username", "user", "login"]);

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
    const protocol =
      normalizeProtocol(protocolIdx >= 0 ? row[protocolIdx] : undefined) ??
      target.protocol ??
      "ssh";
    const port = parsePort(portIdx >= 0 ? row[portIdx] : undefined) ?? target.port;
    const username = (usernameIdx >= 0 ? row[usernameIdx] : undefined)?.trim() || target.username;

    parsedHosts.push(
      createHost({
        label,
        hostname: target.hostname,
        username,
        port,
        protocol,
        group,
        tags,
      }),
    );
  }

  const { hosts, duplicates } = dedupeHosts(parsedHosts);
  const groups = uniq(hosts.map((h) => h.group).filter(Boolean) as string[]);
  return {
    hosts,
    groups,
    issues,
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
    protocol?: Exclude<HostProtocol, "mosh">;
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
    protocol?: Exclude<HostProtocol, "mosh">;
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
    entries.push({ section, key: mKv[1].trim(), value: mKv[2].trim() });
  }

  const candidateEntries = entries.filter((e) =>
    ["sessions", "bookmarks", "bookmarks2", "bookmark"].includes(e.section.trim().toLowerCase()),
  );

  const parsedHosts: Host[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const e of candidateEntries) {
    const rawKey = e.key;
    const rawValue = e.value;
    if (!rawKey || !rawValue) continue;

    parsed++;

    const keyParts = rawKey.replace(/\\/g, "/").split("/").filter(Boolean);
    const label = keyParts[keyParts.length - 1] || rawKey;
    const group =
      keyParts.length > 1 ? keyParts.slice(0, -1).join("/") : undefined;

    let protocol: Exclude<HostProtocol, "mosh"> | undefined;
    let hostname: string | undefined;
    let username: string | undefined;
    let port: number | undefined;

    const tokens = rawValue
      .split("#")
      .map((t) => t.trim())
      .filter(Boolean);

    if (tokens.length > 0) {
      protocol =
        normalizeProtocol(tokens[0]) ??
        tokens.map((t) => normalizeProtocol(t)).find(Boolean);

      // Find a token that looks like [user@]host[:port]
      for (const tok of tokens) {
        const t = tok.replace(/^ssh:/i, "").trim();
        const target = parseTarget(t);
        if (target) {
          hostname = target.hostname;
          username = target.username ?? username;
          port = target.port ?? port;
          protocol = target.protocol ?? protocol;
          break;
        }
      }

      if (!hostname) {
        const hostToken = tokens.find(looksLikeHostnameToken);
        if (hostToken) {
          const target = parseTarget(hostToken);
          hostname = target?.hostname;
          username = target?.username;
          port = target?.port;
        }
      }

      const numericPort = tokens.map((t) => parsePort(t)).find(Boolean);
      if (numericPort) port = numericPort;

      if (!username) {
        const userToken = tokens.find((t) => t.includes("@"));
        if (userToken) username = userToken.split("@")[0];
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

export const getVaultCsvTemplate = (
  opts: VaultCsvTemplateOptions = {},
): string => {
  const includeExampleRows = opts.includeExampleRows !== false;
  const header = ["Groups", "Label", "Tags", "Hostname/IP", "Protocol", "Port", "Username"];
  const rows: string[][] = [header];
  if (includeExampleRows) {
    rows.push(["Project/Dev", "Web Server (dev)", "dev,web", "192.168.1.10", "ssh", "22", "root"]);
    rows.push(["Project/Prod", "Web Server (prod)", "prod,web", "server-a.example.com", "ssh", "22", "ubuntu"]);
    rows.push(["Database", "DB", "db,mysql", "db.example.com", "ssh", "4567", "admin"]);
  }

  const escapeCsv = (value: string) => {
    if (value.includes('"')) value = value.replace(/"/g, '""');
    if (/[",\r\n]/.test(value)) return `"${value}"`;
    return value;
  };

  return rows.map((r) => r.map((c) => escapeCsv(c)).join(",")).join("\r\n") + "\r\n";
};

const exportHostsToCsv = (hosts: Host[]): string => {
  const header = ["Groups", "Label", "Tags", "Hostname/IP", "Protocol", "Port", "Username"];
  const rows: string[][] = [header];

  const escapeCsv = (value: string) => {
    // Prevent CSV formula injection by prefixing dangerous characters with a single quote
    // These characters can be interpreted as formulas by spreadsheet applications
    if (/^[=+\-@\t\r]/.test(value)) {
      value = "'" + value;
    }
    if (value.includes('"')) value = value.replace(/"/g, '""');
    if (/[",\r\n]/.test(value)) return `"${value}"`;
    return value;
  };

  // Filter out serial hosts - CSV format doesn't support serial port configuration
  // Note: mosh-enabled hosts are exported as SSH (losing mosh flag) rather than being skipped,
  // since exporting partial data is better than losing the entire host entry
  const isUnsupported = (h: Host) => h.protocol === "serial";
  const exportableHosts = hosts.filter((h) => !isUnsupported(h));

  // Helper to bracket IPv6 addresses for CSV export
  // IPv6 addresses contain colons which would be misinterpreted as port separators on import
  const formatHostname = (hostname: string): string => {
    // Check if it looks like an IPv6 address (contains colons but not already bracketed)
    if (hostname.includes(":") && !hostname.startsWith("[")) {
      return `[${hostname}]`;
    }
    return hostname;
  };

  for (const host of exportableHosts) {
    // For telnet hosts, use telnet-specific port and username
    const isTelnet = host.protocol === "telnet";
    const effectivePort = isTelnet
      ? (host.telnetPort ?? host.port ?? 23)
      : (host.port ?? 22);
    const effectiveUsername = isTelnet
      ? (host.telnetUsername ?? host.username ?? "")
      : (host.username ?? "");

    rows.push([
      host.group ?? "",
      host.label ?? "",
      (host.tags ?? []).join(","),
      formatHostname(host.hostname),
      host.protocol ?? "ssh",
      String(effectivePort),
      effectiveUsername,
    ]);
  }

  return rows.map((r) => r.map((c) => escapeCsv(c)).join(",")).join("\r\n") + "\r\n";
};

interface ExportHostsResult {
  csv: string;
  exportedCount: number;
  skippedCount: number;
}

export const exportHostsToCsvWithStats = (hosts: Host[]): ExportHostsResult => {
  // Only serial hosts are truly unsupported - mosh hosts are exported as SSH
  const isUnsupported = (h: Host) => h.protocol === "serial";
  const skippedHosts = hosts.filter((h) => isUnsupported(h));
  const exportableHosts = hosts.filter((h) => !isUnsupported(h));

  return {
    csv: exportHostsToCsv(hosts),
    exportedCount: exportableHosts.length,
    skippedCount: skippedHosts.length,
  };
};

