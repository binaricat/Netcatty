import type { Host, HostAuthMethod } from './models';
import { applyHostAuthMethodSelection } from './sshAuth';
import { MAX_SSH_CONNECTION_TIMEOUT_SECONDS } from './sshConnectionTimeouts';

/**
 * Connection settings that agents may change on a saved host through
 * vault_hosts_update, in addition to the fields handled directly by
 * applyVaultHostUpdate. Credentials (password, keys, identities, SSH agent,
 * MFA/TOTP) and security-sensitive switches stay GUI-only on purpose.
 */
export const VAULT_HOST_CONNECTION_SETTING_FIELDS = [
  'authMethod',
  'deviceType',
  'sshInputCompatibility',
  'backspaceBehavior',
  'charset',
  'keepaliveOverride',
  'keepaliveInterval',
  'keepaliveCountMax',
  'sshTcpConnectTimeoutSeconds',
  'sshAuthReadyTimeoutSeconds',
  'sftpSudo',
  'sftpFileProtocol',
  'sftpEncoding',
] as const;

/**
 * resetFields entries and the stored host keys each one removes. Removing a
 * host value lets a group default apply again, or the global/app default for
 * settings that groups do not provide.
 */
const RESETTABLE_FIELDS: Record<string, readonly (keyof Host)[]> = {
  port: ['port'],
  proxy: ['proxyProfileId', 'proxyConfig', 'directProxy'],
  jumpHostIds: ['hostChain'],
  startupCommand: ['startupCommand'],
  startupCommandRunMode: ['startupCommandRunMode'],
  environmentVariables: ['environmentVariables'],
  moshEnabled: ['moshEnabled'],
  moshServerPath: ['moshServerPath'],
  etEnabled: ['etEnabled'],
  etPort: ['etPort'],
  deviceType: ['deviceType'],
  backspaceBehavior: ['backspaceBehavior'],
  charset: ['charset'],
  keepaliveOverride: ['keepaliveOverride'],
  keepaliveInterval: ['keepaliveInterval'],
  keepaliveCountMax: ['keepaliveCountMax'],
  sshTcpConnectTimeoutSeconds: ['sshTcpConnectTimeoutSeconds'],
  sshAuthReadyTimeoutSeconds: ['sshAuthReadyTimeoutSeconds'],
  sftpSudo: ['sftpSudo'],
  sftpFileProtocol: ['sftpFileProtocol'],
  sftpEncoding: ['sftpEncoding'],
};

export const VAULT_HOST_RESETTABLE_FIELDS = Object.keys(RESETTABLE_FIELDS);

/** Patch keys that set the same value a resetFields entry removes. */
const RESET_CONFLICT_KEYS: Record<string, readonly string[]> = {
  proxy: ['proxyProfileId', 'directProxy'],
};

/** Credential inputs that must not be combined with an authMethod change. */
const AUTH_METHOD_CONFLICT_KEYS = ['password', 'keyPath', 'keypath', 'identityId', 'passphrase'] as const;

const AUTH_METHODS: readonly HostAuthMethod[] = ['auto', 'password', 'key', 'certificate'];
/**
 * Terminal encodings Host Details offers (TerminalEncodingSelect). GBK-family
 * names are accepted because the terminal bridge decodes them as GB18030.
 */
const CHARSET_ALIASES: Record<string, 'UTF-8' | 'GB18030'> = {
  utf8: 'UTF-8',
  gb18030: 'GB18030',
  gbk: 'GB18030',
  gb2312: 'GB18030',
  cp936: 'GB18030',
};

/** Normalize an agent-provided charset to a Host Details encoding, or undefined if unsupported. */
export const normalizeAgentCharset = (raw: unknown): 'UTF-8' | 'GB18030' | undefined => (
  typeof raw === 'string' ? CHARSET_ALIASES[raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')] : undefined
);

type Failure = { ok: false; error: string };

const hasOwn = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const parseBooleanInput = (raw: unknown): boolean | undefined => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return undefined;
};

const parseIntegerInput = (raw: unknown, min: number, max: number): number | undefined => {
  const value = typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
};

const parseEnumInput = <T extends string>(raw: unknown, allowed: readonly T[]): T | undefined => {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  return allowed.find((entry) => entry.toLowerCase() === normalized);
};

