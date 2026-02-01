 /**
  * SSH Authentication Helper - Shared authentication logic for SSH connections
  * Used by sshBridge, sftpBridge, and portForwardingBridge
  */
 
 const fs = require("node:fs");
 const path = require("node:path");
 const os = require("node:os");
 const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
 
 // Default SSH key names in priority order
 const DEFAULT_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];
 
 /**
  * Check if an SSH private key is encrypted (requires passphrase)
  * @param {string} keyContent - The content of the private key file
  * @returns {boolean} - True if the key is encrypted
  */
 function isKeyEncrypted(keyContent) {
   if (!keyContent || typeof keyContent !== "string") return false;
  
  // Check for PKCS#8 encrypted format (-----BEGIN ENCRYPTED PRIVATE KEY-----)
  if (keyContent.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----")) {
    return true;
  }
  
  // Check for legacy PEM format encryption (e.g., RSA PRIVATE KEY with encryption)
  if (keyContent.includes("Proc-Type:") && keyContent.includes("ENCRYPTED")) {
    return true;
  }
  
  // Check for DEK-Info header (legacy PEM encryption indicator)
   if (keyContent.includes("DEK-Info:")) return true;
  
  // Check for OpenSSH format keys
  if (keyContent.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    try {
      // Extract the base64 content between the markers
      const base64Match = keyContent.match(
        /-----BEGIN OPENSSH PRIVATE KEY-----\s*([\s\S]*?)\s*-----END OPENSSH PRIVATE KEY-----/
      );
      if (base64Match) {
        const base64Content = base64Match[1].replace(/\s/g, "");
        const keyBuffer = Buffer.from(base64Content, "base64");
        
        // OpenSSH key format: "openssh-key-v1\0" followed by cipher name
        // If ciphername is "none", the key is not encrypted
        const authMagic = "openssh-key-v1\0";
        if (keyBuffer.toString("ascii", 0, authMagic.length) === authMagic) {
          // After magic, read ciphername (length-prefixed string)
          let offset = authMagic.length;
          const cipherNameLen = keyBuffer.readUInt32BE(offset);
          offset += 4;
          const cipherName = keyBuffer.toString("ascii", offset, offset + cipherNameLen);
          return cipherName !== "none";
        }
      }
    } catch {
      // If parsing fails, assume it might be encrypted to be safe
      return true;
    }
  }
  
   return false;
 }
 
 /**
  * Find default SSH private key from user's ~/.ssh directory
  * Skips encrypted keys that require a passphrase
  * @returns {Promise<{ privateKey: string, keyPath: string, keyName: string } | null>}
  */
 async function findDefaultPrivateKey() {
   const sshDir = path.join(os.homedir(), ".ssh");
   for (const name of DEFAULT_KEY_NAMES) {
     const keyPath = path.join(sshDir, name);
     try {
       await fs.promises.access(keyPath, fs.constants.F_OK);
       const privateKey = await fs.promises.readFile(keyPath, "utf8");
       if (isKeyEncrypted(privateKey)) {
         continue;
       }
       return { privateKey, keyPath, keyName: name };
     } catch {
       continue;
     }
   }
   return null;
 }
 
 /**
  * Find ALL default SSH private keys from user's ~/.ssh directory
 * @param {Object} [options]
 * @param {boolean} [options.includeEncrypted=false] - If true, include encrypted keys with isEncrypted flag
 * @returns {Promise<Array<{ privateKey: string, keyPath: string, keyName: string, isEncrypted?: boolean }>>}
  */
