/**
 * Shell Discovery — cross-platform shell detection
 *
 * Detects available shells on Windows (CMD, PowerShell, WSL, Git Bash, Cygwin)
 * and Unix/macOS (via /etc/shells). Registry access on Windows uses `reg.exe`
 * via child_process — no native npm dependency.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXEC_OPTS = { encoding: "utf8", timeout: 5000, windowsHide: true };

/** Module-level cache for later use by the unified discoverShells() (Task 3). */
let cachedShells = null;

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Query a specific value from a Windows registry key.
 * Returns the value string, or `null` on failure.
 *
 * @param {string} keyPath  e.g. "HKLM\\SOFTWARE\\GitForWindows"
 * @param {string} valueName  e.g. "InstallPath"
 * @returns {string|null}
 */
function regQueryValue(keyPath, valueName) {
  try {
    // /ve queries the default (unnamed) value; /v queries a named value.
    const args =
      valueName === "" || valueName == null
        ? ["query", keyPath, "/ve"]
        : ["query", keyPath, "/v", valueName];
    const output = execFileSync("reg", args, EXEC_OPTS);
    // Output format:
    //   HKEY_LOCAL_MACHINE\SOFTWARE\GitForWindows
    //       InstallPath    REG_SZ    C:\Program Files\Git
    const lines = output.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^\s+.+?\s+REG_\w+\s+(.+)$/);
      if (match) {
        return match[1].trim();
      }
    }
  } catch (_err) {
    // Key or value not found — expected on many systems.
  }
  return null;
}

/**
 * Enumerate immediate subkey names under a registry key.
 * Returns an array of full subkey paths, or an empty array on failure.
 *
 * @param {string} keyPath  e.g. "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss"
 * @returns {string[]}
 */
function regEnumSubkeys(keyPath) {
  try {
    const output = execFileSync(
      "reg",
      ["query", keyPath],
      EXEC_OPTS,
    );
    // `reg query <key>` prints the key itself, then each subkey on its own line
    // prefixed with the full path. Values appear with leading whitespace.
    const lines = output.split(/\r?\n/).filter(Boolean);
    const subkeys = [];
    const normalizedParent = keyPath.toLowerCase();
    for (const line of lines) {
      const trimmed = line.trim();
      // Subkeys start with "HK" and are longer than the parent key.
      if (
        trimmed.toLowerCase().startsWith("hk") &&
        trimmed.toLowerCase() !== normalizedParent &&
        trimmed.toLowerCase().startsWith(normalizedParent + "\\")
      ) {
        subkeys.push(trimmed);
      }
    }
    return subkeys;
  } catch (_err) {
    // Key not found or access denied.
  }
  return [];
}

/**
 * Locate an executable on the system PATH using `where.exe`.
 * Returns the first valid, non-alias path, or `null` if not found.
 *
 * @param {string} name  Executable name, e.g. "pwsh"
 * @returns {string|null}
 */
function findExecutableOnPath(name) {
  try {
    const result = execFileSync("where.exe", [name], EXEC_OPTS);
    const candidates = result
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      // Skip Windows App Execution Aliases (WindowsApps zero-byte stubs).
      try {
        const localAppData = (process.env.LOCALAPPDATA || "").toLowerCase();
        if (
          localAppData &&
          candidate.toLowerCase().startsWith(
            path.join(localAppData, "Microsoft", "WindowsApps").toLowerCase() +
              path.sep,
          )
        ) {
          continue;
        }
      } catch (_e) {
        // Ignore — just use the candidate.
      }
      return candidate;
    }
  } catch (_err) {
    // Not found on PATH.
  }
  return null;
}

/**
 * Map a WSL distro name to an icon identifier for SVG lookup.
 *
 * @param {string} distroName  e.g. "Ubuntu-22.04", "Debian", "kali-linux"
 * @returns {string}
 */
function mapWslDistroIcon(distroName) {
  const lower = (distroName || "").toLowerCase();

  if (lower.includes("ubuntu")) return "ubuntu";
  if (lower.includes("debian")) return "debian";
  if (lower.includes("kali")) return "kali";
  if (lower.includes("alpine")) return "alpine";
  if (lower.includes("opensuse") || lower.includes("suse")) return "opensuse";
  if (lower.includes("fedora")) return "fedora";
  if (lower.includes("arch")) return "arch";
  if (lower.includes("oracle")) return "oracle";

  return "linux";
}

// ---------------------------------------------------------------------------
// Individual shell detectors
// ---------------------------------------------------------------------------

/**
 * Detect CMD.
 * @returns {object|null} DiscoveredShell or null
 */
