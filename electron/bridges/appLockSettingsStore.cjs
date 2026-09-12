const {
  pbkdf2,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");

const APP_LOCK_TIMEOUT_OPTIONS_MINUTES = [0, 1, 5, 15, 30, 60];

const DEFAULT_APP_LOCK_SETTINGS = Object.freeze({
  enabled: false,
  timeoutMinutes: 15,
  systemUnlockEnabled: false,
  systemUnlockAutoPromptEnabled: false,
  passwordVerifier: null,
});

const APP_LOCK_VERIFIER_VERSION = 1;
const APP_LOCK_ALGORITHM = "PBKDF2-SHA256";
const APP_LOCK_HASH_ITERATIONS = 210000;
const APP_LOCK_MIN_ITERATIONS = 100000;
const APP_LOCK_SALT_BYTES = 16;
const APP_LOCK_HASH_BYTES = 32;

function cloneSettings(settings) {
  return {
    enabled: settings.enabled === true,
    timeoutMinutes: normalizeAppLockTimeoutMinutes(settings.timeoutMinutes),
    systemUnlockEnabled:
      settings.systemUnlockEnabled === true &&
      settings.enabled === true &&
      settings.passwordVerifier !== null,
    systemUnlockAutoPromptEnabled:
      settings.systemUnlockAutoPromptEnabled === true &&
      settings.systemUnlockEnabled === true &&
      settings.enabled === true &&
      settings.passwordVerifier !== null,
    passwordVerifier: settings.passwordVerifier
      ? {
          version: settings.passwordVerifier.version,
          algorithm: settings.passwordVerifier.algorithm,
          iterations: settings.passwordVerifier.iterations,
          salt: settings.passwordVerifier.salt,
          hash: settings.passwordVerifier.hash,
        }
      : null,
  };
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeBase64Bytes(value) {
  if (typeof value !== "string" || value.length === 0) return null;

  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0) return null;
    if (bytes.toString("base64") !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

function normalizeAppLockTimeoutMinutes(input) {
  const value = typeof input === "string" && input.trim() !== "" ? Number(input) : input;
  return APP_LOCK_TIMEOUT_OPTIONS_MINUTES.includes(value)
    ? value
    : DEFAULT_APP_LOCK_SETTINGS.timeoutMinutes;
}

function normalizeAppLockPasswordVerifier(input) {
  if (!isRecord(input)) return null;
  if (input.version !== APP_LOCK_VERIFIER_VERSION) return null;
  if (input.algorithm !== APP_LOCK_ALGORITHM) return null;
  if (
    typeof input.iterations !== "number" ||
    !Number.isInteger(input.iterations) ||
    input.iterations < APP_LOCK_MIN_ITERATIONS
  ) {
    return null;
  }

  const saltBytes = decodeBase64Bytes(input.salt);
  if (!saltBytes || saltBytes.length !== APP_LOCK_SALT_BYTES) return null;

  const hashBytes = decodeBase64Bytes(input.hash);
  if (!hashBytes || hashBytes.length !== APP_LOCK_HASH_BYTES) return null;

  return {
    version: APP_LOCK_VERIFIER_VERSION,
    algorithm: APP_LOCK_ALGORITHM,
    iterations: input.iterations,
    salt: input.salt,
    hash: input.hash,
  };
}

function derivePasswordHash(password, saltBytes, iterations) {
  return new Promise((resolve, reject) => {
    pbkdf2(password, saltBytes, iterations, APP_LOCK_HASH_BYTES, "sha256", (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("base64"));
    });
  });
}

function normalizeAppLockSettings(input) {
  if (!isRecord(input)) return cloneSettings(DEFAULT_APP_LOCK_SETTINGS);

  const timeoutMinutes = normalizeAppLockTimeoutMinutes(input.timeoutMinutes);
  const passwordVerifier = normalizeAppLockPasswordVerifier(input.passwordVerifier);
  const enabled = input.enabled === true && passwordVerifier !== null;
  const systemUnlockEnabled = input.systemUnlockEnabled === true && enabled;
  const systemUnlockAutoPromptEnabled = input.systemUnlockAutoPromptEnabled === true && systemUnlockEnabled;

  return {
    enabled,
    timeoutMinutes,
    systemUnlockEnabled,
    systemUnlockAutoPromptEnabled,
    passwordVerifier,
  };
}

function canLockFromSettings(settings) {
  const normalized = normalizeAppLockSettings(settings);
  return normalized.enabled === true && normalized.passwordVerifier !== null;
}

/**
 * Hide-to-tray / app-hide locks are automatic. timeoutMinutes === 0 is
 * "Never lock automatically", so those background locks stay off. Startup
 * and manual locks still apply whenever canLockFromSettings is true.
 */
function shouldLockOnBackgroundHide(settings) {
  const normalized = normalizeAppLockSettings(settings);
  return canLockFromSettings(normalized) && normalized.timeoutMinutes > 0;
}

async function createAppLockPasswordVerifier(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("App lock password is required");
  }

  const saltBytes = randomBytes(APP_LOCK_SALT_BYTES);
  return {
    version: APP_LOCK_VERIFIER_VERSION,
    algorithm: APP_LOCK_ALGORITHM,
    iterations: APP_LOCK_HASH_ITERATIONS,
    salt: saltBytes.toString("base64"),
    hash: await derivePasswordHash(password, saltBytes, APP_LOCK_HASH_ITERATIONS),
  };
}

async function verifyAppLockPassword(password, verifier) {
  const normalized = normalizeAppLockPasswordVerifier(verifier);
  if (typeof password !== "string" || password.length === 0 || !normalized) {
    return false;
  }

  const saltBytes = decodeBase64Bytes(normalized.salt);
  const hashBytes = decodeBase64Bytes(normalized.hash);
  if (!saltBytes || !hashBytes) return false;

  const candidateBytes = Buffer.from(
    await derivePasswordHash(password, saltBytes, normalized.iterations),
    "base64",
  );
  if (candidateBytes.length !== hashBytes.length) return false;

  return timingSafeEqual(candidateBytes, hashBytes);
}

function createAppLockSettingsStore({
  filePath,
  readFile,
  writeFile,
  rename,
}) {
  if (!filePath) {
    throw new Error("createAppLockSettingsStore requires filePath");
  }
  if (typeof readFile !== "function") {
    throw new Error("createAppLockSettingsStore requires readFile");
  }
  if (typeof writeFile !== "function") {
    throw new Error("createAppLockSettingsStore requires writeFile");
  }

  let snapshot = cloneSettings(DEFAULT_APP_LOCK_SETTINGS);
  // Serialize load/save so concurrent mutations cannot race on the same .tmp
  // path or overwrite each other with stale snapshots (Codex P2).
  let writeChain = Promise.resolve();

  async function load() {
    let raw;

    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        snapshot = cloneSettings(DEFAULT_APP_LOCK_SETTINGS);
        return cloneSettings(snapshot);
      }
      throw err;
    }

    try {
      snapshot = normalizeAppLockSettings(JSON.parse(String(raw)));
    } catch {
      snapshot = cloneSettings(DEFAULT_APP_LOCK_SETTINGS);
    }

    return cloneSettings(snapshot);
  }

  async function save(nextSettings) {
    const run = async () => {
      const normalized = normalizeAppLockSettings(nextSettings);
      const payload = `${JSON.stringify(normalized, null, 2)}\n`;
      // Atomic replace: write unique temp then rename so a crash mid-write cannot
      // leave a truncated file that load() would treat as DEFAULT (Codex P2).
      if (typeof rename === "function") {
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(tmpPath, payload, { mode: 0o600 });
        await rename(tmpPath, filePath);
      } else {
        await writeFile(filePath, payload, { mode: 0o600 });
      }
      snapshot = normalized;
      return cloneSettings(snapshot);
    };
    const pending = writeChain.then(run, run);
    writeChain = pending.then(() => {}, () => {});
    return pending;
  }

  function getSnapshot() {
    return cloneSettings(snapshot);
  }

  return {
    load,
    save,
    getSnapshot,
  };
}

module.exports = {
  APP_LOCK_TIMEOUT_OPTIONS_MINUTES,
  DEFAULT_APP_LOCK_SETTINGS,
  canLockFromSettings,
  shouldLockOnBackgroundHide,
  createAppLockPasswordVerifier,
  createAppLockSettingsStore,
  normalizeAppLockPasswordVerifier,
  normalizeAppLockSettings,
  normalizeAppLockTimeoutMinutes,
  verifyAppLockPassword,
};
