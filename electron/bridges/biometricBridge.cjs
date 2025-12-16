/**
 * Biometric Key Bridge - Termius-style Biometric SSH Keys
 * 
 * This module implements a biometric-protected SSH key system where:
 * 1. Standard ED25519 keys are generated using ssh-keygen
 * 2. A random UUID passphrase encrypts the private key
 * 3. The passphrase is stored in OS Secure Storage (Keychain/DPAPI via keytar)
 * 4. On use, the OS prompts for biometrics before releasing the passphrase
 * 
 * Platform behavior:
 * - macOS: Keychain automatically prompts for Touch ID / password
 * - Windows: We use electron-windows-security to call Windows Hello
 */

const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

// Service name for keytar (identifies our app in the credential store)
const KEYTAR_SERVICE = "com.netcatty.biometric-keys";

// Lazy-load keytar to handle cases where native module isn't available
let keytar = null;
function getKeytar() {
  if (keytar === null) {
    try {
      keytar = require("keytar");
    } catch (err) {
      console.error("[Biometric] Failed to load keytar:", err.message);
      keytar = false;
    }
  }
  return keytar || null;
}

// Lazy-load electron-windows-security for Windows Hello verification
let windowsSecurity = null;
function getWindowsSecurity() {
  if (process.platform !== "win32") return null;
  if (windowsSecurity === null) {
    try {
      windowsSecurity = require("electron-windows-security");
      console.log("[Biometric] electron-windows-security loaded successfully");
    } catch (err) {
      console.warn("[Biometric] electron-windows-security not available:", err.message);
      windowsSecurity = false;
    }
  }
  return windowsSecurity || null;
}

/**
 * Get the path to ssh-keygen executable
 */
function getSSHKeygenPath() {
  const platform = process.platform;

  if (platform === "win32") {
    // Windows native OpenSSH paths
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const nativePaths = [
      path.join(systemRoot, "System32", "OpenSSH", "ssh-keygen.exe"),
      path.join(systemRoot, "Sysnative", "OpenSSH", "ssh-keygen.exe"),
    ];

    // Git for Windows paths
    const gitPaths = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "usr", "bin", "ssh-keygen.exe"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "usr", "bin", "ssh-keygen.exe"),
    ].filter(Boolean);

    // Prefer native OpenSSH on Windows
    for (const nativePath of nativePaths) {
      if (fs.existsSync(nativePath)) {
        return nativePath;
      }
    }
    for (const gitPath of gitPaths) {
      if (fs.existsSync(gitPath)) {
        return gitPath;
      }
    }

    // Fallback to PATH
    try {
      const whereResult = execSync("where ssh-keygen", { encoding: "utf8", timeout: 5000 });
      const firstPath = whereResult.split("\n")[0]?.trim();
      if (firstPath && fs.existsSync(firstPath)) {
        return firstPath;
      }
    } catch {
      // Not found
    }
  } else {
    // macOS/Linux
    try {
      const whichResult = execSync("which ssh-keygen", { encoding: "utf8", timeout: 5000 });
      const sshKeygenPath = whichResult.trim();
      if (sshKeygenPath && fs.existsSync(sshKeygenPath)) {
        return sshKeygenPath;
      }
    } catch {
      // Not found
    }

    const commonPaths = [
      "/usr/bin/ssh-keygen",
      "/usr/local/bin/ssh-keygen",
      "/opt/homebrew/bin/ssh-keygen",
    ];

    for (const commonPath of commonPaths) {
      if (fs.existsSync(commonPath)) {
        return commonPath;
      }
    }
  }

  return null;
}

/**
 * Generate a high-entropy random passphrase
 */
function generateRandomPassphrase() {
  // Use UUID v4 for high-entropy passphrase (122 bits of randomness)
  return crypto.randomUUID();
}

/**
 * Check if biometric key features are available on this system
 */
