import type {
  VaultImportDestination,
  VaultImportFormat,
} from "../../domain/vaultImport";

export type VaultImportDestinationMode = "preserve" | "existing" | "new";

export function getVaultImportPickerMode(
  format: VaultImportFormat,
  source: "folder" | "file" = "folder",
): {
  directory: boolean;
  multiple: boolean;
} {
  const isBatchFolder = (format === "securecrt" || format === "finalshell")
    && source === "folder";
  return {
    directory: isBatchFolder,
    multiple: isBatchFolder,
  };
}

export function selectVaultImportFiles(
  format: VaultImportFormat,
  files: ArrayLike<File>,
): File[] {
  const selected = Array.from(files);
  return format === "securecrt" || format === "finalshell"
    ? selected
    : selected.slice(0, 1);
}

const normalizeGroup = (raw: string | undefined): string | undefined => {
  const parts = raw
    ?.replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts.join("/") : undefined;
};

export function buildVaultImportDestination({
  mode,
  existingGroup,
  newGroup,
  availableGroups,
}: {
  mode: VaultImportDestinationMode;
  existingGroup?: string;
  newGroup?: string;
  availableGroups?: string[];
}): VaultImportDestination | null {
  if (mode === "preserve") return { mode: "preserve" };
  const group = normalizeGroup(mode === "existing" ? existingGroup : newGroup);
  if (
    mode === "existing"
    && availableGroups
    && (!group || !availableGroups.includes(group))
  ) return null;
  return group ? { mode: "group", group } : null;
}
