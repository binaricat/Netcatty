
declare global {
  interface NetcattyBridge {
    getWindowsPtyInfo?(): NetcattyWindowsPtyInfo | null;
    startSSHSession(options: NetcattySSHOptions): Promise<string>;
    startTelnetSession?(options: {
      sessionId?: string;
      hostname: string;
      port?: number;
      username?: string;
      password?: string;
      cols?: number;
      rows?: number;
      charset?: string;
      env?: Record<string, string>;
      sessionLog?: { enabled: boolean; directory: string; format: string };
    }): Promise<string>;
    startMoshSession?(options: {
      sessionId?: string;
      hostname: string;
      username?: string;
      password?: string;
      privateKey?: string;
      certificate?: string;
      keyId?: string;
      passphrase?: string;
      identityFilePaths?: string[];
      port?: number;
      moshServerPath?: string;
      moshClientPath?: string;
      agentForwarding?: boolean;
      cols?: number;
      rows?: number;
      charset?: string;
      env?: Record<string, string>;
      sessionLog?: { enabled: boolean; directory: string; format: string };
    }): Promise<string>;
    startLocalSession?(options: { sessionId?: string; cols?: number; rows?: number; shell?: string; shellArgs?: string[]; cwd?: string; env?: Record<string, string>; sessionLog?: { enabled: boolean; directory: string; format: string } }): Promise<string>;
    startSerialSession?(options: {
      sessionId?: string;
      path: string;
      baudRate?: number;
      dataBits?: 5 | 6 | 7 | 8;
      stopBits?: 1 | 1.5 | 2;
      parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
      flowControl?: 'none' | 'xon/xoff' | 'rts/cts';
      charset?: string;
      sessionLog?: { enabled: boolean; directory: string; format: string };
    }): Promise<string>;
    listSerialPorts?(): Promise<Array<{
      path: string;
      manufacturer: string;
      serialNumber: string;
      vendorId: string;
      productId: string;
      pnpId: string;
    }>>;
    getDefaultShell?(): Promise<string>;
    discoverShells?(): Promise<DiscoveredShell[]>;
    validatePath?(path: string, type?: 'file' | 'directory' | 'any'): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean; isExecutable: boolean }>;
    generateKeyPair?(options: {
      type: 'RSA' | 'ECDSA' | 'ED25519';
      bits?: number;
      comment?: string;
    }): Promise<{ success: boolean; privateKey?: string; publicKey?: string; error?: string }>;
    checkSshAgent?(): Promise<{ running: boolean; startupType: string | null; error: string | null }>;
    getDefaultKeys?(): Promise<Array<{ name: string; path: string }>>;
    execCommand(options: {
      hostname: string;
      username: string;
      port?: number;
      password?: string;
      privateKey?: string;
      certificate?: string;
      publicKey?: string;
      keyId?: string;
      keySource?: 'generated' | 'imported' | 'reference';
      identityFilePaths?: string[];
      passphrase?: string;
      command: string;
      timeout?: number;
      enableKeyboardInteractive?: boolean;
      sessionId?: string;
    }): Promise<{ stdout: string; stderr: string; code: number | null }>;
    /** Get current working directory from an active SSH session */
    getSessionPwd?(sessionId: string): Promise<{ success: boolean; cwd?: string; error?: string }>;
    /**
     * Get metadata about an already-connected SSH session — currently the
     * SSH server identification string (the `software` part of the
     * SSH-2.0 banner). Used to classify network-device vendors from the
     * banner without opening any additional exec channel.
     */
    getSessionRemoteInfo?(sessionId: string): Promise<{
      success: boolean;
      remoteSshVersion?: string;
      error?: string;
    }>;
    /**
     * Probe the remote distro by running
     * `cat /etc/os-release 2>/dev/null || uname -a` on the existing SSH
     * connection's exec channel (not a brand-new connection). Used as a
     * fallback when banner classification could not identify a network
     * device vendor and we still want a distro-specific icon.
     */
    getSessionDistroInfo?(sessionId: string): Promise<{
      success: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
    }>;
    /** Get server stats (CPU, Memory, Disk, Network) from an active SSH session */
    getServerStats?(sessionId: string): Promise<{
      success: boolean;
      error?: string;
      stats?: {
        cpu: number | null;           // CPU usage percentage (0-100)
        cpuCores: number | null;      // Number of CPU cores
        cpuPerCore: number[];         // Per-core CPU usage array
        memTotal: number | null;      // Total memory in MB
        memUsed: number | null;       // Used memory in MB (excluding buffers/cache)
        memFree: number | null;       // Free memory in MB
        memBuffers: number | null;    // Buffers in MB
        memCached: number | null;     // Cached in MB
        swapTotal: number | null;     // Total swap in MB
        swapUsed: number | null;      // Used swap in MB
        topProcesses: Array<{         // Top 10 processes by memory
          pid: string;
          memPercent: number;
          command: string;
        }>;
        diskPercent: number | null;   // Disk usage percentage for root partition
        diskUsed: number | null;      // Disk used in GB
        diskTotal: number | null;     // Total disk in GB
        disks: Array<{                // All mounted disks
          mountPoint: string;
          used: number;               // Used in GB
          total: number;              // Total in GB
          percent: number;            // Usage percentage
        }>;
        netRxSpeed: number;           // Total network receive speed (bytes/sec)
        netTxSpeed: number;           // Total network transmit speed (bytes/sec)
        netInterfaces: Array<{        // Per-interface network stats
          name: string;               // Interface name (e.g., eth0, ens33)
          rxBytes: number;            // Total received bytes
          txBytes: number;            // Total transmitted bytes
          rxSpeed: number;            // Receive speed (bytes/sec)
          txSpeed: number;            // Transmit speed (bytes/sec)
        }>;
      };
    }>;
    setSessionEncoding?(sessionId: string, encoding: string): Promise<{ ok: boolean; encoding: string }>;
    writeToSession(sessionId: string, data: string, options?: { automated?: boolean }): void;
    resizeSession(sessionId: string, cols: number, rows: number): void;
    setSessionFlowPaused(sessionId: string, paused: boolean): void;
    closeSession(sessionId: string): void;
    // ZMODEM file transfer
    onZmodemEvent?(
      sessionId: string,
      cb: (event: {
        type: 'detect' | 'progress' | 'complete' | 'error';
        sessionId: string;
        transferType?: 'upload' | 'download';
        filename?: string;
        transferred?: number;
        total?: number;
        fileIndex?: number;
        fileCount?: number;
        finalizing?: boolean;
        error?: string;
      }) => void
    ): () => void;
    cancelZmodem?(sessionId: string): void;
    onZmodemOverwriteRequest?(
      sessionId: string,
      cb: (payload: { sessionId: string; requestId: string; filename: string }) => void
    ): () => void;
    respondZmodemOverwrite?(payload: {
      requestId: string;
      action: "overwrite" | "skip" | "cancel";
      applyToRest: boolean;
    }): void;
    onSessionData(sessionId: string, cb: (data: string) => void): () => void;
    onSessionExit(
      sessionId: string,
      cb: (evt: { exitCode?: number; signal?: number; error?: string; reason?: "exited" | "error" | "timeout" | "closed" }) => void
    ): () => void;
    onTelnetAutoLoginComplete?(
      sessionId: string,
      cb: (evt: { sessionId: string }) => void
    ): () => void;
    onTelnetAutoLoginCancelled?(
      sessionId: string,
      cb: (evt: { sessionId: string }) => void
    ): () => void;
    onAuthFailed?(
      sessionId: string,
      cb: (evt: { sessionId: string; error: string; hostname: string }) => void
    ): () => void;

    // Keyboard-interactive authentication (2FA/MFA)
    onKeyboardInteractive?(
      cb: (request: {
        requestId: string;
        sessionId: string;
        name: string;
        instructions: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
        hostname: string;
        savedPassword?: string | null;
      }) => void
    ): () => void;
    respondKeyboardInteractive?(
      requestId: string,
      responses: string[],
      cancelled?: boolean
    ): Promise<{ success: boolean; error?: string }>;

    onHostKeyVerification?(
      cb: (request: {
        requestId: string;
        sessionId: string;
        hostname: string;
        port: number;
        status: 'unknown' | 'changed';
        keyType: string;
        fingerprint: string;
        publicKey?: string;
        knownHostId?: string;
        knownFingerprint?: string;
      }) => void
    ): () => void;
    respondHostKeyVerification?(
      requestId: string,
      accept: boolean,
      addToKnownHosts?: boolean
    ): Promise<{ success: boolean; error?: string }>;

    // Passphrase request for encrypted SSH keys
    onPassphraseRequest?(
      cb: (request: {
        requestId: string;
        keyPath: string;
        keyName: string;
        hostname?: string;
        passphraseInvalid?: boolean;
      }) => void
    ): () => void;
    respondPassphrase?(
      requestId: string,
      passphrase: string,
      cancelled?: boolean
    ): Promise<{ success: boolean; error?: string }>;
    respondPassphraseSkip?(
      requestId: string
    ): Promise<{ success: boolean; error?: string }>;
    onPassphraseTimeout?(
      cb: (event: { requestId: string }) => void
    ): () => void;
    onPassphraseCancelled?(
      cb: (event: { requestId: string; reason?: string }) => void
    ): () => void;
    onPassphraseAuthFailed?(
      cb: (event: { keyPaths: string[]; keyIds?: string[] }) => void
    ): () => void;
  }
}

export {};