async function checkBiometricSupport() {
  const kt = getKeytar();
  const sshKeygenPath = getSSHKeygenPath();
  const platform = process.platform;
  
  const result = {
    supported: false,
    hasKeytar: !!kt,
    hasSshKeygen: !!sshKeygenPath,
    sshKeygenPath,
    platform,
    hasWindowsHello: false,
    error: null,
  };

  if (!kt) {
    result.error = "Keytar (secure storage) is not available";
    return result;
  }

  if (!sshKeygenPath) {
    result.error = "ssh-keygen is not available";
    return result;
  }

  // Check Windows Hello availability on Windows
  if (platform === "win32") {
    const winSec = getWindowsSecurity();
    if (winSec && winSec.UserConsentVerifier) {
      try {
        const availability = await new Promise((resolve, reject) => {
          winSec.UserConsentVerifier.checkAvailabilityAsync((err, avail) => {
            if (err) reject(err);
            else resolve(avail);
          });
        });
        // UserConsentVerifierAvailability.available = 0
        result.hasWindowsHello = availability === 0 || availability === winSec.UserConsentVerifierAvailability.available;
        console.log("[Biometric] Windows Hello availability:", availability, result.hasWindowsHello);
      } catch (err) {
        console.warn("[Biometric] Windows Hello check failed:", err.message);
        result.hasWindowsHello = false;
      }
    }
  }

  result.supported = true;
  return result;
}

/**
 * Generate a biometric-protected SSH key
 * 
 * @param {Object} options
 * @param {string} options.keyId - Unique ID for this key (used as account name in keytar)
 * @param {string} options.label - Human-readable label for the key
 * @returns {Promise<Object>} Result with publicKey, privateKey, or error
 */
