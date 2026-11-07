import type { GroupConfig, Host, Identity, ProxyProfile } from '../models';
import { applyGroupDefaults, resolveGroupDefaults } from '../groupConfig';
import { isPluginHostProtocol } from '../pluginConnection';
import { hasUnreadableProxyCredential, materializeHostProxyProfile, resolveProxyConfigAuth } from '../proxyProfiles';
import { canServeAsSshJumpHost } from '../terminalProtocol';
import { CsvLocalShellSpec, encodeCsvKeyPath, encodeCsvLocalShell, encodeCsvPassphrase, encodeCsvProxy, encodeCsvProxyJump } from './csvCredentialFields';
import { CSV_DIRECT_PROXY_VALUE, formatCsvProxy } from './csvProxy';

const UTF8_BOM = "\uFEFF";

export interface VaultCsvTemplateOptions {
  includeExampleRows?: boolean;
}

export interface VaultCsvExportOptions {
  keyPassphrases?: ReadonlyMap<string, string>;
  keyPassphrasesById?: ReadonlyMap<string, string>;
  keyPathsById?: ReadonlyMap<string, string>;
  proxyProfiles?: ProxyProfile[];
  identities?: Identity[];
  groupConfigs?: GroupConfig[];
}

export const resolveVaultCsvHostKeyPath = (
  host: Host,
  options: VaultCsvExportOptions = {},
): string => {
  const referencedPath = host.identityFileId
    ? options.keyPathsById?.get(host.identityFileId)?.trim()
    : undefined;
  return referencedPath
    || host.identityFilePaths?.find((path) => path.trim())?.trim()
    || "";
};