function detectCmd() {
  try {
    const comSpec = process.env.ComSpec;
    const cmdPath = comSpec || "cmd.exe";
    // Verify the path actually exists when ComSpec provides a full path.
    if (comSpec && !fs.existsSync(comSpec)) {
      // Fallback to bare name — Windows will resolve it.
      return {
        id: "cmd",
        name: "CMD",
        command: "cmd.exe",
        args: [],
        icon: "cmd",
      };
    }
    return {
      id: "cmd",
      name: "CMD",
      command: cmdPath,
      args: [],
      icon: "cmd",
    };
  } catch (_err) {
    // Should never fail, but guard anyway.
  }
  return null;
}

/**
 * Detect Windows PowerShell 5.1.
 * @returns {object|null}
 */
function detectPowerShell() {
  try {
    // Try where.exe first.
    const found = findExecutableOnPath("powershell");
    if (found) {
      return {
        id: "powershell",
        name: "Windows PowerShell",
        command: found,
        args: ["-NoLogo"],
        icon: "powershell",
      };
    }

    // Fallback: well-known path.
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const fallback = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(fallback)) {
      return {
        id: "powershell",
        name: "Windows PowerShell",
        command: fallback,
        args: ["-NoLogo"],
        icon: "powershell",
      };
    }
  } catch (_err) {
    // Detection failed — not critical.
  }
  return null;
}

/**
 * Detect PowerShell Core (pwsh 7+).
 * @returns {object|null}
 */
function detectPwsh() {
  try {
    // 1. where.exe
    const found = findExecutableOnPath("pwsh");
    if (found) {
      return {
        id: "pwsh",
        name: "PowerShell 7",
        command: found,
        args: ["-NoLogo"],
        icon: "pwsh",
      };
    }

    // 2. Registry App Paths
    const regPath = regQueryValue(
      "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe",
      "",
    );
    if (regPath && fs.existsSync(regPath)) {
      return {
        id: "pwsh",
        name: "PowerShell 7",
        command: regPath,
        args: ["-NoLogo"],
        icon: "pwsh",
      };
    }

    // 3. Common fallback path.
    const fallback = path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    if (fs.existsSync(fallback) && fallback.toLowerCase().includes("powershell")) {
      return {
        id: "pwsh",
        name: "PowerShell 7",
        command: fallback,
        args: ["-NoLogo"],
        icon: "pwsh",
      };
    }
  } catch (_err) {
    // Detection failed.
  }
  return null;
}

/**
 * Detect installed WSL distributions via the registry.
 * @returns {object[]} Array of DiscoveredShell objects (may be empty).
 */
function detectWslDistros() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const wslExe = path.join(systemRoot, "System32", "wsl.exe");
  if (
    !fs.existsSync(wslExe) ||
    !path.dirname(wslExe).toLowerCase().endsWith("system32")
  ) {
    return [];
  }

  const distros = [];

  // Primary: use `wsl.exe -l -q` which lists installed distros one per line.
  // More reliable than registry parsing across Windows versions.
  // Note: wsl.exe outputs UTF-16LE on some builds, so we read as buffer and decode.
  try {
    const buf = execFileSync(wslExe, ["-l", "-q"], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1024 * 64,
    });
    // wsl.exe outputs UTF-16LE on most Windows builds (has NUL bytes between chars).
    // Detect by checking for NUL bytes in the raw buffer; if present → UTF-16LE, else UTF-8.
    const isUtf16 = buf.length >= 2 && buf.includes(0x00);
    const output = buf.toString(isUtf16 ? "utf16le" : "utf8");
    const names = output
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, "").trim())
      .filter(Boolean);

    for (const distroName of names) {
      distros.push({
        id: `wsl-${distroName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        name: `${distroName} (WSL)`,
        command: wslExe,
        args: ["-d", distroName],
        icon: mapWslDistroIcon(distroName),
      });
    }
    if (distros.length > 0) return distros;
  } catch (_err) {
    // wsl.exe -l -q failed, fall through to registry method.
  }

  // Fallback: enumerate registry subkeys under Lxss
  try {
    const lxssKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";
    const subkeys = regEnumSubkeys(lxssKey);

    for (const subkey of subkeys) {
      try {
        const distroName = regQueryValue(subkey, "DistributionName");
        if (!distroName) continue;

        distros.push({
          id: `wsl-${distroName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
          name: `${distroName} (WSL)`,
          command: wslExe,
          args: ["-d", distroName],
          icon: mapWslDistroIcon(distroName),
        });
      } catch (_err) {
        // Skip this distro but continue with others.
      }
    }
  } catch (_err) {
    // WSL not installed or registry not accessible.
  }
  return distros;
}

/**
 * Detect Git Bash (from Git for Windows).
 * @returns {object|null}
 */
