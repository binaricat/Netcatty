const fs = require("node:fs");
const path = require("node:path");

const MANIFEST_PATTERN = /^MANIFEST-(\d+)$/;

function formatRecoveryTimestamp(now = Date.now) {
  const raw = typeof now === "function" ? now() : now;
  const date = raw instanceof Date ? raw : new Date(raw);
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return validDate.toISOString().replace(/[:.]/g, "-");
}

function resolveUniqueBackupDir(recoveryRoot, baseName, fsModule) {
  let candidate = path.join(recoveryRoot, baseName);
  let suffix = 1;
  while (true) {
    try {
      fsModule.statSync(candidate);
      candidate = path.join(recoveryRoot, `${baseName}-${suffix}`);
      suffix += 1;
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return candidate;
      }
      return candidate;
    }
  }
}

function guardLocalStorageLevelDb({
  userDataDir,
  now = Date.now,
  fsModule = fs,
} = {}) {
  if (typeof userDataDir !== "string" || userDataDir.length === 0) {
    return { status: "ok" };
  }

  const leveldbDir = path.join(userDataDir, "Local Storage", "leveldb");

  let dirStat;
  try {
    dirStat = fsModule.statSync(leveldbDir);
  } catch {
    return { status: "ok" };
  }
  if (!dirStat.isDirectory()) {
    return { status: "ok" };
  }

  const currentPath = path.join(leveldbDir, "CURRENT");
  try {
    const currentStat = fsModule.statSync(currentPath);
    if (!currentStat.isFile() || currentStat.size > 0) {
      return { status: "ok" };
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      return { status: "ok" };
    }
  }

  let entries;
  try {
    entries = fsModule.readdirSync(leveldbDir);
  } catch {
    return { status: "ok" };
  }

  const validManifests = [];
  let hasLdbFile = false;

  for (const name of entries) {
    if (typeof name !== "string") continue;
    const entryPath = path.join(leveldbDir, name);
    let entryStat;
    try {
      entryStat = fsModule.statSync(entryPath);
    } catch {
      continue;
    }
    if (!entryStat.isFile()) continue;

    const manifestMatch = MANIFEST_PATTERN.exec(name);
    if (manifestMatch) {
      if (entryStat.size > 0) {
        validManifests.push({
          name,
          index: BigInt(manifestMatch[1]),
        });
      }
      continue;
    }

    if (name.toLowerCase().endsWith(".ldb")) {
      hasLdbFile = true;
    }
  }

  if (validManifests.length === 0 && !hasLdbFile) {
    return { status: "ok" };
  }

  const timestamp = formatRecoveryTimestamp(now);
  const recoveryRoot = path.join(userDataDir, "recovery");
  const backupDir = resolveUniqueBackupDir(
    recoveryRoot,
    `leveldb-missing-current-${timestamp}`,
    fsModule,
  );

  try {
    fsModule.mkdirSync(recoveryRoot, { recursive: true });
    fsModule.cpSync(leveldbDir, backupDir, { recursive: true });
  } catch (error) {
    return {
      status: "backup_failed",
      backupDir,
      error,
    };
  }

  if (validManifests.length === 0) {
    return {
      status: "blocked",
      backupDir,
    };
  }

  validManifests.sort((a, b) => {
    if (a.index !== b.index) {
      return a.index > b.index ? -1 : 1;
    }
    return b.name.length - a.name.length
      || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  });

  const manifest = validManifests[0].name;
  const tempCurrentPath = path.join(
    leveldbDir,
    `.CURRENT.recovery.${process.pid}.${timestamp}.tmp`,
  );

  try {
    fsModule.writeFileSync(tempCurrentPath, `${manifest}\n`, "utf8");
    fsModule.renameSync(tempCurrentPath, currentPath);
  } catch (error) {
    try {
      if (typeof fsModule.rmSync === "function") {
        fsModule.rmSync(tempCurrentPath, { force: true });
      } else if (typeof fsModule.unlinkSync === "function") {
        fsModule.unlinkSync(tempCurrentPath);
      }
    } catch {
      // ignore temp cleanup failure
    }
    return {
      status: "blocked",
      backupDir,
      error,
    };
  }

  return {
    status: "recovered",
    manifest,
    backupDir,
  };
}

module.exports = {
  guardLocalStorageLevelDb,
};
