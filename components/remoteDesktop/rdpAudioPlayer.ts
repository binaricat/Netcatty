/**
 * Web Audio RDPSND playback driver using static `'self'` AudioWorklet
 * (`/audio/rdp-pcm-worklet.js`, NEVER `blob:`).
 *
 * Consumes IronRDP WASM `audio_playback` callback payloads:
 * - `{ type: 'wave'; sampleRate: number; channels: number; data: Uint8Array }`
 * - `{ type: 'volume'; left: number; right: number }` (0..1 log-scale)
 * - `{ type: 'close' }`
 */

export type RdpAudioMessage =
  | { type: 'wave'; sampleRate: number; channels: number; data: Uint8Array }
  | { type: 'volume'; left: number; right: number }
  | { type: 'close' };

function resolveWorkletUrl(): string {
  // Always resolve against static 'self' origin so CSP script-src 'self' is satisfied.
  if (typeof window !== 'undefined' && window.location) {
    try {
      return new URL('/audio/rdp-pcm-worklet.js', window.location.origin).href;
    } catch {
      return './audio/rdp-pcm-worklet.js';
    }
  }
  return '/audio/rdp-pcm-worklet.js';
}

function normalizeSampleRate(sampleRate: number): number {
  return Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000
    ? Math.round(sampleRate)
    : 48000;
}

export class RdpAudioPlayer {
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private captureDest: MediaStreamAudioDestinationNode | null = null;
  private initPromise: Promise<void> | null = null;
  private currentSampleRate = 0;
  private userVolume = 1.0;
  private serverVolume = 1.0;
  private muted = false;
  private disposed = false;
  private pendingChunks: Array<{ data: Uint8Array; channels: number }> = [];

