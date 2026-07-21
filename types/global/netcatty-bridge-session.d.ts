
declare global {
  interface NetcattyTerminalInterruptTrace {
    debug?: boolean;
    traceId?: string;
    source?: string;
    sessionId?: string;
    rendererKeyAt?: number;
    rendererSendAt?: number;
    rendererStatus?: string;
    rendererHasSelection?: boolean;
    rendererPriority?: {
      sessionId: string | null;
      backlogBytes: number;
      writeQueueDepth: number;
      deferredAckBytes: number;
      ackAfterInputBytes: number;
      scheduledBackendResume: boolean;
      skippedReason?: string;
    };
  }

  interface NetcattyTerminalOutputPerfMeta {
    id: string;
    emittedAt: number;
    sessionId?: string;
    chars: number;
    lineFeeds: number;
  }

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
      sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
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
      authMethod?: import("../../domain/models").HostAuthMethod;
      requiresMfa?: boolean;
      identityFilePaths?: string[];
      useSshAgent?: boolean;
      agentPublicKeys?: string[];
      identityAgent?: string;
      identitiesOnly?: boolean;
      addKeysToAgent?: string;
      useKeychain?: boolean;
      port?: number;
      moshServerPath?: string;
      moshClientPath?: string;
      agentForwarding?: boolean;
      sudoAutofillPassword?: string;
      // Algorithm settings, forwarded so the host-info stats companion SSH
      // connection (issue #1198) negotiates the same KEX / cipher / host-key
      // set the interactive session would.
      legacyAlgorithms?: boolean;
      skipEcdsaHostKey?: boolean;
      algorithmOverrides?: import("../../domain/models").HostAlgorithmOverrides;
      // Known hosts, used to verify the host key before the stats companion
      // connection (issue #1198) sends a saved password.
      knownHosts?: import("../../domain/models").KnownHost[];
      verifyHostKeys?: boolean;
      cols?: number;
      rows?: number;
      charset?: string;
      env?: Record<string, string>;
      sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    }): Promise<string>;
    startEtSession?(options: {
      sessionId?: string;
      hostname: string;
      hostId?: string;
      username?: string;
      password?: string;
      privateKey?: string;
      certificate?: string;
      keyId?: string;
      passphrase?: string;
      authMethod?: import("../../domain/models").HostAuthMethod;
      requiresMfa?: boolean;
      identityFilePaths?: string[];
      useSshAgent?: boolean;
      agentPublicKeys?: string[];
      identityAgent?: string;
      identitiesOnly?: boolean;
      addKeysToAgent?: string;
      useKeychain?: boolean;
      port?: number;
      etPort?: number;
      legacyAlgorithms?: boolean;
      skipEcdsaHostKey?: boolean;
      algorithmOverrides?: import("../../domain/models").HostAlgorithmOverrides;
      knownHosts?: import("../../domain/models").KnownHost[];
      verifyHostKeys?: boolean;
      jumpHosts?: NetcattyJumpHost[];
      agentForwarding?: boolean;
      sudoAutofillPassword?: string;
      cols?: number;
      rows?: number;
      charset?: string;
      env?: Record<string, string>;
      sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    }): Promise<string>;
    startLocalSession?(options: { sessionId?: string; cols?: number; rows?: number; shell?: string; shellArgs?: string[]; cwd?: string; env?: Record<string, string>; sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean } }): Promise<string>;
    startSerialSession?(options: {
      sessionId?: string;
      path: string;
      baudRate?: number;
      dataBits?: 5 | 6 | 7 | 8;
      stopBits?: 1 | 1.5 | 2;
      parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
      flowControl?: 'none' | 'xon/xoff' | 'rts/cts';
      charset?: string;
      sessionLog?: { enabled: boolean; directory: string; format: string; timestampsEnabled?: boolean };
    }): Promise<string>;
    listSerialPorts?(): Promise<Array<{
      path: string;
      manufacturer: string;
      serialNumber: string;
      vendorId: string;
      productId: string;
      pnpId: string;
    }>>;
    sendSerialYmodem?(sessionId: string, filePath: string): Promise<{
      success: boolean;
      fileName?: string;
      totalBytes?: number;
      writtenBytes?: number;
      error?: string;
      code?: string;
    }>;
    receiveSerialYmodem?(sessionId: string, destinationDir: string): Promise<{
      success: boolean;
      files?: Array<{
        fileName: string;
        filePath: string;
        totalBytes: number;
        writtenBytes: number;
      }>;
      fileCount?: number;
      fileName?: string;
      filePath?: string;
      totalBytes?: number;
      writtenBytes?: number;
      error?: string;
      code?: string;
    }>;
    getDefaultShell?(): Promise<string>;
    discoverShells?(): Promise<DiscoveredShell[]>;
    validatePath?(path: string, type?: 'file' | 'directory' | 'any'): Promise<{ exists: boolean; isFile: boolean; isDirectory: boolean; isExecutable: boolean }>;
    generateKeyPair?(options: {
      type: 'RSA' | 'ECDSA' | 'ED25519';
      bits?: number;
      comment?: string;
    }): Promise<{ success: boolean; privateKey?: string; publicKey?: string; error?: string }>;
    checkSshAgent?(options?: {
      identityAgent?: string;
      hostname?: string;
      port?: number;
      username?: string;
    }): Promise<{ running: boolean; startupType: string | null; error: string | null }>;
    getDefaultKeys?(): Promise<Array<{ name: string; path: string }>>;
    execCommand(options: {
      hostname: string;
      hostId?: string;
      username: string;
      port?: number;
      authMethod?: import("../../domain/models").HostAuthMethod;
      requiresMfa?: boolean;
      password?: string;
      privateKey?: string;
      certificate?: string;
      publicKey?: string;
      keyId?: string;
      keySource?: 'generated' | 'imported' | 'reference';
      identityFilePaths?: string[];
      useSshAgent?: boolean;
      agentPublicKeys?: string[];
      identityAgent?: string;
      identitiesOnly?: boolean;
      addKeysToAgent?: string;
      useKeychain?: boolean;
      passphrase?: string;
      command: string;
      timeout?: number;
      sshTcpConnectTimeoutMs?: number;
      sshAuthReadyTimeoutMs?: number;
      enableKeyboardInteractive?: boolean;
      sessionId?: string;
      legacyAlgorithms?: boolean;
      skipEcdsaHostKey?: boolean;
      algorithmOverrides?: import("../../domain/models").HostAlgorithmOverrides;
    }): Promise<{ stdout: string; stderr: string; code: number | null }>;
    /** Get current working directory from an active SSH session */
    getSessionPwd?(
      sessionId: string,
      options?: { allowHomeFallback?: boolean },
    ): Promise<{ success: boolean; cwd?: string; error?: string }>;
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
    /** Read the remote host's shell history file via an exec channel. */
    readRemoteHistory?(sessionId: string, limit?: number): Promise<{
      success: boolean;
      pending?: boolean;
      error?: string;
      shell?: string;
      bash?: string;
      zsh?: string;
      fish?: string;
    }>;
    /** Get server stats (CPU, Memory, Disk, Network) from an active SSH session */
    getServerStats?(sessionId: string): Promise<{
      success: boolean;
      // Transient "not ready yet" (e.g. a Mosh session whose SSH handshake is
      // still in progress, #1198). Callers should keep polling and NOT count
      // this toward any consecutive-failure give-up.
      pending?: boolean;
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
        latencyMs: number | null;     // TCP connection establishment latency to the SSH endpoint
        netInterfaces: Array<{        // Per-interface network stats
          name: string;               // Interface name (e.g., eth0, ens33)
          rxBytes: number;            // Total received bytes
          txBytes: number;            // Total transmitted bytes
          rxSpeed: number;            // Receive speed (bytes/sec)
          txSpeed: number;            // Transmit speed (bytes/sec)
        }>;
        hostname?: string;             // Hostname reported by the server
        osName?: string;               // Friendly OS name when available
        kernelRelease?: string;        // Kernel release from uname
        uptimeSeconds?: number | null; // Server uptime in seconds
        loadAverage?: number[];        // 1/5/15-minute load average
      };
    }>;
    setSessionEncoding?(sessionId: string, encoding: string): Promise<{ ok: boolean; encoding: string }>;
    writeToSession(
      sessionId: string,
      data: string,
      options?: {
        automated?: boolean;
        lineDelayMs?: number;
        logRewrite?: { sentCommand: string; displayCommand: string };
      },
    ): void;
    interruptSession?(sessionId: string, trace?: NetcattyTerminalInterruptTrace): void;
    resizeSession(sessionId: string, cols: number, rows: number): void;
    setSessionFlowPaused(sessionId: string, paused: boolean): void;
    setSessionFlowPausedAndWait?(sessionId: string, paused: boolean): Promise<{ success: boolean; error?: string }>;
    onTerminalOutputDrainRequest?(
      sessionId: string,
      cb: (payload: { sessionId: string; requestId: string }) => void | Promise<void>,
    ): () => void;
    respondTerminalOutputDrain?(requestId: string): void;
    notifyTerminalSessionDisplayReady?(sessionId: string): void;
    ackSessionFlow(sessionId: string, bytes: number): void;
    closeSession(sessionId: string): void | Promise<void>;
    /** Move a live session's output port to this renderer (same PTY). */
    rebindTerminalSessionOutput?(sessionId: string, authorization: string): Promise<{
      success: boolean;
      previousWebContentsId?: number | null;
      webContentsId?: number;
      error?: string;
    }>;
    /** Restore output after an attach popup closes. */
    restoreTerminalSessionOutput?(
      sessionId: string,
      webContentsId?: number | null,
      authorization?: string,
    ): Promise<{ success: boolean; restored?: boolean; webContentsId?: number; error?: string }>;
    /** Ask the home renderer to serialize current terminal scrollback. */
    requestTerminalSessionSnapshot?(sessionId: string, authorization: string): Promise<{
      success: boolean;
      snapshot?: string;
      error?: string;
    }>;
    /** Home renderer: listen for snapshot requests. */
    onTerminalSessionSnapshotRequest?(
      cb: (payload: { sessionId: string; requestId: string }) => void,
    ): () => void;
    /** Home renderer: reply with serialized scrollback. */
    respondTerminalSessionSnapshot?(requestId: string, snapshot: string): void;
    /** Observe popup: push current state back to the home renderer before restore. */
    applyTerminalSessionSnapshot?(
      sessionId: string,
      snapshot: string,
      context: {
        contextSnapshot: string;
        contextViewportSnapshot: string;
        contextScrollbackSnapshot: string;
        alternateScreen: boolean;
      },
      authorization: string,
    ): Promise<{
      success: boolean;
      error?: string;
    }>;
    markAttachPopupClosePrepared?(sessionId: string, authorization: string): Promise<{ success: boolean; error?: string }>;
    onTerminalPopupPrepareClose?(cb: (payload: { sessionId: string; authorization: string }) => void): () => void;
    /** Home renderer: apply a pushed snapshot from an observe popup. */
    onTerminalSessionApplySnapshot?(
      cb: (payload: {
        sessionId: string;
        snapshot: string;
        contextSnapshot: string;
        contextViewportSnapshot: string;
        contextScrollbackSnapshot: string;
        alternateScreen: boolean;
        requestId: string;
      }) => boolean | Promise<boolean>,
    ): () => void;
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
    cancelZmodem?(sessionId: string, options?: { interrupt?: boolean }): void;
    startZmodemDragDropUpload?(
      sessionId: string,
      files: Array<{
        path?: string;
        name: string;
        remoteName: string;
        data?: ArrayBuffer;
      }>,
      uploadCommand?: string,
    ): Promise<{ success: boolean; error?: string }>;
    onZmodemOverwriteRequest?(
      sessionId: string,
      cb: (payload: { sessionId: string; requestId: string; filename: string }) => void
    ): () => void;
    respondZmodemOverwrite?(payload: {
      requestId: string;
      action: "overwrite" | "skip" | "cancel";
      applyToRest: boolean;
    }): void;
    onSessionData(
      sessionId: string,
      cb: (
        data: string,
        meta?: {
          droppedOutputMayAffectTerminalState?: boolean;
          droppedOutputAlternateScreenAction?: "enter" | "leave";
          /** True while Mosh is still on the ephemeral SSH handshake PTY. */
          moshHandshake?: boolean;
          terminalPerf?: NetcattyTerminalOutputPerfMeta;
        },
      ) => void,
      options?: { replayBacklog?: boolean },
    ): () => void;
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
    /** Fires after Mosh swaps from the SSH handshake PTY to mosh-client. */
    onMoshSessionReady?(
      sessionId: string,
      cb: (evt: { sessionId: string }) => void
    ): () => void;
    onTelnetEchoMode?(
      sessionId: string,
      cb: (evt: { sessionId: string; remoteEcho: boolean; localEcho: boolean }) => void
    ): () => void;
    getTelnetEchoMode?(sessionId: string): Promise<{
      success: boolean;
      sessionId?: string;
      remoteEcho?: boolean;
      localEcho?: boolean;
      error?: string;
    }>;
    onAuthFailed?(
      sessionId: string,
      cb: (evt: { sessionId: string; error: string; hostname: string }) => void
    ): () => void;

    // Keyboard-interactive authentication (2FA/MFA)
    onKeyboardInteractive?(
      cb: (request: {
        requestId: string;
        sessionId: string;
        hostId?: string;
        name: string;
        instructions: string;
        prompts: Array<{ prompt: string; echo: boolean }>;
        hostname: string;
        savedPassword?: string | null;
        /** When false, UI must not offer saving the response as the host password. */
        allowSavePassword?: boolean;
        scope?: "terminal" | "external";
      }) => void
    ): () => void;
    onKeyboardInteractiveCancelled?(
      cb: (event: {
        requestId: string;
        sessionId?: string;
        reason?: string;
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
