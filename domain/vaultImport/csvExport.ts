import type { Host } from '../models';

export interface VaultCsvTemplateOptions {
  includeExampleRows?: boolean;
}

export const getVaultCsvTemplate = (
  opts: VaultCsvTemplateOptions = {},
): string => {
  const includeExampleRows = opts.includeExampleRows !== false;
  const header = ["Groups", "Label", "Tags", "Hostname/IP", "Protocol", "Port", "Username", "Password"];
  const rows: string[][] = [header];
  if (includeExampleRows) {
    rows.push(["Project/Dev", "Web Server (dev)", "dev,web", "192.168.1.10", "ssh", "22", "root", ""]);
    rows.push(["Project/Prod", "Web Server (prod)", "prod,web", "server-a.example.com", "ssh", "22", "ubuntu", ""]);
    rows.push(["Database", "DB", "db,mysql", "db.example.com", "ssh", "4567", "admin", ""]);
  }

  const escapeCsv = (value: string) => {
    if (value.includes('"')) value = value.replace(/"/g, '""');
    if (/[",\r\n]/.test(value)) return `"${value}"`;
    return value;
  };

  return rows.map((r) => r.map((c) => escapeCsv(c)).join(",")).join("\r\n") + "\r\n";
};

const exportHostsToCsv = (hosts: Host[]): string => {
  const header = ["Groups", "Label", "Tags", "Hostname/IP", "Protocol", "Port", "Username", "Password"];
  const rows: string[][] = [header];

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
      host.password ?? "",
    ]);
  }

  const passwordColIdx = header.indexOf("Password");
  return rows.map((r, rowIdx) => r.map((c, i) => escapeCsv(c, rowIdx > 0 && i === passwordColIdx)).join(",")).join("\r\n") + "\r\n";
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
