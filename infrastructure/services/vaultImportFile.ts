import type { VaultImportFormat } from "../../domain/vaultImport";
import { readTextFile } from "../../lib/readTextFile";

export type VaultImportFileEncoding = "auto" | "utf-8" | "gb18030";

export const readVaultImportFile = (
  format: VaultImportFormat,
  file: File,
  encoding: VaultImportFileEncoding = "auto",
): Promise<string> => {
  if (format !== "mobaxterm") return readTextFile(file);
  if (encoding !== "auto") return readTextFile(file, { encoding });
  return readTextFile(file, { fallbackEncoding: "gb18030" });
};
