/**
 * View models for `docker inspect` payloads (the summarized objects produced
 * by electron/bridges/systemManager/dockerOps.cjs). All fields are optional —
 * the raw payload shape varies across docker versions, so every accessor is
 * defensive.
 */

export interface ContainerInspectView {
  id?: string;
  image?: string;
  status?: string;
  startedAt?: string;
  createdAt?: string;
  restartPolicy?: string;
  command?: string;
  ports: string[];
  networks: string[];
  mounts: string[];
  env: string[];
  labels: string[];
}

export interface ImageInspectView {
  id?: string;
  tags: string[];
  digests: string[];
  createdAt?: string;
  size?: string;
  platform?: string;
  entrypoint?: string;
  cmd?: string;
  workdir?: string;
  exposedPorts: string[];
  env: string[];
  labels: string[];
}

type Dict = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function rec(value: unknown): Dict | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Dict)
    : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

export function shortDockerId(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  return raw.replace(/^sha256:/, '').slice(0, 12);
}

function formatIsoDate(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  // Docker uses 0001-01-01T00:00:00Z for "never".
  if (date.getTime() <= 0) return undefined;
  return date.toLocaleString();
}

export function formatBytes(value: unknown): string | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return undefined;
  if (num >= 1024 ** 3) return `${(num / 1024 ** 3).toFixed(2)} GB`;
  if (num >= 1024 ** 2) return `${(num / 1024 ** 2).toFixed(1)} MB`;
  if (num >= 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${num} B`;
}

function labelLines(value: unknown): string[] {
  const labels = rec(value);
  if (!labels) return [];
  return Object.entries(labels).map(([key, val]) => `${key}=${String(val ?? '')}`);
}

/** "0.0.0.0:8080->80/tcp" for published ports, "80/tcp" for exposed-only. */
function portLines(portsMap: unknown): string[] {
  const ports = rec(portsMap);
  if (!ports) return [];
  const lines: string[] = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      lines.push(containerPort);
      continue;
    }
    for (const binding of bindings) {
      const bind = rec(binding);
      const hostIp = str(bind?.HostIp) ?? '0.0.0.0';
      const hostPort = str(bind?.HostPort);
      lines.push(hostPort ? `${hostIp}:${hostPort} -> ${containerPort}` : containerPort);
    }
  }
  return [...new Set(lines)];
}

function commandLine(path: unknown, args: unknown): string | undefined {
  const parts = [str(path), ...strArray(args)].filter(Boolean) as string[];
  return parts.length ? parts.join(' ') : undefined;
}

function joinCommand(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const joined = value.map((v) => String(v)).join(' ').trim();
    return joined || undefined;
  }
  return str(value);
}

export function buildContainerInspectView(data: Dict): ContainerInspectView {
  const state = rec(data.state);
  const network = rec(data.network);

  let status = str(state?.Status);
  const exitCode = typeof state?.ExitCode === 'number' ? state.ExitCode : undefined;
  if (status && status !== 'running' && exitCode !== undefined && exitCode !== 0) {
    status = `${status} (exit ${exitCode})`;
  }

  const networks: string[] = [];
  const networksMap = rec(network?.Networks);
  if (networksMap) {
    for (const [name, info] of Object.entries(networksMap)) {
      const ip = str(rec(info)?.IPAddress);
      networks.push(ip ? `${name} · ${ip}` : name);
    }
  } else {
    const ip = str(network?.IPAddress);
    if (ip) networks.push(ip);
  }

  const mounts = Array.isArray(data.mounts)
    ? data.mounts.map((mount) => {
      const m = rec(mount);
      const source = str(m?.Source) ?? str(m?.Name) ?? str(m?.Type) ?? '?';
      const destination = str(m?.Destination) ?? '?';
      const mode = m?.RW === false ? 'ro' : 'rw';
      return `${source} -> ${destination} (${mode})`;
    })
    : [];

  const restartPolicy = str(rec(data.restartPolicy)?.Name);

  return {
    id: shortDockerId(data.id),
    image: str(data.image),
    status,
    startedAt: formatIsoDate(state?.StartedAt),
    createdAt: formatIsoDate(data.created),
    restartPolicy,
    command: commandLine(data.path, data.args),
    ports: portLines(network?.Ports),
    networks,
    mounts,
    env: strArray(data.env),
    labels: labelLines(data.labels),
  };
}

export function buildImageInspectView(data: Dict): ImageInspectView {
  const config = rec(data.config);
  const os = str(data.os);
  const arch = str(data.architecture);

  return {
    id: shortDockerId(data.id),
    tags: strArray(data.repoTags),
    digests: strArray(data.repoDigests),
    createdAt: formatIsoDate(data.created),
    size: formatBytes(data.size),
    platform: os && arch ? `${os}/${arch}` : os ?? arch,
    entrypoint: joinCommand(config?.entrypoint),
    cmd: joinCommand(config?.cmd),
    workdir: str(config?.workingDir),
    exposedPorts: Object.keys(rec(config?.exposedPorts) ?? {}),
    env: strArray(config?.env),
    labels: labelLines(config?.labels),
  };
}
