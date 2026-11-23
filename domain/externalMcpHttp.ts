export const EXTERNAL_MCP_HTTP_BEARER_ENV = "NETCATTY_MCP_BEARER_TOKEN";
export const DEFAULT_EXTERNAL_MCP_HTTP_PORT = 47391;
export const DEFAULT_EXTERNAL_MCP_HTTP_HOST = "127.0.0.1";
export const EXTERNAL_MCP_HTTP_PATH = "/mcp";

function isIpv4Address(value: string): boolean {
  const parts = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return parts !== null && parts.slice(1).every(
    (part) => Number(part) <= 255 && String(Number(part)) === part,
  );
}

export function isExternalMcpHttpIpAddress(value: string): boolean {
  if (isIpv4Address(value)) return true;

  const [literal, zone, ...extraZones] = value.split("%");
  if (extraZones.length || (zone !== undefined && !/^[0-9a-zA-Z.:-]+$/.test(zone))) return false;
  if (!literal.includes(":")) return false;

  let address = literal;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    if (!isIpv4Address(address.slice(lastColon + 1))) return false;
    // An embedded IPv4 tail occupies two IPv6 groups.
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => half ? half.split(":") : []);
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function isWildcardBind(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

export function buildExternalMcpHttpUrl(listenAddress: string, port: number, clientHost = ""): string {
  const host = isWildcardBind(listenAddress) ? clientHost.trim() : listenAddress;
  if (!host || isWildcardBind(host)) return "";
  return `http://${formatHostForUrl(host)}:${port}${EXTERNAL_MCP_HTTP_PATH}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCodexHttpToml(url: string): string {
  return [
    "[mcp_servers.netcatty-http]",
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(EXTERNAL_MCP_HTTP_BEARER_ENV)}`,
  ].join("\n");
}

export function buildCodexHttpEnvLine(token: string): string {
  return `export ${EXTERNAL_MCP_HTTP_BEARER_ENV}=${shellQuote(token)}`;
}

export function buildClaudeHttpAddCommand(url: string, token: string): string {
  return [
    "claude mcp add --transport http netcatty-http",
    shellQuote(url),
    "--header",
    shellQuote(`Authorization: Bearer ${token}`),
  ].join(" ");
}

export function buildGenericHttpMcpJson(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      "netcatty-http": {
        type: "http",
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
}
