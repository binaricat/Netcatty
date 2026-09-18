import type { GroupConfig, Host, Identity, ProxyProfile } from '../models';
import { applyGroupDefaults, resolveGroupDefaults } from '../groupConfig';
import { isPluginHostProtocol } from '../pluginConnection';
import { hasUnreadableProxyCredential, materializeHostProxyProfile, resolveProxyConfigAuth } from '../proxyProfiles';
import { encodeCsvKeyPath, encodeCsvPassphrase, encodeCsvProxy } from './csvCredentialFields';
import { formatCsvProxy } from './csvProxy';

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
  const header = ["Groups", "Label", "Tags", "Notes", "Hostname/IP", "Protocol", "Port", "Username", "Password", "KeyPath", "Passphrase", "Proxy"];
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

const exportHostsToCsv = (hosts: Host[], options: VaultCsvExportOptions) => {
  const header = ["Groups", "Label", "Tags", "Notes", "Hostname/IP", "Protocol", "Port", "Username", "Password", "KeyPath", "Passphrase", "Proxy"];
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
  const inheritanceOptions = { validProxyProfileIds: new Set(proxyProfiles.map((profile) => profile.id)) };
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
    const effectiveHost = host.group
      ? applyGroupDefaults(host, resolveGroupDefaults(host.group, options.groupConfigs ?? [], inheritanceOptions), inheritanceOptions)
      : host;
    const proxyConfig = materializeHostProxyProfile(effectiveHost, proxyProfiles).proxyConfig;
    if (hasUnreadableProxyCredential(proxyConfig, options.identities)) {
      unreadableProxyCredentialCount += 1;
    }
    const proxyValue = proxyConfig
      ? formatCsvProxy(resolveProxyConfigAuth(proxyConfig, options.identities))
      : "";

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
    ]);
  }

  const passwordColIdx = header.indexOf("Password");
  const keyPathColIdx = header.indexOf("KeyPath");
  const passphraseColIdx = header.indexOf("Passphrase");
  const proxyColIdx = header.indexOf("Proxy");
  const csv = rows.map((r, rowIdx) => r.map((c, i) => escapeCsv(
    c,
    rowIdx > 0 && (i === passwordColIdx || i === keyPathColIdx || i === passphraseColIdx || i === proxyColIdx),
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