export const getVaultCsvTemplate = (
  opts: VaultCsvTemplateOptions = {},
): string => {
  const includeExampleRows = opts.includeExampleRows !== false;
  const header = ["Groups", "Label", "Tags", "Notes", "Hostname/IP", "Protocol", "Port", "Username", "Password", "KeyPath", "Passphrase", "Proxy", "ProxyJump", "LocalShell", "SshInputCompatibility"];
  const rows: string[][] = [header];
  if (includeExampleRows) {
    rows.push(["Project/Dev", "Web Server (dev)", "dev,web", "Dev web tier", "192.168.1.10", "ssh", "22", "root", "", "~/.ssh/id_ed25519", "", "socks5://127.0.0.1:1080"]);
    rows.push(["Project/Prod", "Web Server (prod)", "prod,web", "Production", "server-a.example.com", "ssh", "22", "ubuntu", "", "", ""]);
    rows.push(["Database", "DB", "db,mysql", "MySQL primary", "db.example.com", "ssh", "4567", "admin", "", "", ""]);
  }

  const escapeCsv = (value: string) => {
    if (value.includes('"')) value = value.replace(/"/g, '""');
    if (/[",\r\n]/.test(value)) return `"${value}"`;
    return value;
  };

  return rows.map((r) => r.map((c) => escapeCsv(c)).join(",")).join("\r\n") + "\r\n";
};

// The legacy CSV format has no per-host shell columns, so local-shell vault
// hosts are serialized as one encoded "LocalShell" field; hosts with a
// non-default shell are otherwise lost on reimport (backup data silently
// changed). Default-shell Windows/macOS local hosts still export their OS:
// reimport defaults to Linux, and the OS is part of the reimport dedupe key,
// so a macOS default-shell entry without an OS field would be reimported as
// (and collapse with) a Linux host. Linux default-shell hosts match the
// reimport default and need no field.
const getLocalShellSpec = (host: Host): CsvLocalShellSpec | null => (
  host.protocol === "local"
    && (host.localShell || host.localShellName || host.localShellIcon
      || host.localStartDir || host.localShellArgs?.length
      || host.os === "windows" || host.os === "macos")
    ? {
        shell: host.localShell || undefined,
        shellArgs: host.localShellArgs?.length ? host.localShellArgs : undefined,
        shellName: host.localShellName || undefined,
        shellIcon: host.localShellIcon || undefined,
        startDir: host.localStartDir || undefined,
        os: host.os === "windows" || host.os === "macos" ? host.os : undefined,
      }
    : null
);

const UNSAFE_PROXY_JUMP_USERNAME = /[\s,#@]/;
const UNSAFE_PROXY_JUMP_HOSTNAME = /[\s,#@]/;
const DEFAULT_PROXY_JUMP_PORT = 22;

// OpenSSH ProxyJump: [user@]host[:port], repeated. Port 22 is omitted.
// IPv6 is bracketed so the port separator stays unambiguous.
const formatCsvProxyJumpHop = (host: Host): string | null => {
  if (!canServeAsSshJumpHost(host)) return null;
  const username = host.username?.trim() ?? "";
  const hostname = host.hostname.trim().replace(/^\[(.*)\]$/u, "$1");
  if (!hostname) return null;
  if (username && UNSAFE_PROXY_JUMP_USERNAME.test(username)) return null;
  if (UNSAFE_PROXY_JUMP_HOSTNAME.test(hostname)) return null;
  const port = host.port ?? DEFAULT_PROXY_JUMP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const hostPart = hostname.includes(":") ? `[${hostname}]` : hostname;
  const withUser = username ? `${username}@${hostPart}` : hostPart;
  return port === DEFAULT_PROXY_JUMP_PORT ? withUser : `${withUser}:${port}`;
};

// An empty cell means "no chain". A chain is omitted entirely when any hop
// cannot be represented, so a shortened list is not written back as the truth.
const formatCsvProxyJump = (host: Host, allHosts: readonly Host[]): string => {
  const ids = host.hostChain?.hostIds ?? [];
  if (ids.length === 0) return "";
  const byId = new Map(allHosts.map((item) => [item.id, item]));
  const parts: string[] = [];
  for (const id of ids) {
    const hop = byId.get(id);
    const formatted = hop ? formatCsvProxyJumpHop(hop) : null;
    if (!formatted) return "";
    parts.push(formatted);
  }
  return parts.join(",");
};

const exportHostsToCsv = (hosts: Host[], options: VaultCsvExportOptions) => {
  const header = ["Groups", "Label", "Tags", "Notes", "Hostname/IP", "Protocol", "Port", "Username", "Password", "KeyPath", "Passphrase", "Proxy", "ProxyJump", "LocalShell", "SshInputCompatibility"];
  const rows: string[][] = [header];
  let unreadableProxyCredentialCount = 0;

  const escapeCsv = (value: string, skipFormulaGuard = false) => {
    // Prevent CSV formula injection by prefixing dangerous characters with a single quote
    // These characters can be interpreted as formulas by spreadsheet applications
    // Skip for password fields to preserve credentials verbatim for round-trip
    if (!skipFormulaGuard && /^[=+\-@\t\r]/.test(value)) {
      value = "'" + value;
    }
    if (value.includes('"')) value = value.replace(/"/g, '""');
    if (/[",\r\n]/.test(value)) return `"${value}"`;
    return value;
  };

  // Filter out transports the legacy CSV format cannot represent without
  // silently discarding protocol-owned configuration.
  // Note: mosh-enabled hosts are exported as SSH (losing mosh flag) rather than being skipped,
  // since exporting partial data is better than losing the entire host entry
  const isUnsupported = (h: Host) => h.protocol === "serial" || isPluginHostProtocol(h.protocol);
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

  const proxyProfiles = options.proxyProfiles ?? [];
  // Materialize group proxies so the file stays self-contained, but never the
  // ambient global default. An empty Proxy cell means inherit for grouped and
  // ungrouped hosts alike; injecting the global profile would embed its
  // credentials and change routing based only on whether `group` is set.
  const inheritanceOptions = {
    validProxyProfileIds: new Set(proxyProfiles.map((profile) => profile.id)),
    globalProxyProfileId: "",
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
    const keyPath = resolveVaultCsvHostKeyPath(host, options);
    const passphrase = keyPath
      ? (
          host.identityFileId
            ? (options.keyPassphrasesById?.get(host.identityFileId) ?? "")
            : (options.keyPassphrases?.get(keyPath) ?? "")
        )
      : "";
    // Proxy profiles are materialized inline so the CSV stays self-contained;
    // encrypted credential placeholders are never written to the file.
    const effectiveHost = applyGroupDefaults(
      host,
      host.group
        ? resolveGroupDefaults(host.group, options.groupConfigs ?? [], inheritanceOptions)
        : {},
      inheritanceOptions,
    );
    // `direct` is the reversible CSV form of directProxy. An empty Proxy cell
    // still means inherit, including a configured global default.
    let proxyValue = "";
    if (effectiveHost.directProxy === true) {
      proxyValue = CSV_DIRECT_PROXY_VALUE;
    } else {
      const proxyConfig = materializeHostProxyProfile(effectiveHost, proxyProfiles).proxyConfig;
      if (hasUnreadableProxyCredential(proxyConfig, options.identities)) {
        unreadableProxyCredentialCount += 1;
      }
      if (proxyConfig) {
        proxyValue = formatCsvProxy(resolveProxyConfigAuth(proxyConfig, options.identities));
      }
    }
    const localShellSpec = getLocalShellSpec(host);
    // Group defaults are already on effectiveHost, same as Proxy, so a chain
    // inherited from the group survives a file that has no group-config section.
    const proxyJumpValue = formatCsvProxyJump(effectiveHost, exportableHosts);

    rows.push([
      host.group ?? "",
      host.label ?? "",
      (host.tags ?? []).join(","),
      host.notes ?? "",
      formatHostname(host.hostname),
      host.protocol ?? "ssh",
      String(effectivePort),
      effectiveUsername,
      host.password ?? "",
      encodeCsvKeyPath(keyPath),
      encodeCsvPassphrase(passphrase),
      encodeCsvProxy(proxyValue),
      encodeCsvProxyJump(proxyJumpValue),
      localShellSpec ? encodeCsvLocalShell(localShellSpec) : "",
      host.protocol === undefined || host.protocol === "ssh" ? String(host.sshInputCompatibility ?? true) : "",
    ]);
  }

  const passwordColIdx = header.indexOf("Password");
  const keyPathColIdx = header.indexOf("KeyPath");
  const passphraseColIdx = header.indexOf("Passphrase");
  const proxyColIdx = header.indexOf("Proxy");
  const proxyJumpColIdx = header.indexOf("ProxyJump");
  const csv = rows.map((r, rowIdx) => r.map((c, i) => escapeCsv(
    c,
    rowIdx > 0 && (i === passwordColIdx || i === keyPathColIdx || i === passphraseColIdx || i === proxyColIdx || i === proxyJumpColIdx),
  )).join(",")).join("\r\n") + "\r\n";
  return { csv, unreadableProxyCredentialCount };
};

interface ExportHostsResult {
  csv: string;
  exportedCount: number;
  skippedCount: number;
  unreadableProxyCredentialCount: number;
}

export const exportHostsToCsvWithStats = (
  hosts: Host[],
  options: VaultCsvExportOptions = {},
): ExportHostsResult => {
  // Mosh hosts intentionally degrade to SSH, but namespaced plugin protocols
  // must be skipped because CSV has no field for their opaque configuration.
  const isUnsupported = (h: Host) => h.protocol === "serial" || isPluginHostProtocol(h.protocol);
  const skippedHosts = hosts.filter((h) => isUnsupported(h));
  const exportableHosts = hosts.filter((h) => !isUnsupported(h));
  const { csv, unreadableProxyCredentialCount } = exportHostsToCsv(exportableHosts, options);

  return {
    csv: UTF8_BOM + csv,
    exportedCount: exportableHosts.length,
    skippedCount: skippedHosts.length,
    unreadableProxyCredentialCount,
  };
};