async function findAllDefaultPrivateKeys(options = {}) {
  const { includeEncrypted = false } = options;
   const sshDir = path.join(os.homedir(), ".ssh");

   const promises = DEFAULT_KEY_NAMES.map(async (name) => {
     const keyPath = path.join(sshDir, name);
     try {
       await fs.promises.access(keyPath, fs.constants.F_OK);
       const privateKey = await fs.promises.readFile(keyPath, "utf8");
       const encrypted = isKeyEncrypted(privateKey);
       if (encrypted && !includeEncrypted) {
          return null;
       }
       return {
         privateKey,
         keyPath,
         keyName: name,
         ...(includeEncrypted ? { isEncrypted: encrypted } : {})
       };
     } catch {
       return null;
     }
   });

   const results = await Promise.all(promises);
   return results.filter(Boolean);
 }
 
 /**
  * Get ssh-agent socket path based on platform
  * @returns {string|null}
  */
 function getSshAgentSocket() {
   if (process.platform === "win32") {
     return "\\\\.\\pipe\\openssh-ssh-agent";
   }
   return process.env.SSH_AUTH_SOCK || null;
 }
 
 /**
  * Build authentication handler with default key fallback support
  * @param {Object} options
  * @param {string} [options.privateKey] - Explicitly configured private key
  * @param {string} [options.password] - Password for authentication
 * @param {string} [options.passphrase] - Passphrase for encrypted private key
  * @param {Object} [options.agent] - SSH agent (NetcattyAgent or socket path)
  * @param {string} options.username - SSH username
  * @param {string} [options.logPrefix] - Log prefix for debugging
  * @returns {{ authHandler: Function|Array, privateKey: string|null, agent: string|Object|null, usedDefaultKeys: boolean }}
 * @param {Array} [options.unlockedEncryptedKeys] - Array of unlocked encrypted keys with passphrases
  */
 function buildAuthHandler(options) {
  const { privateKey, password, passphrase, agent, username, logPrefix = "[SSH]", unlockedEncryptedKeys = [], defaultKeys = [] } = options;
   
  // Determine what type of explicit auth the user configured
  const hasExplicitKey = !!privateKey;
  const hasExplicitPassword = !!password;
  const hasExplicitAgent = !!agent;
  const hasExplicitAuth = hasExplicitKey || hasExplicitPassword || hasExplicitAgent;
  
  // Determine if this is a password-only or key-only connection
  const isPasswordOnly = hasExplicitPassword && !hasExplicitKey && !hasExplicitAgent;
  const isKeyOnly = hasExplicitKey && !hasExplicitAgent;
  
   const sshAgentSocket = getSshAgentSocket();
   
  // Only use system ssh-agent BEFORE user's auth when:
  // - User explicitly configured agent, OR
  // - No explicit auth is configured (pure fallback mode)
  // When user configured key/password, system agent should only be used AFTER as fallback
  const useAgentFirst = hasExplicitAgent || !hasExplicitAuth;
  
  // Determine effective agent
  const effectiveAgent = agent || (useAgentFirst ? sshAgentSocket : null);
  
  // Determine effective privateKey (user-provided takes priority)
  const effectivePrivateKey = privateKey || (!hasExplicitAuth && defaultKeys.length > 0 ? defaultKeys[0].privateKey : null);
  
  // Determine fallback keys (keys to try after user's primary auth fails)
  // - If user provided a key: all default keys are fallbacks
  // - If no explicit auth: first default key is primary, rest are fallbacks  
  // - If password-only or agent-only: all default keys are fallbacks (tried after primary)
  const fallbackKeys = hasExplicitKey 
    ? defaultKeys 
    : !hasExplicitAuth 
      ? defaultKeys.slice(1) 
      : defaultKeys;
  
  // Check if we need dynamic handler (have fallback options)
  const hasFallbackOptions = fallbackKeys.length > 0 || 
    (!hasExplicitAgent && sshAgentSocket) || 
    (isPasswordOnly && defaultKeys.length > 0);
  
  // If only simple auth methods and no fallback keys needed, use array-based handler
  if (hasExplicitAuth && !hasFallbackOptions) {
    const authMethods = [];
    if (effectiveAgent) authMethods.push("agent");
    if (privateKey) authMethods.push("publickey");
    if (password) authMethods.push("password");
    authMethods.push("keyboard-interactive");
    
    return {
      authHandler: authMethods,
      privateKey: effectivePrivateKey,
      agent: effectiveAgent,
      usedDefaultKeys: false,
    };
   }
   
  // Build comprehensive authMethods array with all auth options
  // Order depends on what user explicitly configured:
  // - Password-only: password -> agent -> default keys -> keyboard-interactive
  // - Key-only: user key -> password -> agent -> default keys -> keyboard-interactive  
  // - Agent configured: agent -> user key -> password -> default keys -> keyboard-interactive
  // - No explicit auth: agent -> default keys -> keyboard-interactive
  const authMethods = [];
  
  if (isPasswordOnly) {
    // Password-only: password first, then fallbacks
    authMethods.push({ type: "password", id: "password" });
    
    // Add agent and default keys AFTER password as fallback
    if (sshAgentSocket) {
      authMethods.push({ type: "agent", id: "agent" });
    }
    for (const keyInfo of defaultKeys) {
      authMethods.push({ 
        type: "publickey", 
        key: keyInfo.privateKey, 
        id: `publickey-default-${keyInfo.keyName}` 
      });
    }
  } else if (isKeyOnly) {
    // Key-only: user key first, then password (if any), then agent/default keys as fallback
    
    // 1. User-provided key first
    authMethods.push({ 
      type: "publickey", 
      key: privateKey, 
      passphrase: passphrase,
      id: "publickey-user" 
    });
    
    // 2. Password (if configured alongside key)
    if (password) {
      authMethods.push({ type: "password", id: "password" });
    }
    
    // 3. System agent as fallback (AFTER user's key)
    if (sshAgentSocket) {
      authMethods.push({ type: "agent", id: "agent" });
    }
    
    // 4. Default keys as fallback
    for (const keyInfo of fallbackKeys) {
      authMethods.push({ 
        type: "publickey", 
        key: keyInfo.privateKey, 
        id: `publickey-default-${keyInfo.keyName}` 
      });
    }
  } else {
    // Agent configured or no explicit auth: agent -> user key -> password -> default keys
    
    // 1. Agent (user-provided or system)
    if (effectiveAgent) {
      authMethods.push({ type: "agent", id: "agent" });
    }
    
    // 2. User-provided key
    if (privateKey) {
      authMethods.push({ 
        type: "publickey", 
        key: privateKey, 
        passphrase: passphrase,
        id: "publickey-user" 
      });
    }
    
    // 3. Password (if configured)
    if (password) {
      authMethods.push({ type: "password", id: "password" });
    }
    
    // 4. Default keys as fallback
    for (const keyInfo of fallbackKeys) {
      authMethods.push({ 
        type: "publickey", 
        key: keyInfo.privateKey, 
        id: `publickey-default-${keyInfo.keyName}` 
      });
    }
    
    // 5. If no user key provided, add first default key at the beginning (after agent)
    if (!privateKey && defaultKeys.length > 0) {
      const insertIndex = effectiveAgent ? 1 : 0;
      authMethods.splice(insertIndex, 0, { 
        type: "publickey", 
        key: defaultKeys[0].privateKey, 
        id: `publickey-default-${defaultKeys[0].keyName}` 
      });
    }
  }
  
  // Add unlocked encrypted default keys (user provided passphrases for these)
  for (const keyInfo of unlockedEncryptedKeys) {
    authMethods.push({ 
      type: "publickey", 
      key: keyInfo.privateKey, 
      passphrase: keyInfo.passphrase,
      id: `publickey-encrypted-${keyInfo.keyName}` 
    });
  }
  
  // Keyboard-interactive as last resort
  authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
   
  console.log(`${logPrefix} Auth methods configured`, { 
      isPasswordOnly,
      hasUserKey: !!privateKey,
      hasPassword: !!password,
      hasAgent: !!effectiveAgent,
      methodCount: authMethods.length,
      methods: authMethods.map(m => m.id),
    });
  
   // Use dynamic authHandler to try all keys
   let authIndex = 0;
   const attemptedMethodIds = new Set();
   
   const authHandler = (methodsLeft, partialSuccess, callback) => {
     const availableMethods = methodsLeft || ["publickey", "password", "keyboard-interactive", "agent"];
     
     while (authIndex < authMethods.length) {
       const method = authMethods[authIndex];
       authIndex++;
       
       if (attemptedMethodIds.has(method.id)) continue;
       attemptedMethodIds.add(method.id);
       
      if (method.type === "agent" && (availableMethods.includes("publickey") || availableMethods.includes("agent"))) {
        console.log(`${logPrefix} Trying agent auth`);
        return callback("agent");
      } else if (method.type === "publickey" && availableMethods.includes("publickey")) {
         console.log(`${logPrefix} Trying publickey auth:`, method.id);
         const pubkeyAuth = {
           type: "publickey",
           username,
           key: method.key,
         };
         if (method.passphrase) {
           pubkeyAuth.passphrase = method.passphrase;
         }
         return callback(pubkeyAuth);
      } else if (method.type === "password" && availableMethods.includes("password")) {
        console.log(`${logPrefix} Trying password auth`);
        return callback({
          type: "password",
          username,
          password,
        });
       } else if (method.type === "keyboard-interactive" && availableMethods.includes("keyboard-interactive")) {
         return callback("keyboard-interactive");
       }
     }
     return callback(false);
   };
   
  // Determine the agent to return - if authMethods includes agent, we need to provide the socket
  // even if effectiveAgent is null (for fallback scenarios)
  const hasAgentInMethods = authMethods.some(m => m.type === "agent");
  const returnAgent = effectiveAgent || (hasAgentInMethods ? sshAgentSocket : null);
  
   return {
     authHandler,
    privateKey: effectivePrivateKey,
    agent: returnAgent,
     usedDefaultKeys: true,
   };
 }
 
 /**
  * Create a keyboard-interactive event handler
  * @param {Object} options
  * @param {Object} options.sender - Electron webContents sender
  * @param {string} options.sessionId - Session/connection ID
  * @param {string} options.hostname - Host being connected to
  * @param {string} [options.password] - Saved password for fill button
  * @param {string} [options.logPrefix] - Log prefix for debugging
  * @returns {Function} - Event handler for 'keyboard-interactive' event
  */
 function createKeyboardInteractiveHandler(options) {
   const { sender, sessionId, hostname, password, logPrefix = "[SSH]" } = options;
   
   return (name, instructions, instructionsLang, prompts, finish) => {
     console.log(`${logPrefix} ${hostname} keyboard-interactive auth requested`, {
       name,
       instructions,
       promptCount: prompts?.length || 0,
     });
     
     // If there are no prompts, just call finish with empty array
     if (!prompts || prompts.length === 0) {
       console.log(`${logPrefix} No prompts, finishing keyboard-interactive`);
       finish([]);
       return;
     }
     
     // Forward prompts to user via IPC
     const requestId = keyboardInteractiveHandler.generateRequestId('ssh');
     keyboardInteractiveHandler.storeRequest(requestId, (userResponses) => {
       console.log(`${logPrefix} Received user responses, finishing keyboard-interactive`);
       finish(userResponses);
     }, sender.id, sessionId);
     
     const promptsData = prompts.map((p) => ({
       prompt: p.prompt,
       echo: p.echo,
     }));
     
     console.log(`${logPrefix} Showing modal for ${promptsData.length} prompts`);
     
     safeSend(sender, "netcatty:keyboard-interactive", {
       requestId,
       sessionId,
       name: name || hostname,
       instructions: instructions || "",
       prompts: promptsData,
      hostname: hostname,
       savedPassword: password || null,
     });
   };
 }
 
 /**
  * Send message to renderer safely
  */
 function safeSend(sender, channel, payload) {
   try {
     if (!sender || sender.isDestroyed()) return;
     sender.send(channel, payload);
   } catch {
     // Ignore destroyed webContents during shutdown.
   }
 }
 
 /**
  * Apply auth configuration to connection options
  * Convenience function that combines buildAuthHandler results with connOpts
  * @param {Object} connOpts - SSH connection options to modify
  * @param {Object} authConfig - Auth configuration from buildAuthHandler
  */
 function applyAuthToConnOpts(connOpts, authConfig) {
   connOpts.authHandler = authConfig.authHandler;
   if (authConfig.privateKey) {
     connOpts.privateKey = authConfig.privateKey;
   }
   if (authConfig.agent) {
     connOpts.agent = authConfig.agent;
   }
 }
 