/** Parse resetFields from a JSON array, an array, or a comma-separated string. */
export function parseVaultHostResetFields(raw: unknown): { ok: true; fields: string[] } | Failure {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { value = JSON.parse(trimmed); } catch { return { ok: false, error: 'resetFields must be a valid JSON array.' }; }
    } else {
      value = trimmed ? trimmed.split(',') : [];
    }
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return { ok: false, error: 'resetFields must be an array of field names.' };
  }
  const fields = Array.from(new Set(value.map((entry) => entry.trim()).filter(Boolean)));
  const unknown = fields.find((field) => !hasOwn(RESETTABLE_FIELDS, field));
  if (unknown) {
    return {
      ok: false,
      error: `resetFields cannot reset "${unknown}". Allowed: ${VAULT_HOST_RESETTABLE_FIELDS.join(', ')}.`,
    };
  }
  return { ok: true, fields };
}

/**
 * Remove host-level values listed in resetFields. Runs before the other patch
 * fields so the existing validation sees the inherited state.
 */
export function applyVaultHostResetFields(
  host: Host,
  source: Record<string, unknown>,
): { ok: true; host: Host } | Failure {
  if (!hasOwn(source, 'resetFields')) return { ok: true, host };
  const parsed = parseVaultHostResetFields(source.resetFields);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  for (const field of parsed.fields) {
    const conflicts = [field, ...(RESET_CONFLICT_KEYS[field] ?? [])];
    const conflict = conflicts.find((key) => hasOwn(source, key));
    if (conflict) return { ok: false, error: `${conflict} cannot be set and reset in the same update.` };
  }
  if (parsed.fields.includes('port') && host.protocol === 'serial') {
    return { ok: false, error: 'port cannot be reset on a serial host; change serialConfig.baudRate instead.' };
  }
  const next = { ...host } as Record<string, unknown>;
  for (const field of parsed.fields) {
    for (const key of RESETTABLE_FIELDS[field]) delete next[key];
  }
  return { ok: true, host: next as unknown as Host };
}

export function hasVaultHostConnectionSettingPatch(source: Record<string, unknown>): boolean {
  return hasOwn(source, 'resetFields')
    || VAULT_HOST_CONNECTION_SETTING_FIELDS.some((field) => hasOwn(source, field));
}

/**
 * Apply the agent-editable connection settings. Runs after the credential
 * fields so authMethod follows the same selection rules as Host Details.
 */
