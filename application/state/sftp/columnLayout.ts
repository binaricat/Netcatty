export type SortField = "name" | "size" | "modified" | "type" | "owner";
export type SortOrder = "asc" | "desc";

export interface ColumnWidths {
  name: number;
  modified: number;
  size: number;
  type: number;
  owner: number;
}

export type SftpColumnVisibility = Record<keyof ColumnWidths, boolean>;

export const DEFAULT_SFTP_COLUMN_VISIBILITY: SftpColumnVisibility = {
  name: true,
  modified: true,
  size: true,
  type: true,
  owner: true,
};

export const normalizeSftpColumnVisibility = (value: unknown): SftpColumnVisibility => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_SFTP_COLUMN_VISIBILITY;
  }

  const stored = value as Partial<Record<keyof ColumnWidths, unknown>>;
  return {
    name: true,
    modified: stored.modified !== false,
    size: stored.size !== false,
    type: stored.type !== false,
    owner: stored.owner !== false,
  };
};
