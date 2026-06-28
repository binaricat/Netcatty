const MCP_TOOL_NAME_PREFIX = 'mcp__';

const KNOWN_ARTIFACT_TOOL_NAMES = [
  'terminal_read_context',
  'vault_notes_create',
  'vault_notes_update',
  'vault_notes_get',
  'vault_notes_list',
  'vault_hosts_create',
  'vault_hosts_import',
  'vault_hosts_list',
  'host_get',
  'snippets_list',
  'snippets_get',
  'snippets_create',
  'snippets_update',
  'snippets_delete',
  'snippets_run',
  'scripts_list',
  'scripts_get',
  'scripts_create',
  'scripts_update',
  'scripts_delete',
  'scripts_run',
  'scripts_reference',
  'scripts_runs_list',
  'scripts_run_stop',
  'scripts_run_pause',
  'scripts_run_resume',
  'scripts_targets_set',
] as const;

const CLI_ARTIFACT_TOOL_NAMES = new Map<string, string>([
  ['vault host get', 'host_get'],
]);

function readCommandString(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const raw = args.command;
  if (typeof raw === 'string') return raw || null;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const isShellWrap =
    raw.length >= 3 &&
    /(?:^|\/)(sh|bash|zsh|fish|ash|dash)$/.test(String(raw[0] ?? '')) &&
    /^-l?c$/.test(String(raw[1] ?? ''));

  return isShellWrap
    ? String(raw[raw.length - 1] ?? '') || null
    : raw.map((part) => String(part)).join(' ');
}

function unwrapShellCommand(command: string): string {
  const strWrap = command.match(
    /^(?:\S*\/)?(?:sh|bash|zsh|fish|ash|dash)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/,
  );
  return strWrap ? strWrap[2] : command;
}

function stripWrappingQuote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  return (first === last && (first === '"' || first === "'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function normalizeArtifactToolName(toolName: string | undefined): string | undefined {
  const trimmed = toolName?.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith(MCP_TOOL_NAME_PREFIX)) {
    const segments = trimmed.split('__').filter(Boolean);
    return segments[segments.length - 1] || trimmed;
  }

  const prefixedArtifactToolName = KNOWN_ARTIFACT_TOOL_NAMES.find((candidate) => (
    trimmed.endsWith(`_${candidate}`) || trimmed.endsWith(`-${candidate}`)
  ));
  if (prefixedArtifactToolName) return prefixedArtifactToolName;

  return trimmed;
}

export function inferArtifactToolNameFromCliArgs(
  args: Record<string, unknown> | undefined,
): string | undefined {
  const command = readCommandString(args);
  if (!command) return undefined;

  const unwrapped = unwrapShellCommand(command);
  const cliMatch = unwrapped.match(/(?:^|\s|["'])(?:\S*\/)?netcatty-tool-cli(?:\.(?:cjs|cmd))?(?=["'\s]|$)([\s\S]*)$/);
  if (!cliMatch) return undefined;

  const afterCli = stripWrappingQuote(cliMatch[1] ?? '').replace(/^["']?\s*/, '');
  const commandKey = afterCli
    .split(/\s+/)
    .filter((part) => part && !part.startsWith('-'))
    .slice(0, 3)
    .join(' ');

  return CLI_ARTIFACT_TOOL_NAMES.get(commandKey);
}