export function applyVaultHostConnectionSettings(
  host: Host,
  source: Record<string, unknown>,
  resolveEffectiveHost?: (host: Host) => Host,
): { ok: true; host: Host; warnings: string[] } | Failure {
  let updated: Host = { ...host };
  const warnings: string[] = [];
  const isSsh = updated.protocol === undefined || updated.protocol === 'ssh';

  if (hasOwn(source, 'deviceType')) {
    const deviceType = parseEnumInput(source.deviceType, ['general', 'network'] as const);
    if (!deviceType) return { ok: false, error: 'deviceType must be general or network.' };
    if (deviceType === 'network' && updated.protocol === 'local') {
      return { ok: false, error: 'deviceType network does not apply to local shell hosts.' };
    }
    updated.deviceType = deviceType;
  }

  if (hasOwn(source, 'sshInputCompatibility')) {
    const value = parseBooleanInput(source.sshInputCompatibility);
    if (value === undefined) return { ok: false, error: 'sshInputCompatibility must be true or false.' };
    if (!isSsh) return { ok: false, error: 'sshInputCompatibility only applies to SSH hosts.' };
    updated.sshInputCompatibility = value;
  }

  if (hasOwn(source, 'backspaceBehavior')) {
    if (parseEnumInput(source.backspaceBehavior, ['ctrl-h'] as const) !== 'ctrl-h') {
      return { ok: false, error: 'backspaceBehavior must be ctrl-h. Use resetFields ["backspaceBehavior"] to go back to the default or group value.' };
    }
    updated.backspaceBehavior = 'ctrl-h';
  }

  if (hasOwn(source, 'charset')) {
    const charset = normalizeAgentCharset(source.charset);
    if (!charset) {
      return { ok: false, error: 'charset must be UTF-8 or GB18030 (GBK and GB2312 are saved as GB18030). Use resetFields ["charset"] to inherit.' };
    }
    updated.charset = charset;
  }

  const keepaliveOverrideProvided = hasOwn(source, 'keepaliveOverride');
  const keepaliveOverride = keepaliveOverrideProvided ? parseBooleanInput(source.keepaliveOverride) : undefined;
  if (keepaliveOverrideProvided && keepaliveOverride === undefined) {
    return { ok: false, error: 'keepaliveOverride must be true or false.' };
  }
  const keepaliveValueProvided = hasOwn(source, 'keepaliveInterval') || hasOwn(source, 'keepaliveCountMax');
  if (keepaliveOverride === false && keepaliveValueProvided) {
    return { ok: false, error: 'keepaliveOverride false cannot be combined with keepaliveInterval or keepaliveCountMax.' };
  }
  if (hasOwn(source, 'keepaliveInterval')) {
    const value = parseIntegerInput(source.keepaliveInterval, 0, 3600);
    if (value === undefined) return { ok: false, error: 'keepaliveInterval must be an integer between 0 and 3600 seconds.' };
    updated.keepaliveInterval = value;
  }
  if (hasOwn(source, 'keepaliveCountMax')) {
    const value = parseIntegerInput(source.keepaliveCountMax, 1, 100);
    if (value === undefined) return { ok: false, error: 'keepaliveCountMax must be an integer between 1 and 100.' };
    updated.keepaliveCountMax = value;
  }
  if (keepaliveOverride === false) {
    updated.keepaliveOverride = undefined;
  } else if (keepaliveOverride === true || keepaliveValueProvided) {
    updated.keepaliveOverride = true;
  }

  for (const field of ['sshTcpConnectTimeoutSeconds', 'sshAuthReadyTimeoutSeconds'] as const) {
    if (!hasOwn(source, field)) continue;
    const value = parseIntegerInput(source[field], 1, MAX_SSH_CONNECTION_TIMEOUT_SECONDS);
    if (value === undefined) {
      return { ok: false, error: `${field} must be an integer between 1 and ${MAX_SSH_CONNECTION_TIMEOUT_SECONDS} seconds.` };
    }
    updated[field] = value;
  }

  if (hasOwn(source, 'sftpSudo')) {
    const value = parseBooleanInput(source.sftpSudo);
    if (value === undefined) return { ok: false, error: 'sftpSudo must be true or false.' };
    updated.sftpSudo = value;
  }
  if (hasOwn(source, 'sftpFileProtocol')) {
    const value = parseEnumInput(source.sftpFileProtocol, ['auto', 'sftp', 'scp'] as const);
    if (!value) return { ok: false, error: 'sftpFileProtocol must be auto, sftp, or scp.' };
    updated.sftpFileProtocol = value;
  }
  if (hasOwn(source, 'sftpEncoding')) {
    const value = parseEnumInput(source.sftpEncoding, ['auto', 'utf-8', 'gb18030'] as const);
    if (!value) return { ok: false, error: 'sftpEncoding must be auto, utf-8, or gb18030.' };
    updated.sftpEncoding = value;
  }

  if (hasOwn(source, 'authMethod')) {
    const authMethod = parseEnumInput(source.authMethod, AUTH_METHODS);
    if (!authMethod) return { ok: false, error: 'authMethod must be auto, password, key, or certificate.' };
    const conflict = AUTH_METHOD_CONFLICT_KEYS.find((key) => hasOwn(source, key));
    if (conflict) {
      return { ok: false, error: `authMethod cannot be combined with ${conflict}. Change the login method and the credentials in separate updates.` };
    }
    updated = applyHostAuthMethodSelection(updated, authMethod);
    const effective = resolveEffectiveHost?.(updated) ?? updated;
    if (
      (authMethod === 'key' || authMethod === 'certificate')
      && !effective.identityId
      && !effective.identityFileId
      && !effective.identityFilePaths?.some((path) => path.trim())
    ) {
      warnings.push(`No ${authMethod === 'key' ? 'key' : 'certificate'} is selected for this host. Choose one in Host Details before connecting.`);
    }
    if (authMethod === 'password' && !effective.identityId && !effective.password) {
      warnings.push('No password is saved for this host. Netcatty will ask for it when connecting.');
    }
  }

  return { ok: true, host: updated, warnings };
}
