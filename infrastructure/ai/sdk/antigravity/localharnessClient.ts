import { getNetcattyBridge } from '../../../../components/ai/hooks/aiChatStreamingSupport';

export interface LocalHarnessConfig {
  binaryPath: string;
  appDataDir: string;
  debug?: boolean;
}

export class LocalHarnessClient {
  private config: LocalHarnessConfig;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  public onEvent?: (event: unknown) => void;
  public onClose?: () => void;
  public adcProject?: string;

  constructor(config: LocalHarnessConfig) {
    this.config = { ...config, debug: true };
  }

  public async initialize(chatSessionId: string): Promise<void> {
    this.sessionId = chatSessionId;
    const bridge = getNetcattyBridge();
    
    // Call the main process to spawn the binary and get the WebSocket port
    // The preload script maps this to netcatty:ai:antigravity:start
    const { port, apiKey, project } = await bridge.aiAntigravityStartHarness({
      binaryPath: this.config.binaryPath,
      appDataDir: this.config.appDataDir,
      chatSessionId
    }) as any;
    
    this.adcProject = project;

    return new Promise((resolve, reject) => {
      // Connect via WebSocket
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?api_key=${apiKey}`);
      
      this.ws.onopen = () => {
        if (this.config.debug) console.log('[LocalHarness] WebSocket connected');
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (this.config.debug) console.log('[LocalHarness] <=', parsed);
          if (this.onEvent) this.onEvent(parsed);
        } catch (err) {
          console.error('[LocalHarness] Failed to parse message', err);
        }
      };

      this.ws.onerror = (err) => {
        console.error('[LocalHarness] WebSocket error', err);
      };

      this.ws.onclose = () => {
        if (this.config.debug) console.log('[LocalHarness] WebSocket closed');
        if (this.onClose) this.onClose();
      };
      
      // Add a timeout just in case it hangs
      setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          reject(new Error("WebSocket connection timeout"));
        }
      }, 5000);
    });
  }

  public isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public sendJson(payload: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.config.debug) console.log('[LocalHarness] =>', payload);
      this.ws.send(JSON.stringify(payload));
    }
  }

  public destroy(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.sessionId) {
      const bridge = getNetcattyBridge();
      bridge.aiAntigravityStopHarness({ chatSessionId: this.sessionId }).catch(console.error);
      this.sessionId = null;
    }
  }
}
