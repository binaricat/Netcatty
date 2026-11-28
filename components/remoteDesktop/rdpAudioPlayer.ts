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

/**
 * Lightweight linear resampler for 16-bit little-endian PCM when an active
 * recording locked the AudioContext sample rate before the first RDPSND wave.
 */
function resamplePcm16(
  data: Uint8Array,
  channels: 1 | 2,
  sourceRate: number,
  targetRate: number,
): Uint8Array {
  if (sourceRate === targetRate || sourceRate <= 0 || targetRate <= 0) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  }
  const srcView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const bytesPerFrame = channels * 2;
  const srcFrames = Math.floor(data.byteLength / bytesPerFrame);
  if (srcFrames <= 0) return new Uint8Array(0);
  const dstFrames = Math.max(1, Math.round((srcFrames * targetRate) / sourceRate));
  const out = new Uint8Array(dstFrames * bytesPerFrame);
  const dstView = new DataView(out.buffer);
  const ratio = srcFrames / dstFrames;
  for (let i = 0; i < dstFrames; i += 1) {
    const srcPos = i * ratio;
    const idx0 = Math.min(srcFrames - 1, Math.floor(srcPos));
    const idx1 = Math.min(srcFrames - 1, idx0 + 1);
    const frac = srcPos - idx0;
    for (let ch = 0; ch < channels; ch += 1) {
      const s0 = srcView.getInt16((idx0 * channels + ch) * 2, true);
      const s1 = srcView.getInt16((idx1 * channels + ch) * 2, true);
      const sample = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)));
      dstView.setInt16((i * channels + ch) * 2, sample, true);
    }
  }
  return out;
}

export class RdpAudioPlayer {
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private captureDest: MediaStreamAudioDestinationNode | null = null;
  private keepaliveSource: ConstantSourceNode | null = null;
  private keepaliveGain: GainNode | null = null;
  private captureRefCount = 0;
  private initPromise: Promise<void> | null = null;
  private requestedSampleRate = 0;
  private userVolume = 1.0;
  private serverVolume = 1.0;
  private muted = false;
  private disposed = false;
  private pendingChunks: Array<{ data: Uint8Array; channels: number; sampleRate: number }> = [];

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

    // Once the worklet is live, reuse the existing AudioContext regardless of
    // hardware sample-rate differences; `postPcm` resamples when rates differ.
    if (this.context && this.workletNode) {
      if (this.context.state === 'suspended') {
        await this.context.resume().catch(() => {});
      }
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    // If a recording already pre-created the AudioContext + captureDest, keep
    // it alive so the live MediaRecorder audio track is never severed.
    const reusePreCreatedContext = Boolean(this.context && !this.workletNode && this.captureRefCount > 0);
    if (!reusePreCreatedContext && this.context && this.requestedSampleRate !== 0 && this.requestedSampleRate !== targetRate) {
      this.teardownContext({ clearPending: true });
    }
    this.requestedSampleRate = targetRate;

    const initTask = (async () => {
      if (typeof AudioContext === 'undefined') return;
      let ctx: AudioContext;
      if (reusePreCreatedContext && this.context) {
        ctx = this.context;
      } else {
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
      }

      try {
        await ctx.audioWorklet.addModule(resolveWorkletUrl());
      } catch (err) {
        console.warn('[RdpAudioPlayer] Failed to load rdp-pcm-worklet.js:', err);
        this.pendingChunks.length = 0;
        if (this.context === ctx && this.captureRefCount <= 0) {
          this.teardownContext({ clearPending: true });
        } else if (this.context !== ctx) {
          await ctx.close().catch(() => {});
        }
        return;
      }
      if (this.disposed || this.context !== ctx) {
        if (this.context !== ctx) await ctx.close().catch(() => {});
        return;
      }
      let node: AudioWorkletNode;
      try {
        const bufferSampleRate = normalizeSampleRate(ctx.sampleRate || targetRate);
        node = new AudioWorkletNode(ctx, 'rdp-pcm-worklet', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: {
            bufferFrames: Math.max(8192, bufferSampleRate),
          },
        });
        node.connect(ctx.destination);
      } catch (err) {
        console.warn('[RdpAudioPlayer] Failed to create AudioWorkletNode:', err);
        this.pendingChunks.length = 0;
        if (this.context === ctx && this.captureRefCount <= 0) {
          this.teardownContext({ clearPending: true });
        } else if (this.context !== ctx) {
          await ctx.close().catch(() => {});
        }
        return;
      }
      if (this.captureDest) {
        try {
          node.connect(this.captureDest);
        } catch {
          // ignore
        }
      } else if (typeof ctx.createMediaStreamDestination === 'function') {
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
        this.postPcm(item.data, item.channels, item.sampleRate);
      }
    })();