/**
 * Request passphrases for encrypted default keys
 * Shows a modal for each encrypted key and collects passphrases
 * @param {Object} sender - Electron webContents sender
 * @param {string} [hostname] - Optional hostname for context
 * @returns {Promise<{ keys: Array<{ privateKey: string, keyPath: string, keyName: string, passphrase: string }>, cancelled: boolean }>}
 */
async function requestPassphrasesForEncryptedKeys(sender, hostname) {
  const allKeys = await findAllDefaultPrivateKeys({ includeEncrypted: true });
  const encryptedKeys = allKeys.filter(k => k.isEncrypted);
  
  if (encryptedKeys.length === 0) {
    return { keys: [], cancelled: false };
  }
  
  console.log(`[SSHAuth] Found ${encryptedKeys.length} encrypted default key(s), requesting passphrases`);
  
  const unlockedKeys = [];
  let wasCancelled = false;
  
  for (const keyInfo of encryptedKeys) {
    const result = await passphraseHandler.requestPassphrase(
      sender,
      keyInfo.keyPath,
      keyInfo.keyName,
      hostname
    );
    
    // Handle different response types
    if (!result) {
      // Timeout or error - continue with next key
      console.log(`[SSHAuth] No response for ${keyInfo.keyName}, continuing...`);
      continue;
    }
    
    if (result.cancelled) {
      // User clicked Cancel - stop the entire flow
      console.log(`[SSHAuth] User cancelled passphrase flow at ${keyInfo.keyName}`);
      wasCancelled = true;
      break;
    }
    
    if (result.skipped) {
      // User clicked Skip - continue with next key
      console.log(`[SSHAuth] User skipped passphrase for ${keyInfo.keyName}`);
      continue;
    }
    
    if (result.passphrase) {
      // User provided passphrase
      unlockedKeys.push({
        privateKey: keyInfo.privateKey,
        keyPath: keyInfo.keyPath,
        keyName: keyInfo.keyName,
        passphrase: result.passphrase,
      });
    }
  }
  
  return { keys: unlockedKeys, cancelled: wasCancelled };
}

 module.exports = {
   DEFAULT_KEY_NAMES,
   isKeyEncrypted,
   findDefaultPrivateKey,
   findAllDefaultPrivateKeys,
   getSshAgentSocket,
   buildAuthHandler,
   createKeyboardInteractiveHandler,
   applyAuthToConnOpts,
   safeSend,
  requestPassphrasesForEncryptedKeys,
 };
