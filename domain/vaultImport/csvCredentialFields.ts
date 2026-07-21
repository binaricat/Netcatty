const FORMULA_PREFIX = /^[=+\-@\t\r]/u;
const KEY_PATH_MARKER = "__netcatty_csv_keypath_v1__:";
const PASSPHRASE_MARKER = "__netcatty_csv_passphrase_v1__:";

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