    this.initPromise = initTask;
    try {
      await initTask;
    } finally {
      if (this.initPromise === initTask) {
        this.initPromise = null;
      }
      if (!this.workletNode && this.captureRefCount <= 0 && this.context) {
        this.teardownContext({ clearPending: true });
      }
    }
  }

  private postPcm(data: Uint8Array, channels: number, sourceSampleRate?: number): void {
    if (!this.workletNode || this.disposed) return;
    const ch: 1 | 2 = channels === 1 ? 1 : 2;
    const ctxRate = this.context?.sampleRate || this.requestedSampleRate;
    // Copy (or resample when hardware/recording AudioContext rate differs from stream)
    // into a dedicated ArrayBuffer so transfer never detaches WASM linear memory.
    const prepared = sourceSampleRate && ctxRate && sourceSampleRate !== ctxRate
      ? resamplePcm16(data, ch, sourceSampleRate, ctxRate)
      : (() => {
          const copy = new Uint8Array(data.byteLength);
          copy.set(data);
          return copy;
        })();
    if (prepared.byteLength === 0) return;
    this.workletNode.port.postMessage(
      {
        type: 'pcm',
        channels: ch,
        buffer: prepared.buffer,
      },
      [prepared.buffer],
    );
  }

  public handleMessage(msg: RdpAudioMessage): void {
    if (this.disposed || !msg) return;
    switch (msg.type) {
      case 'wave': {
        if (!msg.data || msg.data.byteLength === 0) return;
        const channels = msg.channels === 1 ? 1 : 2;
        const normalizedRate = normalizeSampleRate(msg.sampleRate || 48000);
        if (this.workletNode) {
          if (this.context?.state === 'suspended') {
            void this.context.resume().catch(() => {});
          }
          this.postPcm(msg.data, channels, normalizedRate);
        } else {
          // Bound queued startup chunks so memory never grows unbounded.
          if (this.pendingChunks.length < 32) {
            const copy = new Uint8Array(msg.data.byteLength);
            copy.set(msg.data);
            this.pendingChunks.push({ data: copy, channels, sampleRate: normalizedRate });
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

  private stopCaptureKeepalive(): void {
    const source = this.keepaliveSource;
    const gain = this.keepaliveGain;
    this.keepaliveSource = null;
    this.keepaliveGain = null;
    try { source?.stop(); } catch { /* ignore */ }
    try { source?.disconnect(); } catch { /* ignore */ }
    try { gain?.disconnect(); } catch { /* ignore */ }
  }

  private ensureCaptureKeepalive(ctx: AudioContext, dest: MediaStreamAudioDestinationNode): void {
    if (this.keepaliveSource) return;
    if (typeof ctx.createConstantSource !== 'function' || typeof ctx.createGain !== 'function') {
      return;
    }
    let source: ConstantSourceNode | null = null;
    let gain: GainNode | null = null;
    try {
      source = ctx.createConstantSource();
      source.offset.value = 0;
      gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(dest);
      source.start();
      this.keepaliveSource = source;
      this.keepaliveGain = gain;
    } catch {
      try { source?.stop(); } catch { /* ignore */ }
      try { source?.disconnect(); } catch { /* ignore */ }
      try { gain?.disconnect(); } catch { /* ignore */ }
      this.stopCaptureKeepalive();
    }
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

  /**
   * Acquire a live recording audio stream even if the remote desktop has not
   * emitted its first audio packet yet. Pair every successful call with
   * `releaseCaptureAudioStream()` so idle keepalive nodes and unused contexts
   * are immediately torn down once recording stops.
   */
  public ensureCaptureAudioStream(): MediaStream | null {
    if (this.disposed) return null;
    if (typeof AudioContext === 'undefined') return null;

    let ctx = this.context;
    let createdNewContext = false;
    if (!ctx) {
      try {
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      } catch {
        try {
          ctx = new AudioContext({ latencyHint: 'interactive' });
        } catch {
          return null;
        }
      }
      this.context = ctx;
      this.requestedSampleRate = normalizeSampleRate(ctx.sampleRate || 48000);
      createdNewContext = true;
    }

    if (!this.captureDest) {
      if (typeof ctx.createMediaStreamDestination !== 'function') {
        if (createdNewContext) this.teardownContext({ clearPending: false });
        return null;
      }
      try {
        const dest = ctx.createMediaStreamDestination();
        if (this.workletNode) {
          this.workletNode.connect(dest);
        }
        this.captureDest = dest;
      } catch {
        this.captureDest = null;
        if (createdNewContext) this.teardownContext({ clearPending: false });
        return null;
      }
    }

    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    this.captureRefCount += 1;
    this.ensureCaptureKeepalive(ctx, this.captureDest);
    return this.captureDest.stream;
  }

  /**
   * Release a capture hold acquired via `ensureCaptureAudioStream()`. Stops
   * silent keepalive nodes immediately, and closes the AudioContext if no
   * RDPSND playback worklet was ever needed.
   */
  public releaseCaptureAudioStream(): void {
    this.captureRefCount = Math.max(0, this.captureRefCount - 1);
    if (this.captureRefCount > 0) return;
    this.stopCaptureKeepalive();
    if (!this.workletNode && !this.initPromise && this.context) {
      this.teardownContext({ clearPending: false });
    }
  }

  private teardownContext(options?: { clearPending?: boolean }): void {
    if (options?.clearPending !== false) {
      this.pendingChunks.length = 0;
    }
    this.stopCaptureKeepalive();
    const node = this.workletNode;
    const captureDest = this.captureDest;
    const ctx = this.context;
    this.workletNode = null;
    this.captureDest = null;
    this.context = null;
    this.initPromise = null;
    this.requestedSampleRate = 0;
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
    this.captureRefCount = 0;
    this.teardownContext({ clearPending: true });
  }
}
