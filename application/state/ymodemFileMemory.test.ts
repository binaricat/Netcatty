import test from "node:test";
import assert from "node:assert/strict";

import * as storageKeys from "../../infrastructure/config/storageKeys.ts";
import { getRememberedYmodemSendDefaultPath, rememberYmodemSendFilePath } from "./ymodemFileMemory.ts";

type TestStore = {
  readString: (key: string) => string | null;
  writeString: (key: string, value: string) => boolean;
};

const createStore = (initial: Record<string, string> = {}): {
  store: TestStore;
  values: Map<string, string>;
} => {
  const values = new Map(Object.entries(initial));
  return {
    store: {
      readString: (key: string) => values.get(key) ?? null,
      writeString: (key: string, value: string) => {
        values.set(key, value);
        return true;
      },
    },
    values,
  };
};

test("uses the remembered YMODEM send directory as the file picker default path", () => {
  assert.equal(
    storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR,
    "netcatty_terminal_ymodem_send_dir_v1",
  );

  const { store } = createStore({
    [storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR]: "/firmware/releases",
  });

  assert.equal(getRememberedYmodemSendDefaultPath(store), "/firmware/releases");
});

test("preserves valid remembered directory whitespace", () => {
  const { store } = createStore({
    [storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR]: "/firmware/releases ",
  });

  assert.equal(getRememberedYmodemSendDefaultPath(store), "/firmware/releases ");
});

test("remembers the directory containing a selected YMODEM send file", () => {
  const { store, values } = createStore();

  assert.equal(rememberYmodemSendFilePath("/firmware/releases/device.bin", store), true);
  assert.equal(
    values.get(storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR),
    "/firmware/releases",
  );
});

test("keeps POSIX backslashes as part of the selected file name", () => {
  const { store, values } = createStore();

  assert.equal(rememberYmodemSendFilePath("/firmware/releases\\device.bin", store), true);
  assert.equal(
    values.get(storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR),
    "/firmware",
  );
});

test("remembers Windows-style YMODEM send directories", () => {
  const { store, values } = createStore();

  assert.equal(rememberYmodemSendFilePath("C:\\Users\\catty\\device.bin", store), true);
  assert.equal(
    values.get(storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR),
    "C:\\Users\\catty",
  );
});

test("ignores blank remembered paths and selected file names without a parent directory", () => {
  const { store, values } = createStore({
    [storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR]: "   ",
  });

  assert.equal(getRememberedYmodemSendDefaultPath(store), undefined);
  assert.equal(rememberYmodemSendFilePath("device.bin", store), false);
  assert.equal(values.get(storageKeys.STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR), "   ");
});
