export interface QuickConnectTarget {
  hostname: string;
  username?: string;
  port?: number;
}

interface QuickConnectParseResult {
  target: QuickConnectTarget | null;
  warnings: string[];
}

const parseDirectTarget = (input: string): QuickConnectTarget | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pattern: [user@]hostname[:port]
  // Hostname can be IP (v4 or v6) or domain name
  const regex = /^(?:([^@]+)@)?([^\s:]+|\[[^\]]+\])(?::(\d+))?$/;
  const match = trimmed.match(regex);
  if (!match) return null;

  const [, username, hostname, portStr] = match;

  // Validate hostname looks like an IP or domain
  const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const ipv6Regex = /^\[?[a-fA-F0-9:]+\]?$/;
  const domainRegex =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

  if (
    !ipv4Regex.test(hostname) &&
    !ipv6Regex.test(hostname) &&
    !domainRegex.test(hostname)
  ) {
    return null;
  }

  const port = portStr ? parseInt(portStr, 10) : undefined;
  if (port !== undefined && (isNaN(port) || port < 1 || port > 65535)) {
    return null;
  }

  return {
    hostname: hostname.replace(/^\[|\]$/g, ""), // Remove IPv6 brackets
    username: username || undefined,
    port,
  };
};

const sshArgOptions = new Set([
  "-b",
  "-c",
  "-D",
  "-E",
  "-F",
  "-i",
  "-I",
  "-J",
  "-L",
  "-m",
  "-O",
  "-P",
  "-R",
  "-S",
  "-W",
  "-w",
]);

const parseSshOption = (
  raw: string,
  nextToken?: string,
): { key: string; value: string; consumedNext: boolean } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parts = trimmed.split("=");
  if (parts.length >= 2) {
    const key = parts[0]?.trim();
    const value = parts.slice(1).join("=").trim();
    if (key && value) {
      return { key, value, consumedNext: false };
    }
  }

  if (nextToken && !nextToken.startsWith("-")) {
    return { key: trimmed, value: nextToken, consumedNext: true };
  }

  return null;
};

const parseSshCommand = (input: string): QuickConnectParseResult | null => {
  const trimmed = input.trim();
  if (!/^ssh(\s|$)/i.test(trimmed)) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) return null;

  const warnings: string[] = [];
  let username: string | undefined;
  let optionUsername: string | undefined;
  let port: number | undefined;
  let optionPort: number | undefined;
  let portInvalid = false;
  let optionHostname: string | undefined;
  let hostToken: string | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "-p") {
      const value = tokens[i + 1];
      if (value) {
        port = parseInt(value, 10);
        if (Number.isNaN(port)) portInvalid = true;
        i++;
      }
      continue;
    }

    if (token.startsWith("-p") && token.length > 2) {
      const value = token.replace(/^-p=?/, "");
      if (value) {
        port = parseInt(value, 10);
        if (Number.isNaN(port)) portInvalid = true;
      }
      continue;
    }

    if (token === "-l") {
      const value = tokens[i + 1];
      if (value) {
        username = value;
        i++;
      }
      continue;
    }

    if (token.startsWith("-l") && token.length > 2) {
      const value = token.replace(/^-l=?/, "");
      if (value) username = value;
      continue;
    }

    if (token === "-o") {
      const optionToken = tokens[i + 1];
      if (optionToken) {
        const nextToken = tokens[i + 2];
        const parsed = parseSshOption(optionToken, nextToken);
        if (parsed) {
          const key = parsed.key.toLowerCase();
          if (key === "port") {
            const parsedPort = parseInt(parsed.value, 10);
            if (Number.isNaN(parsedPort)) {
              portInvalid = true;
            } else {
              optionPort = parsedPort;
            }
          } else if (key === "user") {
            optionUsername = parsed.value;
          } else if (key === "hostname") {
            optionHostname = parsed.value;
          } else {
            warnings.push(`-o ${parsed.key}`);
          }
          i += parsed.consumedNext ? 2 : 1;
          continue;
        }
        warnings.push("-o");
        i++;
      }
      continue;
    }

    if (token.startsWith("-o") && token.length > 2) {
      const parsed = parseSshOption(token.slice(2), tokens[i + 1]);
      if (parsed) {
        const key = parsed.key.toLowerCase();
        if (key === "port") {
          const parsedPort = parseInt(parsed.value, 10);
          if (Number.isNaN(parsedPort)) {
            portInvalid = true;
          } else {
            optionPort = parsedPort;
          }
        } else if (key === "user") {
          optionUsername = parsed.value;
        } else if (key === "hostname") {
          optionHostname = parsed.value;
        } else {
          warnings.push(`-o ${parsed.key}`);
        }
        if (parsed.consumedNext) i++;
        continue;
      }
      warnings.push("-o");
    }

    if (sshArgOptions.has(token)) {
      warnings.push(token);
      const next = tokens[i + 1];
      if (next) i++;
      continue;
    }

    if (token.startsWith("-")) {
      warnings.push(token);
      continue;
    }

    if (!hostToken) {
      hostToken = token;
    } else {
      warnings.push(token);
    }
  }

  if (!hostToken) return null;

  const base = optionHostname
    ? parseDirectTarget(optionHostname)
    : parseDirectTarget(hostToken);
  if (!base) return null;

  if (portInvalid) return null;

  const resolvedPort =
    port !== undefined && !Number.isNaN(port)
      ? port
      : optionPort !== undefined && !Number.isNaN(optionPort)
        ? optionPort
        : base.port;
  if (
    resolvedPort !== undefined &&
    (Number.isNaN(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535)
  ) {
    return null;
  }

  return {
    target: {
      hostname: base.hostname,
      username: optionUsername || username || base.username,
      port: resolvedPort,
    },
    warnings: Array.from(new Set(warnings)),
  };
};

// Parse user@host:port or ssh command formats with warning details
export function parseQuickConnectInputWithWarnings(
  input: string,
): QuickConnectParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { target: null, warnings: [] };

  const sshTarget = parseSshCommand(trimmed);
  if (sshTarget) return sshTarget;

  return { target: parseDirectTarget(trimmed), warnings: [] };
}

// Parse user@host:port or ssh command formats
export function parseQuickConnectInput(
  input: string,
): QuickConnectTarget | null {
  return parseQuickConnectInputWithWarnings(input).target;
}

// Check if input looks like a quick connect address
export function isQuickConnectInput(input: string): boolean {
  return parseQuickConnectInput(input) !== null;
}
