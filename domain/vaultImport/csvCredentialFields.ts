const FORMULA_PREFIX = /^[=+\-@\t\r]/u;
const KEY_PATH_MARKER = "__netcatty_csv_keypath_v1__:";
const PASSPHRASE_MARKER = "__netcatty_csv_passphrase_v1__:";
const PROXY_MARKER = "__netcatty_csv_proxy_v1__:";
const LOCAL_SHELL_MARKER = "__netcatty_csv_localshell_v1__:";

const encodeMarkedField = (value: string, marker: string): string => (
  FORMULA_PREFIX.test(value) || value.startsWith(marker)
    ? `${marker}${encodeURIComponent(value)}`
    : value
);

const decodeMarkedField = (value: string, marker: string): string => {
  if (!value.startsWith(marker)) return value;
  try {
    return decodeURIComponent(value.slice(marker.length));
  } catch {
    return value;
  }
};

export const encodeCsvKeyPath = (value: string): string => (
  encodeMarkedField(value, KEY_PATH_MARKER)
);

export const decodeCsvKeyPath = (value: string): string => (
  decodeMarkedField(value, KEY_PATH_MARKER)
);

export const encodeCsvPassphrase = (value: string): string => (
  encodeMarkedField(value, PASSPHRASE_MARKER)
);

export const decodeCsvPassphrase = (value: string): string => (
  decodeMarkedField(value, PASSPHRASE_MARKER)
);

export const encodeCsvProxy = (value: string): string => (
  encodeMarkedField(value, PROXY_MARKER)
);

export const decodeCsvProxy = (value: string): string => (
  decodeMarkedField(value, PROXY_MARKER)
);

export interface CsvLocalShellSpec {
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  startDir?: string;
  /** Host OS of the local-shell entry; decides the default-shell fallback on connect. */
  os?: "linux" | "windows" | "macos";
}

export const encodeCsvLocalShell = (spec: CsvLocalShellSpec): string => (
  encodeMarkedField(JSON.stringify(spec), LOCAL_SHELL_MARKER)
);

const isNonEmptyString = (value: unknown): value is string => (
  typeof value === "string" && value.trim().length > 0
);

const isNonEmptyStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)
);

export const decodeCsvLocalShell = (value: string): CsvLocalShellSpec | null => {
  const raw = decodeMarkedField(value, LOCAL_SHELL_MARKER).trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const spec: CsvLocalShellSpec = {
      ...(isNonEmptyString(record.shell) ? { shell: record.shell } : {}),
      ...(isNonEmptyStringArray(record.shellArgs) ? { shellArgs: record.shellArgs } : {}),
      ...(isNonEmptyString(record.shellName) ? { shellName: record.shellName } : {}),
      ...(isNonEmptyString(record.shellIcon) ? { shellIcon: record.shellIcon } : {}),
      ...(isNonEmptyString(record.startDir) ? { startDir: record.startDir } : {}),
      ...(record.os === "linux" || record.os === "windows" || record.os === "macos"
        ? { os: record.os }
        : {}),
    };
    return Object.keys(spec).length > 0 ? spec : null;
  } catch {
    return null;
  }
};
