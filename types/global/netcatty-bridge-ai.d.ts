
declare global {
  interface NetcattyBridge {
    // AI / external agents
    aiSyncProviders?(providers: Array<{ id: string; providerId: string; apiKey?: string; baseURL?: string; enabled: boolean }>): Promise<{ ok: boolean }>;
    aiChatStream?(requestId: string, url: string, headers?: Record<string, string>, body?: string, providerId?: string): Promise<{ ok: boolean; statusCode?: number; statusText?: string; error?: string }>;
    aiChatCancel?(requestId: string): Promise<boolean>;
    aiFetch?(url: string, method?: string, headers?: Record<string, string>, body?: string, providerId?: string, skipHostCheck?: boolean, followRedirects?: boolean, skipTLSVerify?: boolean): Promise<{ ok: boolean; status?: number; data: string; error?: string }>;
    aiAllowlistAddHost?(baseURL: string): Promise<{ ok: boolean; error?: string }>;
    aiExec?(sessionId: string, command: string, chatSessionId?: string): Promise<{ ok: boolean; stdout?: string; stderr?: string; exitCode?: number | null; error?: string }>;
    aiCattyCancelExec?(chatSessionId: string): Promise<{ ok: boolean; error?: string }>;
    aiDiscoverAgents?(options?: { refreshShellEnv?: boolean; apiKeyPresent?: boolean }): Promise<Array<{
      command: string;
      name: string;
      icon: string;
      description: string;
      args: string[];
      path: string;
      binPath?: string;
      version: string;
      available: boolean;
      installed?: boolean;
      authenticated?: boolean;
      authSource?: string | null;
      sdkBackend?: string;
      /** @deprecated Legacy persisted field from the pre-SDK migration. */
      acpCommand?: string;
      acpArgs?: string[];
    }>>;
    aiPrewarmShellEnv?(): Promise<{ ok: boolean; error?: string }>;
    aiCodexGetIntegration?(options?: { refreshShellEnv?: boolean; validateChatGptAuth?: boolean; codexPath?: string }): Promise<{
      state: 'connected_chatgpt' | 'connected_api_key' | 'connected_custom_config' | 'not_logged_in' | 'unknown';
      isConnected: boolean;
      rawOutput: string;
      exitCode: number | null;
      customConfig?: {
        providerName: string;
        displayName: string;
        baseUrl: string | null;
        envKey: string | null;
        envKeyPresent: boolean;
        hasHardcodedApiKey: boolean;
        model: string | null;
        authHash: string | null;
      } | null;
    }>;
    aiCodexStartLogin?(options?: { codexPath?: string }): Promise<{
      ok: boolean;
      session?: {
        sessionId: string;
        state: 'running' | 'success' | 'error' | 'cancelled';
        url: string | null;
        output: string;
        error: string | null;
        exitCode: number | null;
        codexPath?: string | null;
      };
      error?: string;
    }>;
    aiCodexGetLoginSession?(sessionId: string): Promise<{
      ok: boolean;
      session?: {
        sessionId: string;
        state: 'running' | 'success' | 'error' | 'cancelled';
        url: string | null;
        output: string;
        error: string | null;
        exitCode: number | null;
        codexPath?: string | null;
      };
      error?: string;
    }>;
    aiCodexCancelLogin?(sessionId: string): Promise<{
      ok: boolean;
      found?: boolean;
      session?: {
        sessionId: string;
        state: 'running' | 'success' | 'error' | 'cancelled';
        url: string | null;
        output: string;
        error: string | null;
        exitCode: number | null;
        codexPath?: string | null;
      };
      error?: string;
    }>;
    aiCodexLogout?(options?: { codexPath?: string }): Promise<{
      ok: boolean;
      state?: 'connected_chatgpt' | 'connected_api_key' | 'connected_custom_config' | 'not_logged_in' | 'unknown';
      isConnected?: boolean;
      rawOutput?: string;
      logoutOutput?: string;
      error?: string;
    }>;
    aiMcpUpdateSessions?(sessions: Array<{
      sessionId: string;
      hostId?: string;
      hostname: string;
      label: string;
      os?: string;
      username?: string;
      protocol?: string;
      shellType?: string;
      deviceType?: string;
      connected: boolean;
      hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
      activePortForwards?: Array<{ ruleId: string; label?: string; type?: string; localPort?: number; status?: string }>;
    }>, chatSessionId?: string): Promise<{ ok: boolean }>;
    /** Merge sessions into a chat scope without dropping existing entries. */
    aiMcpMergeSessions?(sessions: Array<{
      sessionId: string;
      hostId?: string;
      hostname: string;
      label: string;
      os?: string;
      username?: string;
      protocol?: string;
      shellType?: string;
      deviceType?: string;
      connected: boolean;
      hostChain?: Array<{ hostId: string; label?: string; hostname?: string }>;
      activePortForwards?: Array<{ ruleId: string; label?: string; type?: string; localPort?: number; status?: string }>;
    }>, chatSessionId: string): Promise<{ ok: boolean; count?: number; error?: string }>;
    onVaultAgentRequest?(cb: (payload: { requestId: string; op: string; params: Record<string, unknown> }) => void): () => void;
    respondVaultAgent?(requestId: string, result: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
    aiMcpSetToolIntegrationMode?(mode: 'mcp' | 'skills'): Promise<{ ok: boolean; error?: string }>;
    aiUserSkillsGetStatus?(): Promise<{
      ok: boolean;
      directoryPath?: string;
      readyCount?: number;
      warningCount?: number;
      skills?: Array<{
        id: string;
        slug: string;
        directoryName: string;
        directoryPath: string;
        skillPath: string;
        name: string;
        description: string;
        status: 'ready' | 'warning';
        warnings: string[];
      }>;
      warnings?: string[];
      error?: string;
    }>;
    aiUserSkillsOpenFolder?(): Promise<{
      ok: boolean;
      directoryPath?: string;
      readyCount?: number;
      warningCount?: number;
      skills?: Array<{
        id: string;
        slug: string;
        directoryName: string;
        directoryPath: string;
        skillPath: string;
        name: string;
        description: string;
        status: 'ready' | 'warning';
        warnings: string[];
      }>;
      warnings?: string[];
      error?: string;
    }>;
    aiUserSkillsBuildContext?(prompt: string, selectedSkillSlugs?: string[]): Promise<{
      ok: boolean;
      context?: string;
      error?: string;
    }>;
    aiSdkAgentStream?(requestId: string, chatSessionId: string, sdkBackend: string, prompt: string, cwd?: string, providerId?: string, model?: string, existingSessionId?: string, historyMessages?: Array<{ role: 'user' | 'assistant'; content: string }>, images?: Array<{ base64Data: string; mediaType: string; filename?: string; filePath?: string }>, toolIntegrationMode?: 'mcp' | 'skills', defaultTargetSession?: { sessionId: string; hostname: string; label: string; os?: string; username?: string; protocol?: string; shellType?: string; deviceType?: string; connected: boolean; source: 'scope-target' | 'only-connected-in-scope' }, userSkillsContext?: string, agentEnv?: Record<string, string>, agentCommand?: string): Promise<{ ok: boolean; error?: string }>;
    aiSdkAgentListModels?(sdkBackend: string, cwd?: string, providerId?: string, chatSessionId?: string, agentEnv?: Record<string, string>, agentCommand?: string): Promise<{ ok: boolean; models?: Array<{ id: string; name: string; description?: string; thinkingLevels?: string[] }>; currentModelId?: string | null; error?: string }>;
    aiCattyCancelExec?(chatSessionId: string): Promise<unknown>;
    aiSetChatSessionCancelled?(chatSessionId: string, cancelled?: boolean): Promise<{ ok: boolean; error?: string }>;
    aiMcpSyncPermissionGrants?(grants: Array<Record<string, unknown>>): Promise<{ ok: boolean; count?: number; error?: string }>;
    externalMcpGetStatus?(): Promise<{
      ok: boolean;
      enabled?: boolean;
      state?: string;
      host?: string;
      port?: number | null;
      discoveryPath?: string | null;
      launcherPath?: string | null;
      chatSessionId?: string;
      exposedSessionCount?: number;
      mode?: 'temporary' | 'persistent';
      idleTimeoutMinutes?: number;
      lastActivityAt?: number | null;
      idleExpiresAt?: number | null;
      permissionMode?: string;
      hostRunning?: boolean;
      error?: string | null;
    }>;
    externalMcpSetEnabled?(enabled: boolean): Promise<Record<string, unknown>>;
    externalMcpSetConfig?(config: {
      mode?: 'temporary' | 'persistent';
      idleTimeoutMinutes?: number;
    }): Promise<Record<string, unknown>>;
    externalMcpCodexGetStatus?(): Promise<Record<string, unknown>>;
    externalMcpCodexAdd?(): Promise<Record<string, unknown>>;
    externalMcpClaudeGetStatus?(): Promise<Record<string, unknown>>;
    externalMcpClaudeAdd?(): Promise<Record<string, unknown>>;
    externalMcpGrokGetStatus?(): Promise<Record<string, unknown>>;
    externalMcpGrokAdd?(): Promise<Record<string, unknown>>;
    aiSdkAgentCancel?(requestId: string, chatSessionId?: string): Promise<{ ok: boolean; error?: string }>;
    aiSdkAgentCleanup?(chatSessionId: string): Promise<{ ok: boolean }>;
    onAiSdkAgentEvent?(requestId: string, cb: (event: Record<string, unknown>) => void): () => void;
    onAiSdkAgentDone?(requestId: string, cb: () => void): () => void;
    onAiSdkAgentError?(requestId: string, cb: (error: string) => void): () => void;
    onAiStreamData?(requestId: string, cb: (data: string) => void): () => void;
    onAiStreamEnd?(requestId: string, cb: () => void): () => void;
    onAiStreamError?(requestId: string, cb: (error: string) => void): () => void;
    onAiAgentStdout?(agentId: string, cb: (data: string) => void): () => void;
    onAiAgentStderr?(agentId: string, cb: (data: string) => void): () => void;
    onAiAgentExit?(agentId: string, cb: (code: number | null) => void): () => void;
  }
}

export {};
