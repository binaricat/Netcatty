import { STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR } from "../../infrastructure/config/storageKeys";
import { localStorageAdapter } from "../../infrastructure/persistence/localStorageAdapter";

type YmodemFileMemoryStore = {
  readString: (key: string) => string | null;
  writeString: (key: string, value: string) => boolean;
};

const getParentDirectory = (filePath: string): string | null => {
  const lastForwardSlash = filePath.lastIndexOf("/");
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
  const lastSeparator = isWindowsPath
    ? Math.max(lastForwardSlash, filePath.lastIndexOf("\\"))
    : lastForwardSlash;

  if (lastSeparator < 0) return null;
  if (lastSeparator === 0) return filePath.slice(0, 1);
  if (lastSeparator === 2 && filePath[1] === ":") return filePath.slice(0, 3);

  return filePath.slice(0, lastSeparator);
};

export const getRememberedYmodemSendDefaultPath = (
  store: YmodemFileMemoryStore = localStorageAdapter,
): string | undefined => {
  const rememberedPath = store.readString(STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR);
  if (!rememberedPath || rememberedPath.trim() === "") return undefined;
  return rememberedPath;
};

export const rememberYmodemSendFilePath = (
  filePath: string,
  store: YmodemFileMemoryStore = localStorageAdapter,
): boolean => {
  const directory = getParentDirectory(filePath);
  if (!directory) return false;
  return store.writeString(STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR, directory);
};