function detectGitBash() {
  try {
    // Try registry first.
    const installPath = regQueryValue(
      "HKLM\\SOFTWARE\\GitForWindows",
      "InstallPath",
    );
    if (installPath) {
      const bashExe = path.join(installPath, "bin", "bash.exe");
      if (fs.existsSync(bashExe)) {
        return {
          id: "git-bash",
          name: "Git Bash",
          command: bashExe,
          args: ["--login", "-i"],
          icon: "git-bash",
        };
      }
    }

    // Fallback: common installation path.
    const fallbackPaths = [
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Git",
        "bin",
        "bash.exe",
      ),
    ];
    for (const p of fallbackPaths) {
      if (fs.existsSync(p)) {
        return {
          id: "git-bash",
          name: "Git Bash",
          command: p,
          args: ["--login", "-i"],
          icon: "git-bash",
        };
      }
    }
  } catch (_err) {
    // Git Bash not installed.
  }
  return null;
}

/**
 * Detect Cygwin bash.
 * @returns {object|null}
 */
function detectCygwin() {
  try {
    // Try 64-bit registry key first, then 32-bit (WOW6432Node).
    const rootDir =
      regQueryValue("HKLM\\SOFTWARE\\Cygwin\\setup", "rootdir") ||
      regQueryValue("HKLM\\SOFTWARE\\WOW6432Node\\Cygwin\\setup", "rootdir");

    if (rootDir) {
      const bashExe = path.join(rootDir, "bin", "bash.exe");
      if (fs.existsSync(bashExe)) {
        return {
          id: "cygwin",
          name: "Cygwin",
          command: bashExe,
          args: ["--login", "-i"],
          icon: "cygwin",
        };
      }
    }

    // Fallback: common path.
    const fallback = "C:\\cygwin64\\bin\\bash.exe";
    if (fs.existsSync(fallback)) {
      return {
        id: "cygwin",
        name: "Cygwin",
        command: fallback,
        args: ["--login", "-i"],
        icon: "cygwin",
      };
    }
  } catch (_err) {
    // Cygwin not installed.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main discovery entry point for Windows
// ---------------------------------------------------------------------------

/**
 * Discover all available shells on a Windows system.
 * Returns an array of DiscoveredShell objects. Exactly one shell will have
 * `isDefault: true` based on priority: pwsh > powershell > cmd.
 *
 * @returns {Array<{id: string, name: string, command: string, args: string[], icon: string, isDefault?: boolean}>}
 */
function discoverWindowsShells() {
  const shells = [];

  // Detect each shell type independently — failures are isolated.
  const cmd = detectCmd();
  if (cmd) shells.push(cmd);

  const powershell = detectPowerShell();
  if (powershell) shells.push(powershell);

  const pwsh = detectPwsh();
  if (pwsh) shells.push(pwsh);

  const wslDistros = detectWslDistros();
  shells.push(...wslDistros);

  const gitBash = detectGitBash();
  if (gitBash) shells.push(gitBash);

  const cygwin = detectCygwin();
  if (cygwin) shells.push(cygwin);

  // Assign default: pwsh > powershell > cmd
  const defaultShell =
    shells.find((s) => s.id === "pwsh") ||
    shells.find((s) => s.id === "powershell") ||
    shells.find((s) => s.id === "cmd");
  if (defaultShell) {
    defaultShell.isDefault = true;
  }

  return shells;
}

// ---------------------------------------------------------------------------
// Unix shell detection helpers
// ---------------------------------------------------------------------------

/**
 * Map a Unix shell binary basename to a human-readable display name.
 *
 * @param {string} basename  e.g. "zsh", "bash", "nu"
 * @returns {string}
 */
function mapUnixShellName(basename) {
  const map = {
    zsh: "Zsh",
    bash: "Bash",
    fish: "Fish",
    sh: "sh",
    ksh: "Ksh",
    tcsh: "Tcsh",
    csh: "Csh",
    dash: "Dash",
    nu: "Nushell",
    pwsh: "PowerShell",
  };
  return map[basename] || basename;
}

/**
 * Map a Unix shell binary basename to an icon identifier.
 *
 * @param {string} basename  e.g. "zsh", "fish", "nu"
 * @returns {string}
 */
function mapUnixShellIcon(basename) {
  const map = {
    zsh: "zsh",
    bash: "bash",
    fish: "fish",
    sh: "terminal",
    ksh: "terminal",
    tcsh: "terminal",
    csh: "terminal",
    dash: "terminal",
    nu: "nushell",
    pwsh: "pwsh",
  };
  return map[basename] || "terminal";
}

/**
 * Returns true for shells that should be launched with the `-l` (login) flag.
 *
 * @param {string} basename
 * @returns {boolean}
 */
function isLoginShell(basename) {
  return ["bash", "zsh", "fish", "ksh", "sh"].includes(basename);
}

// ---------------------------------------------------------------------------
// Main discovery entry point for Unix
// ---------------------------------------------------------------------------

/**
 * Discover all available shells on a Unix/macOS system by reading /etc/shells.
 * The shell referenced by $SHELL is marked as default. If $SHELL is not in
 * /etc/shells it is prepended to the list.
 *
 * @returns {Array<{id: string, name: string, command: string, args: string[], icon: string, isDefault?: boolean}>}
 */
function discoverUnixShells() {
  const shells = [];
  const seen = new Set();

  // Read /etc/shells — each non-comment line is an absolute path.
  let etcShellPaths = [];
  try {
    const content = fs.readFileSync("/etc/shells", "utf8");
    etcShellPaths = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (_err) {
    // /etc/shells not readable — fall through to $SHELL only.
  }

  // Filter to existing files and deduplicate by real path.
  const validPaths = [];
  for (const shellPath of etcShellPaths) {
    try {
      if (!fs.existsSync(shellPath)) continue;
      const real = fs.realpathSync(shellPath);
      if (seen.has(real)) continue;
      seen.add(real);
      validPaths.push(shellPath);
    } catch (_err) {
      // Skip unresolvable paths.
    }
  }

  // Build DiscoveredShell objects.
  // Track basename counts to detect duplicates (e.g., /bin/bash vs /usr/local/bin/bash)
  const baseCount = new Map();
  for (const shellPath of validPaths) {
    const base = path.basename(shellPath);
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }

  for (const shellPath of validPaths) {
    const base = path.basename(shellPath);
    const args = isLoginShell(base) ? ["-l"] : [];
    // Use basename as id when unique, otherwise use path slug to guarantee uniqueness
    const needsDisambiguation = baseCount.get(base) > 1;
    const id = needsDisambiguation
      ? shellPath.replace(/^\/+/, "").replace(/[/\\]+/g, "-")
      : base;
    const name = needsDisambiguation
      ? `${mapUnixShellName(base)} (${shellPath})`
      : mapUnixShellName(base);
    shells.push({
      id,
      name,
      command: shellPath,
      args,
      icon: mapUnixShellIcon(base),
    });
  }

  // Ensure $SHELL is present — prepend it if missing.
  const envShell = process.env.SHELL;
  if (envShell) {
    try {
      const envReal = fs.realpathSync(envShell);
      if (!seen.has(envReal) && fs.existsSync(envShell)) {
        const base = path.basename(envShell);
        const args = isLoginShell(base) ? ["-l"] : [];
        // Check if basename already exists in the list to disambiguate
        const hasDuplicate = shells.some((s) => path.basename(s.command) === base);
        const id = hasDuplicate
          ? envShell.replace(/^\/+/, "").replace(/[/\\]+/g, "-")
          : base;
        const name = hasDuplicate
          ? `${mapUnixShellName(base)} (${envShell})`
          : mapUnixShellName(base);
        shells.unshift({
          id,
          name,
          command: envShell,
          args,
          icon: mapUnixShellIcon(base),
        });
      }
    } catch (_err) {
      // $SHELL path invalid — ignore.
    }
  }

  // Mark $SHELL as default (match by command path or basename).
  if (envShell) {
    const defaultShell =
      shells.find((s) => s.command === envShell) ||
      shells.find((s) => s.id === path.basename(envShell));
    if (defaultShell) {
      defaultShell.isDefault = true;
    }
  }

  // Fallback: mark first shell as default if none matched.
  if (shells.length > 0 && !shells.some((s) => s.isDefault)) {
    shells[0].isDefault = true;
  }

  return shells;
}

// ---------------------------------------------------------------------------
// Unified shell discovery entry point
// ---------------------------------------------------------------------------

/**
 * Discover all available shells for the current platform.
 * Results are cached after the first call.
 *
 * @returns {Array<{id: string, name: string, command: string, args: string[], icon: string, isDefault?: boolean}>}
 */
function discoverShells() {
  if (cachedShells) return cachedShells;

  if (process.platform === "win32") {
    cachedShells = discoverWindowsShells();
  } else {
    cachedShells = discoverUnixShells();
  }

  return cachedShells;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  discoverShells,
  discoverWindowsShells,
  discoverUnixShells,
  mapUnixShellName,
  mapUnixShellIcon,
  isLoginShell,
  regQueryValue,
  regEnumSubkeys,
  findExecutableOnPath,
  mapWslDistroIcon,
};
