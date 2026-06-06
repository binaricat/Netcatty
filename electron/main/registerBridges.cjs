"use strict";

let bridgesRegistered = false;
let cloudSyncSessionPassword = null;
const { readClipboardFiles } = require("../bridges/clipboardFiles.cjs");

function createBridgeRegistrar(context) {
  const {
    electronModule,
    app,
    BrowserWindow,
    shell,
    clipboard,
    path,
    fs,
    os,
    preload,
    effectiveDevServerUrl,
    isDev,
    appIcon,
    isMac,
    electronDir,
    sessions,
    sftpClients,
    CLOUD_SYNC_PASSWORD_FILE,
    getCliDiscoveryFilePath,
    sshBridge,
    sftpBridge,
    localFsBridge,
    transferBridge,
    portForwardingBridge,
    terminalBridge,
    crashLogBridge,
    ptyProcessTree,
    getOauthBridge,
    getGithubAuthBridge,
    getGoogleAuthBridge,
    getOnedriveAuthBridge,
    getCloudSyncBridge,
    getFileWatcherBridge,
    getTempDirBridge,
    getSessionLogsBridge,
    getCompressUploadBridge,
    getGlobalShortcutBridge,
    getCredentialBridge,
    getAutoUpdateBridge,
    getAiBridge,
    getWindowManager,
    getVaultBackupBridge,
    isPathInside,
  } = context;

  let bridgesRegistered = false;
  
  /**
   * Register all IPC bridges with Electron
   */
  const registerBridges = (win) => {
    if (bridgesRegistered) return;
    bridgesRegistered = true;
  
    const { ipcMain } = electronModule;
    const { safeStorage } = electronModule;
    const oauthBridge = getOauthBridge();
    const githubAuthBridge = getGithubAuthBridge();
    const googleAuthBridge = getGoogleAuthBridge();
    const onedriveAuthBridge = getOnedriveAuthBridge();
    const cloudSyncBridge = getCloudSyncBridge();
    const fileWatcherBridge = getFileWatcherBridge();
    const tempDirBridge = getTempDirBridge();
    const sessionLogsBridge = getSessionLogsBridge();
    const compressUploadBridge = getCompressUploadBridge();
    const globalShortcutBridge = getGlobalShortcutBridge();
    const credentialBridge = getCredentialBridge();
    const autoUpdateBridge = getAutoUpdateBridge();
    const aiBridge = getAiBridge();
    const vaultBackupBridge = getVaultBackupBridge();
  
    const getCloudSyncPasswordPath = () => {
      try {
        return path.join(app.getPath("userData"), CLOUD_SYNC_PASSWORD_FILE);
      } catch {
        return null;
      }
    };
  
    const readPersistedCloudSyncPassword = () => {
      try {
        if (!safeStorage?.isEncryptionAvailable?.()) return null;
        const filePath = getCloudSyncPasswordPath();
        if (!filePath || !fs.existsSync(filePath)) return null;
        const base64 = fs.readFileSync(filePath, "utf8");
        if (!base64) return null;
        const buf = Buffer.from(base64, "base64");
        const decrypted = safeStorage.decryptString(buf);
        return typeof decrypted === "string" && decrypted.length ? decrypted : null;
      } catch (err) {
        console.warn("[CloudSync] Failed to read persisted password:", err?.message || err);
        return null;
      }
    };
  
    const persistCloudSyncPassword = (password) => {
      try {
        if (!safeStorage?.isEncryptionAvailable?.()) return false;
        const filePath = getCloudSyncPasswordPath();
        if (!filePath) return false;
        const encrypted = safeStorage.encryptString(password);
        fs.writeFileSync(filePath, encrypted.toString("base64"), { mode: 0o600 });
        return true;
      } catch (err) {
        console.warn("[CloudSync] Failed to persist password:", err?.message || err);
        return false;
      }
    };
  
    const clearPersistedCloudSyncPassword = () => {
      try {
        const filePath = getCloudSyncPasswordPath();
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.warn("[CloudSync] Failed to clear persisted password:", err?.message || err);
      }
    };
  
    // Initialize bridges with shared dependencies
    const cliDiscoveryFilePath = getCliDiscoveryFilePath({ userDataDir: app.getPath("userData") });
    const deps = {
      sessions,
      sftpClients,
      electronModule,
      cliDiscoveryFilePath,
    };
  
    sshBridge.init(deps);
    sftpBridge.init(deps);
    transferBridge.init(deps);
    terminalBridge.init(deps);
    fileWatcherBridge.init(deps);
    globalShortcutBridge.init(deps);
    aiBridge.init(deps);
    crashLogBridge.init(deps);
  
    // Initialize compress upload bridge with transferBridge dependency
    compressUploadBridge.init({
      ...deps,
      transferBridge,
    });
  
    // Initialize temp directory (synchronously)
    tempDirBridge.ensureTempDir();
  
    // Register all IPC handlers
    sshBridge.registerHandlers(ipcMain);
    sftpBridge.registerHandlers(ipcMain);
    localFsBridge.registerHandlers(ipcMain);
    transferBridge.registerHandlers(ipcMain);
    portForwardingBridge.registerHandlers(ipcMain);
    terminalBridge.registerHandlers(ipcMain);
    oauthBridge.setupOAuthBridge(ipcMain);
    githubAuthBridge.registerHandlers(ipcMain);
    googleAuthBridge.registerHandlers(ipcMain, electronModule);
    onedriveAuthBridge.registerHandlers(ipcMain, electronModule);
    cloudSyncBridge.registerHandlers(ipcMain);
    fileWatcherBridge.registerHandlers(ipcMain);
    tempDirBridge.registerHandlers(ipcMain, shell);
    sessionLogsBridge.registerHandlers(ipcMain);
    compressUploadBridge.registerHandlers(ipcMain);
    globalShortcutBridge.registerHandlers(ipcMain);
    credentialBridge.registerHandlers(ipcMain, electronModule);
    autoUpdateBridge.init(deps);
    autoUpdateBridge.registerHandlers(ipcMain);
    aiBridge.registerHandlers(ipcMain);
    crashLogBridge.registerHandlers(ipcMain);
    vaultBackupBridge.registerHandlers(ipcMain, electronModule);
  
    // ZMODEM cancel handler
    ipcMain.on("netcatty:zmodem:cancel", (_event, payload) => {
      const session = sessions.get(payload.sessionId);
      if (session?.zmodemSentry) {
        session.zmodemSentry.cancel();
      }
    });
  
    // Fig autocomplete spec loader — uses dynamic import() since @withfig/autocomplete is ESM
    ipcMain.handle("netcatty:figspec:list", async () => {
      try {
        const fs = require("fs");
        const mod = await import("@withfig/autocomplete");
        const figSpecs = mod.default || [];
        // Merge local specs (covers commands missing from @withfig/autocomplete)
        const localSpecDir = path.join(electronDir, "specs");
        let localNames = [];
        try {
          localNames = fs.readdirSync(localSpecDir)
            .filter(f => f.endsWith(".js"))
            .map(f => f.slice(0, -3));
        } catch { /* no local specs dir */ }
        const merged = [...new Set([...figSpecs, ...localNames])];
        return merged;
      } catch (err) {
        console.warn("[Main] Failed to load fig spec list:", err?.message || err);
        return [];
      }
    });
    ipcMain.handle("netcatty:figspec:load", async (_event, commandName) => {
      try {
        // Sanitize: reject absolute paths, path traversal, and non-spec characters
        if (!commandName || commandName.startsWith("/") || commandName.startsWith("\\") ||
            commandName.includes("..") || !/^[@a-zA-Z0-9._/+-]+$/.test(commandName)) return null;
        const { pathToFileURL } = require("url");
        const fs = require("fs");
  
        // Try local specs first (covers commands missing from @withfig/autocomplete)
        const localSpec = path.join(electronDir, "specs", `${commandName}.js`);
        if (fs.existsSync(localSpec)) {
          const mod = await import(pathToFileURL(localSpec).href);
          const spec = mod.default?.default ?? mod.default ?? null;
          return spec ? JSON.parse(JSON.stringify(spec)) : null;
        }
  
        // Fall back to @withfig/autocomplete
        // Can't use `import("@withfig/autocomplete/build/...")` because the package's
        // "exports" field restricts allowed import paths. Use file URL to bypass.
        const specFile = path.join(electronDir, "..", "node_modules", "@withfig", "autocomplete", "build", `${commandName}.js`);
        const mod = await import(pathToFileURL(specFile).href);
        const spec = mod.default?.default ?? mod.default ?? null;
        // IPC requires serializable data — JSON round-trip strips functions/symbols
        return spec ? JSON.parse(JSON.stringify(spec)) : null;
      } catch (err) {
        console.warn("[Main] Failed to load fig spec:", commandName, err?.message);
        return null;
      }
    });
  
    // Local directory listing for autocomplete (local terminal sessions)
    ipcMain.handle("netcatty:local:listdir", async (_event, payload) => {
      try {
        const {
          path: dirPath,
          foldersOnly,
          filterPrefix = "",
          limit = 100,
        } = payload || {};
        if (typeof dirPath !== "string" || dirPath.length === 0) {
          return { success: false, entries: [], error: "Invalid directory path" };
        }
        const resolvedPath = dirPath.startsWith("~")
          ? dirPath.replace(/^~/, require("os").homedir())
          : dirPath;
        const normalizedPrefix = typeof filterPrefix === "string" ? filterPrefix.toLowerCase() : "";
        const maxEntries = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 100;
        const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
          if (result.length >= maxEntries) break;
          if (entry.name === "." || entry.name === "..") continue;
          if (normalizedPrefix && !entry.name.toLowerCase().startsWith(normalizedPrefix)) continue;
          let type = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
          if (foldersOnly) {
            if (type === "directory") {
              // keep
            } else if (type === "symlink") {
              try {
                const stat = await fs.promises.stat(path.join(resolvedPath, entry.name));
                if (!stat.isDirectory()) continue;
              } catch {
                continue;
              }
            } else {
              continue;
            }
          }
          result.push({ name: entry.name, type });
        }
        return { success: true, entries: result };
      } catch {
        return { success: false, entries: [] };
      }
    });
  
    // Settings window handler
    ipcMain.handle("netcatty:settings:open", async (event) => {
      try {
        await getWindowManager().openSettingsWindow(electronModule, {
          preload,
          devServerUrl: effectiveDevServerUrl,
          isDev,
          appIcon,
          isMac,
          electronDir,
          sourceWindow: BrowserWindow.fromWebContents(event.sender),
        });
        return true;
      } catch (err) {
        console.error("[Main] Failed to open settings window:", err);
        return false;
      }
    });

    ipcMain.handle("netcatty:window:openSession", async (_event, payload) => {
      try {
        if (!payload || typeof payload !== "object" || !payload.sourceSession) {
          return { success: false, error: "Invalid session payload" };
        }
        const title = typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim()
          : "Netcatty";
        const win = await getWindowManager().createWindow(electronModule, {
          preload,
          devServerUrl: effectiveDevServerUrl,
          isDev,
          appIcon,
          isMac,
          electronDir,
          onRegisterBridge: registerBridges,
        });
        try {
          win.setTitle(title);
        } catch {
          // ignore
        }
        const delivery = await getWindowManager().sendWhenRendererReady(
          win,
          "netcatty:window:openSession",
          {
            title,
            sourceSession: payload.sourceSession,
            localShellType: payload.localShellType,
          },
          { timeoutMs: 8000 },
        );
        if (!delivery.success) {
          console.warn(
            "[Main] New session window could not receive the duplicated tab:",
            delivery.reason || delivery.error,
          );
          return { success: false, error: delivery.error || "Failed to open new window" };
        }
        return { success: true };
      } catch (err) {
        console.error("[Main] Failed to open session in new window:", err);
        return { success: false, error: err?.message || "Failed to open new window" };
      }
    });
  
    // Cloud sync master password (stored in-memory + persisted via safeStorage)
    ipcMain.handle("netcatty:cloudSync:session:setPassword", async (_event, password) => {
      cloudSyncSessionPassword = typeof password === "string" && password.length ? password : null;
      if (cloudSyncSessionPassword) {
        persistCloudSyncPassword(cloudSyncSessionPassword);
      } else {
        clearPersistedCloudSyncPassword();
      }
      return true;
    });
  
    ipcMain.handle("netcatty:cloudSync:session:getPassword", async () => {
      if (cloudSyncSessionPassword) return cloudSyncSessionPassword;
      const persisted = readPersistedCloudSyncPassword();
      cloudSyncSessionPassword = persisted;
      return persisted;
    });
  
    ipcMain.handle("netcatty:cloudSync:session:clearPassword", async () => {
      cloudSyncSessionPassword = null;
      clearPersistedCloudSyncPassword();
      return true;
    });
  
    // Open external URL in default browser. Falls back to an in-app
    // BrowserWindow when the OS has no handler for the URL (e.g. Windows with
    // no default browser configured — error 0x483). Rejects only in the rare
    // case where both the system browser AND the fallback window fail, so
    // existing callers that rely on rejection semantics still abort cleanly.
    ipcMain.handle("netcatty:openExternal", async (_event, url) => {
      const { shell } = electronModule;
      await getWindowManager().tryOpenExternalWithFallback(shell, url);
    });
  
    ipcMain.handle("netcatty:openPath", async (_event, targetPath) => {
      if (typeof targetPath !== "string" || targetPath.trim() === "") {
        return { success: false, error: "Invalid path" };
      }
  
      try {
        const { shell } = electronModule;
        const error = await shell.openPath(targetPath);
        return error ? { success: false, error } : { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  
    // App information for About/Application screens
    ipcMain.handle("netcatty:app:getInfo", async () => {
      return {
        name: app.getName(),
        version: app.getVersion(),
        platform: process.platform,
      };
    });
  
    // PTY child process list for busy-check before close
    ipcMain.handle("netcatty:pty:childProcesses", async (_event, sessionId) => {
      if (typeof sessionId !== "string") return [];
      return ptyProcessTree.getChildProcesses(sessionId);
    });
  
    // Native confirmation dialog when closing a session with a running process
    // Returns true only if the user explicitly clicks "Close". ESC/dialog-dismiss
    // resolves as cancelId (0) → false, which is the safe default (do not close).
    ipcMain.handle(
      "netcatty:dialog:confirmCloseBusy",
      async (event, payload) => {
        const command = typeof payload?.command === "string" ? payload.command : "unknown";
        const title = typeof payload?.title === "string" ? payload.title : "Confirm close";
        const message = typeof payload?.message === "string"
          ? payload.message
          : `Process "${command}" is still running and will be terminated.`;
        const cancelLabel = typeof payload?.cancelLabel === "string" ? payload.cancelLabel : "Cancel";
        const closeLabel = typeof payload?.closeLabel === "string" ? payload.closeLabel : "Close";
        const { dialog } = electronModule;
        const win = BrowserWindow.fromWebContents(event.sender);
        const { response } = await dialog.showMessageBox(win || undefined, {
          type: "warning",
          title,
          message,
          buttons: [cancelLabel, closeLabel],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        return response === 1; // true = user picked Close
      },
    );
  
    // Clipboard helpers for renderer fallback paths (e.g. Monaco paste in Electron)
    ipcMain.handle("netcatty:clipboard:readText", async () => {
      try {
        return clipboard?.readText?.() || "";
      } catch {
        return "";
      }
    });

    ipcMain.handle("netcatty:clipboard:writeText", async (_event, text) => {
      try {
        if (typeof clipboard?.writeText !== "function") return false;
        clipboard.writeText(typeof text === "string" ? text : "");
        return true;
      } catch {
        return false;
      }
    });

    ipcMain.handle("netcatty:clipboard:readFiles", async () => {
      return readClipboardFiles({ clipboard, fsImpl: fs, pathImpl: path });
    });
  
    // Select an application from system file picker
    ipcMain.handle("netcatty:selectApplication", async () => {
      const { dialog } = electronModule;
      
      let filters = [];
      let defaultPath;
      
      if (process.platform === "darwin") {
        filters = [{ name: "Applications", extensions: ["app"] }];
        defaultPath = "/Applications";
      } else if (process.platform === "win32") {
        filters = [{ name: "Executables", extensions: ["exe", "com", "bat", "cmd"] }];
        defaultPath = "C:\\Program Files";
      } else {
        // Linux - no specific filter, user can pick any executable
        filters = [{ name: "All Files", extensions: ["*"] }];
        defaultPath = "/usr/bin";
      }
      
      const result = await dialog.showOpenDialog({
        title: "Select Application",
        defaultPath,
        filters,
        properties: ["openFile"],
      });
      
      if (result.canceled || !result.filePaths.length) {
        return null;
      }
      
      const appPath = result.filePaths[0];
      const appName = path.basename(appPath).replace(/\.[^.]+$/, "");
      
      return { path: appPath, name: appName };
    });
  
    // Open a file with a specific application
    ipcMain.handle("netcatty:openWithApplication", async (_event, { filePath, appPath }) => {
      const { spawn: cpSpawn } = require("node:child_process");
      
      console.log(`[Main] Opening file with application:`);
      console.log(`[Main]   File: ${filePath}`);
      console.log(`[Main]   App: ${appPath}`);
      console.log(`[Main]   Platform: ${process.platform}`);
      
      try {
        let child;
        if (process.platform === "darwin") {
          // On macOS, use 'open' command with -a flag for specific app
          const args = ["-a", appPath, filePath];
          console.log(`[Main]   Command: open ${args.join(' ')}`);
          child = cpSpawn("open", args, { detached: true, stdio: "pipe" });
        } else if (process.platform === "win32") {
          // On Windows, use cmd /c start to properly handle paths with spaces
          // The empty string "" as window title is required when the first arg has quotes
          const args = ["/c", "start", "\"\"", `"${appPath}"`, `"${filePath}"`];
          console.log(`[Main]   Command: cmd ${args.join(' ')}`);
          child = cpSpawn("cmd", args, { detached: true, stdio: "pipe", windowsVerbatimArguments: true });
        } else {
          // On Linux, spawn the app with the file
          console.log(`[Main]   Command: ${appPath} ${filePath}`);
          child = cpSpawn(appPath, [filePath], { detached: true, stdio: "pipe" });
        }
        
        // Log any errors from the child process
        child.on("error", (err) => {
          console.error(`[Main] Failed to start application:`, err.message);
        });
        
        child.stderr?.on("data", (data) => {
          // On Windows, stderr may be encoded in GBK/CP936, try to decode
          if (process.platform === "win32") {
            try {
              // Try decoding as GBK (code page 936) for Chinese Windows
              const { TextDecoder } = require("node:util");
              const decoder = new TextDecoder("gbk");
              const decoded = decoder.decode(data);
              console.log(`[Main] Application stderr: ${decoded}`);
            } catch {
              // Fallback to hex dump if decoding fails
              console.log(`[Main] Application stderr (hex): ${data.toString("hex")}`);
            }
          } else {
            console.error(`[Main] Application stderr:`, data.toString());
          }
        });
        
        child.on("exit", (code, signal) => {
          // On Windows, many apps (like Notepad++) pass the file to an existing instance
          // and immediately exit with code 1, this is normal behavior
          if (code !== 0 && code !== null) {
            if (process.platform === "win32") {
              console.log(`[Main] Application exited with code: ${code}, signal: ${signal} (this may be normal for single-instance apps)`);
            } else {
              console.warn(`[Main] Application exited with code: ${code}, signal: ${signal}`);
            }
          } else {
            console.log(`[Main] Application started successfully`);
          }
        });
        
        child.unref();
        return true;
      } catch (err) {
        console.error(`[Main] Error opening file with application:`, err);
        throw err;
      }
    });

    // Open a file with the system default application
    ipcMain.handle("netcatty:openWithSystemDefault", async (_event, { filePath }) => {
      const { shell } = require("electron");

      try {
        const error = await shell.openPath(filePath);
        if (error) {
          return { success: false, error };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  
    // Show save file dialog and return selected path
    ipcMain.handle("netcatty:showSaveDialog", async (_event, { defaultPath, filters }) => {
      const { dialog } = electronModule;
  
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: filters || [{ name: "All Files", extensions: ["*"] }],
      });
  
      if (result.canceled || !result.filePath) {
        return null;
      }
  
      return result.filePath;
    });
  
    // Select a file and return the selected path
    ipcMain.handle("netcatty:selectFile", async (_event, { title, defaultPath, filters }) => {
      const { dialog } = electronModule;
  
      const result = await dialog.showOpenDialog({
        title: title || "Select File",
        defaultPath: defaultPath || os.homedir(),
        filters: filters || [{ name: "All Files", extensions: ["*"] }],
        properties: ["openFile", "showHiddenFiles"],
      });
  
      if (result.canceled || !result.filePaths.length) {
        return null;
      }
  
      return result.filePaths[0];
    });
  
    // Select a directory and return the selected path
    ipcMain.handle("netcatty:selectDirectory", async (_event, { title, defaultPath }) => {
      const { dialog } = electronModule;
  
      const result = await dialog.showOpenDialog({
        title: title || "Select Directory",
        defaultPath,
        properties: ["openDirectory", "createDirectory"],
      });
  
      if (result.canceled || !result.filePaths.length) {
        return null;
      }
  
      return result.filePaths[0];
    });
  
    // Download SFTP file to temp and return local path
    ipcMain.handle("netcatty:sftp:downloadToTemp", async (_event, { sftpId, remotePath, fileName, encoding }) => {
      console.log(`[Main] Downloading SFTP file to temp:`);
      console.log(`[Main]   SFTP ID: ${sftpId}`);
      console.log(`[Main]   Remote path: ${remotePath}`);
      console.log(`[Main]   File name: ${fileName}`);
      
      const client = require("./bridges/sftpBridge.cjs");
      // Use tempDirBridge for dedicated Netcatty temp directory
      const localPath = await getTempDirBridge().getTempFilePath(fileName);
      
      console.log(`[Main]   Local temp path: ${localPath}`);
      
      // Get the sftp client and download file
      const sftpClients = client.getSftpClients ? client.getSftpClients() : null;
      if (!sftpClients) {
        console.log(`[Main]   Using fallback readSftp method`);
        // Fallback: use readSftp and write to temp file
        const content = await client.readSftp(null, { sftpId, path: remotePath, encoding });
        if (typeof content === "string") {
          await fs.promises.writeFile(localPath, content, "utf-8");
        } else {
          await fs.promises.writeFile(localPath, content);
        }
        console.log(`[Main]   File downloaded successfully (fallback)`);
        return localPath;
      }
      
      const sftpClient = sftpClients.get(sftpId);
      if (!sftpClient) {
        console.error(`[Main]   SFTP session not found: ${sftpId}`);
        throw new Error("SFTP session not found");
      }
      
      const encodedPath = client.encodePathForSession
        ? client.encodePathForSession(sftpId, remotePath, encoding)
        : remotePath;
      await sftpClient.fastGet(encodedPath, localPath);
      console.log(`[Main]   File downloaded successfully`);
      return localPath;
    });
  
    // Download SFTP file to temp with progress reporting via transfer events.
    // Progress/complete/cancelled events are delivered via the netcatty:transfer:*
    // channels (handled by transferBridge.startTransfer), so the IPC return value
    // only carries the resolved temp path. Cancellation is NOT an error here —
    // the UI already transitions the task to "cancelled" via the dedicated event.
    ipcMain.handle("netcatty:sftp:downloadToTempWithProgress", async (event, { sftpId, remotePath, fileName, encoding, transferId }) => {
      const localPath = await getTempDirBridge().getTempFilePath(fileName);
      const cleanupPartialDownload = async () => {
        try {
          await fs.promises.rm(localPath, { force: true });
        } catch (err) {
          console.warn(`[Main] Failed to clean temp download after interruption: ${localPath}`, err);
        }
      };
  
      try {
        const payload = {
          transferId,
          sourcePath: remotePath,
          targetPath: localPath,
          sourceType: "sftp",
          targetType: "local",
          sourceSftpId: sftpId,
          sourceEncoding: encoding,
          totalBytes: 0,
        };
  
        const result = await transferBridge.startTransfer(event, payload);
  
        if (result.error) {
          await cleanupPartialDownload();
          if (result.error === "Transfer cancelled") {
            return { localPath, cancelled: true };
          }
          throw new Error(result.error);
        }
        return { localPath, cancelled: false };
      } catch (err) {
        await cleanupPartialDownload();
        throw err;
      }
    });
  
    // Delete a temp file (for cleanup when editors close)
    ipcMain.handle("netcatty:deleteTempFile", async (_event, { filePath }) => {
      try {
        // Only allow deleting files in Netcatty temp directory for security
        const netcattyTempDir = path.resolve(getTempDirBridge().getTempDir());
        const resolvedPath = path.resolve(String(filePath || ""));
        if (!isPathInside(netcattyTempDir, resolvedPath)) {
          console.warn(`[Main] Refused to delete file outside Netcatty temp dir: ${filePath}`);
          return { success: false };
        }
        
        await fs.promises.unlink(resolvedPath);
        console.log(`[Main] Temp file deleted: ${filePath}`);
        return { success: true };
      } catch (err) {
        // Silently handle failures (file may be in use or already deleted)
        console.log(`[Main] Could not delete temp file: ${filePath} (${err.message})`);
        return { success: false };
      }
    });
  
    console.log('[Main] All bridges registered successfully');
  };

  return registerBridges;
}

module.exports = { createBridgeRegistrar };