async function generateBiometricKey(options) {
  const { keyId, label } = options;

  if (!keyId || !label) {
    return { success: false, error: "keyId and label are required" };
  }

  const kt = getKeytar();
  if (!kt) {
    return { success: false, error: "Secure storage (keytar) is not available" };
  }

  const sshKeygenPath = getSSHKeygenPath();
  if (!sshKeygenPath) {
    return { success: false, error: "ssh-keygen is not available" };
  }

  // Generate random passphrase
  const passphrase = generateRandomPassphrase();

  // Create temp directory for key generation
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-biometric-"));
  const keyPath = path.join(tempDir, "id_ed25519");

  try {
    // Generate ED25519 key with passphrase using ssh-keygen
    console.log("[Biometric] Generating ED25519 key with passphrase...");
    
    await new Promise((resolve, reject) => {
      const args = [
        "-t", "ed25519",
        "-f", keyPath,
        "-N", passphrase,
        "-C", `${label}@netcatty-biometric`,
      ];

      const proc = spawn(sshKeygenPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`ssh-keygen exited with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });

    // Read the generated keys
    const privateKey = fs.readFileSync(keyPath, "utf8");
    const publicKey = fs.readFileSync(`${keyPath}.pub`, "utf8");

    // Store passphrase in OS secure storage
    console.log("[Biometric] Storing passphrase in secure storage...");
    await kt.setPassword(KEYTAR_SERVICE, keyId, passphrase);

    // Verify storage worked
    const storedPassphrase = await kt.getPassword(KEYTAR_SERVICE, keyId);
    if (storedPassphrase !== passphrase) {
      throw new Error("Failed to verify passphrase was stored correctly");
    }

    console.log("[Biometric] Key generated and passphrase stored successfully");

    return {
      success: true,
      privateKey,
      publicKey: publicKey.trim(),
      keyType: "ED25519",
    };
  } catch (err) {
    console.error("[Biometric] Key generation failed:", err);
    // Clean up stored passphrase on failure
    try {
      await kt.deletePassword(KEYTAR_SERVICE, keyId);
    } catch {
      // Ignore cleanup errors
    }
    return {
      success: false,
      error: err.message || "Key generation failed",
    };
  } finally {
    // Clean up temp files
    try {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(`${keyPath}.pub`)) fs.unlinkSync(`${keyPath}.pub`);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch (err) {
      console.warn("[Biometric] Temp cleanup failed:", err.message);
    }
  }
}

/**
 * Verify user with Windows Hello before allowing access
 * Uses electron-windows-security native module for reliable UI display
 * 
 * @param {string} reason - The reason for the verification prompt
 * @returns {Promise<boolean>} True if verified, false otherwise
 */
async function verifyWindowsHello(reason = "Unlock your SSH Key") {
  if (process.platform !== "win32") {
    // Not on Windows, no verification needed here
    // (macOS Keychain handles this automatically)
    return true;
  }

  const winSec = getWindowsSecurity();
  if (!winSec || !winSec.UserConsentVerifier) {
    console.warn("[Biometric] electron-windows-security not available, skipping verification");
    // SECURITY: If native module not available, we should fail closed
    return false;
  }

  try {
    console.log("[Biometric] Requesting Windows Hello verification via native module...");
    
    const result = await new Promise((resolve, reject) => {
      winSec.UserConsentVerifier.requestVerificationAsync(reason, (err, verificationResult) => {
        if (err) {
          reject(err);
        } else {
          resolve(verificationResult);
        }
      });
    });

    // UserConsentVerificationResult.verified = 0
    const verified = result === 0 || result === winSec.UserConsentVerificationResult.verified;
    console.log("[Biometric] Windows Hello result:", result, "verified:", verified);
    
    return verified;
  } catch (err) {
    console.error("[Biometric] Windows Hello verification failed:", err);
    return false;
  }
}

/**
 * Retrieve the passphrase for a biometric key
 * On Windows, this first verifies the user with Windows Hello
 * On macOS, the Keychain automatically prompts for Touch ID
 * 
 * @param {string} keyId - The key ID used when generating the key
 * @returns {Promise<Object>} Result with passphrase or error
 */
async function getBiometricPassphrase(keyId) {
  if (!keyId) {
    return { success: false, error: "keyId is required" };
  }

  const kt = getKeytar();
  if (!kt) {
    return { success: false, error: "Secure storage (keytar) is not available" };
  }

  try {
    // On Windows, verify with Windows Hello BEFORE accessing credential manager
    if (process.platform === "win32") {
      console.log("[Biometric] Requesting Windows Hello verification...");
      const verified = await verifyWindowsHello("Unlock SSH Key: " + keyId);
      if (!verified) {
        return { success: false, error: "Windows Hello verification failed or cancelled" };
      }
      console.log("[Biometric] Windows Hello verification successful");
    }

    // Retrieve passphrase from secure storage
    // On macOS, this will trigger Touch ID / password prompt automatically
    console.log("[Biometric] Retrieving passphrase from secure storage...");
    const passphrase = await kt.getPassword(KEYTAR_SERVICE, keyId);

    if (!passphrase) {
      return { success: false, error: "No passphrase found for this key" };
    }

    console.log("[Biometric] Passphrase retrieved successfully");
    return { success: true, passphrase };
  } catch (err) {
    console.error("[Biometric] Failed to retrieve passphrase:", err);
    return { success: false, error: err.message || "Failed to retrieve passphrase" };
  }
}

/**
 * Delete the stored passphrase for a biometric key
 * Should be called when the key is deleted
 * 
 * @param {string} keyId - The key ID
 * @returns {Promise<Object>} Result
 */
async function deleteBiometricPassphrase(keyId) {
  if (!keyId) {
    return { success: false, error: "keyId is required" };
  }

  const kt = getKeytar();
  if (!kt) {
    return { success: false, error: "Secure storage (keytar) is not available" };
  }

  try {
    const result = await kt.deletePassword(KEYTAR_SERVICE, keyId);
    console.log("[Biometric] Passphrase deleted:", result);
    return { success: true };
  } catch (err) {
    console.error("[Biometric] Failed to delete passphrase:", err);
    return { success: false, error: err.message };
  }
}

/**
 * List all stored biometric key IDs
 * Useful for cleanup and debugging
 * 
 * @returns {Promise<Object>} Result with array of keyIds
 */
async function listBiometricKeys() {
  const kt = getKeytar();
  if (!kt) {
    return { success: false, error: "Secure storage (keytar) is not available" };
  }

  try {
    const credentials = await kt.findCredentials(KEYTAR_SERVICE);
    const keyIds = credentials.map((c) => c.account);
    return { success: true, keyIds };
  } catch (err) {
    console.error("[Biometric] Failed to list keys:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Register IPC handlers for biometric key operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:biometric:checkSupport", async () => {
    return checkBiometricSupport();
  });

  ipcMain.handle("netcatty:biometric:generate", async (_event, options) => {
    return generateBiometricKey(options);
  });

  ipcMain.handle("netcatty:biometric:getPassphrase", async (_event, options) => {
    return getBiometricPassphrase(options?.keyId);
  });

  ipcMain.handle("netcatty:biometric:deletePassphrase", async (_event, options) => {
    return deleteBiometricPassphrase(options?.keyId);
  });

  ipcMain.handle("netcatty:biometric:listKeys", async () => {
    return listBiometricKeys();
  });
}

module.exports = {
  registerHandlers,
  checkBiometricSupport,
  generateBiometricKey,
  getBiometricPassphrase,
  deleteBiometricPassphrase,
  listBiometricKeys,
  verifyWindowsHello,
  KEYTAR_SERVICE,
};