  constructor(options?: { muted?: boolean; volume?: number }) {
    if (typeof options?.muted === 'boolean') {
      this.muted = options.muted;
    }
    if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
      this.userVolume = Math.max(0, Math.min(1, options.volume));
    }
  }

  private getEffectiveGain(): number {
    if (this.muted) return 0;
    return Math.max(0, Math.min(1, this.userVolume * this.serverVolume));
  }

  private syncGain(): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'volume',
      volume: this.getEffectiveGain(),
      muted: this.muted,
    });
  }

  private async ensureInitialized(sampleRate: number): Promise<void> {
    if (this.disposed) return;
    const targetRate = normalizeSampleRate(sampleRate);

    if (this.context && this.workletNode && this.currentSampleRate === targetRate) {
      if (this.context.state === 'suspended') {
        await this.context.resume().catch(() => {});
      }
      return;
    }

    if (this.initPromise && this.currentSampleRate === targetRate) {
      return this.initPromise;
    }

    // Tear down any previous AudioContext if sample rate changed, preserving
    // freshly queued chunks for the new rate when initializing from scratch.
    this.teardownContext({ clearPending: this.currentSampleRate !== 0 && this.currentSampleRate !== targetRate });
    this.currentSampleRate = targetRate;

    this.initPromise = (async () => {
      if (typeof AudioContext === 'undefined') return;
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: targetRate, latencyHint: 'interactive' });
      } catch {
        ctx = new AudioContext({ latencyHint: 'interactive' });
      }
      if (this.disposed) {
        await ctx.close().catch(() => {});
        return;
      }
      this.context = ctx;
      try {
        await ctx.audioWorklet.addModule(resolveWorkletUrl());
      } catch (err) {
        console.warn('[RdpAudioPlayer] Failed to load rdp-pcm-worklet.js:', err);
        if (this.context === ctx) {
          this.teardownContext({ clearPending: true });
        } else {
          await ctx.close().catch(() => {});
        }
        return;
      }
      if (this.disposed || this.context !== ctx) {
        await ctx.close().catch(() => {});
        return;
      }
      let node: AudioWorkletNode;
      try {
        node = new AudioWorkletNode(ctx, 'rdp-pcm-worklet', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: {
            bufferFrames: Math.max(8192, targetRate),
          },
        });
        node.connect(ctx.destination);
      } catch (err) {
        console.warn('[RdpAudioPlayer] Failed to create AudioWorkletNode:', err);
        if (this.context === ctx) {
          this.teardownContext({ clearPending: true });
        } else {
          await ctx.close().catch(() => {});
        }
        return;
      }
      if (typeof ctx.createMediaStreamDestination === 'function') {
        try {
          const captureDest = ctx.createMediaStreamDestination();
          node.connect(captureDest);
          this.captureDest = captureDest;
        } catch {
          this.captureDest = null;
        }
      }
      this.workletNode = node;
      this.syncGain();
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      // Drain buffered chunks that arrived during async worklet startup.
      const queued = this.pendingChunks.splice(0);
      for (const item of queued) {
        this.postPcm(item.data, item.channels);
      }
    })();

    return this.initPromise;
  }

  private postPcm(data: Uint8Array, channels: number): void {
    if (!this.workletNode || this.disposed) return;
    // Copy into a dedicated ArrayBuffer so transfer does not detach WASM linear memory.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.workletNode.port.postMessage(
      {
        type: 'pcm',
        channels: channels === 1 ? 1 : 2,
        buffer: copy.buffer,
      },
      [copy.buffer],
    );
  }

  public handleMessage(msg: RdpAudioMessage): void {
    if (this.disposed || !msg) return;
    switch (msg.type) {
      case 'wave': {
        if (!msg.data || msg.data.byteLength === 0) return;
        const channels = msg.channels === 1 ? 1 : 2;
        const normalizedRate = normalizeSampleRate(msg.sampleRate || 48000);
        if (this.workletNode && this.currentSampleRate === normalizedRate) {
          if (this.context?.state === 'suspended') {
            void this.context.resume().catch(() => {});
          }
          this.postPcm(msg.data, channels);
        } else {
          if (this.currentSampleRate !== 0 && this.currentSampleRate !== normalizedRate) {
            this.pendingChunks.length = 0;
          }
          // Bound queued startup chunks so memory never grows unbounded.
          if (this.pendingChunks.length < 32) {
            const copy = new Uint8Array(msg.data.byteLength);
            copy.set(msg.data);
            this.pendingChunks.push({ data: copy, channels });
          }
          void this.ensureInitialized(normalizedRate);
        }
        break;
      }
      case 'volume': {
        const left = typeof msg.left === 'number' && Number.isFinite(msg.left) ? msg.left : 1;
        const right = typeof msg.right === 'number' && Number.isFinite(msg.right) ? msg.right : 1;
        const avg = Math.max(0, Math.min(1, (left + right) * 0.5));
        // Convert 0..1 log-scale server volume into linear gain smoothly.
        this.serverVolume = avg <= 0.001 ? 0 : Math.pow(avg, 2);
        this.syncGain();
        break;
      }
      case 'close': {
        this.flush();
        break;
      }
      default:
        break;
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.syncGain();
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.userVolume = Math.max(0, Math.min(1, volume));
    this.syncGain();
  }

  public getVolume(): number {
    return this.userVolume;
  }

  public resume(): void {
    if (this.context && this.context.state === 'suspended') {
      void this.context.resume().catch(() => {});
    }
  }

  public flush(): void {
    this.pendingChunks.length = 0;
    this.workletNode?.port.postMessage({ type: 'flush' });
  }

  /**
   * Returns a live `MediaStream` tapping the RDPSND worklet output for session
   * recording without disrupting speaker playback. Returns `null` when audio
   * playback has not initialized or `createMediaStreamDestination` is unavailable.
   */
  public getCaptureAudioStream(): MediaStream | null {
    if (this.disposed) return null;
    if (!this.captureDest && this.context && this.workletNode && typeof this.context.createMediaStreamDestination === 'function') {
      try {
        const dest = this.context.createMediaStreamDestination();
        this.workletNode.connect(dest);
        this.captureDest = dest;
      } catch {
        this.captureDest = null;
      }
    }
    return this.captureDest?.stream ?? null;
  }

  private teardownContext(options?: { clearPending?: boolean }): void {
    if (options?.clearPending !== false) {
      this.pendingChunks.length = 0;
    }
    const node = this.workletNode;
    const captureDest = this.captureDest;
    const ctx = this.context;
    this.workletNode = null;
    this.captureDest = null;
    this.context = null;
    this.initPromise = null;
    this.currentSampleRate = 0;
    try {
      node?.port.postMessage({ type: 'reset' });
      node?.port.close?.();
      node?.disconnect();
    } catch { /* ignore */ }
    try {
      captureDest?.stream.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
    if (ctx) {
      void ctx.close().catch(() => {});
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownContext({ clearPending: true });
  }
}
